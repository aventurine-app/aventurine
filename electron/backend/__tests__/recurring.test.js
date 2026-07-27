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

test('recurring: a recurring transfer (e.g. autosave) is detected with direction "transfer"', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(90), daysAgoIso(60), daysAgoIso(30)]) {
    insertTx(c, { date, amount: 200, description: 'SAVINGS AUTO-TRANSFER', tx_type: 'transfer' });
  }
  const r = c.get('/api/recurring');
  assert.equal(r.body.series.length, 1);
  assert.equal(r.body.series[0].direction, 'transfer');
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

// ─── Overrides (editable rows) ───────────────────────────────────────────────

test('recurring override: display_name and amount edits are reflected on the next GET', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', display_name: 'Netflix', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;

  const up = c.post('/api/recurring/override', { key, display_name: 'Streaming', amount: 17.99 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.override.display_name, 'Streaming');
  assert.equal(up.body.override.amount, 17.99);

  const r = c.get('/api/recurring');
  const s = r.body.series[0];
  assert.equal(s.display_name, 'Streaming');
  assert.equal(s.amount, 17.99);
});

test('recurring override: an amount edit never rewrites a past actual occurrence', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const dates = [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)];
  for (const date of dates) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', display_name: 'Netflix', category_id: food });
  }
  const lastDate = dates[dates.length - 1];
  const key = c.get('/api/recurring').body.series[0].key;
  c.post('/api/recurring/override', { key, amount: 99 });

  const r = c.get(`/api/recurring?month=${lastDate.slice(0, 7)}`);
  const actualOcc = r.body.occurrences.find((o) => o.date === lastDate);
  assert.ok(actualOcc);
  assert.equal(actualOcc.actual, true);
  assert.equal(actualOcc.amount, 15.49, 'a real past charge keeps its real amount');
});

test('recurring override: a cadence edit recomputes next_date from the real last charge', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const before = c.get('/api/recurring').body.series[0];
  assert.equal(before.cycle, 'monthly');

  c.post('/api/recurring/override', { key: before.key, cycle: 'weekly' });

  const after = c.get('/api/recurring').body.series[0];
  assert.equal(after.cycle, 'weekly');
  assert.notEqual(after.next_date, before.next_date);
});

test('recurring override: invalid cycle/amount/display_name are rejected', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;

  assert.equal(c.post('/api/recurring/override', { key, cycle: 'daily' }).status, 400);
  assert.equal(c.post('/api/recurring/override', { key, amount: 0 }).status, 400);
  assert.equal(c.post('/api/recurring/override', { key, amount: -5 }).status, 400);
  assert.equal(c.post('/api/recurring/override', { key, display_name: '   ' }).status, 400);
  assert.equal(c.post('/api/recurring/override', { key: '' }).status, 400);
  assert.equal(c.post('/api/recurring/override', { key }).status, 400, 'no fields to update');
});

test('recurring override: null clears a field back to auto-detected', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', display_name: 'Netflix', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;
  c.post('/api/recurring/override', { key, display_name: 'Streaming' });
  assert.equal(c.get('/api/recurring').body.series[0].display_name, 'Streaming');

  c.post('/api/recurring/override', { key, display_name: null });
  assert.equal(c.get('/api/recurring').body.series[0].display_name, 'Netflix');
});

test('recurring override: direction can be corrected, and flows into the calendar occurrences', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const dates = [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)];
  for (const date of dates) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;
  c.post('/api/recurring/override', { key, direction: 'transfer' });

  const r = c.get(`/api/recurring?month=${dates[3].slice(0, 7)}`);
  assert.equal(r.body.series[0].direction, 'transfer');
  const occ = r.body.occurrences.find((o) => o.date === dates[3]);
  assert.equal(occ.direction, 'transfer');
});

test('recurring override: invalid direction is rejected', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;
  assert.equal(c.post('/api/recurring/override', { key, direction: 'savings' }).status, 400);
});

// ─── Add (manual schedules) ───────────────────────────────────────────────────

test('recurring add: a manual schedule with no transactions appears in the listing', (t) => {
  const c = makeClient(t);
  const nextDate = daysAgoIso(-14); // 14 days from now
  const res = c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: nextDate,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.key);

  const r = c.get('/api/recurring');
  assert.equal(r.body.series.length, 1);
  const s = r.body.series[0];
  assert.equal(s.display_name, 'Gym Membership');
  assert.equal(s.direction, 'expense');
  assert.equal(s.cycle, 'monthly');
  assert.equal(s.amount, 45);
  assert.equal(s.next_date, nextDate);
  assert.equal(s.occurrences, 0, 'no real transactions back it');
});

test('recurring add: a manual schedule projects forward even if its anchor date has gone stale', (t) => {
  const c = makeClient(t);
  // Anchor a year in the past — nothing has kept it fresh since nothing ever
  // posts against a manual schedule, so next_date must catch up to today.
  const staleNext = daysAgoIso(365);
  c.post('/api/recurring/schedule', {
    display_name: 'Old Subscription', direction: 'expense', cycle: 'monthly', amount: 9.99, next_date: staleNext,
  });
  const s = c.get('/api/recurring').body.series[0];
  const todayIso = daysAgoIso(0);
  assert.ok(s.next_date >= todayIso, `next_date ${s.next_date} should have caught up to today ${todayIso}`);
});

test('recurring add: appears in the calendar occurrences for its projected month', (t) => {
  const c = makeClient(t);
  const nextDate = daysAgoIso(-10);
  c.post('/api/recurring/schedule', {
    display_name: 'Car Insurance', direction: 'expense', cycle: 'monthly', amount: 120, next_date: nextDate,
  });
  const r = c.get(`/api/recurring?month=${nextDate.slice(0, 7)}`);
  const occ = r.body.occurrences.find((o) => o.date === nextDate);
  assert.ok(occ, 'projected occurrence appears on its due date');
  assert.equal(occ.actual, false);
  assert.equal(occ.amount, 120);
});

test('recurring add: missing/invalid fields are rejected', (t) => {
  const c = makeClient(t);
  const valid = { display_name: 'Thing', direction: 'expense', cycle: 'monthly', amount: 10, next_date: daysAgoIso(-10) };
  assert.equal(c.post('/api/recurring/schedule', { ...valid, display_name: '' }).status, 400);
  assert.equal(c.post('/api/recurring/schedule', { ...valid, display_name: '123' }).status, 400, 'no letters to key off of');
  assert.equal(c.post('/api/recurring/schedule', { ...valid, direction: 'savings' }).status, 400);
  assert.equal(c.post('/api/recurring/schedule', { ...valid, cycle: 'daily' }).status, 400);
  assert.equal(c.post('/api/recurring/schedule', { ...valid, amount: 0 }).status, 400);
  assert.equal(c.post('/api/recurring/schedule', { ...valid, next_date: 'not-a-date' }).status, 400);
});

test('recurring add: a manual entry key collides with (merges into) a later-matching detected series', (t) => {
  const c = makeClient(t);
  // normaliseDesc keys off letters only (digits dropped, punctuation
  // collapsed to spaces) — 'Netflix Com' and 'NETFLIX.COM' both key to
  // 'netflix com', so this manual entry and the transactions below are the
  // SAME schedule, not two.
  c.post('/api/recurring/schedule', {
    display_name: 'Netflix Com', direction: 'expense', cycle: 'monthly', amount: 15.49, next_date: daysAgoIso(-10),
  });
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const r = c.get('/api/recurring');
  assert.equal(r.body.series.length, 1, 'the manual entry and the real series are the same key, not two rows');
  assert.equal(r.body.series[0].display_name, 'Netflix Com');
  assert.equal(r.body.series[0].occurrences, 4, 'the real detected series wins once transactions exist');
});

// ─── Remove ───────────────────────────────────────────────────────────────────

test('recurring remove: deleting a manual schedule removes it outright', (t) => {
  const c = makeClient(t);
  const create = c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: daysAgoIso(-14),
  });
  const key = create.body.key;
  assert.equal(c.get('/api/recurring').body.series.length, 1);

  const del = c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  const row = c.conn.db().prepare('SELECT * FROM recurring_overrides WHERE "key" = ?').get(key);
  assert.equal(row, undefined, 'no tombstone left behind for a manual schedule');
});

test('recurring remove: hiding a detected series persists even though its transactions still recur', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;

  const del = c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.equal(del.status, 200);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, [], 'hidden immediately');

  // Still hidden after another transaction keeps the pattern alive.
  insertTx(c, { date: daysAgoIso(0), amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  assert.deepStrictEqual(c.get('/api/recurring').body.series, [], 'still hidden — removal is a standing flag, not one-shot');

  const row = c.conn.db().prepare('SELECT removed FROM recurring_overrides WHERE "key" = ?').get(key);
  assert.equal(row.removed, 1);
});

test('recurring remove: re-adding under the same name revives a removed detected series', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = c.get('/api/recurring').body.series[0].key;
  c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  c.post('/api/recurring/override', { key, amount: 16 });
  assert.equal(c.get('/api/recurring').body.series.length, 1, 'any edit through the override endpoint un-hides it');
});
