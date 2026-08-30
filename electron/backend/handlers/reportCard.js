'use strict';

// Yearly Report Card (Reports) blueprint. Read-only: aggregates each year's
// Cash Flow (Income & Expenses) activity into income / expense totals, plus the
// latest Balance-Sheet debt snapshot, then hands the per-year totals to
// services/reportCard.js for the year-over-year changes, ratios, and goal
// outcomes. Transfer categories are graded by no goal — money moved to savings
// or a brokerage is excluded from the income/spend surfaces — but their total is
// still reported, because the share of income put away is one of the metrics on
// this report.
//
// "Relevant years" are the years on the Cash Flow statement (the `active_years`
// table), so every year the user tracks gets a card, including one with no
// activity yet, not only years with transactions. Each year's figures are the
// same numbers the Cash Flow page shows: per cell, the transaction-derived sum
// unless a stored Entry overrides it (see incomeExpenses.dataGet).

const { computedCells, manualCells, blendCells } = require('./incomeExpenses');
const { buildReportCards, METRIC_BANDS, INFLATION_CATEGORIES } = require('../services/reportCard');

// cat_type → which headline bucket a category feeds. Transfers get their own
// bucket rather than being dropped: they stay out of income and spend (the two
// headline figures and every goal), but their total is what the savings-rate
// metric divides by income — money the income and spend figures exclude.
const BUCKET_BY_CAT_TYPE = {
  income: 'income',
  expense: 'expenses',
  transfer: 'transfers',
};

// The seeded transfer category for money moved into a brokerage (seed.js).
// Renaming it in the UI keeps the key, so the invested share survives a rename.
// A user-created brokerage category is counted by the savings rate (all
// transfers) but not by this one.
const INVESTING_KEY = 'investing';

/**
 * Per-year { income, expenses, transfers, invested, topExpense, byKey } from the
 * Cash Flow statement, plus the key→name map the charted categories print with. Mirrors incomeExpenses.dataGet's sourcing exactly: every
 * active year is seeded
 * (so empty years still get a card), and each cell contributes its blended
 * value — the transaction sum unless a manual Entry overrides that cell. A
 * category key maps to a bucket by its cat_type (the uncat_* buckets are real
 * categories); cells for unknown/typeless keys are skipped.
 */
function yearlyTotals(db) {
  const bucketByKey = new Map();
  const nameByKey = new Map();
  for (const c of db.prepare('SELECT "key", name, cat_type FROM categories').all()) {
    const bucket = BUCKET_BY_CAT_TYPE[c.cat_type];
    if (bucket) bucketByKey.set(c.key, bucket);
    nameByKey.set(c.key, c.name);
  }

  const totals = new Map(); // year -> { income, expenses, transfers, invested, expenseByCat }
  const ensure = (year) => {
    let t = totals.get(year);
    if (!t) {
      t = { income: 0, expenses: 0, transfers: 0, invested: 0, expenseByCat: new Map() };
      totals.set(year, t);
    }
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
        const t = ensure(year);
        t[bucket] += amt;
        if (bucket === 'transfers' && key === INVESTING_KEY) t.invested += amt;
        // Per-category expense sums back the "largest expense" metric. Kept
        // here rather than in the service: the service takes plain totals and
        // has no way to turn a category key into the name the tile shows.
        if (bucket === 'expenses') {
          t.expenseByCat.set(key, (t.expenseByCat.get(key) || 0) + amt);
        }
      }
    }
  }

  // Resolve each year's biggest expense category once the sums are complete, and
  // keep the charted categories' own sums — the Inflation section plots those
  // five as a series, so unlike topExpense they cannot be reduced to one winner
  // here.
  const charted = new Set(INFLATION_CATEGORIES);
  for (const t of totals.values()) {
    let top = null;
    const byKey = {};
    for (const [key, amount] of t.expenseByCat) {
      if (amount > 0 && (!top || amount > top.amount)) {
        top = { key, name: nameByKey.get(key) || key, amount };
      }
      if (charted.has(key)) byKey[key] = amount;
    }
    t.topExpense = top;
    t.byKey = byKey;
    delete t.expenseByCat;
  }

  // key → the name to print, for the charted categories only. Resolved here for
  // the same reason topExpense's name is: the service takes plain totals and has
  // no way to turn a category key into a name. A key the user deleted keeps its
  // key as its label rather than vanishing from the series.
  const categoryNames = {};
  for (const key of INFLATION_CATEGORIES) categoryNames[key] = nameByKey.get(key) || key;

  return { totals, categoryNames };
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
        WHERE bc.col_type = 'debt' AND bc.hidden = 0`
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
  const { totals, categoryNames } = yearlyTotals(db);
  const debt = debtByYear(db);

  const rows = [...totals.entries()].map(([year, t]) => ({
    year,
    income: t.income,
    expenses: t.expenses,
    transfers: t.transfers,
    invested: t.invested,
    topExpense: t.topExpense,
    debt: debt.has(year) ? debt.get(year) : null,
    expenseByCat: t.byKey,
    categoryNames,
  }));

  // Newest year first.
  const years = buildReportCards(rows).sort((a, b) => b.year - a.year);
  return { ok: true, years, bands: METRIC_BANDS };
}

const routes = [['GET', '/api/report-card', reportCardGet]];

module.exports = { routes, yearlyTotals, debtByYear };
