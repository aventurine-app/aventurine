'use strict';

// Metrics (Reports). NEW behaviour (not a Python port) → no oracle fixture:
// the metrics/goals service is pinned by the deterministic unit tests below,
// and the aggregation endpoint by API tests over a seeded DB.

const test = require('node:test');
const assert = require('node:assert');

const { buildReportCards, evaluateGoals, INFLATION_CATEGORIES } = require('../services/reportCard');
const { makeClient } = require('./helpers');

// ── service: every card shows all six goals, status met/near/miss/na ──────────

const ALL_KEYS = ['expense_ratio', 'debt_to_income', 'savings_rate', 'invested_rate',
  'spending_trend', 'income_trend'];
const statusOf = (goals, key) => goals.find((g) => g.key === key).status;

test('evaluateGoals: always returns all six goals in a fixed order', () => {
  const goals = evaluateGoals({ income: 100000, expenses: 50000, debt: 10000, prev: null });
  assert.deepEqual(goals.map((g) => g.key), ALL_KEYS);
});

test('evaluateGoals: a frugal year meets every evaluable goal', () => {
  // 50% expense ratio, 10% DTI → both ratio goals met; no prior year → the two
  // trend goals are not evaluable (na).
  const goals = evaluateGoals({ income: 100000, expenses: 50000, debt: 10000, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'met');
  assert.equal(statusOf(goals, 'debt_to_income'), 'met');
  assert.equal(statusOf(goals, 'spending_trend'), 'na');
  assert.equal(statusOf(goals, 'income_trend'), 'na');
});

test('evaluateGoals: missing debt makes the debt-to-income goal na (still shown)', () => {
  const goals = evaluateGoals({ income: 100000, expenses: 50000, debt: null, prev: null });
  assert.equal(statusOf(goals, 'debt_to_income'), 'na');
  assert.equal(goals.find((g) => g.key === 'debt_to_income').value, null);
});

test('evaluateGoals: overspending misses the expense-ratio goal', () => {
  // Spent everything, no debt data, no prior year.
  const goals = evaluateGoals({ income: 100000, expenses: 100000, debt: null, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'miss');
});

test('evaluateGoals: zero income makes the ratio goals na (undefined ratios)', () => {
  const goals = evaluateGoals({ income: 0, expenses: 1000, debt: 500, prev: null });
  assert.equal(statusOf(goals, 'expense_ratio'), 'na');
  assert.equal(statusOf(goals, 'debt_to_income'), 'na');
});

// ── service: three levels, and the investing BAND ─────────────────────────────

test('evaluateGoals: a ratio goal just past its bound is near, not missed', () => {
  // 73% expenses / 28% debt: both over, both inside the 5-point near band.
  const near = evaluateGoals({ income: 100000, expenses: 73000, debt: 28000, prev: null });
  assert.equal(statusOf(near, 'expense_ratio'), 'near');
  assert.equal(statusOf(near, 'debt_to_income'), 'near');

  // 76% / 31%: past the band, and now genuinely missed.
  const off = evaluateGoals({ income: 100000, expenses: 76000, debt: 31000, prev: null });
  assert.equal(statusOf(off, 'expense_ratio'), 'miss');
  assert.equal(statusOf(off, 'debt_to_income'), 'miss');
});

test('evaluateGoals: the saving goal is a floor at 20%, counting every transfer', () => {
  const grade = (transfers) =>
    statusOf(evaluateGoals({ income: 100000, expenses: 50000, debt: null, transfers, prev: null }), 'savings_rate');
  assert.equal(grade(14000), 'miss');  // 14% — under the near band
  assert.equal(grade(17000), 'near');  // 17% — short, but close
  assert.equal(grade(20000), 'met');   // 20% — the floor itself
  assert.equal(grade(31000), 'met');   // 31% — above the floor still grades met

  // Saving and investing are graded separately: the investing share can fall
  // below its floor while the total transfers share clears its own.
  const goals = evaluateGoals({ income: 100000, expenses: 50000, debt: null, transfers: 24000, invested: 8000, prev: null });
  assert.equal(statusOf(goals, 'savings_rate'), 'met');
  assert.equal(statusOf(goals, 'invested_rate'), 'miss');
});

test('evaluateGoals: the investing goal is a floor — beating the band still counts', () => {
  const grade = (invested) =>
    statusOf(evaluateGoals({ income: 100000, expenses: 50000, debt: null, invested, prev: null }), 'invested_rate');
  assert.equal(grade(9000), 'miss');   // 9% — under the near band
  assert.equal(grade(12000), 'near');  // 12% — short, but close
  assert.equal(grade(15000), 'met');   // 15% — the floor itself
  assert.equal(grade(18000), 'met');   // 18% — inside the band
  assert.equal(grade(40000), 'met');   // 40% — beating it is not overshooting it
});

test('evaluateGoals: the investing goal ships the band it is drawn against', () => {
  const goal = evaluateGoals({ income: 100000, expenses: 50000, debt: 10000, invested: 18000, prev: null })
    .find((g) => g.key === 'invested_rate');
  assert.deepEqual(goal.range, [0.15, 0.20]);
  assert.equal(goal.target, 0.15);
  // The threshold goals are lines, not bands.
  const er = evaluateGoals({ income: 100000, expenses: 50000, debt: 10000, prev: null })
    .find((g) => g.key === 'expense_ratio');
  assert.equal(er.range, null);
  assert.equal(er.target, 0.70);
});

test('evaluateGoals: a small move the wrong way is near, a large one is missed', () => {
  // Spending up 1.5%, income down 1%: both adverse, both under the 2% band.
  const near = evaluateGoals({
    income: 99000, expenses: 60900, debt: null,
    prev: { income: 100000, expenses: 60000 },
  });
  assert.equal(statusOf(near, 'spending_trend'), 'near');
  assert.equal(statusOf(near, 'income_trend'), 'near');

  const off = evaluateGoals({
    income: 80000, expenses: 75000, debt: null,
    prev: { income: 100000, expenses: 60000 },
  });
  assert.equal(statusOf(off, 'spending_trend'), 'miss');
  assert.equal(statusOf(off, 'income_trend'), 'miss');
});

// ── service: year-over-year trend goals ───────────────────────────────────────

test('evaluateGoals: spending/income trend goals reward the right direction', () => {
  const prev = { income: 100000, expenses: 60000 };
  // Income up, spending down → both YoY goals met.
  const goals = evaluateGoals({ income: 105000, expenses: 57000, debt: null, prev });
  assert.equal(statusOf(goals, 'spending_trend'), 'met');
  assert.equal(statusOf(goals, 'income_trend'), 'met');
});

test('evaluateGoals: a flat year leaves the trend goals na (no change)', () => {
  const prev = { income: 100000, expenses: 60000 };
  const goals = evaluateGoals({ income: 100000, expenses: 60000, debt: null, prev });
  assert.equal(statusOf(goals, 'spending_trend'), 'na');
  assert.equal(statusOf(goals, 'income_trend'), 'na');
});

// ── service: buildReportCards (changes, metrics, prev linkage) ────────────────

test('buildReportCards: ascending order, YoY changes vs the immediately prior year', () => {
  const cards = buildReportCards([
    { year: 2025, income: 100000, expenses: 60000, debt: null },
    { year: 2024, income: 80000, expenses: 50000, debt: null },
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
    { year: 2026, income: 90000, expenses: 50000, debt: null },
    { year: 2024, income: 80000, expenses: 50000, debt: null },
  ]);
  // 2025 is missing, so 2026 has no immediate predecessor.
  assert.equal(cards.find((c) => c.year === 2026).changes.income, null);
});

test('buildReportCards: metrics — ratios + cash-flow margin', () => {
  const [card] = buildReportCards([
    { year: 2025, income: 100000, expenses: 50000, debt: 25000 },
  ]);
  assert.equal(card.metrics.expenseToIncome, 0.5);
  assert.equal(card.metrics.debtToIncome, 0.25);
  // (100000 - 50000) / 100000 — transfers don't reduce the margin.
  assert.equal(card.metrics.cashFlowMargin, 0.5);
});

test('buildReportCards: zero income → undefined ratios are null, not NaN/Infinity', () => {
  const [card] = buildReportCards([
    { year: 2025, income: 0, expenses: 1000, debt: 500 },
  ]);
  assert.equal(card.metrics.expenseToIncome, null);
  assert.equal(card.metrics.debtToIncome, null);
  assert.equal(card.metrics.cashFlowMargin, null);
  // All six goals are still shown, every one na (nothing evaluable).
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
  // All six goals shown, none evaluable yet (no income/prior year) → all na.
  assert.equal(y.goals.length, 6);
  assert.ok(y.goals.every((g) => g.status === 'na'));
});

test('report-card API: aggregates a Cash Flow year by category cat_type', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  const entry = (category, value) =>
    c.post('/api/entry', { year: 2025, month: 'January', category, value });

  // 2025: income 100k, expenses 50k (rent). The 'savings' and 'investing'
  // categories are transfers now — money moved, not spent — so they must NOT
  // land in either headline bucket.
  entry('income', 100000);
  entry('rent', 50000);
  entry('savings', 15000);
  entry('investing', 5000);

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.ok(y, 'expected a 2025 card');
  assert.equal(y.income, 100000);
  assert.equal(y.expenses, 50000); // transfers excluded
  assert.equal(y.net, 50000);
  assert.equal(y.debt, null);
  assert.equal(y.metrics.expenseToIncome, 0.5);
  assert.equal(y.metrics.cashFlowMargin, 0.5);
  // ...but transfers are still REPORTED, as a separate total and two ratios.
  assert.equal(y.transfers, 20000);   // savings + investing
  assert.equal(y.invested, 5000);     // the investing category alone
  assert.equal(y.metrics.savingsRate, 0.2);
  assert.equal(y.metrics.investedRate, 0.05);
  // 50% expenses → ratio goal met; no prior year → trends na.
  assert.equal(statusOf(y.goals, 'expense_ratio'), 'met');
  assert.equal(statusOf(y.goals, 'spending_trend'), 'na');
  assert.equal(statusOf(y.goals, 'income_trend'), 'na');
});

test('report-card API: a tracked year with no activity still gets a (goal-less) card', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2020 });
  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2020);
  assert.ok(y, 'expected a 2020 card even with no activity');
  assert.equal(y.income, 0);
  assert.equal(y.goals.length, 6);
  assert.ok(y.goals.every((g) => g.status === 'na'));
});

test('report-card API: transactions in a year with no year-table are not counted', (t) => {
  const c = makeClient(t);
  const id = categoryIds(c);
  // 2019 has no year-table — its transactions stay off the statement, so no card.
  c.post('/api/transactions', { date: '2019-03-01', description: 'pay', category_id: id.income, amount: 100000 });
  assert.ok(!c.get('/api/report-card').body.years.some((yr) => yr.year === 2019));
});

test('report-card API: cells pull figures from transactions, entries override per cell', (t) => {
  const c = makeClient(t);
  const id = categoryIds(c);
  c.post('/api/year', { year: 2025 });

  c.post('/api/transactions', { date: '2025-01-01', description: 'pay', category_id: id.income, amount: 4000 });
  c.post('/api/transactions', { date: '2025-01-02', description: 'rent', tx_type: 'expense', amount: 1500 });

  let y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.income, 4000);
  assert.equal(y.expenses, 1500); // uncategorized expense, via the uncat bucket

  // A manual entry replaces its one cell's computed sum in the totals too.
  c.post('/api/entry', { year: 2025, month: 'January', category: 'income', value: 5000 });
  y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.income, 5000);
  assert.equal(y.expenses, 1500);
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

// ── the transfer / concentration metrics the Metrics report added ────────────

test('report-card API: the savings rate counts every transfer category, invested only Investing', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  const entry = (category, value) =>
    c.post('/api/entry', { year: 2025, month: 'February', category, value });

  // A user-created brokerage category, added alongside the seeded pair.
  const cat = c.post('/api/categories', { name: 'Vacation Fund', cat_type: 'transfer' });
  assert.equal(cat.status, 200, JSON.stringify(cat.body));

  entry('income', 100000);
  entry('savings', 10000);
  entry('investing', 15000);
  entry(cat.body.category.key, 5000);

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.transfers, 30000);
  assert.equal(y.metrics.savingsRate, 0.3);
  // The custom category rides the savings rate but is not "invested" — only the
  // seeded investing key is.
  assert.equal(y.invested, 15000);
  assert.equal(y.metrics.investedRate, 0.15);
});

test('report-card API: largest expense names the biggest category and its share of spending', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  const entry = (category, value) =>
    c.post('/api/entry', { year: 2025, month: 'March', category, value });

  entry('income', 50000);
  entry('rent', 12000);
  entry('food', 4000);
  entry('automobile', 4000);

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.topExpense.key, 'rent');
  assert.equal(typeof y.topExpense.name, 'string');
  assert.equal(y.topExpense.amount, 12000);
  // Measured against EXPENSES (20000), not income.
  assert.equal(y.metrics.topExpenseShare, 0.6);
});

test('report-card API: a year with no spending has no largest expense', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  c.post('/api/entry', { year: 2025, month: 'April', category: 'income', value: 50000 });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  assert.equal(y.topExpense, null);
  assert.equal(y.metrics.topExpenseShare, null);
  assert.equal(y.transfers, 0);
  assert.equal(y.metrics.savingsRate, 0);
});

test('report-card API: net and its YoY pill ignore transfers entirely', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2024 });
  c.post('/api/year', { year: 2025 });
  c.post('/api/entry', { year: 2024, month: 'January', category: 'income', value: 80000 });
  c.post('/api/entry', { year: 2024, month: 'January', category: 'rent',   value: 40000 });
  c.post('/api/entry', { year: 2025, month: 'January', category: 'income', value: 100000 });
  c.post('/api/entry', { year: 2025, month: 'January', category: 'rent',   value: 50000 });
  // Money moved to savings in 2025 only — net must be unchanged.
  c.post('/api/entry', { year: 2025, month: 'January', category: 'savings', value: 25000 });

  const years = c.get('/api/report-card').body.years;
  const y2025 = years.find((y) => y.year === 2025);
  assert.equal(y2025.net, 50000);
  assert.deepEqual(y2025.changes.net, { abs: 10000, pct: 0.25 });
  assert.deepEqual(y2025.changes.transfers, { abs: 25000, pct: null }); // grew from nothing
  assert.equal(years.find((y) => y.year === 2024).changes.net, null);
});

// ── Inflation series ─────────────────────────────────────────────────────────

test('buildReportCards: the inflation series is always all five categories, in order', () => {
  const [card] = buildReportCards([
    { year: 2025, income: 100000, expenses: 20000, debt: null, expenseByCat: { food: 4000 } },
  ]);
  assert.deepEqual(card.inflation.map((c) => c.key), INFLATION_CATEGORIES);
  // A category with no spend holds its place at zero rather than dropping out —
  // the section draws a fixed set of small multiples.
  assert.equal(card.inflation.find((c) => c.key === 'rent').amount, 0);
  assert.equal(card.inflation.find((c) => c.key === 'food').amount, 4000);
});

test('buildReportCards: inflation pct is per category against the immediately prior year', () => {
  const cards = buildReportCards([
    { year: 2024, income: 100000, expenses: 20000, debt: null, expenseByCat: { rent: 12000, food: 5000 } },
    { year: 2025, income: 100000, expenses: 22000, debt: null, expenseByCat: { rent: 13200, food: 4000 } },
  ]);
  const pct = (card, key) => card.inflation.find((c) => c.key === key).pct;
  // The earliest year has nothing to compare against.
  assert.equal(pct(cards[0], 'rent'), null);
  assert.equal(pct(cards[1], 'rent'), 0.1);   // 12000 → 13200
  assert.equal(pct(cards[1], 'food'), -0.2);  // 5000 → 4000, a fall
});

test('buildReportCards: a rise from nothing has no percentage (null, not Infinity)', () => {
  const cards = buildReportCards([
    { year: 2024, income: 100000, expenses: 0, debt: null, expenseByCat: {} },
    { year: 2025, income: 100000, expenses: 900, debt: null, expenseByCat: { utilities: 900 } },
  ]);
  const u = cards[1].inflation.find((c) => c.key === 'utilities');
  assert.equal(u.amount, 900);
  assert.equal(u.pct, null);
});

test('buildReportCards: a gap year breaks the inflation chain too', () => {
  const cards = buildReportCards([
    { year: 2024, income: 100000, expenses: 12000, debt: null, expenseByCat: { rent: 12000 } },
    { year: 2026, income: 100000, expenses: 13000, debt: null, expenseByCat: { rent: 13000 } },
  ]);
  assert.equal(cards.find((c) => c.year === 2026).inflation.find((c) => c.key === 'rent').pct, null);
});

test('report-card API: the inflation series carries each category its display name', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2024 });
  c.post('/api/year', { year: 2025 });
  const entry = (year, category, value) =>
    c.post('/api/entry', { year, month: 'March', category, value });

  entry(2024, 'income', 50000);
  entry(2024, 'rent', 12000);
  entry(2025, 'income', 50000);
  entry(2025, 'rent', 15000);

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  const rent = y.inflation.find((row) => row.key === 'rent');
  assert.equal(rent.name, 'Rent / Mortgage');
  assert.equal(rent.amount, 15000);
  assert.equal(rent.pct, 0.25);
});

test('report-card API: renaming a charted category keeps its key and follows the name', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  c.post('/api/entry', { year: 2025, month: 'March', category: 'automobile', value: 3000 });
  const ids = categoryIds(c);
  c.put(`/api/categories/${ids.automobile}`, { name: 'Getting Around' });

  const y = c.get('/api/report-card').body.years.find((yr) => yr.year === 2025);
  const auto = y.inflation.find((row) => row.key === 'automobile');
  assert.equal(auto.name, 'Getting Around');
  assert.equal(auto.amount, 3000);
});
