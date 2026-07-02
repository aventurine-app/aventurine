'use strict';

// Accounts blueprint — the money accounts (checking, a credit card, a 401k)
// that transactions and balance anchors belong to. Accounts are the join
// between the ledger and the Balance Sheet: an account may name the Balance
// Sheet column its derived balances feed (balance_column), and its anchors —
// point-in-time balance observations from imported files or the user — are
// what the balance service rolls through the ledger to derive history.
//
// Handlers are plain functions (ctx, {params, query, body}); registration
// lives in routes.js. Multi-statement mutations are wrapped in transactions.

const { bad, cleanLabel, isFiniteNumber, parseIsoDate, round2 } = require('../validate');

// Mirrors the accounts.kind CHECK in schema.js.
const ACCOUNT_KINDS = ['checking', 'savings', 'credit', 'investment', 'retirement', 'other'];
const ANCHOR_SOURCES = ['manual', 'file'];

function getAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

// "Today" is the LOCAL date, like everywhere else in the app (see
// services/predictions.js) — toISOString() would be UTC and can be yesterday
// or tomorrow depending on the user's timezone.
function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Latest anchor per account in one query: the balance the UI shows as
 *  "current" next to each account. */
function latestAnchors(db) {
  const rows = db
    .prepare(
      `SELECT a.account_id, a.date, a.balance, a.source
         FROM account_balance_anchors a
        WHERE NOT EXISTS (
          SELECT 1 FROM account_balance_anchors b
           WHERE b.account_id = a.account_id
             AND (b.date > a.date OR (b.date = a.date AND b.id > a.id))
        )`
    )
    .all();
  return new Map(rows.map((r) => [r.account_id, r]));
}

function serialiseAccount(a, latest = null) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    balance_column: a.balance_column,
    latest_anchor: latest
      ? { date: latest.date, balance: latest.balance, source: latest.source }
      : null,
  };
}

function list(ctx) {
  const db = ctx.db();
  const latest = latestAnchors(db);
  const accounts = db
    .prepare('SELECT * FROM accounts ORDER BY name COLLATE NOCASE')
    .all()
    .map((a) => serialiseAccount(a, latest.get(a.id)));
  return { accounts };
}

/** Validate the shared create/update fields; returns an error string or null.
 *  Only keys present in `data` are checked and applied onto `a`. */
function applyAccountFields(db, a, data, { requireAll }) {
  if ('name' in data || requireAll) {
    const name = cleanLabel(data.name);
    if (!name) return 'name required';
    a.name = name;
  }
  if ('kind' in data || requireAll) {
    if (!ACCOUNT_KINDS.includes(data.kind)) {
      return `kind must be one of: ${ACCOUNT_KINDS.join(', ')}`;
    }
    a.kind = data.kind;
  }
  if ('balance_column' in data) {
    const col = data.balance_column;
    if (col !== null) {
      if (typeof col !== 'string' || !col) return 'invalid balance_column';
      if (!db.prepare('SELECT 1 FROM balance_columns WHERE "key" = ?').get(col)) {
        return 'unknown balance_column';
      }
    }
    a.balance_column = col;
  }
  return null;
}

function create(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const a = { name: '', kind: '', balance_column: null };
  const err = applyAccountFields(db, a, data, { requireAll: true });
  if (err) bad(err);
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(a.name)) {
    bad('account already exists', 409);
  }

  // An opening balance is the onboarding question ("what's this account's
  // balance today?") folded into creation — one manual anchor dated either
  // opening_date or today. It seeds balance derivation immediately.
  let opening = null;
  if (data.opening_balance !== undefined && data.opening_balance !== null) {
    if (!isFiniteNumber(data.opening_balance)) bad('invalid opening_balance');
    const date =
      data.opening_date !== undefined ? parseIsoDate(data.opening_date) : localToday();
    if (!date) bad('invalid opening_date (expected YYYY-MM-DD)');
    opening = { date, balance: round2(data.opening_balance) };
  }

  const created = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO accounts (name, kind, balance_column) VALUES (?, ?, ?)')
      .run(a.name, a.kind, a.balance_column);
    if (opening) {
      db.prepare(
        `INSERT INTO account_balance_anchors (account_id, date, balance, source)
         VALUES (?, ?, ?, 'manual')`
      ).run(info.lastInsertRowid, opening.date, opening.balance);
    }
    return getAccount(db, info.lastInsertRowid);
  })();
  return { ok: true, account: serialiseAccount(created, latestAnchors(db).get(created.id)) };
}

function update(ctx, { params, body }) {
  const db = ctx.db();
  const a = getAccount(db, params.account_id);
  if (!a) bad('not found', 404);
  const data = body || {};
  const err = applyAccountFields(db, a, data, { requireAll: false });
  if (err) bad(err);
  const dup = db.prepare('SELECT id FROM accounts WHERE name = ?').get(a.name);
  if (dup && dup.id !== a.id) bad('account already exists', 409);
  db.prepare('UPDATE accounts SET name = ?, kind = ?, balance_column = ? WHERE id = ?').run(
    a.name,
    a.kind,
    a.balance_column,
    a.id
  );
  return { ok: true, account: serialiseAccount(a, latestAnchors(db).get(a.id)) };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  const a = getAccount(db, params.account_id);
  if (!a) bad('not found', 404);
  db.transaction(() => {
    // Transactions are the user's financial record — deleting an account only
    // unassigns them (account_id back to NULL), never deletes them. Anchors
    // are observations OF the account, so they go with it.
    db.prepare('UPDATE transactions SET account_id = NULL WHERE account_id = ?').run(a.id);
    db.prepare('DELETE FROM account_balance_anchors WHERE account_id = ?').run(a.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
  })();
  return { ok: true };
}

/** Upsert one balance observation. The (account, date, source) key means a
 *  re-import of the same statement updates its 'file' anchor in place and can
 *  never clobber a 'manual' one the user typed for the same day. */
function anchorUpsert(ctx, { params, body }) {
  const db = ctx.db();
  const a = getAccount(db, params.account_id);
  if (!a) bad('not found', 404);
  const data = body || {};
  const date = parseIsoDate(data.date);
  if (!date) bad('invalid date (expected YYYY-MM-DD)');
  if (!isFiniteNumber(data.balance)) bad('invalid balance');
  const source = data.source === undefined ? 'manual' : data.source;
  if (!ANCHOR_SOURCES.includes(source)) {
    bad(`source must be one of: ${ANCHOR_SOURCES.join(', ')}`);
  }
  db.prepare(
    `INSERT INTO account_balance_anchors (account_id, date, balance, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, date, source) DO UPDATE SET balance = excluded.balance`
  ).run(a.id, date, round2(data.balance), source);
  return { ok: true };
}

function anchorDelete(ctx, { params, body }) {
  const db = ctx.db();
  const a = getAccount(db, params.account_id);
  if (!a) bad('not found', 404);
  const data = body || {};
  const date = parseIsoDate(data.date);
  if (!date) bad('invalid date (expected YYYY-MM-DD)');
  const source = data.source === undefined ? 'manual' : data.source;
  if (!ANCHOR_SOURCES.includes(source)) {
    bad(`source must be one of: ${ANCHOR_SOURCES.join(', ')}`);
  }
  db.prepare(
    'DELETE FROM account_balance_anchors WHERE account_id = ? AND date = ? AND source = ?'
  ).run(a.id, date, source);
  return { ok: true };
}

const routes = [
  ['GET', '/api/accounts', list],
  ['POST', '/api/accounts', create],
  ['PUT', '/api/accounts/<int:account_id>', update],
  ['DELETE', '/api/accounts/<int:account_id>', remove],
  ['POST', '/api/accounts/<int:account_id>/anchors', anchorUpsert],
  ['DELETE', '/api/accounts/<int:account_id>/anchors', anchorDelete],
];

module.exports = { routes, ACCOUNT_KINDS, latestAnchors };
