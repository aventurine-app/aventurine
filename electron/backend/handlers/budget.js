'use strict';

// Budget Buckets (Account Tracking) blueprint. Per-month per-category targets
// (budget_targets, schema v3) compared against actual spending computed from
// transactions. Targets are validated/rounded with the same parseEntry helper
// the Cash Flow entries use; the projection/assembly is in services/budget.js.

const { bad, parseEntry, validateYear, isFiniteNumber, round2, VALID_MONTHS } = require('../validate');
const { isBudgetable, monthPrefix, buildBudget } = require('../services/budget');
const { monthlyTotals, trailingAverage } = require('../services/forecast');

// How many complete months of history feed the auto "expected income" average.
const INCOME_WINDOW = 6;

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
  const prefix = monthPrefix(year, month);

  const categories = db.prepare('SELECT * FROM categories ORDER BY position').all();

  const targets = new Map(
    db
      .prepare('SELECT category, amount FROM budget_targets WHERE year = ? AND month = ?')
      .all(year, month)
      .map((r) => [r.category, r.amount])
  );

  // Actual spending per category for the month (categorized rows only).
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

  // Resolved income per month across all history (categorized income categories
  // + null-category rows stored as income). Feeds both "received so far" (this
  // month) and the trailing-average "expected income" default.
  const incomeRows = db
    .prepare(
      `SELECT t.date AS date, t.amount AS amount
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE (t.category_id IS NOT NULL AND c.cat_type = 'income')
           OR (t.category_id IS NULL AND t.tx_type = 'income')`
    )
    .all();
  const incomeTotals = monthlyTotals(incomeRows, []);
  const received = incomeTotals[prefix] ? incomeTotals[prefix].income : 0;

  // Expected income: a per-month override if set, else the trailing average of
  // the complete months BEFORE this one (so "left to budget" is meaningful from
  // day 1 instead of climbing as paychecks arrive).
  const override = db
    .prepare('SELECT amount FROM budget_income WHERE year = ? AND month = ?')
    .get(year, month);
  let expectedIncome;
  let incomeSource;
  if (override) {
    expectedIncome = override.amount;
    incomeSource = 'override';
  } else {
    const avg = trailingAverage(incomeTotals, { today: `${prefix}-01`, window: INCOME_WINDOW });
    expectedIncome = round2(avg.avgIncome);
    incomeSource = 'average';
  }

  const built = buildBudget({ categories, targets, actualByKey, expectedIncome, incomeSource, received });
  return { ok: true, year, month, ...built };
}

/** Validate that a category key names a budgetable category; returns it. */
function requireBudgetableCategory(db, key) {
  const cat = db.prepare('SELECT * FROM categories WHERE "key" = ?').get(key);
  if (!cat || !isBudgetable(cat)) bad('not a budgetable category');
  return cat;
}

function targetUpsert(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body); // { year, month, category, value } with round2
  if (parsed.value < 0) bad('invalid value');
  requireBudgetableCategory(db, parsed.category);
  db.prepare(
    `INSERT INTO budget_targets (year, month, category, amount) VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month, category) DO UPDATE SET amount = excluded.amount`
  ).run(parsed.year, parsed.month, parsed.category, parsed.value);
  return { ok: true };
}

function targetDelete(ctx, { body }) {
  const db = ctx.db();
  const parsed = parseEntry(body, { requireValue: false });
  db.prepare('DELETE FROM budget_targets WHERE year = ? AND month = ? AND category = ?').run(
    parsed.year,
    parsed.month,
    parsed.category
  );
  return { ok: true };
}

function copyMonth(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const { from_year: fy, from_month: fm, to_year: ty, to_month: tm } = data;
  if (!validateYear(fy) || !validateYear(ty)) bad('invalid year');
  if (!VALID_MONTHS.includes(fm) || !VALID_MONTHS.includes(tm)) bad('invalid month');
  if (fy === ty && fm === tm) bad('source and target are the same month');

  const info = db
    .prepare(
      `INSERT INTO budget_targets (year, month, category, amount)
       SELECT ?, ?, category, amount FROM budget_targets WHERE year = ? AND month = ?
       ON CONFLICT(year, month, category) DO UPDATE SET amount = excluded.amount`
    )
    .run(ty, tm, fy, fm);
  return { ok: true, copied: info.changes };
}

/** Validate a (year, month) pair from a body; throws on bad input. */
function requireYearMonth(data) {
  if (!data || typeof data !== 'object') bad('invalid request');
  if (!validateYear(data.year)) bad('invalid year');
  if (!VALID_MONTHS.includes(data.month)) bad('invalid month');
}

function incomeUpsert(ctx, { body }) {
  const db = ctx.db();
  requireYearMonth(body);
  if (!isFiniteNumber(body.amount) || body.amount < 0) bad('invalid amount');
  db.prepare(
    `INSERT INTO budget_income (year, month, amount) VALUES (?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET amount = excluded.amount`
  ).run(body.year, body.month, round2(body.amount));
  return { ok: true };
}

function incomeDelete(ctx, { body }) {
  const db = ctx.db();
  requireYearMonth(body);
  db.prepare('DELETE FROM budget_income WHERE year = ? AND month = ?').run(body.year, body.month);
  return { ok: true };
}

const routes = [
  ['GET', '/api/budget', budgetGet],
  ['POST', '/api/budget/target', targetUpsert],
  ['DELETE', '/api/budget/target', targetDelete],
  ['POST', '/api/budget/copy', copyMonth],
  ['POST', '/api/budget/income', incomeUpsert],
  ['DELETE', '/api/budget/income', incomeDelete],
];

module.exports = { routes };
