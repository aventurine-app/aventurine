'use strict';

// Top Merchants (Reports → Spending). Read-only over transactions. The window
// is relative to "now" and ENDS WITH the current, partial month (unlike Trends,
// which excludes it), so target dates are computed dynamically.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');
const { commonSearchTerm } = require('../services/merchantSearch');

function catId(c, key) {
  return c.conn.db().prepare('SELECT id FROM categories WHERE "key" = ?').get(key).id;
}

function insertTx(c, { date, description, amount, display_name = null, category_id = null, tx_type = 'expense' }) {
  c.conn
    .db()
    .prepare(
      `INSERT INTO transactions (date, description, display_name, category_id, amount, notes, tx_type)
       VALUES (?, ?, ?, ?, ?, '', ?)`
    )
    .run(date, description, display_name, category_id, amount, tx_type);
}

/** A mid-month date `monthsBack` calendar months ago. */
function monthsAgo(monthsBack) {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  return { ym, date: `${ym}-15` };
}

test('top merchants: ranks expense spend per merchant, highest first', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const income = catId(c, 'income');
  const savings = catId(c, 'savings'); // a TRANSFER category since v11

  const m0 = monthsAgo(0); // current, partial month — INCLUDED in the window
  const m2 = monthsAgo(2);

  insertTx(c, { date: m2.date, description: 'SQ *CAFE ROSSO 4471', amount: 12.5, category_id: food });
  insertTx(c, { date: m0.date, description: 'SQ *CAFE ROSSO 9920', amount: 20, category_id: food });
  insertTx(c, { date: m0.date, description: 'HILLTOP MARKET #221', amount: 90, category_id: food });
  // Income and transfers are not spending, however large.
  insertTx(c, { date: m0.date, description: 'PAYROLL DEPOSIT', amount: 5000, category_id: income });
  insertTx(c, { date: m0.date, description: 'AUTO SAVE', amount: 800, category_id: savings });

  const r = c.get('/api/top-merchants?window=3');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.window, 3);
  assert.equal(r.body.limit, 20);

  assert.deepEqual(r.body.merchants.map((m) => m.name),
    ['HILLTOP MARKET #221', 'SQ *CAFE ROSSO 9920']);
  assert.equal(r.body.merchants[0].total, 90);

  // Both café rows are one merchant: the key drops the trailing number.
  const cafe = r.body.merchants[1];
  assert.equal(cafe.total, 32.5);
  assert.equal(cafe.count, 2);
  assert.equal(cafe.last_date, m0.date);

  // Only spending is counted, so the deposit and the autosave rank nowhere.
  assert.equal(r.body.merchants.length, 2);
});

test('top merchants: a curated display name groups the brand and labels the bar', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const m1 = monthsAgo(1);

  // Two descriptions that share no useful substring — only the lexicon's
  // display name puts them on one bar.
  insertTx(c, { date: m1.date, description: 'SQ *BLUE BOTTLE 8842', display_name: 'Blue Bottle Coffee', amount: 6, category_id: food });
  insertTx(c, { date: m1.date, description: 'BLUEBOTTLECOFFEE.COM', display_name: 'Blue Bottle Coffee', amount: 24, category_id: food });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1);
  const m = r.body.merchants[0];
  assert.equal(m.name, 'Blue Bottle Coffee');
  assert.equal(m.total, 30);
  assert.equal(m.count, 2);
  // The ledger's Name filter matches display_name, so the curated name IS the
  // term that finds this bar's rows.
  assert.equal(m.search, 'Blue Bottle Coffee');
});

test('top merchants: an unnamed group links through the substring its rows share', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // A merchant absent from the lexicon, so this exercises tier 2. (A brand in the
  // lexicon resolves to a curated name and is searched as that.)
  insertTx(c, { date: m1.date, description: 'BRIGHTWATER LAUNDRY 8667797', amount: 15.49, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'BRIGHTWATER LAUNDRY 8667799', amount: 15.49, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1);
  // The shared substring, with the half-a-reference-number tail trimmed off.
  assert.equal(r.body.merchants[0].search, 'BRIGHTWATER LAUNDRY');
});

test('top merchants: the lexicon names a row at read time when nothing is stored', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // Rows imported before display_name existed (v8) carry NULL. Without the
  // read-time fallback the same brand gets two bars: one curated, one raw.
  insertTx(c, { date: m1.date, description: 'NETFLIX.COM 8667797', display_name: 'Netflix', amount: 15.49, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'NETFLIX.COM 8667799', display_name: null, amount: 15.49, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1, 'one brand, one bar');
  assert.equal(r.body.merchants[0].name, 'Netflix');
  assert.equal(r.body.merchants[0].count, 2);
});

test('top merchants: statement furniture in FRONT of the name does not split it', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // The case a positional key cannot handle alone: the noise comes before the
  // merchant, and "PMTS" survives NOISE_PATTERNS (which matches the singular
  // "pmt"). "SGQBDG" is a vowel-less reference code.
  insertTx(c, { date: m1.date, description: 'WEB PMTS Greenspring', amount: 100, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'GREENSPRING WEB PMTS ACH WEB-RECUR SGQBDG', amount: 50, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'Greenspring', amount: 25, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1, 'one landlord, one bar');
  assert.equal(r.body.merchants[0].total, 175);
  assert.equal(r.body.merchants[0].count, 3);
});

test('top merchants: a brand keeps digits at either end of its own name', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // Dropping every letter+digit token cost "5GUYS" its identity, leaving the
  // bar keyed on the terminal marker and the city instead.
  insertTx(c, { date: m1.date, description: '5GUYS 0062 QSR YORK PA', amount: 30, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: '5GUYS 0181 QSR YORK PA', amount: 20, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'ISC2.ORG WWW.ISC2.ORG VA', amount: 40, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.deepEqual(r.body.merchants.map((m) => m.count), [2, 1]);
  // Both branches group as one merchant, labelled with its own name.
  assert.ok(/5GUYS/i.test(r.body.merchants[0].name), r.body.merchants[0].name);
  assert.ok(/ISC2/i.test(r.body.merchants[1].name), r.body.merchants[1].name);
});

test('top merchants: an appended per-charge reference does not split a merchant', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // The failure this key was rewritten for: the tail is alphanumeric, so
  // dropping digits alone still left "9a2b"/"4cc1" as differing letters and the
  // one bodega became two bars. Note the leaked "DEBIT" in front — the reason
  // the key takes three leading tokens rather than two.
  insertTx(c, { date: m1.date, description: 'POS DEBIT GREEN LEAF BODEGA 9A2B PORTLAND OR', amount: 12, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'POS DEBIT GREEN LEAF BODEGA 4CC1 PORTLAND OR', amount: 18, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1, 'one merchant, one bar');
  assert.equal(r.body.merchants[0].total, 30);
  assert.equal(r.body.merchants[0].count, 2);
});

test('top merchants: merchants that merely share a leading word stay apart', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // Folding the tail must not fold the identity: these are two businesses that
  // differ inside the key's reach.
  insertTx(c, { date: m1.date, description: 'PIONEER DENTAL ASSOC 4471', amount: 40, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'PIONEER AUTO REPAIR 9920', amount: 30, tx_type: 'expense' });
  // A single distinguishing character is still a distinction — the key keeps
  // 1-character tokens for this reason.
  insertTx(c, { date: m1.date, description: 'KIOSK A 4471', amount: 10, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'KIOSK B 9920', amount: 5, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 4, 'four distinct merchants');
  assert.deepEqual(r.body.merchants.map((m) => m.total), [40, 30, 10, 5]);
});

test('top merchants: KEY_TOKENS=2 folds a distinction that lives in the 3rd token', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // The stated cost of the current strength setting, pinned so that raising or
  // lowering KEY_TOKENS is a visible decision rather than a silent drift: two
  // businesses sharing their first two tokens share a bar. Loosening to 3
  // separates these, at the price of splitting merchants whose location text
  // varies ("GIANT #6300 PA" vs "GIANT 6300 RED LION PA").
  insertTx(c, { date: m1.date, description: 'PIONEER DENTAL ASSOC 4471', amount: 40, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'PIONEER DENTAL LAB 9920', amount: 20, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1);
  assert.equal(r.body.merchants[0].total, 60);
});

test('top merchants: an unnamed bar\'s search term matches every row it counted', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // Grouping more rows per bar makes the shared substring shorter, so the
  // invariant the term exists for is worth asserting directly: whatever comes
  // back must find all of the bar's transactions, not just the newest one.
  const descs = [
    'SQ *HARBOR BAKERY 9A2B SEATTLE WA',
    'SQ *HARBOR BAKERY 4CC1 SEATTLE WA',
    'SQ *HARBOR BAKERY 7710 SEATTLE WA',
  ];
  for (const d of descs) insertTx(c, { date: m1.date, description: d, amount: 7, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 1);
  const { search, count } = r.body.merchants[0];
  assert.equal(count, 3);
  assert.ok(search, 'an unnamed bar with transactions has a search term');
  for (const d of descs) {
    assert.ok(
      d.toLowerCase().includes(search.toLowerCase()),
      `search ${JSON.stringify(search)} must be a substring of ${JSON.stringify(d)}`
    );
  }
});

test('top merchants: uncategorized expenses count, income/transfer rows do not', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  insertTx(c, { date: m1.date, description: 'CORNER STORE', amount: 40, tx_type: 'expense' });
  insertTx(c, { date: m1.date, description: 'VENMO FROM ALEX', amount: 60, tx_type: 'income' });
  insertTx(c, { date: m1.date, description: 'TO BROKERAGE', amount: 500, tx_type: 'transfer' });

  const r = c.get('/api/top-merchants?window=12');
  assert.deepEqual(r.body.merchants.map((m) => m.name), ['CORNER STORE']);
});

test('top merchants: a row that names no merchant is skipped', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  insertTx(c, { date: m1.date, description: '4471 90210', amount: 25, tx_type: 'expense' }); // digits only
  insertTx(c, { date: m1.date, description: 'CORNER STORE', amount: 40, tx_type: 'expense' });

  const r = c.get('/api/top-merchants?window=12');
  assert.deepEqual(r.body.merchants.map((m) => m.name), ['CORNER STORE']);
});

test('top merchants: the window bounds which months are ranked', (t) => {
  const c = makeClient(t);
  const m0 = monthsAgo(0);
  const m4 = monthsAgo(4);
  const m20 = monthsAgo(20);

  insertTx(c, { date: m0.date, description: 'RECENT SHOP', amount: 10, tx_type: 'expense' });
  insertTx(c, { date: m4.date, description: 'MIDDLE SHOP', amount: 20, tx_type: 'expense' });
  insertTx(c, { date: m20.date, description: 'OLD SHOP', amount: 30, tx_type: 'expense' });

  const names = (w) => c.get(`/api/top-merchants?window=${w}`).body.merchants.map((m) => m.name);
  assert.deepEqual(names(3), ['RECENT SHOP']);
  assert.deepEqual(names(6), ['MIDDLE SHOP', 'RECENT SHOP']);
  assert.deepEqual(names(12), ['MIDDLE SHOP', 'RECENT SHOP']);
  assert.deepEqual(names('all'), ['OLD SHOP', 'MIDDLE SHOP', 'RECENT SHOP']);

  // `from` discloses the first month included; 'all' has no lower bound.
  assert.equal(c.get('/api/top-merchants?window=3').body.from, monthsAgo(2).ym);
  assert.equal(c.get('/api/top-merchants?window=all').body.from, null);
});

test('top merchants: window clamps to {3,6,12,24,60,all}', (t) => {
  const c = makeClient(t);
  assert.equal(c.get('/api/top-merchants').body.window, 12); // default
  assert.equal(c.get('/api/top-merchants?window=7').body.window, 12); // invalid → default
  assert.equal(c.get('/api/top-merchants?window=0').body.window, 12);
  assert.equal(c.get('/api/top-merchants?window=ALL').body.window, 'all'); // case-insensitive
  assert.equal(c.get('/api/top-merchants?window=3').body.window, 3);
  assert.equal(c.get('/api/top-merchants?window=6').body.window, 6);
  assert.equal(c.get('/api/top-merchants?window=24').body.window, 24);
  assert.equal(c.get('/api/top-merchants?window=60').body.window, 60);
});

test('top merchants: caps at 20 bars, ranked highest to lowest', (t) => {
  const c = makeClient(t);
  const m1 = monthsAgo(1);

  // 25 merchants, each spending its index amount, so the top 20 are 25 down to
  // 6.
  for (let i = 1; i <= 25; i++) {
    insertTx(c, { date: m1.date, description: `SHOP ${String.fromCharCode(64 + i)}`, amount: i, tx_type: 'expense' });
  }

  const r = c.get('/api/top-merchants?window=12');
  assert.equal(r.body.merchants.length, 20);
  assert.equal(r.body.merchants[0].total, 25);
  assert.equal(r.body.merchants[19].total, 6);
  const totals = r.body.merchants.map((m) => m.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), 'highest to lowest');
});

test('search term: falls back to the newest description when the shared part is unusable', () => {
  // Rows can share nothing but the reference number they happen to collide on.
  // Trimming that leaves no letters, so there is nothing to search on — the
  // term falls back to the most recent full description rather than going null
  // and leaving the bar unclickable.
  assert.equal(commonSearchTerm(['AB 4471', 'CD 4471']), 'CD 4471');
  // Nothing to search on at all (a schedule with no backing transactions).
  assert.equal(commonSearchTerm([]), null);
  // When every description matched, the term stays the exact whole description.
  assert.equal(commonSearchTerm(['CORNER STORE', 'CORNER STORE']), 'CORNER STORE');
});

test('top merchants: an empty ledger answers with an empty ranking', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/top-merchants?window=all');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.merchants, []);
});

test('top merchants: each bar carries the category it spent the most in', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const shopping = catId(c, 'shopping');
  const m0 = monthsAgo(0);

  // One merchant, two categories: the bar takes the dominant one, not the
  // newest row's — a hardware store's rows really do land in two places.
  insertTx(c, { date: m0.date, description: 'PINEHILL HARDWARE', amount: 300, category_id: shopping });
  insertTx(c, { date: m0.date, description: 'PINEHILL HARDWARE', amount: 40, category_id: food });
  // Uncategorized spend answers to the key Trends ships for the statement's
  // uncategorized bucket, so both cards colour it from the same entry.
  insertTx(c, { date: m0.date, description: 'CORNER KIOSK', amount: 25 });

  const byName = Object.fromEntries(
    c.get('/api/top-merchants?window=12').body.merchants.map((m) => [m.name, m.category])
  );
  assert.equal(byName['PINEHILL HARDWARE'], 'shopping');
  assert.equal(byName['CORNER KIOSK'], '__uncategorized__');
});

test('top merchants: total is the whole window, not just the ranked bars', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const m0 = monthsAgo(0);

  insertTx(c, { date: m0.date, description: 'HILLTOP MARKET', amount: 60, category_id: food });
  // No merchant key can be built from a bare reference code, so this row is on
  // no bar — but it was still spent, and the bars are shares of what was spent.
  insertTx(c, { date: m0.date, description: '4471', amount: 40, category_id: food });

  const body = c.get('/api/top-merchants?window=12').body;
  assert.equal(body.total, 100);
  assert.equal(body.merchants.length, 1);
  assert.equal(body.merchants[0].total, 60);
});

test('top merchants: a category narrows the ranking and the total with it', (t) => {
  const c = makeClient(t);
  const food = catId(c, 'food');
  const shopping = catId(c, 'shopping');
  const m0 = monthsAgo(0);

  insertTx(c, { date: m0.date, description: 'HILLTOP MARKET', amount: 60, category_id: food });
  insertTx(c, { date: m0.date, description: 'PINEHILL HARDWARE', amount: 300, category_id: shopping });
  insertTx(c, { date: m0.date, description: 'CORNER KIOSK', amount: 25 });

  const r = c.get('/api/top-merchants?window=12&category=food');
  assert.equal(r.status, 200);
  assert.equal(r.body.category, 'food');
  assert.deepEqual(r.body.merchants.map((m) => m.name), ['HILLTOP MARKET']);
  // The denominator narrows too, so a filtered bar is a share of what was spent
  // in THAT category rather than of the whole window.
  assert.equal(r.body.total, 60);

  // Uncategorized spend answers to the synthetic key Trends ships for the
  // statement's uncategorized bucket, since that is what the rail selects with.
  const u = c.get('/api/top-merchants?window=12&category=__uncategorized__');
  assert.deepEqual(u.body.merchants.map((m) => m.name), ['CORNER KIOSK']);
  assert.equal(u.body.total, 25);
});

test('top merchants: an unknown category is a 404, not an empty ranking', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/top-merchants?window=12&category=nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('top merchants: no category means no filter', (t) => {
  const c = makeClient(t);
  const m0 = monthsAgo(0);
  insertTx(c, { date: m0.date, description: 'HILLTOP MARKET', amount: 60 });

  const r = c.get('/api/top-merchants?window=12&category=');
  assert.equal(r.status, 200);
  assert.equal(r.body.category, null);
  assert.equal(r.body.merchants.length, 1);
});
