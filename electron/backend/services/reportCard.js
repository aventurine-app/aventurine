'use strict';

// Metrics (Reports) — pure metrics/goals logic, no DB handle.
// Given each year's income / expense / transfer / debt totals it derives the
// headline figures, year-over-year changes, the ratios, the met/missed outcome
// of four money goals.
//
// Transfers (money moved to savings/brokerage accounts) stay out of every
// income/spend surface — they are not spending and not earning, so no goal is
// graded on them and they do not reduce the cash-flow margin. They are still
// REPORTED, as two figures and two ratios: `saved` (every transfer category
// except Investing) and `invested` (the Investing category alone) are the
// headline figures, and the savings rate / invested share grade the whole
// transfer total and the investing slice of it against income. The share of
// income put away can be derived only from the transfer total, which the
// income/spend figures exclude. `transfers` stays on the row as the sum of the
// two, since the ratios and the Financial Freedom figure read it.
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
// pass/fail line would give 71% and 140% the same result.
const NEAR_BAND = 0.05;   // ratio goals: 5 points past the bound
const NEAR_TREND = 0.02;  // trend goals: a move under 2% the wrong way

// ─── Financial Freedom ───────────────────────────────────────────────────────
// The Financial Independence (FI) number: the sum a household is commonly said
// to need before its yearly costs can be met from what it holds, taken as a
// fixed multiple of those costs (the 4% rule's reciprocal). One constant, held
// here so the tooltip, the tests and the figure agree on it.
const FI_MULTIPLE = 25;

/**
 * The Dashboard's Financial Freedom card (GET /api/financial-freedom): ONE
 * measurement of the whole ledger, not a per-year figure — it is what the
 * Metrics tab's year picker would have made it, and a target that moved with a
 * picker is not a target.
 *
 * `years` is every tracked year's { year, expenses }. The average is taken over
 * the years with any expenses, so a year with no spending recorded is skipped
 * rather than averaged in as a year of living for free. The CURRENT calendar
 * year is left out while an earlier qualifying year exists: it is partial, and
 * eight months of expenses averaged in as a full year lowers the number by a
 * fifth for no reason the reader can see. When it is the only year with
 * expenses it is used as it stands, since a number built on something beats an
 * N/A built on nothing. `currentYear` is passed in so tests are deterministic.
 *
 * Progress is net worth over the number. Net worth can be negative (more owed
 * than owned), and that is returned as a negative share rather than clamped:
 * the renderer decides how to draw it, and a reader who owes more than they
 * own is owed the real figure.
 */
function financialFreedom({ years, netWorth, netWorthAsOf, currentYear }) {
  const cy = currentYear || new Date().getFullYear();
  let pool = (years || []).filter((y) => y.expenses > 0);
  const complete = pool.filter((y) => y.year !== cy);
  if (complete.length) pool = complete;
  pool = [...pool].sort((a, b) => a.year - b.year);

  let avgExpenses = null;
  let number = null;
  if (pool.length) {
    avgExpenses = round2(pool.reduce((sum, y) => sum + y.expenses, 0) / pool.length);
    number = round2(avgExpenses * FI_MULTIPLE);
  }
  const nw = netWorth == null ? null : round2(netWorth);
  return {
    avgExpenses,
    yearsAveraged: pool.map((y) => y.year),
    number,
    netWorth: nw,
    netWorthAsOf: nw == null ? null : netWorthAsOf || null,
    progress: number > 0 && nw != null ? nw / number : null,
  };
}

// ─── Metric bands ────────────────────────────────────────────────────────────
// Where each ratio's meter is coloured, and what tone it earns there. Shipped
// to the renderer with the report (`bands` on the response) rather than copied
// into the frontend, for the same reason the goal targets are: two copies of a
// tuned number diverge the first time one of them is retuned.
//
// Every band is [from, to] as a share of the 0–100% track, `to`-INCLUSIVE, so a
// value lands in the FIRST band whose `to` it does not exceed. That is what
// makes "expenses under 70%" put exactly 70% in the good band. Values outside
// 0–100% clamp into the end band, which is why a negative cash-flow margin
// reads 'bad' and a 300% debt ratio does too, with no extra rule.
//
// The shape differs by what the ratio measures, and deliberately:
//
//  - LOWER IS BETTER (expenses, debt, expense concentration): good → caution →
//    bad, left to right. There is no bad band at the left end, because spending
//    or owing nothing is not a problem to flag.
//  - PUTTING MONEY AWAY (saving, investing): bad → good → caution. The caution
//    at the TOP is the point — past the target, money is sitting in an account
//    instead of being lived on, which is worth a look rather than a gold star.
//
// `cashFlowMargin` and `topExpenseShare` are still computed and still on the
// response — they are figures, and other readers may want them — but they have
// no bands, because Vitals no longer draws a gauge for either and a band exists
// only to colour a gauge.
const METRIC_BANDS = {
  expenseToIncome: [
    { from: 0, to: EXPENSE_RATIO_GOAL, tone: 'good' },
    { from: EXPENSE_RATIO_GOAL, to: 0.85, tone: 'caution' },
    { from: 0.85, to: 1, tone: 'bad' },
  ],
  debtToIncome: [
    { from: 0, to: DTI_GOAL, tone: 'good' },
    { from: DTI_GOAL, to: 0.40, tone: 'caution' },
    { from: 0.40, to: 1, tone: 'bad' },
  ],
  // Both put-away gauges run their green PAST the goal they are graded against
  // (SAVINGS_GOAL 20%, INVESTED_GOAL 15–20%): the goal is the bar a year is
  // marked against, while the gauge's green is the range that is simply
  // healthy, and putting a third of an income away is not a thing to caution
  // anybody about. The two are deliberately decoupled — they were the same
  // numbers only while the tile carried the goal's badge.
  savingsRate: [
    { from: 0, to: 0.10, tone: 'bad' },
    { from: 0.10, to: 0.30, tone: 'good' },
    { from: 0.30, to: 1, tone: 'caution' },
  ],
  investedRate: [
    { from: 0, to: INVESTED_GOAL[0], tone: 'bad' },
    { from: INVESTED_GOAL[0], to: 0.40, tone: 'good' },
    { from: 0.40, to: 1, tone: 'caution' },
  ],
};

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

/** A goal with a FLOOR: at or over `floor` is met — exceeding a goal counts as
 *  meeting it, so the top of a target range never grades as a miss — within
 *  NEAR_BAND under it is near, below that is missed. */
function gradeOver(value, floor) {
  if (value == null) return 'na';
  if (value >= floor) return 'met';
  return value >= floor - NEAR_BAND ? 'near' : 'miss';
}

/** Year-over-year change vs a prior figure. abs is rounded to cents; pct is
 *  null when there is no prior year, or the prior figure was zero (no finite
 *  percentage from a zero base — the UI renders that as "new"). */
function change(curr, prev) {
  if (prev == null) return null;
  return { abs: round2(curr - prev), pct: prev > 0 ? (curr - prev) / prev : null };
}

/**
 * Evaluate the six money goals for one year. `prev` is the previous year's
 * normalized row (or null for the earliest year). Every card shows all six
 * goals at all times; each yields { key, label, value, target, range, status }
 * where status is 'met' (✓), 'near' (!), 'miss' (✕), or 'na' (—) — a goal is
 * 'na' when it cannot be graded (undefined ratio, no prior year to compare
 * against) or when a trend goal has no year-over-year change. `value` is null
 * only when there is nothing to display.
 *
 * `target` is the single threshold the goal is graded against, and `range` the
 * band, where the goal is a band rather than a line. Both are sent so the
 * renderer can DRAW them (the Metrics tiles notch the meter at the target and
 * shade the band) rather than holding a second copy of these constants in the
 * frontend, which would diverge the first time one is retuned. The two trend
 * goals have neither — "down from last year" is a direction, not a level — so
 * theirs are null and their tiles get no notch.
 *
 * The saving and investing goals are FLOORS, so exceeding either grades 'met'.
 * Investing is the one drawn as a BAND: below 15% of income is short of it and
 * 20% is fully met, and anything above 20% also grades 'met'. The two are
 * independent — saving counts every transfer category and investing counts the
 * investing slice of it, so one goal can be met while the other is not.
 */
function evaluateGoals({ income, expenses, debt, transfers, invested, prev }) {
  const er = ratio(expenses, income);
  const dti = debt == null ? null : ratio(debt, income);
  const sr = ratio(transfers || 0, income);
  const ir = ratio(invested || 0, income);

  // Trend goals: 'na' with no prior year (value null) or when the figure is
  // unchanged year-over-year (value 0, no movement to grade). A move in the
  // wrong direction grades 'near' while it is under NEAR_TREND, so a year that
  // spent 1% more is separated from one that spent 30% more.
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
 * has no spending).
 * Returns the cards in ascending year order; the handler re-sorts for display.
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
    // Net is a DERIVED figure, not a fourth total: income minus expenses and
    // nothing else, so transfers cannot lower it. Its YoY pill compares against
    // the previous year's net by the same rule (a prior net of zero or below
    // has no finite percentage).
    const net = round2(r.income - r.expenses);
    const prevNet = prev ? round2(prev.income - prev.expenses) : null;
    // Saved is the transfer total with the investing slice taken out, so the
    // Savings and Invested figures partition the money put away rather than
    // counting the Investing category twice.
    const saved = round2(r.transfers - r.invested);
    const prevSaved = prev ? round2(prev.transfers - prev.invested) : null;
    return {
      year: r.year,
      income: r.income,
      expenses: r.expenses,
      transfers: r.transfers,
      saved,
      invested: r.invested,
      net,
      topExpense: r.topExpense,
      debt: r.debt,
      changes: {
        income: change(r.income, prev?.income ?? null),
        expenses: change(r.expenses, prev?.expenses ?? null),
        transfers: change(r.transfers, prev?.transfers ?? null),
        saved: change(saved, prevSaved),
        invested: change(r.invested, prev?.invested ?? null),
        net: change(net, prevNet),
      },
      metrics: {
        expenseToIncome: ratio(r.expenses, r.income),
        debtToIncome: r.debt == null ? null : ratio(r.debt, r.income),
        // Share of income left after expenses — the year's overall cash-flow
        // margin. Transfers to savings/brokerage are money moved, not spent, so
        // they are not subtracted here.
        cashFlowMargin: r.income > 0 ? (r.income - r.expenses) / r.income : null,
        // Share of income moved into the user's savings/brokerage accounts
        // (every transfer category), and the part of that which went to the
        // investing category specifically.
        savingsRate: ratio(r.transfers, r.income),
        investedRate: ratio(r.invested, r.income),
        // Concentration: how much of the year's spending went to its single
        // biggest category. Measured against EXPENSES, not income, so a year
        // with no income still produces a defined value.
        topExpenseShare: r.topExpense ? ratio(r.topExpense.amount, r.expenses) : null,
      },
      goals: evaluateGoals({ ...r, prev }),
    };
  });
}

module.exports = {
  buildReportCards,
  evaluateGoals,
  METRIC_BANDS,
  FI_MULTIPLE,
  financialFreedom,
  EXPENSE_RATIO_GOAL,
  DTI_GOAL,
  SAVINGS_GOAL,
  INVESTED_GOAL,
  NEAR_BAND,
  NEAR_TREND,
};
