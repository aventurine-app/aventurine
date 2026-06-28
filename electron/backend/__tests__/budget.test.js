'use strict';

// Budget Buckets (Account Tracking). Targets + actuals are exercised through the
// API; transactions are inserted directly via the conn handle (no dependence on
// the tx-create endpoint's semantics). The migration/version assertions live in
// foundation.test.js + forecast.test.js (both keyed on SCHEMA_VERSION).

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

const YEAR = 2026;
const MONTH = 'March';

function catId(c, key) {
  return c.conn.db().prepare('SELECT id FROM categories WHERE "key" = ?').get(key).id;
}

function insertTx(c, { date, amount, category_id = null, tx_type = 'expense' }) {
  c.conn
    .db()
    .prepare(
      "INSERT INTO transactions (date, description, category_id, amount, notes, tx_type) VALUES (?, '', ?, ?, '', ?)"
    )
    .run(date, category_id, amount, tx_type);
}

// ── shape ────────────────────────────────────────────────────────────────────

test('budget: GET lists only budgetable categories with zero defaults', (t) => {
  const c = makeClient(t);
  const r = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Seeded budgetable = 11 expense (rent, utilities, groceries, dining,
  // automobile, health, entertainment, shopping, travel, insurance, general)
  // + 2 savings + investing = 14. Income + the uncat_* system buckets excluded.
  assert.equal(r.body.categories.length, 14);
  const keys = r.body.categories.map((x) => x.key);
  assert.ok(!keys.includes('income'));
  assert.ok(!keys.includes('uncat_income'));
  assert.ok(!keys.includes('uncat_expense'));
  assert.ok(keys.includes('groceries') && keys.includes('savings') && keys.includes('investing'));
  for (const cat of r.body.categories) {
    assert.equal(cat.target, 0);
    assert.equal(cat.spent, 0);
  }
  assert.deepStrictEqual(r.body.summary, {
    expectedIncome: 0, incomeSource: 'average', received: 0,
    budgeted: 0, leftToBudget: 0, spent: 0, remaining: 0,
  });
});

// ── targets ────────────────────────────────────────────────────────────────

test('budget: target upsert and delete', (t) => {
  const c = makeClient(t);
  const base = { year: YEAR, month: MONTH, category: 'groceries' };

  assert.equal(c.post('/api/budget/target', { ...base, value: 500 }).status, 200);
  let groceries = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.categories.find((x) => x.key === 'groceries');
  assert.equal(groceries.target, 500);

  // Upsert overwrites.
  c.post('/api/budget/target', { ...base, value: 650 });
  groceries = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.categories.find((x) => x.key === 'groceries');
  assert.equal(groceries.target, 650);

  // Delete untracks.
  assert.equal(c.del('/api/budget/target', base).status, 200);
  groceries = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.categories.find((x) => x.key === 'groceries');
  assert.equal(groceries.target, 0);
});

test('budget: target validation', (t) => {
  const c = makeClient(t);
  const ok = { year: YEAR, month: MONTH, category: 'groceries', value: 100 };
  // Non-budgetable categories are rejected.
  assert.equal(c.post('/api/budget/target', { ...ok, category: 'income' }).status, 400);
  assert.equal(c.post('/api/budget/target', { ...ok, category: 'uncat_expense' }).status, 400);
  assert.equal(c.post('/api/budget/target', { ...ok, category: 'nope' }).status, 400);
  // Bad amount / month / year.
  assert.equal(c.post('/api/budget/target', { ...ok, value: 'x' }).status, 400);
  assert.equal(c.post('/api/budget/target', { ...ok, value: -5 }).status, 400);
  assert.equal(c.post('/api/budget/target', { ...ok, month: 'Smarch' }).status, 400);
  assert.equal(c.post('/api/budget/target', { ...ok, year: 50 }).status, 400);
});

test('budget: copy month carries targets forward and overwrites', (t) => {
  const c = makeClient(t);
  c.post('/api/budget/target', { year: YEAR, month: 'February', category: 'groceries', value: 500 });
  c.post('/api/budget/target', { year: YEAR, month: 'February', category: 'rent', value: 1500 });
  // A stale value in March that the copy should overwrite.
  c.post('/api/budget/target', { year: YEAR, month: 'March', category: 'groceries', value: 100 });

  const r = c.post('/api/budget/copy', {
    from_year: YEAR, from_month: 'February', to_year: YEAR, to_month: 'March',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.copied, 2);

  const march = c.get(`/api/budget?year=${YEAR}&month=March`).body.categories;
  assert.equal(march.find((x) => x.key === 'groceries').target, 500); // overwritten
  assert.equal(march.find((x) => x.key === 'rent').target, 1500);

  // Copying a month onto itself is rejected.
  assert.equal(
    c.post('/api/budget/copy', { from_year: YEAR, from_month: 'March', to_year: YEAR, to_month: 'March' }).status,
    400
  );
});

// ── actuals ────────────────────────────────────────────────────────────────

test('budget: actuals come from the month\'s transactions', (t) => {
  const c = makeClient(t);
  const groceries = catId(c, 'groceries');

  insertTx(c, { date: '2026-03-04', amount: 300, category_id: groceries });
  insertTx(c, { date: '2026-03-20', amount: 120, category_id: groceries });
  insertTx(c, { date: '2026-04-02', amount: 999, category_id: groceries }); // different month → excluded

  c.post('/api/budget/target', { year: YEAR, month: MONTH, category: 'groceries', value: 500 });

  const data = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body;
  const groceriesRow = data.categories.find((x) => x.key === 'groceries');
  assert.equal(groceriesRow.spent, 420);
  assert.equal(groceriesRow.remaining, 80);
  assert.equal(data.summary.budgeted, 500);
  assert.equal(data.summary.spent, 420);
  assert.equal(data.summary.remaining, 80);
});

test('budget: over-budget shows a negative remaining', (t) => {
  const c = makeClient(t);
  const groceries = catId(c, 'groceries');
  insertTx(c, { date: '2026-03-04', amount: 420, category_id: groceries });
  c.post('/api/budget/target', { year: YEAR, month: MONTH, category: 'groceries', value: 300 });

  const groceriesRow = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.categories.find((x) => x.key === 'groceries');
  assert.equal(groceriesRow.remaining, -120);
});

test('budget: expected income defaults to the trailing average of prior months', (t) => {
  const c = makeClient(t);
  const income = catId(c, 'income');
  // Two complete months BEFORE March set the average.
  insertTx(c, { date: '2026-01-10', amount: 4000, category_id: income, tx_type: 'income' });
  insertTx(c, { date: '2026-02-10', amount: 4000, category_id: income, tx_type: 'income' });
  // March income so far: categorized + uncategorized = "received".
  insertTx(c, { date: '2026-03-05', amount: 1500, category_id: income, tx_type: 'income' });
  insertTx(c, { date: '2026-03-06', amount: 200, category_id: null, tx_type: 'income' });
  insertTx(c, { date: '2026-03-06', amount: 999, category_id: null, tx_type: 'expense' }); // not income

  c.post('/api/budget/target', { year: YEAR, month: MONTH, category: 'groceries', value: 500 });

  const s = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.summary;
  assert.equal(s.incomeSource, 'average');
  assert.equal(s.expectedIncome, 4000); // avg of Jan+Feb; March (current) excluded
  assert.equal(s.received, 1700);       // March income so far, incl. uncategorized income
  assert.equal(s.leftToBudget, 3500);   // expected 4000 - budgeted 500
});

test('budget: expected income can be overridden per month and cleared', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/budget/income', { year: YEAR, month: MONTH, amount: 5000 }).status, 200);
  let s = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.summary;
  assert.equal(s.incomeSource, 'override');
  assert.equal(s.expectedIncome, 5000);

  // Clearing the override reverts to the average (0 here — no prior history).
  assert.equal(c.del('/api/budget/income', { year: YEAR, month: MONTH }).status, 200);
  s = c.get(`/api/budget?year=${YEAR}&month=${MONTH}`).body.summary;
  assert.equal(s.incomeSource, 'average');
  assert.equal(s.expectedIncome, 0);
});

test('budget: expected-income override validation', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/budget/income', { year: YEAR, month: MONTH, amount: -1 }).status, 400);
  assert.equal(c.post('/api/budget/income', { year: YEAR, month: MONTH, amount: 'x' }).status, 400);
  assert.equal(c.post('/api/budget/income', { year: 50, month: MONTH, amount: 100 }).status, 400);
  assert.equal(c.post('/api/budget/income', { year: YEAR, month: 'Smarch', amount: 100 }).status, 400);
});

// ── category delete cleans up targets ────────────────────────────────────────

test('budget: deleting a category with only a target leaves no orphan', (t) => {
  const c = makeClient(t);
  // 'general' is a budgetable expense category with no transactions/entries.
  const general = catId(c, 'general');
  c.post('/api/budget/target', { year: YEAR, month: MONTH, category: 'general', value: 75 });

  const del = c.del(`/api/categories/${general}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const orphans = c.conn
    .db()
    .prepare("SELECT COUNT(*) AS n FROM budget_targets WHERE category = 'general'")
    .get().n;
  assert.equal(orphans, 0);
});
