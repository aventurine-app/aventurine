'use strict';

// Categories blueprint — port of routes/categories.py. Handlers are plain
// functions (ctx, {params, query, body}); ctx is the conn manager.

const { bad, cleanLabel } = require('../validate');
const { VALID_CAT_TYPES, VALID_FLEX_TYPES, serialiseCategory } = require('../services/categories');

function getCat(db, id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

function list(ctx) {
  const db = ctx.db();
  const cats = db.prepare('SELECT * FROM categories ORDER BY position').all();
  return { categories: cats.map(serialiseCategory) };
}

function create(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const name = cleanLabel(data.name);
  if (!name) bad('name required');
  if (!VALID_CAT_TYPES.includes(data.cat_type)) bad('invalid cat_type');
  // flex_type is optional on create; new categories default to 'flex'.
  const flexType = data.flex_type === undefined ? 'flex' : data.flex_type;
  if (!VALID_FLEX_TYPES.includes(flexType)) bad('invalid flex_type');
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) {
    bad('category already exists', 409);
  }

  const cat = db.transaction(() => {
    const nextPos =
      (db.prepare('SELECT MAX(position) AS m FROM categories').get().m ?? -1) + 1;
    const info = db
      .prepare(
        'INSERT INTO categories ("key", name, cat_type, position, flex_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run('__tmp__', name, data.cat_type, nextPos, flexType);
    const id = info.lastInsertRowid;
    // Stable key derived from the new row's id, so renames never orphan
    // Entry rows (mirror of the Flask flush-then-set-key dance).
    db.prepare('UPDATE categories SET "key" = ? WHERE id = ?').run(`cat_${id}`, id);
    return getCat(db, id);
  })();
  return { ok: true, category: serialiseCategory(cat) };
}

function update(ctx, { params, body }) {
  const db = ctx.db();
  const cat = getCat(db, params.cat_id);
  if (!cat) bad('not found', 404);
  const data = body || {};

  db.transaction(() => {
    if ('name' in data) {
      const name = cleanLabel(data.name);
      if (!name) bad('invalid name');
      const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
      if (existing && existing.id !== cat.id) bad('category already exists', 409);
      cat.name = name;
    }

    if ('cat_type' in data) {
      if (!VALID_CAT_TYPES.includes(data.cat_type)) bad('invalid cat_type');
      if (data.cat_type !== cat.cat_type) {
        cat.cat_type = data.cat_type;
        // Direction is owned by the category — re-type the transactions that
        // reference it so the stored copy never goes stale.
        db.prepare('UPDATE transactions SET tx_type = ? WHERE category_id = ?').run(
          cat.cat_type,
          cat.id
        );
      }
    }

    if ('position' in data) {
      if (typeof data.position !== 'number' || !Number.isInteger(data.position)) {
        bad('invalid position');
      }
      cat.position = data.position;
    }

    if ('flex_type' in data) {
      if (!VALID_FLEX_TYPES.includes(data.flex_type)) bad('invalid flex_type');
      cat.flex_type = data.flex_type;
    }

    db.prepare(
      'UPDATE categories SET name = ?, cat_type = ?, position = ?, flex_type = ? WHERE id = ?'
    ).run(cat.name, cat.cat_type, cat.position, cat.flex_type, cat.id);
  })();

  return { ok: true, category: serialiseCategory(cat) };
}

function move(ctx, { params, body }) {
  const db = ctx.db();
  const cat = getCat(db, params.cat_id);
  if (!cat) bad('not found', 404);
  const direction = (body || {}).direction;
  if (direction !== 'up' && direction !== 'down') bad('direction must be up or down');

  const delta = direction === 'up' ? -1 : 1;
  const neighbor = db
    .prepare('SELECT * FROM categories WHERE position = ?')
    .get(cat.position + delta);
  if (neighbor && neighbor.cat_type === cat.cat_type) {
    // Type-locked swap, atomically.
    db.transaction(() => {
      db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(cat.position, neighbor.id);
      db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(neighbor.position, cat.id);
    })();
  }
  return { ok: true };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  const cat = getCat(db, params.cat_id);
  if (!cat) bad('not found', 404);

  const txCount = db
    .prepare('SELECT COUNT(*) AS c FROM transactions WHERE category_id = ?')
    .get(cat.id).c;
  const entryCount = db
    .prepare('SELECT COUNT(*) AS c FROM entries WHERE category = ?')
    .get(cat.key).c;
  if (txCount || entryCount) {
    // The user must reassign or delete those rows first.
    bad('has_data', 409, { transactions: txCount, entries: entryCount });
  }

  db.transaction(() => {
    // Learned rules pointing at this category can never resurrect a deleted id.
    db.prepare('DELETE FROM match_rules WHERE category_id = ?').run(cat.id);
    // Credit cards merely reference the category for stats — unlink, don't block.
    db.prepare('UPDATE credit_cards SET category_id = NULL WHERE category_id = ?').run(cat.id);
    // Drop any per-table sync config for this category (keyed by its stable key).
    db.prepare('DELETE FROM category_sync WHERE category = ?').run(cat.key);
    // Drop this category's budget envelope (keyed by its stable key).
    db.prepare('DELETE FROM budget_amounts WHERE category = ?').run(cat.key);
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
    db.prepare('UPDATE categories SET position = position - 1 WHERE position > ?').run(
      cat.position
    );
  })();
  return { ok: true };
}

const routes = [
  ['GET', '/api/categories', list],
  ['POST', '/api/categories', create],
  ['PUT', '/api/categories/<int:cat_id>', update],
  ['POST', '/api/categories/<int:cat_id>/move', move],
  ['DELETE', '/api/categories/<int:cat_id>', remove],
];

module.exports = { routes, list, create, update, move, remove };
