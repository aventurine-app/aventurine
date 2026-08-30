'use strict';

// Saved & Invested (Reports). Read-only over the Cash Flow statement (the same
// per-cell blend the statement renders), so no migration/schema assertions here.
// Both charts come from those cells: the stack is one band per Transfer ROW of
// the grid, so it is the statement's own itemisation of the line. The trailing
// window is relative to "now", so target months are computed dynamically (last
// COMPLETE month = one before the current).

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

/** Opt every year a window can reach into the statement — what an import's
 *  ensureActiveYear does for the years it touches. A year that is NOT opted in
 *  is off the statement and so off this report, which is its own test below. */
function activateWindow(c, yearsBack = 5) {
  const now = new Date().getFullYear();
  const stmt = c.conn.db().prepare('INSERT OR IGNORE INTO active_years (year) VALUES (?)');
  for (let y = now - yearsBack; y <= now; y++) stmt.run(y);
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

test('transfers: monthly totals over the trailing window, transfer direction only', (t) => {
  const c = makeClient(t);
  activateWindow(c);
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
  activateWindow(c);
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
  activateWindow(c);
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
  activateWindow(c);
  assert.equal(c.get('/api/transfers').body.window, 12); // default
  assert.equal(c.get('/api/transfers?window=7').body.window, 12); // invalid → default
  assert.equal(c.get('/api/transfers?window=3').body.months.length, 3);
  assert.equal(c.get('/api/transfers?window=6').body.months.length, 6);
  assert.equal(c.get('/api/transfers?window=24').body.months.length, 24);
});

test('transfers: months stop where the ledger does, but real zeroes stay', (t) => {
  const c = makeClient(t);
  activateWindow(c);
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
  activateWindow(c2);
  const inv2 = catId(c2, 'investing');
  const food2 = catId(c2, 'food');
  insertTx(c2, { date: monthsAgo(5).date, amount: 40, description: 'CORNER DELI', category_id: food2, tx_type: 'expense' });
  insertTx(c2, { date: m1.date, amount: 100, description: 'VANGUARD BUY', category_id: inv2 });
  const r2 = c2.get('/api/transfers?window=24');
  assert.equal(r2.body.months.length, 5, 'spending months count as covered');
  assert.ok(!(r2.body.months[0] in r2.body.monthly), 'and a covered month with no transfer is a real zero');
});

test('transfers: one band per Transfer row of the grid, ranked by total', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const savings = catId(c, 'savings');
  const investing = catId(c, 'investing');
  const brokerage = makeCategory(c, { name: 'Brokerage', cat_type: 'transfer' });
  const m1 = monthsAgo(1);
  const m2 = monthsAgo(2);

  insertTx(c, { date: m1.date, amount: 600, description: 'WEB PMTS VGRD*8891', category_id: investing });
  insertTx(c, { date: m2.date, amount: 400, description: 'VANGUARD BUY 44120', category_id: investing });
  insertTx(c, { date: m1.date, amount: 300, description: 'ALLY SAVE', category_id: savings });
  insertTx(c, { date: m2.date, amount: 150, description: 'SCHWAB TRANSFER', category_id: brokerage });

  const r = c.get('/api/transfers?window=12');
  // A band is named by its CATEGORY, not by any description: two descriptions
  // sharing nothing are one band because the statement puts them on one row.
  assert.deepEqual(r.body.accounts.map((a) => a.name), ['Investing', 'Savings', 'Brokerage']);

  const inv = r.body.accounts[0];
  assert.equal(inv.total, 1000);
  assert.equal(inv.monthly[m1.ym], 600);
  assert.equal(inv.monthly[m2.ym], 400);
  // The ledger link carries the stable key, so a renamed account keeps it.
  assert.equal(inv.cat, 'investing');
  assert.equal(r.body.accounts[2].cat, `cat_${brokerage}`);

  // A row re-typed away from transfer takes its whole band off the report.
  c.conn.db().prepare("UPDATE categories SET cat_type = 'expense' WHERE id = ?").run(brokerage);
  const r2 = c.get('/api/transfers?window=12');
  assert.deepEqual(r2.body.accounts.map((a) => a.name), ['Investing', 'Savings']);
  assert.equal(r2.body.total, 1300);
});

test('transfers: the stack always totals the line', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const m1 = monthsAgo(1);

  // Nine transfer rows, one more than the eight the palette can colour. The
  // ninth must fold into OTHER or the two charts would not match.
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
  names.forEach((n, i) => {
    const id = makeCategory(c, { name: n, cat_type: 'transfer' });
    insertTx(c, { date: m1.date, amount: (names.length - i) * 100, description: `${n} Fund`, category_id: id });
  });

  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.accounts.length, 9, 'eight coloured accounts + Other');

  const other = r.body.accounts[8];
  assert.equal(other.key, '__other__');
  assert.equal(other.name, 'Other');
  assert.equal(other.cat, null, 'Other is more than one account, so it cannot filter the ledger');
  assert.equal(other.total, 100); // India, the smallest

  const stacked = r.body.accounts.reduce((sum, m) => sum + (m.monthly[m1.ym] || 0), 0);
  assert.equal(Math.round(stacked * 100) / 100, r.body.monthly[m1.ym]);
  assert.equal(r.body.monthly[m1.ym], r.body.total);
});

test('transfers: an empty ledger answers with the months and nothing else', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const r = c.get('/api/transfers?window=6');
  assert.equal(r.status, 200);
  assert.equal(r.body.months.length, 6);
  assert.equal(r.body.total, 0);
  assert.deepEqual(r.body.monthly, {});
  assert.deepEqual(r.body.accounts, []);
  assert.equal(r.body.everTransferred, false, 'never put anything away, so the empty state offers a way to start');
});

test('transfers: everTransferred ignores the window', (t) => {
  const c = makeClient(t);
  activateWindow(c);
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

test('transfers: a typed Cash Flow cell carries the line and stays in its band', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const investing = catId(c, 'investing');
  const m1 = monthsAgo(1);
  const m2 = monthsAgo(2);

  insertTx(c, { date: m1.date, amount: 600, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m2.date, amount: 400, description: 'VANGUARD BUY', category_id: investing });

  // Claim the newest month's investing cell; the older month stays computed.
  const r0 = c.post('/api/entry', { ...entryCell(m1.ym), category: 'investing', value: 900 });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));

  let r = c.get('/api/transfers?window=12');
  assert.equal(r.body.monthly[m1.ym], 900, 'the typed cell is what the line plots');
  assert.equal(r.body.monthly[m2.ym], 400, 'the untouched cell stays computed');
  assert.equal(r.body.total, 1300);

  // Reading the statement's own rows is what keeps a typed cell IN its band:
  // there is nothing left to attribute, so nothing has to fall back to Other.
  assert.equal(r.body.accounts.length, 1);
  const inv = r.body.accounts[0];
  assert.equal(inv.name, 'Investing');
  assert.equal(inv.total, 1300);
  assert.equal(inv.monthly[m1.ym], 900);

  const stacked = r.body.accounts.reduce((sum, m) => sum + (m.monthly[m1.ym] || 0), 0);
  assert.equal(Math.round(stacked * 100) / 100, r.body.monthly[m1.ym]);

  // Clearing the entry releases the cell back to the computed value.
  assert.equal(c.del('/api/entry', { ...entryCell(m1.ym), category: 'investing' }).status, 200);
  r = c.get('/api/transfers?window=12');
  assert.equal(r.body.monthly[m1.ym], 600);
  assert.equal(r.body.accounts[0].total, 1000);
});

test('transfers: a hand-entered cell needs no transaction behind it', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const m1 = monthsAgo(1);

  const r0 = c.post('/api/entry', { ...entryCell(m1.ym), category: 'savings', value: 250 });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));

  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.total, 250);
  assert.equal(r.body.monthly[m1.ym], 250);
  assert.deepEqual(r.body.accounts.map((a) => a.name), ['Savings']);
  assert.equal(r.body.everTransferred, true, 'a typed cell is saving, so the empty state must not offer a first one');
});

test('transfers: a year with no year-table is off the report', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const investing = catId(c, 'investing');
  const m1 = monthsAgo(1);

  insertTx(c, { date: m1.date, amount: 500, description: 'VANGUARD BUY', category_id: investing });
  assert.equal(c.get('/api/transfers?window=12').body.total, 500);

  // Opting the year out (what DELETE /api/year does) takes its months off the
  // chart entirely — they are not plotted as zero.
  c.conn.db().prepare('DELETE FROM active_years WHERE year = ?').run(Number(m1.ym.slice(0, 4)));
  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.total, 0);
  assert.ok(!r.body.months.some((m) => m.slice(0, 4) === m1.ym.slice(0, 4)));
  assert.deepEqual(r.body.accounts, []);
});

test('transfers: an uncategorized transfer has no cell, so it gets its own band', (t) => {
  const c = makeClient(t);
  activateWindow(c);
  const investing = catId(c, 'investing');
  const m1 = monthsAgo(1);

  // The statement gives an uncategorized transfer no row (it is not spending and
  // not income), so nothing can override it and the ledger speaks for it.
  insertTx(c, { date: m1.date, amount: 500, description: 'VANGUARD BUY', category_id: investing });
  insertTx(c, { date: m1.date, amount: 120, description: 'ALLY SAVINGS XFER', category_id: null, tx_type: 'transfer' });

  const r = c.get('/api/transfers?window=12');
  assert.equal(r.body.total, 620);
  const uncat = r.body.accounts.find((a) => a.key === '__uncategorized__');
  assert.ok(uncat, 'counted in the line, so it needs a band of its own');
  assert.equal(uncat.total, 120);
  assert.equal(uncat.cat, null, '"uncategorized AND moved" is not a filter the ledger can express');

  // And it stays off the statement's uncategorized-EXPENSE bucket.
  const d = c.get('/api/data').body;
  const cells = d.entries[m1.ym.slice(0, 4)]?.[entryCell(m1.ym).month] || {};
  assert.equal(cells.uncat_expense, undefined);
});
