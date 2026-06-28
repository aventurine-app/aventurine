'use strict';

// Idempotent default seeding — port of bootstrap.seed_defaults + the seed
// tuples from config.py. Safe to run on every startup and after a New Database
// reset: each tracker is only seeded when still empty, and categories are
// filled in by key so a partially-populated DB is completed, not duplicated.

// (key, name, cat_type, position, flex_type)
//
// The canonical category set: a recognizable, standard personal-finance taxonomy
// shipped by default. Users layer their own categories on top (POST /api/categories)
// and may rename/delete these — keys are stable slugs, so renames don't break
// references. The built-in import categorizer (services/merchantCategories.js)
// targets these keys; finer buckets here (groceries vs. dining, a real Insurance/
// Travel category) directly raise auto-categorization usefulness. The two
// uncat_* buckets are system buckets (NULL-category sums) — see
// handlers/incomeExpenses.js NULL_SYNC_KEYS — and must not be removed.
//
// flex_type seeds the spend character used by budgeting features: the two
// contractual bills (rent, insurance) are 'fixed', every savings/investing
// bucket is a 'goal', and the rest default to 'flex'. The user can change any of
// these per category. (Income has no cost character; it carries the neutral
// 'flex' default.)
const DEFAULT_CATEGORIES = [
  ['income',         'Primary Income',      'income',    0,  'flex'],
  ['other_income',   'Other Income',        'income',    1,  'flex'],
  ['uncat_income',   'Uncategorized',       'income',    2,  'flex'],
  ['rent',           'Rent / Mortgage',     'expense',   3,  'fixed'],
  ['utilities',      'Utilities',           'expense',   4,  'flex'],
  ['groceries',      'Groceries',           'expense',   5,  'flex'],
  ['dining',         'Dining & Restaurants','expense',   6,  'flex'],
  ['automobile',     'Auto & Transport',    'expense',   7,  'flex'],
  ['health',         'Health & Wellness',   'expense',   8,  'flex'],
  ['entertainment',  'Entertainment',       'expense',   9,  'flex'],
  ['shopping',       'Shopping',            'expense',   10, 'flex'],
  ['travel',         'Travel',              'expense',   11, 'flex'],
  ['insurance',      'Insurance',           'expense',   12, 'fixed'],
  ['general',        'General',             'expense',   13, 'flex'],
  ['uncat_expense',  'Uncategorized',       'expense',   14, 'flex'],
  ['savings',        'Primary Savings',     'savings',   15, 'goal'],
  ['emergency_fund', 'Emergency Fund',      'savings',   16, 'goal'],
  ['investing',      'Investment Account',  'investing', 17, 'goal'],
];

// (key, label, col_type, position)
const DEFAULT_BALANCE_COLUMNS = [
  ['checking',    'Checking',    'cash',       0],
  ['savings',     'Savings',     'cash',       1],
  ['investments', 'Investments', 'investment', 2],
  ['retirement',  'Retirement',  'retirement', 3],
  ['debt',        'Debt',        'debt',       4],
];

const DEFAULT_APP_SETTINGS = { tx_fuzzy_threshold: '1' };

function seedDefaults(db) {
  const year = new Date().getFullYear();

  if (!db.prepare('SELECT 1 FROM active_years LIMIT 1').get()) {
    db.prepare('INSERT INTO active_years (year) VALUES (?)').run(year);
  }

  const existingKeys = new Set(
    db.prepare('SELECT "key" FROM categories').all().map((r) => r.key)
  );
  const insCat = db.prepare(
    'INSERT INTO categories ("key", name, cat_type, position, flex_type) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [key, name, catType, pos, flexType] of DEFAULT_CATEGORIES) {
    if (!existingKeys.has(key)) {
      insCat.run(key, name, catType, pos, flexType);
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
