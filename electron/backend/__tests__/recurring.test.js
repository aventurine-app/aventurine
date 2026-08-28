'use strict';

// Recurring (Reports) — GET /api/recurring. Detection itself is pinned by
// recurringSeries.test.js; this file covers the handler: direction resolution
// (categorized rows derive tx_type from Category.cat_type, same rule every
// other list endpoint follows), transfer exclusion, month-scoped occurrences
// (actual vs. projected), and the month query-param contract. `today` is not
// injectable through the API (the handler always uses the real local date, as
// /api/predictions/upcoming does), so dates are built relative to "now" rather
// than hardcoded.
//
// Detection does not populate the page on its own, so almost every test here
// inserts history and then calls adoptAll(), the two-call equivalent of running
// "Find recurring schedules" and ticking every box. The adoption gate is covered
// in its own section at the bottom.

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

/** Run detection and adopt everything it found — what the picker dialog does
 *  when the user ticks every candidate. Returns the adopted keys. */
function adoptAll(c) {
  const keys = c.get('/api/recurring/candidates').body.candidates.map((s) => s.key);
  if (keys.length) c.post('/api/recurring/adopt', { keys });
  return keys;
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

  adoptAll(c);

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
  adoptAll(c);
  const r = c.get('/api/recurring');
  assert.equal(r.body.series.length, 1);
  assert.equal(r.body.series[0].direction, 'income');
});

test('recurring: a recurring transfer (e.g. autosave) is detected with direction "transfer"', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(90), daysAgoIso(60), daysAgoIso(30)]) {
    insertTx(c, { date, amount: 200, description: 'SAVINGS AUTO-TRANSFER', tx_type: 'transfer' });
  }
  adoptAll(c);
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
  // Not even offered as a candidate, so there is nothing to adopt either.
  assert.deepStrictEqual(adoptAll(c), []);
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
  const key = adoptAll(c)[0];

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
  const key = adoptAll(c)[0];
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
  adoptAll(c);
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
  const key = adoptAll(c)[0];

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
  const key = adoptAll(c)[0];
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
  const key = adoptAll(c)[0];
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
  const key = adoptAll(c)[0];
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

test('recurring remove: deleting a detected series un-adopts it, and it stays gone as it keeps recurring', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = adoptAll(c)[0];

  const del = c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.equal(del.status, 200);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, [], 'off the page immediately');

  // Still absent after another transaction extends the pattern: detection finding
  // it again does not re-adopt it.
  insertTx(c, { date: daysAgoIso(0), amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  assert.deepStrictEqual(c.get('/api/recurring').body.series, [], 'still gone — adoption is a standing flag, not one-shot');

  const row = c.conn.db().prepare('SELECT adopted FROM recurring_overrides WHERE "key" = ?').get(key);
  assert.equal(row.adopted, 0);
});

test('recurring remove: a deleted detected series is offered again by the next detection run', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = adoptAll(c)[0];
  c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  const again = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(again.length, 1, 'a delete is recoverable — it goes back in the picker');
  assert.equal(again[0].key, key);
  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series.length, 1);
});

test('recurring remove: re-adopting a deleted series keeps the corrections it carried', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = adoptAll(c)[0];
  c.post('/api/recurring/override', { key, display_name: 'Streaming' });
  c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series[0].display_name, 'Streaming');
});

test('recurring remove: an edit through the override endpoint re-adopts a deleted series', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = adoptAll(c)[0];
  c.del(`/api/recurring/schedule/${encodeURIComponent(key)}`);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  c.post('/api/recurring/override', { key, amount: 16 });
  assert.equal(c.get('/api/recurring').body.series.length, 1, 'correcting a schedule is adopting it');
});

// ─── Clear all ────────────────────────────────────────────────────────────────

test('recurring clear all: empties the page, un-adopting detections and dropping manual rows', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const detectedKey = adoptAll(c)[0];
  c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: daysAgoIso(-14),
  });
  assert.equal(c.get('/api/recurring').body.series.length, 2);

  const res = c.del('/api/recurring/schedules');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.cleared, 2);
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);
  assert.deepStrictEqual(c.get('/api/recurring').body.occurrences, []);

  const rows = c.conn.db().prepare('SELECT "key", adopted FROM recurring_overrides').all();
  assert.deepStrictEqual(rows, [{ key: detectedKey, adopted: 0 }], 'detection un-adopted, manual row gone');
});

test('recurring clear all: transactions are untouched and detection offers its schedules again', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  const key = adoptAll(c)[0];
  c.post('/api/recurring/override', { key, display_name: 'Streaming' });
  c.del('/api/recurring/schedules');

  assert.equal(c.get('/api/transactions').body.transactions.length, 4, 'the ledger is not what got cleared');
  const again = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(again.length, 1, 'clearing is recoverable — it goes back in the picker');
  assert.equal(again[0].key, key);
  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series[0].display_name, 'Streaming', 'corrections survive the round trip');
});

test('recurring clear all: clearing an already-empty page is a no-op, not an error', (t) => {
  const c = makeClient(t);
  const res = c.del('/api/recurring/schedules');
  assert.equal(res.status, 200);
  assert.equal(res.body.cleared, 0);
});

test('recurring clear all: an unadopted candidate is left alone', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  // Never adopted, but carrying a correction — clear-all acts on the page, and
  // this was never on it.
  const key = c.get('/api/recurring/candidates').body.candidates[0].key;
  c.conn.db().prepare('INSERT INTO recurring_overrides ("key", display_name, adopted) VALUES (?, ?, 0)')
    .run(key, 'Streaming');

  assert.equal(c.del('/api/recurring/schedules').body.cleared, 0);
  const row = c.conn.db().prepare('SELECT display_name FROM recurring_overrides WHERE "key" = ?').get(key);
  assert.equal(row.display_name, 'Streaming', 'an untouched row keeps its corrections');
});

// ─── Category (the card's pill) ───────────────────────────────────────────────

test('recurring category: a series carries the category its transactions have', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  adoptAll(c);
  const s = c.get('/api/recurring').body.series[0];
  assert.equal(s.category_id, food);
  assert.equal(s.category, 'Food');
});

test('recurring category: uncategorized transactions leave it null, not guessed', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM' });
  }
  adoptAll(c);
  const s = c.get('/api/recurring').body.series[0];
  assert.equal(s.category_id, null);
  assert.equal(s.category, null);
});

test('recurring category: the majority category wins when a series is split', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const entertainment = catId(c, 'entertainment');
  // Three of four rows are Entertainment; one Food row must not decide the
  // category.
  insertTx(c, { date: daysAgoIso(95), amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  for (const date of [daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: entertainment });
  }
  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series[0].category, 'Entertainment');
});

test('recurring category: an uncategorized row does not outvote a categorized one', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  insertTx(c, { date: daysAgoIso(95), amount: 15.49, description: 'NETFLIX.COM' });
  insertTx(c, { date: daysAgoIso(65), amount: 15.49, description: 'NETFLIX.COM' });
  insertTx(c, { date: daysAgoIso(35), amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  insertTx(c, { date: daysAgoIso(5), amount: 15.49, description: 'NETFLIX.COM' });
  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series[0].category, 'Food',
    'rows with no category abstain rather than voting for "none"');
});

test('recurring category: a hand-added schedule has none', (t) => {
  const c = makeClient(t);
  c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: daysAgoIso(-14),
  });
  const s = c.get('/api/recurring').body.series[0];
  assert.equal(s.category, null, 'nothing backs it, so there is nothing to read a category from');
});

test('recurring category: candidates carry it too, for the picker', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  assert.equal(c.get('/api/recurring/candidates').body.candidates[0].category, 'Food');
});

// ─── Search term (the card's merchant link) ───────────────────────────────────
// `search` is what the card's merchant link puts in the ledger's Name filter.
// The required property is RECALL: the term must be a substring of every
// transaction in the series, or the linked ledger view shows fewer charges than
// the calendar drew. The ledger's filter is a case-insensitive substring match on
// description/display_name (txRowMatchesFilters), which is what these assert.

/** Every description sharing `key`'s grouping, as the ledger stores them. */
function descriptionsFor(c) {
  return c.conn.db().prepare('SELECT description FROM transactions').all().map((r) => r.description);
}

function assertFindsEvery(term, descriptions) {
  assert.ok(term, 'a detected series always has a search term');
  for (const d of descriptions) {
    assert.ok(d.toLowerCase().includes(term.toLowerCase()),
      `"${term}" must match "${d}" — the ledger filter is a plain substring search`);
  }
}

test('recurring search: a term that finds every charge, not just the one description kept', (t) => {
  const c = makeClient(t);
  // The case this exists for: one merchant, a trailing reference number that
  // moves every month. Searching any single row's description would come back
  // with exactly that row.
  const descs = [
    'NETFLIX.COM 8667797', 'NETFLIX.COM 8667812', 'NETFLIX.COM 8667955', 'NETFLIX.COM 8668043',
  ];
  descs.forEach((description, i) => {
    insertTx(c, { date: daysAgoIso(95 - i * 30), amount: 15.49, description });
  });
  adoptAll(c);
  const s = c.get('/api/recurring').body.series[0];
  assertFindsEvery(s.search, descriptionsFor(c));
  assert.equal(s.search, 'NETFLIX.COM',
    'the half-matched reference number is dropped — it buys no precision the letters do not');
});

test('recurring search: the shared part need not be at the front of the description', (t) => {
  const c = makeClient(t);
  // A leading auth number varies instead of a trailing one, so the common
  // prefix is the useless "POS " — the merchant is in the middle.
  const descs = [
    'POS 4421 CORNER MARKET', 'POS 8890 CORNER MARKET', 'POS 1207 CORNER MARKET', 'POS 6634 CORNER MARKET',
  ];
  descs.forEach((description, i) => {
    insertTx(c, { date: daysAgoIso(95 - i * 30), amount: 62.5, description });
  });
  adoptAll(c);
  const s = c.get('/api/recurring').body.series[0];
  assertFindsEvery(s.search, descriptionsFor(c));
  assert.equal(s.search, 'CORNER MARKET');
});

test('recurring search: identical descriptions keep the whole thing', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 42, description: 'CITY FITNESS CLUB' });
  }
  adoptAll(c);
  assert.equal(c.get('/api/recurring').body.series[0].search, 'CITY FITNESS CLUB');
});

test('recurring search: a renamed schedule still searches its real descriptions', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM' });
  }
  adoptAll(c);
  c.post('/api/recurring/override', { key: 'netflix com', display_name: 'Movie Night' });
  const s = c.get('/api/recurring').body.series[0];
  assert.equal(s.display_name, 'Movie Night');
  assert.equal(s.search, 'NETFLIX.COM',
    'the label is the user\'s word for it; the ledger only knows the description');
});

test('recurring search: a hand-added schedule has none', (t) => {
  const c = makeClient(t);
  c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: daysAgoIso(-14),
  });
  const s = c.get('/api/recurring').body.series[0];
  assert.equal(s.search, null, 'no transactions behind it, so the card offers no link to go and see them');
});

test('recurring search: candidates carry it too', (t) => {
  const c = makeClient(t);
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 11.99, description: 'SPOTIFY P1A4C9' });
  }
  assert.equal(c.get('/api/recurring/candidates').body.candidates[0].search, 'SPOTIFY P1A4C9');
});

// ─── Detection / adoption (the mini-onboarding) ───────────────────────────────

test('recurring detect: history alone shows nothing until the user adopts a candidate', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', display_name: 'Netflix', category_id: food });
  }

  const listed = c.get('/api/recurring');
  assert.deepStrictEqual(listed.body.series, [], 'detection does not populate the page by itself');
  assert.deepStrictEqual(listed.body.occurrences, [], 'and contributes no calendar dots either');

  const cand = c.get('/api/recurring/candidates');
  assert.equal(cand.status, 200, JSON.stringify(cand.body));
  assert.equal(cand.body.candidates.length, 1);
  const s = cand.body.candidates[0];
  assert.equal(s.display_name, 'Netflix');
  assert.equal(s.cycle, 'monthly');
  assert.equal(s.amount, 15.49);
  assert.equal(s.occurrences, 4);

  // Looking is not adopting.
  assert.deepStrictEqual(c.get('/api/recurring').body.series, []);

  const ad = c.post('/api/recurring/adopt', { keys: [s.key] });
  assert.equal(ad.status, 200, JSON.stringify(ad.body));
  assert.equal(ad.body.adopted, 1);
  assert.equal(c.get('/api/recurring').body.series.length, 1);
});

test('recurring detect: only the ticked candidates are adopted, and adopted ones stop being offered', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  for (const date of [daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
    insertTx(c, { date, amount: 42, description: 'CITY FITNESS CLUB', category_id: food });
  }
  const candidates = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(candidates.length, 2);

  const picked = candidates.find((s) => s.amount === 42);
  c.post('/api/recurring/adopt', { keys: [picked.key] });

  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1, 'the unticked candidate stays off the page');
  assert.equal(series[0].key, picked.key);

  const left = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(left.length, 1, 'an adopted schedule is not offered again');
  assert.notEqual(left[0].key, picked.key);
});

test('recurring detect: candidates come back most-confident first', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  // A long, dead-regular series and a shorter one — both detected, but not
  // equally well evidenced, so the picker has something to order.
  for (const date of [daysAgoIso(155), daysAgoIso(125), daysAgoIso(95), daysAgoIso(65), daysAgoIso(35), daysAgoIso(5)]) {
    insertTx(c, { date, amount: 15.49, description: 'NETFLIX.COM', category_id: food });
  }
  for (const date of [daysAgoIso(62), daysAgoIso(32), daysAgoIso(2)]) {
    insertTx(c, { date, amount: 42, description: 'CITY FITNESS CLUB', category_id: food });
  }
  const candidates = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(candidates.length, 2);
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].confidence >= candidates[i].confidence, 'sorted by confidence, descending');
  }
});

test('recurring adopt: an empty or non-array keys list is rejected', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/recurring/adopt', {}).status, 400);
  assert.equal(c.post('/api/recurring/adopt', { keys: 'netflix com' }).status, 400);
  assert.equal(c.post('/api/recurring/adopt', { keys: [] }).status, 400);
  assert.equal(c.post('/api/recurring/adopt', { keys: ['  '] }).status, 400);
});

test('recurring adopt: a key detection no longer produces renders nothing', (t) => {
  const c = makeClient(t);
  const ad = c.post('/api/recurring/adopt', { keys: ['ghost merchant'] });
  assert.equal(ad.status, 200, 'a stale key from an open picker is a race, not an error');
  assert.deepStrictEqual(c.get('/api/recurring').body.series, [], 'nothing backs it, so it shows nothing');
});

test('recurring adopt: a hand-added schedule needs no adoption step', (t) => {
  const c = makeClient(t);
  c.post('/api/recurring/schedule', {
    display_name: 'Gym Membership', direction: 'expense', cycle: 'monthly', amount: 45, next_date: daysAgoIso(-14),
  });
  assert.equal(c.get('/api/recurring').body.series.length, 1, 'the user just declared it — nothing left to confirm');
});
