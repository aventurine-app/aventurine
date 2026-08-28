'use strict';

// Onboarding state — whether the Dashboard leads with first-run setup: does
// this database hold any user data?
//
// "Fresh" is computed from DATA, not from a flag: a database is fresh while it
// holds no transactions, no Balance Sheet or Cash Flow cells, no portfolio
// holdings, and no adopted accounts. So the first-run experience never appears
// for a user who has real data, and a mis-set flag cannot hide it permanently
// (it reappears until the user adds data or skips it). The one stored bit is
// the explicit skip (app_settings.onboarding_dismissed), which hides the
// invitation and changes nothing else.

const TOUCHED_BY_USER = [
  'SELECT 1 FROM transactions LIMIT 1',
  'SELECT 1 FROM balance_entries LIMIT 1',
  'SELECT 1 FROM entries LIMIT 1',
  'SELECT 1 FROM portfolio_entries LIMIT 1',
  // An adopted account is the footprint of a completed import even if its rows
  // were later deleted, so it counts as "this user has been here".
  'SELECT 1 FROM balance_columns WHERE hidden = 0 LIMIT 1',
];

function get(ctx) {
  const db = ctx.db();
  const fresh = !TOUCHED_BY_USER.some((sql) => db.prepare(sql).get());
  const dismissed =
    db.prepare('SELECT value FROM app_settings WHERE "key" = ?').get('onboarding_dismissed')
      ?.value === 'on';
  return { fresh, dismissed };
}

const routes = [['GET', '/api/onboarding', get]];

module.exports = { routes };
