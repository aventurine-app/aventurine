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
// BUILT SCHEDULES: detection groups by one normaliseDesc key and counts every
// row under it, which loses a series its bank has renamed and breaks one whose
// merchant sends off-cycle extras under the same description. A schedule can
// therefore carry a RULE instead of a bare key -- several description keys
// folded together (recurring_aliases) plus an amount band -- which the user
// assembles in the builder (GET /api/recurring/merchants, GET
// /api/recurring/similar, POST /api/recurring/preview, POST /api/recurring/build).
// See services/recurringRules.js for why neither case is reachable by tuning a
// threshold. Membership is still recomputed from transactions on every read, so
// a built schedule picks up future charges on its own and survives a re-import.
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
  detectRecurringSeries, normaliseDesc, localTodayIso, addMonths, addDays, daysBetween, median,
  CYCLE_MONTHS, CYCLE_DAYS,
} = require('../services/predictions');
const { addMonthKey, placeRecurring } = require('../services/forecast');
const {
  suggestAmountBand, withinBand, makeKeyResolver, summariseByKey,
} = require('../services/recurringRules');
const { sequenceRatio, FUZZY_THRESHOLD_MIN } = require('../services/matchRules');
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
 * PAST occurrences (services/predictions.js's `dates`) are untouched, so an
 * override never rewrites recorded history.
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
 * DETECTED series' last_date is always recent — LAPSED_GRACE_DAYS caps it at 90
 * days), a manual schedule's last_date never advances, since no transactions
 * post against it, so it can become arbitrarily old. next_date is therefore
 * walked forward with the same catch-up loop placeRecurring uses, so a schedule
 * added once continues to read "next Aug 15", "next Sep 15", … rather than
 * staying at the date first entered.
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
 * The rules built schedules carry: alias key -> schedule key, and schedule key
 * -> its amount band. Both are empty on a database whose schedules were all
 * detected or hand-added, and an empty pair reproduces the pre-builder
 * behaviour exactly.
 */
function loadRules(db) {
  const aliases = new Map(
    db.prepare('SELECT alias_key, "key" FROM recurring_aliases').all().map((a) => [a.alias_key, a.key])
  );
  const bands = new Map();
  for (const r of db.prepare('SELECT "key", amount_min, amount_max FROM recurring_overrides').all()) {
    if (r.amount_min != null || r.amount_max != null) {
      bands.set(r.key, { min: r.amount_min, max: r.amount_max });
    }
  }
  return { aliases, bands };
}

/** Every transaction, serialised, with each row's direction resolved from its
 *  category. The one full read the page costs; shared by detection and by the
 *  builder's summaries so neither scans the table twice. */
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
  const { aliases, bands } = loadRules(db);
  const keyOf = makeKeyResolver(aliases);

  // Drop rows outside their schedule's amount band BEFORE detection: the band
  // decides what counts as an occurrence, and detection measures its cadence
  // from the occurrences it is given. Filtering afterwards would leave the
  // cadence measured from rows the user excluded.
  const rows = bands.size ? allRows.filter((t) => withinBand(t.amount, bands.get(keyOf(t)))) : allRows;

  const catByKey = categoryByKey(rows, keyOf);
  // Keyed by RAW normaliseDesc (merchantSearch is shared with Top Merchants and
  // knows nothing of aliases). A folded series' key is the primary key, which is
  // itself one of those raw keys, so the lookup still resolves.
  const searchByKey = searchTermByKey(rows);

  return DIRECTION_NAMES.flatMap((direction) =>
    detectRecurringSeries(rows.filter((t) => t.tx_type === direction), { today: todayIso, keyOf })
      .map((s) => {
        const categoryId = catByKey.has(s.key) ? catByKey.get(s.key) : null;
        return {
          ...s,
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
    cycle: s.cycle,
    occurrences: s.occurrences,
    confidence: s.confidence,
    last_date: s.last_date,
    next_date: s.next_date,
  };
}

function recurringGet(ctx, { query }) {
  const db = ctx.db();

  const month = query.month || currentMonthKey();
  if (!MONTH_RE.test(month)) bad('invalid month (expected YYYY-MM)');

  const todayIso = localTodayIso();
  const overrides = new Map(
    db.prepare('SELECT * FROM recurring_overrides WHERE adopted = 1').all().map((o) => [o.key, o])
  );

  // Adopted detections only — an unadopted one is a candidate the user hasn't
  // accepted (or has since deleted), and never renders here.
  const detected = detectAll(db, todayIso)
    .filter((s) => overrides.has(s.key))
    .map((s) => withOverride(s, overrides.get(s.key), todayIso));

  // Any adopted override key that ISN'T a currently-detected series is a
  // manual schedule — synthesize a series-shaped object for it.
  const detectedKeys = new Set(detected.map((s) => s.key));
  const manual = [];
  for (const ov of overrides.values()) {
    if (detectedKeys.has(ov.key)) continue;
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
    // Project forward from the series' OWN last recorded charge, not from
    // today. Projecting from today left every month between the last real
    // charge and now drawing nothing at all: no actual chips (the ledger has
    // none) and no projected ones (they were skipped as past), so a schedule
    // whose merchant string changed — a bank renaming a payroll line, an
    // un-imported recent statement — read as months in which the charge simply
    // never happened, while the months either side of the gap rendered fine.
    // A series survives detection for up to LAPSED_GRACE_DAYS past its next due
    // date, so that gap can be three months wide. Stepping from last_date fills
    // it with the ordinary projected (faint) chip, which is the honest reading:
    // expected here, nothing recorded. No chip can collide with an actual one,
    // since the first step lands strictly after last_date, the newest date in
    // `dates`. placeRecurring's catch-up loop then no-ops (nothing precedes the
    // start bound) and its end bound still leaves months earlier than the last
    // recorded charge empty.
    const projected = placeRecurring(
      [{ key: s.key, name: s.cycle, days: s.cycle_days, amount: s.amount, last: s.last_date }],
      s.last_date,
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
 * Upsert a user override for one recurring schedule (POST body: {key,
 * display_name?, direction?, cycle?, amount?} — any subset, each null clears
 * that field back to auto-detected). Recurring rows have no surrogate id (a
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
  // Editing a schedule also adopts it: the only UI path to this endpoint is a
  // row already on the page, and a caller correcting a candidate's name or
  // amount directly is keeping that schedule. No effect on an already-adopted
  // row, which is the normal case.
  patch.adopted = 1;

  db.prepare('INSERT INTO recurring_overrides ("key") VALUES (?) ON CONFLICT("key") DO NOTHING').run(key);
  const sets = Object.keys(patch).map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE recurring_overrides SET ${sets} WHERE "key" = ?`).run(...Object.values(patch), key);

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
 * apply as an override on top of it (withOverride). `next_date` is what the user
 * enters, but a schedule is stored and projected the same way a detected series
 * is (last_date + cycle), so it is reverse-stepped once here.
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
  if (!CYCLE_NAMES.includes(body.cycle)) bad('invalid cycle');
  if (!isFiniteNumber(body.amount) || body.amount <= 0) bad('invalid amount');
  const nextDate = parseIsoDate(body.next_date);
  if (!nextDate) bad('invalid next_date');
  const lastDate = reverseStepCycle(nextDate, body.cycle);

  db.prepare(
    `INSERT INTO recurring_overrides ("key", display_name, direction, cycle, amount, last_date, adopted)
       VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT("key") DO UPDATE SET
       display_name = excluded.display_name, direction = excluded.direction, cycle = excluded.cycle,
       amount = excluded.amount, last_date = excluded.last_date, adopted = 1`
  ).run(key, name, body.direction, body.cycle, round2(body.amount), lastDate);

  return { ok: true, key };
}

// ── Builder ──────────────────────────────────────────────────────────────────
// Assembling a schedule the detector could not find on its own: the user names
// one merchant, the app offers every description that looks like it, and the
// picked set becomes the schedule's rule. See services/recurringRules.js for
// why the rule is a set of keys plus an amount band rather than a list of
// transaction ids.

const MAX_BUILD_KEYS = 25;   // a schedule assembled from more spellings than
                             // this is a mis-click, not a renamed merchant
const MAX_MERCHANT_RESULTS = 40;

/**
 * Description keys that already belong to ANOTHER built schedule's rule. These
 * block: letting two schedules fold the same key would divide one merchant's
 * history between them, and each would then measure a cadence from half of it.
 */
function aliasOwners(db) {
  return new Map(
    db.prepare('SELECT alias_key, "key" FROM recurring_aliases').all().map((a) => [a.alias_key, a.key])
  );
}

/**
 * Keys that are currently a schedule in their own right. Unlike an alias this
 * does NOT block: a user assembling a renamed series will often tick a fragment
 * they adopted earlier, back when it was still detectable, and absorbing it is
 * precisely what they are asking for. The builder reports these so the dialog
 * can say so on the row rather than springing it on them.
 */
function adoptedKeys(db) {
  return new Set(
    db.prepare('SELECT "key" FROM recurring_overrides WHERE adopted = 1').all().map((o) => o.key)
  );
}

/**
 * Merchant groups matching a search term — step one of the builder, where the
 * user names the schedule the detector missed.
 *
 * This searches DESCRIPTIONS, not transactions: the user is identifying a
 * merchant, not a particular charge, and returning groups keeps the response
 * small (a real ledger holds far fewer distinct descriptions than rows) and
 * spares them choosing which of 46 identical paychecks is "the" one.
 */
function recurringMerchants(ctx, { query }) {
  const db = ctx.db();
  const q = String(query.q || '').trim().toLowerCase();
  if (!q) return { merchants: [] };

  const { rows } = loadLedger(db);
  const owners = aliasOwners(db);
  const adopted = adoptedKeys(db);

  const merchants = summariseByKey(rows)
    .filter((g) => g.description.toLowerCase().includes(q) || g.key.includes(q))
    // Newest first: a schedule is built to project forward, so the merchant the
    // user is looking for is almost always one that charged recently.
    .sort((a, b) => (a.last_date < b.last_date ? 1 : a.last_date > b.last_date ? -1 : b.count - a.count))
    .slice(0, MAX_MERCHANT_RESULTS)
    .map((g) => ({ ...g, claimed_by: owners.get(g.key) ?? null, adopted: adopted.has(g.key) }));

  return { merchants };
}

/**
 * Descriptions that look like the seed's — step two, where a renamed series is
 * put back together.
 *
 * Everything at or above FUZZY_THRESHOLD_MIN is returned, and the client shows
 * the whole list with only the exact match ticked. There is deliberately NO
 * threshold slider: whether loose matching is safe depends on how distinctive
 * the merchant's name is, which a number cannot express. Measured on a real
 * ledger, a seed of "PUSHPAY USA INC" matches its three renamed spellings and
 * nothing else across 963 descriptions, while "ZELLE PAYMENT FROM <person>" at
 * the same threshold reaches a different person entirely. A count, a date span
 * and an amount range make that judgement obvious; a number does not.
 *
 * Candidates are restricted to the seed's own direction, which removes the
 * commonest false match for free (a payment TO someone scoring high against a
 * payment FROM them).
 */
function recurringSimilar(ctx, { query }) {
  const db = ctx.db();
  const key = String(query.key || '').trim();
  if (!key) bad('key required');

  const { rows } = loadLedger(db);
  const groups = summariseByKey(rows);
  const seed = groups.find((g) => g.key === key);
  if (!seed) bad('no transactions match that merchant', 404);

  const owners = aliasOwners(db);
  const adopted = adoptedKeys(db);
  const needle = seed.description.toLowerCase();

  const matches = groups
    .filter((g) => g.direction === seed.direction)
    .map((g) => ({ ...g, similarity: round2(sequenceRatio(needle, g.description.toLowerCase())) }))
    .filter((g) => g.key === seed.key || g.similarity >= FUZZY_THRESHOLD_MIN)
    .map((g) => ({
      ...g,
      exact: g.key === seed.key,
      claimed_by: owners.get(g.key) === seed.key ? null : owners.get(g.key) ?? null,
      // Its own schedule today, and it would be folded into this one. Shown on
      // the row so ticking it is a decision rather than a surprise.
      adopted: g.key !== seed.key && adopted.has(g.key),
    }))
    .sort((a, b) => b.similarity - a.similarity || (a.last_date < b.last_date ? 1 : -1));

  return { seed: { key: seed.key, description: seed.description, direction: seed.direction }, matches };
}

/**
 * Resolve a builder request into the schedule it describes, without writing.
 * Shared by preview and build so the schedule the user is shown is produced by
 * the same code that saves it.
 *
 * The PRIMARY key is the picked key whose newest charge is newest overall:
 * that is the spelling the bank is using now, so it is the one a future import
 * will carry and the one the other picks fold onto.
 */
function resolveBuild(db, body) {
  const raw = (body && body.keys) || [];
  if (!Array.isArray(raw)) bad('keys required');
  const keys = [...new Set(raw.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean))];
  if (!keys.length) bad('no keys selected');
  if (keys.length > MAX_BUILD_KEYS) bad(`at most ${MAX_BUILD_KEYS} descriptions can form one schedule`);

  const band = parseBand(body);
  const todayIso = localTodayIso();
  const { rows } = loadLedger(db);

  const picked = new Set(keys);
  const matched = rows.filter((t) => picked.has(normaliseDesc(t.description)));
  if (!matched.length) bad('no transactions match those descriptions', 404);

  const newestMatch = matched.reduce((a, b) => (a.date > b.date ? a : b));
  const direction = body.direction && DIRECTION_NAMES.includes(body.direction)
    ? body.direction
    : newestMatch.tx_type;
  // One direction per schedule, the same way detection buckets the ledger. A
  // mixed selection keeps the rows that agree with the newest charge rather
  // than measuring a cadence across two different kinds of money.
  const inDirection = matched.filter((t) => t.tx_type === direction);
  if (!inDirection.length) bad('no transactions match those descriptions', 404);

  const primary = normaliseDesc(inDirection.reduce((a, b) => (a.date > b.date ? a : b)).description);
  const kept = inDirection.filter((t) => withinBand(t.amount, band));
  if (!kept.length) bad('the amount range excludes every matching transaction');

  const series = detectRecurringSeries(kept, { today: todayIso, keyOf: () => primary })[0] || null;
  const newest = kept.reduce((a, b) => (a.date > b.date ? a : b));

  return {
    keys,
    primary,
    direction,
    band,
    series,
    matched_count: inDirection.length,
    excluded_count: inDirection.length - kept.length,
    suggested_band: suggestAmountBand(inDirection.map((t) => t.amount)),
    newest_date: newest.date,
    newest_description: newest.description,
    median_amount: round2(median(kept.map((t) => t.amount))),
  };
}

/** {min, max} from a request body, or null for no band. Either bound may be
 *  null on its own (an open-ended range is still a range). */
function parseBand(body) {
  const read = (field) => {
    if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === null) return null;
    if (!isFiniteNumber(body[field]) || body[field] < 0) bad(`invalid ${field}`);
    return round2(body[field]);
  };
  const min = read('amount_min');
  const max = read('amount_max');
  if (min != null && max != null && min > max) bad('amount_min must not exceed amount_max');
  return min == null && max == null ? null : { min, max };
}

/**
 * What POST /api/recurring/build would create, without writing anything. The
 * dialog calls this as the user ticks descriptions, so the cadence, amount and
 * next due date on screen are the ones that will actually be saved.
 *
 * `needs_cycle` is the interesting answer: it means the picked set is real but
 * too short or too irregular for a cadence to be measured, so the user has to
 * say what it is. That is the case the builder exists for.
 */
function recurringPreview(ctx, { body }) {
  const r = resolveBuild(ctx.db(), body || {});
  return {
    primary: r.primary,
    direction: r.direction,
    matched_count: r.matched_count,
    excluded_count: r.excluded_count,
    suggested_band: r.suggested_band,
    needs_cycle: !r.series,
    series: r.series ? serialiseSeries({ ...r.series, direction: r.direction }) : null,
    median_amount: r.median_amount,
  };
}

/**
 * Save the built schedule: one adopted override row plus an alias row per
 * extra description key.
 *
 * Two shapes come out of this, and which one depends on whether the picked set
 * detects. When it does, the override deliberately stores NO cycle or amount —
 * those keep coming from live detection, so the schedule follows the ledger the
 * way every detected one does, and the band and aliases are all that was added.
 * When it does not, the request must carry a cycle and the row is written as a
 * full manual schedule; detection takes over by itself once enough charges land
 * (withOverride), exactly as it does for a hand-added one.
 */
function recurringBuild(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  const r = resolveBuild(db, data);

  let displayName = null;
  if (data.display_name != null) {
    displayName = cleanLabel(data.display_name);
    if (!displayName) bad('invalid display_name');
  }
  // A schedule that cannot be detected is stored as a manual one, and
  // manualSeries only surfaces a row carrying every field — including a label.
  // Falling back to the newest description gives it the name the user just
  // picked it by. A DETECTED schedule keeps a null label on purpose: that is
  // what makes its name follow the ledger.
  if (!displayName && !r.series) displayName = cleanLabel(r.newest_description);

  // A key already folded into a DIFFERENT built schedule is refused: taking it
  // would divide one merchant's history between two schedules, and each would
  // then measure a cadence from half of it. The owner is named so the message
  // points at the schedule to edit.
  const owners = aliasOwners(db);
  for (const key of r.keys) {
    const owner = owners.get(key);
    if (owner && owner !== r.primary) {
      bad('one of those descriptions already belongs to another schedule', 409, { key, schedule: owner });
    }
  }

  // A picked key that is its own schedule today is ABSORBED, not refused. This
  // is the common case when a renamed series is reassembled: the user adopted a
  // fragment months ago, it lapsed off the calendar when the bank renamed it,
  // and they are now saying it was this schedule all along. Un-adopting keeps
  // its stored corrections, the same way deleting a detected schedule does.
  const adopted = adoptedKeys(db);
  const absorbed = r.keys.filter((k) => k !== r.primary && adopted.has(k));

  let cycle = null;
  if (!r.series) {
    if (!CYCLE_NAMES.includes(data.cycle)) bad('cycle required: these charges are too few or too irregular to measure one', 422);
    cycle = data.cycle;
  } else if (CYCLE_NAMES.includes(data.cycle)) {
    cycle = data.cycle; // an explicit correction still wins over what was measured
  }

  const aliases = r.keys.filter((k) => k !== r.primary);

  db.transaction(() => {
    db.prepare('INSERT INTO recurring_overrides ("key") VALUES (?) ON CONFLICT("key") DO NOTHING').run(r.primary);
    db.prepare(
      `UPDATE recurring_overrides
          SET adopted = 1, direction = ?, amount_min = ?, amount_max = ?,
              display_name = COALESCE(?, display_name),
              cycle = ?,
              amount = CASE WHEN ? THEN ? ELSE NULL END,
              last_date = CASE WHEN ? THEN ? ELSE NULL END
        WHERE "key" = ?`
    ).run(
      r.direction,
      r.band ? r.band.min : null,
      r.band ? r.band.max : null,
      displayName,
      cycle,
      r.series ? 0 : 1, r.median_amount,
      r.series ? 0 : 1, r.newest_date,
      r.primary
    );

    // Replace this schedule's aliases wholesale: the picked set IS the rule, so
    // rebuilding it with one description unticked has to drop that key rather
    // than leave the old row behind.
    db.prepare('DELETE FROM recurring_aliases WHERE "key" = ?').run(r.primary);
    const addAlias = db.prepare('INSERT INTO recurring_aliases (alias_key, "key") VALUES (?, ?)');
    for (const alias of aliases) addAlias.run(alias, r.primary);

    // An absorbed fragment must stop being a schedule of its own, or the page
    // would list it beside the one that now owns its transactions.
    const unadopt = db.prepare('UPDATE recurring_overrides SET adopted = 0 WHERE "key" = ?');
    for (const key of absorbed) unadopt.run(key);
  })();

  return {
    ok: true, key: r.primary, aliases: aliases.length, detected: !!r.series, absorbed: absorbed.length,
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
    // Un-adopt only. The aliases and amount band stay with the row: they are
    // corrections like any other, and keeping them means the schedule returns
    // to the picker as the ONE series the user assembled instead of splintering
    // back into the fragments they just merged.
    db.prepare('UPDATE recurring_overrides SET adopted = 0 WHERE "key" = ?').run(key);
  } else {
    db.transaction(() => {
      db.prepare('DELETE FROM recurring_aliases WHERE "key" = ?').run(key);
      db.prepare('DELETE FROM recurring_overrides WHERE "key" = ?').run(key);
    })();
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
  const dropAliases = db.prepare('DELETE FROM recurring_aliases WHERE "key" = ?');
  const dropRow = db.prepare('DELETE FROM recurring_overrides WHERE "key" = ?');
  db.transaction(() => {
    for (const key of adopted) {
      if (detected.has(key)) {
        unadopt.run(key);
      } else {
        dropAliases.run(key);
        dropRow.run(key);
      }
    }
  })();

  return { ok: true, cleared: adopted.length };
}

const routes = [
  ['GET', '/api/recurring', recurringGet],
  ['GET', '/api/recurring/candidates', recurringCandidates],
  ['GET', '/api/recurring/merchants', recurringMerchants],
  ['GET', '/api/recurring/similar', recurringSimilar],
  ['POST', '/api/recurring/preview', recurringPreview],
  ['POST', '/api/recurring/build', recurringBuild],
  ['POST', '/api/recurring/adopt', recurringAdopt],
  ['POST', '/api/recurring/override', recurringOverrideUpsert],
  ['POST', '/api/recurring/schedule', recurringScheduleCreate],
  ['DELETE', '/api/recurring/schedule/<key>', recurringScheduleDelete],
  ['DELETE', '/api/recurring/schedules', recurringClearAll],
];

module.exports = { routes };
