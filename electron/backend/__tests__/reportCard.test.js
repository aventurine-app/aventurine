'use strict';

// Yearly Report Card (Reports). NEW behaviour (not a Python port) → no oracle
// fixture: the metrics/goals service is pinned by the deterministic unit tests
// below, and the aggregation endpoint by API tests over a seeded DB.

const test = require('node:test');
const assert = require('node:assert');

const { buildReportCards, evaluateGoals } = require('../services/reportCard');
const { makeClient } = require('./helpers');

// ── service: every card shows all five goals, status met/miss/na ──────────────

const ALL_KEYS = ['expense_ratio', 'savings_rate', 'debt_to_income', 'spending_trend', 'income_trend'];
const statusOf = (goals, key) => goals.find((g) => g.key === key).status;

test('evaluateGoals: always returns all five goals in a fixed order', () => {
  const goals = evaluateGoals({ income: 100000, expenses: 50000, savings: 20000, debt: 10000, prev: null });
  assert.deepEqual(goals.map((g) => g.key), ALL_KEYS);
});

test('evaluateGoals: a frugal year meets every evaluable goal', () => {
  // 50% expense ratio, 20% savings rate, 10% DTI → all three ratio goals met;
  // no prior year → the two trend goals are not evaluable (na).
  const goals = evaluateGoals({ income: 100000, expenses: 50000, savings: 20000, debt: 10000, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'met');
  assert.equal(statusOf(goals, 'savings_rate'), 'met');
  assert.equal(statusOf(goals, 'debt_to_income'), 'met');
  assert.equal(statusOf(goals, 'spending_trend'), 'na');
  assert.equal(statusOf(goals, 'income_trend'), 'na');
});

test('evaluateGoals: missing debt makes the debt-to-income goal na (still shown)', () => {
  const goals = evaluateGoals({ income: 100000, expenses: 50000, savings: 20000, debt: null, prev: null });
  assert.equal(statusOf(goals, 'debt_to_income'), 'na');
  assert.equal(goals.find((g) => g.key === 'debt_to_income').value, null);
});

test('evaluateGoals: overspending + no saving misses both ratio goals', () => {
  // Spent everything, saved nothing, no debt data, no prior year.
  const goals = evaluateGoals({ income: 100000, expenses: 100000, savings: 0, debt: null, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'miss');
  assert.equal(statusOf(goals, 'savings_rate'), 'miss');
});

test('evaluateGoals: zero income makes the ratio goals na (undefined ratios)', () => {
  const goals = evaluateGoals({ income: 0, expenses: 1000, savings: 0, debt: 500, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'na');
  assert.equal(statusOf(goals, 'savings_rate'), 'na');
  assert.equal(statusOf(goals, 'debt_to_income'), 'na');
});

// ── service: year-over-year trend goals ───────────────────────────────────────

test('evaluateGoals: spending/income trend goals reward the right direction', () => {
  const prev = { income: 100000, expenses: 60000, savings: 0 };
  // Income up, spending down → both YoY goals met.
  const goals = evaluateGoals({ income: 105000, expenses: 57000, savings: 0, debt: null, prev });
  assert.equal(statusOf(goals, 'spending_trend'), 'met');
  assert.equal(statusOf(goals, 'income_trend'), 'met');
});

test('evaluateGoals: a flat year leaves the trend goals na (no change)', () => {
  const prev = { income: 100000, expenses: 60000, savings: 0 };
  const goals = evaluateGoals({ income: 100000, expenses: 60000, savings: 0, debt: null, prev });
  assert.equal(statusOf(goals, 'spending_trend'), 'na');
  assert.equal(statusOf(goals, 'income_trend'), 'na');
});

// ── service: buildReportCards (changes, metrics, prev linkage) ────────────────

test('buildReportCards: ascending order, YoY changes vs the immediately prior year', () => {
  const cards = buildReportCards([
    { year: 2025, income: 100000, expenses: 60000, savings: 10000, debt: null },
    { year: 2024, income: 80000, expenses: 50000, savings: 8000, debt: null },
  ]);
  assert.deepEqual(cards.map((c) => c.year), [2024, 2025]);

  const y2024 = cards[0];
  assert.equal(y2024.changes.income, null); // no 2023 to compare to
  // No prior year → the two trend goals are shown but not evaluable (na).
  assert.equal(statusOf(y2024.goals, 'spending_trend'), 'na');
  assert.equal(statusOf(y2024.goals, 'income_trend'), 'na');

  const y2025 = cards[1];
  assert.deepEqual(y2025.changes.income, { abs: 20000, pct: 0.25 });
  assert.deepEqual(y2025.changes.expenses, { abs: 10000, pct: 0.2 });
});

test('buildReportCards: a gap year breaks the YoY chain', () => {
  const cards = buildReportCards([
    { year: 2026, income: 90000, expenses: 50000, savings: 0, debt: null },
    { year: 2024, income: 80000, expenses: 50000, savings: 0, debt: null },
  ]);
  // 2025 is missing, so 2026 has no immediate predecessor.
  assert.equal(cards.find((c) => c.year === 2026).changes.income, null);
});

test('buildReportCards: metrics — ratios + cash-flow margin', () => {
  const [card] = buildReportCards([
    { year: 2025, income: 100000, expenses: 50000, savings: 20000, debt: 25000 },
  ]);
  assert.equal(card.metrics.expenseToIncome, 0.5);
  assert.equal(card.metrics.debtToIncome, 0.25);
  // (100000 - 50000 - 20000) / 100000.
  assert.equal(card.metrics.cashFlowMargin, 0.3);
});

test('buildReportCards: zero income → undefined ratios are null, not NaN/Infinity', () => {
  const [card] = buildReportCards([
    { year: 2025, income: 0, expenses: 1000, savings: 0, debt: 500 },
  ]);
  assert.equal(card.metrics.expenseToIncome, null);
  assert.equal(card.metrics.debtToIncome, null);
  assert.equal(card.metrics.cashFlowMargin, null);
  // All five goals are still shown, every one na (nothing evaluable).
  assert.deepEqual(card.goals.map((g) => g.key), ALL_KEYS);
  assert.ok(card.goals.every((g) => g.status === 'na'));
});

// ── API ───────────────────────────────────────────────────────────────────────

function categoryIds(c) {
  const cats = c.get('/api/categories').body.categories;
  return Object.fromEntries(cats.map((cat) => [cat.key, cat.id]));
}

const CURRENT_YEAR = new Date().getFullYear();

// Report-card figures now come from the Cash Flow statement (active_years +
// hand-entered cells + synced sums), NOT from raw transactions — so every year
// the user tracks gets a card, even an empty one.

test('report-card API: a fresh DB shows only the seeded current year, no evaluable goals', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/report-card');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // seed.js seeds the current year into active_years.
  assert.deepEqual(r.body.years.map((y) => y.year), [CURRENT_YEAR]);
  const y = r.body.years[0];
  assert.equal(y.income, 0);
  assert.equal(y.expenses, 0);
  assert.equal(y.savings, 0);
  // All five goals shown, none evaluable yet (no income/prior year) → all na.
  assert.equal(y.goals.length, 5);
  assert.ok(y.goals.every((g) => g.status === 'na'));
});

test('report-card API: aggregates a Cash Flow year by category cat_type', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  c.post('/api/year/2025/sync', { all: true, sync: false }); // new years default synced; hand-enter below
  const entry = (category, value) =>
    c.post('/api/entry', { year: 2025, month: 'January', category, value });

  // 2025: income 100k, expenses 50k (rent), savings 15k + investing 5k = 20k.
  entry('income', 100000);
  entry('rent', 50000);
  entry('savings', 15000);
  entry('investing', 5000);

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.ok(y, 'expected a 2025 card');
  assert.equal(y.income, 100000);
  assert.equal(y.expenses, 50000);
  assert.equal(y.savings, 20000); // savings + investing combined
  assert.equal(y.debt, null);
  assert.equal(y.metrics.expenseToIncome, 0.5);
  assert.equal(y.metrics.cashFlowMargin, 0.3);
  // 50% expenses, 20% saving → both ratio goals met; no prior year → trends na.
  assert.equal(statusOf(y.goals, 'expense_ratio'), 'met');
  assert.equal(statusOf(y.goals, 'savings_rate'), 'met');
  assert.equal(statusOf(y.goals, 'spending_trend'), 'na');
  assert.equal(statusOf(y.goals, 'income_trend'), 'na');
});

test('report-card API: a tracked year with no activity still gets a (goal-less) card', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2020 });
  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2020);
  assert.ok(y, 'expected a 2020 card even with no activity');
  assert.equal(y.income, 0);
  assert.equal(y.goals.length, 5);
  assert.ok(y.goals.every((g) => g.status === 'na'));
});

test('report-card API: transactions alone do not feed an unsynced year', (t) => {
  const c = makeClient(t);
  const id = categoryIds(c);
  c.post('/api/year', { year: 2025 });
  // New years default to fully synced; turn it off so the cell stays
  // hand-entered (here, empty) and transactions do NOT feed it.
  c.post('/api/year/2025/sync', { all: true, sync: false });
  c.post('/api/transactions', { date: '2025-03-01', description: 'pay', category_id: id.income, amount: 100000 });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.income, 0);
  assert.equal(y.goals.length, 5);
  assert.ok(y.goals.every((g) => g.status === 'na'));
});

test('report-card API: synced cells pull figures from transactions', (t) => {
  const c = makeClient(t);
  const id = categoryIds(c);
  c.post('/api/year', { year: 2025 });
  // Sync a categorized bucket and an uncategorized bucket for the year.
  c.post('/api/year/2025/sync', { category: 'income', sync: true });
  c.post('/api/year/2025/sync', { category: 'uncat_expense', sync: true });

  c.post('/api/transactions', { date: '2025-01-01', description: 'pay', category_id: id.income, amount: 4000 });
  c.post('/api/transactions', { date: '2025-01-02', description: 'rent', tx_type: 'expense', amount: 1500 });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.income, 4000);
  assert.equal(y.expenses, 1500); // uncategorized expense, via the synced uncat bucket
});

test('report-card API: debt-to-income uses the latest Balance-Sheet debt month', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  c.post('/api/year/2025/sync', { all: true, sync: false }); // new years default synced; hand-enter below
  c.post('/api/entry', { year: 2025, month: 'June', category: 'income', value: 100000 });

  // Add a debt-type Balance-Sheet column and give it two months in 2025.
  const col = c.post('/api/balance/columns', { label: 'Credit Card', type: 'debt' });
  assert.equal(col.status, 200, JSON.stringify(col.body));
  const key = col.body.column.key;
  c.post('/api/balance/entry', { year: 2025, month: 'January', category: key, value: 10000 });
  c.post('/api/balance/entry', { year: 2025, month: 'March', category: key, value: 20000 });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.debt, 20000); // latest month (March) wins
  assert.equal(y.metrics.debtToIncome, 0.2);
});

test('report-card API: multiple years come back newest-first with YoY changes', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2024 });
  c.post('/api/year', { year: 2025 });
  // New years default to fully synced; hand-enter income below.
  c.post('/api/year/2024/sync', { all: true, sync: false });
  c.post('/api/year/2025/sync', { all: true, sync: false });
  c.post('/api/entry', { year: 2024, month: 'January', category: 'income', value: 80000 });
  c.post('/api/entry', { year: 2025, month: 'January', category: 'income', value: 100000 });

  const years = c.get('/api/report-card').body.years;
  // Newest-first overall (the seeded current year sorts ahead of both).
  const sorted = [...years.map((y) => y.year)].sort((a, b) => b - a);
  assert.deepEqual(years.map((y) => y.year), sorted);

  assert.deepEqual(years.find((y) => y.year === 2025).changes.income, { abs: 20000, pct: 0.25 });
  assert.equal(years.find((y) => y.year === 2024).changes.income, null);
});
