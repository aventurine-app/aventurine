'use strict';

// Spend-averaging helper for the Credit Cards planner — port of
// services/credit_cards.py. Pure; DB access stays in the handler.

// How many of the most recent active months feed the average.
const SPEND_WINDOW_MONTHS = 12;

/**
 * Average monthly spend over the most recent `window` months that actually
 * have spend recorded. `monthTotals` is a Map keyed by year*100 + monthIndex
 * (1-12) — numerically sortable in chronological order, mirroring Python's
 * (year, month) tuple keys.
 *
 * Months with zero/negative totals are skipped rather than averaged in (a
 * month with no data usually means "not tracked yet"). Returns 0 when no
 * month has spend.
 */
function recentMonthlyAverage(monthTotals, window = SPEND_WINDOW_MONTHS) {
  const active = [...monthTotals.entries()]
    .filter(([, total]) => total > 0)
    .map(([key]) => key)
    .sort((a, b) => a - b)
    .slice(-window);
  if (!active.length) return 0;
  const sum = active.reduce((s, key) => s + monthTotals.get(key), 0);
  return sum / active.length;
}

module.exports = { SPEND_WINDOW_MONTHS, recentMonthlyAverage };
