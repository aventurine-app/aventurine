'use strict';

// Per-table (per-year) category sync membership. A row in category_sync means
// that category's Cash Flow values for that year are computed from transactions
// instead of hand-entered. `category` is the category KEY (matching
// entries.category), so it survives renames.
//
// Shared by the Income & Expenses handler (which decides the data source for
// each cell) and the Credit Cards handler (whose spend average follows the same
// transactions-vs-entries rule).

/** All synced cells as { [yearStr]: Set<catKey> }. One query. */
function syncedMap(db) {
  const map = {};
  for (const r of db.prepare('SELECT year, category FROM category_sync').all()) {
    (map[String(r.year)] ??= new Set()).add(r.category);
  }
  return map;
}

/** Is this (year, category) cell computed from transactions? */
function isSynced(db, year, category) {
  return !!db
    .prepare('SELECT 1 FROM category_sync WHERE year = ? AND category = ?')
    .get(year, category);
}

module.exports = { syncedMap, isSynced };
