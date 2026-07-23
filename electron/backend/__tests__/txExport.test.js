'use strict';

// Export feature (no Python ancestor): serialiser coverage for
// services/txExport.js and the chunked POST /api/transactions/export
// protocol — header/append/footer over <path>.part, overwrite guard, and
// the rename-into-place on the final chunk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeClient } = require('./helpers');
const { EXPORT_CHUNK } = require('../handlers/transactions');
const { exportHeader, exportBody, exportFooter } = require('../services/txExport');

// ── Shared helpers ────────────────────────────────────────────────────────────

const firstCat = (c, catType) =>
  c.get('/api/transactions').body.categories.find((x) => x.cat_type === catType);

function createTx(c, desc, { catId = null, amount = 10.0, txType = 'expense', d = '2026-06-01', notes = '', account = null } = {}) {
  const payload = { date: d, description: desc, tx_type: txType, amount, notes };
  if (catId !== null) payload.category_id = catId;
  if (account !== null) payload.account_key = account;
  const r = c.post('/api/transactions', payload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.transaction;
}

/** Drive the chunk loop the way txexport.js does; returns the final body. */
function exportAll(c, p, format, extra = {}) {
  let offset = 0;
  for (;;) {
    const r = c.post('/api/transactions/export', { path: p, format, offset, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.done) return r.body;
    offset = r.body.exported;
  }
}

// ── Serialisers (services/txExport.js) ────────────────────────────────────────

const SAMPLE = [
  { id: 1, date: '2026-01-05', description: 'ACME PAYROLL', amount: 2100, notes: '', tx_type: 'income', category_name: 'Income' },
  { id: 2, date: '2026-01-07', description: 'He said "hi", twice', amount: 15.49, notes: 'a&b <note>', tx_type: 'expense', category_name: null },
];
const META = { firstDate: '2026-01-05', lastDate: '2026-01-07', balance: 2084.51, now: new Date(2026, 5, 12, 9, 30, 0) };

test('csv serialiser: signed amounts and RFC 4180 quoting', () => {
  const out = exportHeader('csv', META) + exportBody('csv', SAMPLE);
  const lines = out.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Date,Description,Type,Category,Amount,Notes');
  assert.equal(lines[1], '2026-01-05,ACME PAYROLL,income,Income,2100.00,');
  // Quotes doubled, field with comma/quote wrapped; expense negative.
  assert.equal(lines[2], '2026-01-07,"He said ""hi"", twice",expense,,-15.49,a&b <note>');
  assert.equal(exportFooter('csv', META), '');
});

test('qif serialiser: one ^-terminated record per row, US dates', () => {
  const out = exportHeader('qif', META) + exportBody('qif', SAMPLE);
  const lines = out.split('\r\n').filter(Boolean);
  assert.equal(lines[0], '!Type:Bank');
  assert.deepEqual(lines.slice(1, 6), [
    'D01/05/2026', 'T2100.00', 'PACME PAYROLL', 'LIncome', '^',
  ]);
  // Uncategorized row: no L line; notes become the memo.
  assert.deepEqual(lines.slice(6), [
    'D01/07/2026', 'T-15.49', 'PHe said "hi", twice', 'Ma&b <note>', '^',
  ]);
});

test('ofx serialiser: SGML structure, escaping, date range, balance', () => {
  const out = exportHeader('ofx', META) + exportBody('ofx', SAMPLE) + exportFooter('ofx', META);
  assert.match(out, /^OFXHEADER:100\r\n/);
  assert.match(out, /<DTSTART>20260105\r\n<DTEND>20260107/);
  assert.match(out, /<TRNTYPE>CREDIT\r\n<DTPOSTED>20260105\r\n<TRNAMT>2100.00\r\n<FITID>FL-1/);
  assert.match(out, /<TRNTYPE>DEBIT[\s\S]*<TRNAMT>-15.49/);
  // Markup characters in user text are entity-escaped (the import parser
  // reverses exactly this set).
  assert.match(out, /<MEMO>a&amp;b &lt;note&gt;/);
  assert.match(out, /<BALAMT>2084.51/);
  assert.match(out, /<\/OFX>\r\n$/);
  // Plain OFX carries no Intuit tag…
  assert.doesNotMatch(out, /INTU\.BID/);
});

test('qfx serialiser: OFX plus the Intuit signon tag', () => {
  const out = exportHeader('qfx', META);
  assert.match(out, /<INTU\.BID>3000/);
});

// ── POST /api/transactions/export ─────────────────────────────────────────────

test('export writes a complete CSV file and cleans up the .part', (t) => {
  const c = makeClient(t);
  const income = firstCat(c, 'income');
  createTx(c, 'Coffee', { amount: 4.5, d: '2026-02-02', notes: 'morning' });
  createTx(c, 'Paycheck', { catId: income.id, amount: 1000, d: '2026-01-15' });

  const dest = path.join(c.dir, 'out.csv');
  const body = exportAll(c, dest, 'csv');
  assert.deepEqual(
    { exported: body.exported, total: body.total, path: body.path },
    { exported: 2, total: 2, path: dest }
  );
  assert.ok(!fs.existsSync(dest + '.part'));

  const lines = fs.readFileSync(dest, 'utf8').split('\r\n').filter(Boolean);
  assert.equal(lines.length, 3);
  // Oldest first, direction derived from the category.
  assert.equal(lines[1], `2026-01-15,Paycheck,income,${income.name},1000.00,`);
  assert.equal(lines[2], '2026-02-02,Coffee,expense,,-4.50,morning');
});

test('export of an empty ledger still produces a well-formed file', (t) => {
  const c = makeClient(t);
  const dest = path.join(c.dir, 'empty.ofx');
  const body = exportAll(c, dest, 'ofx');
  assert.deepEqual({ exported: body.exported, total: body.total }, { exported: 0, total: 0 });
  const out = fs.readFileSync(dest, 'utf8');
  assert.match(out, /^OFXHEADER:100/);
  assert.match(out, /<\/OFX>\r\n$/);
  assert.doesNotMatch(out, /<STMTTRN>/);
});

test('export spans multiple chunks and appends in order', (t) => {
  const c = makeClient(t);
  const n = EXPORT_CHUNK + 5;
  const rows = Array.from({ length: n }, (_, i) => ({
    date: '2026-03-01',
    description: `Row ${String(i).padStart(4, '0')}`,
    tx_type: 'expense',
    amount: 1,
  }));
  assert.equal(c.post('/api/transactions/import', { rows }).status, 200);

  const dest = path.join(c.dir, 'big.qif');
  const first = c.post('/api/transactions/export', { path: dest, format: 'qif', offset: 0 });
  assert.equal(first.status, 200);
  assert.deepEqual(
    { exported: first.body.exported, total: first.body.total, done: first.body.done },
    { exported: EXPORT_CHUNK, total: n, done: false }
  );
  // Mid-export: only the .part exists.
  assert.ok(fs.existsSync(dest + '.part'));
  assert.ok(!fs.existsSync(dest));

  const second = c.post('/api/transactions/export', { path: dest, format: 'qif', offset: first.body.exported });
  assert.equal(second.status, 200);
  assert.equal(second.body.done, true);
  assert.equal(second.body.exported, n);

  const out = fs.readFileSync(dest, 'utf8');
  assert.equal((out.match(/\^/g) || []).length, n);
  assert.match(out, /PRow 0000[\s\S]*PRow 0504/); // ascending id within the day
});

test('export refuses to clobber an existing file without overwrite', (t) => {
  const c = makeClient(t);
  createTx(c, 'Something');
  const dest = path.join(c.dir, 'exists.csv');
  fs.writeFileSync(dest, 'precious');

  const r = c.post('/api/transactions/export', { path: dest, format: 'csv', offset: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'A file already exists at that location');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'precious');

  const body = exportAll(c, dest, 'csv', { overwrite: true });
  assert.equal(body.exported, 1);
  assert.match(fs.readFileSync(dest, 'utf8'), /^Date,Description/);
});

test('export with filters writes only the matching rows', (t) => {
  const c = makeClient(t);
  const income = firstCat(c, 'income');
  createTx(c, 'Paycheck', { catId: income.id, amount: 1000, d: '2026-01-15' });
  createTx(c, 'Coffee Shop', { amount: 4.5, d: '2026-02-02' });
  createTx(c, 'Coffee Beans', { amount: 18.0, d: '2026-03-10' });
  createTx(c, 'Rent', { amount: 900, d: '2026-02-01' });

  // Name (case-insensitive substring) + date range + amount range together.
  let dest = path.join(c.dir, 'filtered.csv');
  let body = exportAll(c, dest, 'csv', {
    filters: { description: 'coffee', date_from: '2026-02-01', date_to: '2026-02-28', amount_min: 1, amount_max: 10 },
  });
  assert.deepEqual({ exported: body.exported, total: body.total }, { exported: 1, total: 1 });
  const lines = fs.readFileSync(dest, 'utf8').split('\r\n').filter(Boolean);
  assert.deepEqual(lines.slice(1), ['2026-02-02,Coffee Shop,expense,,-4.50,']);

  // tx_type filters on the direction derived from the category.
  dest = path.join(c.dir, 'income.csv');
  body = exportAll(c, dest, 'csv', { filters: { tx_type: 'income' } });
  assert.equal(body.exported, 1);
  assert.match(fs.readFileSync(dest, 'utf8'), /Paycheck,income/);

  // category_id: null exports only uncategorized rows.
  dest = path.join(c.dir, 'uncat.csv');
  body = exportAll(c, dest, 'csv', { filters: { category_id: null } });
  assert.equal(body.exported, 3);

  // category_id: <id> exports only that category's rows.
  dest = path.join(c.dir, 'cat.csv');
  body = exportAll(c, dest, 'csv', { filters: { category_id: income.id } });
  assert.equal(body.exported, 1);

  // The OFX statement range/balance span the filtered set, not the ledger.
  dest = path.join(c.dir, 'filtered.ofx');
  exportAll(c, dest, 'ofx', { filters: { description: 'coffee' } });
  const ofx = fs.readFileSync(dest, 'utf8');
  assert.match(ofx, /<DTSTART>20260202\r\n<DTEND>20260310/);
  assert.match(ofx, /<BALAMT>-22.50/);
});

test('export filters by account_key (a specific account, and the unassigned rows)', (t) => {
  const c = makeClient(t);
  // Two accounts are seeded (checking, savings); a hand-entered row has none.
  createTx(c, 'Grocery Run', { amount: 42, d: '2026-04-01', account: 'checking' });
  createTx(c, 'Fuel Stop', { amount: 30, d: '2026-04-02', account: 'savings' });
  createTx(c, 'Cash Tip', { amount: 5, d: '2026-04-03' }); // account_key null

  // A named account exports only its rows.
  let dest = path.join(c.dir, 'checking.csv');
  let body = exportAll(c, dest, 'csv', { filters: { account_key: 'checking' } });
  assert.equal(body.exported, 1);
  assert.match(fs.readFileSync(dest, 'utf8'), /Grocery Run/);

  // account_key: null (the "No account" chip) exports only the unassigned rows.
  dest = path.join(c.dir, 'noacct.csv');
  body = exportAll(c, dest, 'csv', { filters: { account_key: null } });
  assert.equal(body.exported, 1);
  assert.match(fs.readFileSync(dest, 'utf8'), /Cash Tip/);
});

test('export validates filters', (t) => {
  const c = makeClient(t);
  const dest = path.join(c.dir, 'x.csv');
  const post = (filters) =>
    c.post('/api/transactions/export', { path: dest, format: 'csv', offset: 0, filters });

  let r = post('coffee');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'filters must be an object');

  r = post({ date_from: '02/01/2026' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /date_from must be an ISO date/);

  r = post({ amount_min: 'cheap' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /amount_min must be a number/);

  r = post({ tx_type: 'savings' }); // retired type — no longer accepted
  assert.equal(r.status, 400);
  assert.match(r.body.error, /tx_type must be one of/);

  r = post({ category_id: 'Groceries' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /category_id must be an integer or null/);

  r = post({ account_key: 42 }); // must be a string key or null
  assert.equal(r.status, 400);
  assert.match(r.body.error, /account_key must be a string or null/);

  // Empty filters object behaves exactly like no filters.
  createTx(c, 'Something');
  const body = exportAll(c, dest, 'csv', { filters: {} });
  assert.deepEqual({ exported: body.exported, total: body.total }, { exported: 1, total: 1 });
});

test('export validates format, offset, and path', (t) => {
  const c = makeClient(t);
  const dest = path.join(c.dir, 'x.csv');

  let r = c.post('/api/transactions/export', { path: dest, format: 'xls', offset: 0 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /format must be one of/);

  r = c.post('/api/transactions/export', { path: dest, format: 'csv', offset: -1 });
  assert.equal(r.status, 400);

  r = c.post('/api/transactions/export', { path: c.dir, format: 'csv', offset: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'That path is a directory — include a file name');

  // A non-zero offset with no first chunk on disk is a protocol error.
  r = c.post('/api/transactions/export', { path: dest, format: 'csv', offset: 10 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /restart from offset 0/);
});
