'use strict';

// Credit Cards blueprint — port of routes/credit_cards.py. Cards store
// user-entered figures plus an optional link to ONE expense category; the
// derived stats hinge on that category's average monthly spend, computed here
// and shipped alongside so the client recomputes without another round trip.

const { bad, cleanLabel, isFiniteNumber, round2 } = require('../validate');
const { recentMonthlyAverage } = require('../services/creditCards');
const { syncedMap } = require('../categorySync');

function serialiseCard(c) {
  return {
    id: c.id,
    name: c.name,
    credit_limit: c.credit_limit,
    rewards_pct: c.rewards_pct,
    annual_fee: c.annual_fee,
    category_id: c.category_id,
  };
}

/**
 * {category_id -> average monthly spend} for every expense category. Data-source
 * rule matches /api/data, now per-(year, category): a synced cell's monthly
 * value comes from transactions ('uncat_expense' sums NULL-category expense
 * rows), a manual cell's from Entry. Cell maps are keyed year*100 + monthIndex —
 * numerically chronological.
 */
function monthlySpendByCategory(db) {
  const cats = db.prepare("SELECT * FROM categories WHERE cat_type = 'expense'").all();
  const totals = new Map(cats.map((c) => [c.id, new Map()]));
  const bump = (cells, key, amount) => cells.set(key, (cells.get(key) || 0) + amount);

  const synced = syncedMap(db);
  const isCellSynced = (yearStr, key) => !!synced[yearStr]?.has(key);
  const idByKey = new Map(cats.map((c) => [c.key, c.id]));
  const keyById = new Map(cats.map((c) => [c.id, c.key]));

  // Manual cells — stored Entry values for expense categories, skipping any
  // (year, category) that is synced (those follow transactions instead).
  for (const e of db.prepare('SELECT * FROM entries').all()) {
    const cid = idByKey.get(e.category);
    if (cid === undefined) continue; // not an expense category
    if (isCellSynced(String(e.year), e.category)) continue;
    // month is stored as 1-12; the cell key stays numerically chronological.
    bump(totals.get(cid), e.year * 100 + e.month, e.value);
  }

  // Synced cells — transactions. Categorized expense rows map by their category
  // key; NULL-category expense rows feed uncat_expense.
  for (const t of db.prepare('SELECT * FROM transactions').all()) {
    if (!t.date) continue;
    let key, cid;
    if (t.category_id == null) {
      if (t.tx_type !== 'expense') continue;
      key = 'uncat_expense';
      cid = idByKey.get('uncat_expense');
      if (cid === undefined) continue;
    } else {
      cid = t.category_id;
      key = keyById.get(cid);
      if (key === undefined) continue; // not an expense category
    }
    const yearStr = t.date.slice(0, 4);
    if (!isCellSynced(yearStr, key)) continue;
    const cellKey = parseInt(yearStr, 10) * 100 + parseInt(t.date.slice(5, 7), 10);
    bump(totals.get(cid), cellKey, t.amount);
  }

  const result = {};
  for (const [cid, cells] of totals) result[cid] = recentMonthlyAverage(cells);
  return result;
}

function data(ctx) {
  const db = ctx.db();
  const cats = db
    .prepare("SELECT * FROM categories WHERE cat_type = 'expense' ORDER BY position")
    .all();
  const spend = monthlySpendByCategory(db);
  const monthlySpend = {};
  for (const [cid, avg] of Object.entries(spend)) monthlySpend[cid] = round2(avg);
  return {
    cards: db.prepare('SELECT * FROM credit_cards').all().map(serialiseCard),
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    monthly_spend: monthlySpend,
  };
}

function create(ctx, { body }) {
  const db = ctx.db();
  // An empty JSON object is a valid create request — every field defaults.
  const data2 = body || {};
  const name = cleanLabel(data2.name ?? 'New Card') || 'New Card';
  const info = db
    .prepare(
      `INSERT INTO credit_cards (name, credit_limit, rewards_pct, annual_fee, category_id)
       VALUES (?, 0, 0, 0, NULL)`
    )
    .run(name);
  const card = db.prepare('SELECT * FROM credit_cards WHERE id = ?').get(info.lastInsertRowid);
  return { ok: true, card: serialiseCard(card) };
}

function update(ctx, { params, body }) {
  const db = ctx.db();
  const card = db.prepare('SELECT * FROM credit_cards WHERE id = ?').get(params.card_id);
  if (!card) bad('not found', 404);
  if (!body) bad('invalid request');

  if ('name' in body) {
    const name = cleanLabel(body.name);
    if (!name) bad('name required');
    card.name = name;
  }

  for (const field of ['credit_limit', 'annual_fee']) {
    if (field in body) {
      const value = body[field];
      if (!isFiniteNumber(value) || value < 0) bad(`invalid ${field}`);
      card[field] = round2(value);
    }
  }

  if ('rewards_pct' in body) {
    const value = body.rewards_pct;
    if (!isFiniteNumber(value) || value < 0 || value > 100) bad('invalid rewards_pct');
    card.rewards_pct = round2(value);
  }

  if ('category_id' in body) {
    const catId = body.category_id;
    if (catId === null) {
      card.category_id = null;
    } else {
      if (typeof catId !== 'number' || !Number.isInteger(catId)) bad('invalid category_id');
      const cat = db.prepare('SELECT cat_type FROM categories WHERE id = ?').get(catId);
      if (!cat) bad('category not found', 404);
      if (cat.cat_type !== 'expense') bad('category must be an expense category');
      card.category_id = catId;
    }
  }

  db.prepare(
    `UPDATE credit_cards
        SET name = ?, credit_limit = ?, rewards_pct = ?, annual_fee = ?, category_id = ?
      WHERE id = ?`
  ).run(card.name, card.credit_limit, card.rewards_pct, card.annual_fee, card.category_id, card.id);
  return { ok: true, card: serialiseCard(card) };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  const card = db.prepare('SELECT id FROM credit_cards WHERE id = ?').get(params.card_id);
  if (!card) bad('not found', 404);
  db.prepare('DELETE FROM credit_cards WHERE id = ?').run(card.id);
  return { ok: true };
}

const routes = [
  ['GET', '/api/credit-cards/data', data],
  ['POST', '/api/credit-cards', create],
  ['PUT', '/api/credit-cards/<int:card_id>', update],
  ['DELETE', '/api/credit-cards/<int:card_id>', remove],
];

module.exports = { routes };
