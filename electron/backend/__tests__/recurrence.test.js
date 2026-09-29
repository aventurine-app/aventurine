'use strict';

// services/recurrence.js — the rule a schedule repeats by, and the dates it
// produces. Pure date arithmetic, so everything here is pinned to fixed ISO
// strings rather than to "now".
//
// The cases that matter are the ones a plain stepper got wrong: a short month
// clamping a day permanently, an nth weekday that moves every month, and an end
// date that has to stop generation without deleting the schedule.

const test = require('node:test');
const assert = require('node:assert');

const {
  normaliseRule, ruleFromCycle, nextOccurrence, occurrencesBetween, hasEnded,
} = require('../services/recurrence');

const monthly = (over = {}) => normaliseRule({ freq: 'monthly', ...over }, '2026-01-15');
const weekly = (over = {}) => normaliseRule({ freq: 'weekly', ...over }, '2026-01-15');

// ── Monthly by date ──────────────────────────────────────────────────────────

test('monthly by date: a clamped short month does not move the schedule', () => {
  const rule = monthly({ month_mode: 'date', day: 31 });
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-31', '2026-01-01', '2026-06-01'),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']
  );
});

test('monthly by date: every 3 months keeps the anchor month phase', () => {
  const rule = monthly({ month_mode: 'date', day: 5, interval: 3 });
  assert.deepEqual(
    occurrencesBetween(rule, '2026-02-05', '2026-01-01', '2027-01-01'),
    ['2026-02-05', '2026-05-05', '2026-08-05', '2026-11-05']
  );
});

test('monthly by date: a window before the anchor yields nothing', () => {
  const rule = monthly({ month_mode: 'date', day: 5 });
  assert.deepEqual(occurrencesBetween(rule, '2026-06-05', '2026-01-01', '2026-06-01'), []);
});

// ── Monthly by day ───────────────────────────────────────────────────────────

test('monthly by day: the third Friday of each month', () => {
  const rule = monthly({ month_mode: 'day', pos: 3, weekday: 5 });
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-01', '2026-01-01', '2026-05-01'),
    ['2026-01-16', '2026-02-20', '2026-03-20', '2026-04-17']
  );
});

test('monthly by day: the last Monday of each month', () => {
  const rule = monthly({ month_mode: 'day', pos: -1, weekday: 1 });
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-01', '2026-01-01', '2026-05-01'),
    ['2026-01-26', '2026-02-23', '2026-03-30', '2026-04-27']
  );
});

test('monthly by day: the first of a weekday is always in the first seven days', () => {
  const rule = monthly({ month_mode: 'day', pos: 1, weekday: 0 });
  for (const d of occurrencesBetween(rule, '2026-01-01', '2026-01-01', '2027-01-01')) {
    assert.ok(Number(d.slice(8, 10)) <= 7, `${d} is not in the first week`);
  }
});

// ── Weekly ───────────────────────────────────────────────────────────────────

test('weekly: every 2 weeks holds the fortnight the anchor is in', () => {
  const rule = weekly({ interval: 2, weekday: 4 }); // Thursday
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-15', '2026-01-01', '2026-03-01'),
    ['2026-01-15', '2026-01-29', '2026-02-12', '2026-02-26']
  );
});

test('weekly: an unspecified weekday comes from the anchor', () => {
  const rule = weekly({});
  assert.equal(rule.weekday, 4, '2026-01-15 is a Thursday');
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-15', '2026-01-15', '2026-02-06'),
    ['2026-01-15', '2026-01-22', '2026-01-29', '2026-02-05']
  );
});

// ── Next due ─────────────────────────────────────────────────────────────────

test('next due: the first occurrence on or after today, today included', () => {
  const rule = monthly({ month_mode: 'date', day: 10 });
  assert.equal(nextOccurrence(rule, '2026-01-10', '2026-03-10'), '2026-03-10');
  assert.equal(nextOccurrence(rule, '2026-01-10', '2026-03-11'), '2026-04-10');
});

test('next due: a schedule lapsed by months still walks forward to today', () => {
  const rule = monthly({ month_mode: 'date', day: 10 });
  assert.equal(nextOccurrence(rule, '2020-01-10', '2026-09-29'), '2026-10-10');
});

test('next due: never earlier than the anchor', () => {
  const rule = monthly({ month_mode: 'date', day: 10 });
  assert.equal(nextOccurrence(rule, '2026-06-10', '2026-01-01'), '2026-06-10');
});

// ── End date ─────────────────────────────────────────────────────────────────

test('until: generation stops at the end date, inclusive', () => {
  const rule = monthly({ month_mode: 'date', day: 1, until: '2026-04-01' });
  assert.deepEqual(
    occurrencesBetween(rule, '2026-01-01', '2026-01-01', '2027-01-01'),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']
  );
});

test('until: a passed end date leaves no next due, and reads as ended', () => {
  const rule = monthly({ month_mode: 'date', day: 1, until: '2026-04-01' });
  assert.equal(nextOccurrence(rule, '2026-01-01', '2026-05-01'), null);
  assert.equal(hasEnded(rule, '2026-01-01', '2026-05-01'), true);
  assert.equal(hasEnded(rule, '2026-01-01', '2026-03-15'), false);
});

test('until: a perpetual rule never ends', () => {
  assert.equal(hasEnded(monthly({ month_mode: 'date', day: 1 }), '2026-01-01', '2099-01-01'), false);
});

// ── The five old cadences ────────────────────────────────────────────────────

test('ruleFromCycle: every old cadence maps onto a rule that produces its dates', () => {
  const cases = [
    ['weekly', '2026-01-15', ['2026-01-15', '2026-01-22', '2026-01-29']],
    ['biweekly', '2026-01-15', ['2026-01-15', '2026-01-29', '2026-02-12']],
    ['monthly', '2026-01-15', ['2026-01-15', '2026-02-15', '2026-03-15']],
    ['quarterly', '2026-01-15', ['2026-01-15', '2026-04-15', '2026-07-15']],
    ['yearly', '2026-01-15', ['2026-01-15', '2027-01-15', '2028-01-15']],
  ];
  for (const [cycle, anchor, expected] of cases) {
    const rule = ruleFromCycle(cycle, anchor);
    const got = occurrencesBetween(rule, anchor, anchor, '2029-01-01', { limit: 3 });
    assert.deepEqual(got, expected, cycle);
  }
});

test('ruleFromCycle: an unknown cadence has no rule', () => {
  assert.equal(ruleFromCycle('fortnightly', '2026-01-15'), null);
});

// ── Validation ───────────────────────────────────────────────────────────────

test('normaliseRule: no freq is not a rule, it is the absence of one', () => {
  assert.equal(normaliseRule(null, '2026-01-15'), null);
  assert.equal(normaliseRule({}, '2026-01-15'), null);
});

test('normaliseRule: rejects what would repeat on a day that does not exist', () => {
  const bad = (raw) => assert.throws(() => normaliseRule(raw, '2026-01-15'));
  bad({ freq: 'daily' });
  bad({ freq: 'monthly', interval: 0 });
  bad({ freq: 'monthly', interval: 1.5 });
  bad({ freq: 'monthly', interval: 1000 });
  bad({ freq: 'monthly', month_mode: 'date', day: 32 });
  bad({ freq: 'monthly', month_mode: 'day', pos: 5, weekday: 1 });
  bad({ freq: 'monthly', month_mode: 'weekish' });
  bad({ freq: 'weekly', weekday: 7 });
  bad({ freq: 'monthly', until: 'someday' });
});

test('normaliseRule: fills the parts the caller left out from the anchor', () => {
  assert.deepEqual(normaliseRule({ freq: 'monthly' }, '2026-03-09'), {
    freq: 'monthly', interval: 1, weekday: null, month_mode: 'date', day: 9, pos: null, until: null,
  });
  assert.deepEqual(normaliseRule({ freq: 'monthly', month_mode: 'day' }, '2026-03-09'), {
    freq: 'monthly', interval: 1, weekday: 1, month_mode: 'day', day: null, pos: 1, until: null,
  });
});
