'use strict';

// Budget envelopes. A single recurring target per category (budget_amounts)
// compared against a month's actual spend. Targets are global — only the GET's
// (year, month) scopes which month's actuals/received are shown. Transactions
// are inserted directly via the conn handle (no dependence on the tx-create
// endpoint's semantics). Migration/version assertions live in foundation.test.js
// + forecast.test.js (both keyed on SCHEMA_VERSION).

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

function get(c, year = YEAR, month = MONTH) {
  return c.get(`/api/budget?year=${year}&month=${month}`).body;
}

function row(c, key, year = YEAR, month = MONTH) {
  return get(c, year, month).categories.find((x) => x.key === key);
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
  assert.deepStrictEqual(r.body.summary, { received: 0 });
});

// ── targets ────────────────────────────────────────────────────────────────

test('budget: target upsert and delete', (t) => {
  const c = makeClient(t);
  const base = { category: 'groceries' };

  assert.equal(c.post('/api/budget/target', { ...base, value: 500 }).status, 200);
  assert.equal(row(c, 'groceries').target, 500);

  // Upsert overwrites.
  c.post('/api/budget/target', { ...base, value: 650 });
  assert.equal(row(c, 'groceries').target, 650);

  // Delete untracks.
  assert.equal(c.del('/api/budget/target', base).status, 200);
  assert.equal(row(c, 'groceries').target, 0);
});

test('budget: a target applies to every month', (t) => {
  const c = makeClient(t);
  c.post('/api/budget/target', { category: 'groceries', value: 500 });
  // The same recurring figure shows for any month queried — there is no
  // per-month target to set differently.
  assert.equal(row(c, 'groceries', YEAR, 'January').target, 500);
  assert.equal(row(c, 'groceries', YEAR, 'July').target, 500);
  assert.equal(row(c, 'groceries', YEAR + 1, 'December').target, 500);
});

test('budget: target validation', (t) => {
  const c = makeClient(t);
  // Non-budgetable categories are rejected.
  assert.equal(c.post('/api/budget/target', { category: 'income', value: 100 }).status, 400);
  assert.equal(c.post('/api/budget/target', { category: 'uncat_expense', value: 100 }).status, 400);
  assert.equal(c.post('/api/budget/target', { category: 'nope', value: 100 }).status, 400);
  assert.equal(c.post('/api/budget/target', { category: '', value: 100 }).status, 400);
  // Bad amount.
  assert.equal(c.post('/api/budget/target', { category: 'groceries', value: 'x' }).status, 400);
  assert.equal(c.post('/api/budget/target', { category: 'groceries', value: -5 }).status, 400);
});

// ── actuals ────────────────────────────────────────────────────────────────

test("budget: actuals come from the viewed month's transactions", (t) => {
  const c = makeClient(t);
  const groceries = catId(c, 'groceries');

  insertTx(c, { date: '2026-03-04', amount: 300, category_id: groceries });
  insertTx(c, { date: '2026-03-20', amount: 120, category_id: groceries });
  insertTx(c, { date: '2026-04-02', amount: 999, category_id: groceries });

  c.post('/api/budget/target', { category: 'groceries', value: 500 });

  // March sees only March spend; the global target is unchanged in April.
  const march = row(c, 'groceries', YEAR, 'March');
  assert.equal(march.spent, 420);
  assert.equal(march.remaining, 80);

  const april = row(c, 'groceries', YEAR, 'April');
  assert.equal(april.target, 500);
  assert.equal(april.spent, 999);
  assert.equal(april.remaining, -499);
});

test('budget: over-budget shows a negative remaining', (t) => {
  const c = makeClient(t);
  const groceries = catId(c, 'groceries');
  insertTx(c, { date: '2026-03-04', amount: 420, category_id: groceries });
  c.post('/api/budget/target', { category: 'groceries', value: 300 });

  assert.equal(row(c, 'groceries').remaining, -120);
});

// ── income reference ─────────────────────────────────────────────────────────

test('budget: income received is reported for the viewed month only', (t) => {
  const c = makeClient(t);
  const income = catId(c, 'income');
  insertTx(c, { date: '2026-03-05', amount: 1500, category_id: income, tx_type: 'income' });
  insertTx(c, { date: '2026-03-06', amount: 200, category_id: null, tx_type: 'income' });
  insertTx(c, { date: '2026-03-06', amount: 999, category_id: null, tx_type: 'expense' }); // not income
  insertTx(c, { date: '2026-04-10', amount: 4000, category_id: income, tx_type: 'income' });

  assert.equal(get(c, YEAR, 'March').summary.received, 1700); // incl. uncategorized income
  assert.equal(get(c, YEAR, 'April').summary.received, 4000);
  assert.equal(get(c, YEAR, 'May').summary.received, 0);
});

// ── category delete cleans up the budget ─────────────────────────────────────

test('budget: deleting a category with a budget leaves no orphan', (t) => {
  const c = makeClient(t);
  // 'general' is a budgetable expense category with no transactions/entries.
  const general = catId(c, 'general');
  c.post('/api/budget/target', { category: 'general', value: 75 });

  const del = c.del(`/api/categories/${general}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const orphans = c.conn
    .db()
    .prepare("SELECT COUNT(*) AS n FROM budget_amounts WHERE category = 'general'")
    .get().n;
  assert.equal(orphans, 0);
});
