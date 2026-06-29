'use strict';

// Budget envelopes blueprint. A single recurring target per category
// (budget_amounts, schema v6) is compared against actual spending for the month
// being viewed, computed from transactions. The projection/assembly lives in
// services/budget.js; targets are global, so only the GET takes a (year, month)
// — to scope which month's actuals are shown.

const { bad, isFiniteNumber, validateYear, round2, VALID_MONTHS } = require('../validate');
const { isBudgetable, monthPrefix, buildBudget } = require('../services/budget');

/** Current local (year, monthName) — the default month for the view. */
function currentYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: VALID_MONTHS[d.getMonth()] };
}

/** Resolve ?year=&month= against sane defaults (independently). */
function resolveMonth(query) {
  const def = currentYearMonth();
  const y = parseInt(query.year, 10);
  const year = validateYear(y) ? y : def.year;
  const month = VALID_MONTHS.includes(query.month) ? query.month : def.month;
  return { year, month };
}

function budgetGet(ctx, { query }) {
  const db = ctx.db();
  const { year, month } = resolveMonth(query);
  const prefix = monthPrefix(year, month); // 'YYYY-MM' for matching tx dates

  const categories = db.prepare('SELECT * FROM categories ORDER BY position').all();

  // Recurring targets — one row per category, the same every month.
  const targets = new Map(
    db.prepare('SELECT category, amount FROM budget_amounts').all().map((r) => [r.category, r.amount])
  );

  // Actual spending per category for the viewed month (categorized rows only).
  const keyById = new Map(categories.map((c) => [c.id, c.key]));
  const actualByKey = new Map();
  for (const r of db
    .prepare(
      `SELECT category_id AS cid, SUM(amount) AS s
         FROM transactions
        WHERE substr(date, 1, 7) = ? AND category_id IS NOT NULL
        GROUP BY category_id`
    )
    .all(prefix)) {
    const key = keyById.get(r.cid);
    if (key) actualByKey.set(key, r.s);
  }

  // Income received in the viewed month (categorized income categories + rows
  // stored as income with no category). Surfaced only as a small reference.
  const received = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE substr(t.date, 1, 7) = ?
          AND ((t.category_id IS NOT NULL AND c.cat_type = 'income')
               OR (t.category_id IS NULL AND t.tx_type = 'income'))`
    )
    .get(prefix).total;

  const built = buildBudget({ categories, targets, actualByKey, received });
  return { ok: true, year, month, ...built };
}

/** Validate that a body names a budgetable category; returns the category row. */
function requireBudgetableCategory(db, key) {
  if (typeof key !== 'string' || !key || key.length > 100) bad('invalid category');
  const cat = db.prepare('SELECT * FROM categories WHERE "key" = ?').get(key);
  if (!cat || !isBudgetable(cat)) bad('not a budgetable category');
  return cat;
}

function targetUpsert(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  requireBudgetableCategory(db, data.category);
  if (!isFiniteNumber(data.value) || data.value < 0) bad('invalid value');
  db.prepare(
    `INSERT INTO budget_amounts (category, amount) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET amount = excluded.amount`
  ).run(data.category, round2(data.value));
  return { ok: true };
}

function targetDelete(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  if (typeof data.category !== 'string' || !data.category) bad('invalid category');
  db.prepare('DELETE FROM budget_amounts WHERE category = ?').run(data.category);
  return { ok: true };
}

const routes = [
  ['GET', '/api/budget', budgetGet],
  ['POST', '/api/budget/target', targetUpsert],
  ['DELETE', '/api/budget/target', targetDelete],
];

module.exports = { routes };
