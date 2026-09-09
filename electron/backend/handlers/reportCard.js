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
//
// The response carries the same cards over TWO spans: `years`, and `months` —
// each of the twelve months, keyed by name, as its own newest-first series of
// years. That is what backs the report's year+month picker pair, the one the
// Cash Flow tab already uses. A month's card is built by the same service
// function off the same blended cells, with one difference: its debt is null,
// so the debt-to-income ratio reports N/A rather than measuring a balance
// carried against a twelfth of the income servicing it.

const { computedCells, manualCells, blendCells } = require('./incomeExpenses');
const { buildReportCards, METRIC_BANDS } = require('../services/reportCard');
const { VALID_MONTHS } = require('../validate');

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
 * Every Cash Flow cell, bucketed once into per-year AND per-month totals.
 * Mirrors incomeExpenses.dataGet's sourcing exactly: every active year is
 * seeded (so empty years still get a card), and each cell contributes its
 * blended value — the transaction sum unless a manual Entry overrides that
 * cell. A category key maps to a bucket by its cat_type (the uncat_* buckets
 * are real categories); cells for unknown/typeless keys are skipped.
 *
 * Both scopes come off ONE walk of the blended cells: a cell belongs to a year
 * and to a month of it at the same time, and reading the statement twice per
 * request would spend twice the work on the same numbers. All twelve months of
 * every active year are seeded, so a month with no cells reports zeroes rather
 * than going missing — the rule the year scope already applies to an active
 * year with no activity.
 */
function collectTotals(db) {
  const bucketByKey = new Map();
  const nameByKey = new Map();
  for (const c of db.prepare('SELECT "key", name, cat_type FROM categories').all()) {
    const bucket = BUCKET_BY_CAT_TYPE[c.cat_type];
    if (bucket) bucketByKey.set(c.key, bucket);
    nameByKey.set(c.key, c.name);
  }

  const years = new Map();  // year -> totals
  const months = new Map(); // month name -> Map(year -> totals)
  for (const m of VALID_MONTHS) months.set(m, new Map());

  const blank = () => ({ income: 0, expenses: 0, transfers: 0, invested: 0, expenseByCat: new Map() });
  const ensureYear = (year) => {
    let t = years.get(year);
    if (!t) { t = blank(); years.set(year, t); }
    return t;
  };
  const ensureMonth = (month, year) => {
    const byYear = months.get(month);
    if (!byYear) return null; // a cell stored under a month name we do not know
    let t = byYear.get(year);
    if (!t) { t = blank(); byYear.set(year, t); }
    return t;
  };

  // Seed every year on the Cash Flow statement, in both scopes.
  for (const y of db.prepare('SELECT year FROM active_years').all()) {
    ensureYear(y.year);
    for (const m of VALID_MONTHS) ensureMonth(m, y.year);
  }

  const blended = blendCells(computedCells(db), manualCells(db));
  for (const [yearStr, monthCells] of Object.entries(blended)) {
    const year = parseInt(yearStr, 10);
    if (!Number.isInteger(year)) continue;
    for (const [month, cells] of Object.entries(monthCells)) {
      for (const [key, amt] of Object.entries(cells)) {
        const bucket = bucketByKey.get(key);
        if (!bucket) continue;
        for (const t of [ensureYear(year), ensureMonth(month, year)]) {
          if (!t) continue;
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
  }

  // Resolve each span's biggest expense category once its sums are complete.
  const resolveTop = (t) => {
    let top = null;
    for (const [key, amount] of t.expenseByCat) {
      if (amount > 0 && (!top || amount > top.amount)) {
        top = { key, name: nameByKey.get(key) || key, amount };
      }
    }
    t.topExpense = top;
    delete t.expenseByCat;
  };
  for (const t of years.values()) resolveTop(t);
  for (const byYear of months.values()) for (const t of byYear.values()) resolveTop(t);

  return { years, months };
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

/** One scope's totals as the raw rows buildReportCards takes. `debtFor` gives
 *  a year's debt snapshot, or null in a scope that has none to report. */
function cardRows(totals, debtFor) {
  return [...totals.entries()].map(([year, t]) => ({
    year,
    income: t.income,
    expenses: t.expenses,
    transfers: t.transfers,
    invested: t.invested,
    topExpense: t.topExpense,
    debt: debtFor(year),
  }));
}

function reportCardGet(ctx) {
  const db = ctx.db();
  const { years: yearTotals, months: monthTotals } = collectTotals(db);
  const debt = debtByYear(db);

  // Newest year first.
  const newestFirst = (a, b) => b.year - a.year;
  const years = buildReportCards(
    cardRows(yearTotals, (y) => (debt.has(y) ? debt.get(y) : null))
  ).sort(newestFirst);

  // The same cards over one month of each year, so the report's month picker
  // has a span to narrow to. buildReportCards keys its comparison on `year`, so
  // running it over one month's series across the years compares a month
  // against the SAME month twelve months earlier, which is what the pill reads.
  //
  // Debt is null in this scope: it is a balance carried, not a flow, so
  // dividing it by one month's income would measure it against a twelfth of the
  // income servicing it. The ratio reports N/A for a month instead.
  const months = {};
  for (const [month, totals] of monthTotals) {
    months[month] = buildReportCards(cardRows(totals, () => null)).sort(newestFirst);
  }

  return { ok: true, years, months, bands: METRIC_BANDS };
}

const routes = [['GET', '/api/report-card', reportCardGet]];

module.exports = { routes, debtByYear };
