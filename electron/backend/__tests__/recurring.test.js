'use strict';

// Recurring (Reports) — GET /api/recurring. Detection itself is pinned by
// recurringSeries.test.js; this file covers the handler: direction resolution
// (categorized rows derive tx_type from Category.cat_type, same rule every
// other list endpoint follows), transfer exclusion, month-scoped occurrences
// (actual vs. projected), and the month query-param contract. `today` isn't
// injectable through the API (the handler always uses the real local date, same
// as /api/predictions/upcoming already does), so dates are built relative to
// "now" rather than hardcoded.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function catId(c, key) {
  return c.conn.db().prepare('SELECT id FROM categories WHERE "key" = ?').get(key).id;
}

function insertTx(c, { date, amount, description = '', display_name = null, category_id = null, tx_type = 'expense' }) {
  c.conn
    .db()
    .prepare(
      `INSERT INTO transactions (date, description, display_name, category_id, amount, notes, tx_type)
       VALUES (?, ?, ?, ?, ?, '', ?)`
    )
    .run(date, description, display_name, category_id, amount, tx_type);
}

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonthKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

test('recurring: empty history returns empty series/occurrences, not an error', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/recurring');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.series, []);
  assert.deepStrictEqual(r.body.occurrences, []);
  assert.equal(r.body.month, currentMonthKey());
});

test('recurring: invalid month param -> 400', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/recurring?month=not-a-month');
  assert.equal(r.status, 400);
});

test('recurring: monthly expense series — actual occurrence in its month, projected the next', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const d1 = daysAgoIso(95);
  const d2 = daysAgoIso(65);
  const d3 = daysAgoIso(35);
  const d4 = daysAgoIso(5);
  for (const date of [d1, d2, d3, d4]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', display_name: 'Netflix', category_id: food });
  }

  const lastMonth = d4.slice(0, 7);
  const r = c.get(`/api/recurring?month=${lastMonth}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.series.length, 1);
  const s = r.body.series[0];
  assert.equal(s.display_name, 'Netflix');
  assert.equal(s.direction, 'expense');
  assert.equal(s.cycle, 'monthly');

  const actualOcc = r.body.occurrences.find((o) => o.date === d4);
  assert.ok(actualOcc, 'actual occurrence present in its own month');
  assert.equal(actualOcc.actual, true);
  assert.equal(actualOcc.key, s.key);

  const nextMonth = addMonthKey(lastMonth, 1);
  const r2 = c.get(`/api/recurring?month=${nextMonth}`);
  assert.equal(r2.body.series.length, 1, 'series listing is month-independent');
  assert.ok(r2.body.occurrences.length >= 1, 'a projected occurrence appears next month');
  assert.equal(r2.body.occurrences[0].actual, false);
});

test('recurring: recurring income is detected with direction "income"', (t) => {
  const c = makeClient(t);
  const income = catId(c, 'income');
  for (const date of [daysAgoIso(88), daysAgoIso(58), daysAgoIso(28)]) {
    insertTx(c, {
      date, amount: 3000, description: 'ACME PAYROLL', display_name: 'Acme Corp',
      category_id: income, tx_type: 'income',
    });
  }
  const r = c.get('/api/recurring');
  assert.equal(r.body.series.length, 1);
  assert.equal(r.body.series[0].direction, 'income');
});

test('recurring: transfer-type transactions are excluded even if they recur', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(90), daysAgoIso(60), daysAgoIso(30)]) {
    insertTx(c, { date, amount: 200, description: 'SAVINGS AUTO-TRANSFER', tx_type: 'transfer' });
  }
  const r = c.get('/api/recurring');
  assert.deepStrictEqual(r.body.series, []);
});

test('recurring: a lapsed series is dropped and contributes no occurrences', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(500), daysAgoIso(470), daysAgoIso(440)]) {
    insertTx(c, { date, amount: 9, description: 'DEFUNCT GYM', category_id: food });
  }
  const r = c.get('/api/recurring');
  assert.deepStrictEqual(r.body.series, []);
  assert.deepStrictEqual(r.body.occurrences, []);
});
