'use strict';

// Spending Trends (Reports) blueprint. Read-only: returns monthly spending per
// EXPENSE category over a trailing window of complete months, for the chart +
// "biggest movers" panel. The movers math is client-side (services/trends has
// no state); this handler only aggregates.
//
// Source of truth: the CASH FLOW STATEMENT, not the raw ledger — the same
// per-cell blend the statement renders (computed from transactions, a stored
// Entry overriding its own cell), so a hand-typed cell is not silently
// overruled by a chart, and a year with no year-table contributes nothing here
// exactly as it contributes nothing there. Top Merchants still reads the ledger
// directly: it ranks merchants, and the statement has no per-merchant cell.

const { addMonthKey } = require('../services/forecast');
const { computedCells, manualCells, blendCells } = require('./incomeExpenses');
const { monthNumber } = require('../validate');

// Allowed trailing windows, in months (3mo / 6mo / 1yr / 2yr / 5yr) — the same
// set the Top Merchants card beside this one offers, so both cards of the
// Spending tab cover the same spans.
const ALLOWED_WINDOWS = new Set([3, 6, 12, 24, 60]);
const DEFAULT_WINDOW = 12;

// The statement keys uncategorized spend by its system bucket; the chart has
// always shipped it as a synthetic series, so the key is translated on the way
// out rather than leaking a bucket the category selector never showed.
const UNCAT_CELL = 'uncat_expense';
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
  const inWindow = new Set(months);

  // What the statement shows, cell for cell.
  const cells = blendCells(computedCells(db), manualCells(db));

  // Expense-category names, keyed the way the statement keys its cells; a cell
  // whose key isn't here is income or transfer, and isn't spending.
  const nameByKey = new Map(
    db
      .prepare("SELECT \"key\", name FROM categories WHERE cat_type = 'expense'")
      .all()
      .map((c) => [c.key, c.name])
  );

  // Accumulate monthly maps per category key.
  const byKey = new Map(); // key -> { key, name, monthly }
  const ensure = (key, name) => {
    let entry = byKey.get(key);
    if (!entry) { entry = { key, name, monthly: {} }; byKey.set(key, entry); }
    return entry;
  };
  for (const [yearStr, byMonth] of Object.entries(cells)) {
    for (const [month, row] of Object.entries(byMonth)) {
      const num = monthNumber(month);
      if (!num) continue;
      const ym = `${yearStr}-${String(num).padStart(2, '0')}`;
      if (!inWindow.has(ym)) continue;
      for (const [cellKey, value] of Object.entries(row)) {
        const name = nameByKey.get(cellKey);
        if (name === undefined) continue;
        ensure(cellKey === UNCAT_CELL ? UNCAT_KEY : cellKey, name).monthly[ym] = value;
      }
    }
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
