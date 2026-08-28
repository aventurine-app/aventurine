'use strict';

// Balance Forecast (Reports) — pure projection logic, no DB handle. Given a
// starting balance plus the user's transaction history and any planned items,
// it projects a running balance forward over a horizon at WEEKLY resolution, so
// intra-month cash crunches (a big bill landing before payday) stay visible
// instead of being averaged into a single month-end point.
//
// This is NEW behaviour (not a Python port), so there is no oracle fixture; it
// is pinned by ordinary deterministic unit tests in __tests__/forecast.test.js.
//
// HYBRID model — each week's net is the sum of:
//
//   1. A SMOOTH baseline of the user's *irregular* spending and income: the
//      trailing-average monthly total of everything that is NOT a detected
//      recurring pattern, converted to a per-day rate and spread evenly across
//      the weeks. This keeps the long-run slope accurate, since it includes
//      one-off and lumpy spending the way the old monthly model did.
//   2. DATED recurring flows — subscriptions, rent, paychecks the detector
//      matches — projected forward and placed in the specific week they fall in.
//      These are subtracted from the smooth baseline above so they are not
//      counted twice; moving them from "smooth" to "dated" is what gives the
//      line its within-month shape.
//   3. User-entered PLANNED items, placed in the week they fall in.
//
// (An earlier version projected ONLY auto-detected recurring charges. That
// covered nearly all income but only the few expenses that repeat on a fixed
// merchant+cadence, so it overstated the balance. A later version used a single
// flat monthly average, which had the correct total but no intra-month detail.
// The hybrid keeps the average's total and restores the timing detail of the
// recurring projection.)
//
// The HORIZON (how far ahead to draw) and the trailing-average WINDOW (how much
// history to estimate from) are separate inputs — see HISTORY_MONTHS. So is
// which months count at all: a month the ledger has no rows for is un-imported,
// not a month of zero spending, and is left out of the average rather than
// lowering it (see windowAverages' `activeMonths`).

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

// How much history the smooth baseline is averaged over, in COMPLETE calendar
// months. Independent of the horizon: how far ahead the chart draws is separate
// from how much history the estimate uses. (It used to be the same number, so
// switching the range picker from 3 months to 6 re-estimated the slope with no
// indication — on a ledger whose spending had stepped down, the projected burn
// tripled purely from picking a longer view.)
const HISTORY_MONTHS = 6;

// Average calendar days per month, used to turn a monthly average into the
// per-day rate the smooth baseline is spread by (365.25 / 12).
const DAYS_PER_MONTH = 365.25 / 12;

// ── Month-key helpers (keys are 'YYYY-MM', dates are 'YYYY-MM-DD'; both sort
//    lexicographically in chronological order). addMonthKey is also imported
//    by handlers/trends.js. ─────────────────────────────────────────────────

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
 * calendar months (the current month is excluded). Thin wrapper over
 * windowAverages for the single-totals case; see windowAverages for the window
 * rules.
 * Returns { avgIncome, avgExpense, monthsUsed } (monthsUsed 0 ⇒ no usable
 * history).
 */
function trailingAverage(totals, { today, window, activeMonths = null }) {
  const a = windowAverages(totals, totals, { today, window, activeMonths });
  return { avgIncome: a.avgIncome, avgExpense: a.avgExpense, monthsUsed: a.monthsUsed };
}

/**
 * Average two parallel sets of monthly totals over the SAME month span: the
 * full history (`totalsAll`, → the summary's "typical month") and the
 * irregular-only history (`totalsIrreg`, recurring patterns removed → the
 * smooth-baseline slope). Pinning both to one span keeps the smooth + dated
 * decomposition adding back up to the full average.
 *
 * The span is the trailing `window` of COMPLETE calendar months (the current,
 * part-way month is excluded), starting no earlier than the user's first month
 * of data so a new user isn't divided by months that predate them.
 *
 * Months the ledger holds NO transaction for are skipped entirely rather than
 * averaged in as zeros — `activeMonths` (a Set of 'YYYY-MM' the caller has rows
 * for) is what separates "a month with no spending" from "a month never
 * imported". Counting the latter as a real zero lowered the baseline with no
 * indication: a ledger with a two-month gap in an otherwise steady $3,000/mo
 * reported a typical month of $2,000. Omitted ⇒ fall back to the months
 * `totalsAll` itself has, which is the same rule for every caller that already
 * passes complete data.
 */
function windowAverages(totalsAll, totalsIrreg, { today, window, activeMonths = null }) {
  const empty = {
    avgIncome: 0, avgExpense: 0, avgIrregIncome: 0, avgIrregExpense: 0, monthsUsed: 0,
  };
  const current = monthKey(today);
  const lastComplete = addMonthKey(current, -1);
  const desiredStart = addMonthKey(current, -window);

  const active = activeMonths || new Set(Object.keys(totalsAll));
  const dataMonths = [...active].filter((m) => m <= lastComplete);
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
    if (!active.has(m)) continue;
    const a = totalsAll[m];
    if (a) { sI += a.income; sE += a.expense; }
    const g = totalsIrreg[m];
    if (g) { gI += g.income; gE += g.expense; }
    n += 1;
  }
  if (!n) return empty;
  return {
    avgIncome: sI / n, avgExpense: sE / n,
    avgIrregIncome: gI / n, avgIrregExpense: gE / n,
    monthsUsed: n,
  };
}

// ── Recurring-pattern detection (for the dated layer) ────────────────────────
// A trimmed-down version of detectRecurringExpenses: same grouping/cycle/
// regularity rules, returning only what the forecast uses — the normalised key
// (to mark which history rows to remove from the smooth baseline) and the cycle
// + predicted amount + last charge (to project occurrences forward). Works for
// either direction's rows; recurring income (paychecks) produces the upward
// steps in the line.

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
 * the cycle tolerance (treated as cancelled), so it is neither removed from the
 * smooth baseline nor projected forward.
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
    // Overdue beyond tolerance ⇒ treated as cancelled; not carried forward.
    if (daysBetween(stepDate(last, name, days), todayIso) > tol) continue;

    const amount = round2(median(dates.slice(-3).map((d) => byDate.get(d))));
    patterns.push({ key, name, days, amount, last });
  }
  return patterns;
}

/**
 * Project each pattern's charges into the forecast window, returning the dated
 * occurrences [{ date, amount }] that fall in [todayIso, endIso).
 *
 * With `catchUpOverdue`, a charge whose due date has already passed is placed
 * on today rather than skipped. Only the forecast sets this, because
 * recurringPatterns retains a pattern only while it is overdue by no more than
 * its cycle's tolerance: a missed charge here is a bill with no matching
 * transaction in the ledger that is due shortly, and deferring it a whole cycle
 * removed the near-term cash crunch the report exists to show. The Recurring
 * calendar (handlers/recurring.js) leaves this off: it draws real charges on
 * the days they landed, and adding one on today would show a charge that never
 * occurred.
 */
function placeRecurring(patterns, todayIso, endIso, { catchUpOverdue = false } = {}) {
  const occ = [];
  for (const p of patterns) {
    let due = stepDate(p.last, p.name, p.days);
    let guard = 0;
    let overdue = false;
    while (due < todayIso && guard++ < 1000) { overdue = true; due = stepDate(due, p.name, p.days); }
    if (overdue && catchUpOverdue && todayIso < endIso) {
      occ.push({ date: todayIso, amount: p.amount });
    }
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

// ── Actual history (the left half of the chart) ──────────────────────────────

/**
 * The account's ACTUAL weekly balance over the `spanDays` before today, so the
 * chart can put today in the middle with real history on the left and the
 * projection on the right.
 *
 * Walked BACKWARD from `endBalance` — the balance the projection starts at —
 * through the ledger: the balance at the end of day `d` is `endBalance` minus
 * every net flow dated after `d`. Deriving it this way (rather than forward from
 * an older anchor) makes the two halves meet exactly at today: both are pinned
 * to the same figure, so the junction is continuous and the recent slope can be
 * compared against the projected one. It also means the history carries the
 * same staleness as `endBalance` — the SHAPE comes from real transactions
 * either way, only the level comes from the Balance Sheet cell (which the
 * renderer labels when it is old).
 *
 * Stops at the account's first transaction: before that there is nothing to walk
 * back through, and continuing would draw a flat line at a balance with no
 * supporting data. Returns [{ weekEnd, label, balance }] oldest-first, excluding
 * today itself (that point is the projection's `anchor`).
 */
function historySeries({ endBalance, income, expense, spanDays, today }) {
  let first = null;
  const net = new Map(); // date -> net flow that day (income positive)
  const add = (rows, sign) => {
    for (const t of rows) {
      if (!t.date) continue;
      if (first === null || t.date < first) first = t.date;
      net.set(t.date, (net.get(t.date) || 0) + sign * t.amount);
    }
  };
  add(income, 1);
  add(expense, -1);
  if (first === null) return [];

  const windowStart = addDays(today, -spanDays);
  const start = windowStart > first ? windowStart : first;

  // Flows on or before today, sorted ascending; consumed from the end while
  // walking backward.
  const dates = [...net.keys()].filter((d) => d <= today).sort();
  let idx = dates.length - 1;

  const points = [];
  let balance = round2(endBalance);
  for (let k = 1; ; k++) {
    const d = addDays(today, -7 * k);
    if (d < start) break;
    // Undo every flow dated after d, leaving the balance as of the end of d.
    while (idx >= 0 && dates[idx] > d) { balance = round2(balance - net.get(dates[idx])); idx -= 1; }
    points.push({ weekEnd: d, label: weekLabel(d), balance });
  }
  points.reverse();
  return points;
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * Top-level: project a weekly forecast from raw inputs. `income`/`expense` are
 * the already-direction-split transaction rows; `planned` is the planned-items
 * list ([{ amount, flow, date }]). `months` is the horizon (1/3/6); `window` is
 * the independent trailing-average lookback (see HISTORY_MONTHS). `activeMonths`
 * is the Set of 'YYYY-MM' the ledger holds any row for (see windowAverages).
 * `today` defaults to the local date. Returns:
 *   { anchor: { date, balance },
 *     series: [{ weekStart, weekEnd, label, income, expense, net, balance }],
 *     summary: { endBalance, endDate, lowest: { weekStart, label, balance },
 *                belowZero, avgIncome, avgExpense, monthsUsed, window } }
 *
 * `anchor` is where the line STARTS — today, at the starting balance, before any
 * projected flow. The series' first entry is already a week of flows in, so a
 * chart plotting only the series draws its opening point at the wrong height
 * under a label reading today's date.
 *
 * All monetary values are round2'd at the week boundary.
 */
function forecast({
  startBalance, income, expense, planned, months,
  window = HISTORY_MONTHS, activeMonths = null, today = null,
}) {
  const todayIso = today || localTodayIso();
  const endIso = horizonEnd(todayIso, months);
  const nWeeks = weekCount(todayIso, endIso);

  // Recurring decomposition: mark the recurring rows so they are excluded from
  // the smooth baseline, and average the irregular remainder over the same span
  // as the full history (which feeds the summary's "typical month").
  const incPatterns = recurringPatterns(income, todayIso);
  const expPatterns = recurringPatterns(expense, todayIso);
  const incKeys = new Set(incPatterns.map((p) => p.key));
  const expKeys = new Set(expPatterns.map((p) => p.key));

  const totalsAll = monthlyTotals(income, expense);
  const totalsIrreg = monthlyTotals(
    income.filter((t) => !incKeys.has(normaliseDesc(t.description))),
    expense.filter((t) => !expKeys.has(normaliseDesc(t.description)))
  );
  const avg = windowAverages(totalsAll, totalsIrreg, { today: todayIso, window, activeMonths });

  const perDayInc = avg.avgIrregIncome / DAYS_PER_MONTH;
  const perDayExp = avg.avgIrregExpense / DAYS_PER_MONTH;

  // Place the dated flows (recurring + planned) into their weekly buckets.
  const incBuckets = new Array(nWeeks).fill(0);
  const expBuckets = new Array(nWeeks).fill(0);
  const drop = (occ, buckets) => {
    for (const o of occ) {
      const i = weekIndexOf(todayIso, o.date);
      if (i >= 0 && i < nWeeks) buckets[i] += o.amount;
    }
  };
  const opts = { catchUpOverdue: true };
  drop(placeRecurring(incPatterns, todayIso, endIso, opts), incBuckets);
  drop(placeRecurring(expPatterns, todayIso, endIso, opts), expBuckets);
  for (const p of planned) {
    const i = weekIndexOf(todayIso, p.date);
    if (i >= 0 && i < nWeeks) (p.flow === 'income' ? incBuckets : expBuckets)[i] += p.amount;
  }

  // Walk the weeks, accumulating the running balance.
  const openingBalance = round2(startBalance);
  let balance = openingBalance;
  let lowest = null;
  let belowZero = false;
  const series = [];
  for (let i = 0; i < nWeeks; i++) {
    const weekStart = addDays(todayIso, i * 7);
    const daysInWeek = Math.min(7, daysBetween(weekStart, endIso));
    // The last day this bucket covers — the point's position on a date axis,
    // since the balance shown is the one reached at the END of the week.
    const weekEnd = addDays(weekStart, Math.max(0, daysInWeek - 1));
    const inc = round2(perDayInc * daysInWeek + incBuckets[i]);
    const exp = round2(perDayExp * daysInWeek + expBuckets[i]);
    const net = round2(inc - exp);
    balance = round2(balance + net);
    if (balance < 0) belowZero = true;
    if (!lowest || balance < lowest.balance) {
      lowest = { weekStart, label: weekLabel(weekStart), balance };
    }
    series.push({
      weekStart, weekEnd, label: weekLabel(weekStart), income: inc, expense: exp, net, balance,
    });
  }

  // Real history over exactly the span the projection covers, so today lands
  // dead centre on the chart and the two halves are the same length.
  const spanDays = daysBetween(todayIso, endIso);
  const history = historySeries({
    endBalance: openingBalance, income, expense, spanDays, today: todayIso,
  });

  return {
    anchor: { date: todayIso, balance: openingBalance },
    // The x-axis bounds, symmetric about today by construction, so the renderer
    // does not re-derive them and drift off-centre.
    domain: { start: addDays(todayIso, -spanDays), end: endIso },
    history,
    series,
    summary: {
      endBalance: series.length ? series[series.length - 1].balance : openingBalance,
      endDate: series.length ? series[series.length - 1].weekEnd : todayIso,
      // The low point of the projection. Only the below-zero case is shown in
      // the UI: on a line that only climbs, `lowest` is always week 0, so the
      // level alone carries no information.
      lowest,
      belowZero,
      avgIncome: round2(avg.avgIncome),
      avgExpense: round2(avg.avgExpense),
      monthsUsed: avg.monthsUsed,
      window,
    },
  };
}

module.exports = {
  forecast,
  HISTORY_MONTHS,
  historySeries,
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
