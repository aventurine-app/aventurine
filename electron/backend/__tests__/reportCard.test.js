'use strict';

// Yearly Report Card (Reports). NEW behaviour (not a Python port) → no oracle
// fixture: the grading/metrics service is pinned by the deterministic unit tests
// below, and the aggregation endpoint by API tests over a seeded DB.

const test = require('node:test');
const assert = require('node:assert');

const { buildReportCards, gradeYear, letterFor } = require('../services/reportCard');
const { makeClient } = require('./helpers');

// ── service: letter bands ─────────────────────────────────────────────────────

test('letterFor: GPA cutoffs map score → letter', () => {
  assert.equal(letterFor(1.0), 'A');
  assert.equal(letterFor(0.93), 'A');
  assert.equal(letterFor(0.905), 'A-');
  assert.equal(letterFor(0.85), 'B');
  assert.equal(letterFor(0.71), 'C-');
  assert.equal(letterFor(0.61), 'D-');
  assert.equal(letterFor(0.59), 'F');
  assert.equal(letterFor(0), 'F');
});

// ── service: a single year's grade (no prior year → 3 ratio goals) ────────────

test('gradeYear: a frugal year hits every applicable goal → A', () => {
  // 50% expense ratio, 20% savings rate, 10% DTI → all three ratio goals score 1.
  const g = gradeYear({ income: 100000, expenses: 50000, savings: 20000, debt: 10000, prev: null });
  assert.equal(g.goals.length, 3);
  assert.ok(g.goals.every((x) => x.met));
  assert.equal(g.score, 1);
  assert.equal(g.letter, 'A');
});

test('gradeYear: missing debt drops the debt-to-income goal', () => {
  const g = gradeYear({ income: 100000, expenses: 50000, savings: 20000, debt: null, prev: null });
  assert.deepEqual(g.goals.map((x) => x.key), ['expense_ratio', 'savings_rate']);
});

test('gradeYear: overspending + no saving tanks the grade', () => {
  // Spent everything, saved nothing, no debt data, no prior year.
  const g = gradeYear({ income: 100000, expenses: 100000, savings: 0, debt: null, prev: null });
  assert.equal(g.goals.find((x) => x.key === 'expense_ratio').score, 0);
  assert.equal(g.goals.find((x) => x.key === 'savings_rate').score, 0);
  assert.equal(g.letter, 'F');
});

test('gradeYear: partial credit scales linearly between the goal and the floor', () => {
  // 85% expense ratio is halfway between the 70% goal and the 100% floor → 0.5.
  const g = gradeYear({ income: 100000, expenses: 85000, savings: 0, debt: null, prev: null });
  assert.equal(g.goals.find((x) => x.key === 'expense_ratio').score, 0.5);
});

// ── service: year-over-year goals only appear with a prior year ───────────────

test('gradeYear: spending/income trend goals reward the right direction', () => {
  const prev = { income: 100000, expenses: 60000, savings: 0 };
  // Income up 5%, spending down 5% → both YoY goals score a full 1.0.
  const g = gradeYear({ income: 105000, expenses: 57000, savings: 0, debt: null, prev });
  const spend = g.goals.find((x) => x.key === 'spending_trend');
  const inc = g.goals.find((x) => x.key === 'income_trend');
  assert.ok(spend.met && spend.score === 1);
  assert.ok(inc.met && inc.score === 1);
});

test('gradeYear: a flat year scores 0.5 on each YoY goal', () => {
  const prev = { income: 100000, expenses: 60000, savings: 0 };
  const g = gradeYear({ income: 100000, expenses: 60000, savings: 0, debt: null, prev });
  assert.equal(g.goals.find((x) => x.key === 'spending_trend').score, 0.5);
  assert.equal(g.goals.find((x) => x.key === 'income_trend').score, 0.5);
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
  assert.equal(y2024.grade.goals.every((g) => g.key.startsWith('expense') || g.key.startsWith('savings')), true);

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
  assert.equal(card.grade.letter, null); // nothing gradeable
  assert.deepEqual(card.grade.goals, []);
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

test('report-card API: a fresh DB shows only the seeded current year, ungradeable', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/report-card');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // seed.js seeds the current year into active_years.
  assert.deepEqual(r.body.years.map((y) => y.year), [CURRENT_YEAR]);
  const y = r.body.years[0];
  assert.equal(y.income, 0);
  assert.equal(y.expenses, 0);
  assert.equal(y.savings, 0);
  assert.equal(y.grade.letter, null); // no income → nothing to grade
});

test('report-card API: aggregates a Cash Flow year by category cat_type', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
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
  assert.equal(y.grade.letter, 'A');
});

test('report-card API: a tracked year with no activity still gets an (N/A) card', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2020 });
  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2020);
  assert.ok(y, 'expected a 2020 card even with no activity');
  assert.equal(y.income, 0);
  assert.equal(y.grade.letter, null);
});

test('report-card API: transactions alone do not feed an unsynced year', (t) => {
  const c = makeClient(t);
  const id = categoryIds(c);
  c.post('/api/year', { year: 2025 });
  // Not synced → the Cash Flow cell stays hand-entered (here, empty).
  c.post('/api/transactions', { date: '2025-03-01', description: 'pay', category_id: id.income, amount: 100000 });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.income, 0);
  assert.equal(y.grade.letter, null);
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
  c.post('/api/entry', { year: 2024, month: 'January', category: 'income', value: 80000 });
  c.post('/api/entry', { year: 2025, month: 'January', category: 'income', value: 100000 });

  const years = c.get('/api/report-card').body.years;
  // Newest-first overall (the seeded current year sorts ahead of both).
  const sorted = [...years.map((y) => y.year)].sort((a, b) => b - a);
  assert.deepEqual(years.map((y) => y.year), sorted);

  assert.deepEqual(years.find((y) => y.year === 2025).changes.income, { abs: 20000, pct: 0.25 });
  assert.equal(years.find((y) => y.year === 2024).changes.income, null);
});
