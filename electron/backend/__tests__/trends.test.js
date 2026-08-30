'use strict';

// Spending Trends (Reports). Read-only over the Cash Flow statement (the same
// per-cell blend the statement renders), so no migration/schema assertions here.
// The trailing window is relative to "now", so target months are computed
// dynamically (last COMPLETE month = one month before the current).

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function catId(c, key) {
  return c.conn.db().prepare('SELECT id FROM categories WHERE "key" = ?').get(key).id;
}

/** Opt a year into the statement (what an import's ensureActiveYear does). */
function activateYear(c, year) {
  c.conn.db().prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)').run(Number(year));
}

// `activate: false` leaves the year off the statement, which is how a user opts
// a year out — those transactions feed no cell and so no trend.
function insertTx(c, { date, amount, category_id = null, tx_type = 'expense', activate = true }) {
  if (activate) activateYear(c, date.slice(0, 4));
  c.conn
    .db()
    .prepare(
      "INSERT INTO transactions (date, description, category_id, amount, notes, tx_type) VALUES (?, '', ?, ?, '', ?)"
    )
    .run(date, category_id, amount, tx_type);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Split a 'YYYY-MM' into the { year, month } an /api/entry body wants. */
function entryCell(ym) {
  const [year, mm] = ym.split('-');
  return { year: Number(year), month: MONTH_NAMES[Number(mm) - 1] };
}

/** 'YYYY-MM' (+ a mid-month date) for `monthsBack` complete months ago. */
function monthsAgo(monthsBack) {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  return { ym, date: `${ym}-15` };
}
function thisMonthDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
}

test('trends: monthly per-expense-category sums over the trailing window', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const income = catId(c, 'income');
  const savings = catId(c, 'savings');

  const m1 = monthsAgo(1); // last complete month (newest in window)
  const m6 = monthsAgo(6);
  const m13 = monthsAgo(13); // older than a 12-month window → excluded

  insertTx(c, { date: m1.date, amount: 200, category_id: food });
  insertTx(c, { date: m1.date, amount: 50, category_id: food }); // same month → 250
  insertTx(c, { date: m6.date, amount: 120, category_id: food });
  insertTx(c, { date: m13.date, amount: 999, category_id: food }); // outside window
  insertTx(c, { date: thisMonthDate(), amount: 777, category_id: food }); // current partial month → excluded
  insertTx(c, { date: m1.date, amount: 5000, category_id: income }); // income category → excluded
  insertTx(c, { date: m1.date, amount: 400, category_id: savings }); // savings category → excluded
  insertTx(c, { date: m1.date, amount: 60, category_id: null, tx_type: 'expense' }); // uncategorized

  const r = c.get('/api/trends?window=12');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.window, 12);
  assert.equal(r.body.months.length, 12);
  assert.equal(r.body.months[11], m1.ym); // newest = last complete month
  assert.equal(r.body.months[0], monthsAgo(12).ym); // oldest

  const foodCat = r.body.categories.find((x) => x.key === 'food');
  assert.ok(foodCat, 'food present');
  assert.equal(foodCat.monthly[m1.ym], 250);
  assert.equal(foodCat.monthly[m6.ym], 120);
  assert.ok(!(m13.ym in foodCat.monthly), 'month outside window excluded');
  assert.ok(!(thisMonthDate().slice(0, 7) in foodCat.monthly), 'current partial month excluded');

  // Income + savings categories are not expense → excluded entirely.
  assert.ok(!r.body.categories.some((x) => x.key === 'income'));
  assert.ok(!r.body.categories.some((x) => x.key === 'savings'));
  // An expense category with no spend is omitted.
  assert.ok(!r.body.categories.some((x) => x.key === 'rent'));
  // Null-category expense surfaces as a synthetic "Uncategorized" series.
  const uncat = r.body.categories.find((x) => x.key === '__uncategorized__');
  assert.ok(uncat, 'uncategorized present');
  assert.equal(uncat.monthly[m1.ym], 60);
});

test('trends: window clamps to {6,12,36,60}', (t) => {
  const c = makeClient(t);
  assert.equal(c.get('/api/trends').body.window, 12); // default
  assert.equal(c.get('/api/trends?window=7').body.window, 12); // invalid → default
  assert.equal(c.get('/api/trends?window=6').body.months.length, 6);
  assert.equal(c.get('/api/trends?window=36').body.months.length, 36);
  assert.equal(c.get('/api/trends?window=60').body.months.length, 60);
});


test('trends: a typed Cash Flow cell overrides the computed value', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const m1 = monthsAgo(1);
  const m2 = monthsAgo(2);

  insertTx(c, { date: m1.date, amount: 200, category_id: food });
  insertTx(c, { date: m2.date, amount: 120, category_id: food });

  // Claim the newest month's cell; the older one keeps its computed value.
  const r0 = c.post('/api/entry', { ...entryCell(m1.ym), category: 'food', value: 75 });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));

  let foodCat = c.get('/api/trends?window=12').body.categories.find((x) => x.key === 'food');
  assert.equal(foodCat.monthly[m1.ym], 75, 'entry overrides its own cell');
  assert.equal(foodCat.monthly[m2.ym], 120, 'untouched cell stays computed');

  // Clearing the entry releases the cell back to the computed value.
  const r1 = c.del('/api/entry', { ...entryCell(m1.ym), category: 'food' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  foodCat = c.get('/api/trends?window=12').body.categories.find((x) => x.key === 'food');
  assert.equal(foodCat.monthly[m1.ym], 200);
});

test('trends: a year with no year-table contributes nothing', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const m1 = monthsAgo(1);

  insertTx(c, { date: m1.date, amount: 200, category_id: food, activate: false });
  // Seeding opts the CURRENT year in, so opt it back out to be the year with no
  // year-table (what DELETE /api/year does).
  c.conn.db().prepare('DELETE FROM active_years').run();
  assert.deepEqual(c.get('/api/trends?window=12').body.categories, []);

  // Opting the year in is what puts it on the chart.
  activateYear(c, m1.ym.slice(0, 4));
  const foodCat = c.get('/api/trends?window=12').body.categories.find((x) => x.key === 'food');
  assert.equal(foodCat.monthly[m1.ym], 200);
});

test('trends: a hand-entered cell needs no transaction behind it', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);
  c.post('/api/year', { year: entryCell(m1.ym).year });

  const r0 = c.post('/api/entry', { ...entryCell(m1.ym), category: 'rent', value: 900 });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));

  const rent = c.get('/api/trends?window=12').body.categories.find((x) => x.key === 'rent');
  assert.ok(rent, 'rent present');
  assert.equal(rent.monthly[m1.ym], 900);
});
