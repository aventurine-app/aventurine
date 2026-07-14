'use strict';

// Cash Flow (Income & Expenses) blueprint. Shares its validation helpers with
// the year-table factory via validate.js.
//
// Data-source rule (per cell): every (year, month, category) cell of an active
// year is COMPUTED from transactions by default; a stored Entry OVERRIDES that
// one cell. There is no sync mode or per-category switch — typing in a cell
// claims it, deleting the entry releases it back to the computed value.

const { bad, parseEntry, validateYear, VALID_MONTHS, monthNumber, monthName } = require('../validate');

const NULL_KEYS = { income: 'uncat_income', expense: 'uncat_expense' };

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
    return NULL_KEYS[(t.tx_type ?? 'expense') === 'income' ? 'income' : 'expense'];
  }
  return keyById.get(t.category_id);
}

/**
 * Aggregate Transactions into {yearStr -> {month -> {catKey -> sum}}} for every
 * cell of every ACTIVE year — the computed layer every cell shows unless a
 * manual Entry overrides it. Years without a year-table contribute nothing
 * (deleting a year-table is how a user opts a year out of the statement).
 */
function computedCells(db) {
  const sums = {};
  const activeYears = new Set(
    db.prepare('SELECT year FROM active_years').all().map((y) => String(y.year))
  );
  if (!activeYears.size) return sums;

  const keyById = new Map(
    db.prepare('SELECT id, "key" FROM categories').all().map((c) => [c.id, c.key])
  );

  for (const t of db.prepare('SELECT * FROM transactions').all()) {
    if (!t.date) continue;
    const yearStr = t.date.slice(0, 4);
    if (!activeYears.has(yearStr)) continue;
    const key = txKey(t, keyById);
    if (!key) continue;
    const month = VALID_MONTHS[parseInt(t.date.slice(5, 7), 10) - 1];
    const months = (sums[yearStr] ??= {});
    const cells = (months[month] ??= {});
    cells[key] = (cells[key] || 0) + t.amount;
  }
  return sums;
}

/** Stored Entry rows as {yearStr -> {month -> {catKey -> value}}} — the manual
 *  per-cell overrides (and, for years/categories with no transactions, simply
 *  the hand-entered bookkeeping). */
function manualCells(db) {
  const manual = {};
  for (const e of db.prepare('SELECT * FROM entries').all()) {
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

function dataGet(ctx) {
  const db = ctx.db();
  const computed = computedCells(db);
  const manual = manualCells(db);

  const years = db.prepare('SELECT year FROM active_years').all().map((y) => y.year);

  // `entries` is the blended view (what every consumer renders); `computed`
  // and `manual` are the layers, shipped so the statement UI can style a
  // cell's provenance and show the computed shadow value under an override.
  return {
    years: years.sort((a, b) => a - b),
    entries: blendCells(computed, manual),
    computed,
    manual,
    columns: columnsPayload(db),
  };
}

function entryUpsert(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body);
  db.prepare(
    `INSERT INTO entries (year, month, category, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month, category) DO UPDATE SET value = excluded.value`
  ).run(parsed.year, monthNumber(parsed.month), parsed.category, parsed.value);
  return { ok: true };
}

function entryDelete(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body, { requireValue: false });
  db.prepare('DELETE FROM entries WHERE year = ? AND month = ? AND category = ?').run(
    parsed.year,
    monthNumber(parsed.month),
    parsed.category
  );
  return { ok: true };
}

/**
 * Ensure a Cash Flow year-table exists. Cells compute from transactions by
 * default, so creating the year is all it takes for that year's activity to
 * appear. Shared by the "+ year" endpoint and the transaction importer (an
 * import auto-creates the years it touches, so imported history feeds the
 * statement, Report Card, and Home with zero configuration). Returns true
 * when the year was created.
 */
function ensureActiveYear(db, year) {
  return db.prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)').run(year).changes > 0;
}

function yearAdd(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');
  const year = body.year;
  if (!validateYear(year)) bad('invalid year');
  ensureActiveYear(db, year);
  return { ok: true, year };
}

function yearDelete(ctx, { params }) {
  const db = ctx.db();
  db.transaction(() => {
    db.prepare('DELETE FROM active_years WHERE year = ?').run(params.year);
    db.prepare('DELETE FROM entries WHERE year = ?').run(params.year);
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
    // Copy the manual overrides; computed cells recompute from the target
    // year's own transactions.
    db.prepare(
      `INSERT INTO entries (year, month, category, value)
       SELECT ?, month, category, value FROM entries WHERE year = ?`
    ).run(target, params.year);
  })();
  return { ok: true, year: target };
}

const routes = [
  ['GET', '/api/data', dataGet],
  ['POST', '/api/entry', entryUpsert],
  ['DELETE', '/api/entry', entryDelete],
  ['POST', '/api/year', yearAdd],
  ['DELETE', '/api/year/<int:year>', yearDelete],
  ['POST', '/api/year/<int:year>/duplicate', yearDuplicate],
];

module.exports = { routes, computedCells, manualCells, blendCells, ensureActiveYear };
