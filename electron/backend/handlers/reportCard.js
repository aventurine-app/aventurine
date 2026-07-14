'use strict';

// Yearly Report Card (Reports) blueprint. Read-only: aggregates each year's
// Cash Flow (Income & Expenses) activity into income / expense / savings +
// investing totals, plus the latest Balance-Sheet debt snapshot, then hands the
// per-year totals to services/reportCard.js for the year-over-year changes,
// ratios, and goal outcomes.
//
// "Relevant years" are the years on the Cash Flow statement (the `active_years`
// table) — so every year the user tracks gets a card, even one with no activity
// yet, not just years that happen to have transactions. Each year's figures are
// the exact same numbers the Cash Flow page shows: per cell, the transaction-
// derived sum unless a stored Entry overrides it (see incomeExpenses.dataGet).

const { computedCells, manualCells, blendCells } = require('./incomeExpenses');
const { buildReportCards } = require('../services/reportCard');

// cat_type → which headline bucket a category feeds. savings and investing are
// reported as one combined "savings & investing" figure.
const BUCKET_BY_CAT_TYPE = {
  income: 'income',
  expense: 'expenses',
  savings: 'savings',
  investing: 'savings',
};

/**
 * Per-year { income, expenses, savings } from the Cash Flow statement. Mirrors
 * incomeExpenses.dataGet's data sourcing exactly: every active year is seeded
 * (so empty years still get a card), and each cell contributes its blended
 * value — the transaction sum unless a manual Entry overrides that cell. A
 * category key maps to a bucket by its cat_type (the uncat_* buckets are real
 * categories); cells for unknown/typeless keys are skipped.
 */
function yearlyTotals(db) {
  const bucketByKey = new Map();
  for (const c of db.prepare('SELECT "key", cat_type FROM categories').all()) {
    const bucket = BUCKET_BY_CAT_TYPE[c.cat_type];
    if (bucket) bucketByKey.set(c.key, bucket);
  }

  const totals = new Map(); // year -> { income, expenses, savings }
  const ensure = (year) => {
    let t = totals.get(year);
    if (!t) { t = { income: 0, expenses: 0, savings: 0 }; totals.set(year, t); }
    return t;
  };

  // Seed every year on the Cash Flow statement so years with no activity still
  // get a card (with no evaluable goals).
  for (const y of db.prepare('SELECT year FROM active_years').all()) ensure(y.year);

  const blended = blendCells(computedCells(db), manualCells(db));
  for (const [yearStr, months] of Object.entries(blended)) {
    const year = parseInt(yearStr, 10);
    if (!Number.isInteger(year)) continue;
    for (const cells of Object.values(months)) {
      for (const [key, amt] of Object.entries(cells)) {
        const bucket = bucketByKey.get(key);
        if (!bucket) continue;
        ensure(year)[bucket] += amt;
      }
    }
  }

  return totals;
}

/**
 * Per-year total debt = the sum of debt-type Balance-Sheet columns at the most
 * recent month that has any debt entry in that year. A year with no debt data
 * is absent from the map (→ null debt, an N/A debt-to-income metric). Mirrors
 * forecast.js' accountBalances month-recency pick (month is stored as 1-12).
 */
function debtByYear(db) {
  const rows = db
    .prepare(
      `SELECT be.year AS year, be.month AS month, be.value AS value
         FROM balance_entries be
         JOIN balance_columns bc ON bc."key" = be.category
        WHERE bc.col_type = 'debt'`
    )
    .all();

  const latestIdx = new Map(); // year -> highest month (1-12) seen
  for (const r of rows) {
    const cur = latestIdx.get(r.year);
    if (cur === undefined || r.month > cur) latestIdx.set(r.year, r.month);
  }

  const debt = new Map();
  for (const r of rows) {
    if (r.month !== latestIdx.get(r.year)) continue;
    debt.set(r.year, (debt.get(r.year) || 0) + r.value);
  }
  return debt;
}

function reportCardGet(ctx) {
  const db = ctx.db();
  const totals = yearlyTotals(db);
  const debt = debtByYear(db);

  const rows = [...totals.entries()].map(([year, t]) => ({
    year,
    income: t.income,
    expenses: t.expenses,
    savings: t.savings,
    debt: debt.has(year) ? debt.get(year) : null,
  }));

  // Newest year first — most users care about the year they're in.
  const years = buildReportCards(rows).sort((a, b) => b.year - a.year);
  return { ok: true, years };
}

const routes = [['GET', '/api/report-card', reportCardGet]];

module.exports = { routes, yearlyTotals, debtByYear };
