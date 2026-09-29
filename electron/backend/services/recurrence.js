'use strict';

// The recurrence rule a schedule repeats by, and the date arithmetic that turns
// one into actual dates. Pure functions over ISO strings; no DB access, no
// Electron, no clock of its own (today is always passed in).
//
// WHY A RULE RATHER THAN A CYCLE NAME. The page used to carry one of five fixed
// cadences — weekly, biweekly, monthly, quarterly, yearly — and step a date by
// that cadence's nominal gap. Real bills do not all fit five names: rent on the
// last business-ish day, a payroll on the 1st and 15th, a subscription that
// renews every 3 months on the second Tuesday. A rule says the same five things
// and those as well:
//
//   weekly    + interval 1  = weekly          monthly + date + interval 1  = monthly
//   weekly    + interval 2  = biweekly        monthly + date + interval 3  = quarterly
//                                             monthly + date + interval 12 = yearly
//
// so it is a strict superset and nothing that could be expressed before is lost.
//
// THE OTHER REASON: PHASE. Stepping a date by its cadence compounds its own
// clamping. A schedule due the 31st stepped into February becomes the 28th, and
// every step after that is taken FROM the 28th, so it never returns to the 31st
// — one short month permanently moves a bill. Here an occurrence is computed
// from the rule and the anchor's phase rather than from the previous
// occurrence, so the 31st gives Jan 31, Feb 28, Mar 31. The clamp applies to the
// month it happens in and to no other.
//
// THE ANCHOR is a date the schedule is known to occur on: the last recorded
// charge of a detected series, or the date the user entered for a hand-made
// one. It fixes the phase — which week of the fortnight, which month of the
// quarter — and generation INCLUDES it. Callers that are drawing projections
// over recorded history filter out anything at or before it (see
// handlers/recurring.js), because those days already have real charges on them.

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FREQ_NAMES = ['weekly', 'monthly'];
const MONTH_MODES = ['date', 'day'];
// 1st through 4th, plus last. There is deliberately no 5th: a month has a fifth
// Tuesday only sometimes, so a schedule set to one would silently skip months,
// which is what "last" is for.
const WEEK_POSITIONS = [1, 2, 3, 4, -1];
// A year of weeks, or a decade of months. Past this an "every N" is a typo
// rather than a cadence, and the generators below stay bounded.
const MAX_INTERVAL = 120;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 0 = Sunday, matching Date#getDay and the calendar's own column order. */
function weekdayOf(iso) {
  return new Date(toUTC(iso)).getUTCDay();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year, month, day) {
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}`;
}

/** Months since the epoch year 0, so two months can be compared and stepped as
 *  one number rather than as a (year, month) pair. */
function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function fromMonthIndex(idx) {
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

// ─── The rule ────────────────────────────────────────────────────────────────

/**
 * Validate and fill in a rule from whatever a request or a database row holds,
 * returning null when the input does not describe one at all (no freq, which is
 * how a detected schedule with no cadence override reads). Throws via `fail` on
 * a rule that is present but wrong, so a bad edit is a 400 rather than a
 * schedule that silently repeats on the wrong day.
 *
 * `anchorIso` supplies the parts the caller left out: a weekly rule with no
 * weekday repeats on the anchor's weekday, a monthly one with no day repeats on
 * the anchor's day of the month. That is what makes "just change it to every 2
 * weeks" a one-field edit.
 */
function normaliseRule(raw, anchorIso, fail) {
  const bad = fail || ((msg) => { throw new Error(msg); });
  if (!raw || raw.freq == null) return null;

  if (!FREQ_NAMES.includes(raw.freq)) bad('invalid freq');
  const interval = raw.interval == null ? 1 : Number(raw.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) bad('invalid interval');

  const until = raw.until == null || raw.until === '' ? null : String(raw.until);
  if (until !== null && !ISO_RE.test(until)) bad('invalid until');

  const anchor = ISO_RE.test(String(anchorIso || '')) ? anchorIso : null;

  if (raw.freq === 'weekly') {
    const weekday = raw.weekday == null
      ? (anchor ? weekdayOf(anchor) : bad('weekly rule needs a weekday'))
      : Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) bad('invalid weekday');
    return { freq: 'weekly', interval, weekday, month_mode: null, day: null, pos: null, until };
  }

  const mode = raw.month_mode == null ? 'date' : raw.month_mode;
  if (!MONTH_MODES.includes(mode)) bad('invalid month_mode');

  if (mode === 'date') {
    const day = raw.day == null
      ? (anchor ? Number(anchor.slice(8, 10)) : bad('monthly rule needs a day'))
      : Number(raw.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) bad('invalid day');
    return { freq: 'monthly', interval, weekday: null, month_mode: 'date', day, pos: null, until };
  }

  const pos = raw.pos == null ? 1 : Number(raw.pos);
  if (!WEEK_POSITIONS.includes(pos)) bad('invalid pos');
  const weekday = raw.weekday == null
    ? (anchor ? weekdayOf(anchor) : bad('monthly rule needs a weekday'))
    : Number(raw.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) bad('invalid weekday');
  return { freq: 'monthly', interval, weekday, month_mode: 'day', day: null, pos, until };
}

/**
 * The rule equivalent of one of detection's five cadence names, anchored on a
 * date the series actually occurred. This is what a DETECTED schedule repeats
 * by until the user edits it, and it is also how a pre-rule database row is
 * read: the two produce the same dates the old stepper did, because the day of
 * the month and the weekday both come off the same anchor it stepped from.
 */
function ruleFromCycle(cycle, anchorIso, until = null) {
  const weekly = { weekly: 1, biweekly: 2 }[cycle];
  if (weekly) {
    return {
      freq: 'weekly', interval: weekly, weekday: weekdayOf(anchorIso),
      month_mode: null, day: null, pos: null, until,
    };
  }
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[cycle];
  if (!months) return null;
  return {
    freq: 'monthly', interval: months, weekday: null,
    month_mode: 'date', day: Number(anchorIso.slice(8, 10)), pos: null, until,
  };
}

// ─── Generating dates ────────────────────────────────────────────────────────

/** The date a weekly rule lands on in the period `k` periods after the anchor's
 *  own. The anchor's period starts on the rule's weekday at or before it, so a
 *  rule whose weekday differs from the anchor's does not shift the phase by a
 *  whole period. */
function weeklyOccurrence(rule, anchorIso, k) {
  const back = (weekdayOf(anchorIso) - rule.weekday + 7) % 7;
  return fromUTC(toUTC(anchorIso) + (k * rule.interval * 7 - back) * DAY_MS);
}

/** The date a monthly rule lands on in `idx` (a month index), or null when that
 *  month has no such date. Only `pos` 1-4 and last are allowed, and all five
 *  exist in every month, so this is null only for a caller's bad month. */
function monthlyOccurrence(rule, idx) {
  const { year, month } = fromMonthIndex(idx);
  const last = daysInMonth(year, month);
  if (rule.month_mode === 'date') return iso(year, month, Math.min(rule.day, last));

  if (rule.pos === -1) {
    const lastWeekday = weekdayOf(iso(year, month, last));
    return iso(year, month, last - ((lastWeekday - rule.weekday + 7) % 7));
  }
  const firstWeekday = weekdayOf(iso(year, month, 1));
  return iso(year, month, 1 + ((rule.weekday - firstWeekday + 7) % 7) + (rule.pos - 1) * 7);
}

/** Occurrence number `k` counted from the anchor's own period (k = 0 is the
 *  anchor's period, which is at or before the anchor itself). */
function occurrenceAt(rule, anchorIso, k) {
  if (rule.freq === 'weekly') return weeklyOccurrence(rule, anchorIso, k);
  const [y, m] = anchorIso.split('-').map(Number);
  return monthlyOccurrence(rule, monthIndex(y, m) + k * rule.interval);
}

/** How many periods separate the anchor's period from `iso`'s, rounded down.
 *  An estimate: occurrenceAt is walked from here rather than trusted, since the
 *  clamped day of a short month can put a date a period either side. */
function periodEstimate(rule, anchorIso, targetIso) {
  if (rule.freq === 'weekly') {
    return Math.floor((toUTC(targetIso) - toUTC(anchorIso)) / DAY_MS / (7 * rule.interval)) - 1;
  }
  const [ay, am] = anchorIso.split('-').map(Number);
  const [ty, tm] = targetIso.split('-').map(Number);
  return Math.floor((monthIndex(ty, tm) - monthIndex(ay, am)) / rule.interval) - 1;
}

/**
 * The schedule's first occurrence on or after `fromIso`, or null once the rule
 * has ended (`until` passed). Never returns a date before the anchor: a
 * schedule does not project backwards past the date it is anchored on.
 */
function nextOccurrence(rule, anchorIso, fromIso) {
  const start = fromIso < anchorIso ? anchorIso : fromIso;
  let k = Math.max(0, periodEstimate(rule, anchorIso, start));
  let date = occurrenceAt(rule, anchorIso, k);
  let guard = 0;
  while (date < start && guard++ < 1000) date = occurrenceAt(rule, anchorIso, ++k);
  if (date < start) return null;
  if (rule.until && date > rule.until) return null;
  return date;
}

/**
 * Every occurrence in [fromIso, toIso), soonest first. Bounded by `limit` as
 * well as by the window, so a caller that asks for a decade of a weekly
 * schedule gets a long list rather than an unbounded one.
 */
function occurrencesBetween(rule, anchorIso, fromIso, toIso, { limit = 500 } = {}) {
  const out = [];
  if (!rule || !anchorIso || toIso <= fromIso) return out;
  const start = fromIso < anchorIso ? anchorIso : fromIso;
  let k = Math.max(0, periodEstimate(rule, anchorIso, start));
  let date = occurrenceAt(rule, anchorIso, k);
  let guard = 0;
  while (date < start && guard++ < 1000) date = occurrenceAt(rule, anchorIso, ++k);
  while (date < toIso && out.length < limit) {
    if (rule.until && date > rule.until) break;
    out.push(date);
    date = occurrenceAt(rule, anchorIso, ++k);
  }
  return out;
}

/** True once the rule's end date has passed, so nothing more will ever be due.
 *  The schedule stays on the page, greyed: a row that vanished on its end date
 *  would read as data the app lost. */
function hasEnded(rule, anchorIso, todayIso) {
  if (!rule || !rule.until) return false;
  return nextOccurrence(rule, anchorIso, todayIso) === null;
}

module.exports = {
  normaliseRule,
  ruleFromCycle,
  nextOccurrence,
  occurrencesBetween,
  hasEnded,
  weekdayOf,
  FREQ_NAMES,
  MONTH_MODES,
  WEEK_POSITIONS,
  WEEKDAY_NAMES,
  MAX_INTERVAL,
};
