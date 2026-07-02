'use strict';

// Balance derivation: anchors rolled through the ledger into Balance Sheet
// month-ends. Service-level tests pin the coverage/anchor rules ("never
// confidently wrong"); API-level tests prove the /api/balance/data overlay —
// derived cells fill, manual cells win, provenance is reported.

const test = require('node:test');
const assert = require('node:assert');

const { deriveAccountMonthEnds, GRACE_DAYS } = require('../services/balances');
const { makeClient } = require('./helpers');

// Uncategorized rows only — direction from tx_type; no catTypes lookups needed.
const CAT_TYPES = new Map();
const tx = (date, amount, txType = 'expense') => ({
  date, amount, tx_type: txType, category_id: null,
});
const anchor = (date, balance, source = 'file') => ({ date, balance, source });

// ── Service: derivation rules ────────────────────────────────────────────────

test('derive: rolls BACKWARD from a statement-end anchor (the OFX shape)', () => {
  // June: +3000 income on the 1st, -500 on the 20th; bank says 4000 on Jun 30.
  const months = deriveAccountMonthEnds(
    [tx('2026-05-10', 200), tx('2026-06-01', 3000, 'income'), tx('2026-06-20', 500)],
    [anchor('2026-06-30', 4000)],
    CAT_TYPES
  );
  assert.equal(months['2026-06'], 4000); // at the anchor itself
  // May month-end = 4000 minus June's net (+3000 - 500) = 1500.
  assert.equal(months['2026-05'], 1500);
});

test('derive: rolls FORWARD from an opening anchor', () => {
  // User typed 1000 as of Jun 1; spends 100 in June, earns 50 in July.
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 100), tx('2026-07-10', 50, 'income')],
    [anchor('2026-06-01', 1000, 'manual')],
    CAT_TYPES
  );
  assert.equal(months['2026-06'], 900);
  assert.equal(months['2026-07'], 950);
});

test('derive: transfers move the account balance like any flow', () => {
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 500, 'transfer_out'), tx('2026-06-08', 200, 'transfer_in')],
    [anchor('2026-06-30', 700)],
    CAT_TYPES
  );
  assert.equal(months['2026-06'], 700);
});

test('derive: a MANUAL anchor months past the ledger states only its own month', () => {
  // Transactions end March 31; the user types a balance in July. The gap
  // proves nothing about April–June (refusing beats guessing), but the
  // typed balance is still a fact about July itself.
  const months = deriveAccountMonthEnds(
    [tx('2026-03-05', 100), tx('2026-03-31', 50)],
    [anchor('2026-07-01', 4000, 'manual')],
    CAT_TYPES
  );
  assert.equal(months['2026-07'], 4000, 'the anchor month shows the observation');
  assert.equal(months['2026-04'], undefined, 'the gap months stay empty');
  assert.equal(months['2026-05'], undefined);
  assert.equal(months['2026-06'], undefined);
  assert.equal(months['2026-03'], undefined, 'no rolling without a usable anchor');
});

test('derive: an anchors-only account (no transactions) populates its months', () => {
  // The 401k pattern: the user records a balance now and then; no files.
  const months = deriveAccountMonthEnds(
    [],
    [
      anchor('2026-04-15', 93000, 'manual'),
      anchor('2026-06-20', 95500, 'manual'),
      anchor('2026-06-02', 94800, 'manual'), // older observation, same month
    ],
    CAT_TYPES
  );
  assert.deepStrictEqual(months, { '2026-04': 93000, '2026-06': 95500 });
});

test('derive: a FILE anchor past the ledger extends coverage — the bank vouches', () => {
  // A dormant account: last row in March, statement closes July 1. The
  // statement itself covers the quiet months, so they derive (flat balance).
  const months = deriveAccountMonthEnds(
    [tx('2026-03-05', 100), tx('2026-03-31', 50)],
    [anchor('2026-07-01', 4000, 'file')],
    CAT_TYPES
  );
  assert.equal(months['2026-03'], 4000);
  assert.equal(months['2026-05'], 4000);
  assert.equal(months['2026-07'], 4000);
});

test('derive: an anchor pre-dating the ledger window never rolls into it', () => {
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 100)],
    [anchor('2026-01-15', 4000, 'file')],
    CAT_TYPES
  );
  // The January observation stands as a point; nothing bridges Feb–Jun.
  assert.deepStrictEqual(months, { '2026-01': 4000 });
});

test('derive: grace window admits a statement anchor dated just past the last row', () => {
  const lastTx = '2026-06-28';
  const months = deriveAccountMonthEnds(
    [tx('2026-06-10', 100), tx(lastTx, 50)],
    [anchor('2026-06-30', 850)], // 2 days past the last row, well under GRACE_DAYS
    CAT_TYPES
  );
  assert.ok(GRACE_DAYS >= 2);
  assert.equal(months['2026-06'], 850);
});

test('derive: months before the first transaction stay empty', () => {
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 100)],
    [anchor('2026-06-30', 1000)],
    CAT_TYPES
  );
  assert.deepStrictEqual(Object.keys(months), ['2026-06']);
});

test('derive: latest anchor is the single reference; same-day file beats manual', () => {
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 100)],
    [
      anchor('2026-06-01', 999, 'manual'),
      anchor('2026-06-30', 500, 'manual'),
      anchor('2026-06-30', 700, 'file'),
    ],
    CAT_TYPES
  );
  assert.equal(months['2026-06'], 700);
});

// ── API: the /api/balance/data overlay ───────────────────────────────────────

function setupLedgerAccount(c, { column = 'checking' } = {}) {
  const r = c.post('/api/accounts', {
    name: `Acct-${column}`, kind: 'checking', balance_column: column,
  });
  assert.equal(r.status, 200);
  return r.body.account;
}

const balanceData = (c) => {
  const r = c.get('/api/balance/data');
  assert.equal(r.status, 200);
  return r.body;
};

test('balance overlay: import + anchor light up empty Balance Sheet cells', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);

  const imp = c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [
      { date: '2026-05-03', description: 'PAYROLL', tx_type: 'income', amount: 3000 },
      { date: '2026-05-20', description: 'RENT', tx_type: 'expense', amount: 1000 },
      { date: '2026-06-04', description: 'PAYROLL', tx_type: 'income', amount: 3000 },
      { date: '2026-06-18', description: 'GROC', tx_type: 'expense', amount: 500 },
    ],
  });
  assert.equal(imp.status, 200);
  assert.equal(
    c.post(`/api/accounts/${a.id}/anchors`, { date: '2026-06-18', balance: 4500, source: 'file' }).status,
    200
  );

  const d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 4500);
  // May month-end = 4500 − June's net (+3000 − 500) = 2000.
  assert.equal(d.entries['2026'].May.checking, 2000);
  assert.deepStrictEqual(d.derived['2026'].June, ['checking']);
  assert.deepStrictEqual(d.derived['2026'].May, ['checking']);
});

test('balance overlay: a hand-entered cell wins over the derived value', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);
  c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [{ date: '2026-06-04', description: 'PAY', tx_type: 'income', amount: 3000 }],
  });
  c.post(`/api/accounts/${a.id}/anchors`, { date: '2026-06-04', balance: 5000 });

  // The user types their own June value — it must survive the overlay.
  assert.equal(
    c.post('/api/balance/entry', { year: 2026, month: 'June', category: 'checking', value: 1234 }).status,
    200
  );
  const d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 1234);
  assert.ok(!d.derived['2026']?.June?.includes('checking'), 'user cell not marked derived');
});

test('balance overlay: no anchor, no overlay — and no derived map noise', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);
  c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [{ date: '2026-06-04', description: 'PAY', tx_type: 'income', amount: 3000 }],
  });
  const d = balanceData(c);
  assert.equal(d.entries['2026']?.June?.checking, undefined);
  assert.deepStrictEqual(d.derived, {});
});

test('balance overlay: two accounts on one column sum only where both cover', (t) => {
  const c = makeClient(t);
  const a1 = setupLedgerAccount(c);
  const r2 = c.post('/api/accounts', {
    name: 'Second Checking', kind: 'checking', balance_column: 'checking',
  });
  const a2 = r2.body.account;

  // a1 covers May+June; a2 covers June only.
  c.post('/api/transactions/import', {
    account_id: a1.id,
    rows: [
      { date: '2026-05-10', description: 'x', tx_type: 'income', amount: 100 },
      { date: '2026-06-10', description: 'x', tx_type: 'income', amount: 100 },
    ],
  });
  c.post(`/api/accounts/${a1.id}/anchors`, { date: '2026-06-10', balance: 1000 });
  c.post('/api/transactions/import', {
    account_id: a2.id,
    rows: [{ date: '2026-06-08', description: 'y', tx_type: 'income', amount: 50 }],
  });
  c.post(`/api/accounts/${a2.id}/anchors`, { date: '2026-06-08', balance: 500 });

  const d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 1500); // both cover June
  assert.equal(d.entries['2026']?.May?.checking, undefined, 'May only half-known: stays empty');
});
