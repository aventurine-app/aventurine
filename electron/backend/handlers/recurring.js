'use strict';

// Recurring (Reports) blueprint — read-only. Surfaces detectRecurringSeries
// (services/predictions.js) as a full listing rather than the top-N "due
// soon" slice /api/predictions/upcoming returns, plus a per-month calendar of
// occurrences (actual past charges + projected future ones) for the requested
// month.

const { bad } = require('../validate');
const { serialiseTx } = require('../services/transactions');
const { detectRecurringSeries, localTodayIso } = require('../services/predictions');
const { addMonthKey, placeRecurring } = require('../services/forecast');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function recurringGet(ctx, { query }) {
  const db = ctx.db();

  const month = query.month || currentMonthKey();
  if (!MONTH_RE.test(month)) bad('invalid month (expected YYYY-MM)');

  const catTypeById = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY date')
    .all()
    .map((t) => serialiseTx(t, catTypeById))
    .filter((t) => t.tx_type !== 'transfer');

  const income = rows.filter((t) => t.tx_type === 'income');
  const expense = rows.filter((t) => t.tx_type === 'expense');

  const todayIso = localTodayIso();
  const series = [
    ...detectRecurringSeries(income, { today: todayIso }).map((s) => ({ ...s, direction: 'income' })),
    ...detectRecurringSeries(expense, { today: todayIso }).map((s) => ({ ...s, direction: 'expense' })),
  ].sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.confidence - a.confidence));

  const monthStart = `${month}-01`;
  const monthEndExclusive = `${addMonthKey(month, 1)}-01`;

  const occurrences = [];
  for (const s of series) {
    for (const d of s.dates) {
      if (d.date >= monthStart && d.date < monthEndExclusive) {
        occurrences.push({
          date: d.date, key: s.key, direction: s.direction, amount: d.amount, actual: true,
        });
      }
    }
    // Project forward from today through this month's end; placeRecurring's
    // catch-up loop already no-ops when monthEndExclusive is in the past, so
    // this needs no branching for past/current/future months.
    const projected = placeRecurring(
      [{ key: s.key, name: s.cycle, days: s.cycle_days, amount: s.amount, last: s.last_date }],
      todayIso,
      monthEndExclusive
    );
    for (const o of projected) {
      if (o.date >= monthStart) {
        occurrences.push({
          date: o.date, key: s.key, direction: s.direction, amount: o.amount, actual: false,
        });
      }
    }
  }
  occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    month,
    series: series.map((s) => ({
      key: s.key,
      description: s.description,
      display_name: s.display_name,
      direction: s.direction,
      amount: s.amount,
      cycle: s.cycle,
      occurrences: s.occurrences,
      confidence: s.confidence,
      last_date: s.last_date,
      next_date: s.next_date,
    })),
    occurrences,
  };
}

const routes = [['GET', '/api/recurring', recurringGet]];

module.exports = { routes };
