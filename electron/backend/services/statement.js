'use strict';

// The Cash Flow statement's cells, the one source every income/spend report
// reads: Cash Flow itself, Spending Trends, the Report Card and Saved &
// Invested.
//
// Data-source rule (per cell): every (year, month, category) cell of an active
// year is COMPUTED from transactions by default; a stored Entry OVERRIDES that
// one cell. There is no sync mode or per-category switch — typing in a cell
// stores an override, deleting the entry restores the computed value.
//
// Cells are shaped {yearStr -> {monthName -> {catKey -> value}}}.

const { VALID_MONTHS, monthName } = require('../validate');

// The two system buckets NULL-category transactions sum into, by direction.
// Their keys are pinned by services/categories.js SYSTEM_CATEGORY_KEYS.
const NULL_KEYS = { income: 'uncat_income', expense: 'uncat_expense' };

/** The statement key a transaction group feeds: its category's key, or one of
 *  the two uncategorized buckets (by tx_type) for NULL-category rows. An
 *  uncategorized TRANSFER feeds no cell: the statement is an income/spend
 *  surface and the direction rule keeps transfers off every one of those, so
 *  bucketing it as uncategorized expense would have the statement report moved
 *  money as spent. There is no uncat_transfer bucket to send it to instead, and
 *  inventing one would put a column on the statement for rows that belong on
 *  none of it. */
function cellKey(categoryId, txType, keyById) {
  if (categoryId == null) {
    const dir = txType ?? 'expense';
    if (dir === 'transfer') return null;
    return NULL_KEYS[dir === 'income' ? 'income' : 'expense'];
  }
  return keyById.get(categoryId);
}

/**
 * The transaction sums for every cell of every ACTIVE year: the computed layer
 * every cell shows unless a manual Entry overrides it. Years without a
 * year-table contribute nothing (deleting a year-table is how a user opts a
 * year out of the statement).
 *
 * Summed by SQLite into one row per (month, category, tx_type) group, so no
 * per-transaction object is built on the JS side: this runs on every
 * statement, trends, report-card and transfers request, in the main process.
 * Only an uncategorized group's tx_type picks its cell; a categorized group
 * goes to its category, which owns its direction.
 *
 * `years` (a Set of year strings) lets a caller that has already read
 * active_years hand it over instead of having it read a second time.
 */
function computedCells(db, years = null) {
  const sums = {};
  const activeYears = years || activeYearSet(db);
  if (!activeYears.size) return sums;

  const keyById = new Map(
    db.prepare('SELECT id, "key" FROM categories').all().map((c) => [c.id, c.key])
  );

  // The GROUP BY matches ix_transactions_month_cat column for column, and
  // every column read is in that index, so SQLite walks the index in group
  // order with no sort and no table lookups. Keep the two in step: grouping by
  // a CASE, or filtering on `date` itself, falls back to sorting every row.
  // (An empty date groups under '' and is dropped by the year check below.)
  // The stored tx_type of a categorized row always matches its category, since
  // every write keeps it in step, so grouping by it adds no real groups.
  const groups = db.prepare(
    `SELECT substr(date, 1, 7) AS ym, category_id, tx_type, SUM(amount) AS total
       FROM transactions
      GROUP BY substr(date, 1, 7), category_id, tx_type`
  ).all();

  for (const g of groups) {
    const year = g.ym.slice(0, 4);
    if (!activeYears.has(year)) continue;
    const month = VALID_MONTHS[parseInt(g.ym.slice(5, 7), 10) - 1];
    const key = cellKey(g.category_id, g.tx_type, keyById);
    if (!month || !key) continue;
    const cells = ((sums[year] ??= {})[month] ??= {});
    // Several groups can land on one key (a NULL and an 'expense' tx_type both
    // feed uncat_expense), so add rather than assign.
    cells[key] = (cells[key] || 0) + g.total;
  }
  return sums;
}

/** Stored Entry rows: the manual per-cell overrides (and, for years or
 *  categories with no transactions, simply the hand-entered bookkeeping). */
function manualCells(db) {
  const manual = {};
  for (const e of db.prepare('SELECT year, month, category, value FROM entries').all()) {
    const months = (manual[String(e.year)] ??= {});
    // Stored as 1-12; the response (and the renderer) key cells by month name.
    (months[monthName(e.month)] ??= {})[e.category] = e.value;
  }
  return manual;
}

/** Deep-merge the two layers into the values the statement shows:
 *  entry ?? computed, per cell. */
function blendCells(computed, manual) {
  const entries = {};
  const overlay = (layer) => {
    for (const [yearStr, months] of Object.entries(layer)) {
      for (const [month, cells] of Object.entries(months)) {
        const target = ((entries[yearStr] ??= {})[month] ??= {});
        Object.assign(target, cells);
      }
    }
  };
  overlay(computed);
  overlay(manual); // manual second — an entry wins its cell
  return entries;
}

/** What the statement shows, cell for cell. The one call the reports make. */
function statementCells(db) {
  return blendCells(computedCells(db), manualCells(db));
}

/** Active years as a Set of year strings, the shape cell keys use. */
function activeYearSet(db) {
  return new Set(db.prepare('SELECT year FROM active_years').all().map((y) => String(y.year)));
}

/**
 * Ensure a Cash Flow year-table exists. Cells compute from transactions by
 * default, so creating the year is all it takes for that year's activity to
 * appear. Used by the transaction importer: an import auto-creates the years
 * it touches, so imported history feeds the statement, Report Card, and
 * Dashboard with zero configuration. Returns true when the year was created.
 */
function ensureActiveYear(db, year) {
  return db.prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)').run(year).changes > 0;
}

module.exports = {
  NULL_KEYS,
  computedCells,
  manualCells,
  blendCells,
  statementCells,
  ensureActiveYear,
};
