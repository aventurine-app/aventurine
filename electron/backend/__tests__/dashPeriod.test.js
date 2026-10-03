'use strict';

// Card periods (static/js/widgets/dashperiod.js): what a card's period spec
// covers and what its header calls it. Pinned against a fixed "now" — mid
// October 2026 — so the months each preset resolves to are spelled out.

const test = require('node:test');
const assert = require('node:assert');

const DashPeriod = require('../../../static/js/widgets/dashperiod.js');

const NOW = new Date(2026, 9, 2, 14, 30); // 2 Oct 2026, local time
const resolve = (spec) => DashPeriod.resolve(spec, NOW);
const ym = (slots) => slots.map(DashPeriod.formatMonth);

test('period: a month follows the calendar unless it is pinned', () => {
  const current = resolve({ preset: 'month', month: null, compare: null });
  assert.deepStrictEqual(ym(current.slots), ['2026-10']);
  assert.equal(current.isCurrentMonth, true);
  assert.equal(current.short, 'Oct 2026');
  assert.equal(current.label, 'October 2026');

  const pinned = resolve({ preset: 'month', month: '2026-08', compare: null });
  assert.deepStrictEqual(ym(pinned.slots), ['2026-08']);
  assert.equal(pinned.isCurrentMonth, false);
});

test('period: a pin in the future, or malformed, falls back to the current month', () => {
  assert.deepStrictEqual(ym(resolve({ preset: 'month', month: '2027-01' }).slots), ['2026-10']);
  assert.deepStrictEqual(ym(resolve({ preset: 'month', month: 'soon' }).slots), ['2026-10']);
  assert.deepStrictEqual(ym(resolve({ preset: 'decade' }).slots), ['2026-10']);
});

test('period: ranges end with the current, partial month', () => {
  assert.deepStrictEqual(ym(resolve({ preset: 'm3' }).slots), ['2026-08', '2026-09', '2026-10']);
  assert.equal(resolve({ preset: 'ytd' }).slots.length, 10);
  assert.deepStrictEqual(ym([resolve({ preset: 'ytd' }).first]), ['2026-01']);
  const y1 = resolve({ preset: 'y1' });
  assert.equal(y1.slots.length, 12);
  assert.deepStrictEqual(ym([y1.first, y1.last]), ['2025-11', '2026-10']);
  assert.equal(resolve({ preset: 'y5' }).slots.length, 60);
});

test('period: labels name the span, with the year once when it does not change', () => {
  assert.equal(resolve({ preset: 'ytd' }).short, 'Jan – Oct 2026');
  assert.equal(resolve({ preset: 'ytd' }).label, 'January – October 2026');
  assert.equal(resolve({ preset: 'y1' }).short, 'Nov ’25 – Oct ’26');
  assert.equal(resolve({ preset: 'y1' }).label, 'November 2025 – October 2026');
});

test('period: days ahead start today and count it', () => {
  const d30 = resolve({ preset: 'd30' });
  assert.equal(d30.kind, 'ahead');
  assert.equal(d30.days, 30);
  assert.equal(d30.start.getDate(), 2);
  assert.equal(d30.end.getMonth(), 9);
  assert.equal(d30.end.getDate(), 31);
  assert.equal(d30.short, 'Next 30 days');
  const f3 = resolve({ preset: 'f3' });
  assert.equal(f3.months, 3);
  assert.deepStrictEqual([f3.end.getMonth(), f3.end.getDate()], [0, 1]); // Jan 1 2027
});

test('period: clean keeps only what the card can show', () => {
  const allowed = ['month', 'm3', 'ytd', 'y1'];
  const fallback = { preset: 'month', month: null };
  assert.deepStrictEqual(DashPeriod.clean({ preset: 'y3' }, allowed, fallback), fallback);
  assert.deepStrictEqual(DashPeriod.clean({ preset: 'm3', month: '2026-01' }, allowed, fallback), { preset: 'm3', month: null });
  assert.deepStrictEqual(DashPeriod.clean({ preset: 'month', month: '2026-01', compare: 'prev' }, allowed, fallback),
    { preset: 'month', month: '2026-01' }, 'a comparison stored by an older build is dropped');
  assert.deepStrictEqual(DashPeriod.clean(null, allowed, fallback), fallback);
});
