'use strict';

// Idempotent default seeding — port of bootstrap.seed_defaults + the seed
// tuples from config.py. Safe to run on every startup and after a New Database
// reset: each tracker is only seeded when still empty, and categories are
// filled in by key so a partially-populated DB is completed, not duplicated.

const { SYSTEM_CATEGORY_KEYS, insertPos } = require('./services/categories');

// (key, name, cat_type, position)
//
// The default category set: a standard personal-finance taxonomy shipped with a
// new database. Users can add their own categories (POST /api/categories) and
// rename or delete these — keys are stable slugs, so a rename does not break
// references. The built-in import categorizer (services/merchantCategories.js)
// targets these keys; broad buckets here (a single Food bucket for groceries and
// restaurants, a dedicated Insurance/Travel category) raise the share of rows
// auto-categorization can fill. The two uncat_* buckets are system buckets
// (NULL-category sums) — see handlers/incomeExpenses.js NULL_SYNC_KEYS — and
// must not be removed.
const DEFAULT_CATEGORIES = [
  ['income',         'Primary Income',      'income',    0],
  ['other_income',   'Other Income',        'income',    1],
  ['uncat_income',   'Uncategorized',       'income',    2],
  ['rent',           'Rent / Mortgage',     'expense',   3],
  ['utilities',      'Utilities',           'expense',   4],
  ['food',           'Food',                'expense',   5],
  ['automobile',     'Auto & Transport',    'expense',   6],
  ['health',         'Health & Wellness',   'expense',   7],
  ['entertainment',  'Entertainment',       'expense',   8],
  ['shopping',       'Shopping',            'expense',   9],
  ['travel',         'Travel',              'expense',   10],
  ['insurance',      'Insurance',           'expense',   11],
  ['general',        'General',             'expense',   12],
  ['uncat_expense',  'Uncategorized',       'expense',   13],
  // Transfers: money moved between the user's own accounts (savings, brokerage).
  // Excluded from every income/spend surface. Keys are unchanged so the import
  // categorizer's merchant lexicon (which targets these keys) still maps here.
  //
  // Two buckets, not three: a separate Emergency Fund row split saving by
  // PURPOSE, a distinction the ledger cannot derive and most users do not draw,
  // since the destination account is the same either way. It can be re-added as
  // a custom category. (Renamed 2026-07-25; `savings` and `investing` keep their
  // keys, so the lexicon and the trained classifier are unaffected.)
  ['savings',        'Savings',             'transfer',  14],
  ['investing',      'Investing',           'transfer',  15],
];

// (key, label, col_type, position)
//
// The starter accounts. Unlike the category taxonomy above, these are seeded
// HIDDEN (see balance_columns.hidden): account names are specific to each user,
// so there is no useful default, and five generic columns nobody chose would
// fill the Balance Sheet with unused rows. They exist only as stably-keyed,
// pre-named CHOICES for onboarding and the import account picker ("Which account
// is this from?"), and each appears in the app once adopted. A user can also
// create an account with any name, which is visible immediately; this list is a
// shortcut, not a limit (two checking accounts are allowed).
// Positions keep each col_type's run contiguous, in typeOrder — the invariant
// yearTable.insertPos maintains and the Balance Sheet groups by. Presentation
// order in the onboarding picker is a separate concern (Credit Card is one of
// the most-imported accounts but sorts last here, under debt).
const DEFAULT_BALANCE_COLUMNS = [
  ['checking',    'Checking',    'cash',       0],
  ['savings',     'Savings',     'cash',       1],
  ['investments', 'Investments', 'investment', 2],
  ['retirement',  'Retirement',  'retirement', 3],
  ['credit_card', 'Credit Card', 'debt',       4],
  ['debt',        'Loan',        'debt',       5],
];

const DEFAULT_APP_SETTINGS = { tx_auto_match: 'on' };

function seedDefaults(db) {
  const year = new Date().getFullYear();

  if (!db.prepare('SELECT 1 FROM active_years LIMIT 1').get()) {
    db.prepare('INSERT INTO active_years (year) VALUES (?)').run(year);
  }

  // The default taxonomy seeds only into an EMPTY table, like every other
  // tracker in this function. Re-filling by key on every open would re-create
  // defaults the user deleted, and re-insert them at their original seed
  // position, colliding with whatever occupies it now. A delete must persist
  // across relaunch, so a non-empty table is left alone.
  if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
    const insCat = db.prepare(
      'INSERT INTO categories ("key", name, cat_type, position) VALUES (?, ?, ?, ?)'
    );
    for (const [key, name, catType, pos] of DEFAULT_CATEGORIES) {
      insCat.run(key, name, catType, pos);
    }
  }

  // System buckets (the two uncat_* rows) are the one exception: they are
  // required (NULL-category sums — without the row the Uncategorized column
  // disappears from Cash Flow), so a DB written before the API lock existed gets
  // them re-created if deleted, and repaired if renamed or re-typed. Applied
  // here at the storage boundary, on every open, so every read path gets the
  // canonical rows. Position is not repaired: reordering is allowed.
  const healCat = db.prepare(
    'UPDATE categories SET name = ?, cat_type = ? WHERE "key" = ? AND (name != ? OR cat_type != ?)'
  );
  for (const [key, name, catType] of DEFAULT_CATEGORIES) {
    if (!SYSTEM_CATEGORY_KEYS.has(key)) continue;
    if (db.prepare('SELECT 1 FROM categories WHERE "key" = ?').get(key)) {
      healCat.run(name, catType, key, name, catType);
    } else {
      const pos = insertPos(db, catType);
      db.prepare('UPDATE categories SET position = position + 1 WHERE position >= ?').run(pos);
      db.prepare(
        'INSERT INTO categories ("key", name, cat_type, position) VALUES (?, ?, ?, ?)'
      ).run(key, name, catType, pos);
    }
  }

  if (!db.prepare('SELECT 1 FROM balance_active_years LIMIT 1').get()) {
    db.prepare('INSERT INTO balance_active_years (year) VALUES (?)').run(year);
  }
  // Seeded hidden (hidden = 1) — the starter accounts are offered as choices in
  // onboarding and the import picker, and each becomes a real, visible account
  // only when the user adopts it. A fresh Balance Sheet therefore starts with no
  // columns at all rather than five the user never chose.
  if (!db.prepare('SELECT 1 FROM balance_columns LIMIT 1').get()) {
    const insCol = db.prepare(
      'INSERT INTO balance_columns ("key", label, col_type, position, hidden) VALUES (?, ?, ?, ?, 1)'
    );
    for (const [key, label, colType, pos] of DEFAULT_BALANCE_COLUMNS) {
      insCol.run(key, label, colType, pos);
    }
  }

  if (!db.prepare('SELECT 1 FROM portfolio_accounts LIMIT 1').get()) {
    db.prepare('INSERT INTO portfolio_accounts (name) VALUES (?)').run('My Portfolio');
  }

  const hasSetting = db.prepare('SELECT 1 FROM app_settings WHERE "key" = ?');
  const insSetting = db.prepare('INSERT INTO app_settings ("key", value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_APP_SETTINGS)) {
    if (!hasSetting.get(k)) insSetting.run(k, v);
  }
}

module.exports = {
  seedDefaults,
  DEFAULT_CATEGORIES,
  DEFAULT_BALANCE_COLUMNS,
  DEFAULT_APP_SETTINGS,
};
