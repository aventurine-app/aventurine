'use strict';

// Balance derivation: anchors rolled through the ledger into Balance Sheet
// month-ends. Service-level tests pin the coverage/anchor rules ("never
// confidently wrong"); API-level tests prove the /api/balance/data overlay —
// derived cells fill, manual cells win, provenance is reported.

const test = require('node:test');
const assert = require('node:assert');

const { deriveAccountMonthEnds } = require('../services/balances');
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

test('derive: a MANUAL anchor months past the ledger still rolls the trend', () => {
  // Transactions end in April; the user types a balance in July. The gap is
  // treated as quiet: the levels may be offset by the gap's unknown net
  // flow, but every month gets a value and the SHAPE of change is exact —
  // that's what the net-worth graph needs.
  const months = deriveAccountMonthEnds(
    [tx('2026-03-05', 100), tx('2026-04-10', 50, 'income')],
    [anchor('2026-07-01', 4000, 'manual')],
    CAT_TYPES
  );
  assert.equal(months['2026-07'], 4000, 'anchor month');
  assert.equal(months['2026-06'], 4000, 'quiet gap months carry the balance flat');
  assert.equal(months['2026-05'], 4000);
  assert.equal(months['2026-04'], 4000, 'all activity already before April month-end');
  assert.equal(months['2026-03'], 3950, 'March month-end excludes April income');
  assert.equal(months['2026-02'], undefined, 'nothing before the span');
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

test('derive: an anchor pre-dating the ledger rolls forward across the gap', () => {
  const months = deriveAccountMonthEnds(
    [tx('2026-06-05', 100)],
    [anchor('2026-01-15', 4000, 'file')],
    CAT_TYPES
  );
  assert.equal(months['2026-01'], 4000);
  assert.equal(months['2026-03'], 4000, 'quiet gap carries flat');
  assert.equal(months['2026-06'], 3900, 'June expense lands');
});

test('derive: years of history + one balance-today = a full monthly trend', () => {
  // The founder scenario: a multi-year export and a single typed balance.
  // Every month across the span derives — a net-worth graph, not one dot.
  const txs = [];
  for (let year = 2022; year <= 2026; year++) {
    for (let m = 1; m <= (year === 2026 ? 6 : 12); m++) {
      const mm = String(m).padStart(2, '0');
      txs.push(tx(`${year}-${mm}-01`, 3000, 'income'));
      txs.push(tx(`${year}-${mm}-15`, 2500));
    }
  }
  const months = deriveAccountMonthEnds(txs, [anchor('2026-07-02', 10000, 'manual')], CAT_TYPES);
  const keys = Object.keys(months);
  assert.equal(keys.length, 55, 'Jan 2022 through Jul 2026, every month');
  // Net +500/month walking backward from the anchor.
  assert.equal(months['2026-07'], 10000);
  assert.equal(months['2026-06'], 10000);        // gap month, carried flat
  assert.equal(months['2026-05'], 9500);
  assert.equal(months['2022-01'], 10000 - 500 * 53);
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

test('balance sync: linking an account defaults its column into sync; import + anchor fill it', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);

  // The first link seeded sync for the bootstrap year, and the column is
  // reported as syncable.
  let d = balanceData(c);
  assert.ok(d.sync['2026'].includes('checking'), 'linked column synced by default');
  assert.deepStrictEqual(d.syncable, ['checking']);

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

  d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 4500);
  // May month-end = 4500 − June's net (+3000 − 500) = 2000.
  assert.equal(d.entries['2026'].May.checking, 2000);
});

test('balance sync: synced cells refuse manual writes; unsync restores them', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);
  c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [{ date: '2026-06-04', description: 'PAY', tx_type: 'income', amount: 3000 }],
  });
  c.post(`/api/accounts/${a.id}/anchors`, { date: '2026-06-04', balance: 5000 });

  // Synced → hand-editing is refused, exactly like a synced Cash Flow cell.
  const write = { year: 2026, month: 'June', category: 'checking', value: 1234 };
  assert.equal(c.post('/api/balance/entry', write).status, 409);
  assert.equal(c.del('/api/balance/entry', write).status, 409);

  // Opt the column out for this year → manual entry works and shows; the
  // derived value no longer appears anywhere in the column.
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'checking', sync: false }).status,
    200
  );
  assert.equal(c.post('/api/balance/entry', write).status, 200);
  let d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 1234);
  assert.ok(!d.sync['2026']?.includes('checking'));

  // Opt back in → the computed value returns; the manual 1234 is ignored but
  // preserved underneath for the next opt-out.
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'checking', sync: true }).status,
    200
  );
  d = balanceData(c);
  assert.equal(d.entries['2026'].June.checking, 5000);
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'checking', sync: false }).status,
    200
  );
  assert.equal(balanceData(c).entries['2026'].June.checking, 1234, 'manual value survived');
});

test('balance sync: a synced column with no anchor shows nothing (not zeros)', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);
  c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [{ date: '2026-06-04', description: 'PAY', tx_type: 'income', amount: 3000 }],
  });
  const d = balanceData(c);
  assert.ok(d.sync['2026'].includes('checking'), 'synced, but…');
  assert.equal(d.entries['2026']?.June?.checking, undefined, '…no observation, no value');
});

test('balance sync: an unlinked column cannot be switched ON; OFF always works', (t) => {
  const c = makeClient(t);
  setupLedgerAccount(c); // links 'checking' only
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'savings', sync: true }).status,
    400
  );
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'savings', sync: false }).status,
    200
  );
  assert.equal(
    c.post('/api/balance/year/2026/sync', { category: 'nope', sync: true }).status,
    400
  );
  // "Sync all" only grabs eligible columns.
  assert.equal(c.post('/api/balance/year/2026/sync', { all: true, sync: true }).status, 200);
  assert.deepStrictEqual(balanceData(c).sync['2026'], ['checking']);
});

test('balance sync: year add seeds linked columns; duplicate copies; delete clears', (t) => {
  const c = makeClient(t);
  setupLedgerAccount(c);

  assert.equal(c.post('/api/balance/year', { year: 2025 }).status, 200);
  let d = balanceData(c);
  assert.ok(d.sync['2025'].includes('checking'), 'new year defaults linked columns into sync');

  // Customize 2025 (opt out), then duplicate — the copy carries the opt-out.
  c.post('/api/balance/year/2025/sync', { category: 'checking', sync: false });
  assert.equal(c.post('/api/balance/year/2025/duplicate', { target_year: 2024 }).status, 200);
  d = balanceData(c);
  assert.ok(!d.sync['2024']?.includes('checking'), 'duplicate is a faithful copy');

  assert.equal(c.del('/api/balance/year/2024').status, 200);
  assert.equal(balanceData(c).sync['2024'], undefined);
});

test('balance sync: an import-created year arrives with linked columns synced', (t) => {
  const c = makeClient(t);
  const a = setupLedgerAccount(c);
  c.post('/api/transactions/import', {
    account_id: a.id,
    rows: [{ date: '2025-03-05', description: 'PAY', tx_type: 'income', amount: 3000 }],
  });
  const d = balanceData(c);
  assert.ok(d.years.includes(2025));
  assert.ok(d.sync['2025'].includes('checking'));
});

test('balance sync: two accounts on one column sum only where both cover', (t) => {
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
