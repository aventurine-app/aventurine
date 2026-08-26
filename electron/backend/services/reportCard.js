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

// Goal targets. The first three are absolute ratios; the last two are
// year-over-year movements.
const EXPENSE_RATIO_GOAL = 0.70;      // keep expenses ≤ 70% of income
const DTI_GOAL = 0.25;                // keep total debt ≤ 25% of income
const SAVINGS_GOAL = 0.20;            // put ≥ 20% of income away, anywhere
const INVESTED_GOAL = [0.15, 0.20];   // of which 15–20% goes to investing

// How far past a goal still counts as CLOSE rather than missed. Every goal is
// graded on three levels, not two: hit (or beaten), slightly off, off. A single
// pass/fail line makes 71% and 140% the same answer, which is the one thing a
// year-long figure should never say.
const NEAR_BAND = 0.05;   // ratio goals: 5 points past the bound
const NEAR_TREND = 0.02;  // trend goals: a move under 2% the wrong way

/** a / b, or null when the denominator is non-positive (ratio undefined). */
function ratio(a, b) {
  return b > 0 ? a / b : null;
}

/** A goal with a CEILING: at or under `bound` is met, within NEAR_BAND over it
 *  is near, past that is missed. */
function gradeUnder(value, bound) {
  if (value == null) return 'na';
  if (value <= bound) return 'met';
  return value <= bound + NEAR_BAND ? 'near' : 'miss';
}

/** A goal with a FLOOR: at or over `floor` is met — beating a goal is still
 *  hitting it, so the top of a target range is never a fail — within NEAR_BAND
 *  under it is near, below that is missed. */
function gradeOver(value, floor) {
  if (value == null) return 'na';
  if (value >= floor) return 'met';
  return value >= floor - NEAR_BAND ? 'near' : 'miss';
}

/** Year-over-year change vs a prior figure. abs is rounded to cents; pct is
 *  null when there is no prior year, or the prior figure was zero (growth from
 *  nothing has no finite percentage — the UI renders that as "new"). */
function change(curr, prev) {
  if (prev == null) return null;
  return { abs: round2(curr - prev), pct: prev > 0 ? (curr - prev) / prev : null };
}

/**
 * Evaluate the six money goals for one year. `prev` is the previous year's
 * normalized row (or null for the earliest year). Every card shows all six
 * goals at all times; each yields { key, label, value, target, range, status }
 * where status is 'met' (✓), 'near' (!), 'miss' (✕), or 'na' (—) — a goal is
 * 'na' when it can't be judged (undefined ratio, no prior year to compare
 * against) or when a trend goal saw no year-over-year change. `value` is null
 * only when there's nothing to show.
 *
 * `target` is the single threshold the goal is judged against, and `range` the
 * band it is judged against where the goal is a band rather than a line. Both
 * ship so the renderer can DRAW them (the Metrics tiles notch the meter at the
 * target and shade the band) rather than keeping a second copy of these
 * constants in the frontend, where it would silently disagree the first time
 * one is retuned. The two trend goals have neither — "down from last year" is a
 * direction, not a level — so theirs are null and their tiles get no notch.
 *
 * The saving and investing goals are FLOORS, so beating either is still hitting
 * it. Investing is the one drawn as a BAND: below 15% of income is short of it
 * and 20% is where it is fully met, but anything above that is beating it, not
 * overshooting it, so the top of the range grades 'met' like the rest. The two
 * do not compete — saving counts every transfer category and investing counts
 * the investing slice of it, so one goal can be met while the other is not.
 */
function evaluateGoals({ income, expenses, debt, transfers, invested, prev }) {
  const er = ratio(expenses, income);
  const dti = debt == null ? null : ratio(debt, income);
  const sr = ratio(transfers || 0, income);
  const ir = ratio(invested || 0, income);

  // Trend goals: 'na' with no prior year (value null) or when the figure was
  // unchanged year-over-year (value 0, no movement to reward or penalise). A
  // move the wrong way is 'near' while it is under NEAR_TREND — a year that
  // spent 1% more is not the same answer as one that spent 30% more.
  const spendingValue = prev && prev.expenses > 0 ? (expenses - prev.expenses) / prev.expenses : null;
  const incomeValue = prev && prev.income > 0 ? (income - prev.income) / prev.income : null;
  const trendStatus = (value, improved) => {
    if (value == null || value === 0) return 'na';
    if (improved) return 'met';
    return Math.abs(value) <= NEAR_TREND ? 'near' : 'miss';
  };

  return [
    {
      key: 'expense_ratio',
      label: 'Expenses under 70% of income',
      value: er,
      target: EXPENSE_RATIO_GOAL,
      range: null,
      status: gradeUnder(er, EXPENSE_RATIO_GOAL),
    },
    {
      key: 'debt_to_income',
      label: 'Total debt under 25% of income',
      value: dti,
      target: DTI_GOAL,
      range: null,
      status: gradeUnder(dti, DTI_GOAL),
    },
    {
      key: 'savings_rate',
      label: 'Saving at least 20% of income',
      value: sr,
      target: SAVINGS_GOAL,
      range: null,
      status: gradeOver(sr, SAVINGS_GOAL),
    },
    {
      key: 'invested_rate',
      label: 'Investing 15% to 20% of income',
      value: ir,
      target: INVESTED_GOAL[0],
      range: INVESTED_GOAL,
      status: gradeOver(ir, INVESTED_GOAL[0]),
    },
    {
      key: 'spending_trend',
      label: 'Spending down from last year',
      value: spendingValue,
      target: null,
      range: null,
      status: trendStatus(spendingValue, spendingValue < 0),
    },
    {
      key: 'income_trend',
      label: 'Income up from last year',
      value: incomeValue,
      target: null,
      range: null,
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
  SAVINGS_GOAL,
  INVESTED_GOAL,
  NEAR_BAND,
  NEAR_TREND,
};
