'use strict';

// Spending Trends (Reports) blueprint. Read-only: returns monthly spending per
// EXPENSE category over a trailing window of complete months, for the chart +
// "biggest movers" panel. The movers math is client-side (services/trends has
// no state); this handler only aggregates.

const { addMonthKey } = require('../services/forecast');

// Allowed trailing windows, in months (6mo / 12mo / 3yr / 5yr).
const ALLOWED_WINDOWS = new Set([6, 12, 36, 60]);
const DEFAULT_WINDOW = 12;

const UNCAT_KEY = '__uncategorized__';

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function trendsGet(ctx, { query }) {
  const db = ctx.db();

  let window = parseInt(query.window, 10);
  if (!ALLOWED_WINDOWS.has(window)) window = DEFAULT_WINDOW;

  // Trailing `window` COMPLETE months: end at last month, walk back. The current
  // (partial) month is excluded so a half-finished month doesn't dent the trend.
  const lastComplete = addMonthKey(currentMonthKey(), -1);
  const firstMonth = addMonthKey(lastComplete, -(window - 1));
  const months = [];
  for (let i = 0; i < window; i++) months.push(addMonthKey(firstMonth, i));

  // Per-(category, month) expense sums for real expense categories.
  const rows = db
    .prepare(
      `SELECT t.category_id AS cid, substr(t.date, 1, 7) AS ym, SUM(t.amount) AS s
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE c.cat_type = 'expense'
          AND substr(t.date, 1, 7) BETWEEN ? AND ?
        GROUP BY t.category_id, ym`
    )
    .all(firstMonth, lastComplete);

  // Null-category spending → a synthetic "Uncategorized" series.
  const uncatRows = db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS ym, SUM(t.amount) AS s
         FROM transactions t
        WHERE t.category_id IS NULL AND t.tx_type = 'expense'
          AND substr(t.date, 1, 7) BETWEEN ? AND ?
        GROUP BY ym`
    )
    .all(firstMonth, lastComplete);

  // Category metadata, excluding the uncat_expense system bucket.
  const cats = db
    .prepare("SELECT id, \"key\", name FROM categories WHERE cat_type = 'expense' AND \"key\" != 'uncat_expense'")
    .all();
  const metaById = new Map(cats.map((c) => [c.id, c]));

  // Accumulate monthly maps per category key.
  const byKey = new Map(); // key -> { key, name, monthly }
  const ensure = (key, name) => {
    let entry = byKey.get(key);
    if (!entry) { entry = { key, name, monthly: {} }; byKey.set(key, entry); }
    return entry;
  };
  for (const r of rows) {
    const meta = metaById.get(r.cid);
    if (!meta) continue; // uncat_expense bucket or a non-expense row — skip
    ensure(meta.key, meta.name).monthly[r.ym] = r.s;
  }
  for (const r of uncatRows) {
    if (r.s) ensure(UNCAT_KEY, 'Uncategorized').monthly[r.ym] = r.s;
  }

  // Only categories with non-zero spend in the window; sorted by total desc so
  // the biggest spenders lead the selector.
  const categories = [...byKey.values()]
    .map((c) => ({ ...c, total: Object.values(c.monthly).reduce((a, b) => a + b, 0) }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .map(({ key, name, monthly }) => ({ key, name, monthly }));

  return { ok: true, window, months, categories };
}

const routes = [['GET', '/api/trends', trendsGet]];

module.exports = { routes };
