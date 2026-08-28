'use strict';

// Transactions blueprint — port of routes/transactions.py, plus the
// post-migration export endpoint (no Python ancestor).

const fs = require('fs');
const path = require('path');

const { bad, parseIsoDate, isFiniteNumber, validateYear, round2 } = require('../validate');
const { ensureActiveYear } = require('./incomeExpenses');
const { normalisePath } = require('./database');
const { EXPORT_FORMATS, exportHeader, exportBody, exportFooter } = require('../services/txExport');
const {
  serialiseTx,
  applyTxFields,
  insertTx,
  updateTx,
  newTx,
  accountExists,
} = require('../services/transactions');
const { serialiseCategory } = require('../services/categories');
const {
  recordMatch,
  forgetMatch,
  applyAutoMatch,
  sequenceRatio,
  FUZZY_THRESHOLD_MIN,
  FUZZY_THRESHOLD_MAX,
} = require('../services/matchRules');
const { applyBuiltinCategorize, applyDisplayNames } = require('../services/categorize');
const { adoptAccount } = require('../services/accounts');

function list(ctx) {
  const db = ctx.db();
  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC')
    .all();
  const cats = db.prepare('SELECT * FROM categories ORDER BY position').all();
  // Derive each row's direction from its category so rows written before a
  // category was re-typed still render with the category's current type.
  const catTypes = new Map(cats.map((c) => [c.id, c.cat_type]));
  return {
    transactions: rows.map((t) => serialiseTx(t, catTypes)),
    categories: cats.map(serialiseCategory),
  };
}

function create(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const t = newTx();
  const err = applyTxFields(db, t, data, { requireAll: true });
  if (err) bad(err);
  db.transaction(() => {
    // Record a rule for an explicit assignment; otherwise apply the existing
    // rules. Auto-matched rows are never passed to recordMatch — only direct
    // user assignments create rules.
    if (t.category_id != null) {
      recordMatch(db, t.description, t.category_id);
    } else {
      applyAutoMatch(db, [t]);
    }
    insertTx(db, t);
  })();
  return { ok: true, transaction: serialiseTx(t) };
}

function update(ctx, { params, body }) {
  const db = ctx.db();
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(params.tx_id);
  if (!t) bad('not found', 404);
  const data = body || {};
  const err = applyTxFields(db, t, data, { requireAll: false });
  if (err) bad(err);
  db.transaction(() => {
    // Only a payload containing category_id changes categorization: setting it
    // creates or updates the rule for this description, clearing it deletes
    // the rule.
    if ('category_id' in data) {
      if (t.category_id != null) {
        recordMatch(db, t.description, t.category_id);
      } else {
        forgetMatch(db, t.description);
      }
    }
    updateTx(db, t);
  })();
  return { ok: true, transaction: serialiseTx(t) };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  const t = db.prepare('SELECT id FROM transactions WHERE id = ?').get(params.tx_id);
  if (!t) bad('not found', 404);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id);
  return { ok: true };
}

// Delete every transaction. Scoped to the transactions table only — categories,
// learned match rules, balance-sheet entries and everything else are left
// unchanged. Guarded on the frontend by a type-to-confirm dialog (settings.js).
// Returns the number of rows removed so the UI can report it.
function removeAll(ctx) {
  const db = ctx.db();
  const info = db.prepare('DELETE FROM transactions').run();
  return { ok: true, deleted: info.changes };
}

function similar(ctx, { query }) {
  const db = ctx.db();
  const rawDesc = (query.description || '').trim();
  if (!rawDesc) return { transactions: [] };

  // Match strength arrives per request (the wizard's slider): 1.0 means exact
  // (case-insensitive) only; any lower value is a fuzzy SequenceMatcher
  // threshold. Missing or non-numeric values fall back to exact. (The
  // unattended auto-match threshold is fixed — see services/matchRules.js.)
  let threshold = Number(query.threshold);
  if (!Number.isFinite(threshold)) threshold = 1;
  threshold = Math.min(FUZZY_THRESHOLD_MAX, Math.max(FUZZY_THRESHOLD_MIN, threshold));

  // By default only uncategorized rows are candidates; include_categorized=1
  // (the cascade flow) widens the set to every transaction.
  const includeCategorized = query.include_categorized === '1';
  const catFilter = includeCategorized ? '' : ' AND category_id IS NULL';

  // exclude_ids: comma-separated ids to leave out (the rows being edited);
  // exclude_id is the original single-id spelling, still honoured.
  const exclude = new Set(
    `${query.exclude_ids || ''},${query.exclude_id || ''}`
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n))
  );

  const needle = rawDesc.toLowerCase();
  let rows;
  if (threshold < 1) {
    // Pull the candidate rows and filter in JS — same as the Python difflib
    // pass; the candidate set is small at personal-ledger scale.
    rows = db
      .prepare(
        `SELECT * FROM transactions WHERE 1=1${catFilter} ORDER BY date DESC, id DESC`
      )
      .all()
      .filter(
        (t) => sequenceRatio(needle, (t.description || '').toLowerCase()) >= threshold
      );
  } else {
    rows = db
      .prepare(
        `SELECT * FROM transactions
          WHERE lower(description) = ?${catFilter}
          ORDER BY date DESC, id DESC`
      )
      .all(needle);
  }
  rows = rows.filter((t) => !exclude.has(t.id));
  // Derive direction from the category, same as list() — the widened pool can
  // return categorized rows whose stored tx_type predates a category re-type.
  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  return { transactions: rows.map((t) => serialiseTx(t, catTypes)) };
}

function categorizeSimilar(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const ids = data.ids ?? [];
  const categoryId = data.category_id;

  if (!Array.isArray(ids) || !ids.length) bad('ids must be a non-empty array');
  if (typeof categoryId !== 'number' || !Number.isInteger(categoryId)) {
    bad('category_id must be an integer');
  }
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  if (!cat) bad('unknown category_id');

  // By default only rows still uncategorized at commit time are updated;
  // overwrite:true (the cascade flow, where the user confirmed each row) also
  // recategorizes rows that already had a category. tx_type is derived from
  // Category.cat_type.
  const catGuard = data.overwrite === true ? '' : ' AND category_id IS NULL';
  const placeholders = ids.map(() => '?').join(',');
  const updated = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM transactions
          WHERE id IN (${placeholders})${catGuard}`
      )
      .all(...ids);
    const upd = db.prepare(
      'UPDATE transactions SET category_id = ?, tx_type = ? WHERE id = ?'
    );
    for (const t of rows) {
      upd.run(categoryId, cat.cat_type, t.id);
      // The user confirmed each of these rows in the Categorize Similar
      // dialog, so each description becomes a rule.
      recordMatch(db, t.description, categoryId);
    }
    return rows.length;
  })();
  return { ok: true, updated };
}

function hashes(ctx, { query }) {
  const db = ctx.db();
  let sql = 'SELECT date, amount, description FROM transactions';
  const args = [];
  const since = query.since ? parseIsoDate(query.since) : null;
  if (since) {
    sql += ' WHERE date >= ?';
    args.push(since);
  }
  const rows = db.prepare(sql).all(...args);
  return {
    hashes: rows.map(
      (t) => `${t.date}|${t.amount.toFixed(2)}|${(t.description || '').toLowerCase().trim()}`
    ),
  };
}

const BALANCE_SOURCES = new Set(['file', 'ofx']);

/**
 * Validate the optional `balances` array an import may carry — the month-end
 * account balances read from the statement (a mapped CSV/XLSX balance column or
 * an OFX <LEDGERBAL>). Each raw item is { account_key, date, value, source };
 * the (year, month) the reading lands in is DERIVED from its date here, never
 * trusted from the client, so a cell only ever fills the month its reading
 * actually falls in. Unknown accounts and malformed items are dropped (the
 * transactions still import) rather than failing the whole import. Returns the
 * clean, cents-rounded rows ready to upsert.
 */
function validateBalances(db, raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) bad('balances must be an array');
  if (!raw.length) return [];

  const known = new Set(
    db.prepare('SELECT "key" FROM balance_columns').all().map((c) => c.key)
  );
  const clean = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (typeof b.account_key !== 'string' || !known.has(b.account_key)) continue;
    const date = parseIsoDate(b.date);
    if (!date) continue;
    if (!isFiniteNumber(b.value)) continue;
    if (!BALANCE_SOURCES.has(b.source)) continue;
    const year = parseInt(date.slice(0, 4), 10);
    const month = parseInt(date.slice(5, 7), 10);
    if (!validateYear(year)) continue;
    clean.push({ account_key: b.account_key, year, month, date, value: round2(b.value), source: b.source });
  }
  return clean;
}

function importRows(ctx, { body }) {
  const db = ctx.db();
  const rows = (body || {}).rows;
  if (!Array.isArray(rows) || !rows.length) bad('rows must be a non-empty array');

  // A dry run runs the exact same row-building + categorization passes below
  // (both read-only against the DB) but skips the transaction() block that
  // actually persists anything — so the caller can show "here's what we
  // found" (including the categorizer's real uncategorized count) BEFORE the
  // user commits to the import, with zero trace left if they back out.
  const dryRun = !!(body || {}).dry_run;
  const balances = dryRun ? [] : validateBalances(db, (body || {}).balances);

  // The account every row in this import belongs to; the UI always prompts for
  // it. A missing key is accepted (imports predating this, or a caller that
  // omits it) and leaves the rows unassigned rather than failing the import. An
  // explicit key matching no account IS an error, so a typo does not drop the
  // association without notice.
  const rawAccount = (body || {}).account_key;
  let accountKey = null;
  if (rawAccount != null) {
    if (typeof rawAccount !== 'string' || !accountExists(db, rawAccount)) bad('unknown account_key');
    accountKey = rawAccount;
  }

  const inserted = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      skipped.push({ row: i, reason: 'invalid row format' });
      continue;
    }
    const t = newTx();
    const err = applyTxFields(db, t, row, { requireAll: true });
    if (err) {
      skipped.push({ row: i, reason: err });
      continue;
    }
    t.account_key = accountKey;
    inserted.push(t);
  }

  // Imported rows arrive uncategorized. Two batch passes categorize the
  // confident ones, then everything commits together. Order matters: the user's
  // learned rules run first and take priority, then the built-in lexicon fills
  // in still-uncategorized rows. Both skip already-categorized rows, so the
  // second never overwrites the first. Neither pass writes to the DB (they read
  // match_rules/categories only), so both are safe to run for a dry run.
  const autoCategorized =
    applyAutoMatch(db, inserted) + applyBuiltinCategorize(db, inserted);
  // Third pass: clean display names for rows the merchant lexicon matches
  // (dictionary lookup only — the raw description is stored unchanged and the
  // ledger keeps it one click away). Hand-entered rows get no display name.
  applyDisplayNames(db, inserted);
  let accountAdopted = false;
  if (!dryRun && (inserted.length || balances.length)) {
    db.transaction(() => {
      // Adopting the target account happens HERE, at the storage boundary,
      // rather than in the importer UI: an import landing in a starter account
      // is what adopts it, and doing it server-side means no caller can insert
      // rows into an account that stays hidden. Picking one in a picker and then
      // abandoning the import adopts nothing.
      if (accountKey) accountAdopted = adoptAccount(db, accountKey);

      for (const t of inserted) insertTx(db, t);

      // Write each imported month-end balance into the Balance Sheet as
      // ordinary, hand-editable data (a balance_entries cell), not a separate
      // synced or computed layer. Automating the Balance Sheet as a derived
      // layer was attempted twice and abandoned; instead an import seeds the
      // cells, and afterwards they work like any value the user typed (edit,
      // clear, override). One reading per (account, year, month) from
      // deriveBalances; a re-import overwrites the cell with the newer file.
      const upsertBalance = db.prepare(
        `INSERT INTO balance_entries (year, month, category, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year, month, category) DO UPDATE SET value = excluded.value`
      );
      for (const b of balances) upsertBalance.run(b.year, b.month, b.account_key, b.value);

      // Auto-create the Cash Flow *and* Balance Sheet year-tables for every year
      // this import touches (transaction years and balance-reading years alike),
      // so imported history feeds the statement, Report Card, and Dashboard with zero
      // configuration (Cash Flow cells compute from transactions by default,
      // Balance Sheet cells seeded from these readings) and both /statements tabs
      // stay in step — a year that appears in one must appear in the other.
      const ensureBalanceYear = db.prepare(
        'INSERT OR IGNORE INTO balance_active_years (year) VALUES (?)'
      );
      const touchedYears = new Set([
        ...inserted.map((t) => parseInt(t.date.slice(0, 4), 10)),
        ...balances.map((b) => b.year),
      ]);
      for (const year of touchedYears) {
        if (validateYear(year)) {
          ensureActiveYear(db, year);
          ensureBalanceYear.run(year);
        }
      }
    })();
  }

  return {
    ok: true,
    dry_run: dryRun,
    inserted: dryRun ? 0 : inserted.length,
    would_insert: inserted.length,
    skipped,
    auto_categorized: autoCategorized,
    balances_applied: dryRun ? 0 : balances.length,
    account_adopted: accountAdopted,
    found: summariseImport(db, inserted),
  };
}

/**
 * Summary of a just-committed import: the period it covers, its totals by
 * direction, and the per-category counts. This is what the import-results screen
 * shows instead of a bare row count. Read off the rows just inserted (they
 * carry the category the three categorization passes assigned), so it needs no
 * extra query.
 *
 * Amounts are stored as magnitudes with the direction in tx_type, so every total
 * here is positive; `uncategorized` counts the rows no tier categorized, which
 * the user fills in from the ledger.
 */
function summariseImport(db, inserted) {
  const found = {
    date_from: null, date_to: null,
    income: 0, expense: 0, transfer: 0,
    categories: [], uncategorized: 0,
  };
  if (!inserted.length) return found;

  const names = new Map();
  for (const c of db.prepare('SELECT id, "key", name, cat_type FROM categories').all()) {
    names.set(c.id, c);
  }

  const byCat = new Map();
  for (const t of inserted) {
    if (found.date_from === null || t.date < found.date_from) found.date_from = t.date;
    if (found.date_to === null || t.date > found.date_to) found.date_to = t.date;
    found[t.tx_type] = round2(found[t.tx_type] + t.amount);

    if (t.category_id == null) { found.uncategorized++; continue; }
    const cat = names.get(t.category_id);
    if (!cat) { found.uncategorized++; continue; }
    const acc = byCat.get(cat.id) || { key: cat.key, name: cat.name, cat_type: cat.cat_type, count: 0, total: 0 };
    acc.count++;
    acc.total = round2(acc.total + t.amount);
    byCat.set(cat.id, acc);
  }

  // Biggest first: the rundown is a "does this look right?" check, and the
  // categories carrying the most money are the ones worth checking.
  found.categories = [...byCat.values()].sort((a, b) => b.total - a.total);
  return found;
}

// ── Export ────────────────────────────────────────────────────────────────
// Chunked, client-driven, stateless: the renderer POSTs {path, format,
// offset} repeatedly; offset 0 writes the format header plus the first chunk
// to <path>.part, later calls append, and the final chunk appends the footer
// and renames <path>.part into place — so a half-finished export never
// masquerades as a complete file. The chunking exists so the renderer's
// progress bar tracks rows actually written, not an animation.
const EXPORT_CHUNK = 500;

// Optional `filters` body field — the Transactions Search bar exports the
// rows the user is looking at, not the whole ledger. Conditions reference
// the t/c aliases of the export queries' LEFT JOIN; tx_type compares the
// DERIVED direction (COALESCE(c.cat_type, t.tx_type)), the same rule list()
// and the renderer use, so the file matches what the table shows.
const EXPORT_TX_TYPES = ['income', 'expense', 'transfer'];

// tx_type / category_id / account_key each accept either a single value (the
// shape a one-pick filter has always sent) or a LIST of them OR-ed together —
// those three chips are multi-select. An empty list is rejected rather than
// read as "no filter": a filter with nothing picked must never quietly widen
// the export to the whole ledger.
function filterList(value, field) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) bad(`filters.${field} must not be an empty list`);
  return list;
}

// `t.<col> IN (?, ?)` — or the bare `= ?` when there is only one value.
function inClause(col, values) {
  return values.length === 1 ? `${col} = ?` : `${col} IN (${values.map(() => '?').join(', ')})`;
}

function exportFilterSql(filters) {
  if (filters == null) return { where: '', args: [] };
  if (typeof filters !== 'object' || Array.isArray(filters)) bad('filters must be an object');
  const conds = [];
  const args = [];
  if (filters.date_from != null) {
    const d = parseIsoDate(filters.date_from);
    if (!d) bad('filters.date_from must be an ISO date (YYYY-MM-DD)');
    conds.push('t.date >= ?');
    args.push(d);
  }
  if (filters.date_to != null) {
    const d = parseIsoDate(filters.date_to);
    if (!d) bad('filters.date_to must be an ISO date (YYYY-MM-DD)');
    conds.push('t.date <= ?');
    args.push(d);
  }
  if (filters.description != null) {
    if (typeof filters.description !== 'string') bad('filters.description must be a string');
    const needle = filters.description.trim().toLowerCase();
    if (needle) {
      // Match the raw description OR the clean display name — the table's
      // Name filter searches both, and the export must save what it shows.
      conds.push(
        "(instr(lower(t.description), ?) > 0 OR instr(lower(COALESCE(t.display_name, '')), ?) > 0)"
      );
      args.push(needle, needle);
    }
  }
  if (filters.amount_min != null) {
    if (!isFiniteNumber(filters.amount_min)) bad('filters.amount_min must be a number');
    conds.push('t.amount >= ?');
    args.push(filters.amount_min);
  }
  if (filters.amount_max != null) {
    if (!isFiniteNumber(filters.amount_max)) bad('filters.amount_max must be a number');
    conds.push('t.amount <= ?');
    args.push(filters.amount_max);
  }
  if (filters.tx_type != null) {
    const types = filterList(filters.tx_type, 'tx_type');
    for (const type of types) {
      if (!EXPORT_TX_TYPES.includes(type)) {
        bad(`filters.tx_type must be one of: ${EXPORT_TX_TYPES.join(', ')}`);
      }
    }
    conds.push(inClause('COALESCE(c.cat_type, t.tx_type)', types));
    args.push(...types);
  }
  if ('category_id' in filters) {
    // A null means "uncategorized"; an integer names one category; an absent
    // key means no filter. Mixing the two in a list is allowed — the
    // Uncategorized row is just another box in the chip's list.
    const ids = [];
    let anyNull = false;
    for (const value of filterList(filters.category_id, 'category_id')) {
      if (value === null) anyNull = true;
      else if (Number.isInteger(value)) ids.push(value);
      else bad('filters.category_id must be an integer or null');
    }
    const parts = [];
    if (ids.length) { parts.push(inClause('t.category_id', ids)); args.push(...ids); }
    if (anyNull) parts.push('t.category_id IS NULL');
    conds.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
  }
  if ('account_key' in filters) {
    // Same shape: a null means "unassigned" (no Balance Sheet account), a
    // string names one account, an absent key means no filter.
    const keys = [];
    let anyNull = false;
    for (const value of filterList(filters.account_key, 'account_key')) {
      if (value === null) anyNull = true;
      else if (typeof value === 'string') keys.push(value);
      else bad('filters.account_key must be a string or null');
    }
    const parts = [];
    if (keys.length) { parts.push(inClause('t.account_key', keys)); args.push(...keys); }
    if (anyNull) parts.push('t.account_key IS NULL');
    conds.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', args };
}

function exportTx(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};

  const format = data.format;
  if (!EXPORT_FORMATS.includes(format)) {
    bad(`format must be one of: ${EXPORT_FORMATS.join(', ')}`);
  }
  const offset = data.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) bad('offset must be a non-negative integer');
  // Stateless like the offset: the renderer re-sends the same filters with
  // every chunk, so each call rebuilds the identical WHERE clause.
  const { where, args } = exportFilterSql(data.filters);
  const dest = normalisePath(data.path);
  const part = dest + '.part';
  // Containment: confirm any export destination the renderer sent without a
  // native dialog. Idempotent across the chunk loop — once approved, the
  // offset>0 appends pass through (see conn.authorizeWrite).
  ctx.authorizeWrite(dest);

  if (offset === 0) {
    // Same guard and error string as /api/db/create; the renderer retries with
    // overwrite:true after the user confirms.
    if (!data.overwrite && fs.existsSync(dest)) {
      bad('A file already exists at that location', 409);
    }
  } else if (!fs.existsSync(part)) {
    bad('export not in progress — restart from offset 0');
  }

  // Oldest-first is the convention in bank export files. Direction is
  // re-derived from the category at read time, same as list().
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.description, t.amount, t.notes,
              COALESCE(c.cat_type, t.tx_type) AS tx_type,
              c.name AS category_name
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id${where}
        ORDER BY t.date, t.id
        LIMIT ? OFFSET ?`
    )
    .all(...args, EXPORT_CHUNK, offset);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id${where}`
    )
    .get(...args).n;
  const done = rows.length < EXPORT_CHUNK;

  // The OFX family needs the statement date range and a closing balance;
  // only the first and last calls write sections that use them. Both span
  // the filtered set, so a filtered export is self-consistent.
  let meta = null;
  if (offset === 0 || done) {
    const range = db
      .prepare(
        `SELECT MIN(t.date) AS lo, MAX(t.date) AS hi
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id${where}`
      )
      .get(...args);
    const bal = db
      .prepare(
        `SELECT SUM(CASE WHEN COALESCE(c.cat_type, t.tx_type) = 'income'
                         THEN t.amount ELSE -t.amount END) AS net
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id${where}`
      )
      .get(...args);
    meta = { firstDate: range.lo, lastDate: range.hi, balance: bal.net ?? 0, now: new Date() };
  }

  try {
    if (offset === 0) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(part, exportHeader(format, meta) + exportBody(format, rows));
    } else {
      fs.appendFileSync(part, exportBody(format, rows));
    }
    if (done) {
      fs.appendFileSync(part, exportFooter(format, meta));
      fs.renameSync(part, dest);
    }
  } catch (e) {
    try {
      fs.unlinkSync(part);
    } catch {
      // already gone / never created
    }
    bad(`Cannot write the export file: ${e.code || e.constructor.name}`);
  }

  const out = { ok: true, exported: offset + rows.length, total, done };
  if (done) out.path = dest;
  return out;
}

const routes = [
  ['GET', '/api/transactions', list],
  ['POST', '/api/transactions', create],
  ['PUT', '/api/transactions/<int:tx_id>', update],
  ['DELETE', '/api/transactions', removeAll],
  ['DELETE', '/api/transactions/<int:tx_id>', remove],
  ['GET', '/api/transactions/similar', similar],
  ['POST', '/api/transactions/categorize-similar', categorizeSimilar],
  ['GET', '/api/transactions/hashes', hashes],
  ['POST', '/api/transactions/import', importRows],
  ['POST', '/api/transactions/export', exportTx],
];

// EXPORT_CHUNK is exported so the chunk-protocol tests can build a ledger
// that spans more than one call without hard-coding the size twice.
module.exports = { routes, EXPORT_CHUNK };
