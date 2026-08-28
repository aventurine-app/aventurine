'use strict';

// Saved & Invested (Reports). Read-only over transactions, so no migration/
// schema assertions here. The trailing window is relative to "now", so target
// months are computed dynamically (last COMPLETE month = one before the current).

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function catId(c, key) {
  return c.conn.db().prepare('SELECT id FROM categories WHERE "key" = ?').get(key).id;
}

/** A category the seed does not ship, created the way the UI creates one. The
 *  backend derives the key ('cat_<id>'), which is the point: the report cannot
 *  key off a user-chosen name, only off the direction. */
function makeCategory(c, { name, cat_type }) {
  const r = c.post('/api/categories', { name, cat_type });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.category.id;
}

function insertTx(c, { date, amount, description = '', display_name = null, category_id = null, tx_type = 'transfer' }) {
  c.conn
    .db()
    .prepare(
      'INSERT INTO transactions (date, description, display_name, category_id, amount, notes, tx_type)'
      + " VALUES (?, ?, ?, ?, ?, '', ?)"
    )
    .run(date, description, display_name, category_id, amount, tx_type);
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

test('transfers: monthly totals over the trailing window, transfer direction only', (t) => {
  const c = makeClient(t);
  const investing = catId(c, 'investing');
  const income = catId(c, 'income');
  const food = catId(c, 'food');

  const m1 = monthsAgo(1); // last complete month (newest in window)
  const m6 = monthsAgo(6);
  const m13 = monthsAgo(13); // older than a 12-month window → excluded

  insertTx(c, { date: m1.date, amount: 500, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m1.date, amount: 250, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m6.date, amount: 300, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m13.date, amount: 999, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: thisMonthDate(), amount: 777, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m1.date, amount: 5000, description: 'PAYROLL', category_id: income, tx_type: 'income' });
  insertTx(c, { date: m1.date, amount: 60, description: 'CORNER DELI', category_id: food, tx_type: 'expense' });

  const r = c.get('/api/transfers?window=12');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.window, 12);
  assert.equal(r.body.months.length, 12);
  assert.equal(r.body.months[11], m1.ym); // newest = last complete month
  assert.equal(r.body.months[0], monthsAgo(12).ym); // oldest

  assert.equal(r.body.monthly[m1.ym], 750);
  assert.equal(r.body.monthly[m6.ym], 300);
  assert.ok(!(m13.ym in r.body.monthly), 'month outside window excluded');
  assert.ok(!(thisMonthDate().slice(0, 7) in r.body.monthly), 'current partial month excluded');
  assert.equal(r.body.total, 1050);
});

test('transfers: any transfer category counts, no curation needed', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // The report follows the DIRECTION, so a user-created category counts the same
  // as the seeded ones, and a seeded one re-typed away from transfer stops
  // counting. Neither depends on the import lexicon matching anything.
  const savings = catId(c, 'savings');
  const investing = catId(c, 'investing');
  const brokerage = makeCategory(c, { name: 'Brokerage', cat_type: 'transfer' });
  const crypto = makeCategory(c, { name: 'Crypto', cat_type: 'transfer' });

  insertTx(c, { date: m1.date, amount: 100, description: 'ALLY SAVE', category_id: savings });
  insertTx(c, { date: m1.date, amount: 200, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m1.date, amount: 300, description: 'SCHWAB TRANSFER', category_id: brokerage });
  insertTx(c, { date: m1.date, amount: 400, description: 'COINBASE INC', category_id: crypto });

  assert.equal(c.get('/api/transfers?window=12').body.total, 1000);

  // Re-typed to spending → it leaves, because the direction is the whole rule.
  c.conn.db().prepare("UPDATE categories SET cat_type = 'expense' WHERE id = ?").run(crypto);
  assert.equal(c.get('/api/transfers?window=12').body.total, 600);
});

test('transfers: an uncategorized row takes its direction from tx_type', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);
  // The direction rule: no category, so the row's own tx_type applies. Same rule
  // handlers/topMerchants.js uses for an uncategorized row.
  insertTx(c, { date: m1.date, amount: 120, description: 'ALLY SAVINGS XFER', category_id: null, tx_type: 'transfer' });
  insertTx(c, { date: m1.date, amount: 900, description: 'CORNER DELI', category_id: null, tx_type: 'expense' });
  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.total, 120);
});

test('transfers: window clamps to {3,6,12,24}', (t) => {
  const c = makeClient(t);
  assert.equal(c.get('/api/transfers').body.window, 12); // default
  assert.equal(c.get('/api/transfers?window=7').body.window, 12); // invalid → default
  assert.equal(c.get('/api/transfers?window=3').body.months.length, 3);
  assert.equal(c.get('/api/transfers?window=6').body.months.length, 6);
  assert.equal(c.get('/api/transfers?window=24').body.months.length, 24);
});

test('transfers: months stop where the ledger does, but real zeroes stay', (t) => {
  const c = makeClient(t);
  const investing = catId(c, 'investing');
  const m4 = monthsAgo(4);
  const m1 = monthsAgo(1);

  // The ledger begins four months ago, so a 24-month window cannot plot the
  // twenty months before it: nothing was imported for them, and a zero column
  // would show no saving for months with no data.
  insertTx(c, { date: m4.date, amount: 100, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m1.date, amount: 100, description: 'VANGUARD BUY', category_id: investing });

  const r = c.get('/api/transfers?window=24');
  assert.equal(r.body.window, 24, 'the request is still reported as asked');
  assert.equal(r.body.months.length, 4, 'clamped to the months the ledger covers');
  assert.equal(r.body.months[0], m4.ym);
  assert.equal(r.body.months[3], m1.ym);

  // The clamp is the LEDGER's first row, not the first transfer row: a month
  // the ledger covers with nothing put away really is a zero, and saying so is
  // the point of the chart.
  const c2 = makeClient(t);
  const inv2 = catId(c2, 'investing');
  const food2 = catId(c2, 'food');
  insertTx(c2, { date: monthsAgo(5).date, amount: 40, description: 'CORNER DELI', category_id: food2, tx_type: 'expense' });
  insertTx(c2, { date: m1.date, amount: 100, description: 'VANGUARD BUY', category_id: inv2 });
  const r2 = c2.get('/api/transfers?window=24');
  assert.equal(r2.body.months.length, 5, 'spending months count as covered');
  assert.ok(!(r2.body.months[0] in r2.body.monthly), 'and a covered month with no transfer is a real zero');
});

test('transfers: merchants group by the shared rule and rank by total', (t) => {
  const c = makeClient(t);
  const investing = catId(c, 'investing');
  const m1 = monthsAgo(1);
  const m2 = monthsAgo(2);

  // Curated display_name groups two descriptions that share nothing.
  insertTx(c, { date: m1.date, amount: 600, description: 'WEB PMTS VGRD*8891', display_name: 'Vanguard', category_id: investing });
  insertTx(c, { date: m2.date, amount: 400, description: 'VANGUARD BUY 44120', display_name: 'Vanguard', category_id: investing });
  // Unnamed rows group on their leading content tokens.
  insertTx(c, { date: m1.date, amount: 200, description: 'HARBOR CREST FUNDS 8812', category_id: investing });
  insertTx(c, { date: m2.date, amount: 150, description: 'HARBOR CREST FUNDS 9930', category_id: investing });

  const r = c.get('/api/transfers?window=12');
  const names = r.body.merchants.map((m) => m.name);
  assert.deepEqual(names, ['Vanguard', 'HARBOR CREST FUNDS 8812']);

  const vanguard = r.body.merchants[0];
  assert.equal(vanguard.total, 1000);
  assert.equal(vanguard.count, 2);
  assert.equal(vanguard.monthly[m1.ym], 600);
  assert.equal(vanguard.monthly[m2.ym], 400);
  // A curated name is used as the filter term directly (the Name filter matches
  // display_name); an unnamed group uses the substring its rows share.
  assert.equal(vanguard.search, 'Vanguard');
  assert.equal(r.body.merchants[1].search, 'HARBOR CREST FUNDS');
});

test('transfers: the stack always totals the line', (t) => {
  const c = makeClient(t);
  const investing = catId(c, 'investing');
  const m1 = monthsAgo(1);

  // Nine distinct merchants (one more than the eight the palette can colour) plus
  // a row matching no merchant. Everything past the eighth, and the unmatched
  // row, must land in OTHER or the two charts would not match.
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
  names.forEach((n, i) => {
    insertTx(c, { date: m1.date, amount: (names.length - i) * 100, description: `${n} Funds`, category_id: investing });
  });
  insertTx(c, { date: m1.date, amount: 7, description: '55512345', category_id: investing });

  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.merchants.length, 9, 'eight coloured merchants + Other');

  const other = r.body.merchants[8];
  assert.equal(other.key, '__other__');
  assert.equal(other.name, 'Other');
  assert.equal(other.search, null, 'Other is not one group, so it cannot filter the ledger');
  assert.equal(other.total, 107); // India (100) + the nameless row (7)
  assert.equal(other.count, 2);

  const stacked = r.body.merchants.reduce((sum, m) => sum + (m.monthly[m1.ym] || 0), 0);
  assert.equal(Math.round(stacked * 100) / 100, r.body.monthly[m1.ym]);
  assert.equal(r.body.monthly[m1.ym], r.body.total);
});

test('transfers: an empty ledger answers with the months and nothing else', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/transfers?window=6');
  assert.equal(r.status, 200);
  assert.equal(r.body.months.length, 6);
  assert.equal(r.body.total, 0);
  assert.deepEqual(r.body.monthly, {});
  assert.deepEqual(r.body.merchants, []);
  assert.equal(r.body.everTransferred, false, 'never put anything away, so the empty state offers a way to start');
});

test('transfers: everTransferred ignores the window', (t) => {
  const c = makeClient(t);
  const investing = catId(c, 'investing');
  // Older than any window the picker offers, so the report is empty, but the
  // ledger DOES hold a transfer, so the empty state must suggest a longer window
  // rather than a first transfer.
  insertTx(c, { date: monthsAgo(40).date, amount: 500, description: 'VANGUARD BUY', category_id: investing });
  const r = c.get('/api/transfers?window=3');
  assert.equal(r.body.total, 0);
  assert.equal(r.body.everTransferred, true);
});

test('transfers: the report is a paid feature', (t) => {
  const c = makeClient(t, { licensed: false });
  assert.equal(c.get('/api/transfers').status, 402);
});
