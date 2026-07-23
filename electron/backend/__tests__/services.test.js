'use strict';

// Parity tests against Python-generated oracles (fixtures/*.json) for the
// ported pure services, plus semantic tests for applyTxFields / parseEntry.
// The oracles were produced by the OLD backend (services/predictions.py,
// services/credit_cards.py, round()) so the port is checked against the
// real thing, not against my reading of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectRecurringExpenses } = require('../services/predictions');
const { recentMonthlyAverage } = require('../services/creditCards');
const { round2, parseEntry, parseIsoDate, ApiError } = require('../validate');
const { applyTxFields, newTx } = require('../services/transactions');
const { connect } = require('../db');
const { bootstrapSchema } = require('../migrate');
const { seedDefaults } = require('../seed');

const FIXTURES = path.join(__dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('detectRecurringExpenses matches the Python oracle exactly', () => {
  const cases = load('predictions-oracle.json');
  assert.ok(cases.length >= 10, 'enough cases');
  let kept = 0;
  for (const c of cases) {
    const got = detectRecurringExpenses(c.transactions, { today: c.today, limit: c.limit });
    assert.deepStrictEqual(
      got, c.expected,
      `prediction mismatch (today=${c.today} limit=${c.limit} rows=${c.transactions.length})`
    );
    kept += got.length;
  }
  assert.ok(kept >= 10, 'oracle exercises kept rows, not only drops');
});

test('recentMonthlyAverage matches the Python oracle', () => {
  for (const c of load('ccavg-oracle.json')) {
    const totals = new Map(c.totals.map(([y, m, v]) => [y * 100 + m, v]));
    const got = recentMonthlyAverage(totals, c.window);
    assert.ok(Math.abs(got - c.expected) < 1e-9, `avg mismatch: js=${got} py=${c.expected}`);
  }
});

test('round2 matches Python round(x, 2) including ties-to-even', () => {
  for (const { x, expected } of load('round2-oracle.json')) {
    assert.strictEqual(round2(x), expected, `round2(${x})`);
  }
});

test('parseIsoDate: strict YYYY-MM-DD with real-calendar check', () => {
  assert.equal(parseIsoDate('2026-06-11'), '2026-06-11');
  assert.equal(parseIsoDate('2026-02-30'), null);
  assert.equal(parseIsoDate('2026-13-01'), null);
  assert.equal(parseIsoDate('06/11/2026'), null);
  assert.equal(parseIsoDate(20260611), null);
  assert.equal(parseIsoDate(''), null);
});

test('parseEntry mirrors _parse_entry validation', () => {
  const good = parseEntry({ year: 2026, month: 'June', category: 'food', value: 12.345 });
  assert.deepStrictEqual(good, { year: 2026, month: 'June', category: 'food', value: 12.35 });

  const fails = [
    [{}, 'invalid year'],
    [{ year: 'x', month: 'June', category: 'food', value: 1 }, 'invalid year'],
    [{ year: 999, month: 'June', category: 'food', value: 1 }, 'invalid year'],
    [{ year: 2026, month: 'Juneish', category: 'food', value: 1 }, 'invalid month'],
    [{ year: 2026, month: 'June', category: '', value: 1 }, 'invalid category'],
    [{ year: 2026, month: 'June', category: 'x'.repeat(101), value: 1 }, 'category too long'],
    [{ year: 2026, month: 'June', category: 'food', value: NaN }, 'invalid value'],
    [{ year: 2026, month: 'June', category: 'food', value: Infinity }, 'invalid value'],
    [{ year: 2026, month: 'June', category: 'food', value: true }, 'invalid value'],
    [{ year: 2026, month: 'June', category: 'food', value: '5' }, 'invalid value'],
  ];
  for (const [payload, msg] of fails) {
    assert.throws(() => parseEntry(payload), (e) => e instanceof ApiError && e.message === msg,
      JSON.stringify(payload));
  }
  // requireValue=false skips the value check entirely
  const noVal = parseEntry({ year: 2026, month: 'June', category: 'food' }, { requireValue: false });
  assert.deepStrictEqual(noVal, { year: 2026, month: 'June', category: 'food' });
});

test('applyTxFields: direction owned by category; explicit tx_type only when uncategorized', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tx-')), 'f.db');
  const db = connect(dbPath);
  bootstrapSchema(db);
  seedDefaults(db);
  const incomeCat = db.prepare("SELECT id FROM categories WHERE \"key\"='income'").get().id;

  // create with category: tx_type comes from the category, payload ignored
  const t = newTx();
  assert.equal(
    applyTxFields(db, t, {
      date: '2026-06-01', description: 'PAYCHECK', amount: -1234.567,
      category_id: incomeCat, tx_type: 'expense',
    }, { requireAll: true }),
    null
  );
  assert.equal(t.tx_type, 'income', 'category owns direction');
  assert.equal(t.amount, 1234.57, 'positive magnitude, cents-rounded');

  // uncategorized: explicit tx_type applies
  const u = newTx();
  assert.equal(
    applyTxFields(db, u, { date: '2026-06-02', description: 'misc', amount: 5, tx_type: 'transfer' },
      { requireAll: true }),
    null
  );
  assert.equal(u.tx_type, 'transfer');

  // validation failures return the exact Flask error strings
  assert.equal(applyTxFields(db, newTx(), { date: 'nope' }, { requireAll: true }),
    'invalid date (expected YYYY-MM-DD)');
  assert.equal(applyTxFields(db, newTx(),
    { date: '2026-01-01', description: 'x', amount: 1, tx_type: 'bogus' }, { requireAll: true }),
    'invalid tx_type');
  assert.equal(applyTxFields(db, newTx(),
    { date: '2026-01-01', description: 'x', amount: 1, category_id: 99999 }, { requireAll: true }),
    'unknown category_id');
  assert.equal(applyTxFields(db, newTx(),
    { date: '2026-01-01', description: 'x', amount: 1, category_id: true }, { requireAll: true }),
    'invalid category_id');

  // truncation caps
  const long = newTx();
  applyTxFields(db, long, {
    date: '2026-01-01', description: 'D'.repeat(250), amount: 1, notes: 'N'.repeat(600),
  }, { requireAll: true });
  assert.equal(long.description.length, 200);
  assert.equal(long.notes.length, 500);
  db.close();
});
