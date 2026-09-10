'use strict';

// Budgets routes. Handlers are plain functions (ctx, {params, query, body});
// ctx is the conn manager.
//
// A budget is ONE monthly target per category, applied to EVERY month — past
// and future alike — which is why nothing here carries a year or a month. The
// storage is budget_amounts (schema.js), keyed by the category's stable slug,
// so renaming a category keeps its target.
//
// WHAT IS NOT HERE: actual spend. The Budgets page reads that out of the Cash
// Flow statement (GET /api/data), the same blended per-cell source Spending
// Trends reads — a hand-entered cell is the user's answer for that month, and a
// second aggregation over the ledger would let the two surfaces disagree about
// what a month cost. So there is no /api/budgets/progress: the renderer already
// holds both halves and divides them.
//
// This route is PAID. The licensing gate in router.js is an allow list, so
// leaving '/api/budgets' off FREE_PREFIXES is what locks it — nothing here
// references licensing.

const { bad, isFiniteNumber, round2 } = require('../validate');

// Income has no target to hold to: a budget is a ceiling on money leaving. The
// transfer direction is allowed because "move $400 into savings every month" is
// a target in exactly the same sense as "$500 of groceries" — the same pair
// schema.js names on budget_amounts.
const BUDGETABLE_CAT_TYPES = new Set(['expense', 'transfer']);

// One save carries every row the Set Budget dialog showed, so the payload is
// bounded by the category taxonomy. The cap is far above any real one; it is
// here so a malformed request cannot make the loop below do unbounded work.
const MAX_ROWS_PER_SAVE = 200;

function listRows(db) {
  return db.prepare('SELECT category, amount FROM budget_amounts ORDER BY category').all();
}

/**
 * Every target that has been set, as [{ category, amount }].
 *
 * Unjoined and unfiltered on purpose, mirroring the Cash Flow read path: a
 * database that predates a category deletion can hold a row whose key no longer
 * resolves, and hiding it here would only make it invisible rather than gone.
 * The renderer keys off the categories it drew, so an orphan is ignored.
 */
function list(ctx) {
  return { budgets: listRows(ctx.db()) };
}

/**
 * Save the targets the payload names, and ONLY those.
 *
 *   amount > 0    upsert that category's target
 *   amount === 0  clear it — a zero target and no target mean the same thing
 *                 (nothing to spend against), and a zero would otherwise draw a
 *                 circle with no size
 *
 * Categories the payload does not name are left alone, so this is a save of the
 * dialog's rows rather than a replace of the whole table: a target the dialog
 * never showed cannot be wiped by a save it was not part of.
 *
 * The whole payload is validated before any of it is written, and the writes
 * run in one transaction, so a bad row leaves the stored set exactly as it was
 * instead of half-saved.
 */
function save(ctx, { body }) {
  const db = ctx.db();
  const rows = (body || {}).budgets;
  if (!Array.isArray(rows)) bad('budgets must be an array');
  if (rows.length > MAX_ROWS_PER_SAVE) bad('too many budgets');

  const findCat = db.prepare('SELECT cat_type FROM categories WHERE "key" = ?');
  const parsed = rows.map((row) => {
    if (!row || typeof row !== 'object') bad('invalid budget');
    const { category, amount } = row;
    if (typeof category !== 'string' || !category) bad('invalid category');
    const cat = findCat.get(category);
    if (!cat) bad('unknown category');
    if (!BUDGETABLE_CAT_TYPES.has(cat.cat_type)) bad('category cannot hold a budget');
    // Rounded at the write boundary, like every other money field, so no float
    // artifact reaches disk (see validate.round2).
    if (!isFiniteNumber(amount) || amount < 0) bad('invalid amount');
    return { category, amount: round2(amount) };
  });

  const upsert = db.prepare(
    `INSERT INTO budget_amounts (category, amount) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET amount = excluded.amount`
  );
  const clear = db.prepare('DELETE FROM budget_amounts WHERE category = ?');

  db.transaction(() => {
    for (const { category, amount } of parsed) {
      if (amount > 0) upsert.run(category, amount);
      else clear.run(category);
    }
  })();

  // The saved set comes back with the acknowledgement so the dialog's caller
  // has no reason to issue a second GET to find out what it just wrote.
  return { ok: true, budgets: listRows(db) };
}

const routes = [
  ['GET', '/api/budgets', list],
  ['PUT', '/api/budgets', save],
];

module.exports = { routes, list, save };
