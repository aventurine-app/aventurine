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

/**
 * Ensure a Cash Flow year-table exists, creating it fully synced. A brand-new
 * year defaults to computed-from-transactions for every category — the user
 * opts cells OUT rather than in. Guarded on the insert actually creating the
 * year, so calling this for an existing year never re-syncs categories the
 * user has turned off. Returns true when the year was created.
 *
 * Shared by the Cash Flow "+ year" endpoint and the transaction importer
 * (an import auto-creates the years it touches, so imported history feeds
 * the statement, Report Card, and Home with zero configuration).
 */
function ensureSyncedYear(db, year) {
  const info = db.prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)').run(year);
  if (info.changes > 0) {
    db.prepare(
      'INSERT OR IGNORE INTO category_sync (year, category) SELECT ?, "key" FROM categories'
    ).run(year);
  }
  return info.changes > 0;
}

module.exports = { syncedMap, isSynced, ensureSyncedYear };
