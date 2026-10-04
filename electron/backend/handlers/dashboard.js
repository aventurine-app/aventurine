'use strict';

// Dashboard routes: the user's saved Dashboard layouts.
//
// A layout is one tab of the Dashboard: a name and a set of cards. A card is a
// widget type placed on a 12-column grid, with its own display settings and its
// own period. The page (static/js/pages/dashboard.js and dashcards.js) owns what
// every card draws; this file stores layouts and refuses any shape that could
// not have come from that page, so a malformed write can never leave the
// Dashboard unable to load.
//
// ONE WRITE REPLACES EVERYTHING. A Customize session can rename, add, delete and
// rearrange several layouts and ends with one Done, and a period change outside
// it touches one card of one layout. Both are small (a few layouts of a dozen
// cards), so a PUT carries the complete set and is applied in one transaction:
// what is stored is always a set the page actually had, never half of one. The
// whole payload is validated before anything is written.
//
// NOTHING STORED MEANS THE DEFAULT. A database that never saved a dashboard
// answers with no layouts, and the page draws its default. No row is seeded on
// purpose: an untouched dashboard keeps following whatever the default is in the
// build the user is running. A PUT of an empty list returns to that state.
//
// WHICH TAB IS OPEN lives in app_settings under ACTIVE_KEY rather than as a
// column, so switching tabs rewrites one setting instead of every layout row.

const { bad } = require('../validate');

const ACTIVE_KEY = 'dashboard_active_layout';

const MAX_LAYOUTS = 8;
const MAX_CARDS = 40;
const COLS = 12;
const MAX_ROW = 2000;
const MAX_HEIGHT = 12;
const MAX_NAME = 32;
// A card's settings are a handful of display choices (a chart form, a count,
// the accounts a chart offers). The cap is far above any real one; it is here so
// one write cannot park an arbitrarily large blob in the row.
const MAX_SETTINGS_CHARS = 2000;

// Client-made ids: the page names layouts and cards itself, so a save never has
// to wait on the server to learn an id before the next edit can refer to it.
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// The widget types the page's registry draws (static/js/pages/dashcards.js is
// the authority on what each one is). Listed here only so an unknown type is
// refused at the door instead of stored and silently skipped on every load.
const CARD_TYPES = new Set([
  'networth', 'accounts', 'incomeExpenses', 'cashflow', 'balances', 'spending', 'monthlySpending',
  'budgets', 'savingsRate', 'merchants', 'transactions', 'upcoming', 'forecast',
]);

// Period presets (static/js/widgets/dashperiod.js): the calendar month, trailing
// ranges ending with it, days ahead (Upcoming Bills) and months ahead (Cash
// Forecast). `month` pins a 'month' preset to one month; null follows the
// current one.
const PERIOD_PRESETS = new Set([
  'month', 'm3', 'm6', 'ytd', 'y1', 'y3', 'y5',
  'd14', 'd30', 'd60', 'f1', 'f3', 'f6',
]);
// The colours a card may wear to link its period to other cards
// (static/js/pages/dashboard.js COLORS).
const CARD_COLORS = new Set(['red', 'orange', 'green', 'blue', 'purple', 'pink']);

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parsePeriod(raw) {
  if (!isPlainObject(raw)) bad('invalid card period');
  const preset = raw.preset;
  const month = raw.month ?? null;
  if (!PERIOD_PRESETS.has(preset)) bad('invalid card period');
  if (month !== null && (preset !== 'month' || typeof month !== 'string' || !MONTH_RE.test(month))) {
    bad('invalid card month');
  }
  return { preset, month };
}

function parseCard(raw, seenIds) {
  if (!isPlainObject(raw)) bad('invalid card');
  const { id, type, x, y, w, h } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid card id');
  if (seenIds.has(id)) bad('duplicate card id');
  seenIds.add(id);
  if (!CARD_TYPES.has(type)) bad('unknown card type');
  if (!isInt(w) || w < 1 || w > COLS) bad('invalid card width');
  if (!isInt(x) || x < 0 || x + w > COLS) bad('invalid card column');
  if (!isInt(h) || h < 1 || h > MAX_HEIGHT) bad('invalid card height');
  if (!isInt(y) || y < 0 || y > MAX_ROW) bad('invalid card row');
  const settings = raw.settings ?? {};
  if (!isPlainObject(settings)) bad('invalid card settings');
  if (JSON.stringify(settings).length > MAX_SETTINGS_CHARS) bad('card settings too large');
  const color = raw.color ?? null;
  if (color !== null && !CARD_COLORS.has(color)) bad('invalid card color');
  return { id, type, x, y, w, h, settings, period: parsePeriod(raw.period), color };
}

function parseLayout(raw, seenLayoutIds) {
  if (!isPlainObject(raw)) bad('invalid layout');
  const { id, cards } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid layout id');
  if (seenLayoutIds.has(id)) bad('duplicate layout id');
  seenLayoutIds.add(id);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > MAX_NAME) bad('invalid layout name');
  if (!Array.isArray(cards)) bad('cards must be an array');
  if (cards.length > MAX_CARDS) bad('too many cards');
  // Card ids are unique within a layout; two layouts may each hold a copy.
  const seenCardIds = new Set();
  return { id, name, cards: cards.map((c) => parseCard(c, seenCardIds)) };
}

/** A stored row's cards. The CHECK constraint keeps the column valid JSON, so
 *  this only guards against a row edited by hand into something that is JSON
 *  but not a list. */
function readCards(text) {
  try {
    const cards = JSON.parse(text);
    return Array.isArray(cards) ? cards : [];
  } catch {
    return [];
  }
}

function readState(db) {
  const layouts = db
    .prepare('SELECT id, name, cards FROM dashboard_layouts ORDER BY position, id')
    .all()
    .map((r) => ({ id: r.id, name: r.name, cards: readCards(r.cards) }));
  const stored = db.prepare('SELECT value FROM app_settings WHERE "key" = ?').get(ACTIVE_KEY);
  // A stored tab that no longer exists falls back to the first, the same answer
  // the page gives a database that never stored one.
  const active = layouts.some((l) => l.id === stored?.value) ? stored.value : (layouts[0]?.id ?? null);
  return { active, layouts };
}

function get(ctx) {
  return readState(ctx.db());
}

function put(ctx, { body }) {
  const db = ctx.db();
  const data = body || {};
  if (!Array.isArray(data.layouts)) bad('layouts must be an array');
  if (data.layouts.length > MAX_LAYOUTS) bad('too many layouts');
  const seenLayoutIds = new Set();
  const layouts = data.layouts.map((l) => parseLayout(l, seenLayoutIds));
  const active = layouts.some((l) => l.id === data.active) ? data.active : (layouts[0]?.id ?? null);

  const insert = db.prepare(
    'INSERT INTO dashboard_layouts (id, name, position, cards) VALUES (?, ?, ?, ?)'
  );
  db.transaction(() => {
    db.prepare('DELETE FROM dashboard_layouts').run();
    layouts.forEach((l, i) => insert.run(l.id, l.name, i, JSON.stringify(l.cards)));
    if (active === null) {
      db.prepare('DELETE FROM app_settings WHERE "key" = ?').run(ACTIVE_KEY);
    } else {
      db.prepare(
        `INSERT INTO app_settings ("key", value) VALUES (?, ?)
         ON CONFLICT("key") DO UPDATE SET value = excluded.value`
      ).run(ACTIVE_KEY, active);
    }
  })();

  return { ok: true, ...readState(db) };
}

const routes = [
  ['GET', '/api/dashboard', get],
  ['PUT', '/api/dashboard', put],
];

module.exports = { routes, CARD_TYPES, PERIOD_PRESETS };
