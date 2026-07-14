'use strict';

// Port of tests/test_transactions.py, tests/test_match_rules.py,
// tests/test_predictions.py (API half), and tests/test_credit_cards.py
// (API half — the pure helpers are covered in services.test.js).

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');
const { addMonths, localTodayIso } = require('../services/predictions');

// ── Shared helpers (mirrors of the Python test helpers) ──────────────────────

const getCategories = (c) => c.get('/api/transactions').body.categories;
const firstCat = (c, catType) => getCategories(c).find((x) => x.cat_type === catType);

function makeCategory(c, name, catType = 'expense') {
  const r = c.post('/api/categories', { name, cat_type: catType });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.category.id;
}

function createTx(c, desc, { catId = null, amount = 10.0, txType = 'expense', d = '2026-06-01' } = {}) {
  const payload = { date: d, description: desc, tx_type: txType, amount };
  if (catId !== null) payload.category_id = catId;
  const r = c.post('/api/transactions', payload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.transaction;
}

function importRows(c, descs, txType = 'expense') {
  const rows = descs.map((d) => ({
    date: '2026-06-05',
    description: d,
    tx_type: txType,
    amount: 5.0,
  }));
  const r = c.post('/api/transactions/import', { rows });
  assert.equal(r.status, 200);
  return r.body;
}

const txByDesc = (c, desc) =>
  c.get('/api/transactions').body.transactions.filter((t) => t.description === desc);

function setSetting(c, key, value) {
  const r = c.put(`/api/app-settings/${key}`, { value });
  assert.equal(r.status, 200);
}

// ── test_transactions.py ──────────────────────────────────────────────────────

test('tx_type derived from category', (t) => {
  const c = makeClient(t);
  const income = firstCat(c, 'income');
  const r = c.post('/api/transactions', {
    date: '2026-01-15',
    description: 'Paycheck',
    tx_type: 'expense', // contradicts the category on purpose
    category_id: income.id,
    amount: 100,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.transaction.tx_type, 'income');
});

test('uncategorized tx keeps explicit type', (t) => {
  const c = makeClient(t);
  const tx = createTx(c, 'Cash gift', { txType: 'income', amount: 50, d: '2026-01-15' });
  assert.equal(tx.category_id, null);
  assert.equal(tx.tx_type, 'income');
});

test('uncategorized-count reflects NULL-category rows', (t) => {
  const c = makeClient(t);
  const expense = firstCat(c, 'expense');
  assert.equal(c.get('/api/transactions/uncategorized-count').body.count, 0);

  createTx(c, 'gift', { txType: 'income', amount: 50 });
  const coffee = createTx(c, 'coffee', { amount: 4 });
  createTx(c, 'rent', { catId: expense.id, amount: 1500 }); // already categorized
  assert.equal(c.get('/api/transactions/uncategorized-count').body.count, 2);

  // Categorizing an uncategorized row drops the count by one.
  c.put(`/api/transactions/${coffee.id}`, { category_id: expense.id });
  assert.equal(c.get('/api/transactions/uncategorized-count').body.count, 1);
});

test('new category lands at the end of its own type block, not the global end', (t) => {
  const c = makeClient(t);
  // Cash Flow columns and the ledger dropdown render in flat position order,
  // so a global MAX+1 append would park a new income category past Investing.
  const ids = {
    income: makeCategory(c, 'Freelance', 'income'),
    expense: makeCategory(c, 'Pets', 'expense'),
    savings: makeCategory(c, 'Vacation Fund', 'savings'),
    investing: makeCategory(c, 'Crypto', 'investing'),
  };

  const cats = c.get('/api/categories').body.categories; // ORDER BY position
  // Type blocks stay contiguous, in canonical order.
  const types = cats.map((x) => x.cat_type);
  const runs = types.filter((tp, i) => i === 0 || tp !== types[i - 1]);
  assert.deepEqual(runs, ['income', 'expense', 'savings', 'investing']);
  // Each new category is the last row of its own block.
  for (const [tp, id] of Object.entries(ids)) {
    const ofType = cats.filter((x) => x.cat_type === tp);
    assert.equal(ofType[ofType.length - 1].id, id);
  }
  // Positions stay unique and contiguous 0..N-1 after the shifts.
  assert.deepEqual(
    cats.map((x) => x.position).sort((a, b) => a - b),
    cats.map((_, i) => i)
  );
  // The Cash Flow columns payload sees the same order.
  assert.deepEqual(
    c.get('/api/data').body.columns.map((x) => x.key),
    cats.map((x) => x.key)
  );

  // Fallback: a type with no rows left inserts after the nearest earlier block.
  for (const cat of cats.filter((x) => x.cat_type === 'savings')) {
    assert.equal(c.del(`/api/categories/${cat.id}`).status, 200);
  }
  makeCategory(c, 'Rainy Day', 'savings');
  const after = c.get('/api/categories').body.categories.map((x) => x.cat_type);
  assert.deepEqual(
    after.filter((tp, i) => i === 0 || tp !== after[i - 1]),
    ['income', 'expense', 'savings', 'investing']
  );
});

test('category retype updates transactions', (t) => {
  const c = makeClient(t);
  const cat = firstCat(c, 'expense');
  const tx = createTx(c, 'Refundable thing', { catId: cat.id, amount: 10, d: '2026-02-01' });
  assert.equal(c.put(`/api/categories/${cat.id}`, { cat_type: 'income' }).status, 200);
  const row = c.get('/api/transactions').body.transactions.find((x) => x.id === tx.id);
  assert.equal(row.tx_type, 'income');
});

test('categorize-similar derives type from the category', (t) => {
  const c = makeClient(t);
  const income = firstCat(c, 'income');
  const ids = ['2026-03-01', '2026-03-02'].map(
    (d) => createTx(c, 'Employer Inc', { d, amount: 1 }).id
  );
  const r = c.post('/api/transactions/categorize-similar', { ids, category_id: income.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.updated, 2);
  for (const row of c.get('/api/transactions').body.transactions) {
    if (ids.includes(row.id)) {
      assert.equal(row.category_id, income.id);
      assert.equal(row.tx_type, 'income');
    }
  }
});

test('amount stored as rounded magnitude', (t) => {
  const c = makeClient(t);
  const tx = createTx(c, 'rounding', { amount: -12.3456, d: '2026-01-01' });
  assert.equal(tx.amount, 12.35);
});

// ── Clean display names (no Python ancestor) ─────────────────────────────────
// Imports get a curated display_name when the MERCHANT lexicon recognizes the
// row — dictionary lookup only, never a string generated from the description.
// The stored description is never touched (matching, dedup, search and export
// key off it).

test('import names lexicon merchants; description keeps the raw string', (t) => {
  const c = makeClient(t);
  const raw = 'NETFLIX.COM 866-579-7172 CA';
  importRows(c, [raw, 'Lunch with Sam']);

  const named = txByDesc(c, raw)[0];
  assert.equal(named.display_name, 'Netflix');
  assert.equal(named.description, raw);

  // A row the merchant lexicon doesn't recognize stays unnamed — no attempt,
  // no failure.
  assert.equal(txByDesc(c, 'Lunch with Sam')[0].display_name, null);
});

test('keyword-tier categorization names nothing (kind, not identity)', (t) => {
  const c = makeClient(t);
  const raw = 'SQ *BLUE BOTTLE COFFEE 866-123-4567 CA';
  const result = importRows(c, [raw]);
  assert.equal(result.auto_categorized, 1); // 'coffee' keyword → dining
  assert.equal(txByDesc(c, raw)[0].display_name, null);
});

test('hand-entered transactions get no display_name', (t) => {
  const c = makeClient(t);
  const tx = createTx(c, 'NETFLIX.COM');
  assert.equal(tx.display_name, null);
});

test('editing the description clears display_name; other edits keep it', (t) => {
  const c = makeClient(t);
  const raw = 'CHECKCARD 1234 SHELL OIL';
  importRows(c, [raw]);
  const tx = txByDesc(c, raw)[0];
  assert.equal(tx.display_name, 'Shell');

  // Non-description edits (and a payload re-sending the same description,
  // as bulk edit does) keep the clean name.
  let r = c.put(`/api/transactions/${tx.id}`, { amount: 12.5, description: raw });
  assert.equal(r.status, 200);
  assert.equal(r.body.transaction.display_name, 'Shell');

  // The user rewrote the description — it supersedes the derived name.
  r = c.put(`/api/transactions/${tx.id}`, { description: 'Gas fill-up' });
  assert.equal(r.status, 200);
  assert.equal(r.body.transaction.display_name, null);
});

test('display names respect the auto-match switch and skip identical names', (t) => {
  const c = makeClient(t);
  setSetting(c, 'tx_auto_match', 'off');
  importRows(c, ['NETFLIX.COM']);
  assert.equal(txByDesc(c, 'NETFLIX.COM')[0].display_name, null);

  setSetting(c, 'tx_auto_match', 'on');
  // The canonical name equals the description verbatim — nothing to reveal,
  // so nothing is stored.
  importRows(c, ['Netflix']);
  assert.equal(txByDesc(c, 'Netflix')[0].display_name, null);
});

test('rows categorized by a learned rule still get the merchant name', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'My Streaming');
  createTx(c, 'NETFLIX.COM', { catId: cat }); // teaches a MatchRule

  const result = importRows(c, ['NETFLIX.COM']);
  assert.equal(result.auto_categorized, 1); // via the learned rule, not the lexicon
  const rows = txByDesc(c, 'NETFLIX.COM').filter((x) => x.display_name != null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display_name, 'Netflix');
  assert.equal(rows[0].category_id, cat);
});

// ── test_match_rules.py ───────────────────────────────────────────────────────

test('import auto-categorizes exact match', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Streaming');
  createTx(c, 'NETFLIX.COM', { catId: cat });

  const result = importRows(c, ['NETFLIX.COM', 'Totally Unknown Shop']);
  assert.equal(result.auto_categorized, 1);
  assert.ok(txByDesc(c, 'NETFLIX.COM').every((x) => x.category_id === cat));
  assert.equal(txByDesc(c, 'Totally Unknown Shop')[0].category_id, null);
});

test('exact match is case- and space-insensitive', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Coffee');
  createTx(c, '  Blue Bottle   Coffee ', { catId: cat });
  importRows(c, ['blue bottle coffee']);
  assert.equal(txByDesc(c, 'blue bottle coffee')[0].category_id, cat);
});

test('create auto-categorizes and derives type', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Salary', 'income');
  createTx(c, 'ACME PAYROLL', { catId: cat, txType: 'income' });

  const tx = createTx(c, 'ACME PAYROLL', { txType: 'expense' });
  assert.equal(tx.category_id, cat);
  assert.equal(tx.tx_type, 'income');
});

test('update records rule; categorize-similar records rules', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Grocer');
  const a = createTx(c, 'GROCER TOWN #1');
  const b = createTx(c, 'GROCER TOWN #2');

  assert.equal(c.put(`/api/transactions/${a.id}`, { category_id: cat }).status, 200);
  assert.equal(
    c.post('/api/transactions/categorize-similar', { ids: [b.id], category_id: cat }).status,
    200
  );
  const result = importRows(c, ['GROCER TOWN #1', 'GROCER TOWN #2']);
  assert.equal(result.auto_categorized, 2);
});

test('uncategorizing forgets the rule', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Subs');
  const tx = createTx(c, 'StreamCo Monthly', { catId: cat });
  assert.equal(c.put(`/api/transactions/${tx.id}`, { category_id: null }).status, 200);

  const result = importRows(c, ['StreamCo Monthly']);
  assert.equal(result.auto_categorized, 0);
  assert.ok(txByDesc(c, 'StreamCo Monthly').every((x) => x.category_id === null));
});

test('explicit category is never overridden', (t) => {
  const c = makeClient(t);
  const catA = makeCategory(c, 'Match A');
  const catB = makeCategory(c, 'Match B');
  createTx(c, 'Corner Shop', { catId: catA });
  const tx = createTx(c, 'Corner Shop', { catId: catB });
  assert.equal(tx.category_id, catB);
});

test('auto-match can be turned off (and back on)', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Gas');
  createTx(c, 'GAS STATION', { catId: cat });

  setSetting(c, 'tx_auto_match', 'off');
  let result = importRows(c, ['GAS STATION']);
  assert.equal(result.auto_categorized, 0);
  assert.equal(txByDesc(c, 'GAS STATION').filter((x) => x.category_id === null).length, 1);

  setSetting(c, 'tx_auto_match', 'on');
  result = importRows(c, ['GAS STATION']);
  assert.equal(result.auto_categorized, 1);
});

test('app-settings defaults and validation', (t) => {
  const c = makeClient(t);
  assert.equal(c.get('/api/app-settings').body.tx_auto_match, 'on');
  assert.equal(c.put('/api/app-settings/tx_auto_match', { value: 'sometimes' }).status, 400);
  assert.equal(c.put('/api/app-settings/nonsense', { value: 'x' }).status, 404);
});

test('tx_fuzzy_threshold is no longer a stored setting', (t) => {
  const c = makeClient(t);
  assert.equal(!('tx_fuzzy_threshold' in c.get('/api/app-settings').body), true);
  assert.equal(c.put('/api/app-settings/tx_fuzzy_threshold', { value: '0.7' }).status, 404);
});

test('similar: threshold param — absent/garbage is exact, lower is fuzzy, clamped at 0.5', (t) => {
  const c = makeClient(t);
  createTx(c, 'acme grocery mart'); // uncategorized; ~0.80 similar to the needle
  const needle = encodeURIComponent('acme grocery store');

  // No threshold (and a garbage one) mean exact, so a non-identical row is left out.
  let r = c.get(`/api/transactions/similar?description=${needle}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.transactions.length, 0);
  r = c.get(`/api/transactions/similar?description=${needle}&threshold=loose`);
  assert.equal(r.body.transactions.length, 0);

  // Loosening the bar brings it in; a still-stricter bar keeps it out.
  r = c.get(`/api/transactions/similar?description=${needle}&threshold=0.5`);
  assert.equal(r.body.transactions.length, 1);
  assert.equal(r.body.transactions[0].description, 'acme grocery mart');
  r = c.get(`/api/transactions/similar?description=${needle}&threshold=0.95`);
  assert.equal(r.body.transactions.length, 0);

  // Below-range values clamp up to 0.5 rather than matching everything.
  createTx(c, 'utterly unrelated payee');
  r = c.get(`/api/transactions/similar?description=${needle}&threshold=0.01`);
  assert.ok(r.body.transactions.every((x) => x.description !== 'utterly unrelated payee'));
});

test('similar: include_categorized widens the pool; exclude_ids drops the edited rows', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Gym');
  // Uncategorized row first — categorizing `a` records a learned rule that
  // would otherwise auto-categorize `b` at creation.
  const b = createTx(c, 'monthly gym membership');
  const a = createTx(c, 'monthly gym membership', { catId: cat });
  const needle = encodeURIComponent('monthly gym membership');

  // Default pool: uncategorized only.
  let r = c.get(`/api/transactions/similar?description=${needle}`);
  assert.deepEqual(r.body.transactions.map((x) => x.id), [b.id]);

  // Widened pool: the categorized row joins in.
  r = c.get(`/api/transactions/similar?description=${needle}&include_categorized=1`);
  assert.deepEqual(r.body.transactions.map((x) => x.id).sort(), [a.id, b.id].sort());

  // The rows being edited are excluded.
  r = c.get(
    `/api/transactions/similar?description=${needle}&include_categorized=1&exclude_ids=${a.id},${b.id}`
  );
  assert.equal(r.body.transactions.length, 0);
});

test('categorize-similar: overwrite recategorizes already-categorized rows', (t) => {
  const c = makeClient(t);
  const catA = makeCategory(c, 'Match Old');
  const catB = makeCategory(c, 'Match New');
  const tx = createTx(c, 'Corner Bakery 22', { catId: catA });

  // Without overwrite the categorized row is guarded (existing behavior).
  let r = c.post('/api/transactions/categorize-similar', { ids: [tx.id], category_id: catB });
  assert.equal(r.body.updated, 0);

  r = c.post('/api/transactions/categorize-similar', {
    ids: [tx.id], category_id: catB, overwrite: true,
  });
  assert.equal(r.body.updated, 1);
  assert.equal(txByDesc(c, 'Corner Bakery 22')[0].category_id, catB);
});

test('auto-match catches near-identical descriptions at the fixed 0.92 bar', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Music');
  // Synthetic merchant the built-in lexicon doesn't know, so this isolates the
  // LEARNED fuzzy-match behavior from cold-start categorization.
  createTx(c, 'Zentrix Premium', { catId: cat });

  // Near-identical (≥ 0.92 similar) auto-matches with no setting involved.
  const result = importRows(c, ['Zentrix Premiums']);
  assert.equal(result.auto_categorized, 1);
  assert.ok(txByDesc(c, 'Zentrix Premiums').some((x) => x.category_id === cat));
});

test('fuzzy: far descriptions stay uncategorized', (t) => {
  const c = makeClient(t);
  makeCategory(c, 'Match Books');
  const cat = getCategories(c).find((x) => x.name === 'Match Books').id;
  createTx(c, 'City Bookstore Downtown', { catId: cat });
  // A non-describable merchant: below the fixed 0.92 bar AND one the built-in
  // categorizer abstains on, so this isolates fuzzy auto-match behavior (a real
  // word like "Hardware" would now be categorized shopping by the classifier).
  assert.equal(importRows(c, ['Qplex Kiosk 7743']).auto_categorized, 0);
});

test('fuzzy: ambiguous rules leave transaction alone', (t) => {
  const c = makeClient(t);
  const catA = makeCategory(c, 'Match Amb A');
  const catB = makeCategory(c, 'Match Amb B');
  createTx(c, 'acme store x1', { catId: catA });
  createTx(c, 'acme store x2', { catId: catB });

  assert.equal(importRows(c, ['acme store x']).auto_categorized, 0);
  assert.equal(txByDesc(c, 'acme store x')[0].category_id, null);
});

test('category delete drops its rules', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Doomed');
  const tx = createTx(c, 'Doomed Merchant', { catId: cat });
  c.put(`/api/transactions/${tx.id}`, { category_id: null });
  c.put(`/api/transactions/${tx.id}`, { category_id: cat });
  c.del(`/api/transactions/${tx.id}`);
  assert.equal(c.del(`/api/categories/${cat}`).status, 200);

  assert.equal(importRows(c, ['Doomed Merchant']).auto_categorized, 0);
});

test('DELETE /api/transactions wipes the whole ledger but nothing else', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Match Persist');
  // A learned rule (created by categorizing) must survive the wipe: deleting all
  // transactions clears only the ledger, not categories or match rules.
  const tx = createTx(c, 'Persist Merchant', { catId: cat });
  c.del(`/api/transactions/${tx.id}`); // leaves the rule behind
  createTx(c, 'One');
  createTx(c, 'Two');
  createTx(c, 'Three');
  assert.equal(c.get('/api/transactions').body.transactions.length, 3);

  const r = c.del('/api/transactions');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.deleted, 3);

  // Ledger empty…
  assert.equal(c.get('/api/transactions').body.transactions.length, 0);
  // …but the category and its learned rule are untouched: an import of the
  // remembered description still auto-categorizes.
  assert.ok(getCategories(c).some((x) => x.id === cat));
  assert.equal(importRows(c, ['Persist Merchant']).auto_categorized, 1);
});

test('DELETE /api/transactions on an empty ledger is a no-op', (t) => {
  const c = makeClient(t);
  const r = c.del('/api/transactions');
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 0);
});

test('import cold-categorizes known merchants via the built-in lexicon (no learned rules)', (t) => {
  const c = makeClient(t);
  const catId = (key) => getCategories(c).find((x) => x.key === key).id;

  // No prior categorizations exist, so this exercises the built-in lexicon: it
  // must catch recognizable merchants even in messy bank-export form, and leave
  // genuinely-unknown rows blank.
  const result = importRows(c, [
    'NETFLIX.COM',
    'POS DEBIT SHELL OIL 57210 HOUSTON TX',
    'ZZZ Unknown Corner Store',
  ]);
  assert.equal(result.auto_categorized, 2);
  assert.equal(txByDesc(c, 'NETFLIX.COM')[0].category_id, catId('entertainment'));
  assert.ok(
    txByDesc(c, 'POS DEBIT SHELL OIL 57210 HOUSTON TX').every(
      (x) => x.category_id === catId('automobile')
    )
  );
  assert.equal(txByDesc(c, 'ZZZ Unknown Corner Store')[0].category_id, null);
});

test('built-in categorization respects the direction guard and the on/off setting', (t) => {
  const c = makeClient(t);

  // A positive (income) row matching an expense merchant is left alone rather
  // than flipped into an expense category.
  let result = importRows(c, ['SHELL OIL REFUND'], 'income');
  assert.equal(result.auto_categorized, 0);
  assert.equal(txByDesc(c, 'SHELL OIL REFUND')[0].category_id, null);

  // Within the outflow family the guard permits refining the KIND: an imported
  // debit (sign says 'expense') to a named brokerage is an investing
  // contribution, and the row's tx_type follows the category.
  const investingId = getCategories(c).find((x) => x.key === 'investing').id;
  result = importRows(c, ['ROBINHOOD FUNDS 4412']);
  assert.equal(result.auto_categorized, 1);
  const rh = txByDesc(c, 'ROBINHOOD FUNDS 4412')[0];
  assert.equal(rh.category_id, investingId);
  assert.equal(rh.tx_type, 'investing');

  // But an INFLOW from a brokerage is a withdrawal, not income — it must stay
  // blank rather than cross the inflow/outflow line.
  result = importRows(c, ['ROBINHOOD FUNDS 8821'], 'income');
  assert.equal(result.auto_categorized, 0);
  assert.equal(txByDesc(c, 'ROBINHOOD FUNDS 8821')[0].category_id, null);

  // Turning auto-match off disables the built-in pass too.
  setSetting(c, 'tx_auto_match', 'off');
  result = importRows(c, ['NETFLIX.COM']);
  assert.equal(result.auto_categorized, 0);
  assert.equal(txByDesc(c, 'NETFLIX.COM')[0].category_id, null);
});

// ── test_predictions.py (API half) ────────────────────────────────────────────

const TODAY = localTodayIso();

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function seedMonthly(c, catId, desc, amount, lastIso, n = 4) {
  for (let i = 0; i < n; i++) {
    createTx(c, `${desc} #${100 + i}`, { catId, amount, d: isoAddDays(lastIso, -30 * i) });
  }
}

const getUpcoming = (c, params = '') => {
  const r = c.get(`/api/predictions/upcoming${params}`);
  assert.equal(r.status, 200);
  return r.body.upcoming;
};

test('predictions: monthly subscription detected with full payload', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Bills A');
  const last = isoAddDays(TODAY, -10);
  seedMonthly(c, cat, 'NETFLIX', 15.99, last);

  const items = getUpcoming(c);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.cycle, 'monthly');
  assert.equal(item.amount, 15.99);
  assert.equal(item.occurrences, 4);
  assert.equal(item.description, 'NETFLIX #100');
  const expectedDue = addMonths(last, 1);
  assert.equal(item.next_date, expectedDue);
  assert.equal(
    item.due_in_days,
    Math.round((Date.parse(expectedDue) - Date.parse(TODAY)) / 86400000)
  );
  assert.equal(item.last_date, last);
  assert.ok(item.confidence > 0 && item.confidence <= 1);
});

test('predictions: irregular spending not detected', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Groceries');
  [3, 13, 23, 60, 100, 145].forEach((offset, i) => {
    createTx(c, 'Corner Grocer', { catId: cat, amount: 20 + i * 7, d: isoAddDays(TODAY, -offset) });
  });
  assert.deepStrictEqual(getUpcoming(c), []);
});

test('predictions: two occurrences not enough', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Bills B');
  seedMonthly(c, cat, 'Gym Membership', 30.0, isoAddDays(TODAY, -5), 2);
  assert.deepStrictEqual(getUpcoming(c), []);
});

test('predictions: lapsed subscription excluded', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Bills C');
  seedMonthly(c, cat, 'Old Magazine', 9.99, isoAddDays(TODAY, -80));
  assert.deepStrictEqual(getUpcoming(c), []);
});

test('predictions: income not included', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Salary', 'income');
  seedMonthly(c, cat, 'ACME Payroll', 4200.0, isoAddDays(TODAY, -10));
  assert.deepStrictEqual(getUpcoming(c), []);
});

test('predictions: uncategorized expense detected via stored tx_type', (t) => {
  const c = makeClient(t);
  seedMonthly(c, null, 'Spotify', 11.99, isoAddDays(TODAY, -3));
  const items = getUpcoming(c);
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 11.99);
});

test('predictions: limit and ordering', (t) => {
  const c = makeClient(t);
  const cat = makeCategory(c, 'Pred Bills D');
  ['Aa', 'Bb', 'Cc', 'Dd', 'Ee', 'Ff'].forEach((name, j) => {
    const last = isoAddDays(TODAY, -(5 + j));
    for (let i = 0; i < 4; i++) {
      createTx(c, `Sub ${name}`, { catId: cat, amount: 10 + j, d: isoAddDays(last, -30 * i) });
    }
  });

  const items = getUpcoming(c);
  assert.equal(items.length, 5);
  assert.ok(items.every((it) => it.description !== 'Sub Aa'));
  const dates = items.map((it) => it.next_date);
  assert.deepStrictEqual(dates, [...dates].sort());
  assert.equal(getUpcoming(c, '?limit=6').length, 6);
});

// ── test_credit_cards.py (API half) ───────────────────────────────────────────

const categoryByKey = (c, key) =>
  c.get('/api/categories').body.categories.find((x) => x.key === key);

function makeCard(c, payload = {}) {
  const r = c.post('/api/credit-cards', payload);
  assert.equal(r.status, 200);
  return r.body.card;
}

const ccData = (c) => {
  const r = c.get('/api/credit-cards/data');
  assert.equal(r.status, 200);
  return r.body;
};

function addEntry(c, year, month, category, value) {
  const r = c.post('/api/entry', { year, month, category, value });
  assert.equal(r.status, 200);
}

function addTx(c, isoDate, amount, { catId = null, txType = 'expense' } = {}) {
  const payload = { date: isoDate, description: 'x', amount, tx_type: txType };
  if (catId !== null) payload.category_id = catId;
  assert.equal(c.post('/api/transactions', payload).status, 200);
}

test('cards: create defaults and data payload', (t) => {
  const c = makeClient(t);
  const card = makeCard(c);
  assert.equal(card.name, 'New Card');
  assert.equal(card.credit_limit, 0);
  assert.equal(card.rewards_pct, 0);
  assert.equal(card.annual_fee, 0);
  assert.equal(card.category_id, null);

  const data = ccData(c);
  assert.deepStrictEqual(data.cards.map((x) => x.id), [card.id]);
  const listed = new Set(data.categories.map((x) => x.id));
  const full = c.get('/api/categories').body.categories;
  assert.deepStrictEqual(
    listed,
    new Set(full.filter((x) => x.cat_type === 'expense').map((x) => x.id))
  );
  assert.deepStrictEqual(
    new Set(Object.keys(data.monthly_spend)),
    new Set([...listed].map(String))
  );
  assert.ok(Object.values(data.monthly_spend).every((v) => v === 0));
});

test('cards: update fields round and validate', (t) => {
  const c = makeClient(t);
  const card = makeCard(c);
  const r = c.put(`/api/credit-cards/${card.id}`, {
    name: '  Sapphire  ',
    credit_limit: 5000.005,
    rewards_pct: 1.5,
    annual_fee: 95,
  });
  assert.equal(r.status, 200);
  const updated = r.body.card;
  assert.equal(updated.name, 'Sapphire');
  assert.equal(updated.credit_limit, 5000.01);
  assert.equal(updated.rewards_pct, 1.5);
  assert.equal(updated.annual_fee, 95);

  for (const bad of [
    { credit_limit: -1 },
    { annual_fee: NaN },
    { rewards_pct: 101 },
    { rewards_pct: -0.5 },
    { credit_limit: true },
    { name: '   ' },
  ]) {
    assert.equal(c.put(`/api/credit-cards/${card.id}`, bad).status, 400, JSON.stringify(bad));
  }
});

test('cards: category assignment rules', (t) => {
  const c = makeClient(t);
  const card = makeCard(c);
  const groceries = categoryByKey(c, 'groceries');
  const income = categoryByKey(c, 'income');

  assert.equal(c.put(`/api/credit-cards/${card.id}`, { category_id: income.id }).status, 400);
  assert.equal(c.put(`/api/credit-cards/${card.id}`, { category_id: 999999 }).status, 404);
  assert.equal(c.put(`/api/credit-cards/${card.id}`, { category_id: 'groceries' }).status, 400);

  let r = c.put(`/api/credit-cards/${card.id}`, { category_id: groceries.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.card.category_id, groceries.id);

  r = c.put(`/api/credit-cards/${card.id}`, { category_id: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.card.category_id, null);
});

test('cards: delete card', (t) => {
  const c = makeClient(t);
  const card = makeCard(c);
  assert.equal(c.del(`/api/credit-cards/${card.id}`).status, 200);
  assert.deepStrictEqual(ccData(c).cards, []);
  assert.equal(c.del(`/api/credit-cards/${card.id}`).status, 404);
});

test('cards: category delete unlinks card', (t) => {
  const c = makeClient(t);
  const catId = c.post('/api/categories', { name: 'Hobbies', cat_type: 'expense' }).body.category
    .id;
  const card = makeCard(c);
  c.put(`/api/credit-cards/${card.id}`, { category_id: catId });

  assert.equal(c.del(`/api/categories/${catId}`).status, 200);
  assert.equal(ccData(c).cards[0].category_id, null);
});

test('cards: manual entries average when no transactions exist', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addEntry(c, 2026, 'January', 'groceries', 300);
  addEntry(c, 2026, 'February', 'groceries', 100);
  addEntry(c, 2026, 'March', 'groceries', 0); // no spend -> skipped
  assert.equal(ccData(c).monthly_spend[String(groceries.id)], 200.0);
});

test('cards: cells compute from transactions; an entry overrides its one cell', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addTx(c, '2026-01-05', 100, { catId: groceries.id });
  addTx(c, '2026-01-20', 50, { catId: groceries.id });
  addTx(c, '2026-03-02', 250, { catId: groceries.id });
  assert.equal(ccData(c).monthly_spend[String(groceries.id)], 200.0); // (150 + 250) / 2

  // Overriding January replaces that cell's computed 150 outright.
  addEntry(c, 2026, 'January', 'groceries', 350);
  assert.equal(ccData(c).monthly_spend[String(groceries.id)], 300.0); // (350 + 250) / 2
});

test('cards: uncategorized expense bucket', (t) => {
  const c = makeClient(t);
  const uncat = categoryByKey(c, 'uncat_expense');
  addTx(c, '2026-02-10', 120);
  addTx(c, '2026-02-12', 80, { txType: 'income' });

  assert.equal(ccData(c).monthly_spend[String(uncat.id)], 120.0);
});

// ── Per-cell precedence: computed by default, an Entry overrides its cell ────

const getData = (c) => {
  const r = c.get('/api/data');
  assert.equal(r.status, 200);
  return r.body;
};

test('data: cells compute from transactions with zero configuration', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addTx(c, '2026-01-05', 100, { catId: groceries.id });
  addTx(c, '2026-01-20', 50, { catId: groceries.id });
  // Uncategorized expense — a distinct description so the rules learned from
  // the categorized rows above don't auto-match it.
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-02-02', description: 'zzqx delta', amount: 40, tx_type: 'expense',
    }).status,
    200
  );

  const d = getData(c);
  assert.equal(d.entries['2026'].January.groceries, 150);
  assert.equal(d.entries['2026'].February.uncat_expense, 40);
  // The layers ship alongside the blend, for the statement UI's provenance
  // styling and computed-shadow tooltips.
  assert.equal(d.computed['2026'].January.groceries, 150);
  assert.equal(d.manual['2026'], undefined);
});

test('data: a manual entry overrides its one cell; deleting it reverts to computed', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addTx(c, '2026-01-05', 100, { catId: groceries.id });
  addTx(c, '2026-02-08', 60, { catId: groceries.id });

  addEntry(c, 2026, 'January', 'groceries', 9999);
  let d = getData(c);
  assert.equal(d.entries['2026'].January.groceries, 9999); // override wins its cell
  assert.equal(d.entries['2026'].February.groceries, 60); // sibling cell still computed
  assert.equal(d.computed['2026'].January.groceries, 100); // shadow value still shipped
  assert.equal(d.manual['2026'].January.groceries, 9999);

  // Clearing the entry releases the cell back to the computed value.
  assert.equal(
    c.del('/api/entry', { year: 2026, month: 'January', category: 'groceries' }).status,
    200
  );
  d = getData(c);
  assert.equal(d.entries['2026'].January.groceries, 100);
  assert.equal(d.manual['2026'], undefined);
});

test('data: manual bookkeeping works with no transactions at all', (t) => {
  const c = makeClient(t);
  addEntry(c, 2026, 'January', 'income', 4000);
  addEntry(c, 2026, 'January', 'rent', 1500);
  const d = getData(c);
  assert.equal(d.entries['2026'].January.income, 4000);
  assert.equal(d.entries['2026'].January.rent, 1500);
});

test('data: transactions in a year with no year-table contribute nothing', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addTx(c, '2019-05-05', 75, { catId: groceries.id }); // 2019 is not an active year
  const d = getData(c);
  assert.ok(!d.years.includes(2019));
  assert.equal(d.entries['2019'], undefined);
  // Creating the year-table is all it takes for the activity to appear.
  assert.equal(c.post('/api/year', { year: 2019 }).status, 200);
  assert.equal(getData(c).entries['2019'].May.groceries, 75);
});

test('data: deleting a year drops its entries and its computed cells', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  c.post('/api/year', { year: 2030 });
  addTx(c, '2030-04-01', 10, { catId: groceries.id });
  addEntry(c, 2030, 'May', 'groceries', 20);
  assert.equal(c.del('/api/year/2030').status, 200);
  const d = getData(c);
  assert.ok(!d.years.includes(2030));
  assert.equal(d.entries['2030'], undefined);
});

test('data: duplicating a year copies the manual overrides only', (t) => {
  const c = makeClient(t);
  const groceries = categoryByKey(c, 'groceries');
  addTx(c, '2026-01-05', 100, { catId: groceries.id }); // computed in 2026
  addEntry(c, 2026, 'March', 'groceries', 77); // manual override in 2026

  assert.equal(c.post('/api/year/2026/duplicate', { target_year: 2027 }).status, 200);
  const d = getData(c);
  // The override travels; the computed cell recomputes from 2027's (empty) ledger.
  assert.equal(d.entries['2027'].March.groceries, 77);
  assert.equal(d.entries['2027'].January, undefined);
});

test('data: the retired per-year sync endpoint is gone', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/year/2026/sync', { category: 'groceries', sync: true }).status, 404);
  assert.ok(!('sync' in getData(c)));
});

test('import: auto-creates year-tables for the years it touches', (t) => {
  const c = makeClient(t);
  const r = c.post('/api/transactions/import', {
    rows: [
      { date: '2024-03-01', description: 'zzqx alpha', tx_type: 'expense', amount: 5 },
      { date: '2023-11-20', description: 'zzqx beta', tx_type: 'expense', amount: 7 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const d = getData(c);
  // Both imported years now exist on the Cash Flow statement, and their cells
  // already carry the imported (uncategorized) sums.
  assert.ok(d.years.includes(2023) && d.years.includes(2024));
  assert.equal(d.entries['2024'].March.uncat_expense, 5);
  assert.equal(d.entries['2023'].November.uncat_expense, 7);

  // …and the matching Balance Sheet years are created in lockstep, so both
  // /statements tabs show the same year rolodex.
  const b = c.get('/api/balance/data').body;
  assert.ok(b.years.includes(2023) && b.years.includes(2024));
});

test('import: never disturbs manual overrides in an existing year', (t) => {
  const c = makeClient(t);
  addEntry(c, 2026, 'February', 'groceries', 500); // manual override
  const groceries = categoryByKey(c, 'groceries');
  const r = c.post('/api/transactions/import', {
    rows: [{ date: '2026-02-02', description: 'zzqx gamma', tx_type: 'expense', amount: 3, category_id: groceries.id }],
  });
  assert.equal(r.status, 200);
  // The override still wins its cell; the import's row is in the computed shadow.
  const d = getData(c);
  assert.equal(d.entries['2026'].February.groceries, 500);
  assert.equal(d.computed['2026'].February.groceries, 3);
});
