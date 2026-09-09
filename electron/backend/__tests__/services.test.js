'use strict';

// Tests for the pure services, plus semantic tests for applyTxFields /
// parseEntry. The fixtures under fixtures/ are golden values: they pin
// behaviour that is expensive to re-derive and easy to change by accident.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectRecurringExpenses } = require('../services/predictions');
const { round2, parseEntry, parseIsoDate, ApiError } = require('../validate');
const { applyTxFields, newTx } = require('../services/transactions');
const { connect } = require('../db');
const { bootstrapSchema } = require('../migrate');
const { seedDefaults } = require('../seed');

const FIXTURES = path.join(__dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('detectRecurringExpenses holds its pinned values', () => {
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

test('round2: half away from zero, on the decimal the user typed', () => {
  // The cases that separate a decimal-domain shift from `x * 100`. Each of
  // these is stored as a double slightly BELOW the half-cent it reads as
  // (2.675 is really 2.674999999999999822), so a binary multiply rounds them
  // for the wrong reason, in whichever direction its own error happens to fall.
  const cases = [
    [2.675, 2.68], [0.125, 0.13], [1.115, 1.12], [1.005, 1.01],
    [8.835, 8.84], [10.075, 10.08], [1234.565, 1234.57], [0.005, 0.01],
  ];
  for (const [x, want] of cases) {
    assert.strictEqual(round2(x), want, `round2(${x})`);
    assert.strictEqual(round2(-x), -want, `round2(${-x})`); // symmetric
  }
});

test('round2: already-rounded values are untouched, and it is idempotent', () => {
  // The re-save path. A value that has already been through round2 must come
  // back bit-identical, or every write would nudge stored money.
  for (let cents = -5000; cents <= 5000; cents++) {
    const v = cents / 100;
    assert.strictEqual(round2(v), v, `round2(${v})`);
    assert.strictEqual(round2(round2(v)), round2(v));
  }
});

test('round2: non-finite input passes through, -0 keeps its sign', () => {
  assert.ok(Number.isNaN(round2(NaN)));
  assert.strictEqual(round2(Infinity), Infinity);
  assert.strictEqual(round2(-Infinity), -Infinity);
  assert.ok(Object.is(round2(-0), -0));
  assert.strictEqual(round2(0), 0);
});

test('round2: output never carries more than two decimals', () => {
  for (let i = 0; i < 2000; i++) {
    const v = round2(Math.random() * 2e5 - 1e5);
    assert.strictEqual(v, Number(v.toFixed(2)), `round2 left fraction on ${v}`);
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

  // validation failures return the exact documented error strings
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
