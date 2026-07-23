'use strict';

// Idempotent default seeding — port of bootstrap.seed_defaults + the seed
// tuples from config.py. Safe to run on every startup and after a New Database
// reset: each tracker is only seeded when still empty, and categories are
// filled in by key so a partially-populated DB is completed, not duplicated.

const { SYSTEM_CATEGORY_KEYS, insertPos } = require('./services/categories');

// (key, name, cat_type, position)
//
// The canonical category set: a recognizable, standard personal-finance taxonomy
// shipped by default. Users layer their own categories on top (POST /api/categories)
// and may rename/delete these — keys are stable slugs, so renames don't break
// references. The built-in import categorizer (services/merchantCategories.js)
// targets these keys; recognizable buckets here (a single Food bucket for
// groceries + restaurants, a real Insurance/Travel category) directly raise
// auto-categorization usefulness. The two
// uncat_* buckets are system buckets (NULL-category sums) — see
// handlers/incomeExpenses.js NULL_SYNC_KEYS — and must not be removed.
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
  // categorizer's merchant lexicon (which targets these keys) keeps landing here.
  ['savings',        'Primary Savings',     'transfer',  14],
  ['emergency_fund', 'Emergency Fund',      'transfer',  15],
  ['investing',      'Investment Account',  'transfer',  16],
];

// (key, label, col_type, position)
const DEFAULT_BALANCE_COLUMNS = [
  ['checking',    'Checking',    'cash',       0],
  ['savings',     'Savings',     'cash',       1],
  ['investments', 'Investments', 'investment', 2],
  ['retirement',  'Retirement',  'retirement', 3],
  ['debt',        'Debt',        'debt',       4],
];

const DEFAULT_APP_SETTINGS = { tx_auto_match: 'on' };

function seedDefaults(db) {
  const year = new Date().getFullYear();

  if (!db.prepare('SELECT 1 FROM active_years LIMIT 1').get()) {
    db.prepare('INSERT INTO active_years (year) VALUES (?)').run(year);
  }

  // The default taxonomy seeds only into an EMPTY table — a starting template,
  // like every other tracker in this function. Re-filling by key on every open
  // would resurrect defaults the user deliberately deleted (and re-insert them
  // at their original seed position, colliding with whatever sits there now).
  // A delete must survive relaunch: the user owns a non-empty table.
  if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
    const insCat = db.prepare(
      'INSERT INTO categories ("key", name, cat_type, position) VALUES (?, ?, ?, ?)'
    );
    for (const [key, name, catType, pos] of DEFAULT_CATEGORIES) {
      insCat.run(key, name, catType, pos);
    }
  }

  // System buckets (the two uncat_* rows) are the one exception: they're
  // load-bearing (NULL-category sums — without the row the Uncategorized
  // column vanishes from Cash Flow), so a DB written before the API lock
  // existed gets them re-created if deleted, and healed if renamed/re-typed.
  // Enforced here at the storage boundary, on every open, so every read path
  // sees the canonical rows. Position is not healed: reordering is allowed.
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
  if (!db.prepare('SELECT 1 FROM balance_columns LIMIT 1').get()) {
    const insCol = db.prepare(
      'INSERT INTO balance_columns ("key", label, col_type, position) VALUES (?, ?, ?, ?)'
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
