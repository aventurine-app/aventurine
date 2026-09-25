'use strict';

// Balance Sheet routes: the grid read and its columns. The year and cell routes
// it shares with Cash Flow come from yearTable.js.
//
// Balance Sheet columns double as the app's accounts, so they carry the
// starter-account `hidden` flag (see seed.js DEFAULT_BALANCE_COLUMNS): unadopted
// starter accounts (hidden = 1) are filtered out of every read path except the
// explicit ?include_hidden=true listing the onboarding / import pickers use.
// They are the one surface whose job is to offer a not-yet-adopted account.
//
// Every column has a type, and columns of one type stay contiguous in
// TYPE_ORDER.

const { bad, cleanLabel, monthName } = require('../validate');
const { yearEntryRoutes } = require('./yearTable');

const PREFIX = '/api/balance';
const TYPE_ORDER = ['cash', 'investment', 'retirement', 'debt'];
const VALID_TYPES = new Set(TYPE_ORDER);

/** Position where a newly added column should land: the end of its type group,
 *  falling back through earlier types so same-type columns stay contiguous.
 *
 *  Only VISIBLE columns are considered: unadopted starter accounts are not
 *  part of the display order, so they must not push a real column past its
 *  type group. Adopting one re-derives its position through here. */
function insertPos(db, colType) {
  const lastOfType = (t) =>
    db
      .prepare('SELECT position FROM balance_columns WHERE hidden = 0 AND col_type = ? ORDER BY position DESC')
      .get(t);
  const lastSame = lastOfType(colType);
  if (lastSame) return lastSame.position + 1;
  const idx = TYPE_ORDER.indexOf(colType);
  for (const earlier of TYPE_ORDER.slice(0, idx).reverse()) {
    const last = lastOfType(earlier);
    if (last) return last.position + 1;
  }
  return 0;
}

/** Push unadopted starter accounts to positions at or after `from`, keeping
 *  their relative order. Called after a write that renumbers the visible
 *  columns from 0, so the two sets never collide on a position: hidden rows
 *  always sort after visible ones, and adoption re-derives a real position
 *  through insertPos anyway. */
function parkHidden(db, from) {
  const hidden = db
    .prepare('SELECT id FROM balance_columns WHERE hidden = 1 ORDER BY position')
    .all();
  const set = db.prepare('UPDATE balance_columns SET position = ? WHERE id = ?');
  hidden.forEach((c, i) => set.run(from + i, c.id));
}

function columnPayload(col) {
  return { key: col.key, label: col.label, type: col.col_type, hidden: !!col.hidden };
}

function getData(ctx) {
  const db = ctx.db();
  const years = db
    .prepare('SELECT year FROM balance_active_years')
    .all()
    .map((y) => y.year)
    .sort((a, b) => a - b);
  const entries = {};
  for (const e of db.prepare('SELECT year, month, category, value FROM balance_entries').all()) {
    const months = (entries[String(e.year)] ??= {});
    // Stored as 1-12; the response keys cells by month name.
    (months[monthName(e.month)] ??= {})[e.category] = e.value;
  }
  const cols = db.prepare('SELECT * FROM balance_columns WHERE hidden = 0 ORDER BY position').all();
  return { years, entries, columns: cols.map(columnPayload) };
}

/** Visible columns by default; ?include_hidden=true also lists unadopted
 *  starter accounts, for the pickers that exist to offer them. */
function getColumns(ctx, { query }) {
  const db = ctx.db();
  const where = query.include_hidden === 'true' ? '' : ' WHERE hidden = 0';
  return db.prepare(`SELECT * FROM balance_columns${where} ORDER BY position`).all().map(columnPayload);
}

function addColumn(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');
  const label = cleanLabel(body.label);
  if (!label) bad('label required');
  const colType = body.type;
  if (!VALID_TYPES.has(colType)) bad('invalid type');

  const col = db.transaction(() => {
    const pos = insertPos(db, colType);
    // Shift later columns up to make room without violating the implicit
    // uniqueness of `position` within the type's run.
    db.prepare('UPDATE balance_columns SET position = position + 1 WHERE position >= ?').run(pos);
    const info = db
      .prepare('INSERT INTO balance_columns ("key", label, col_type, position) VALUES (?, ?, ?, ?)')
      .run('__tmp__', label, colType, pos);
    const id = info.lastInsertRowid;
    db.prepare('UPDATE balance_columns SET "key" = ? WHERE id = ?').run(`bcol_${id}`, id);
    return db.prepare('SELECT * FROM balance_columns WHERE id = ?').get(id);
  })();
  return { ok: true, column: columnPayload(col) };
}

function updateColumn(ctx, { params, body }) {
  const db = ctx.db();
  const col = db.prepare('SELECT * FROM balance_columns WHERE "key" = ?').get(params.key);
  if (!col) bad('not found', 404);
  if (!body) bad('invalid request');

  db.transaction(() => {
    if ('label' in body) {
      const label = cleanLabel(body.label);
      if (!label) bad('label required');
      db.prepare('UPDATE balance_columns SET label = ? WHERE id = ?').run(label, col.id);
    }

    if ('type' in body && body.type !== col.col_type) {
      const newType = body.type;
      if (!VALID_TYPES.has(newType)) bad('invalid type');
      // Park at -1, close the gap, then re-insert at the new group's tail.
      // The parking slot keeps the UNIQUE position constraint satisfied while
      // the rows either side of the gap shuffle.
      const oldPos = col.position;
      db.prepare('UPDATE balance_columns SET position = -1 WHERE id = ?').run(col.id);
      db.prepare('UPDATE balance_columns SET position = position - 1 WHERE position > ?').run(oldPos);
      const pos = insertPos(db, newType);
      db.prepare('UPDATE balance_columns SET position = position + 1 WHERE position >= ?').run(pos);
      db.prepare('UPDATE balance_columns SET col_type = ?, position = ? WHERE id = ?').run(
        newType,
        pos,
        col.id
      );
    }
  })();
  return { ok: true };
}

function moveColumn(ctx, { params, body }) {
  const db = ctx.db();
  const direction = (body || {}).direction;
  if (direction !== 'up' && direction !== 'down') bad('invalid direction');
  const col = db.prepare('SELECT * FROM balance_columns WHERE "key" = ?').get(params.key);
  if (!col) bad('not found', 404);
  // The adjacent VISIBLE column, found by ordering rather than position ± 1:
  // unadopted starter accounts sit at arbitrary positions, so the arithmetic
  // form could "swap" a column with an account that isn't on screen.
  const dir = direction === 'up' ? { cmp: '<', order: 'DESC' } : { cmp: '>', order: 'ASC' };
  const neighbor = db
    .prepare(
      `SELECT * FROM balance_columns WHERE position ${dir.cmp} ? AND hidden = 0
        ORDER BY position ${dir.order} LIMIT 1`
    )
    .get(col.position);
  // Type-lock: a column only swaps with a neighbor of its own type.
  if (neighbor && neighbor.col_type === col.col_type) {
    db.transaction(() => {
      db.prepare('UPDATE balance_columns SET position = ? WHERE id = ?').run(col.position, neighbor.id);
      db.prepare('UPDATE balance_columns SET position = ? WHERE id = ?').run(neighbor.position, col.id);
    })();
  }
  return { ok: true };
}

/** Apply an explicit full ordering and per-column type assignment in a single
 *  pass: the arbitrary repositioning that drag-and-drop produces, which the
 *  one-step `move` endpoint can't express.
 *
 *  body.order is [{ key, type }, …] listing EVERY visible column exactly once
 *  in the desired order. We rewrite position 0..N-1 in that order and set
 *  col_type from each item, so a column can change both its slot and its type
 *  group in one drop. `position` carries no UNIQUE constraint, so sequential
 *  reassignment inside the transaction needs no parking dance. */
function reorderColumns(ctx, { body }) {
  const db = ctx.db();
  if (!body || !Array.isArray(body.order)) bad('invalid request');
  // Every VISIBLE column: unadopted starter accounts are invisible to the UI
  // doing the dragging, so requiring them here would reject every reorder.
  const all = db.prepare('SELECT "key" FROM balance_columns WHERE hidden = 0').all();
  if (body.order.length !== all.length) bad('order must list every column');

  const known = new Set(all.map((c) => c.key));
  const seen = new Set();
  for (const item of body.order) {
    if (!item || !known.has(item.key)) bad('unknown column', 404);
    if (seen.has(item.key)) bad('duplicate column');
    seen.add(item.key);
    if (!VALID_TYPES.has(item.type)) bad('invalid type');
  }

  const set = db.prepare('UPDATE balance_columns SET position = ?, col_type = ? WHERE "key" = ?');
  db.transaction(() => {
    body.order.forEach((item, i) => set.run(i, item.type, item.key));
    parkHidden(db, body.order.length);
  })();
  return { ok: true };
}

function deleteColumn(ctx, { params, query }) {
  const db = ctx.db();
  const col = db.prepare('SELECT * FROM balance_columns WHERE "key" = ?').get(params.key);
  if (!col) bad('not found', 404);
  const force = query.force === 'true';
  const hasData = !!db
    .prepare('SELECT 1 FROM balance_entries WHERE category = ? LIMIT 1')
    .get(params.key);
  if (hasData && !force) bad('has_data', 409);
  db.transaction(() => {
    if (force) db.prepare('DELETE FROM balance_entries WHERE category = ?').run(params.key);
    db.prepare('DELETE FROM balance_columns WHERE id = ?').run(col.id);
    db.prepare('UPDATE balance_columns SET position = position - 1 WHERE position > ?').run(
      col.position
    );
  })();
  return { ok: true };
}

const routes = [
  ['GET', `${PREFIX}/data`, getData],
  ...yearEntryRoutes({
    prefix: PREFIX,
    yearTable: 'balance_active_years',
    entryTable: 'balance_entries',
    keyTable: 'balance_columns',
  }),
  ['GET', `${PREFIX}/columns`, getColumns],
  ['POST', `${PREFIX}/columns`, addColumn],
  ['PUT', `${PREFIX}/columns/<key>`, updateColumn],
  ['POST', `${PREFIX}/columns/<key>/move`, moveColumn],
  ['POST', `${PREFIX}/columns/reorder`, reorderColumns],
  ['DELETE', `${PREFIX}/columns/<key>`, deleteColumn],
];

module.exports = { routes };
