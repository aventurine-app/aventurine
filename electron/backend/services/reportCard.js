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
 * normalized row (or null for the earliest year). Each goal yields
 * { key, label, value, met }; goals that can't be evaluated (undefined ratio, or
 * no prior year) are omitted — so a first year isn't shown trend goals it has no
 * history to compare against.
 */
function evaluateGoals({ income, expenses, savings, debt, prev }) {
  const goals = [];

  const er = ratio(expenses, income);
  if (er != null) {
    goals.push({
      key: 'expense_ratio',
      label: 'Expenses under 70% of income',
      value: er,
      met: er <= EXPENSE_RATIO_GOAL,
    });
  }

  const sr = ratio(savings, income);
  if (sr != null) {
    goals.push({
      key: 'savings_rate',
      label: 'Saving & investing over 15% of income',
      value: sr,
      met: sr >= SAVINGS_RATE_GOAL,
    });
  }

  const dti = debt == null ? null : ratio(debt, income);
  if (dti != null) {
    goals.push({
      key: 'debt_to_income',
      label: 'Total debt under 25% of income',
      value: dti,
      met: dti <= DTI_GOAL,
    });
  }

  if (prev && prev.expenses > 0) {
    goals.push({
      key: 'spending_trend',
      label: 'Spending down from last year',
      value: (expenses - prev.expenses) / prev.expenses,
      met: expenses <= prev.expenses,
    });
  }

  if (prev && prev.income > 0) {
    goals.push({
      key: 'income_trend',
      label: 'Income up from last year',
      value: (income - prev.income) / prev.income,
      met: income >= prev.income,
    });
  }

  return goals;
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
