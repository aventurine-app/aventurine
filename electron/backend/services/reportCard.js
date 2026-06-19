'use strict';

// Yearly Report Card (Reports) — pure metrics/goals logic, no DB handle.
// Given each year's income / expense / savings(+investing) / debt totals it
// derives the headline figures, year-over-year changes, the three ratios, and
// the met/missed outcome of five money goals.
//
// NEW behaviour (not a Python port) → no oracle fixture; pinned by the
// deterministic unit tests in __tests__/reportCard.test.js.

const { round2 } = require('../validate');

// Goal targets. The first three are absolute ratios; the last two are
// year-over-year movements.
const EXPENSE_RATIO_GOAL = 0.70; // keep expenses ≤ 70% of income
const SAVINGS_RATE_GOAL = 0.15;  // keep saving + investing ≥ 15% of income
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
 * Evaluate the five money goals for one year. `prev` is the previous year's
 * normalized row (or null for the earliest year). Every card shows all five
 * goals at all times; each yields { key, label, value, status } where status is
 * 'met' (✓), 'miss' (✕), or 'na' (—) — a goal is 'na' when it can't be judged
 * (undefined ratio, no prior year to compare against) or when a trend goal saw
 * no year-over-year change. `value` is null only when there's nothing to show.
 */
function evaluateGoals({ income, expenses, savings, debt, prev }) {
  // status for a goal whose `value` is undefined (null) → 'na'; otherwise the
  // result of the threshold test passed in.
  const judge = (value, met) => (value == null ? 'na' : met ? 'met' : 'miss');

  const er = ratio(expenses, income);
  const sr = ratio(savings, income);
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
      key: 'savings_rate',
      label: 'Saving & investing over 15% of income',
      value: sr,
      status: judge(sr, sr >= SAVINGS_RATE_GOAL),
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
 * { year, income, expenses, savings, debt } (debt null when the year has no
 * Balance-Sheet debt data). Returns the cards in ascending year order; the
 * handler re-sorts for display.
 */
function buildReportCards(rows) {
  const sorted = rows
    .map((r) => ({
      year: r.year,
      income: round2(r.income || 0),
      expenses: round2(r.expenses || 0),
      savings: round2(r.savings || 0),
      debt: r.debt == null ? null : round2(r.debt),
    }))
    .sort((a, b) => a.year - b.year);

  const byYear = new Map(sorted.map((r) => [r.year, r]));

  return sorted.map((r) => {
    const prev = byYear.get(r.year - 1) || null;
    return {
      year: r.year,
      income: r.income,
      expenses: r.expenses,
      savings: r.savings,
      debt: r.debt,
      changes: {
        income: change(r.income, prev?.income ?? null),
        expenses: change(r.expenses, prev?.expenses ?? null),
        savings: change(r.savings, prev?.savings ?? null),
      },
      metrics: {
        expenseToIncome: ratio(r.expenses, r.income),
        debtToIncome: r.debt == null ? null : ratio(r.debt, r.income),
        // What share of income is left after every tracked outflow (expenses,
        // saving and investing) — the year's overall cash-flow margin.
        cashFlowMargin: r.income > 0 ? (r.income - r.expenses - r.savings) / r.income : null,
      },
      goals: evaluateGoals({ ...r, prev }),
    };
  });
}

module.exports = {
  buildReportCards,
  evaluateGoals,
  EXPENSE_RATIO_GOAL,
  SAVINGS_RATE_GOAL,
  DTI_GOAL,
};
