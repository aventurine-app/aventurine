'use strict';

// Recurring-expense detection for the Dashboard page "Upcoming Expenses" card —
// faithful port of services/predictions.py. Pure functions over already-loaded
// rows; only .date (ISO string) / .description / .amount are touched. DB access
// stays in the handler.

// (name, nominal gap in days, per-gap tolerance in days) — tolerances are tight
// enough that the windows do not overlap.
const CYCLES = [
  ['weekly', 7, 2],
  ['biweekly', 14, 3],
  ['monthly', 30, 5],
  ['quarterly', 91, 10],
  ['yearly', 365, 20],
];

// Cycles that step by calendar month rather than a fixed day count.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

// {cycle name -> nominal gap in days}, derived from CYCLES. A cadence override
// (Recurring page) re-derives next_date from this, so the day counts above are
// not duplicated.
const CYCLE_DAYS = Object.fromEntries(CYCLES.map(([name, days]) => [name, days]));

const MIN_OCCURRENCES = 3; // charges needed before a pattern is trusted
const MIN_REGULARITY = 0.7; // fraction of gaps that must sit within tolerance

// Grace period (days past the projected next charge) before
// detectRecurringSeries drops a series as cancelled. Much looser than a cycle's
// own gap tolerance: a short month, a late-posting charge, or an un-imported
// latest statement would otherwise remove months of regular history from the
// calendar. detectRecurringExpenses keeps the tighter per-cycle tolerance
// (oracle-pinned, must not change).
const LAPSED_GRACE_DAYS = 90;

/** Canonical grouping key for a merchant string (mirror of _normalise_desc):
 *  lowercase, digits dropped, every non-[a-z] run collapsed to one space. */
function normaliseDesc(desc) {
  const lowered = String(desc == null ? '' : desc).toLowerCase().replace(/\d+/g, '');
  return lowered.replace(/[^a-z]+/g, ' ').trim();
}

// ── ISO-date arithmetic (dates stay 'YYYY-MM-DD' strings) ────────────────────

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

const DAY_MS = 86400000;

/** Today as a LOCAL-timezone ISO date — mirror of Python's date.today(). This
 *  is the default `today` for detection; UTC would shift the date by a day for
 *  users west of Greenwich in the evening. */
function localTodayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(isoA, isoB) {
  return Math.round((toUTC(isoB) - toUTC(isoA)) / DAY_MS);
}

function addDays(iso, n) {
  return fromUTC(toUTC(iso) + n * DAY_MS);
}

/** iso plus n calendar months, clamping the day (Jan 31 + 1mo -> Feb 28).
 *  Mirror of _add_months. */
function addMonths(iso, n) {
  const [y0, m0, d0] = iso.split('-').map(Number);
  const total = m0 - 1 + n;
  const year = y0 + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  // Last day of the target month = day 0 of the following month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const p = (nn) => String(nn).padStart(2, '0');
  return `${year}-${p(month)}-${p(Math.min(d0, lastDay))}`;
}

/** statistics.median over numbers. */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Match the median gap to a known cycle; null when no cycle window matches. */
function classifyCycle(gaps) {
  const mid = median(gaps);
  for (const [name, days, tol] of CYCLES) {
    if (Math.abs(mid - days) <= tol) return [name, days, tol];
  }
  return null;
}

// Python-equivalent round(x, 2) — the one exact implementation lives in
// validate.js (BigInt-exact, oracle-verified); do not duplicate it.
const { round2 } = require('../validate');

/**
 * Find likely subscriptions/bills in expense transactions and project the next
 * charge of each (mirror of detect_recurring_expenses). `today` is an ISO
 * string (defaults to the current date). Returns up to `limit` predictions,
 * soonest due first: {description, amount, cycle, next_date, due_in_days,
 * last_date, occurrences, confidence}.
 */
function detectRecurringExpenses(transactions, { today = null, limit = 5 } = {}) {
  const todayIso = today || localTodayIso();

  // Bucket rows by normalised merchant key; ungroupable rows are skipped.
  const groups = new Map();
  for (const t of transactions) {
    const key = normaliseDesc(t.description);
    if (!key) continue;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(t);
  }

  const results = [];
  for (const rows of groups.values()) {
    // Merge same-day rows (split charges) into one occurrence.
    const byDate = new Map();
    for (const t of rows) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount);
    }
    if (byDate.size < MIN_OCCURRENCES) continue;

    const dates = [...byDate.keys()].sort(); // ISO strings sort chronologically
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));

    const cycle = classifyCycle(gaps);
    if (!cycle) continue;
    const [name, days, tol] = cycle;

    // Regularity: enough individual gaps must sit near the nominal cycle.
    const regular = gaps.filter((g) => Math.abs(g - days) <= tol).length / gaps.length;
    if (regular < MIN_REGULARITY) continue;

    // Project the next charge from the most recent one.
    const last = dates[dates.length - 1];
    const nextDue = name in CYCLE_MONTHS ? addMonths(last, CYCLE_MONTHS[name]) : addDays(last, days);

    // Overdue beyond tolerance => treated as cancelled; dropped.
    if (daysBetween(nextDue, todayIso) > tol) continue;

    // Predicted amount: median of the latest few charges.
    const amount = round2(median(dates.slice(-3).map((d) => byDate.get(d))));

    // Confidence blends regularity with history depth, capped at six gaps.
    const confidence = round2(regular * (0.5 + (0.5 * Math.min(gaps.length, 6)) / 6));

    // Display name = the most recent raw description.
    const latestRow = rows.reduce((a, b) => (a.date > b.date ? a : b));
    results.push({
      description: latestRow.description,
      amount,
      cycle: name,
      next_date: nextDue,
      due_in_days: daysBetween(todayIso, nextDue),
      last_date: last,
      occurrences: dates.length,
      confidence,
    });
  }

  // Soonest first; ties on date are ordered by confidence.
  results.sort((a, b) =>
    a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.confidence - a.confidence
  );
  return results.slice(0, limit);
}

/**
 * Find every currently-active recurring series in one direction's transactions
 * (mirror of detectRecurringExpenses's grouping/cycle/regularity/lapsed-drop
 * rules, kept as a separate function rather than a shared refactor because
 * detectRecurringExpenses is oracle-fixture-pinned and must not change).
 * Unlike detectRecurringExpenses this returns EVERY qualifying series (no
 * `limit`) and keeps each series' full occurrence history — `dates`, one entry
 * per real charge date with that day's actual (split-merged) amount — instead
 * of collapsing it to a last-date/count pair. The calendar view uses those
 * dates to mark past charge days, not only the next projected one.
 * `today` is an ISO string (defaults to the current date). Returns
 * [{key, description, amount, cycle, next_date, due_in_days, last_date, dates,
 * occurrences, confidence}], sorted soonest-due first.
 */
function detectRecurringSeries(transactions, { today = null } = {}) {
  const todayIso = today || localTodayIso();

  const groups = new Map();
  for (const t of transactions) {
    const key = normaliseDesc(t.description);
    if (!key) continue;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(t);
  }

  const results = [];
  for (const rows of groups.values()) {
    const byDate = new Map();
    for (const t of rows) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount);
    }
    if (byDate.size < MIN_OCCURRENCES) continue;

    const dates = [...byDate.keys()].sort();
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));

    const cycle = classifyCycle(gaps);
    if (!cycle) continue;
    const [name, days, tol] = cycle;

    const regular = gaps.filter((g) => Math.abs(g - days) <= tol).length / gaps.length;
    if (regular < MIN_REGULARITY) continue;

    const last = dates[dates.length - 1];
    const nextDue = name in CYCLE_MONTHS ? addMonths(last, CYCLE_MONTHS[name]) : addDays(last, days);

    // Overdue beyond the lapsed grace period => treated as cancelled; dropped.
    if (daysBetween(nextDue, todayIso) > LAPSED_GRACE_DAYS) continue;

    const amount = round2(median(dates.slice(-3).map((d) => byDate.get(d))));
    const confidence = round2(regular * (0.5 + (0.5 * Math.min(gaps.length, 6)) / 6));
    const latestRow = rows.reduce((a, b) => (a.date > b.date ? a : b));

    results.push({
      key: normaliseDesc(latestRow.description),
      description: latestRow.description,
      display_name: latestRow.display_name ?? null,
      amount,
      cycle: name,
      cycle_days: days,
      dates: dates.map((d) => ({ date: d, amount: round2(byDate.get(d)) })),
      next_date: nextDue,
      due_in_days: daysBetween(todayIso, nextDue),
      last_date: last,
      occurrences: dates.length,
      confidence,
    });
  }

  results.sort((a, b) =>
    a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.confidence - a.confidence
  );
  return results;
}

module.exports = {
  detectRecurringExpenses,
  detectRecurringSeries,
  normaliseDesc,
  addMonths,
  addDays,
  daysBetween,
  median,
  classifyCycle,
  localTodayIso,
  CYCLE_MONTHS,
  CYCLE_DAYS,
  MIN_OCCURRENCES,
  MIN_REGULARITY,
  LAPSED_GRACE_DAYS,
};
