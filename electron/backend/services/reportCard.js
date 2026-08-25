'use strict';

// Metrics (Reports) — pure metrics/goals logic, no DB handle.
// Given each year's income / expense / transfer / debt totals it derives the
// headline figures, year-over-year changes, the ratios, and the met/missed
// outcome of four money goals.
//
// Transfers (money moved to savings/brokerage accounts) stay out of every
// income/spend surface — they are not spending and not earning, so no goal is
// graded on them and they never dent the cash-flow margin. They are still
// REPORTED, as their own figure and as two ratios (savings rate, invested
// share): "what share of what I earned did I put away" is a question only the
// transfer total can answer, and it is the one the income/spend view is blind
// to by design.
//
// NEW behaviour (not a Python port) → no oracle fixture; pinned by the
// deterministic unit tests in __tests__/reportCard.test.js.

const { round2 } = require('../validate');

// Goal targets. The first two are absolute ratios; the last two are
// year-over-year movements.
const EXPENSE_RATIO_GOAL = 0.70; // keep expenses ≤ 70% of income
const DTI_GOAL = 0.25;           // keep total debt ≤ 25% of income

/** a / b, or null when the denominator is non-positive (ratio undefined). */
function ratio(a, b) {
  return b > 0 ? a / b : null;
}

/** Year-over-year change vs a prior figure. abs is rounded to cents; pct is
 *  null when there is no prior year, or the prior figure was zero (growth from
 *  nothing has no finite percentage — the UI renders that as "new"). */
function change(curr, prev) {
  if (prev == null) return null;
  return { abs: round2(curr - prev), pct: prev > 0 ? (curr - prev) / prev : null };
}

/**
 * Evaluate the four money goals for one year. `prev` is the previous year's
 * normalized row (or null for the earliest year). Every card shows all four
 * goals at all times; each yields { key, label, value, status } where status is
 * 'met' (✓), 'miss' (✕), or 'na' (—) — a goal is 'na' when it can't be judged
 * (undefined ratio, no prior year to compare against) or when a trend goal saw
 * no year-over-year change. `value` is null only when there's nothing to show.
 */
function evaluateGoals({ income, expenses, debt, prev }) {
  // status for a goal whose `value` is undefined (null) → 'na'; otherwise the
  // result of the threshold test passed in.
  const judge = (value, met) => (value == null ? 'na' : met ? 'met' : 'miss');

  const er = ratio(expenses, income);
  const dti = debt == null ? null : ratio(debt, income);

  // Trend goals: 'na' with no prior year (value null) or when the figure was
  // unchanged year-over-year (value 0, no movement to reward or penalise).
  const spendingValue = prev && prev.expenses > 0 ? (expenses - prev.expenses) / prev.expenses : null;
  const incomeValue = prev && prev.income > 0 ? (income - prev.income) / prev.income : null;
  const trendStatus = (value, improved) =>
    value == null ? 'na' : value === 0 ? 'na' : improved ? 'met' : 'miss';

  return [
    {
      key: 'expense_ratio',
      label: 'Expenses under 70% of income',
      value: er,
      status: judge(er, er <= EXPENSE_RATIO_GOAL),
    },
    {
      key: 'debt_to_income',
      label: 'Total debt under 25% of income',
      value: dti,
      status: judge(dti, dti <= DTI_GOAL),
    },
    {
      key: 'spending_trend',
      label: 'Spending down from last year',
      value: spendingValue,
      status: trendStatus(spendingValue, spendingValue < 0),
    },
    {
      key: 'income_trend',
      label: 'Income up from last year',
      value: incomeValue,
      status: trendStatus(incomeValue, incomeValue > 0),
    },
  ];
}

/**
 * Build the per-year report cards from raw yearly totals. `rows` is an array of
 * { year, income, expenses, transfers, invested, topExpense, debt } (debt null
 * when the year has no Balance-Sheet debt data, topExpense null when the year
 * has no spending). Returns the cards in ascending year order; the handler
 * re-sorts for display.
 */
function buildReportCards(rows) {
  const sorted = rows
    .map((r) => ({
      year: r.year,
      income: round2(r.income || 0),
      expenses: round2(r.expenses || 0),
      transfers: round2(r.transfers || 0),
      invested: round2(r.invested || 0),
      topExpense: r.topExpense
        ? { key: r.topExpense.key, name: r.topExpense.name, amount: round2(r.topExpense.amount) }
        : null,
      debt: r.debt == null ? null : round2(r.debt),
    }))
    .sort((a, b) => a.year - b.year);

  const byYear = new Map(sorted.map((r) => [r.year, r]));

  return sorted.map((r) => {
    const prev = byYear.get(r.year - 1) || null;
    // Net is a DERIVED figure, not a fourth total: it is income minus expenses
    // and nothing else, so transfers can never make it look like a worse year
    // than it was. Its YoY pill compares against the previous year's net by the
    // same rule (a prior net of zero or below has no finite percentage).
    const net = round2(r.income - r.expenses);
    const prevNet = prev ? round2(prev.income - prev.expenses) : null;
    return {
      year: r.year,
      income: r.income,
      expenses: r.expenses,
      transfers: r.transfers,
      invested: r.invested,
      net,
      topExpense: r.topExpense,
      debt: r.debt,
      changes: {
        income: change(r.income, prev?.income ?? null),
        expenses: change(r.expenses, prev?.expenses ?? null),
        transfers: change(r.transfers, prev?.transfers ?? null),
        net: change(net, prevNet),
      },
      metrics: {
        expenseToIncome: ratio(r.expenses, r.income),
        debtToIncome: r.debt == null ? null : ratio(r.debt, r.income),
        // What share of income is left after expenses — the year's overall
        // cash-flow margin. (Transfers to savings/brokerage are money moved,
        // not spent, so they don't reduce the margin.)
        cashFlowMargin: r.income > 0 ? (r.income - r.expenses) / r.income : null,
        // Share of income moved into the user's own savings/brokerage
        // accounts (every transfer category), and the slice of that which went
        // to the investing category specifically.
        savingsRate: ratio(r.transfers, r.income),
        investedRate: ratio(r.invested, r.income),
        // Concentration: how much of the year's spending went to its single
        // biggest category. Measured against EXPENSES, not income — it answers
        // "where did the spending go", so a year that earned nothing still has
        // a meaningful answer.
        topExpenseShare: r.topExpense ? ratio(r.topExpense.amount, r.expenses) : null,
      },
      goals: evaluateGoals({ ...r, prev }),
    };
  });
}

module.exports = {
  buildReportCards,
  evaluateGoals,
  EXPENSE_RATIO_GOAL,
  DTI_GOAL,
};
