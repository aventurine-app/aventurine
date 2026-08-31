'use strict';

// Year-table feature factory — port of year_table.py. Three tables share an
// identical shape (a years table, an entries table, a columns table); this
// produces the 11 standard routes for one such feature. Currently used by
// Balance Sheet only, exactly like the Python factory.
//
// Table names come from this module's config, never from user input, so they
// are safe to interpolate into the SQL strings.

const { bad, cleanLabel, parseEntry, validateYear, monthNumber, monthName } = require('../validate');

function yearTableRoutes({
  prefix,
  yearTable,
  entryTable,
  colTable,
  typeOrder = null,
  columnKeyPrefix = 'col',
  hasHidden = false,
}) {
  const hasTypes = typeOrder !== null;
  const validTypes = hasTypes ? new Set(typeOrder) : null;

  // Columns the app shows. With `hasHidden`, unadopted starter accounts
  // (hidden = 1) are filtered out of every read path except the explicit
  // ?include_hidden=true listing the onboarding / import pickers use — they are
  // the one surface whose job is to offer a not-yet-adopted account.
  const visibleClause = hasHidden ? ' WHERE hidden = 0' : '';

  /** Position where a newly added column should land (mirror of _insert_pos):
   *  typeless append; typed lands at the end of its type group, falling back
   *  through earlier types so same-type columns stay contiguous.
   *
   *  Only VISIBLE columns are considered: unadopted starter accounts are not
   *  part of the display order, so they must not push a real column past its
   *  type group. Adopting one re-derives its position through here. */
  function insertPos(db, colType) {
    if (!hasTypes) {
      const last = db
        .prepare(`SELECT position FROM ${colTable}${visibleClause} ORDER BY position DESC`)
        .get();
      return last ? last.position + 1 : 0;
    }
    const where = hasHidden ? 'WHERE hidden = 0 AND col_type = ?' : 'WHERE col_type = ?';
    const lastOfType = (t) =>
      db
        .prepare(`SELECT position FROM ${colTable} ${where} ORDER BY position DESC`)
        .get(t);
    const lastSame = lastOfType(colType);
    if (lastSame) return lastSame.position + 1;
    const idx = typeOrder.indexOf(colType);
    for (const earlier of typeOrder.slice(0, idx).reverse()) {
      const last = lastOfType(earlier);
      if (last) return last.position + 1;
    }
    return 0;
  }

  /** Push unadopted starter accounts to positions at or after `from`, keeping
   *  their relative order. Called after a write that renumbers the visible
   *  columns from 0, so the two sets never collide on a position — hidden rows
   *  always sort after visible ones, and adoption re-derives a real position
   *  through insertPos anyway. No-op unless the feature has hidden columns. */
  function parkHidden(db, from) {
    if (!hasHidden) return;
    const hidden = db
      .prepare(`SELECT id FROM ${colTable} WHERE hidden = 1 ORDER BY position`)
      .all();
    const set = db.prepare(`UPDATE ${colTable} SET position = ? WHERE id = ?`);
    hidden.forEach((c, i) => set.run(from + i, c.id));
  }

  function columnPayload(col) {
    const d = { key: col.key, label: col.label };
    if (hasTypes) d.type = col.col_type;
    if (hasHidden) d.hidden = !!col.hidden;
    return d;
  }

  function apiData(ctx) {
    const db = ctx.db();
    const years = db
      .prepare(`SELECT year FROM ${yearTable}`)
      .all()
      .map((y) => y.year)
      .sort((a, b) => a - b);
    const entries = {};
    for (const e of db.prepare(`SELECT * FROM ${entryTable}`).all()) {
      const months = (entries[String(e.year)] ??= {});
      // Stored as 1-12; the response keys cells by month name.
      (months[monthName(e.month)] ??= {})[e.category] = e.value;
    }
    const cols = db.prepare(`SELECT * FROM ${colTable}${visibleClause} ORDER BY position`).all();
    return { years, entries, columns: cols.map(columnPayload) };
  }

  function apiUpsertEntry(ctx, { body }) {
    const db = ctx.db();
    const parsed = parseEntry(body);
    // This feature's cells name a column of ITS OWN colTable (balance_columns
    // for the Balance Sheet), not a Cash Flow category — which is why the check
    // lives in each caller rather than in the shared parseEntry. Write only; see
    // the note on the Cash Flow copy for why reads and deletes stay open.
    if (!db.prepare(`SELECT 1 FROM ${colTable} WHERE "key" = ?`).get(parsed.category)) {
      bad('unknown category');
    }
    db.prepare(
      `INSERT INTO ${entryTable} (year, month, category, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(year, month, category) DO UPDATE SET value = excluded.value`
    ).run(parsed.year, monthNumber(parsed.month), parsed.category, parsed.value);
    return { ok: true };
  }

  function apiDeleteEntry(ctx, { body }) {
    const db = ctx.db();
    const parsed = parseEntry(body, { requireValue: false });
    db.prepare(`DELETE FROM ${entryTable} WHERE year = ? AND month = ? AND category = ?`).run(
      parsed.year,
      monthNumber(parsed.month),
      parsed.category
    );
    return { ok: true };
  }

  function apiAddYear(ctx, { body }) {
    const db = ctx.db();
    if (!body) bad('invalid request');
    const year = body.year;
    if (!validateYear(year)) bad('invalid year');
    db.prepare(`INSERT OR IGNORE INTO ${yearTable} (year) VALUES (?)`).run(year);
    return { ok: true, year };
  }

  function apiDeleteYear(ctx, { params }) {
    const db = ctx.db();
    db.transaction(() => {
      db.prepare(`DELETE FROM ${yearTable} WHERE year = ?`).run(params.year);
      db.prepare(`DELETE FROM ${entryTable} WHERE year = ?`).run(params.year);
    })();
    return { ok: true };
  }

  function apiDuplicateYear(ctx, { params, body }) {
    const db = ctx.db();
    const target = (body || {}).target_year;
    if (!validateYear(target)) bad('invalid target_year');
    if (db.prepare(`SELECT 1 FROM ${yearTable} WHERE year = ?`).get(target)) {
      bad('year already exists');
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO ${yearTable} (year) VALUES (?)`).run(target);
      db.prepare(
        `INSERT INTO ${entryTable} (year, month, category, value)
         SELECT ?, month, category, value FROM ${entryTable} WHERE year = ?`
      ).run(target, params.year);
    })();
    return { ok: true, year: target };
  }

  /** Visible columns by default; ?include_hidden=true also lists unadopted
   *  starter accounts, for the pickers that exist to offer them. */
  function apiGetColumns(ctx, { query }) {
    const db = ctx.db();
    const all = hasHidden && query.include_hidden === 'true';
    const where = all ? '' : visibleClause;
    return db.prepare(`SELECT * FROM ${colTable}${where} ORDER BY position`).all().map(columnPayload);
  }

  function apiAddColumn(ctx, { body }) {
    const db = ctx.db();
    if (!body) bad('invalid request');
    const label = cleanLabel(body.label);
    if (!label) bad('label required');

    let colType = null;
    if (hasTypes) {
      colType = body.type;
      if (!validTypes.has(colType)) bad('invalid type');
    }

    const col = db.transaction(() => {
      const pos = insertPos(db, colType);
      // Shift later columns up to make room without violating the implicit
      // uniqueness of `position` within the type's run.
      db.prepare(`UPDATE ${colTable} SET position = position + 1 WHERE position >= ?`).run(pos);
      const info = hasTypes
        ? db
            .prepare(
              `INSERT INTO ${colTable} ("key", label, col_type, position) VALUES (?, ?, ?, ?)`
            )
            .run('__tmp__', label, colType, pos)
        : db
            .prepare(`INSERT INTO ${colTable} ("key", label, position) VALUES (?, ?, ?)`)
            .run('__tmp__', label, pos);
      const id = info.lastInsertRowid;
      db.prepare(`UPDATE ${colTable} SET "key" = ? WHERE id = ?`).run(
        `${columnKeyPrefix}_${id}`,
        id
      );
      return db.prepare(`SELECT * FROM ${colTable} WHERE id = ?`).get(id);
    })();
    return { ok: true, column: columnPayload(col) };
  }

  function apiUpdateColumn(ctx, { params, body }) {
    const db = ctx.db();
    const col = db.prepare(`SELECT * FROM ${colTable} WHERE "key" = ?`).get(params.key);
    if (!col) bad('not found', 404);
    if (!body) bad('invalid request');

    db.transaction(() => {
      if ('label' in body) {
        const label = cleanLabel(body.label);
        if (!label) bad('label required');
        db.prepare(`UPDATE ${colTable} SET label = ? WHERE id = ?`).run(label, col.id);
      }

      if (hasTypes && 'type' in body && body.type !== col.col_type) {
        const newType = body.type;
        if (!validTypes.has(newType)) bad('invalid type');
        // Park at -1, close the gap, then re-insert at the new group's tail —
        // same intermediate-state dance as the Python factory.
        const oldPos = col.position;
        db.prepare(`UPDATE ${colTable} SET position = -1 WHERE id = ?`).run(col.id);
        db.prepare(`UPDATE ${colTable} SET position = position - 1 WHERE position > ?`).run(
          oldPos
        );
        const pos = insertPos(db, newType);
        db.prepare(`UPDATE ${colTable} SET position = position + 1 WHERE position >= ?`).run(pos);
        db.prepare(`UPDATE ${colTable} SET col_type = ?, position = ? WHERE id = ?`).run(
          newType,
          pos,
          col.id
        );
      }
    })();
    return { ok: true };
  }

  function apiMoveColumn(ctx, { params, body }) {
    const db = ctx.db();
    const direction = (body || {}).direction;
    if (direction !== 'up' && direction !== 'down') bad('invalid direction');
    const col = db.prepare(`SELECT * FROM ${colTable} WHERE "key" = ?`).get(params.key);
    if (!col) bad('not found', 404);
    // The adjacent VISIBLE column, found by ordering rather than position ± 1:
    // unadopted starter accounts sit at arbitrary positions, so the arithmetic
    // form could "swap" a column with an account that isn't on screen.
    const dir = direction === 'up' ? { cmp: '<', order: 'DESC' } : { cmp: '>', order: 'ASC' };
    const neighbor = db
      .prepare(
        `SELECT * FROM ${colTable} WHERE position ${dir.cmp} ?` +
          (hasHidden ? ' AND hidden = 0' : '') +
          ` ORDER BY position ${dir.order} LIMIT 1`
      )
      .get(col.position);
    if (neighbor) {
      // Type-lock: a typed feature only swaps with same-type neighbors.
      if (hasTypes && neighbor.col_type !== col.col_type) return { ok: true };
      db.transaction(() => {
        db.prepare(`UPDATE ${colTable} SET position = ? WHERE id = ?`).run(col.position, neighbor.id);
        db.prepare(`UPDATE ${colTable} SET position = ? WHERE id = ?`).run(neighbor.position, col.id);
      })();
    }
    return { ok: true };
  }

  /** Apply an explicit full ordering (and, for typed features, per-column type
   *  assignment) in a single pass — the arbitrary repositioning that drag-and-
   *  drop produces, which the one-step `move` endpoint can't express.
   *
   *  body.order is [{ key, type? }, …] listing EVERY column exactly once in the
   *  desired order. We rewrite position 0..N-1 in that order and (for typed
   *  features) set col_type from each item, so a column can change both its slot
   *  and its type group in one drop. `position` carries no UNIQUE constraint, so
   *  sequential reassignment inside the transaction needs no parking dance. */
  function apiReorderColumns(ctx, { body }) {
    const db = ctx.db();
    if (!body || !Array.isArray(body.order)) bad('invalid request');
    // Every VISIBLE column: unadopted starter accounts are invisible to the UI
    // doing the dragging, so requiring them here would reject every reorder.
    const all = db.prepare(`SELECT * FROM ${colTable}${visibleClause}`).all();
    if (body.order.length !== all.length) bad('order must list every column');

    const known = new Set(all.map((c) => c.key));
    const seen = new Set();
    for (const item of body.order) {
      if (!item || !known.has(item.key)) bad('unknown column', 404);
      if (seen.has(item.key)) bad('duplicate column');
      seen.add(item.key);
      if (hasTypes && !validTypes.has(item.type)) bad('invalid type');
    }

    db.transaction(() => {
      body.order.forEach((item, i) => {
        if (hasTypes) {
          db.prepare(`UPDATE ${colTable} SET position = ?, col_type = ? WHERE "key" = ?`).run(
            i,
            item.type,
            item.key
          );
        } else {
          db.prepare(`UPDATE ${colTable} SET position = ? WHERE "key" = ?`).run(i, item.key);
        }
      });
      parkHidden(db, body.order.length);
    })();
    return { ok: true };
  }

  function apiDeleteColumn(ctx, { params, query }) {
    const db = ctx.db();
    const col = db.prepare(`SELECT * FROM ${colTable} WHERE "key" = ?`).get(params.key);
    if (!col) bad('not found', 404);
    const force = query.force === 'true';
    const hasData = !!db
      .prepare(`SELECT 1 FROM ${entryTable} WHERE category = ? LIMIT 1`)
      .get(params.key);
    if (hasData && !force) bad('has_data', 409);
    db.transaction(() => {
      if (force) db.prepare(`DELETE FROM ${entryTable} WHERE category = ?`).run(params.key);
      db.prepare(`DELETE FROM ${colTable} WHERE id = ?`).run(col.id);
      db.prepare(`UPDATE ${colTable} SET position = position - 1 WHERE position > ?`).run(
        col.position
      );
    })();
    return { ok: true };
  }

  return [
    ['GET', `${prefix}/data`, apiData],
    ['POST', `${prefix}/entry`, apiUpsertEntry],
    ['DELETE', `${prefix}/entry`, apiDeleteEntry],
    ['POST', `${prefix}/year`, apiAddYear],
    ['DELETE', `${prefix}/year/<int:year>`, apiDeleteYear],
    ['POST', `${prefix}/year/<int:year>/duplicate`, apiDuplicateYear],
    ['GET', `${prefix}/columns`, apiGetColumns],
    ['POST', `${prefix}/columns`, apiAddColumn],
    ['PUT', `${prefix}/columns/<key>`, apiUpdateColumn],
    ['POST', `${prefix}/columns/<key>/move`, apiMoveColumn],
    ['POST', `${prefix}/columns/reorder`, apiReorderColumns],
    ['DELETE', `${prefix}/columns/<key>`, apiDeleteColumn],
  ];
}

module.exports = { yearTableRoutes };
