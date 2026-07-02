'use strict';

// Accounts API + transfer semantics: the account CRUD/anchor endpoints, the
// account_id plumbing through transaction create/update/import, and the rule
// that transfers (money between the user's own accounts) are excluded from
// every income/spend surface — categorization, the uncat badge, Cash Flow.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function makeAccount(c, payload = {}) {
  const r = c.post('/api/accounts', { name: 'Checking', kind: 'checking', ...payload });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.account;
}

const listAccounts = (c) => {
  const r = c.get('/api/accounts');
  assert.equal(r.status, 200);
  return r.body.accounts;
};

const groceriesOf = (c) =>
  c.get('/api/categories').body.categories.find((x) => x.key === 'groceries');

// ── CRUD ─────────────────────────────────────────────────────────────────────

test('accounts: create / list / update / delete', (t) => {
  const c = makeClient(t);
  assert.deepStrictEqual(listAccounts(c), []);

  const a = makeAccount(c, { name: 'Everyday Checking', balance_column: 'checking' });
  assert.equal(a.kind, 'checking');
  assert.equal(a.balance_column, 'checking');
  assert.equal(a.latest_anchor, null);

  const up = c.put(`/api/accounts/${a.id}`, { name: 'Main Checking', kind: 'savings' });
  assert.equal(up.status, 200);
  assert.equal(up.body.account.name, 'Main Checking');
  assert.equal(up.body.account.kind, 'savings');

  assert.equal(c.del(`/api/accounts/${a.id}`).status, 200);
  assert.deepStrictEqual(listAccounts(c), []);
  assert.equal(c.del(`/api/accounts/${a.id}`).status, 404);
});

test('accounts: validation — name, kind, balance_column, duplicates', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/accounts', { kind: 'checking' }).status, 400); // no name
  assert.equal(c.post('/api/accounts', { name: 'X', kind: 'offshore' }).status, 400);
  assert.equal(
    c.post('/api/accounts', { name: 'X', kind: 'checking', balance_column: 'nope' }).status,
    400
  );
  makeAccount(c, { name: 'Twin' });
  assert.equal(c.post('/api/accounts', { name: 'Twin', kind: 'savings' }).status, 409);
});

test('accounts: opening balance becomes a manual anchor', (t) => {
  const c = makeClient(t);
  const a = makeAccount(c, { opening_balance: 4250.501, opening_date: '2026-06-30' });
  assert.deepStrictEqual(a.latest_anchor, {
    date: '2026-06-30',
    balance: 4250.5, // round2 at the write boundary
    source: 'manual',
  });
});

test('accounts: anchor upsert keys on (date, source); manual and file coexist', (t) => {
  const c = makeClient(t);
  const a = makeAccount(c);
  const anchor = (body) => c.post(`/api/accounts/${a.id}/anchors`, body);

  assert.equal(anchor({ date: '2026-06-01', balance: 100, source: 'file' }).status, 200);
  assert.equal(anchor({ date: '2026-06-01', balance: 120 }).status, 200); // manual, same day
  assert.equal(anchor({ date: '2026-06-01', balance: 130, source: 'file' }).status, 200); // update

  // Latest wins by date (then id); both same-day sources exist independently.
  const got = listAccounts(c)[0].latest_anchor;
  assert.equal(got.date, '2026-06-01');
  assert.ok(anchor({ date: 'junk', balance: 1 }).status === 400);
  assert.ok(anchor({ date: '2026-06-01', balance: NaN }).status === 400);
  assert.ok(anchor({ date: '2026-06-01', balance: 1, source: 'cloud' }).status === 400);

  assert.equal(
    c.del(`/api/accounts/${a.id}/anchors`, { date: '2026-06-01', source: 'file' }).status,
    200
  );
});

// ── account_id on transactions ───────────────────────────────────────────────

test('transactions: create/update carry account_id; unknown account rejected', (t) => {
  const c = makeClient(t);
  const a = makeAccount(c);

  const created = c.post('/api/transactions', {
    date: '2026-06-01', description: 'coffee', tx_type: 'expense', amount: 4.5,
    account_id: a.id,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.transaction.account_id, a.id);

  const cleared = c.put(`/api/transactions/${created.body.transaction.id}`, { account_id: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.transaction.account_id, null);

  assert.equal(
    c.post('/api/transactions', {
      date: '2026-06-01', description: 'x', tx_type: 'expense', amount: 1, account_id: 999,
    }).status,
    400
  );
});

test('import: one account_id applies to every row; unknown one rejects the batch', (t) => {
  const c = makeClient(t);
  const a = makeAccount(c);
  const rows = [
    { date: '2026-06-01', description: 'a', tx_type: 'expense', amount: 1 },
    { date: '2026-06-02', description: 'b', tx_type: 'income', amount: 2 },
  ];

  assert.equal(c.post('/api/transactions/import', { rows, account_id: 999 }).status, 400);

  const r = c.post('/api/transactions/import', { rows, account_id: a.id });
  assert.equal(r.status, 200);
  const txs = c.get('/api/transactions').body.transactions;
  assert.ok(txs.every((x) => x.account_id === a.id));
});

test('accounts: deleting an account unassigns its transactions, keeps them', (t) => {
  const c = makeClient(t);
  const a = makeAccount(c);
  c.post('/api/transactions', {
    date: '2026-06-01', description: 'keep me', tx_type: 'expense', amount: 9, account_id: a.id,
  });
  assert.equal(c.del(`/api/accounts/${a.id}`).status, 200);
  const txs = c.get('/api/transactions').body.transactions;
  assert.equal(txs.length, 1);
  assert.equal(txs[0].description, 'keep me');
  assert.equal(txs[0].account_id, null);
});

// ── Transfer semantics ───────────────────────────────────────────────────────

test('transfers: uncategorizable, invisible to the uncat badge and Cash Flow', (t) => {
  const c = makeClient(t);
  const groceries = groceriesOf(c);

  const made = c.post('/api/transactions', {
    date: '2026-06-05', description: 'ZELLE TO SAVINGS', tx_type: 'transfer_out', amount: 500,
  });
  assert.equal(made.status, 200);
  const transfer = made.body.transaction;
  assert.equal(transfer.tx_type, 'transfer_out');
  assert.equal(transfer.category_id, null);

  // Categorizing a transfer is a 400, not a silent direction flip.
  assert.equal(
    c.put(`/api/transactions/${transfer.id}`, { category_id: groceries.id }).status,
    400
  );

  // The badge counts only categorizable work: one plain uncategorized row.
  c.post('/api/transactions', {
    date: '2026-06-06', description: 'POS 1234', tx_type: 'expense', amount: 25,
  });
  assert.equal(c.get('/api/transactions/uncategorized-count').body.count, 1);

  // similar() never offers the transfer as a bulk-categorize candidate.
  const sim = c.get('/api/transactions/similar?description=ZELLE%20TO%20SAVINGS');
  assert.deepStrictEqual(sim.body.transactions, []);

  // Cash Flow (bootstrap year is fully synced): the transfer feeds neither the
  // uncat_expense bucket nor any category — only the plain expense shows.
  const cells = c.get('/api/data').body.entries['2026'].June;
  assert.equal(cells.uncat_expense, 25);
});

test('transfers: learned rules skip transfer rows on import', (t) => {
  const c = makeClient(t);
  const groceries = groceriesOf(c);

  // Teach a rule for this exact description via a direct categorization.
  const seed = c.post('/api/transactions', {
    date: '2026-06-01', description: 'ZELLE TO SAVINGS', tx_type: 'expense', amount: 1,
    category_id: groceries.id,
  });
  assert.equal(seed.status, 200);

  // The same description as a transfer must NOT be auto-categorized.
  const r = c.post('/api/transactions/import', {
    rows: [
      { date: '2026-06-07', description: 'ZELLE TO SAVINGS', tx_type: 'transfer_out', amount: 500 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.auto_categorized, 0);
  const imported = c
    .get('/api/transactions')
    .body.transactions.find((x) => x.tx_type === 'transfer_out');
  assert.equal(imported.category_id, null);
});
