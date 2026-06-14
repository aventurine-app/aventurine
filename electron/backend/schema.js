'use strict';

// Authoritative baseline schema for a fresh Finance Lab database. This is the
// single source of truth for the shape a new DB is created with; future schema
// changes add numbered migrations in migrate.js that climb from SCHEMA_VERSION.

const SCHEMA_VERSION = 4;

const DDL = [
  `CREATE TABLE active_years (
     year INTEGER NOT NULL,
     PRIMARY KEY (year)
   )`,
  `CREATE TABLE app_settings (
     "key" VARCHAR(64) NOT NULL,
     value TEXT DEFAULT '' NOT NULL,
     PRIMARY KEY ("key")
   )`,
  `CREATE TABLE balance_active_years (
     year INTEGER NOT NULL,
     PRIMARY KEY (year)
   )`,
  `CREATE TABLE balance_columns (
     id INTEGER NOT NULL,
     "key" VARCHAR(50) NOT NULL,
     label VARCHAR(100) NOT NULL,
     col_type VARCHAR(20) NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (id),
     UNIQUE ("key")
   )`,
  `CREATE TABLE balance_entries (
     id INTEGER NOT NULL,
     year INTEGER NOT NULL,
     month VARCHAR(20) NOT NULL,
     category VARCHAR(50) NOT NULL,
     value FLOAT NOT NULL,
     PRIMARY KEY (id),
     CONSTRAINT uq_balance_entry UNIQUE (year, month, category)
   )`,
  `CREATE TABLE categories (
     id INTEGER NOT NULL,
     "key" VARCHAR(50) NOT NULL,
     name VARCHAR(100) NOT NULL,
     cat_type VARCHAR(20) NOT NULL,
     position INTEGER DEFAULT 0 NOT NULL,
     PRIMARY KEY (id),
     UNIQUE ("key")
   )`,
  // Per-table sync: a row means "this category's Cash Flow values for this year
  // are computed from transactions instead of hand-entered". category is the
  // category KEY (like entries.category), so it survives renames.
  `CREATE TABLE category_sync (
     year INTEGER NOT NULL,
     category VARCHAR(50) NOT NULL,
     PRIMARY KEY (year, category)
   )`,
  `CREATE TABLE credit_cards (
     id INTEGER NOT NULL,
     name VARCHAR(100) NOT NULL,
     credit_limit FLOAT NOT NULL,
     rewards_pct FLOAT NOT NULL,
     annual_fee FLOAT NOT NULL,
     category_id INTEGER,
     PRIMARY KEY (id),
     FOREIGN KEY(category_id) REFERENCES categories (id)
   )`,
  `CREATE TABLE entries (
     id INTEGER NOT NULL,
     year INTEGER NOT NULL,
     month VARCHAR(20) NOT NULL,
     category VARCHAR(50) NOT NULL,
     value FLOAT NOT NULL,
     PRIMARY KEY (id),
     CONSTRAINT uq_entry UNIQUE (year, month, category)
   )`,
  `CREATE TABLE match_rules (
     id INTEGER NOT NULL,
     pattern VARCHAR(200) NOT NULL,
     category_id INTEGER NOT NULL,
     PRIMARY KEY (id),
     FOREIGN KEY(category_id) REFERENCES categories (id)
   )`,
  `CREATE TABLE portfolio_accounts (
     id INTEGER NOT NULL,
     name VARCHAR(100) NOT NULL,
     PRIMARY KEY (id)
   )`,
  `CREATE TABLE portfolio_entries (
     id INTEGER NOT NULL,
     account_id INTEGER NOT NULL,
     ticker VARCHAR(20) NOT NULL,
     asset_name VARCHAR(100) NOT NULL,
     amount FLOAT NOT NULL,
     price FLOAT NOT NULL,
     market_price FLOAT NOT NULL,
     PRIMARY KEY (id),
     FOREIGN KEY(account_id) REFERENCES portfolio_accounts (id)
   )`,
  // FK references categories(id). foreign_keys stays OFF (see db.js) —
  // referential rules are enforced in the handlers, not the engine — so this
  // constraint documents intent rather than being enforced at runtime.
  `CREATE TABLE transactions (
     id INTEGER NOT NULL,
     date DATE NOT NULL,
     description VARCHAR(200) DEFAULT '' NOT NULL,
     category_id INTEGER,
     amount FLOAT DEFAULT 0 NOT NULL,
     notes VARCHAR(500) DEFAULT '' NOT NULL,
     tx_type VARCHAR(10) DEFAULT 'expense' NOT NULL,
     PRIMARY KEY (id),
     FOREIGN KEY(category_id) REFERENCES categories (id)
   )`,
  // Planned items for the Cash Flow Forecast (Reports). One-off or scheduled
  // future income/expenses the user knows about but that the recurring-charge
  // detector can't infer. amount is a positive magnitude (round2 at write);
  // `flow` decides its sign in the projection. date stays 'YYYY-MM-DD'.
  `CREATE TABLE forecast_planned (
     id INTEGER NOT NULL,
     label VARCHAR(100) NOT NULL,
     amount FLOAT NOT NULL,
     flow VARCHAR(10) NOT NULL,
     date DATE NOT NULL,
     PRIMARY KEY (id)
   )`,
  // Budget Buckets (Account Tracking): per-month spending target per category.
  // category is the category KEY (survives renames, like entries.category);
  // budgetable categories are expense/savings/investing. Distinct from the Cash
  // Flow `entries` table and unaffected by per-table sync — budgeting stands on
  // its own. Actuals are computed from transactions at read time.
  `CREATE TABLE budget_targets (
     id INTEGER NOT NULL,
     year INTEGER NOT NULL,
     month VARCHAR(20) NOT NULL,
     category VARCHAR(50) NOT NULL,
     amount FLOAT NOT NULL,
     PRIMARY KEY (id),
     CONSTRAINT uq_budget_target UNIQUE (year, month, category)
   )`,
  // Optional per-month override of the budget's "expected income" figure. When
  // absent, the budget defaults expected income to the trailing-average monthly
  // income from transactions (see handlers/budget.js). One row per month.
  `CREATE TABLE budget_income (
     year INTEGER NOT NULL,
     month VARCHAR(20) NOT NULL,
     amount FLOAT NOT NULL,
     PRIMARY KEY (year, month)
   )`,
  `CREATE INDEX ix_balance_entries_year ON balance_entries (year)`,
  `CREATE INDEX ix_credit_cards_category_id ON credit_cards (category_id)`,
  `CREATE INDEX ix_entries_year ON entries (year)`,
  `CREATE INDEX ix_match_rules_category_id ON match_rules (category_id)`,
  `CREATE UNIQUE INDEX ix_match_rules_pattern ON match_rules (pattern)`,
  `CREATE INDEX ix_portfolio_entries_account_id ON portfolio_entries (account_id)`,
  `CREATE INDEX ix_transactions_category_id ON transactions (category_id)`,
  `CREATE INDEX ix_transactions_date ON transactions (date)`,
  `CREATE INDEX ix_forecast_planned_date ON forecast_planned (date)`,
  `CREATE INDEX ix_budget_targets_year ON budget_targets (year)`,
];

function createBaselineSchema(db) {
  for (const stmt of DDL) db.exec(stmt);
}

module.exports = { SCHEMA_VERSION, createBaselineSchema };
