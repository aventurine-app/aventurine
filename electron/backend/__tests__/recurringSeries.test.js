'use strict';

// detectRecurringSeries (services/predictions.js) — the Recurring report's full
// listing detector. This is NOT an oracle-pinned function (detectRecurringExpenses
// is, and stays untouched); it shares the same grouping/cycle/regularity rules but
// returns every qualifying series with its full occurrence history instead of a
// top-N "due soon" slice, so it's pinned by ordinary deterministic unit tests here
// (same precedent as services/forecast.js's recurringPatterns/placeRecurring in
// forecast.test.js) with a fixed `today` removing the only time dependency.

const test = require('node:test');
const assert = require('node:assert');

const { detectRecurringSeries } = require('../services/predictions');

const tx = (date, amount, description = 'Netflix', display_name = null) => ({
  date, amount, description, display_name,
});

test('detectRecurringSeries: monthly series carries its full occurrence history', () => {
  const rows = [
    tx('2026-04-14', 15.49, 'NETFLIX.COM', 'Netflix'),
    tx('2026-05-14', 15.49, 'NETFLIX.COM', 'Netflix'),
    tx('2026-06-14', 15.49, 'NETFLIX.COM', 'Netflix'),
    tx('2026-07-14', 15.49, 'NETFLIX.COM', 'Netflix'),
  ];
  const [s] = detectRecurringSeries(rows, { today: '2026-07-20' });
  assert.ok(s, 'series detected');
  assert.equal(s.cycle, 'monthly');
  assert.equal(s.occurrences, 4);
  assert.equal(s.display_name, 'Netflix');
  assert.equal(s.last_date, '2026-07-14');
  assert.equal(s.next_date, '2026-08-14');
  assert.deepStrictEqual(
    s.dates,
    [
      { date: '2026-04-14', amount: 15.49 },
      { date: '2026-05-14', amount: 15.49 },
      { date: '2026-06-14', amount: 15.49 },
      { date: '2026-07-14', amount: 15.49 },
    ]
  );
});

test('detectRecurringSeries: same-day split charges merge into one occurrence amount', () => {
  const rows = [
    tx('2026-05-01', 400, 'RENT'), tx('2026-05-01', 100, 'RENT'), // 500 that month
    tx('2026-06-01', 500, 'RENT'),
    tx('2026-07-01', 500, 'RENT'),
  ];
  const [s] = detectRecurringSeries(rows, { today: '2026-07-05' });
  assert.equal(s.occurrences, 3);
  assert.equal(s.dates[0].amount, 500);
});

test('detectRecurringSeries: works on income rows the same way (direction-agnostic)', () => {
  const rows = [
    tx('2026-04-30', 3000, 'ACME PAYROLL', 'Acme Corp'),
    tx('2026-05-29', 3000, 'ACME PAYROLL', 'Acme Corp'),
    tx('2026-06-30', 3000, 'ACME PAYROLL', 'Acme Corp'),
  ];
  const [s] = detectRecurringSeries(rows, { today: '2026-07-05' });
  assert.ok(s, 'income series detected');
  assert.equal(s.cycle, 'monthly');
});

test('detectRecurringSeries: fewer than 3 occurrences never qualifies', () => {
  const rows = [tx('2026-05-14'), tx('2026-06-14')];
  assert.deepStrictEqual(detectRecurringSeries(rows, { today: '2026-07-01' }), []);
});

test('detectRecurringSeries: irregular gaps are rejected', () => {
  const rows = [
    tx('2026-01-05'), tx('2026-02-20'), tx('2026-03-02'), tx('2026-06-28'),
  ];
  assert.deepStrictEqual(detectRecurringSeries(rows, { today: '2026-07-01' }), []);
});

test('detectRecurringSeries: a lapsed series (overdue beyond tolerance) is dropped entirely', () => {
  const rows = [
    tx('2025-10-14'), tx('2025-11-14'), tx('2025-12-14'), tx('2026-01-14'),
  ];
  // Next charge would've been ~2026-02-14; "today" is far past it + tolerance.
  assert.deepStrictEqual(detectRecurringSeries(rows, { today: '2026-07-20' }), []);
});

test('detectRecurringSeries: multiple merchants sort soonest-due first', () => {
  const rows = [
    tx('2026-05-01', 9, 'A'), tx('2026-06-01', 9, 'A'), tx('2026-07-01', 9, 'A'), // next: 2026-08-01
    tx('2026-05-18', 9, 'B'), tx('2026-06-18', 9, 'B'), tx('2026-07-18', 9, 'B'), // next: 2026-08-18
  ];
  const series = detectRecurringSeries(rows, { today: '2026-07-20' });
  assert.deepStrictEqual(series.map((s) => s.description), ['A', 'B']);
});
