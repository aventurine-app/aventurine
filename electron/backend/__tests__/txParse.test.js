'use strict';

// Regression suite for the transaction-import parsing core (txparse.js —
// the file the browser actually runs; it dual-exports for Node). Import is
// the make-or-break feature, so this pins the parser against a fixture
// corpus of messy bank exports (fixtures/import/): quoted CSV with BOM +
// CRLF + embedded newlines, delimiter sniffing, OFX in both SGML and XML
// flavours, QIF apostrophe dates, JSON envelopes, a hand-built .xlsx
// (shared strings, rich text, inline strings, Excel serial dates, sparse
// cells), windows-1252 fallback, and the rejection paths (.xls, PDF,
// binary). Plus unit tables for the date/amount normalisers and the
// column-detection heuristics.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TxParse = require('../../../static/js/widgets/txparse.js');
const {
  parseFile, parseDelimited, detectDelimiter, detectColumns, applyMapping,
  parseIsoDate, parseAmount, fingerprint,
} = TxParse;

const FIX = path.join(__dirname, 'fixtures', 'import');

// parseFile expects an ArrayBuffer (what file.arrayBuffer() yields in the
// browser); a Node Buffer's view offset must be honoured when converting.
function loadFixture(name) {
  const b = fs.readFileSync(path.join(FIX, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ── Date normaliser ──────────────────────────────────────────────────────────

test('parseIsoDate handles every supported format', () => {
  const cases = [
    ['2026-01-02',      '2026-01-02'],  // ISO dash
    ['2026/01/03',      '2026-01-03'],  // ISO slash
    ['01/04/2026',      '2026-01-04'],  // US slash
    ['01-05-2026',      '2026-01-05'],  // US dash
    ['1/6/26',          '2026-01-06'],  // US short
    ['07.01.2026',      '2026-01-07'],  // European
    ['20260108',        '2026-01-08'],  // compact / OFX
    ['Jan 9, 2026',     '2026-01-09'],  // month name
    ['January 10 2026', '2026-01-10'],  // full month name
    ['11 Jan 2026',     '2026-01-11'],  // day-first
    ['12-Jan-2026',     '2026-01-12'],  // day-first dashed
    ['  2026-01-02  ',  '2026-01-02'],  // surrounding whitespace
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseIsoDate(input), expected, `parseIsoDate(${JSON.stringify(input)})`);
  }
});

test('parseIsoDate converts Excel serials (day counts from 1899-12-30)', () => {
  // 25569 is the well-known Unix-epoch anchor.
  assert.equal(parseIsoDate('25569'), '1970-01-01');
  const serial = String(Date.UTC(2026, 2, 4) / 86400000 + 25569);
  assert.equal(parseIsoDate(serial), '2026-03-04');
  assert.equal(parseIsoDate(serial + '.5'), '2026-03-04'); // time fraction ignored
});

test('parseIsoDate rejects garbage rather than guessing', () => {
  for (const bad of ['', null, undefined, 'not a date', '13/45/2026', '2026-13-01',
                     '123', '1234567', 'Xyz 5, 2026']) {
    assert.equal(parseIsoDate(bad), null, `parseIsoDate(${JSON.stringify(bad)})`);
  }
});

// ── Amount normaliser ────────────────────────────────────────────────────────

test('parseAmount strips symbols/commas and honours accountant parentheses', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(45.00)'), -45);
  assert.equal(parseAmount('(£99.99)'), -99.99);
  assert.equal(parseAmount('€99.50'), 99.5);
  assert.equal(parseAmount('-23.45'), -23.45);
  assert.equal(parseAmount('  1200  '), 1200);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount(null)));
});

// ── Duplicate fingerprint ────────────────────────────────────────────────────

test('fingerprint matches the backend formula (date|abs-2dp|lowercased desc)', () => {
  assert.equal(
    fingerprint({ date: '2026-01-05', amount: 23.45, description: '  Starbucks #12 ' }),
    '2026-01-05|23.45|starbucks #12'
  );
  // Sign never enters the fingerprint (amounts are stored unsigned).
  assert.equal(
    fingerprint({ date: '2026-01-05', amount: -23.45, description: 'X' }),
    fingerprint({ date: '2026-01-05', amount: 23.45, description: 'x' })
  );
});

// ── Delimited text ───────────────────────────────────────────────────────────

test('parseDelimited: quotes, "" escapes, embedded delimiter + newline, BOM', () => {
  const { headers, rows } = parseDelimited('﻿a,b\r\n"x,y","he said ""hi"""\r\n"line1\nline2",2\r\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.deepEqual(rows, [['x,y', 'he said "hi"'], ['line1\nline2', '2']]);
});

test('detectDelimiter is quote-aware and prefers uniform column counts', () => {
  assert.equal(detectDelimiter('a;b;c\n"x, y";2;3\n4;5;6\n'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(detectDelimiter('a|b\n1|2\n'), '|');
  assert.equal(detectDelimiter('a,b\n1,2\n'), ',');
});

// ── Fixture corpus: parseFile end to end ─────────────────────────────────────

test('chase-style.csv: BOM + CRLF + quoted commas/quotes/newlines survive', async () => {
  const t = await parseFile('chase-style.csv', loadFixture('chase-style.csv'));
  assert.deepEqual(t.headers, ['Transaction Date', 'Description', 'Amount', 'Balance']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0][1], 'AMAZON MKTP US*2Y4RT, Seattle WA');
  assert.equal(t.rows[1][1], 'JOE\'S "DELI" #42');
  assert.equal(t.rows[2][1], 'CHECK DEPOSIT\nMOBILE');
  assert.equal(t.fixed, false);
});

test('eu-semicolon.csv: sniffs ";" and European dates map to ISO', async () => {
  const t = await parseFile('eu-semicolon.csv', loadFixture('eu-semicolon.csv'));
  assert.deepEqual(t.headers, ['Datum', 'Beschreibung', 'Betrag']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[2][1], 'Miete Wohnung, Mitte'); // quoted comma intact

  const { parsed, errors } = applyMapping(t.rows, { date: 0, description: 1, amount: 2, notes: null });
  assert.equal(errors.length, 0);
  assert.deepEqual(parsed.map(r => r.date), ['2026-01-15', '2026-01-16', '2026-01-17']);
  assert.deepEqual(parsed.map(r => r.tx_type), ['expense', 'income', 'expense']);
});

test('pipe-delimited.txt and tab-delimited.tsv sniff their delimiters', async () => {
  const pipe = await parseFile('pipe-delimited.txt', loadFixture('pipe-delimited.txt'));
  assert.deepEqual(pipe.headers, ['Date', 'Payee', 'Amount']);
  assert.equal(pipe.rows.length, 3);

  const tsv = await parseFile('tab-delimited.tsv', loadFixture('tab-delimited.tsv'));
  assert.deepEqual(tsv.headers, ['Date', 'Description', 'Amount']);
  assert.equal(tsv.rows.length, 2);
});

test('parens-accounting.csv: (x) negatives and $/£ symbols normalise', async () => {
  const t = await parseFile('parens-accounting.csv', loadFixture('parens-accounting.csv'));
  const { parsed, errors } = applyMapping(t.rows, { date: 0, description: 1, amount: 2, notes: null });
  assert.equal(errors.length, 0);
  assert.deepEqual(parsed.map(r => [r.tx_type, r.amount]), [
    ['expense', 45], ['income', 1500], ['expense', 99.99],
  ]);
});

test('dates-zoo.csv: every date dialect lands on the intended ISO day', async () => {
  const t = await parseFile('dates-zoo.csv', loadFixture('dates-zoo.csv'));
  const { parsed, errors } = applyMapping(t.rows, { date: 0, description: 1, amount: 2, notes: null });
  assert.equal(errors.length, 0);
  assert.deepEqual(
    parsed.map(r => r.date),
    Array.from({ length: 11 }, (_, i) => `2026-01-${String(i + 2).padStart(2, '0')}`)
  );
});

test('sample-sgml.ofx: SGML flavour — unclosed tags, tz-suffixed dates, MEMO promotion', async () => {
  const t = await parseFile('sample-sgml.ofx', loadFixture('sample-sgml.ofx'));
  assert.equal(t.fixed, true);
  assert.deepEqual(t.headers, ['Date', 'Description', 'Amount', 'Notes']);
  assert.equal(t.rows.length, 3);
  // Time + timezone stripped from DTPOSTED; NAME + MEMO both kept.
  assert.deepEqual(t.rows[0], ['2026-02-15', 'STARBUCKS STORE #123', '-42.19', 'CARD 1234']);
  // No NAME → MEMO promoted to description (not duplicated into notes),
  // XML entity unescaped.
  assert.deepEqual(t.rows[1], ['2026-02-16', 'DIRECT DEPOSIT ACME & CO', '1250.00', '']);
  assert.deepEqual(t.rows[2], ['2026-02-17', 'PARKING', '-7.50', '']);
});

test('sample-xml.qfx: XML flavour parses identically', async () => {
  const t = await parseFile('sample-xml.qfx', loadFixture('sample-xml.qfx'));
  assert.equal(t.fixed, true);
  assert.deepEqual(t.rows[0], ['2026-03-01', 'NETFLIX.COM', '-15.00', '']);
  assert.deepEqual(t.rows[1], ['2026-03-02', 'GROCERY & MORE', '-88.10', 'POS PURCHASE']);
});

test('misnamed-ofx.txt: content sniffing beats the lying extension', async () => {
  const t = await parseFile('misnamed-ofx.txt', loadFixture('misnamed-ofx.txt'));
  assert.equal(t.fixed, true); // parsed as OFX, not as delimited text
  assert.deepEqual(t.rows, [['2026-04-10', 'APP STORE', '-3.99', '']]);
});

test('sample.qif: apostrophe dates, T/U amounts, L-category fallback, no trailing ^', async () => {
  const t = await parseFile('sample.qif', loadFixture('sample.qif'));
  assert.equal(t.fixed, true);
  assert.equal(t.rows.length, 3);
  const { parsed, errors } = applyMapping(t.rows, { date: 0, description: 1, amount: 2, notes: 3 }, 1);
  assert.equal(errors.length, 0);
  assert.deepEqual(parsed[0], {
    date: '2026-01-15', description: 'SHELL OIL 5701', tx_type: 'expense',
    amount: 32.5, notes: 'CARD PURCHASE',
  });
  // U amount honoured; category label used as the notes fallback.
  assert.deepEqual([parsed[1].amount, parsed[1].tx_type, parsed[1].notes], [850, 'expense', 'Rent']);
  // Final record flushed despite the missing trailing '^'.
  assert.deepEqual([parsed[2].date, parsed[2].amount, parsed[2].tx_type], ['2026-03-20', 1200, 'income']);
});

test('envelope.json: finds the transaction array, unions keys, blanks nulls', async () => {
  const t = await parseFile('envelope.json', loadFixture('envelope.json'));
  assert.deepEqual(t.headers, ['date', 'payee', 'amount', 'category', 'note']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0][3], '');            // null → ''
  assert.equal(t.rows[2][0], '');            // missing key → ''
  const { parsed, errors } = applyMapping(t.rows, { date: 0, description: 1, amount: 2, notes: 4 });
  assert.equal(parsed.length, 2);            // the dateless row errors out
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /unparseable date/);
});

test('title-above.xlsx: native zip/XML path — serials, shared+rich+inline strings, sparse cells', async () => {
  const t = await parseFile('title-above.xlsx', loadFixture('title-above.xlsx'));
  // The one-cell title row and blank spacer row are skipped; the header row
  // includes the rich-text run concatenation ("Am"+"ount").
  assert.deepEqual(t.headers, ['Date', 'Description', 'Amount', 'Notes']);
  assert.equal(t.rows.length, 2);
  // Shared string with entity + boolean cell.
  assert.deepEqual(t.rows[0].slice(1), ['COFFEE & BAGEL CO', '-4.75', 'TRUE']);
  // Inline string runs concatenated; missing C cell leaves a hole ('').
  assert.deepEqual(t.rows[1].slice(1), ['TRANSFER IN', '', 'ACME PAYROLL']);
  // Excel serial dates round-trip through applyMapping.
  const { parsed } = applyMapping([t.rows[0]], { date: 0, description: 1, amount: 2, notes: 3 });
  assert.equal(parsed[0].date, '2026-03-04');
});

test('cp1252.csv: invalid-UTF-8 bytes fall back to windows-1252, not U+FFFD', async () => {
  const t = await parseFile('cp1252.csv', loadFixture('cp1252.csv'));
  assert.equal(t.rows[0][1], 'CAFé “LE MONDE”');
  assert.ok(!t.rows[0][1].includes('�'));
});

test('rejections: .xls, PDF, and NUL-ridden binaries fail with guidance', async () => {
  await assert.rejects(parseFile('legacy.xls', loadFixture('legacy.xls')), /re-save the file as \.xlsx or CSV/);
  await assert.rejects(parseFile('statement.pdf', loadFixture('statement.pdf')), /PDF statements cannot be imported/);
  await assert.rejects(parseFile('random.bin', loadFixture('random.bin')), /unrecognised binary file/);
});

// ── Column detection ─────────────────────────────────────────────────────────

test('detectColumns: fuzzy header names win first', () => {
  const d = detectColumns(['Posting Date', 'Transaction Details', 'Debit Amount', 'Reference'], []);
  assert.deepEqual(d, { date: 0, description: 1, amount: 2, notes: 3 });
});

test('detectColumns: data-shape fallback rescues anonymous headers', () => {
  const rows = [
    ['2026-01-01', 'COFFEE SHOP DOWNTOWN', '-4.50'],
    ['2026-01-02', 'GROCERY MARKET #12', '-61.20'],
    ['2026-01-03', 'PAYCHECK', '2100.00'],
  ];
  const d = detectColumns(['A', 'B', 'C'], rows);
  assert.equal(d.date, 0);      // >80% of values parse as dates
  assert.equal(d.amount, 2);    // >80% parse as amounts
  assert.equal(d.description, 1); // longest average text among the rest
});

// ── applyMapping error reporting ─────────────────────────────────────────────

test('applyMapping: per-row errors carry human row numbers; valid rows pass through', () => {
  const rows = [
    ['2026-01-01', 'OK ROW', '10.00'],
    ['garbage',    'BAD DATE', '5.00'],
    ['2026-01-03', 'BAD AMOUNT', 'five'],
    ['2026-01-04', '', '1.00'],
  ];
  const { parsed, errors } = applyMapping(rows, { date: 0, description: 1, amount: 2, notes: null });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    date: '2026-01-01', description: 'OK ROW', tx_type: 'income', amount: 10, notes: '',
  });
  // firstRowNum defaults to 2 (row 1 is the header line in the source file).
  assert.deepEqual(errors.map(e => e.row), [3, 4, 5]);
  assert.match(errors[0].reason, /unparseable date/);
  assert.match(errors[1].reason, /unparseable amount/);
  assert.equal(errors[2].reason, 'empty description');
});

// ── Full pipeline (what the UI actually runs) ────────────────────────────────

test('pipeline: parseFile → detectColumns → applyMapping on a messy CSV', async () => {
  const t = await parseFile('chase-style.csv', loadFixture('chase-style.csv'));
  const d = detectColumns(t.headers, t.rows);
  assert.deepEqual(d, { date: 0, description: 1, amount: 2, notes: null });
  const { parsed, errors } = applyMapping(t.rows, d);
  assert.equal(errors.length, 0);
  assert.deepEqual(parsed[0], {
    date: '2026-01-05', description: 'AMAZON MKTP US*2Y4RT, Seattle WA',
    tx_type: 'expense', amount: 23.45, notes: '',
  });
  // Fingerprints of the parsed rows are ready for the dup-detection set.
  assert.equal(fingerprint(parsed[0]), '2026-01-05|23.45|amazon mktp us*2y4rt, seattle wa');
});
