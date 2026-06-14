'use strict';

// Yearly Report Card (Reports) — pure grading/metrics logic, no DB handle.
// Given each year's income / expense / savings(+investing) / debt totals it
// derives the headline figures, year-over-year changes, the three ratios, and
// an A–F letter grade measuring how close the year came to five money goals.
//
// NEW behaviour (not a Python port) → no oracle fixture; pinned by the
// deterministic unit tests in __tests__/reportCard.test.js.

const { round2 } = require('../validate');

// Goal targets — the figures the grade measures distance to. The first three
// are absolute ratios; the last two are year-over-year movements.
const EXPENSE_RATIO_GOAL = 0.70; // keep expenses ≤ 70% of income
const SAVINGS_RATE_GOAL = 0.15;  // keep saving + investing ≥ 15% of income
const DTI_GOAL = 0.25;           // keep total debt ≤ 25% of income
// A ±YOY_BAND swing in income/spending spans half a grade-point either side of
// flat (flat = 0.5), so a 5% raise / 5% spending cut scores a full 1.0.
const YOY_BAND = 0.05;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Letter bands on a 0..1 score (standard GPA cutoffs). Checked high → low.
const GRADE_BANDS = [
  [0.93, 'A'], [0.90, 'A-'], [0.87, 'B+'], [0.83, 'B'], [0.80, 'B-'],
  [0.77, 'C+'], [0.73, 'C'], [0.70, 'C-'], [0.67, 'D+'], [0.63, 'D'],
  [0.60, 'D-'],
];

function letterFor(score) {
  for (const [cut, letter] of GRADE_BANDS) if (score >= cut) return letter;
  return 'F';
}

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
 * Score the five goals for one year and roll them into a letter grade. `prev`
 * is the previous year's normalized row (or null for the earliest year). Each
 * goal yields { key, label, value, met, score } where score is 0..1; goals that
 * can't be evaluated (undefined ratio, or no prior year) are omitted, and the
 * overall score is the mean of the goals that DID apply — so a first year isn't
 * punished for having no history to compare against.
 */
function gradeYear({ income, expenses, savings, debt, prev }) {
  const goals = [];

  const er = ratio(expenses, income);
  if (er != null) {
    goals.push({
      key: 'expense_ratio',
      label: 'Expenses under 70% of income',
      value: er,
      met: er <= EXPENSE_RATIO_GOAL,
      // Full credit at ≤70%, zero at ≥100% (spending the whole paycheck).
      score: clamp01((1 - er) / (1 - EXPENSE_RATIO_GOAL)),
    });
  }

  const sr = ratio(savings, income);
  if (sr != null) {
    goals.push({
      key: 'savings_rate',
      label: 'Saving & investing over 15% of income',
      value: sr,
      met: sr >= SAVINGS_RATE_GOAL,
      // Full credit at ≥15%, scaling linearly down to zero.
      score: clamp01(sr / SAVINGS_RATE_GOAL),
    });
  }

  const dti = debt == null ? null : ratio(debt, income);
  if (dti != null) {
    goals.push({
      key: 'debt_to_income',
      label: 'Total debt under 25% of income',
      value: dti,
      met: dti <= DTI_GOAL,
      // Full credit at ≤25%, zero once debt reaches a full year of income.
      score: clamp01((1 - dti) / (1 - DTI_GOAL)),
    });
  }

  if (prev && prev.expenses > 0) {
    const ch = (expenses - prev.expenses) / prev.expenses;
    goals.push({
      key: 'spending_trend',
      label: 'Spending down from last year',
      value: ch,
      met: expenses <= prev.expenses,
      // flat → 0.5; a YOY_BAND cut → 1.0; a YOY_BAND rise → 0.0.
      score: clamp01(0.5 - ch / (2 * YOY_BAND)),
    });
  }

  if (prev && prev.income > 0) {
    const ch = (income - prev.income) / prev.income;
    goals.push({
      key: 'income_trend',
      label: 'Income up from last year',
      value: ch,
      met: income >= prev.income,
      // flat → 0.5; a YOY_BAND raise → 1.0; a YOY_BAND drop → 0.0.
      score: clamp01(0.5 + ch / (2 * YOY_BAND)),
    });
  }

  const score = goals.length ? goals.reduce((a, g) => a + g.score, 0) / goals.length : 0;
  return { letter: goals.length ? letterFor(score) : null, score: round2(score), goals };
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
      grade: gradeYear({ ...r, prev }),
    };
  });
}

module.exports = {
  buildReportCards,
  gradeYear,
  letterFor,
  EXPENSE_RATIO_GOAL,
  SAVINGS_RATE_GOAL,
  DTI_GOAL,
};
