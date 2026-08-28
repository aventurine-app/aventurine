'use strict';

// Balance Forecast (Reports) blueprint. Read endpoint projects a running
// weekly balance; the planned-items endpoints are plain CRUD over the
// forecast_planned table (schema v2). Projection logic lives in
// services/forecast.js; this handler only gathers inputs and validates writes.

const { bad, cleanLabel, isFiniteNumber, round2, parseIsoDate } = require('../validate');
const { forecast, HISTORY_MONTHS } = require('../services/forecast');

const ALLOWED_MONTHS = new Set([1, 3, 6]);
const DEFAULT_MONTHS = 3;
const VALID_FLOWS = new Set(['income', 'expense']);

function serialisePlanned(p) {
  return { id: p.id, label: p.label, amount: p.amount, flow: p.flow, date: p.date };
}

function plannedList(db) {
  return db
    .prepare('SELECT * FROM forecast_planned ORDER BY date, id')
    .all()
    .map(serialisePlanned);
}

/**
 * Each cash-type Balance-Sheet account (column) paired with its latest available
 * balance — the value entered for the most recent (year, month) that account has
 * data for. Only `col_type = 'cash'` columns are listed: the forecast tracks a
 * spendable cash balance, so investment/retirement/debt accounts are not offered
 * as a starting point. `balance` is null when the account has no entries yet.
 * `month` is stored as 1-12, so recency is by (year, month).
 * Ordered by column position so the picker mirrors the Balance Sheet's order.
 *
 * `as_of` is the 'YYYY-MM' that balance was recorded for, and it is reported
 * rather than assumed to be current: the Balance Sheet is month-granular and
 * hand-editable, so a user who last imported in March gets a March figure while
 * the projection starts from today. The gap cannot be closed here (the
 * transactions in between are already spent, and re-deriving a live balance from
 * them would double-count anything the sheet cell already includes), so the
 * renderer displays the date alongside the figure.
 *
 * This builds the renderer's account drop-down, and the starting balance is
 * resolved against it (see resolveStart).
 */
function accountBalances(db) {
  const cols = db
    .prepare(
      // hidden = 0: unadopted starter accounts are not listed.
      `SELECT "key", label, col_type, position FROM balance_columns
        WHERE col_type = 'cash' AND hidden = 0 ORDER BY position`
    )
    .all();

  // Newest (year, month) entry per account key. month is stored as 1-12.
  const latest = new Map();
  for (const r of db.prepare('SELECT category, year, month, value FROM balance_entries').all()) {
    const cur = latest.get(r.category);
    if (!cur || r.year > cur.year || (r.year === cur.year && r.month > cur.idx)) {
      latest.set(r.category, { year: r.year, idx: r.month, value: r.value });
    }
  }

  return cols.map((c) => {
    const l = latest.get(c.key);
    return {
      key: c.key,
      label: c.label,
      type: c.col_type,
      balance: l ? round2(l.value) : null,
      as_of: l ? `${l.year}-${String(l.idx).padStart(2, '0')}` : null,
    };
  });
}

/**
 * Pick the account the forecast starts from. An explicit `accountKey` must match
 * one of the (cash) accounts, else 400, so a non-cash column cannot be selected.
 * With no key, defaults to the first cash account. Returns the chosen account
 * object (from `accounts`) or null when there are no cash accounts.
 */
function resolveStart(accounts, accountKey) {
  if (accountKey !== undefined && accountKey !== '') {
    const chosen = accounts.find((a) => a.key === accountKey);
    if (!chosen) bad('invalid account');
    return chosen;
  }
  return accounts[0] || null;
}

/**
 * Split transactions into income/expense the same way /api/transactions and the
 * predictions card do: a categorized row's direction follows its
 * Category.cat_type; an uncategorized row keeps its stored tx_type. With
 * `includeTransfers`, transfer-typed rows are added to the expense (outflow)
 * bucket — money moved out of the cash account into savings or a brokerage; with
 * it off they are excluded, so the projection shows the balance as if that money
 * had stayed in the account.
 *
 * SCOPE: the projection tracks ONE account's balance, so it uses that account's
 * flows. Reading the whole ledger distorted a Checking forecast with money spent
 * on a credit card or out of savings — in a two-account ledger where every
 * charge belonged to Savings, Checking was still projected $1,000 below zero.
 * Rows carry `account_key` since v10.
 *
 * The fallback matters as much as the rule: an account with NO rows of its own
 * falls back to the whole ledger rather than forecasting a flat line. That is
 * the shape of every pre-v10 import (account_key NULL throughout) and of a
 * single-account user who never picked one, and for them the whole ledger IS
 * this account's activity. Which of the two applied is returned as `scope` so
 * the renderer can label the figure.
 *
 * `activeMonths` is every 'YYYY-MM' the scoped rows touch — including months
 * that are all transfers with transfers switched off, which are real months with
 * no spendable flow (see windowAverages).
 */
function directionSplit(db, { includeTransfers, accountKey }) {
  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const all = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  const owned = accountKey ? all.filter((t) => t.account_key === accountKey) : [];
  const rows = owned.length ? owned : all;

  const income = [];
  const expense = [];
  const activeMonths = new Set();
  for (const t of rows) {
    if (t.date) activeMonths.add(t.date.slice(0, 7));
    const dir = t.category_id != null ? catTypes.get(t.category_id) ?? t.tx_type : t.tx_type;
    if (dir === 'income') income.push(t);
    else if (dir === 'expense') expense.push(t);
    else if (includeTransfers && dir === 'transfer') expense.push(t);
  }
  return { income, expense, activeMonths, scope: owned.length ? 'account' : 'ledger' };
}

function getForecast(ctx, { query }) {
  const db = ctx.db();

  let months = parseInt(query.months, 10);
  if (!ALLOWED_MONTHS.has(months)) months = DEFAULT_MONTHS;

  // Starting balance comes from a chosen Balance-Sheet account's latest entry
  // (?account=<key>), defaulting to the first cash account. An account with no
  // entries yet — or no accounts at all — starts the forecast from 0.
  const accounts = accountBalances(db);
  const startAccount = resolveStart(accounts, query.account);
  const startBalance = startAccount && startAccount.balance != null ? startAccount.balance : 0;

  // Transfers are treated as outflows by default (they leave the cash account
  // on their way to savings/a brokerage); ?include_transfers=0 leaves them out
  // so the projection reflects only spendable income vs expenses.
  const includeTransfers = query.include_transfers !== '0' && query.include_transfers !== 'false';

  const accountKey = startAccount ? startAccount.key : null;
  const { income, expense, activeMonths, scope } = directionSplit(db, {
    includeTransfers, accountKey,
  });
  const planned = plannedList(db);

  const result = forecast({
    startBalance, income, expense, planned, months,
    window: HISTORY_MONTHS, activeMonths,
  });
  return {
    ok: true,
    months,
    start_balance: startBalance,
    start_account: accountKey,
    // Which month the starting balance was recorded for — null when there is no
    // balance. The renderer displays it when it is not recent (accountBalances).
    start_as_of: startAccount ? startAccount.as_of : null,
    // 'account' when the projection uses the chosen account's own rows,
    // 'ledger' when it fell back to every transaction (see directionSplit).
    scope,
    accounts,
    include_transfers: includeTransfers,
    history_months: HISTORY_MONTHS,
    anchor: result.anchor,
    domain: result.domain,
    // Actual weekly balances for the same span BEFORE today — the left half of
    // the chart, against which the projection on the right is read.
    history: result.history,
    series: result.series,
    summary: result.summary,
    planned,
  };
}

// ── Planned-items CRUD ───────────────────────────────────────────────────────

/** Validate a planned-item field set. With requireAll, every field must be
 *  present (create); otherwise only the provided fields are validated (update).
 *  Returns a partial { label, amount, flow, date } of the cleaned values. */
function parsePlanned(body, { requireAll }) {
  if (!body || typeof body !== 'object') bad('invalid request');
  const out = {};

  const has = (k) => k in body;
  if (requireAll || has('label')) {
    const label = cleanLabel(body.label);
    if (!label) bad('label required');
    out.label = label;
  }
  if (requireAll || has('amount')) {
    if (!isFiniteNumber(body.amount) || body.amount <= 0) bad('invalid amount');
    out.amount = round2(body.amount);
  }
  if (requireAll || has('flow')) {
    if (!VALID_FLOWS.has(body.flow)) bad('invalid flow');
    out.flow = body.flow;
  }
  if (requireAll || has('date')) {
    const date = parseIsoDate(body.date);
    if (!date) bad('invalid date');
    out.date = date;
  }
  return out;
}

function addPlanned(ctx, { body }) {
  const db = ctx.db();
  const p = parsePlanned(body, { requireAll: true });
  const info = db
    .prepare('INSERT INTO forecast_planned (label, amount, flow, date) VALUES (?, ?, ?, ?)')
    .run(p.label, p.amount, p.flow, p.date);
  const row = db.prepare('SELECT * FROM forecast_planned WHERE id = ?').get(info.lastInsertRowid);
  return { ok: true, item: serialisePlanned(row) };
}

function updatePlanned(ctx, { params, body }) {
  const db = ctx.db();
  const row = db.prepare('SELECT * FROM forecast_planned WHERE id = ?').get(params.item_id);
  if (!row) bad('not found', 404);
  const p = parsePlanned(body, { requireAll: false });
  const next = { ...row, ...p };
  db.prepare(
    'UPDATE forecast_planned SET label = ?, amount = ?, flow = ?, date = ? WHERE id = ?'
  ).run(next.label, next.amount, next.flow, next.date, row.id);
  return { ok: true, item: serialisePlanned(next) };
}

function deletePlanned(ctx, { params }) {
  const db = ctx.db();
  const row = db.prepare('SELECT id FROM forecast_planned WHERE id = ?').get(params.item_id);
  if (!row) bad('not found', 404);
  db.prepare('DELETE FROM forecast_planned WHERE id = ?').run(row.id);
  return { ok: true };
}

const routes = [
  ['GET', '/api/forecast', getForecast],
  ['POST', '/api/forecast/planned', addPlanned],
  ['PUT', '/api/forecast/planned/<int:item_id>', updatePlanned],
  ['DELETE', '/api/forecast/planned/<int:item_id>', deletePlanned],
];

module.exports = { routes };
