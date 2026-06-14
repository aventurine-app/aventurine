'use strict';

// Yearly Report Card (Reports) blueprint. Read-only: aggregates each year's
// Cash Flow (Income & Expenses) activity into income / expense / savings +
// investing totals, plus the latest Balance-Sheet debt snapshot, then hands the
// per-year totals to services/reportCard.js for the year-over-year changes,
// ratios, and grade.
//
// "Relevant years" are the years on the Cash Flow statement (the `active_years`
// table) — so every year the user tracks gets a card, even one with no activity
// yet, not just years that happen to have transactions. Each year's figures are
// the exact same numbers the Cash Flow page shows: hand-entered cell values plus,
// for synced cells, the transaction-derived sums (see incomeExpenses.dataGet).

const { VALID_MONTHS } = require('../validate');
const { syncedMap } = require('../categorySync');
const { syncSums } = require('./incomeExpenses');
const { buildReportCards } = require('../services/reportCard');

// cat_type → which headline bucket a category feeds. savings and investing are
// reported as one combined "savings & investing" figure.
const BUCKET_BY_CAT_TYPE = {
  income: 'income',
  expense: 'expenses',
  savings: 'savings',
  investing: 'savings',
};

// The two uncategorized sync buckets (NULL-category transactions, by tx_type)
// feed the same income/expense headline figures.
const BUCKET_BY_SYNC_KEY = { uncat_income: 'income', uncat_expense: 'expenses' };

const MONTH_INDEX = new Map(VALID_MONTHS.map((m, i) => [m, i]));

/**
 * Per-year { income, expenses, savings } from the Cash Flow statement. Mirrors
 * incomeExpenses.dataGet's data sourcing exactly: every active year is seeded
 * (so empty years still get a card), hand-entered cell values are summed unless
 * the cell is synced, and synced cells contribute their transaction-derived
 * sums. A category key maps to a bucket by its cat_type; the uncat_* sync keys
 * map to income/expense. Cells for unknown/typeless keys are skipped.
 */
function yearlyTotals(db) {
  const bucketByKey = new Map();
  for (const c of db.prepare('SELECT "key", cat_type FROM categories').all()) {
    const bucket = BUCKET_BY_CAT_TYPE[c.cat_type];
    if (bucket) bucketByKey.set(c.key, bucket);
  }
  const bucketFor = (key) => bucketByKey.get(key) || BUCKET_BY_SYNC_KEY[key] || null;

  const totals = new Map(); // year -> { income, expenses, savings }
  const ensure = (year) => {
    let t = totals.get(year);
    if (!t) { t = { income: 0, expenses: 0, savings: 0 }; totals.set(year, t); }
    return t;
  };

  // Seed every year on the Cash Flow statement so years with no activity still
  // get a (ungradeable, N/A) card.
  for (const y of db.prepare('SELECT year FROM active_years').all()) ensure(y.year);

  const synced = syncedMap(db);

  // Hand-entered cells — a synced cell ignores its stored manual value.
  for (const e of db.prepare('SELECT year, month, category, value FROM entries').all()) {
    if (synced[String(e.year)]?.has(e.category)) continue;
    const bucket = bucketFor(e.category);
    if (!bucket) continue;
    ensure(e.year)[bucket] += e.value;
  }

  // Synced cells — { yearStr -> { month -> { catKey -> sum } } } from transactions.
  for (const [yearStr, months] of Object.entries(syncSums(db))) {
    const year = parseInt(yearStr, 10);
    if (!Number.isInteger(year)) continue;
    for (const cells of Object.values(months)) {
      for (const [key, amt] of Object.entries(cells)) {
        const bucket = bucketFor(key);
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
 * forecast.js' accountBalances month-recency pick (month is stored as a name).
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

  const latestIdx = new Map(); // year -> highest month index seen
  for (const r of rows) {
    const idx = MONTH_INDEX.get(r.month);
    if (idx === undefined) continue;
    const cur = latestIdx.get(r.year);
    if (cur === undefined || idx > cur) latestIdx.set(r.year, idx);
  }

  const debt = new Map();
  for (const r of rows) {
    const idx = MONTH_INDEX.get(r.month);
    if (idx === undefined || idx !== latestIdx.get(r.year)) continue;
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
