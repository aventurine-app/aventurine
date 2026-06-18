'use strict';

// Idempotent default seeding — port of bootstrap.seed_defaults + the seed
// tuples from config.py. Safe to run on every startup and after a New Database
// reset: each tracker is only seeded when still empty, and categories are
// filled in by key so a partially-populated DB is completed, not duplicated.

// (key, name, cat_type, position)
const DEFAULT_CATEGORIES = [
  ['income',         'Primary Income',     'income',    0],
  ['other_income',   'Other Income',       'income',    1],
  ['uncat_income',   'Uncategorized',      'income',    2],
  ['rent',           'Rent / Mortgage',    'expense',   3],
  ['utilities',      'Utilities',          'expense',   4],
  ['food',           'Food',               'expense',   5],
  ['automobile',     'Automobile',         'expense',   6],
  ['health',         'Health / Wellness',  'expense',   7],
  ['entertainment',  'Entertainment',      'expense',   8],
  ['general',        'General',            'expense',   9],
  ['uncat_expense',  'Uncategorized',      'expense',   10],
  ['savings',        'Primary Savings',    'savings',   11],
  ['emergency_fund', 'Emergency Fund',     'savings',   12],
  ['investing',      'Investment Account', 'investing', 13],
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
    'INSERT INTO categories ("key", name, cat_type, position) VALUES (?, ?, ?, ?)'
  );
  for (const [key, name, catType, pos] of DEFAULT_CATEGORIES) {
    if (!existingKeys.has(key)) {
      insCat.run(key, name, catType, pos);
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
