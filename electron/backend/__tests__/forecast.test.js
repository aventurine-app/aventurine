'use strict';

// Balance Forecast (Reports). This feature is NEW (not a Python port), so
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
  forecast, trailingAverage, monthlyTotals, HISTORY_MONTHS, historySeries,
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
  // The summary's "typical month" still reflects the FULL average — over the
  // trailing HISTORY_MONTHS window (Jan-May here, clamped to the first month of
  // data), NOT the 3-month horizon this call asked to draw.
  assert.equal(r.summary.avgIncome, 4000);
  assert.equal(r.summary.avgExpense, 1500);
  assert.equal(r.summary.monthsUsed, 5);
});

// ── horizon and history window are independent knobs ─────────────────────────

test('forecast: the horizon does not change the estimated slope', () => {
  // Spending stepped down three months ago. Back when the trailing window WAS
  // the horizon, asking for a longer view silently re-estimated the burn rate
  // from the older, higher months — 3 months projected ~1000/mo, 6 months
  // ~3000/mo, off the same ledger. All three horizons must now agree.
  const expense = [
    exp('2025-12-10', 5000, 'Old habit A'), exp('2026-01-10', 5000, 'Old habit B'),
    exp('2026-02-10', 5000, 'Old habit C'), exp('2026-03-10', 1000, 'New habit A'),
    exp('2026-04-10', 1000, 'New habit B'), exp('2026-05-10', 1000, 'New habit C'),
  ];
  const burn = (months) => {
    const r = forecast({
      startBalance: 10000, income: [], expense, planned: [], months,
      window: 3, today: '2026-06-01',
    });
    return (10000 - r.summary.endBalance) / months;
  };
  // window: 3 → Mar/Apr/May → 1000/mo, whichever horizon is drawn.
  for (const months of [1, 3, 6]) {
    assert.ok(Math.abs(burn(months) - 1000) < 25, `horizon ${months}mo implied ${burn(months)}/mo`);
  }
});

test('forecast: months the ledger never saw are not averaged in as zeros', () => {
  // A steady 3000/mo with Feb and Mar missing (never imported). Counting the
  // gap as two months of zero spending deflated the typical month to 2000.
  const expense = [
    exp('2025-12-10', 3000, 'Spend A'), exp('2026-01-10', 3000, 'Spend B'),
    exp('2026-04-10', 3000, 'Spend C'), exp('2026-05-10', 3000, 'Spend D'),
  ];
  const activeMonths = new Set(['2025-12', '2026-01', '2026-04', '2026-05']);
  const r = forecast({
    startBalance: 0, income: [], expense, planned: [], months: 3,
    window: 6, activeMonths, today: '2026-06-01',
  });
  assert.equal(r.summary.avgExpense, 3000);
  assert.equal(r.summary.monthsUsed, 4);

  // A month that IS in the ledger but held no income/expense stays a real zero.
  const withRealZero = new Set([...activeMonths, '2026-02', '2026-03']);
  const r2 = forecast({
    startBalance: 0, income: [], expense, planned: [], months: 3,
    window: 6, activeMonths: withRealZero, today: '2026-06-01',
  });
  assert.equal(r2.summary.avgExpense, 2000);
  assert.equal(r2.summary.monthsUsed, 6);
});

// ── the chart's opening point ────────────────────────────────────────────────

test('forecast: the anchor is today at the untouched starting balance', () => {
  // series[0] is already a week of flows in, so a chart drawing only the series
  // opens at the wrong height under a label reading today.
  const planned = [{ amount: 1200, flow: 'expense', date: '2026-06-01' }];
  const r = forecast({ startBalance: 5000, income: [], expense: [], planned, months: 1, today: '2026-06-01' });
  assert.deepStrictEqual(r.anchor, { date: '2026-06-01', balance: 5000 });
  assert.equal(r.series[0].balance, 3800);
  // Each week also carries the last day it covers — where its point belongs on
  // a date axis, since the balance shown is the one reached by the week's end.
  assert.equal(r.series[0].weekStart, '2026-06-01');
  assert.equal(r.series[0].weekEnd, '2026-06-07');
  assert.equal(r.summary.endDate, r.series[r.series.length - 1].weekEnd);
});

// ── actual history: the left half of the chart ───────────────────────────────

test('historySeries: walks the ledger backward from the starting balance', () => {
  // $1,000 out on May 4, $400 in on May 18, today's balance 5000. Each point is
  // the balance at the END of that day, so a flow dated ON a boundary is already
  // reflected in it and only LATER flows are undone.
  const income = [inc('2026-05-18', 400, 'Refund')];
  const expense = [exp('2026-05-04', 1000, 'Car repair')];
  const h = historySeries({
    endBalance: 5000, income, expense, spanDays: 35, today: '2026-06-01',
  });
  assert.deepStrictEqual(h.map((p) => [p.weekEnd, p.balance]), [
    ['2026-05-04', 4600], // the car repair has landed; the refund has not
    ['2026-05-11', 4600],
    ['2026-05-18', 5000], // refund landed
    ['2026-05-25', 5000],
  ]);
  // The 35-day span reaches Apr 27, but the ledger starts May 4 — see below.
  assert.equal(h[0].weekEnd, '2026-05-04');
});

test('historySeries: stops at the first transaction, never invents a flat past', () => {
  // The balance before the ledger's first row IS arithmetically derivable (no
  // flows to undo, so it is just today's balance walked back). It is still not
  // DRAWN: a flat line stretching left of the first transaction asserts the
  // account sat at that figure, when all we actually know is that we have no
  // rows for the period — which for this app usually means "not imported yet",
  // not "nothing happened". Same reasoning as windowAverages' activeMonths.
  const expense = [exp('2026-05-20', 100, 'Coffee run')];
  const h = historySeries({
    endBalance: 900, income: [], expense, spanDays: 90, today: '2026-06-01',
  });
  assert.deepStrictEqual(h.map((p) => [p.weekEnd, p.balance]), [['2026-05-25', 900]]);

  // No transactions at all ⇒ nothing to draw, and the chart is projection-only.
  assert.deepStrictEqual(
    historySeries({ endBalance: 900, income: [], expense: [], spanDays: 90, today: '2026-06-01' }), []
  );
});

test('forecast: history and projection meet at today, over a symmetric domain', () => {
  const income = ['01', '02', '03', '04', '05'].map((m) => inc(`2026-${m}-01`, 4000));
  const expense = ['01', '02', '03', '04', '05'].map((m) => exp(`2026-${m}-15`, 1500));
  const r = forecast({ startBalance: 1000, income, expense, planned: [], months: 3, today: '2026-06-01' });

  // Today is exactly the midpoint of the axis the renderer is handed: Jun 1 is
  // 92 days after Mar 1 and 92 days before Sep 1.
  assert.deepStrictEqual(r.domain, { start: '2026-03-01', end: '2026-09-01' });
  assert.equal(r.anchor.date, '2026-06-01');
  assert.ok(r.history.length > 0);
  // Every history point is in the past half, every series point in the future.
  assert.ok(r.history.every((p) => p.weekEnd >= r.domain.start && p.weekEnd < '2026-06-01'));
  assert.ok(r.series.every((s) => s.weekEnd >= '2026-06-01' && s.weekEnd <= r.domain.end));

  // The junction is continuous: the last history point plus that week's real
  // flows lands on the anchor, which is also where the projection starts.
  assert.equal(r.anchor.balance, 1000);
  // Rent on May 15 is the only flow in the final history week (May 25 → Jun 1)?
  // No — nothing falls there, so the last history point equals the anchor.
  assert.equal(r.history[r.history.length - 1].balance, 1000);
});

// ── an overdue-but-live charge lands imminently, not a cycle from now ────────

test('placeRecurring: a charge overdue within tolerance is caught up to today', () => {
  // Rent on the 15th, last seen May 15 — by Jun 18 the June charge is 3 days
  // late. recurringPatterns still considers the pattern live (3 <= the monthly
  // 5-day tolerance), so the money is owed now, not on Jul 15.
  const rent = ['01', '02', '03', '04', '05'].map((m) => exp(`2026-${m}-15`, 1500));
  const patterns = recurringPatterns(rent, '2026-06-18');
  assert.equal(patterns.length, 1);

  const skipped = placeRecurring(patterns, '2026-06-18', '2026-08-01');
  assert.deepStrictEqual(skipped.map((o) => o.date), ['2026-07-15']);

  const caught = placeRecurring(patterns, '2026-06-18', '2026-08-01', { catchUpOverdue: true });
  assert.deepStrictEqual(caught.map((o) => o.date), ['2026-06-18', '2026-07-15']);

  // A pattern that is not overdue at all is untouched by the option.
  const onTime = recurringPatterns(rent, '2026-06-10');
  assert.deepStrictEqual(
    placeRecurring(onTime, '2026-06-10', '2026-08-01', { catchUpOverdue: true }).map((o) => o.date),
    ['2026-06-15', '2026-07-15']
  );
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
  // A fresh DB has no ADOPTED accounts (the starter accounts are seeded hidden),
  // so there is nothing to offer or start from until the user imports.
  assert.equal(r.body.start_account, null);
  assert.equal(r.body.start_balance, 0);
  assert.deepStrictEqual(r.body.accounts, []);
  assert.equal(r.body.include_transfers, true); // transfers counted by default
  assert.deepStrictEqual(r.body.planned, []);
});

test('forecast API: adopted cash accounts become offerable', (t) => {
  const c = makeClient(t);
  c.adopt('checking');
  c.adopt('savings');
  const r = c.get('/api/forecast');
  // Ordered by Balance Sheet position, each with its latest balance (null until
  // any entry exists). Unadopted starters stay out of the picker entirely.
  assert.deepStrictEqual(r.body.accounts.map((a) => a.key), ['checking', 'savings']);
  assert.ok(r.body.accounts.every((a) => a.type === 'cash' && a.balance === null));
  assert.equal(r.body.start_account, 'checking'); // first cash-type by position
  assert.equal(r.body.start_balance, 0);
});

test('forecast API: transfer flows can be excluded from the projection', (t) => {
  const c = makeClient(t);
  // Three monthly transfers to savings in the trailing window (uncategorized
  // rows keep their explicit tx_type). The 15th of each of the last 3 complete
  // months keeps them inside the default 3-month average window.
  const today = localTodayIso();
  const month = (back) => addMonthKey(today.slice(0, 7), -back);
  for (const back of [1, 2, 3]) {
    c.post('/api/transactions', {
      date: `${month(back)}-15`, description: 'Transfer to savings',
      tx_type: 'transfer', amount: 500,
    });
  }

  // Included (default): the transfers register as outflows in the typical month.
  const inc = c.get('/api/forecast');
  assert.equal(inc.body.include_transfers, true);
  assert.ok(inc.body.summary.avgExpense > 0, JSON.stringify(inc.body.summary));

  // Excluded: nothing left to spend → a flat, higher line.
  const exc = c.get('/api/forecast?include_transfers=0');
  assert.equal(exc.body.include_transfers, false);
  assert.equal(exc.body.summary.avgExpense, 0);
  assert.ok(exc.body.summary.endBalance > inc.body.summary.endBalance);
});

test('forecast API: the projection follows the CHOSEN account, not the whole ledger', (t) => {
  const c = makeClient(t);
  const year = c.get('/api/balance/data').body.years[0];
  for (const k of ['checking', 'savings']) c.adopt(k);
  c.post('/api/balance/entry', { year, month: 'January', category: 'checking', value: 5000 });
  c.post('/api/balance/entry', { year, month: 'January', category: 'savings', value: 50000 });

  // Three months of heavy spending out of SAVINGS, and a trickle out of
  // CHECKING — so each account owns rows and neither can claim the fallback.
  const today = localTodayIso();
  const spend = (back, amount, account) => {
    const r = c.post('/api/transactions', {
      date: `${addMonthKey(today.slice(0, 7), -back)}-15`,
      description: `${account} spend ${back}`, tx_type: 'expense', amount,
    });
    c.put(`/api/transactions/${r.body.transaction.id}`, { account_key: account });
  };
  for (const back of [1, 2, 3]) {
    spend(back, 2000, 'savings');
    spend(back, 100, 'checking');
  }

  const sav = c.get('/api/forecast?account=savings');
  assert.equal(sav.body.scope, 'account');
  assert.equal(sav.body.summary.avgExpense, 2000);

  // Checking sees only its own 100/mo. It used to inherit the full 2100 —
  // being projected into the red off money spent from another account.
  const chk = c.get('/api/forecast?account=checking');
  assert.equal(chk.body.scope, 'account');
  assert.equal(chk.body.summary.avgExpense, 100);
  assert.equal(chk.body.summary.belowZero, false);
  assert.ok(chk.body.summary.endBalance > 4000, JSON.stringify(chk.body.summary));
});

test('forecast API: an unassigned ledger still drives every account', (t) => {
  const c = makeClient(t);
  const year = c.get('/api/balance/data').body.years[0];
  c.adopt('checking');
  c.post('/api/balance/entry', { year, month: 'January', category: 'checking', value: 5000 });

  // Pre-v10 shape: rows with no account_key at all. Scoping strictly here would
  // forecast a flat line for a user whose ledger is entirely this account.
  const today = localTodayIso();
  for (const back of [1, 2, 3]) {
    c.post('/api/transactions', {
      date: `${addMonthKey(today.slice(0, 7), -back)}-15`,
      description: `Unassigned spend ${back}`, tx_type: 'expense', amount: 900,
    });
  }
  const r = c.get('/api/forecast?account=checking');
  assert.equal(r.body.scope, 'ledger');
  assert.equal(r.body.summary.avgExpense, 900);
});

test('forecast API: the starting balance reports the month it came from', (t) => {
  const c = makeClient(t);
  const year = c.get('/api/balance/data').body.years[0];
  c.adopt('checking');
  c.post('/api/balance/entry', { year, month: 'March', category: 'checking', value: 1234 });

  const r = c.get('/api/forecast');
  assert.equal(r.body.start_balance, 1234);
  assert.equal(r.body.start_as_of, `${year}-03`);
  assert.equal(r.body.accounts.find((a) => a.key === 'checking').as_of, `${year}-03`);
  // The anchor is today at that balance, before any projected flow.
  assert.deepStrictEqual(r.body.anchor, { date: localTodayIso(), balance: 1234 });
  assert.equal(r.body.history_months, HISTORY_MONTHS);

  // No entries at all ⇒ nothing to date.
  const c2 = makeClient(t);
  c2.adopt('checking');
  assert.equal(c2.get('/api/forecast').body.start_as_of, null);
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
  // Adopt the starter accounts this test needs, then give both cash ones data.
  for (const k of ['checking', 'savings', 'investments']) c.adopt(k);
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
  // 'checking' (col_type=cash, position 0) once adopted; give it two months of data.
  const year = c.get('/api/balance/data').body.years[0];
  c.adopt('checking');
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
  c.adopt('checking');
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
