'use strict';

// Recurring (Reports) blueprint. Surfaces detectRecurringSeries
// (services/predictions.js) as a full listing rather than the top-N "due
// soon" slice /api/predictions/upcoming returns, plus a per-month calendar of
// occurrences (actual past charges + projected future ones) for the
// requested month. Income, expense, AND transfer patterns are all detected
// here (unlike Cash Flow/Forecast, which exclude transfers) — a recurring
// autosave/auto-invest transfer is exactly the kind of thing this page exists
// to surface. Every schedule's label/direction/cadence/amount is a
// correctable prediction (recurring_overrides), and a schedule can also be
// added by hand or removed — see the handler doc comments below.

const { bad, cleanLabel, isFiniteNumber, round2, parseIsoDate } = require('../validate');
const { serialiseTx } = require('../services/transactions');
const {
  detectRecurringSeries, normaliseDesc, localTodayIso, addMonths, addDays, daysBetween, CYCLE_MONTHS, CYCLE_DAYS,
} = require('../services/predictions');
const { addMonthKey, placeRecurring } = require('../services/forecast');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CYCLE_NAMES = Object.keys(CYCLE_DAYS);
const DIRECTION_NAMES = ['income', 'expense', 'transfer'];

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** iso + one cycle step (mirror of forecast.js's stepDate, kept local since
 *  this file needs it both forwards, here, and backwards in reverseStepCycle
 *  below). */
function stepCycle(iso, cycle) {
  return cycle in CYCLE_MONTHS ? addMonths(iso, CYCLE_MONTHS[cycle]) : addDays(iso, CYCLE_DAYS[cycle]);
}

/** iso - one cycle step — turns a user-entered "next due" date into the
 *  last_date anchor a schedule is stored/projected from. */
function reverseStepCycle(iso, cycle) {
  return cycle in CYCLE_MONTHS ? addMonths(iso, -CYCLE_MONTHS[cycle]) : addDays(iso, -CYCLE_DAYS[cycle]);
}

/**
 * Layer a user override (recurring_overrides row, or undefined) on top of a
 * detected series. Only display_name/direction/cycle/amount are ever
 * overridden — the real transaction history (dates, occurrence count, past
 * actual amounts) always stays what was actually detected. A cadence
 * override recomputes next_date/due_in_days from the series' real last_date,
 * so the calendar's future projection follows the new cycle immediately;
 * PAST occurrences (services/predictions.js's `dates`) are untouched, so
 * history never silently rewrites itself.
 */
function withOverride(s, ov, todayIso) {
  if (!ov) return s;
  const cycle = ov.cycle ?? s.cycle;
  const cycle_days = ov.cycle ? CYCLE_DAYS[cycle] : s.cycle_days;
  const next_date = ov.cycle ? stepCycle(s.last_date, cycle) : s.next_date;
  return {
    ...s,
    display_name: ov.display_name ?? s.display_name,
    direction: ov.direction ?? s.direction,
    cycle,
    cycle_days,
    amount: ov.amount ?? s.amount,
    next_date,
    due_in_days: daysBetween(todayIso, next_date),
  };
}

/**
 * Synthesize a series-shaped object for a schedule that has NO backing
 * transactions at all (a manual add) — null if the override row is missing
 * any of the fields such a schedule needs (display_name/direction/cycle/
 * amount/last_date), which is only reachable by calling POST
 * /api/recurring/override directly rather than through the normal
 * POST /api/recurring/schedule create flow.
 *
 * Unlike withOverride's single-step cadence recompute (safe there because a
 * DETECTED series' last_date is always recent — LAPSED_GRACE_DAYS caps it at
 * 90 days), a manual schedule's last_date never advances on its own (nothing
 * ever posts against it), so it can go stale indefinitely. next_date is
 * therefore walked forward via the same catch-up loop placeRecurring uses,
 * so a schedule added once keeps reading as "next Aug 15", "next Sep 15", …
 * forever, not frozen at whatever was first entered.
 */
function manualSeries(ov, todayIso) {
  if (!ov.display_name || !ov.direction || !ov.cycle || ov.amount == null || !ov.last_date) return null;
  let next_date = stepCycle(ov.last_date, ov.cycle);
  let guard = 0;
  while (next_date < todayIso && guard++ < 1000) next_date = stepCycle(next_date, ov.cycle);
  return {
    key: ov.key,
    description: ov.display_name,
    display_name: ov.display_name,
    direction: ov.direction,
    amount: ov.amount,
    cycle: ov.cycle,
    cycle_days: CYCLE_DAYS[ov.cycle],
    dates: [], // no real occurrences ever posted
    occurrences: 0,
    confidence: 1, // user-declared, not statistically inferred
    last_date: ov.last_date,
    next_date,
    due_in_days: daysBetween(todayIso, next_date),
  };
}

function recurringGet(ctx, { query }) {
  const db = ctx.db();

  const month = query.month || currentMonthKey();
  if (!MONTH_RE.test(month)) bad('invalid month (expected YYYY-MM)');

  const catTypeById = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY date')
    .all()
    .map((t) => serialiseTx(t, catTypeById));

  const income = rows.filter((t) => t.tx_type === 'income');
  const expense = rows.filter((t) => t.tx_type === 'expense');
  const transfer = rows.filter((t) => t.tx_type === 'transfer');

  const todayIso = localTodayIso();
  const overrides = new Map(
    db.prepare('SELECT * FROM recurring_overrides').all().map((o) => [o.key, o])
  );

  const detected = [
    ...detectRecurringSeries(income, { today: todayIso }).map((s) => withOverride({ ...s, direction: 'income' }, overrides.get(s.key), todayIso)),
    ...detectRecurringSeries(expense, { today: todayIso }).map((s) => withOverride({ ...s, direction: 'expense' }, overrides.get(s.key), todayIso)),
    ...detectRecurringSeries(transfer, { today: todayIso }).map((s) => withOverride({ ...s, direction: 'transfer' }, overrides.get(s.key), todayIso)),
  ].filter((s) => !overrides.get(s.key)?.removed);

  // Any override key that ISN'T a currently-detected series is either a
  // manual schedule (synthesize it) or a removed one (already filtered out
  // above by the .removed check, since detected.some below can't match it).
  const detectedKeys = new Set(detected.map((s) => s.key));
  const manual = [];
  for (const ov of overrides.values()) {
    if (detectedKeys.has(ov.key) || ov.removed) continue;
    const m = manualSeries(ov, todayIso);
    if (m) manual.push(m);
  }

  const series = [...detected, ...manual]
    .sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : b.confidence - a.confidence));

  const monthStart = `${month}-01`;
  const monthEndExclusive = `${addMonthKey(month, 1)}-01`;

  const occurrences = [];
  for (const s of series) {
    for (const d of s.dates) {
      if (d.date >= monthStart && d.date < monthEndExclusive) {
        occurrences.push({
          date: d.date, key: s.key, direction: s.direction, amount: d.amount, actual: true,
        });
      }
    }
    // Project forward from today through this month's end; placeRecurring's
    // catch-up loop already no-ops when monthEndExclusive is in the past, so
    // this needs no branching for past/current/future months.
    const projected = placeRecurring(
      [{ key: s.key, name: s.cycle, days: s.cycle_days, amount: s.amount, last: s.last_date }],
      todayIso,
      monthEndExclusive
    );
    for (const o of projected) {
      if (o.date >= monthStart) {
        occurrences.push({
          date: o.date, key: s.key, direction: s.direction, amount: o.amount, actual: false,
        });
      }
    }
  }
  occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    month,
    series: series.map((s) => ({
      key: s.key,
      description: s.description,
      display_name: s.display_name,
      direction: s.direction,
      amount: s.amount,
      cycle: s.cycle,
      occurrences: s.occurrences,
      confidence: s.confidence,
      last_date: s.last_date,
      next_date: s.next_date,
    })),
    occurrences,
  };
}

/**
 * Upsert a user override for one recurring schedule (POST body: {key,
 * display_name?, direction?, cycle?, amount?} — any subset, each null clears
 * that field back to auto-detected). Recurring rows have no surrogate id (a
 * detected series is recomputed fresh from transactions on every read — see
 * detectRecurringSeries), so the client's own grouping key IS the identity,
 * same as Cash Flow's /api/entry keys on a category string rather than a row
 * id. Editing a manual schedule's date isn't supported here — only
 * POST /api/recurring/schedule (create) sets last_date; delete + re-add to
 * change one.
 */
function recurringOverrideUpsert(ctx, { body }) {
  const db = ctx.db();
  if (!body || typeof body.key !== 'string' || !body.key.trim()) bad('key required');
  const key = body.key.trim();

  const hasField = (f) => Object.prototype.hasOwnProperty.call(body, f);
  const patch = {};

  if (hasField('display_name')) {
    if (body.display_name === null) {
      patch.display_name = null;
    } else {
      const name = cleanLabel(body.display_name);
      if (!name) bad('invalid display_name');
      patch.display_name = name;
    }
  }
  if (hasField('direction')) {
    if (body.direction !== null && !DIRECTION_NAMES.includes(body.direction)) bad('invalid direction');
    patch.direction = body.direction;
  }
  if (hasField('cycle')) {
    if (body.cycle !== null && !CYCLE_NAMES.includes(body.cycle)) bad('invalid cycle');
    patch.cycle = body.cycle;
  }
  if (hasField('amount')) {
    if (body.amount === null) {
      patch.amount = null;
    } else {
      if (!isFiniteNumber(body.amount) || body.amount <= 0) bad('invalid amount');
      patch.amount = round2(body.amount);
    }
  }
  if (!Object.keys(patch).length) bad('no fields to update');
  // Any real edit means the schedule should be visible — undoes a prior
  // "remove" if the user is re-adding under the same key. Harmless
  // otherwise: a removed row never renders, so its inputs can't be the
  // source of a stray edit that reaches here.
  patch.removed = 0;

  db.prepare('INSERT INTO recurring_overrides ("key") VALUES (?) ON CONFLICT("key") DO NOTHING').run(key);
  const sets = Object.keys(patch).map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE recurring_overrides SET ${sets} WHERE "key" = ?`).run(...Object.values(patch), key);

  const row = db.prepare('SELECT * FROM recurring_overrides WHERE "key" = ?').get(key);
  return { ok: true, override: row };
}

/**
 * Create (or fully replace) a MANUAL recurring schedule — one with no
 * backing transactions ("I know I'll be charged $12/mo starting next
 * month"). Every field is required, unlike the partial-patch upsert above.
 * The key is derived from display_name via normaliseDesc — the SAME
 * grouping key real transactions for that merchant would produce — so if
 * matching transactions ever show up, detection naturally takes over and
 * this row keeps applying as a plain override on top of it (withOverride).
 * `next_date` is the more intuitive thing for a user to enter ("when's this
 * next due"), but a schedule is stored/projected the same way a detected
 * series is (last_date + cycle), so it's reverse-stepped once here.
 */
function recurringScheduleCreate(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');

  const name = cleanLabel(body.display_name);
  if (!name) bad('name required');
  const key = normaliseDesc(name);
  if (!key) bad('name must contain letters');

  if (!DIRECTION_NAMES.includes(body.direction)) bad('invalid direction');
  if (!CYCLE_NAMES.includes(body.cycle)) bad('invalid cycle');
  if (!isFiniteNumber(body.amount) || body.amount <= 0) bad('invalid amount');
  const nextDate = parseIsoDate(body.next_date);
  if (!nextDate) bad('invalid next_date');
  const lastDate = reverseStepCycle(nextDate, body.cycle);

  db.prepare(
    `INSERT INTO recurring_overrides ("key", display_name, direction, cycle, amount, last_date, removed)
       VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT("key") DO UPDATE SET
       display_name = excluded.display_name, direction = excluded.direction, cycle = excluded.cycle,
       amount = excluded.amount, last_date = excluded.last_date, removed = 0`
  ).run(key, name, body.direction, body.cycle, round2(body.amount), lastDate);

  return { ok: true, key };
}

/**
 * Remove a recurring schedule. A MANUAL schedule (no matching detected
 * series) has nothing else backing it, so its row is deleted outright. A
 * DETECTED one is re-derived from transactions on every read, so hiding it
 * needs a standing flag rather than a delete — the row (created if it
 * doesn't exist yet) is marked removed=1 instead of dropped.
 */
function recurringScheduleDelete(ctx, { params }) {
  const db = ctx.db();
  const key = params.key;
  if (!key) bad('key required');

  const catTypeById = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date').all().map((t) => serialiseTx(t, catTypeById));
  const todayIso = localTodayIso();
  const isDetected = DIRECTION_NAMES.some((dir) =>
    detectRecurringSeries(rows.filter((t) => t.tx_type === dir), { today: todayIso }).some((s) => s.key === key)
  );

  if (isDetected) {
    db.prepare(
      'INSERT INTO recurring_overrides ("key", removed) VALUES (?, 1) ON CONFLICT("key") DO UPDATE SET removed = 1'
    ).run(key);
  } else {
    db.prepare('DELETE FROM recurring_overrides WHERE "key" = ?').run(key);
  }
  return { ok: true };
}

const routes = [
  ['GET', '/api/recurring', recurringGet],
  ['POST', '/api/recurring/override', recurringOverrideUpsert],
  ['POST', '/api/recurring/schedule', recurringScheduleCreate],
  ['DELETE', '/api/recurring/schedule/<key>', recurringScheduleDelete],
];

module.exports = { routes };
