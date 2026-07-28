'use strict';

// Onboarding state — the one question the Dashboard asks before deciding
// whether to lead with first-run setup: does this database hold anything the
// user put there?
//
// "Fresh" is answered from DATA, not from a flag: a database is fresh while it
// holds no transactions, no Balance Sheet or Cash Flow cells, no portfolio
// holdings, and no adopted accounts. That means the first-run experience cannot
// strand a user who has real data (it never shows), and cannot be permanently
// lost by a mis-set flag (it comes back until they either use the app or say no
// thanks). The single stored bit is the user's explicit "skip"
// (app_settings.onboarding_dismissed), which suppresses the invitation without
// touching anything else.

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
