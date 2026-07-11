'use strict';

// App-settings blueprint — port of routes/app_settings.py. Keys the API may
// read/write are allowlisted so unrelated rows are never exposed or corrupted.

const { bad } = require('../validate');

const ALLOWED_KEYS = new Set(['tx_auto_match']);

const VALID_VALUES = {
  tx_auto_match: ['on', 'off'],
};

const DEFAULTS = { tx_auto_match: 'on' };

function get(ctx) {
  const db = ctx.db();
  const placeholders = [...ALLOWED_KEYS].map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT "key", value FROM app_settings WHERE "key" IN (${placeholders})`)
    .all(...ALLOWED_KEYS);
  const result = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // Fill in defaults for any key not yet seeded (e.g. pre-migration DB).
  for (const [k, v] of Object.entries(DEFAULTS)) result[k] ??= v;
  return result;
}

function put(ctx, { params, body }) {
  const db = ctx.db();
  const key = params.key;
  if (!ALLOWED_KEYS.has(key)) bad('unknown setting key', 404);
  const value = (body || {}).value;
  if (typeof value !== 'string') bad('value must be a string');
  const allowed = VALID_VALUES[key];
  if (allowed && !allowed.includes(value)) {
    bad(`invalid value; allowed: ${allowed.join(', ')}`);
  }
  db.prepare(
    `INSERT INTO app_settings ("key", value) VALUES (?, ?)
     ON CONFLICT("key") DO UPDATE SET value = excluded.value`
  ).run(key, value);
  return { ok: true, key, value };
}

const routes = [
  ['GET', '/api/app-settings', get],
  ['PUT', '/api/app-settings/<key>', put],
];

module.exports = { routes };
