'use strict';

// Recurring (Reports) routes. Surfaces detectRecurringSeries
// (services/predictions.js) as a full listing, plus a per-month calendar of
// occurrences (actual past charges + projected ones) for the
// requested month — projected ones fill BOTH the future and any gap between a
// series' last recorded charge and today, so a schedule never renders a month
// as empty merely because the ledger stopped naming it. Income, expense, AND
// transfer patterns are all detected here
// (unlike Cash Flow/Forecast, which exclude transfers), since a recurring
// autosave or auto-invest transfer is one of the schedules this page is for.
// Every schedule's label/direction/cadence/amount can be corrected
// (recurring_overrides), and a schedule can also be added by hand, removed, or
// cleared all at once (DELETE /api/recurring/schedules) — see the handler doc
// comments below.
//
// ADOPTION (the reason there are two listing endpoints): detection is heuristic,
// so it does not populate the page on its own. GET /api/recurring returns only
// ADOPTED schedules — a fresh database returns an empty list however much
// recurring history it holds. The user runs detection explicitly (GET
// /api/recurring/candidates → the picker dialog) and adopts the ones they
// recognize (POST /api/recurring/adopt). The calendar and the editable list read
// the adopted set only.

const { bad, cleanLabel, isFiniteNumber, round2, parseIsoDate } = require('../validate');
const { serialiseTx } = require('../services/transactions');
const {
  detectRecurringSeries, normaliseDesc, localTodayIso, addDays, daysBetween,
  CYCLE_DAYS,
} = require('../services/predictions');
const { addMonthKey } = require('../services/forecast');
// Cadence lives here now. placeRecurring (services/forecast.js) is deliberately
// NOT used any more: it steps a nominal gap, which is all the Balance Forecast's
// own privately detected patterns need, and it has no model of a chosen weekday,
// an nth-weekday month or an end date. Leaving it alone keeps that report's
// detection uncoupled from this page's, which is the arrangement it is built on.
const {
  normaliseRule, ruleFromCycle, nextOccurrence, occurrencesBetween, hasEnded,
  FREQ_NAMES, MONTH_MODES, WEEK_POSITIONS, MAX_INTERVAL,
} = require('../services/recurrence');
const { withinBand, makeKeyResolver } = require('../services/recurringRules');
// Brand-name suggestions for the editor's Name field, from the bundled lexicon
// rather than from the ledger — the only source a schedule for a charge that has
// never posted can be named from. See services/merchantSuggest.js.
const { suggestMerchants } = require('../services/merchantSuggest');
// The merchant link's search term — the same rule the Top Merchants report
// links its bars through (services/merchantSearch.js, extracted from here).
const { searchTermByKey } = require('../services/merchantSearch');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CYCLE_NAMES = Object.keys(CYCLE_DAYS);
const DIRECTION_NAMES = ['income', 'expense', 'transfer'];

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * The cadence rule stored on an override row, or null when the row carries no
 * cadence of its own (the ordinary case for a detected schedule the user has
 * only renamed). The day/weekday parts may be NULL here: normaliseRule fills
 * them from the schedule's anchor, which is where the old stepper took them
 * from too.
 */
function ruleFromRow(ov) {
  if (!ov || !ov.rule_freq) return null;
  return {
    freq: ov.rule_freq,
    interval: ov.rule_interval,
    month_mode: ov.rule_month_mode,
    day: ov.rule_month_day,
    pos: ov.rule_week_pos,
    weekday: ov.rule_weekday,
    until: ov.rule_until,
  };
}

/**
 * What "next due" means on every surface that shows it: the first occurrence
 * that has not happened yet.
 *
 * For a DETECTED series the anchor is its last recorded charge, so the next one
 * is strictly after that AND on or after today — a series survives detection for
 * up to LAPSED_GRACE_DAYS past its due date, so one step off the anchor can
 * still be weeks in the past. For a MANUAL one the anchor is a date the user
 * declared and nothing has posted against, so the anchor itself counts.
 *
 * Null once the rule's end date has passed: the schedule is over, and saying so
 * is the honest answer. It stays on the page, greyed.
 */
function seriesNextDue(rule, anchorIso, todayIso, { afterAnchor }) {
  const from = afterAnchor && addDays(anchorIso, 1) > todayIso ? addDays(anchorIso, 1) : todayIso;
  return nextOccurrence(rule, anchorIso, from);
}

/**
 * id -> category row, for resolving a schedule's chosen category_id into the
 * name it shows and the direction it implies. One query, read once per request.
 */
function categoriesById(db) {
  return new Map(
    db.prepare('SELECT id, name, cat_type FROM categories').all().map((c) => [c.id, c])
  );
}

/**
 * The category the user PICKED for this schedule, or null when they picked none
 * — which is the ordinary case, and means the schedule keeps reading whatever
 * category its transactions carry (categoryByKey).
 *
 * Null too when the picked category has since been deleted: a schedule pointing
 * at a category that no longer exists reads as uncategorized, the same way a
 * transaction does. There is no foreign key to have prevented it (foreign_keys
 * is off app-wide, see db.js), and the alternative — an error on a page the user
 * only wanted to look at — is worse than a blank pill.
 */
function chosenCategory(ov, cats) {
  if (!ov || ov.category_id == null || !cats) return null;
  return cats.get(ov.category_id) || null;
}

/**
 * Layer a user override (recurring_overrides row, or undefined) on top of a
 * detected series. Only display_name/direction/cadence/amount are ever
 * overridden — the real transaction history (dates, occurrence count, past
 * actual amounts) always stays what was actually detected, so an override never
 * rewrites recorded history.
 *
 * An END DATE applies on top of whichever cadence is in force, detected or
 * overridden: "this stops in March" is not a statement about how often it
 * repeats, and making the user restate the cadence to say it would be absurd.
 */
function withOverride(s, ov, todayIso, cats) {
  if (!ov) return s;
  const overridden = normaliseRule(ruleFromRow(ov), s.last_date);
  const rule = { ...(overridden || s.rule), until: ov.rule_until ?? null };
  const next_date = seriesNextDue(rule, s.last_date, todayIso, { afterAnchor: true });
  const chosen = chosenCategory(ov, cats);
  return {
    ...s,
    display_name: ov.display_name ?? s.display_name,
    direction: chosen ? chosen.cat_type : (ov.direction ?? s.direction),
    category_id: chosen ? chosen.id : s.category_id,
    category: chosen ? chosen.name : s.category,
    rule,
    amount: ov.amount ?? s.amount,
    next_date,
    ended: hasEnded(rule, s.last_date, todayIso),
    due_in_days: next_date ? daysBetween(todayIso, next_date) : null,
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
 * A manual schedule's last_date never advances, since no transactions ever post
 * against it, so it can become arbitrarily old — which is why next_date is
 * walked forward (nextDueOnOrAfter) rather than stepped once, and a schedule
 * added long ago still reads "next Aug 15", "next Sep 15", … rather than staying
 * at the date first entered.
 */
function manualSeries(ov, todayIso, cats) {
  if (!ov.display_name || !ov.direction || !ov.rule_freq || ov.amount == null || !ov.last_date) return null;
  const rule = normaliseRule(ruleFromRow(ov), ov.last_date);
  if (!rule) return null;
  // The anchor counts here, unlike a detected series': nothing has posted
  // against it, so the date the user entered is itself still ahead of them.
  const next_date = seriesNextDue(rule, ov.last_date, todayIso, { afterAnchor: false });
  const chosen = chosenCategory(ov, cats);
  return {
    key: ov.key,
    description: ov.display_name,
    display_name: ov.display_name,
    direction: chosen ? chosen.cat_type : ov.direction,
    category_id: chosen ? chosen.id : null,
    category: chosen ? chosen.name : null,
    amount: ov.amount,
    rule,
    dates: [], // no real occurrences ever posted
    occurrences: 0,
    confidence: 1, // user-declared, not statistically inferred
    last_date: ov.last_date,
    next_date,
    ended: hasEnded(rule, ov.last_date, todayIso),
    due_in_days: next_date ? daysBetween(todayIso, next_date) : null,
  };
}

/**
 * The category a detection key's transactions actually carry, as a
 * key -> category_id map. A series is a group of transactions, not one row, so
 * its category is the one MOST of them share; ties go to whichever was used
 * most recently, since a re-categorization is the newer decision. Rows with no
 * category don't vote — a schedule half-categorized still reads as its
 * category, and one with nothing categorized comes back absent.
 */
function categoryByKey(rows, keyOf) {
  const counts = new Map(); // detection key -> Map(category_id -> {n, last})
  for (const t of rows) {
    if (t.category_id == null) continue;
    const key = keyOf(t);
    if (!key) continue;
    let byCat = counts.get(key);
    if (!byCat) { byCat = new Map(); counts.set(key, byCat); }
    const prev = byCat.get(t.category_id);
    byCat.set(t.category_id, { n: (prev ? prev.n : 0) + 1, last: t.date });
  }

  const winners = new Map();
  for (const [key, byCat] of counts) {
    let bestId = null;
    let best = null;
    for (const [id, tally] of byCat) {
      if (!best || tally.n > best.n || (tally.n === best.n && tally.last > best.last)) {
        bestId = id;
        best = tally;
      }
    }
    winners.set(key, bestId);
  }
  return winners;
}

/**
 * Every series detectRecurringSeries finds in the ledger right now, each
 * tagged with the direction of the bucket it was detected in, the category its
 * transactions carry, and the term that finds those transactions in the
 * ledger. No override layering and no adoption filter — the raw detection
 * result, shared by the listing (which then keeps the adopted ones), the
 * candidate picker (which keeps the rest) and delete (which only checks whether
 * a key is detected at all).
 */
/**
 * What a schedule carries beyond its own key: schedule key -> its amount band.
 * Empty on every database today (nothing writes a band any more — see
 * services/recurringRules.js), and an empty map reproduces plain
 * one-key-per-schedule behaviour exactly.
 */
function loadBands(db) {
  const bands = new Map();
  for (const r of db.prepare('SELECT "key", amount_min, amount_max FROM recurring_overrides').all()) {
    if (r.amount_min != null || r.amount_max != null) {
      bands.set(r.key, { min: r.amount_min, max: r.amount_max });
    }
  }
  return bands;
}

/** Every transaction, serialised, with each row's direction resolved from its
 *  category. The one full read the page costs. */
function loadLedger(db) {
  const cats = db.prepare('SELECT id, name, cat_type FROM categories').all();
  const catTypeById = new Map(cats.map((c) => [c.id, c.cat_type]));
  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY date')
    .all()
    .map((t) => serialiseTx(t, catTypeById));
  return { catTypeById, catNameById: new Map(cats.map((c) => [c.id, c.name])), rows };
}

function detectAll(db, todayIso) {
  const { catNameById, rows: allRows } = loadLedger(db);
  const bands = loadBands(db);
  const keyOf = makeKeyResolver();

  // Drop rows outside their schedule's amount band BEFORE detection: the band
  // decides what counts as an occurrence, and detection measures its cadence
  // from the occurrences it is given. Filtering afterwards would leave the
  // cadence measured from rows the user excluded.
  const rows = bands.size ? allRows.filter((t) => withinBand(t.amount, bands.get(keyOf(t)))) : allRows;

  const catByKey = categoryByKey(rows, keyOf);
  const searchByKey = searchTermByKey(rows);

  return DIRECTION_NAMES.flatMap((direction) =>
    detectRecurringSeries(rows.filter((t) => t.tx_type === direction), { today: todayIso, keyOf })
      .map((s) => {
        const categoryId = catByKey.has(s.key) ? catByKey.get(s.key) : null;
        // Detection speaks in five cadence names; the rest of this file speaks
        // in rules. Converting here, once, means a detected schedule and an
        // edited one are the same kind of thing everywhere downstream.
        //
        // It also fixes next_date. Detection dates the next charge one step past
        // the last one it recorded, which can be in the PAST — a series stays
        // detected for up to LAPSED_GRACE_DAYS overdue, so a bill whose latest
        // charge was never imported would read as "next" on a day that has gone.
        // The CALENDAR is unaffected: its projected chips still run from
        // last_date (see recurringGet), which is what fills that overdue gap with
        // faint chips rather than hiding it.
        const rule = ruleFromCycle(s.cycle, s.last_date);
        const next_date = seriesNextDue(rule, s.last_date, todayIso, { afterAnchor: true });
        return {
          ...s,
          rule,
          next_date,
          ended: false, // only an end date ends a schedule, and detection sets none
          due_in_days: next_date ? daysBetween(todayIso, next_date) : null,
          direction,
          category_id: categoryId,
          category: categoryId == null ? null : catNameById.get(categoryId) ?? null,
          search: searchByKey.get(s.key) ?? null,
        };
      })
  );
}

/** The public shape of one schedule/candidate row. */
function serialiseSeries(s) {
  return {
    key: s.key,
    description: s.description,
    display_name: s.display_name,
    direction: s.direction,
    // The category its transactions carry, for the card's pill. Null on a
    // hand-added schedule (no backing transactions) or an uncategorized one.
    category_id: s.category_id ?? null,
    category: s.category ?? null,
    // The ledger Name-filter term that matches this schedule's transactions
    // (searchTermByKey). Null on a hand-added schedule, which has no backing
    // transactions.
    search: s.search ?? null,
    amount: s.amount,
    // The cadence rule (services/recurrence.js), fully resolved: the day of the
    // month or the weekday is filled in from the anchor even when the stored
    // override left it open, so the client never has to re-derive it to draw the
    // control the user edits it with.
    rule: s.rule || null,
    // Its end date has passed. The schedule stays listed, greyed: a row that
    // vanished on its end date would read as data the app lost.
    ended: !!s.ended,
    // No backing transactions, so its anchor date is the user's rather than the
    // ledger's — which is what makes the date editable in the editor.
    manual: s.occurrences === 0,
    occurrences: s.occurrences,
    confidence: s.confidence,
    last_date: s.last_date,
    // Null once the schedule has ended: there is no next one.
    next_date: s.next_date ?? null,
  };
}

function recurringGet(ctx, { query }) {
  const db = ctx.db();

  const month = query.month || currentMonthKey();
  if (!MONTH_RE.test(month)) bad('invalid month (expected YYYY-MM)');

  const todayIso = localTodayIso();
  const cats = categoriesById(db);
  const overrides = new Map(
    db.prepare('SELECT * FROM recurring_overrides WHERE adopted = 1').all().map((o) => [o.key, o])
  );

  // Adopted detections only — an unadopted one is a candidate the user hasn't
  // accepted (or has since deleted), and never renders here.
  const detected = detectAll(db, todayIso)
    .filter((s) => overrides.has(s.key))
    .map((s) => withOverride(s, overrides.get(s.key), todayIso, cats));

  // Any adopted override key that ISN'T a currently-detected series is a
  // manual schedule — synthesize a series-shaped object for it.
  const detectedKeys = new Set(detected.map((s) => s.key));
  const manual = [];
  for (const ov of overrides.values()) {
    if (detectedKeys.has(ov.key)) continue;
    const m = manualSeries(ov, todayIso, cats);
    if (m) manual.push(m);
  }

  // Soonest due first. An ENDED schedule has no next date at all, so it sorts
  // to the bottom rather than to the top, where a null would otherwise put it.
  const series = [...detected, ...manual].sort((a, b) => {
    if (!a.next_date || !b.next_date) return (a.next_date ? 0 : 1) - (b.next_date ? 0 : 1);
    if (a.next_date !== b.next_date) return a.next_date < b.next_date ? -1 : 1;
    return b.confidence - a.confidence;
  });

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
    // Project from the series' OWN anchor, not from today. Projecting from
    // today left every month between the last real charge and now drawing
    // nothing at all: no actual chips (the ledger has none) and no projected
    // ones (they were skipped as past), so a schedule whose merchant string
    // changed — a bank renaming a payroll line, an un-imported recent statement
    // — read as months in which the charge simply never happened, while the
    // months either side of the gap rendered fine. A series survives detection
    // for up to LAPSED_GRACE_DAYS past its next due date, so that gap can be
    // three months wide. Generating from the anchor fills it with the ordinary
    // projected (faint) chip, which is the honest reading: expected here,
    // nothing recorded. Months EARLIER than the anchor stay empty, since
    // occurrencesBetween never runs backwards past it.
    //
    // A projection landing on a day that already has a real charge is dropped:
    // that day's answer is what actually happened, not what was expected.
    const recorded = new Set(s.dates.map((d) => d.date));
    for (const date of occurrencesBetween(s.rule, s.last_date, monthStart, monthEndExclusive)) {
      if (recorded.has(date)) continue;
      occurrences.push({
        date, key: s.key, direction: s.direction, amount: s.amount, actual: false,
      });
    }
  }
  occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { month, series: series.map(serialiseSeries), occurrences };
}

/**
 * Run detection on demand and return what the user hasn't adopted yet — the
 * contents of the "Find recurring schedules" picker. Adopted keys are
 * excluded (they're already on the page); a previously-deleted schedule is
 * simply unadopted, so it shows up here again on the next run, unticked.
 *
 * Read-only: nothing is written until the user picks. Sorted by confidence
 * so the patterns most likely to be real schedules are the ones at the top of
 * the dialog.
 */
function recurringCandidates(ctx) {
  const db = ctx.db();
  const todayIso = localTodayIso();
  const adopted = new Set(
    db.prepare('SELECT "key" FROM recurring_overrides WHERE adopted = 1').all().map((o) => o.key)
  );
  const candidates = detectAll(db, todayIso)
    .filter((s) => !adopted.has(s.key))
    .sort((a, b) => b.confidence - a.confidence || (a.next_date < b.next_date ? -1 : 1));
  return { candidates: candidates.map(serialiseSeries) };
}

/**
 * Adopt the schedules the user ticked in the picker (POST body: {keys: [...]}
 * of detection keys). Adoption is the only thing that puts a detected series on
 * the page, and it is only a flag: the schedule's fields still come from live
 * detection, so an adopted series continues to follow the ledger until the user
 * edits a field. Unrecognized keys are accepted rather than rejected — an
 * adopted row for a key detection no longer produces renders as nothing (since
 * manualSeries requires the full field set), and a stale key in a submitted
 * picker is a race, not a client bug worth a 400.
 */
function recurringAdopt(ctx, { body }) {
  const db = ctx.db();
  const keys = body && body.keys;
  if (!Array.isArray(keys)) bad('keys required');
  const clean = [...new Set(keys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean))];
  if (!clean.length) bad('no keys to adopt');

  const stmt = db.prepare(
    'INSERT INTO recurring_overrides ("key", adopted) VALUES (?, 1) ON CONFLICT("key") DO UPDATE SET adopted = 1'
  );
  db.transaction(() => { for (const key of clean) stmt.run(key); })();

  return { ok: true, adopted: clean.length };
}

/**
 * The rule columns a request describes, as a column -> value patch.
 *
 * Two spellings are accepted and both mean the same thing. `cycle` is the old
 * five-name shorthand, kept because it is the shortest way to say the common
 * cases and because detection still measures cadences in those terms; it sets
 * the frequency and interval only, leaving the day and weekday to be resolved
 * from the schedule's anchor at read time, exactly as it always was. `rule` is
 * the full form the editor sends, where any part may still be left null to mean
 * "take it from the anchor".
 *
 * Each field is checked on its own rather than through normaliseRule: that one
 * needs an anchor to fill the gaps, and the anchor of a DETECTED schedule is its
 * last recorded charge, which is only knowable by running detection. Saving an
 * edit should not have to.
 */
function parseRulePatch(raw) {
  if (CYCLE_NAMES.includes(raw)) {
    const weekly = { weekly: 1, biweekly: 2 }[raw];
    return weekly
      ? { rule_freq: 'weekly', rule_interval: weekly, rule_month_mode: null,
          rule_month_day: null, rule_week_pos: null, rule_weekday: null }
      : { rule_freq: 'monthly', rule_interval: { monthly: 1, quarterly: 3, yearly: 12 }[raw],
          rule_month_mode: 'date', rule_month_day: null, rule_week_pos: null, rule_weekday: null };
  }
  if (!raw || typeof raw !== 'object') bad('invalid cadence');

  if (!FREQ_NAMES.includes(raw.freq)) bad('invalid freq');
  const int = (v, lo, hi, name) => {
    if (v == null) return null;
    if (!Number.isInteger(v) || v < lo || v > hi) bad(`invalid ${name}`);
    return v;
  };
  const interval = raw.interval == null ? 1 : int(raw.interval, 1, MAX_INTERVAL, 'interval');
  if (raw.month_mode != null && !MONTH_MODES.includes(raw.month_mode)) bad('invalid month_mode');
  if (raw.pos != null && !WEEK_POSITIONS.includes(raw.pos)) bad('invalid pos');

  return {
    rule_freq: raw.freq,
    rule_interval: interval,
    rule_month_mode: raw.freq === 'monthly' ? (raw.month_mode ?? 'date') : null,
    rule_month_day: raw.freq === 'monthly' ? int(raw.day, 1, 31, 'day') : null,
    rule_week_pos: raw.freq === 'monthly' && raw.month_mode === 'day' ? (raw.pos ?? 1) : null,
    rule_weekday: int(raw.weekday, 0, 6, 'weekday'),
  };
}

/**
 * A category_id from a request, as a value to store: an id this database
 * actually has, or null to clear the choice and go back to whatever the
 * schedule's transactions say.
 *
 * Checked against the table rather than merely type-checked, because a stored id
 * that matches no category reads back as uncategorized — the schedule would
 * silently lose the answer the user just gave it.
 */
function parseCategoryId(db, raw) {
  if (raw === null || raw === '') return null;
  if (!Number.isInteger(raw)) bad('invalid category_id');
  const row = db.prepare('SELECT id FROM categories WHERE id = ?').get(raw);
  if (!row) bad('unknown category_id');
  return raw;
}

/** The empty cadence patch: back to whatever detection measures. */
const NO_RULE = {
  rule_freq: null, rule_interval: null, rule_month_mode: null,
  rule_month_day: null, rule_week_pos: null, rule_weekday: null,
};

/**
 * Upsert a user override for one recurring schedule (POST body: {key,
 * display_name?, direction?, cycle?|rule?, until?, amount?, next_date?} — any
 * subset, each null clearing that field back to auto-detected).
 * The amount BAND is not among them: it decides which transactions a cadence is
 * measured from, which is a question about detecting a schedule rather than
 * about writing one, and nothing writes one any more (see
 * services/recurringRules.js). Recurring rows have no surrogate id (a
 * detected series is recomputed from transactions on every read — see
 * detectRecurringSeries), so the grouping key is the identifier, the same way
 * Cash Flow's /api/entry keys on a category string rather than a row id.
 * Editing a manual schedule's date is not supported here — only
 * POST /api/recurring/schedule (create) sets last_date; delete and re-add to
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
  // The category the schedule is FILED under, which is not the same question as
  // the direction above: null here means "read it off my transactions again",
  // and a set one outranks both the detected category and the stored direction
  // (withOverride), since a category owns the direction of everything filed
  // under it.
  if (hasField('category_id')) patch.category_id = parseCategoryId(db, body.category_id);
  // `cycle` and `rule` are two spellings of the same patch; null clears the
  // cadence override so the schedule follows whatever detection measures again.
  if (hasField('cycle') || hasField('rule')) {
    const raw = hasField('rule') ? body.rule : body.cycle;
    Object.assign(patch, raw === null ? NO_RULE : parseRulePatch(raw));
  }
  // The end date is its OWN field, not part of the cadence: "this stops in
  // March" says nothing about how often it repeats, and making the user restate
  // the cadence in order to say it would be absurd. withOverride applies it on
  // top of whichever cadence is in force.
  if (hasField('until')) {
    if (body.until !== null && !parseIsoDate(body.until)) bad('invalid until');
    patch.rule_until = body.until;
  }
  // The anchor, for a MANUAL schedule: the date it next falls on. A detected
  // schedule's dates come from its transactions, so there is nothing here to
  // move and the editor does not offer it.
  if (hasField('next_date')) {
    if (body.next_date !== null && !parseIsoDate(body.next_date)) bad('invalid next_date');
    patch.last_date = body.next_date;
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
  // Editing a schedule also adopts it: the only UI path to this endpoint is a
  // row already on the page, and a caller correcting a candidate's name or
  // amount directly is keeping that schedule. No effect on an already-adopted
  // row, which is the normal case.
  patch.adopted = 1;

  db.transaction(() => {
    db.prepare('INSERT INTO recurring_overrides ("key") VALUES (?) ON CONFLICT("key") DO NOTHING').run(key);
    const sets = Object.keys(patch).map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE recurring_overrides SET ${sets} WHERE "key" = ?`).run(...Object.values(patch), key);
  })();

  const row = db.prepare('SELECT * FROM recurring_overrides WHERE "key" = ?').get(key);
  return { ok: true, override: row };
}

/**
 * Create (or fully replace) a MANUAL recurring schedule — one with no
 * backing transactions (a charge the user expects but has not been billed for
 * yet). Every field is required, unlike the partial-patch upsert above.
 * The key is derived from display_name via normaliseDesc — the SAME grouping key
 * real transactions for that merchant would produce — so once matching
 * transactions are imported, detection takes over and this row continues to
 * apply as an override on top of it (withOverride). `next_date` is stored as the
 * schedule's ANCHOR: a rule generates from its anchor inclusive, so the date the
 * user entered is itself the first occurrence, and nothing has to be
 * reverse-stepped to make that true.
 * A hand-added schedule is adopted on the spot — the user just declared it,
 * there is nothing left to confirm in a detection picker.
 */
function recurringScheduleCreate(ctx, { body }) {
  const db = ctx.db();
  if (!body) bad('invalid request');

  const name = cleanLabel(body.display_name);
  if (!name) bad('name required');
  const key = normaliseDesc(name);
  if (!key) bad('name must contain letters');

  if (!DIRECTION_NAMES.includes(body.direction)) bad('invalid direction');
  // Optional: a schedule can be created uncategorized, and a manual one has no
  // transactions to read a category off later, so leaving it out is a real
  // answer rather than an omission.
  const categoryId = body.category_id == null ? null : parseCategoryId(db, body.category_id);
  if (!isFiniteNumber(body.amount) || body.amount <= 0) bad('invalid amount');
  const nextDate = parseIsoDate(body.next_date);
  if (!nextDate) bad('invalid next_date');
  const until = body.until == null ? null : parseIsoDate(body.until);
  if (body.until != null && !until) bad('invalid until');
  if (until && until < nextDate) bad('the end date is before the first charge');
  const rule = parseRulePatch(body.rule ?? body.cycle);

  db.prepare(
    `INSERT INTO recurring_overrides
       ("key", display_name, direction, category_id, amount, last_date, adopted, rule_until,
        rule_freq, rule_interval, rule_month_mode, rule_month_day, rule_week_pos, rule_weekday)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT("key") DO UPDATE SET
       display_name = excluded.display_name, direction = excluded.direction,
       category_id = excluded.category_id,
       amount = excluded.amount, last_date = excluded.last_date, adopted = 1,
       rule_until = excluded.rule_until,
       rule_freq = excluded.rule_freq, rule_interval = excluded.rule_interval,
       rule_month_mode = excluded.rule_month_mode, rule_month_day = excluded.rule_month_day,
       rule_week_pos = excluded.rule_week_pos, rule_weekday = excluded.rule_weekday`
  ).run(
    key, name, body.direction, categoryId, round2(body.amount), nextDate, until,
    rule.rule_freq, rule.rule_interval, rule.rule_month_mode,
    rule.rule_month_day, rule.rule_week_pos, rule.rule_weekday
  );

  return { ok: true, key };
}

// ── Naming ──────────────────────────────────────────────────────────────────

const MAX_BRAND_RESULTS = 8;

/**
 * Brand-name suggestions for the editor's Name field (GET
 * /api/recurring/brands?q=). The ANSWER TO A DIFFERENT QUESTION from
 * /api/recurring/similar below, which searches the ledger: this searches the
 * bundled merchant lexicon, so it can name a charge that has never posted —
 * which is precisely the schedule the user is writing by hand.
 *
 * Nothing is associated with any transaction. The suggestion fills in a name and
 * a category, and the name is what draws the merchant's avatar (avatar.js slugs
 * the label and looks it up in the icon manifest the same lexicon generated).
 *
 * A brand whose category key this database no longer has — the user deleted or
 * renamed the default — still comes back, named, with a null category. The name
 * is the useful half and the category is an offer.
 */
function recurringBrands(ctx, { query }) {
  const db = ctx.db();
  const hits = suggestMerchants(query.q, MAX_BRAND_RESULTS);
  if (!hits.length) return { brands: [] };

  const byKey = new Map(
    db.prepare('SELECT id, "key" AS key, name, cat_type FROM categories').all().map((c) => [c.key, c])
  );
  return {
    brands: hits.map(({ name, category_key: categoryKey }) => {
      const cat = byKey.get(categoryKey) || null;
      return {
        name,
        category_id: cat ? cat.id : null,
        category: cat ? cat.name : null,
        direction: cat ? cat.cat_type : null,
      };
    }),
  };
}

/**
 * Remove a recurring schedule from the page. A MANUAL schedule (no matching
 * detected series) has nothing else backing it, so its row is deleted
 * outright. A DETECTED one is re-derived from transactions on every read, so
 * it's un-adopted instead of dropped — that both takes it off the page and
 * puts it back in the candidate picker, where the user can re-tick it if the
 * delete was a mistake. Its stored corrections are kept for that return trip.
 * The transactions behind it are never touched either way.
 */
function recurringScheduleDelete(ctx, { params }) {
  const db = ctx.db();
  const key = params.key;
  if (!key) bad('key required');

  const isDetected = detectAll(db, localTodayIso()).some((s) => s.key === key);
  if (isDetected) {
    // Un-adopt only. The amount band stays with the row: it is a correction like
    // any other, and the schedule returns to the picker measuring the same
    // occurrences it did here.
    db.prepare('UPDATE recurring_overrides SET adopted = 0 WHERE "key" = ?').run(key);
  } else {
    db.prepare('DELETE FROM recurring_overrides WHERE "key" = ?').run(key);
  }
  return { ok: true };
}

/**
 * Take the whole page back to blank — the bulk form of the delete above, and
 * it follows the same rule schedule-by-schedule: detected series are un-adopted
 * (corrections kept, returned to the picker), manual ones are deleted. This
 * clears the CALENDAR, not the user's history: anything detection can find
 * returns on the next "Find recurring schedules" run, and no transaction is
 * modified.
 *
 * Idempotent — clearing an already-empty page is a 200 with cleared: 0, not an
 * error. No confirmation at this layer; the UI shows that prompt.
 */
function recurringClearAll(ctx) {
  const db = ctx.db();
  const detected = new Set(detectAll(db, localTodayIso()).map((s) => s.key));
  const adopted = db
    .prepare('SELECT "key" FROM recurring_overrides WHERE adopted = 1')
    .all()
    .map((o) => o.key);

  const unadopt = db.prepare('UPDATE recurring_overrides SET adopted = 0 WHERE "key" = ?');
  const dropRow = db.prepare('DELETE FROM recurring_overrides WHERE "key" = ?');
  db.transaction(() => {
    for (const key of adopted) {
      if (detected.has(key)) unadopt.run(key);
      else dropRow.run(key);
    }
  })();

  return { ok: true, cleared: adopted.length };
}

const routes = [
  ['GET', '/api/recurring', recurringGet],
  ['GET', '/api/recurring/candidates', recurringCandidates],
  ['GET', '/api/recurring/brands', recurringBrands],
  ['POST', '/api/recurring/adopt', recurringAdopt],
  ['POST', '/api/recurring/override', recurringOverrideUpsert],
  ['POST', '/api/recurring/schedule', recurringScheduleCreate],
  ['DELETE', '/api/recurring/schedule/<key>', recurringScheduleDelete],
  ['DELETE', '/api/recurring/schedules', recurringClearAll],
];

module.exports = { routes };
