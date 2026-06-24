'use strict';

// Transactions blueprint — port of routes/transactions.py, plus the
// post-migration export endpoint (no Python ancestor).

const fs = require('fs');
const path = require('path');

const { bad, parseIsoDate, isFiniteNumber } = require('../validate');
const { normalisePath } = require('./database');
const { EXPORT_FORMATS, exportHeader, exportBody, exportFooter } = require('../services/txExport');
const {
  serialiseTx,
  applyTxFields,
  insertTx,
  updateTx,
  newTx,
} = require('../services/transactions');
const { serialiseCategory } = require('../services/categories');
const {
  recordMatch,
  forgetMatch,
  applyAutoMatch,
  sequenceRatio,
  getFuzzyThreshold,
} = require('../services/matchRules');

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

// Lightweight count of still-uncategorized rows, for the sidebar badge. Kept
// separate from list() so every page can poll it without pulling the whole
// ledger across IPC.
function uncategorizedCount(ctx) {
  const db = ctx.db();
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')
    .get();
  return { count: n };
}

function create(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const t = newTx();
  const err = applyTxFields(db, t, data, { requireAll: true });
  if (err) bad(err);
  db.transaction(() => {
    // Learn from an explicit assignment; otherwise try the learned rules.
    // Auto-matched rows never feed back into recordMatch — only direct user
    // decisions create rules.
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
    // Only a payload that touches category_id is a categorization decision:
    // assigning learns/updates the rule for this description, while
    // explicitly clearing the category retracts it.
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

function similar(ctx, { query }) {
  const db = ctx.db();
  const rawDesc = (query.description || '').trim();
  const excludeId = query.exclude_id != null ? parseInt(query.exclude_id, 10) : NaN;
  if (!rawDesc) return { transactions: [] };

  // The single match-strength slider (tx_fuzzy_threshold) drives this: 1.0 means
  // exact (case-insensitive) only; any value below it is a fuzzy SequenceMatcher
  // bar. (The unattended auto-match bar stays fixed — see services/matchRules.js.)
  const threshold = getFuzzyThreshold(db);
  const needle = rawDesc.toLowerCase();
  let rows;
  if (threshold < 1) {
    // Pull all uncategorized rows and filter in JS — same as the Python
    // difflib pass; the uncategorized set is usually small.
    rows = db
      .prepare(
        'SELECT * FROM transactions WHERE category_id IS NULL ORDER BY date DESC, id DESC'
      )
      .all()
      .filter(
        (t) => sequenceRatio(needle, (t.description || '').toLowerCase()) >= threshold
      );
  } else {
    rows = db
      .prepare(
        `SELECT * FROM transactions
          WHERE category_id IS NULL AND lower(description) = ?
          ORDER BY date DESC, id DESC`
      )
      .all(needle);
  }
  if (Number.isInteger(excludeId)) {
    rows = rows.filter((t) => t.id !== excludeId);
  }
  return { transactions: rows.map((t) => serialiseTx(t)) };
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

  // Only rows that are still uncategorized at commit time; tx_type derives
  // from the category — direction is owned by Category.cat_type.
  const placeholders = ids.map(() => '?').join(',');
  const updated = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM transactions
          WHERE id IN (${placeholders}) AND category_id IS NULL`
      )
      .all(...ids);
    const upd = db.prepare(
      'UPDATE transactions SET category_id = ?, tx_type = ? WHERE id = ?'
    );
    for (const t of rows) {
      upd.run(categoryId, cat.cat_type, t.id);
      // The user confirmed each of these rows in the Categorize Similar
      // dialog, so every description is a learned rule.
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

function importRows(ctx, { body }) {
  const db = ctx.db();
  const rows = (body || {}).rows;
  if (!Array.isArray(rows) || !rows.length) bad('rows must be a non-empty array');

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
    inserted.push(t);
  }

  // Imported rows arrive uncategorized; the learned rules categorize the
  // confident matches in one batch pass, then everything commits together.
  const autoCategorized = applyAutoMatch(db, inserted);
  if (inserted.length) {
    db.transaction(() => {
      for (const t of inserted) insertTx(db, t);
    })();
  }

  return {
    ok: true,
    inserted: inserted.length,
    skipped,
    auto_categorized: autoCategorized,
  };
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
const EXPORT_TX_TYPES = ['income', 'expense', 'savings', 'investing'];

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
      conds.push('instr(lower(t.description), ?) > 0');
      args.push(needle);
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
    if (!EXPORT_TX_TYPES.includes(filters.tx_type)) {
      bad(`filters.tx_type must be one of: ${EXPORT_TX_TYPES.join(', ')}`);
    }
    conds.push('COALESCE(c.cat_type, t.tx_type) = ?');
    args.push(filters.tx_type);
  }
  if ('category_id' in filters) {
    // Explicit null means "uncategorized only"; an absent key means no filter.
    if (filters.category_id === null) {
      conds.push('t.category_id IS NULL');
    } else if (Number.isInteger(filters.category_id)) {
      conds.push('t.category_id = ?');
      args.push(filters.category_id);
    } else {
      bad('filters.category_id must be an integer or null');
    }
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
  // Containment: confirm any export destination the renderer relayed without a
  // native dialog. Idempotent across the chunk loop — approved once, the
  // offset>0 appends pass straight through (see conn.authorizeWrite).
  ctx.authorizeWrite(dest);

  if (offset === 0) {
    // Same guard + error string as /api/db/create; the renderer retries
    // with overwrite:true after the user confirms.
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
  ['DELETE', '/api/transactions/<int:tx_id>', remove],
  ['GET', '/api/transactions/uncategorized-count', uncategorizedCount],
  ['GET', '/api/transactions/similar', similar],
  ['POST', '/api/transactions/categorize-similar', categorizeSimilar],
  ['GET', '/api/transactions/hashes', hashes],
  ['POST', '/api/transactions/import', importRows],
  ['POST', '/api/transactions/export', exportTx],
];

// EXPORT_CHUNK is exported so the chunk-protocol tests can build a ledger
// that spans more than one call without hard-coding the size twice.
module.exports = { routes, EXPORT_CHUNK };
