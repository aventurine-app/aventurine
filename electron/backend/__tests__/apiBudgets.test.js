'use strict';

// Budgets: the one monthly target per category behind the Budgets page
// (handlers/budgets.js). The rules worth pinning are the ones a reader of the
// page cannot see: which categories may hold a target, that zero clears rather
// than stores, that a save touches only the rows it names, and that a bad row
// leaves the stored set untouched.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function getBudgets(c) {
  const r = c.get('/api/budgets');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.budgets;
}

/** The saved set as a plain { key: amount } map, for readable assertions. */
function asMap(rows) {
  return Object.fromEntries(rows.map((b) => [b.category, b.amount]));
}

test('budgets: a fresh database has none', (t) => {
  const c = makeClient(t);
  assert.deepStrictEqual(getBudgets(c), []);
});

test('budgets: save then read back', (t) => {
  const c = makeClient(t);
  const r = c.put('/api/budgets', {
    budgets: [{ category: 'food', amount: 500 }, { category: 'rent', amount: 1500 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The acknowledgement carries the saved set, so the dialog needs no re-GET.
  assert.deepStrictEqual(asMap(r.body.budgets), { food: 500, rent: 1500 });
  assert.deepStrictEqual(asMap(getBudgets(c)), { food: 500, rent: 1500 });
});

test('budgets: a target is one figure for every month, not a per-month row', (t) => {
  const c = makeClient(t);
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 400 }] });
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 425 }] });
  // Second save replaces rather than accumulates: budget_amounts is keyed by
  // category alone.
  assert.deepStrictEqual(asMap(getBudgets(c)), { food: 425 });
});

test('budgets: zero clears the target', (t) => {
  const c = makeClient(t);
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 500 }] });
  const r = c.put('/api/budgets', { budgets: [{ category: 'food', amount: 0 }] });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(getBudgets(c), []);
});

test('budgets: a save touches only the categories it names', (t) => {
  const c = makeClient(t);
  c.put('/api/budgets', {
    budgets: [{ category: 'food', amount: 500 }, { category: 'rent', amount: 1500 }],
  });
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 600 }] });
  assert.deepStrictEqual(asMap(getBudgets(c)), { food: 600, rent: 1500 });
});

test('budgets: expense and transfer categories may hold one, income may not', (t) => {
  const c = makeClient(t);
  assert.equal(c.put('/api/budgets', { budgets: [{ category: 'savings', amount: 400 }] }).status, 200);
  const r = c.put('/api/budgets', { budgets: [{ category: 'income', amount: 4200 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'category cannot hold a budget');
  assert.deepStrictEqual(asMap(getBudgets(c)), { savings: 400 });
});

test('budgets: unknown category is refused', (t) => {
  const c = makeClient(t);
  const r = c.put('/api/budgets', { budgets: [{ category: 'no_such_cat', amount: 100 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown category');
});

test('budgets: amounts must be real, finite and not negative', (t) => {
  const c = makeClient(t);
  for (const amount of [NaN, Infinity, -1, '500', true, null, undefined]) {
    const r = c.put('/api/budgets', { budgets: [{ category: 'food', amount }] });
    assert.equal(r.status, 400, `accepted ${String(amount)}`);
  }
  assert.deepStrictEqual(getBudgets(c), []);
});

test('budgets: the payload must be an array of objects', (t) => {
  const c = makeClient(t);
  assert.equal(c.put('/api/budgets', {}).status, 400);
  assert.equal(c.put('/api/budgets', { budgets: 'food' }).status, 400);
  assert.equal(c.put('/api/budgets', { budgets: [null] }).status, 400);
  assert.equal(c.put('/api/budgets', { budgets: [{ amount: 5 }] }).status, 400);
  assert.equal(
    c.put('/api/budgets', {
      budgets: Array.from({ length: 201 }, () => ({ category: 'food', amount: 1 })),
    }).status,
    400
  );
});

test('budgets: a bad row rolls the whole save back', (t) => {
  const c = makeClient(t);
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 500 }] });
  const r = c.put('/api/budgets', {
    budgets: [
      { category: 'food', amount: 999 },
      { category: 'no_such_cat', amount: 100 },
    ],
  });
  assert.equal(r.status, 400);
  // The valid first row must NOT have landed.
  assert.deepStrictEqual(asMap(getBudgets(c)), { food: 500 });
});

test('budgets: amounts are rounded to cents at the write boundary', (t) => {
  const c = makeClient(t);
  c.put('/api/budgets', { budgets: [{ category: 'food', amount: 2.675 }] });
  // round2 rounds the decimal the user typed, half away from zero.
  assert.deepStrictEqual(asMap(getBudgets(c)), { food: 2.68 });
});

test('budgets: deleting a category drops its target', (t) => {
  const c = makeClient(t);
  const created = c.post('/api/categories', { name: 'Hobbies', cat_type: 'expense' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const cat = created.body.category;

  c.put('/api/budgets', { budgets: [{ category: cat.key, amount: 120 }] });
  assert.deepStrictEqual(asMap(getBudgets(c)), { [cat.key]: 120 });

  assert.equal(c.del(`/api/categories/${cat.id}`).status, 200);
  assert.deepStrictEqual(getBudgets(c), []);
});

test('budgets: a target survives its category being renamed', (t) => {
  const c = makeClient(t);
  const created = c.post('/api/categories', { name: 'Hobbies', cat_type: 'expense' });
  const cat = created.body.category;
  c.put('/api/budgets', { budgets: [{ category: cat.key, amount: 120 }] });

  assert.equal(c.put(`/api/categories/${cat.id}`, { name: 'Pastimes' }).status, 200);
  // Keyed by the stable slug, not the name.
  assert.deepStrictEqual(asMap(getBudgets(c)), { [cat.key]: 120 });
});

test('budgets: the routes are paid', (t) => {
  const c = makeClient(t, { licensed: false });
  assert.equal(c.get('/api/budgets').status, 402);
  assert.equal(c.put('/api/budgets', { budgets: [] }).status, 402);
});
