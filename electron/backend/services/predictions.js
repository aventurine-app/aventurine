'use strict';

// Recurring-expense detection for the Home page "Upcoming Expenses" card —
// faithful port of services/predictions.py. Pure functions over already-loaded
// rows; only .date (ISO string) / .description / .amount are touched. DB access
// stays in the handler.

// (name, nominal gap in days, per-gap tolerance in days) — tolerances tight
// enough that the windows never overlap.
const CYCLES = [
  ['weekly', 7, 2],
  ['biweekly', 14, 3],
  ['monthly', 30, 5],
  ['quarterly', 91, 10],
  ['yearly', 365, 20],
];

// Cycles that step by calendar month rather than a fixed day count.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

const MIN_OCCURRENCES = 3; // charges needed before a pattern is trusted
const MIN_REGULARITY = 0.7; // fraction of gaps that must sit within tolerance

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

/** Today as a LOCAL-timezone ISO date — mirror of Python's date.today() (the
 *  default `today` for detection; using UTC would shift a day for users west
 *  of Greenwich in the evening). */
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

/** Match the median gap to a known cycle; null when nothing fits. */
function classifyCycle(gaps) {
  const mid = median(gaps);
  for (const [name, days, tol] of CYCLES) {
    if (Math.abs(mid - days) <= tol) return [name, days, tol];
  }
  return null;
}

// Python-equivalent round(x, 2) — the one exact implementation lives in
// validate.js (BigInt-exact, oracle-verified); never duplicate it.
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

    // Overdue beyond tolerance => probably cancelled — drop it.
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

  // Soonest first; confidence breaks date ties.
  results.sort((a, b) =>
    a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.confidence - a.confidence
  );
  return results.slice(0, limit);
}

module.exports = {
  detectRecurringExpenses,
  normaliseDesc,
  addMonths,
  addDays,
  daysBetween,
  median,
  classifyCycle,
  localTodayIso,
  CYCLE_MONTHS,
};
