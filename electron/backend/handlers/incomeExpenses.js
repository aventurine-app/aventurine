'use strict';

// Cash Flow (Income & Expenses) blueprint. Shares its validation helpers with
// the year-table factory via validate.js.
//
// Sync is per-table: a (year, category) pair in category_sync means that cell's
// monthly value is computed from transactions instead of hand-entered. See
// categorySync.js.

const { bad, parseEntry, validateYear, VALID_MONTHS, monthNumber, monthName } = require('../validate');
const { syncedMap, isSynced } = require('../categorySync');

const NULL_SYNC_KEYS = { income: 'uncat_income', expense: 'uncat_expense' };

function columnsPayload(db) {
  return db
    .prepare('SELECT * FROM categories ORDER BY position')
    .all()
    .map((c) => ({ key: c.key, label: c.name, type: c.cat_type }));
}

/** The category key a transaction feeds: its category's key, or one of the two
 *  uncategorized buckets (by tx_type) for NULL-category rows. */
function txKey(t, keyById) {
  if (t.category_id == null) {
    return NULL_SYNC_KEYS[(t.tx_type ?? 'expense') === 'income' ? 'income' : 'expense'];
  }
  return keyById.get(t.category_id);
}

/**
 * Aggregate Transactions into {yearStr -> {month -> {catKey -> sum}}} for the
 * (year, category) cells that are synced. A transaction contributes only when
 * its own year + target category key is in category_sync.
 */
function syncSums(db) {
  const sums = {};
  const synced = syncedMap(db);
  if (!Object.keys(synced).length) return sums;

  const keyById = new Map(
    db.prepare('SELECT id, "key" FROM categories').all().map((c) => [c.id, c.key])
  );

  for (const t of db.prepare('SELECT * FROM transactions').all()) {
    if (!t.date) continue;
    const yearStr = t.date.slice(0, 4);
    const key = txKey(t, keyById);
    if (!key || !synced[yearStr]?.has(key)) continue;
    const monthName = VALID_MONTHS[parseInt(t.date.slice(5, 7), 10) - 1];
    const months = (sums[yearStr] ??= {});
    const cells = (months[monthName] ??= {});
    cells[key] = (cells[key] || 0) + t.amount;
  }
  return sums;
}

function dataGet(ctx) {
  const db = ctx.db();
  const synced = syncedMap(db);

  const entries = {};
  for (const e of db.prepare('SELECT * FROM entries').all()) {
    // A synced cell ignores any stored manual value — it follows transactions.
    if (synced[String(e.year)]?.has(e.category)) continue;
    const months = (entries[String(e.year)] ??= {});
    // Stored as 1-12; the response (and the renderer) key cells by month name.
    (months[monthName(e.month)] ??= {})[e.category] = e.value;
  }

  const sums = syncSums(db);
  for (const [yearStr, months] of Object.entries(sums)) {
    for (const [month, cells] of Object.entries(months)) {
      const target = ((entries[yearStr] ??= {})[month] ??= {});
      Object.assign(target, cells);
    }
  }

  const years = db.prepare('SELECT year FROM active_years').all().map((y) => y.year);

  // Synced cells, per year, for the renderer (read-only vs editable per table).
  const syncPayload = {};
  for (const [yearStr, set] of Object.entries(synced)) syncPayload[yearStr] = [...set];

  return {
    years: years.sort((a, b) => a - b),
    entries,
    columns: columnsPayload(db),
    sync: syncPayload,
  };
}

function entryUpsert(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body);
  if (isSynced(db, parsed.year, parsed.category)) {
    bad('category is in sync mode; edit transactions instead', 409);
  }
  db.prepare(
    `INSERT INTO entries (year, month, category, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month, category) DO UPDATE SET value = excluded.value`
  ).run(parsed.year, monthNumber(parsed.month), parsed.category, parsed.value);
  return { ok: true };
}

function entryDelete(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body, { requireValue: false });
  if (isSynced(db, parsed.year, parsed.category)) {
    bad('category is in sync mode; edit transactions instead', 409);
  }
  db.prepare('DELETE FROM entries WHERE year = ? AND month = ? AND category = ?').run(
    parsed.year,
    monthNumber(parsed.month),
    parsed.category
  );
  return { ok: true };
}

function yearAdd(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');
  const year = body.year;
  if (!validateYear(year)) bad('invalid year');
  db.transaction(() => {
    const info = db.prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)').run(year);
    // A newly created year-table defaults to fully synced: every category is
    // computed from transactions, so the user opts cells OUT rather than IN.
    // Guard on `info.changes` so re-posting an existing year is a no-op and
    // never silently re-syncs categories the user had already turned off.
    if (info.changes > 0) {
      db.prepare(
        'INSERT OR IGNORE INTO category_sync (year, category) SELECT ?, "key" FROM categories'
      ).run(year);
    }
  })();
  return { ok: true, year };
}

function yearDelete(ctx, { params }) {
  const db = ctx.db();
  db.transaction(() => {
    db.prepare('DELETE FROM active_years WHERE year = ?').run(params.year);
    db.prepare('DELETE FROM entries WHERE year = ?').run(params.year);
    db.prepare('DELETE FROM category_sync WHERE year = ?').run(params.year);
  })();
  return { ok: true };
}

function yearDuplicate(ctx, { params, body }) {
  const db = ctx.db();
  const target = (body || {}).target_year;
  if (!validateYear(target)) bad('invalid target_year');
  if (db.prepare('SELECT 1 FROM active_years WHERE year = ?').get(target)) {
    bad('year already exists');
  }
  db.transaction(() => {
    db.prepare('INSERT INTO active_years (year) VALUES (?)').run(target);
    // Copy manual entries and the per-table sync config so the duplicate is a
    // faithful copy; synced cells then recompute from the target year's data.
    db.prepare(
      `INSERT INTO entries (year, month, category, value)
       SELECT ?, month, category, value FROM entries WHERE year = ?`
    ).run(target, params.year);
    db.prepare(
      `INSERT INTO category_sync (year, category)
       SELECT ?, category FROM category_sync WHERE year = ?`
    ).run(target, params.year);
  })();
  return { ok: true, year: target };
}

/**
 * Toggle sync for a year-table. Body is either { category, sync } for a single
 * category or { all: true, sync } to apply to every category at once. Only
 * active years can be configured.
 */
function syncSet(ctx, { params, body }) {
  const db = ctx.db();
  const data = body || {};
  if (typeof data.sync !== 'boolean') bad('sync must be boolean');
  if (!db.prepare('SELECT 1 FROM active_years WHERE year = ?').get(params.year)) {
    bad('unknown year', 404);
  }

  const ins = db.prepare(
    'INSERT OR IGNORE INTO category_sync (year, category) VALUES (?, ?)'
  );
  const del = db.prepare('DELETE FROM category_sync WHERE year = ? AND category = ?');
  const apply = (key) => (data.sync ? ins.run(params.year, key) : del.run(params.year, key));

  if (data.all === true) {
    const keys = db.prepare('SELECT "key" FROM categories').all().map((c) => c.key);
    db.transaction(() => keys.forEach(apply))();
  } else {
    const key = data.category;
    if (!db.prepare('SELECT 1 FROM categories WHERE "key" = ?').get(key)) {
      bad('unknown category');
    }
    apply(key);
  }
  return { ok: true };
}

const routes = [
  ['GET', '/api/data', dataGet],
  ['POST', '/api/entry', entryUpsert],
  ['DELETE', '/api/entry', entryDelete],
  ['POST', '/api/year', yearAdd],
  ['DELETE', '/api/year/<int:year>', yearDelete],
  ['POST', '/api/year/<int:year>/duplicate', yearDuplicate],
  ['POST', '/api/year/<int:year>/sync', syncSet],
];

module.exports = { routes, syncSums };
