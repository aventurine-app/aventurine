'use strict';

// Financial Freedom (Dashboard). Read-only: ONE measurement of the whole ledger
// — the Financial Independence number (FI_MULTIPLE x average yearly expenses)
// and how far the latest Balance-Sheet net worth has got towards it. It first
// lived on the Metrics tab as a per-year figure and was moved here because a
// target that changed with the report's year picker is not a target.
//
// Yearly expenses come from the Cash Flow statement through reportCard's
// yearlyTotals — the same blended cells Metrics grades — so the two never
// disagree about what a year cost. The math itself is services/reportCard.js
// financialFreedom(); this file only reads the two inputs.

const { yearlyTotals } = require('./reportCard');
const { financialFreedom } = require('../services/reportCard');

/**
 * The latest net worth on the Balance Sheet: every visible column's most recent
 * value, summed, with debt columns subtracted — the Dashboard's Net Worth
 * chart's rule (computeNetWorth in static/js/pages/dashboard.js), so the two
 * agree. Carry-forward is the method: a month that updates one account still
 * reports every account (the running `latest` map) rather than dropping to the
 * one entry. The snapshot carries the month it was taken from, so the card can
 * say "as of March 2025" when the balances are older than today.
 *
 * Returns { value, asOf: { year, month } } (month 1-12), or null when the
 * Balance Sheet holds no entry at all.
 */
function latestNetWorth(db) {
  const rows = db
    .prepare(
      `SELECT be.year AS year, be.month AS month, be.category AS category,
              be.value AS value, bc.col_type AS col_type
         FROM balance_entries be
         JOIN balance_columns bc ON bc."key" = be.category
        WHERE bc.hidden = 0
        ORDER BY be.year, be.month`
    )
    .all();
  if (!rows.length) return null;

  const latest = new Map(); // column key -> its most recent signed value
  let asOf = null;
  for (const r of rows) {
    latest.set(r.category, r.col_type === 'debt' ? -r.value : r.value);
    asOf = { year: r.year, month: r.month };
  }
  let value = 0;
  for (const v of latest.values()) value += v;
  return { value, asOf };
}

function financialFreedomGet(ctx) {
  const db = ctx.db();
  const { totals } = yearlyTotals(db);
  const years = [...totals.entries()].map(([year, t]) => ({ year, expenses: t.expenses }));
  const nw = latestNetWorth(db);
  return {
    ok: true,
    ...financialFreedom({
      years,
      netWorth: nw ? nw.value : null,
      netWorthAsOf: nw ? nw.asOf : null,
    }),
  };
}

const routes = [['GET', '/api/financial-freedom', financialFreedomGet]];

module.exports = { routes, latestNetWorth };
