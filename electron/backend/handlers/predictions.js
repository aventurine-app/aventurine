'use strict';

// Predictions blueprint — port of routes/predictions.py.

const { detectRecurringExpenses } = require('../services/predictions');

// Hard cap on ?limit= so a client can't request an unbounded result set.
const MAX_LIMIT = 20;

function upcoming(ctx, { query }) {
  const db = ctx.db();
  // Mirror request.args.get('limit', default=5, type=int) or 5 — a bad parse
  // or an explicit 0 both fall back to 5, then the cap clamps.
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit === 0) limit = 5;
  limit = Math.max(1, Math.min(limit, MAX_LIMIT));

  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  // Direction resolved the same way /api/transactions does it: a categorized
  // row's type comes from Category.cat_type at read time; the stored tx_type
  // only speaks for uncategorized rows.
  const expenses = rows.filter((t) => {
    const dir = t.category_id != null ? catTypes.get(t.category_id) ?? t.tx_type : t.tx_type;
    return dir === 'expense';
  });
  return { upcoming: detectRecurringExpenses(expenses, { limit }) };
}

const routes = [['GET', '/api/predictions/upcoming', upcoming]];

module.exports = { routes };
