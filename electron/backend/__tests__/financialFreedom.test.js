'use strict';

// Financial Freedom (Dashboard). NEW behaviour (not a Python port) → no oracle
// fixture: the service is pinned by deterministic unit tests and the endpoint
// by API tests over a seeded DB.

const test = require('node:test');
const assert = require('node:assert');

const { financialFreedom, FI_MULTIPLE } = require('../services/reportCard');
const { makeClient } = require('./helpers');

const years = (spec) => spec.map(([year, expenses]) => ({ year, expenses }));

// ── service ───────────────────────────────────────────────────────────────────

test('fi: the number is 25 x the average expenses of every year with expenses', () => {
  const fi = financialFreedom({ years: years([[2022, 40000], [2023, 50000], [2024, 60000]]), currentYear: 2026 });
  assert.equal(FI_MULTIPLE, 25);
  assert.equal(fi.avgExpenses, 50000);
  assert.equal(fi.number, 1250000);
  assert.deepEqual(fi.yearsAveraged, [2022, 2023, 2024]);
});

test('fi: a year with no expenses is skipped, not averaged in as zero', () => {
  const fi = financialFreedom({ years: years([[2023, 0], [2024, 50000]]), currentYear: 2026 });
  assert.equal(fi.avgExpenses, 50000);
  assert.deepEqual(fi.yearsAveraged, [2024]);
  const none = financialFreedom({ years: years([[2023, 0]]), currentYear: 2026 });
  assert.equal(none.number, null);
  assert.deepEqual(none.yearsAveraged, []);
});

test('fi: the running (partial) year is left out while an earlier year has expenses', () => {
  const fi = financialFreedom({ years: years([[2025, 48000], [2026, 8000]]), currentYear: 2026 });
  assert.equal(fi.avgExpenses, 48000);
  assert.deepEqual(fi.yearsAveraged, [2025]);
  // Alone, it is used as it stands: a number built on something beats N/A.
  const only = financialFreedom({ years: years([[2026, 8000]]), currentYear: 2026 });
  assert.equal(only.avgExpenses, 8000);
  assert.equal(only.number, 200000);
});

test('fi: progress is net worth over the number, null without either, negative when more is owed', () => {
  const base = { years: years([[2023, 40000]]), currentYear: 2026 };
  const asOf = { year: 2025, month: 3 };
  const ahead = financialFreedom({ ...base, netWorth: 100000, netWorthAsOf: asOf });
  assert.equal(ahead.netWorth, 100000);
  assert.deepEqual(ahead.netWorthAsOf, asOf);
  assert.equal(ahead.progress, 0.1);

  const none = financialFreedom({ ...base, netWorth: null, netWorthAsOf: null });
  assert.equal(none.netWorth, null);
  assert.equal(none.netWorthAsOf, null);
  assert.equal(none.progress, null);

  const owing = financialFreedom({ ...base, netWorth: -50000, netWorthAsOf: asOf });
  assert.equal(owing.progress, -0.05);

  // No expenses anywhere: no number, so no progress even with a net worth.
  const noNumber = financialFreedom({ years: years([[2025, 0]]), netWorth: 100000, netWorthAsOf: asOf, currentYear: 2026 });
  assert.equal(noNumber.number, null);
  assert.equal(noNumber.progress, null);
});

// ── API ───────────────────────────────────────────────────────────────────────

test('financial-freedom API: a fresh DB has no number and no progress', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/financial-freedom');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true, avgExpenses: null, yearsAveraged: [], number: null,
    netWorth: null, netWorthAsOf: null, progress: null,
  });
});

test('financial-freedom API: net worth is assets minus debt at the latest Balance-Sheet month, carried forward', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2025 });
  c.post('/api/entry', { year: 2025, month: 'June', category: 'food', value: 40000 });

  const cash = c.post('/api/balance/columns', { label: 'Checking', type: 'cash' }).body.column.key;
  const debt = c.post('/api/balance/columns', { label: 'Credit Card', type: 'debt' }).body.column.key;
  // The debt is entered in January and never again; March updates only the
  // cash column, so the January debt has to carry forward into March's total.
  c.post('/api/balance/entry', { year: 2025, month: 'January', category: cash, value: 30000 });
  c.post('/api/balance/entry', { year: 2025, month: 'January', category: debt, value: 10000 });
  c.post('/api/balance/entry', { year: 2025, month: 'March', category: cash, value: 50000 });

  const fi = c.get('/api/financial-freedom').body;
  assert.equal(fi.avgExpenses, 40000);
  assert.equal(fi.number, 1000000);
  assert.deepEqual(fi.yearsAveraged, [2025]);
  assert.equal(fi.netWorth, 40000);
  assert.deepEqual(fi.netWorthAsOf, { year: 2025, month: 3 });
  assert.equal(fi.progress, 0.04);
});

test('financial-freedom API: the number averages the Cash Flow years, entries overriding cells', (t) => {
  const c = makeClient(t);
  c.post('/api/year', { year: 2024 });
  c.post('/api/year', { year: 2025 });
  c.post('/api/entry', { year: 2024, month: 'June', category: 'food', value: 20000 });
  // 2025's cost comes from a transaction, and a typed cell then overrides it
  // (the same per-cell blend the Cash Flow statement shows).
  const food = c.get('/api/categories').body.categories.find((cat) => cat.key === 'food').id;
  c.post('/api/transactions', { date: '2025-03-10', description: 'Groceries', amount: 5000, category_id: food });
  c.post('/api/entry', { year: 2025, month: 'March', category: 'food', value: 30000 });

  const fi = c.get('/api/financial-freedom').body;
  assert.deepEqual(fi.yearsAveraged, [2024, 2025]);
  assert.equal(fi.avgExpenses, 25000);
  assert.equal(fi.number, 625000);
});

test('financial-freedom API: hidden starter accounts do not count towards net worth', (t) => {
  const c = makeClient(t);
  // Starter accounts are seeded hidden; a balance in one must not surface here.
  const hidden = c.get('/api/balance/columns?include_hidden=true').body.find((col) => col.hidden);
  assert.ok(hidden, 'expected a hidden starter account');
  c.post('/api/balance/entry', { year: 2025, month: 'January', category: hidden.key, value: 999 });
  assert.equal(c.get('/api/financial-freedom').body.netWorth, null);
});
