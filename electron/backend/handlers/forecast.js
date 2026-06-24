'use strict';

// Cash Flow Forecast (Reports) blueprint. Read endpoint projects a running
// weekly balance; the planned-items endpoints are plain CRUD over the
// forecast_planned table (schema v2). Projection logic lives in
// services/forecast.js; this handler only gathers inputs and validates writes.

const { bad, cleanLabel, isFiniteNumber, round2, parseIsoDate } = require('../validate');
const { forecast } = require('../services/forecast');

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
 * spendable cash balance, so investment/retirement/debt accounts aren't offered
 * as a starting point. `balance` is null when the account has no entries yet.
 * `month` is stored as 1-12, so recency is by (year, month).
 * Ordered by column position so the picker mirrors the Balance Sheet's order.
 *
 * This is what the renderer's account drop-down is built from, and what the
 * starting balance is resolved against (see resolveStart).
 */
function accountBalances(db) {
  const cols = db
    .prepare(
      `SELECT "key", label, col_type, position FROM balance_columns
        WHERE col_type = 'cash' ORDER BY position`
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
    };
  });
}

/**
 * Pick the account the forecast starts from. An explicit `accountKey` must match
 * one of the (cash) accounts (else 400) — selecting a non-cash column is what
 * keeps the picker honest. With no key, default to the first cash account.
 * Returns the chosen account object (from `accounts`) or null when there are no
 * cash accounts at all.
 */
function resolveStart(accounts, accountKey) {
  if (accountKey !== undefined && accountKey !== '') {
    const chosen = accounts.find((a) => a.key === accountKey);
    if (!chosen) bad('invalid account');
    return chosen;
  }
  return accounts[0] || null;
}

/** Split transactions into income/expense the same way /api/transactions and
 *  the predictions card do: a categorized row's direction follows its
 *  Category.cat_type; an uncategorized row keeps its stored tx_type. With
 *  `includeSavings`, savings- and investing-typed rows are folded into the
 *  expense (outflow) bucket — money moved out of the cash account on its way to
 *  savings/investments; with it off they're dropped, so the projection shows the
 *  balance as if that money had stayed put. */
function directionSplit(db, includeSavings) {
  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const income = [];
  const expense = [];
  for (const t of db.prepare('SELECT * FROM transactions ORDER BY date').all()) {
    const dir = t.category_id != null ? catTypes.get(t.category_id) ?? t.tx_type : t.tx_type;
    if (dir === 'income') income.push(t);
    else if (dir === 'expense') expense.push(t);
    else if (includeSavings && (dir === 'savings' || dir === 'investing')) expense.push(t);
  }
  return { income, expense };
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

  // Savings/investing transfers are treated as outflows by default (they leave
  // the cash account); ?include_savings=0 leaves them out so the projection
  // reflects only spendable income vs expenses.
  const includeSavings = query.include_savings !== '0' && query.include_savings !== 'false';

  const { income, expense } = directionSplit(db, includeSavings);
  const planned = plannedList(db);

  const result = forecast({ startBalance, income, expense, planned, months });
  return {
    ok: true,
    months,
    start_balance: startBalance,
    start_account: startAccount ? startAccount.key : null,
    accounts,
    include_savings: includeSavings,
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
