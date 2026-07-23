'use strict';

// Imported balances → the Balance Sheet, as ordinary hand-editable cells.
// An import seeds balance_entries directly (NOT a separate synced/computed
// layer — automating the Balance Sheet as a derived layer hit design blockers,
// so imports just fill the cells and they behave like anything the user typed).
// Editing/clearing a seeded cell is the plain entry upsert/delete already
// covered by apiTrackers.test.js.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

const YEAR = new Date().getFullYear(); // the year seed.js activates on a fresh DB

// Import one throwaway transaction plus the given balance readings.
function importWith(c, balances, txDate) {
  const date = txDate || (balances[0] && balances[0].date) || `${YEAR}-01-15`;
  return c.post('/api/transactions/import', {
    rows: [{ date, description: 'seed tx', tx_type: 'expense', amount: 1 }],
    balances,
  });
}

// The Balance Sheet cells for a year: { MonthName -> { account_key -> value } }.
const cells = (c, year = YEAR) => (c.get('/api/balance/data').body.entries || {})[String(year)] || {};

test('an import seeds month-end balances as ordinary Balance Sheet cells', (t) => {
  const c = makeClient(t);
  const r = importWith(c, [
    { account_key: 'checking', date: `${YEAR}-01-31`, value: 2450.0, source: 'file' },
    { account_key: 'checking', date: `${YEAR}-03-31`, value: 1250.0, source: 'ofx' },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.body.balances_applied, 2);

  const c1 = cells(c);
  assert.equal(c1.January.checking, 2450.0);
  assert.equal(c1.March.checking, 1250.0);
  // A month with no reading gets no cell.
  assert.equal(c1.February, undefined);

  // These are plain user data — there is no separate computed/manual layer.
  const data = c.get('/api/balance/data').body;
  assert.equal(data.computed, undefined);
  assert.equal(data.manual, undefined);
});

test('a seeded cell is editable and clearable like any hand-entered value', (t) => {
  const c = makeClient(t);
  importWith(c, [{ account_key: 'checking', date: `${YEAR}-01-31`, value: 2450.0, source: 'file' }]);

  // Edit it.
  assert.equal(
    c.post('/api/balance/entry', { year: YEAR, month: 'January', category: 'checking', value: 2500 }).status,
    200
  );
  assert.equal(cells(c).January.checking, 2500);

  // Clear it — the cell goes away entirely (no computed value hiding underneath).
  assert.equal(c.del('/api/balance/entry', { year: YEAR, month: 'January', category: 'checking' }).status, 200);
  assert.equal(cells(c).January, undefined);
});

test('re-importing overwrites the cell with the newer file', (t) => {
  const c = makeClient(t);
  importWith(c, [{ account_key: 'checking', date: `${YEAR}-01-31`, value: 2450, source: 'file' }]);
  assert.equal(cells(c).January.checking, 2450);
  importWith(c, [{ account_key: 'checking', date: `${YEAR}-01-31`, value: 2600, source: 'file' }]);
  assert.equal(cells(c).January.checking, 2600);
});

test('unknown accounts and malformed readings are dropped, not fatal', (t) => {
  const c = makeClient(t);
  const r = importWith(c, [
    { account_key: 'checking',   date: `${YEAR}-02-10`, value: 42,  source: 'file' },   // ok
    { account_key: 'no_such_col', date: `${YEAR}-02-10`, value: 999, source: 'file' },  // unknown account
    { account_key: 'checking',   date: 'garbage',       value: 1,   source: 'file' },   // bad date
    { account_key: 'checking',   date: `${YEAR}-02-10`, value: 'x', source: 'file' },   // bad value
    { account_key: 'checking',   date: `${YEAR}-02-10`, value: 1,   source: 'bogus' },  // bad source
  ]);
  assert.equal(r.body.balances_applied, 1);
  assert.equal(cells(c).February.checking, 42);
  assert.equal(cells(c).February.no_such_col, undefined);

  // A non-array balances field is a bad request.
  assert.equal(
    c.post('/api/transactions/import', {
      rows: [{ date: `${YEAR}-01-01`, description: 'x', tx_type: 'expense', amount: 1 }],
      balances: 'nope',
    }).status,
    400
  );
});

test('an import auto-creates the Balance Sheet year tab for a reading in a new year', (t) => {
  const c = makeClient(t);
  const future = YEAR + 3; // not seeded
  importWith(c, [{ account_key: 'savings', date: `${future}-06-30`, value: 8000, source: 'file' }], `${future}-06-15`);
  const data = c.get('/api/balance/data').body;
  assert.ok(data.years.includes(future));
  assert.equal(cells(c, future).June.savings, 8000);
});

test('a debt account keeps a negative reading (no sign coercion)', (t) => {
  const c = makeClient(t);
  importWith(c, [{ account_key: 'debt', date: `${YEAR}-01-31`, value: -540.25, source: 'file' }]);
  assert.equal(cells(c).January.debt, -540.25);
});

test('import without a balances field still works (transactions only)', (t) => {
  const c = makeClient(t);
  const r = c.post('/api/transactions/import', {
    rows: [{ date: `${YEAR}-01-10`, description: 'x', tx_type: 'expense', amount: 1 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.balances_applied, 0);
  assert.deepStrictEqual(c.get('/api/balance/data').body.entries, {});
});
