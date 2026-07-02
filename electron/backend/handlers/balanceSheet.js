'use strict';

// Balance Sheet specifics layered onto the generic year-table factory: the
// per-(year, column) sync toggle endpoint plus the factory hooks that keep
// balance_sync consistent through the year lifecycle and guard writes to
// synced cells. The derivation/overlay logic itself lives in
// services/balances.js; routes.js spreads `factoryHooks` into the factory
// config and registers `routes` alongside it.

const { bad, validateYear } = require('../validate');
const {
  overlayBalanceData,
  syncedBalanceMap,
  linkedColumnKeys,
  ensureBalanceYear,
} = require('../services/balances');

/**
 * Toggle sync for a Balance Sheet year. Body is either { category, sync } for
 * a single column or { all: true, sync } for every eligible column at once —
 * the same contract as Cash Flow's syncSet. Turning sync ON requires the
 * column to have a linked account (an unlinked column has no data source, so
 * syncing it would only produce permanently empty read-only cells); turning
 * it OFF is always allowed.
 */
function syncSet(ctx, { params, body }) {
  const db = ctx.db();
  const data = body || {};
  if (typeof data.sync !== 'boolean') bad('sync must be boolean');
  if (!db.prepare('SELECT 1 FROM balance_active_years WHERE year = ?').get(params.year)) {
    bad('unknown year', 404);
  }

  const linked = linkedColumnKeys(db);
  const ins = db.prepare('INSERT OR IGNORE INTO balance_sync (year, category) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM balance_sync WHERE year = ? AND category = ?');
  const apply = (key) => (data.sync ? ins.run(params.year, key) : del.run(params.year, key));

  if (data.all === true) {
    // "Sync all" means every column that CAN sync; "Unsync all" clears
    // everything, including rows for columns whose account was since deleted.
    const keys = data.sync
      ? [...linked]
      : db.prepare('SELECT "key" FROM balance_columns').all().map((c) => c.key);
    db.transaction(() => keys.forEach(apply))();
  } else {
    const key = data.category;
    if (!db.prepare('SELECT 1 FROM balance_columns WHERE "key" = ?').get(key)) {
      bad('unknown column');
    }
    if (data.sync && !linked.has(key)) {
      bad('no account is linked to this column; assign one at import to enable sync');
    }
    apply(key);
  }
  return { ok: true };
}

/** Factory hooks (yearTableRoutes config) that keep balance_sync coherent. */
const factoryHooks = {
  augmentData: overlayBalanceData,

  // A synced cell is computed — hand-editing it is refused exactly like a
  // synced Cash Flow cell (the stored value would be ignored anyway).
  guardEntryWrite(db, parsed) {
    if (syncedBalanceMap(db)[String(parsed.year)]?.has(parsed.category)) {
      bad('account is in sync mode; its values derive from your imports', 409);
    }
  },

  // New year (Add Year button): linked columns default into sync — the same
  // sync-by-default a year created by a transaction import gets.
  onYearAdded(db, year) {
    if (!validateYear(year)) return;
    db.prepare(
      `INSERT OR IGNORE INTO balance_sync (year, category)
       SELECT ?, balance_column FROM accounts WHERE balance_column IS NOT NULL`
    ).run(year);
  },

  // A duplicate is a faithful copy, sync config included.
  onYearDuplicated(db, sourceYear, targetYear) {
    db.prepare(
      `INSERT OR IGNORE INTO balance_sync (year, category)
       SELECT ?, category FROM balance_sync WHERE year = ?`
    ).run(targetYear, sourceYear);
  },

  onYearDeleted(db, year) {
    db.prepare('DELETE FROM balance_sync WHERE year = ?').run(year);
  },
};

const routes = [['POST', '/api/balance/year/<int:year>/sync', syncSet]];

module.exports = { routes, factoryHooks, ensureBalanceYear };
