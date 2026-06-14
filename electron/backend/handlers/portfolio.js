'use strict';

// Portfolio blueprint — port of routes/portfolio.py.

const { bad, cleanLabel, isFiniteNumber } = require('../validate');

function serialiseEntry(e) {
  return {
    id: e.id,
    ticker: e.ticker,
    asset_name: e.asset_name,
    amount: e.amount,
    price: e.price,
    market_price: e.market_price,
  };
}

function entriesFor(db, accountId) {
  return db
    .prepare('SELECT * FROM portfolio_entries WHERE account_id = ?')
    .all(accountId)
    .map(serialiseEntry);
}

function data(ctx) {
  const db = ctx.db();
  const accounts = db.prepare('SELECT * FROM portfolio_accounts').all();
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, entries: entriesFor(db, a.id) })),
  };
}

function addAccount(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');
  const name = cleanLabel(body.name ?? 'New Account') || 'New Account';
  const info = db.prepare('INSERT INTO portfolio_accounts (name) VALUES (?)').run(name);
  return { ok: true, account: { id: info.lastInsertRowid, name, entries: [] } };
}

function updateAccount(ctx, { params, body }) {
  const db = ctx.db();
  const account = db
    .prepare('SELECT * FROM portfolio_accounts WHERE id = ?')
    .get(params.account_id);
  if (!account) bad('not found', 404);
  if (!body) bad('invalid request');
  if ('name' in body) {
    const name = cleanLabel(body.name);
    if (!name) bad('name required');
    db.prepare('UPDATE portfolio_accounts SET name = ? WHERE id = ?').run(name, account.id);
  }
  return { ok: true };
}

function duplicateAccount(ctx, { params }) {
  const db = ctx.db();
  const orig = db
    .prepare('SELECT * FROM portfolio_accounts WHERE id = ?')
    .get(params.account_id);
  if (!orig) bad('not found', 404);
  const copyId = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO portfolio_accounts (name) VALUES (?)')
      .run(orig.name + ' (Copy)');
    db.prepare(
      `INSERT INTO portfolio_entries (account_id, asset_name, ticker, amount, price, market_price)
       SELECT ?, asset_name, ticker, amount, price, market_price
         FROM portfolio_entries WHERE account_id = ?`
    ).run(info.lastInsertRowid, orig.id);
    return info.lastInsertRowid;
  })();
  return {
    ok: true,
    account: { id: copyId, name: orig.name + ' (Copy)', entries: entriesFor(db, copyId) },
  };
}

function deleteAccount(ctx, { params }) {
  const db = ctx.db();
  const account = db
    .prepare('SELECT id FROM portfolio_accounts WHERE id = ?')
    .get(params.account_id);
  if (!account) bad('not found', 404);
  db.transaction(() => {
    db.prepare('DELETE FROM portfolio_entries WHERE account_id = ?').run(account.id);
    db.prepare('DELETE FROM portfolio_accounts WHERE id = ?').run(account.id);
  })();
  return { ok: true };
}

function addEntry(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');
  const accountId = body.account_id;
  if (typeof accountId !== 'number' || !Number.isInteger(accountId)) bad('invalid account_id');
  if (!db.prepare('SELECT 1 FROM portfolio_accounts WHERE id = ?').get(accountId)) {
    bad('account not found', 404);
  }
  // Model defaults: empty strings + zeros (mirror of PortfolioEntry()).
  const info = db
    .prepare(
      `INSERT INTO portfolio_entries (account_id, ticker, asset_name, amount, price, market_price)
       VALUES (?, '', '', 0, 0, 0)`
    )
    .run(accountId);
  const e = db.prepare('SELECT * FROM portfolio_entries WHERE id = ?').get(info.lastInsertRowid);
  return { ok: true, entry: serialiseEntry(e) };
}

function updateEntry(ctx, { params, body }) {
  const db = ctx.db();
  const e = db.prepare('SELECT * FROM portfolio_entries WHERE id = ?').get(params.entry_id);
  if (!e) bad('not found', 404);
  if (!body) bad('invalid request');

  if ('ticker' in body) {
    if (typeof body.ticker !== 'string') bad('invalid ticker');
    e.ticker = body.ticker.slice(0, 20).toUpperCase();
  }
  if ('asset_name' in body) {
    if (typeof body.asset_name !== 'string') bad('invalid asset_name');
    e.asset_name = body.asset_name.slice(0, 100);
  }
  // No 2dp rounding here on purpose: amount is a share/unit count and the
  // price fields legitimately carry sub-cent precision. Finiteness is still
  // enforced — one NaN breaks every reader.
  for (const field of ['amount', 'price', 'market_price']) {
    if (field in body) {
      if (!isFiniteNumber(body[field])) bad(`invalid ${field}`);
      e[field] = body[field];
    }
  }
  db.prepare(
    `UPDATE portfolio_entries
        SET ticker = ?, asset_name = ?, amount = ?, price = ?, market_price = ?
      WHERE id = ?`
  ).run(e.ticker, e.asset_name, e.amount, e.price, e.market_price, e.id);
  return { ok: true };
}

function deleteEntry(ctx, { params }) {
  const db = ctx.db();
  const e = db.prepare('SELECT id FROM portfolio_entries WHERE id = ?').get(params.entry_id);
  if (!e) bad('not found', 404);
  db.prepare('DELETE FROM portfolio_entries WHERE id = ?').run(e.id);
  return { ok: true };
}

const routes = [
  ['GET', '/api/portfolio/data', data],
  ['POST', '/api/portfolio/account', addAccount],
  ['PUT', '/api/portfolio/account/<int:account_id>', updateAccount],
  ['POST', '/api/portfolio/account/<int:account_id>/duplicate', duplicateAccount],
  ['DELETE', '/api/portfolio/account/<int:account_id>', deleteAccount],
  ['POST', '/api/portfolio/entry', addEntry],
  ['PUT', '/api/portfolio/entry/<int:entry_id>', updateEntry],
  ['DELETE', '/api/portfolio/entry/<int:entry_id>', deleteEntry],
];

module.exports = { routes };
