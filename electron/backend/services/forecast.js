'use strict';

// Cash Flow Forecast (Reports) — pure projection logic, no DB handle. Given a
// starting balance plus the user's transaction history and any planned items,
// it projects a running balance forward over a horizon at WEEKLY resolution, so
// intra-month cash crunches (a big bill landing before payday) are visible
// instead of being averaged away into a single month-end point.
//
// This is NEW behaviour (not a Python port), so there is no oracle fixture; it
// is pinned by ordinary deterministic unit tests in __tests__/forecast.test.js.
//
// HYBRID model — each week's net is the sum of:
//
//   1. A SMOOTH baseline of the user's *irregular* spending and income: the
//      trailing-average monthly total of everything that ISN'T a detected
//      recurring pattern, converted to a per-day rate and spread evenly across
//      the weeks. This keeps the long-run slope honest (it captures one-off and
//      lumpy spending the way the old monthly model did).
//   2. DATED recurring flows — subscriptions, rent, paychecks the detector
//      recognises — projected forward and dropped into the specific week they
//      fall in. These are subtracted from the smooth baseline above so they are
//      not counted twice; moving them from "smooth" to "dated" is what gives the
//      line its within-month shape.
//   3. User-entered PLANNED items, dropped into the week they fall in.
//
// (An earlier version projected ONLY auto-detected recurring charges. That
// captured ~all income but only the few expenses that repeat on a fixed
// merchant+cadence, so it systematically overstated the balance. A later version
// used a single flat monthly average, which was honest about totals but showed
// no intra-month detail. The hybrid keeps the honest total of the average while
// restoring the timing detail of the recurring projection.)

const {
  localTodayIso, normaliseDesc, classifyCycle, median,
  addMonths, addDays, daysBetween, CYCLE_MONTHS,
} = require('./predictions');
const { round2 } = require('../validate');

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Same thresholds the Upcoming-Expenses detector uses (services/predictions.js).
const MIN_OCCURRENCES = 3;
const MIN_REGULARITY = 0.7;

// Average calendar days per month, used to turn a monthly average into the
// per-day rate the smooth baseline is spread by (365.25 / 12).
const DAYS_PER_MONTH = 365.25 / 12;

// ── Month-key helpers (keys are 'YYYY-MM', dates are 'YYYY-MM-DD'; both sort
//    lexicographically in chronological order). addMonthKey is also imported
//    by handlers/trends.js — change with care. ────────────────────────────────

const monthKey = (iso) => iso.slice(0, 7);

/** 'YYYY-MM' + n months, wrapping the year. */
function addMonthKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ── Historical baseline ──────────────────────────────────────────────────────

/** Sum actual transactions into per-month totals keyed 'YYYY-MM'. `income` and
 *  `expense` are the already-direction-split rows. */
function monthlyTotals(income, expense) {
  const totals = {};
  const add = (rows, key) => {
    for (const t of rows) {
      if (!t.date) continue;
      const m = monthKey(t.date);
      (totals[m] ??= { income: 0, expense: 0 })[key] += t.amount;
    }
  };
  add(income, 'income');
  add(expense, 'expense');
  return totals;
}

/**
 * Average monthly income and expense over the trailing `window` of COMPLETE
 * calendar months (the current month is excluded). The window starts no earlier
 * than the user's first month of data, so a new user isn't divided by empty
 * months; interior months with no transactions count as real zeros. Returns
 * { avgIncome, avgExpense, monthsUsed } (monthsUsed 0 ⇒ no usable history).
 *
 * Used for the forecast summary.
 */
function trailingAverage(totals, { today, window }) {
  const current = monthKey(today);
  const lastComplete = addMonthKey(current, -1);
  const desiredStart = addMonthKey(current, -window);

  const dataMonths = Object.keys(totals).filter((m) => m <= lastComplete);
  if (!dataMonths.length) return { avgIncome: 0, avgExpense: 0, monthsUsed: 0 };

  const firstData = dataMonths.reduce((a, b) => (a < b ? a : b));
  const start = desiredStart > firstData ? desiredStart : firstData;
  if (start > lastComplete) return { avgIncome: 0, avgExpense: 0, monthsUsed: 0 };

  let sumI = 0;
  let sumE = 0;
  let n = 0;
  for (let m = start; m <= lastComplete; m = addMonthKey(m, 1)) {
    const t = totals[m];
    if (t) { sumI += t.income; sumE += t.expense; }
    n += 1;
  }
  return { avgIncome: sumI / n, avgExpense: sumE / n, monthsUsed: n };
}

/**
 * Like trailingAverage, but over the SAME month span averages two parallel sets
 * of totals: the full history (`totalsAll`, → the summary's "typical month") and
 * the irregular-only history (`totalsIrreg`, recurring patterns removed → the
 * smooth-baseline slope). Pinning both to the span of `totalsAll` keeps the
 * smooth + dated decomposition adding back up to the full average.
 */
function windowAverages(totalsAll, totalsIrreg, { today, window }) {
  const empty = {
    avgIncome: 0, avgExpense: 0, avgIrregIncome: 0, avgIrregExpense: 0, monthsUsed: 0,
  };
  const current = monthKey(today);
  const lastComplete = addMonthKey(current, -1);
  const desiredStart = addMonthKey(current, -window);

  const dataMonths = Object.keys(totalsAll).filter((m) => m <= lastComplete);
  if (!dataMonths.length) return empty;

  const firstData = dataMonths.reduce((a, b) => (a < b ? a : b));
  const start = desiredStart > firstData ? desiredStart : firstData;
  if (start > lastComplete) return empty;

  let sI = 0;
  let sE = 0;
  let gI = 0;
  let gE = 0;
  let n = 0;
  for (let m = start; m <= lastComplete; m = addMonthKey(m, 1)) {
    const a = totalsAll[m];
    if (a) { sI += a.income; sE += a.expense; }
    const g = totalsIrreg[m];
    if (g) { gI += g.income; gE += g.expense; }
    n += 1;
  }
  return {
    avgIncome: sI / n, avgExpense: sE / n,
    avgIrregIncome: gI / n, avgIrregExpense: gE / n,
    monthsUsed: n,
  };
}

// ── Recurring-pattern detection (for the dated layer) ────────────────────────
// A trimmed-down sibling of detectRecurringExpenses: same grouping/cycle/
// regularity rules, but it keeps what the forecast needs — the normalised key
// (to tag which history rows to pull out of the smooth baseline) and the cycle +
// predicted amount + last charge (to project occurrences forward). Works for
// either direction's rows; recurring income (paychecks) drives the "recover
// after payday" half of the shape.

/** One cycle step forward from an ISO date. Calendar cycles step by month so a
 *  bill anchored to the 31st clamps month-end correctly; the rest step by days. */
function stepDate(iso, name, days) {
  return name in CYCLE_MONTHS ? addMonths(iso, CYCLE_MONTHS[name]) : addDays(iso, days);
}

/**
 * Identify *active* recurring patterns in one direction's rows. Returns
 * [{ key, name, days, amount, last }] — `key` is the normalised merchant string,
 * `amount` the predicted per-charge amount, `last` the most recent charge date.
 * A pattern is dropped if its next projected charge is already overdue beyond
 * the cycle tolerance (probably cancelled), so it neither displaces the smooth
 * baseline nor gets projected forward.
 */
function recurringPatterns(rows, todayIso) {
  const groups = new Map();
  for (const t of rows) {
    if (!t.date) continue;
    const key = normaliseDesc(t.description);
    if (!key) continue;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(t);
  }

  const patterns = [];
  for (const [key, grp] of groups) {
    const byDate = new Map();
    for (const t of grp) byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount);
    if (byDate.size < MIN_OCCURRENCES) continue;

    const dates = [...byDate.keys()].sort();
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const cycle = classifyCycle(gaps);
    if (!cycle) continue;
    const [name, days, tol] = cycle;

    const regular = gaps.filter((g) => Math.abs(g - days) <= tol).length / gaps.length;
    if (regular < MIN_REGULARITY) continue;

    const last = dates[dates.length - 1];
    // Overdue beyond tolerance ⇒ probably cancelled — don't carry it forward.
    if (daysBetween(stepDate(last, name, days), todayIso) > tol) continue;

    const amount = round2(median(dates.slice(-3).map((d) => byDate.get(d))));
    patterns.push({ key, name, days, amount, last });
  }
  return patterns;
}

/** Project each pattern's charges into the forecast window, returning the dated
 *  occurrences [{ date, amount }] that fall in [todayIso, endIso). */
function placeRecurring(patterns, todayIso, endIso) {
  const occ = [];
  for (const p of patterns) {
    let due = stepDate(p.last, p.name, p.days);
    let guard = 0;
    while (due < todayIso && guard++ < 1000) due = stepDate(due, p.name, p.days);
    guard = 0;
    while (due < endIso && guard++ < 1000) {
      occ.push({ date: due, amount: p.amount });
      due = stepDate(due, p.name, p.days);
    }
  }
  return occ;
}

// ── Weekly horizon helpers ───────────────────────────────────────────────────

/** End of the horizon: `months` calendar months past today (exclusive bound). */
function horizonEnd(todayIso, months) {
  return addMonths(todayIso, months);
}

/** Number of 7-day buckets needed to cover [todayIso, endIso). */
function weekCount(todayIso, endIso) {
  return Math.max(1, Math.ceil(daysBetween(todayIso, endIso) / 7));
}

/** Which 7-day bucket (from today) an ISO date lands in; <0 means before today. */
function weekIndexOf(todayIso, dateIso) {
  return Math.floor(daysBetween(todayIso, dateIso) / 7);
}

/** Short label for a week, keyed on its start date, e.g. 'Jun 14'. */
function weekLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * Top-level: project a weekly forecast from raw inputs. `income`/`expense` are
 * the already-direction-split transaction rows; `planned` is the planned-items
 * list ([{ amount, flow, date }]). `months` is the horizon (1/3/6) and also the
 * trailing-average window. `today` defaults to the local date. Returns:
 *   { series: [{ weekStart, label, income, expense, net, balance }],
 *     summary: { endBalance, lowest: { weekStart, label, balance }, belowZero,
 *                avgIncome, avgExpense, monthsUsed } }
 * All monetary values are round2'd at the week boundary.
 */
function forecast({ startBalance, income, expense, planned, months, today = null }) {
  const todayIso = today || localTodayIso();
  const endIso = horizonEnd(todayIso, months);
  const nWeeks = weekCount(todayIso, endIso);

  // Recurring decomposition: tag the recurring rows so they leave the smooth
  // baseline, and average the irregular remainder over the same span as the
  // full history (which feeds the summary's "typical month").
  const incPatterns = recurringPatterns(income, todayIso);
  const expPatterns = recurringPatterns(expense, todayIso);
  const incKeys = new Set(incPatterns.map((p) => p.key));
  const expKeys = new Set(expPatterns.map((p) => p.key));

  const totalsAll = monthlyTotals(income, expense);
  const totalsIrreg = monthlyTotals(
    income.filter((t) => !incKeys.has(normaliseDesc(t.description))),
    expense.filter((t) => !expKeys.has(normaliseDesc(t.description)))
  );
  const avg = windowAverages(totalsAll, totalsIrreg, { today: todayIso, window: months });

  const perDayInc = avg.avgIrregIncome / DAYS_PER_MONTH;
  const perDayExp = avg.avgIrregExpense / DAYS_PER_MONTH;

  // Drop the dated flows (recurring + planned) into their weekly buckets.
  const incBuckets = new Array(nWeeks).fill(0);
  const expBuckets = new Array(nWeeks).fill(0);
  const drop = (occ, buckets) => {
    for (const o of occ) {
      const i = weekIndexOf(todayIso, o.date);
      if (i >= 0 && i < nWeeks) buckets[i] += o.amount;
    }
  };
  drop(placeRecurring(incPatterns, todayIso, endIso), incBuckets);
  drop(placeRecurring(expPatterns, todayIso, endIso), expBuckets);
  for (const p of planned) {
    const i = weekIndexOf(todayIso, p.date);
    if (i >= 0 && i < nWeeks) (p.flow === 'income' ? incBuckets : expBuckets)[i] += p.amount;
  }

  // Walk the weeks, accumulating the running balance.
  let balance = round2(startBalance);
  let lowest = null;
  let belowZero = false;
  const series = [];
  for (let i = 0; i < nWeeks; i++) {
    const weekStart = addDays(todayIso, i * 7);
    const daysInWeek = Math.min(7, daysBetween(weekStart, endIso));
    const inc = round2(perDayInc * daysInWeek + incBuckets[i]);
    const exp = round2(perDayExp * daysInWeek + expBuckets[i]);
    const net = round2(inc - exp);
    balance = round2(balance + net);
    if (balance < 0) belowZero = true;
    if (!lowest || balance < lowest.balance) {
      lowest = { weekStart, label: weekLabel(weekStart), balance };
    }
    series.push({ weekStart, label: weekLabel(weekStart), income: inc, expense: exp, net, balance });
  }

  return {
    series,
    summary: {
      endBalance: series.length ? series[series.length - 1].balance : round2(startBalance),
      lowest,
      belowZero,
      avgIncome: round2(avg.avgIncome),
      avgExpense: round2(avg.avgExpense),
      monthsUsed: avg.monthsUsed,
    },
  };
}

module.exports = {
  forecast,
  monthlyTotals,
  trailingAverage,
  windowAverages,
  recurringPatterns,
  placeRecurring,
  addMonthKey,
  horizonEnd,
  weekCount,
  weekIndexOf,
  weekLabel,
};
