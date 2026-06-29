'use strict';

// Cash Flow Forecast (Reports). This feature is NEW (not a Python port), so
// there is no oracle fixture — the WEEKLY hybrid projection is pinned by the
// deterministic unit tests below (a fixed `today` removes the only time
// dependency), and the endpoints + planned-items CRUD by API tests. The v1→v2
// migration is checked against a simulated legacy DB.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  forecast, trailingAverage, monthlyTotals,
  recurringPatterns, placeRecurring, weekCount, horizonEnd, addMonthKey,
} = require('../services/forecast');
const { localTodayIso } = require('../services/predictions');
const { connect } = require('../db');
const { bootstrapSchema } = require('../migrate');
const { seedDefaults } = require('../seed');
const { SCHEMA_VERSION } = require('../schema');
const { makeClient } = require('./helpers');

// ── tiny builders (only .date/.amount/.description matter to the service) ─────
const inc = (date, amount, description = 'Paycheck') => ({ date, amount, description });
const exp = (date, amount, description = 'Rent') => ({ date, amount, description });

// ── weekly skeleton: planned items land in the week they fall in ─────────────

test('forecast: a planned item bends the week it lands in (no history)', () => {
  const planned = [{ amount: 300, flow: 'expense', date: '2026-06-10' }];
  const r = forecast({ startBalance: 1000, income: [], expense: [], planned, months: 1, today: '2026-06-01' });

  // 1-month horizon from Jun 1 → Jul 1 is 30 days → 5 weekly buckets.
  assert.equal(r.series.length, 5);
  assert.deepStrictEqual(r.series.map((s) => s.weekStart),
    ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']);
  // Jun 10 is 9 days out → week index 1.
  assert.equal(r.series[1].expense, 300);
  assert.deepStrictEqual(r.series.map((s) => s.balance), [1000, 700, 700, 700, 700]);
  assert.deepStrictEqual(r.summary.lowest, { weekStart: '2026-06-08', label: 'Jun 8', balance: 700 });
  assert.equal(r.summary.belowZero, false);
  assert.equal(r.summary.monthsUsed, 0);
});

test('forecast: a planned dip drives the lowest point + below-zero flag', () => {
  const planned = [
    { amount: 800, flow: 'expense', date: '2026-06-10' }, // week 1
    { amount: 800, flow: 'income', date: '2026-06-20' },  // week 2
  ];
  const r = forecast({ startBalance: 500, income: [], expense: [], planned, months: 1, today: '2026-06-01' });
  assert.deepStrictEqual(r.series.map((s) => s.balance), [500, -300, 500, 500, 500]);
  assert.equal(r.summary.belowZero, true);
  assert.deepStrictEqual(r.summary.lowest, { weekStart: '2026-06-08', label: 'Jun 8', balance: -300 });
});

// ── the hybrid: recurring bills + paychecks land on their due weeks ──────────

test('forecast: recurring rent + paycheck are placed on the weeks they recur', () => {
  // Five months of a monthly paycheck (1st) and monthly rent (15th). With no
  // other transactions the smooth baseline is zero, so the line is pure timing:
  // it steps up on payday weeks and down on rent weeks.
  const income = ['01', '02', '03', '04', '05'].map((m) => inc(`2026-${m}-01`, 4000));
  const expense = ['01', '02', '03', '04', '05'].map((m) => exp(`2026-${m}-15`, 1500));
  const r = forecast({ startBalance: 1000, income, expense, planned: [], months: 3, today: '2026-06-01' });

  // 3 months → Sep 1 is 92 days out → 14 weekly buckets.
  assert.equal(r.series.length, 14);
  // Paychecks land in weeks 0/4/8 (Jun 1, Jul 1, Aug 1); rent in weeks 2/6/10.
  assert.deepStrictEqual(r.series.map((s) => s.balance), [
    5000, 5000, 3500, 3500, 7500, 7500, 6000, 6000, 10000, 10000, 8500, 8500, 8500, 8500,
  ]);
  assert.equal(r.summary.endBalance, 8500);
  assert.deepStrictEqual(r.summary.lowest, { weekStart: '2026-06-15', label: 'Jun 15', balance: 3500 });
  assert.equal(r.summary.belowZero, false);
  // The summary's "typical month" still reflects the FULL average.
  assert.equal(r.summary.avgIncome, 4000);
  assert.equal(r.summary.avgExpense, 1500);
  assert.equal(r.summary.monthsUsed, 3);
});

// ── the smooth baseline: irregular spending is spread evenly per-day ──────────

test('forecast: irregular (non-recurring) spend is smoothed across the weeks', () => {
  // Three one-off May expenses (distinct merchants → never detected as
  // recurring) totalling 3043.75 = a clean 100/day once divided by 30.4375.
  const expense = [
    exp('2026-05-05', 1043.75, 'Vet bill'),
    exp('2026-05-15', 1000, 'Car repair'),
    exp('2026-05-25', 1000, 'Dentist'),
  ];
  const r = forecast({ startBalance: 0, income: [], expense, planned: [], months: 1, today: '2026-06-01' });

  // window=1 → only May counts; nothing is recurring so it's the whole baseline.
  assert.equal(r.summary.monthsUsed, 1);
  assert.equal(r.summary.avgExpense, 3043.75);
  // 100/day: four full weeks of 700 then a 2-day tail of 200.
  assert.deepStrictEqual(r.series.map((s) => s.expense), [700, 700, 700, 700, 200]);
  assert.deepStrictEqual(r.series.map((s) => s.balance), [-700, -1400, -2100, -2800, -3000]);
  assert.equal(r.summary.belowZero, true);
});

test('forecast: no usable history → a flat line at the start balance', () => {
  // Transactions exist only in the current (incomplete) month.
  const income = [inc('2026-06-03', 5000, 'One-off')];
  const r = forecast({ startBalance: 1000, income, expense: [], planned: [], months: 3, today: '2026-06-10' });
  assert.equal(r.summary.monthsUsed, 0);
  assert.ok(r.series.every((s) => s.balance === 1000));
});

// ── money rounding stays exact ────────────────────────────────────────────────

test('forecast: monetary outputs are round2-clean', () => {
  const planned = [{ amount: 0.2, flow: 'expense', date: '2026-03-01' }];
  const r = forecast({ startBalance: 0.1, income: [], expense: [], planned, months: 1, today: '2026-03-01' });
  assert.equal(r.series[0].balance, -0.1);
});

// ── recurring-pattern detection + projection in isolation ─────────────────────

test('recurringPatterns: detects a monthly bill and projects it forward', () => {
  const rent = ['01', '02', '03', '04', '05'].map((m) => exp(`2026-${m}-15`, 1500));
  const patterns = recurringPatterns(rent, '2026-06-01');
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].name, 'monthly');
  assert.equal(patterns[0].amount, 1500);
  assert.equal(patterns[0].last, '2026-05-15');

  const occ = placeRecurring(patterns, '2026-06-01', '2026-09-01');
  assert.deepStrictEqual(occ, [
    { date: '2026-06-15', amount: 1500 },
    { date: '2026-07-15', amount: 1500 },
    { date: '2026-08-15', amount: 1500 },
  ]);
});

test('recurringPatterns: a lapsed pattern (overdue beyond tolerance) is dropped', () => {
  // Last charge in Feb; by June the next due (Mar) is long overdue → cancelled.
  const rows = [exp('2025-12-15', 1500), exp('2026-01-15', 1500), exp('2026-02-15', 1500)];
  assert.equal(recurringPatterns(rows, '2026-06-01').length, 0);
});

test('trailingAverage: window/exclusion rules in isolation', () => {
  const totals = monthlyTotals(
    [inc('2026-03-01', 100), inc('2026-04-01', 200), inc('2026-05-01', 300), inc('2026-06-01', 9999)],
    []
  );
  const a = trailingAverage(totals, { today: '2026-06-15', window: 3 });
  assert.deepStrictEqual(a, { avgIncome: 200, avgExpense: 0, monthsUsed: 3 }); // (100+200+300)/3, Jun excluded
});

// ── API ──────────────────────────────────────────────────────────────────────

test('forecast API: default shape, fresh DB', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/forecast');
  const today = localTodayIso();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.months, 3);
  assert.equal(r.body.series.length, weekCount(today, horizonEnd(today, 3)));
  // Default account is the seeded 'checking' column (first cash-type by
  // position), with no entries yet → starts from 0.
  assert.equal(r.body.start_account, 'checking');
  assert.equal(r.body.start_balance, 0);
  // The picker is fed the cash-type Balance-Sheet accounts only (seed ships two,
  // ordered by position), each with its latest balance (null until any entry exists).
  assert.deepStrictEqual(r.body.accounts.map((a) => a.key), ['checking', 'savings']);
  assert.ok(r.body.accounts.every((a) => a.type === 'cash' && a.balance === null));
  assert.equal(r.body.include_savings, true); // savings/investing counted by default
  assert.deepStrictEqual(r.body.planned, []);
});

test('forecast API: savings/investing flows can be excluded from the projection', (t) => {
  const c = makeClient(t);
  // Three monthly transfers to savings in the trailing window (uncategorized
  // rows keep their explicit tx_type). The 15th of each of the last 3 complete
  // months keeps them inside the default 3-month average window.
  const today = localTodayIso();
  const month = (back) => addMonthKey(today.slice(0, 7), -back);
  for (const back of [1, 2, 3]) {
    c.post('/api/transactions', {
      date: `${month(back)}-15`, description: 'Transfer to savings',
      tx_type: 'savings', amount: 500,
    });
  }

  // Included (default): the transfers register as outflows in the typical month.
  const inc = c.get('/api/forecast');
  assert.equal(inc.body.include_savings, true);
  assert.ok(inc.body.summary.avgExpense > 0, JSON.stringify(inc.body.summary));

  // Excluded: nothing left to spend → a flat, higher line.
  const exc = c.get('/api/forecast?include_savings=0');
  assert.equal(exc.body.include_savings, false);
  assert.equal(exc.body.summary.avgExpense, 0);
  assert.ok(exc.body.summary.endBalance > inc.body.summary.endBalance);
});

test('forecast API: months is clamped to {1,3,6}', (t) => {
  const c = makeClient(t);
  const today = localTodayIso();
  assert.equal(c.get('/api/forecast?months=1').body.series.length, weekCount(today, horizonEnd(today, 1)));
  assert.equal(c.get('/api/forecast?months=6').body.series.length, weekCount(today, horizonEnd(today, 6)));
  assert.equal(c.get('/api/forecast?months=5').body.months, 3);   // bad value → default
  assert.equal(c.get('/api/forecast?months=12').body.months, 3);  // no longer allowed → default
});

test('forecast API: only cash accounts are offered, and selectable', (t) => {
  const c = makeClient(t);
  const year = c.get('/api/balance/data').body.years[0];
  // Seed ships two cash columns ('checking', 'savings'); give both data.
  c.post('/api/balance/entry', { year, month: 'January', category: 'checking', value: 1000 });
  c.post('/api/balance/entry', { year, month: 'January', category: 'savings', value: 7500 });

  // Both cash accounts show up; the seeded investment/retirement/debt columns do not.
  const accounts = c.get('/api/forecast').body.accounts;
  assert.deepStrictEqual(accounts.map((a) => a.key).sort(), ['checking', 'savings']);

  // Selecting the other cash account starts the forecast from its latest balance.
  const ok = c.get('/api/forecast?account=savings');
  assert.equal(ok.body.start_account, 'savings');
  assert.equal(ok.body.start_balance, 7500);
  assert.equal(ok.body.series[0].balance, 7500); // no flows → unchanged in week 0

  // A non-cash column (seeded 'investments' is col_type=investment) is not selectable.
  assert.equal(c.get('/api/forecast?account=investments').status, 400);
  assert.equal(c.get('/api/forecast?account=does_not_exist').status, 400);
});

test('forecast API: default account uses the latest balance of the first cash account', (t) => {
  const c = makeClient(t);
  // Seed ships a 'checking' (col_type=cash, position 0) column; give it two months of data.
  const year = c.get('/api/balance/data').body.years[0];
  c.post('/api/balance/entry', { year, month: 'January', category: 'checking', value: 1000 });
  c.post('/api/balance/entry', { year, month: 'February', category: 'checking', value: 1500.5 });
  const r = c.get('/api/forecast');
  assert.equal(r.body.start_account, 'checking');
  assert.equal(r.body.start_balance, 1500.5); // latest month wins
  // The picker reports each account's latest balance.
  assert.equal(r.body.accounts.find((a) => a.key === 'checking').balance, 1500.5);
});

test('forecast API: planned-items CRUD', (t) => {
  const c = makeClient(t);

  const add = c.post('/api/forecast/planned', { label: 'Property tax', amount: 4000, flow: 'expense', date: '2099-09-01' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const id = add.body.item.id;
  assert.equal(add.body.item.label, 'Property tax');
  assert.equal(add.body.item.amount, 4000);

  // Shows up in the read endpoint.
  assert.equal(c.get('/api/forecast').body.planned.some((p) => p.id === id), true);

  // Update.
  const upd = c.put(`/api/forecast/planned/${id}`, { amount: 4200 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.item.amount, 4200);
  assert.equal(upd.body.item.label, 'Property tax'); // untouched fields preserved

  // Delete.
  assert.equal(c.del(`/api/forecast/planned/${id}`).status, 200);
  assert.equal(c.get('/api/forecast').body.planned.length, 0);
});

test('forecast API: planned-items validation + 404', (t) => {
  const c = makeClient(t);
  const base = { label: 'X', amount: 10, flow: 'expense', date: '2099-01-01' };
  assert.equal(c.post('/api/forecast/planned', { ...base, label: '' }).status, 400);
  assert.equal(c.post('/api/forecast/planned', { ...base, amount: 0 }).status, 400);
  assert.equal(c.post('/api/forecast/planned', { ...base, amount: 'x' }).status, 400);
  assert.equal(c.post('/api/forecast/planned', { ...base, flow: 'transfer' }).status, 400);
  assert.equal(c.post('/api/forecast/planned', { ...base, date: '2099-13-40' }).status, 400);
  assert.equal(c.put('/api/forecast/planned/9999', { amount: 5 }).status, 404);
  assert.equal(c.del('/api/forecast/planned/9999').status, 404);
});

test('forecast API: a planned item dated today bends week 0', (t) => {
  const c = makeClient(t);
  const year = c.get('/api/balance/data').body.years[0];
  c.post('/api/balance/entry', { year, month: 'January', category: 'checking', value: 1000 });
  const today = localTodayIso();
  c.post('/api/forecast/planned', { label: 'Big bill', amount: 250, flow: 'expense', date: today });
  const r = c.get('/api/forecast?months=3');
  assert.equal(r.body.series[0].expense, 250);
  assert.equal(r.body.series[0].balance, 750);
});

// ── migration v1 → v2 ────────────────────────────────────────────────────────

test('migration: fresh DB is at SCHEMA_VERSION with forecast_planned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mig-'));
  const dbPath = path.join(dir, 'fresh.db');
  try {
    const db = connect(dbPath, null);
    bootstrapSchema(db);
    assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_planned'").get());
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a legacy v1 DB climbs to SCHEMA_VERSION and gains the new tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mig-'));
  const dbPath = path.join(dir, 'legacy.db');
  try {
    const db = connect(dbPath, null);
    bootstrapSchema(db);
    seedDefaults(db);
    // Simulate a DB created before these features: drop the post-v1 tables, drop to v1.
    db.exec('DROP TABLE forecast_planned');
    db.exec('DROP TABLE budget_amounts');
    db.pragma('user_version = 1');

    bootstrapSchema(db); // re-run the bootstrap as conn.init() would
    assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
    const has = (tbl) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    assert.ok(has('forecast_planned'), 'forecast_planned recreated');
    assert.ok(has('budget_amounts'), 'budget_amounts recreated');
    // The per-month budget tables are created by v3/v4 then retired by v6.
    assert.ok(!has('budget_targets'), 'budget_targets retired by v6');
    assert.ok(!has('budget_income'), 'budget_income retired by v6');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v6: per-month targets collapse to one recurring amount (most recent month)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mig6-'));
  const dbPath = path.join(dir, 'pre6.db');
  try {
    const db = connect(dbPath, null);
    bootstrapSchema(db);
    seedDefaults(db);
    // Recreate the pre-v6 budget tables in their v3/v4 shape (month VARCHAR) and
    // seed per-month targets, then drop the version below 6 so only v6 runs.
    db.exec('DROP TABLE budget_amounts');
    db.exec(`CREATE TABLE budget_targets (
       id INTEGER NOT NULL, year INTEGER NOT NULL, month VARCHAR(20) NOT NULL,
       category VARCHAR(50) NOT NULL, amount FLOAT NOT NULL,
       PRIMARY KEY (id), CONSTRAINT uq_budget_target UNIQUE (year, month, category))`);
    db.exec(`CREATE TABLE budget_income (
       year INTEGER NOT NULL, month VARCHAR(20) NOT NULL, amount FLOAT NOT NULL,
       PRIMARY KEY (year, month))`);
    const ins = db.prepare('INSERT INTO budget_targets (year, month, category, amount) VALUES (?, ?, ?, ?)');
    // groceries budgeted across three months of 2026 — November (month 11) is the
    // most recent and must win. This also pins the CAST: as TEXT the string '11'
    // sorts BEFORE '3', so a lexical comparison would wrongly pick March (400).
    ins.run(2026, 3, 'groceries', 400);
    ins.run(2026, 11, 'groceries', 525);
    ins.run(2026, 5, 'groceries', 480);
    // rent budgeted in two years — the later year wins.
    ins.run(2026, 12, 'rent', 1500);
    ins.run(2027, 1, 'rent', 1600);
    db.prepare('INSERT INTO budget_income (year, month, amount) VALUES (?, ?, ?)').run(2026, 3, 4200);
    db.pragma('user_version = 5');

    bootstrapSchema(db); // climbs 5 -> SCHEMA_VERSION, running only v6
    assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);

    const amounts = Object.fromEntries(
      db.prepare('SELECT category, amount FROM budget_amounts').all().map((r) => [r.category, r.amount])
    );
    assert.equal(amounts.groceries, 525, 'most recent month (Nov) wins, compared numerically');
    assert.equal(amounts.rent, 1600, 'most recent year wins');

    const has = (tbl) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    assert.ok(!has('budget_targets'), 'budget_targets dropped by v6');
    assert.ok(!has('budget_income'), 'budget_income dropped by v6');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
