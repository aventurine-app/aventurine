'use strict';

// Authoritative baseline schema for a fresh Oliv database. This is the single
// source of truth for the shape a new DB is created with; future schema changes
// add numbered migrations in migrate.js that climb from SCHEMA_VERSION.
//
// Two audiences read this schema: the app, and a user who opens their own DB in
// any SQLite tool. For that second audience the DDL is deliberately
// self-describing:
//   - table/column comments are written INSIDE each statement, so SQLite keeps
//     them verbatim in sqlite_schema (`.schema` shows them to an external user);
//   - CHECK constraints document the valid enum/range domains;
//   - FOREIGN KEY clauses document the relationships. The engine runs with
//     foreign_keys OFF (see db.js) — referential rules are enforced by the
//     handlers — so the declared FKs are advisory: they let tools draw the
//     relationship graph but do not constrain writes at runtime;
//   - the v_* views pre-join the normalized tables into human-readable,
//     chronologically-sortable shapes for ad-hoc querying.

const SCHEMA_VERSION = 6;

// Months persist as 1-12 integers so `ORDER BY year, month` sorts
// chronologically (the app translates to/from English names at its API
// boundary — see validate.monthNumber/monthName). MONTH_NAMES (mirrors
// validate.VALID_MONTHS, kept standalone so this file stays pure DDL) drives
// the human-readable month_name column the views expose.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// A CASE expression mapping a 1-12 month column back to its English name, for
// the readable month_name column in the views.
function monthNameCase(col) {
  const arms = MONTH_NAMES.map((m, i) => `          WHEN ${i + 1} THEN '${m}'`).join('\n');
  return `CASE ${col}\n${arms}\n        END`;
}

const DDL = [
  `CREATE TABLE active_years (
     -- Years shown as tabs in Cash Flow.
     year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
     PRIMARY KEY (year)
   )`,
  `CREATE TABLE app_settings (
     -- Key/value application preferences (e.g. tx_fuzzy_threshold).
     "key" VARCHAR(64) NOT NULL,
     value TEXT DEFAULT '' NOT NULL,
     PRIMARY KEY ("key")
   )`,
  `CREATE TABLE balance_active_years (
     -- Years shown as tabs in the Balance Sheet.
     year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
     PRIMARY KEY (year)
   )`,
  `CREATE TABLE balance_columns (
     -- User-defined Balance Sheet accounts (the columns). "key" is a stable slug
     -- referenced by balance_entries.category; col_type groups the accounts.
     id INTEGER NOT NULL,
     "key" VARCHAR(50) NOT NULL,
     label VARCHAR(100) NOT NULL,
     col_type VARCHAR(20) NOT NULL
       CHECK (col_type IN ('cash', 'investment', 'retirement', 'debt')),
     position INTEGER NOT NULL,
     PRIMARY KEY (id),
     UNIQUE ("key")
   )`,
  `CREATE TABLE balance_entries (
     -- One value per (year, month, account) cell of the Balance Sheet.
     -- category is a balance_columns."key". value MAY be negative (debt, a
     -- negative net-worth line, etc.) so it carries no sign CHECK.
     id INTEGER NOT NULL,
     year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
     month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
     category VARCHAR(50) NOT NULL,
     value FLOAT NOT NULL,
     PRIMARY KEY (id),
     CONSTRAINT uq_balance_entry UNIQUE (year, month, category),
     FOREIGN KEY (category) REFERENCES balance_columns ("key")
   )`,
  `CREATE TABLE categories (
     -- Cash Flow / transaction categories. "key" is a stable slug referenced by
     -- entries.category, category_sync.category and budget_targets.category (so
     -- those survive renames). cat_type is the category's direction and owns the
     -- tx_type of every transaction linked to it. flex_type is the spend
     -- character — a fixed cost, a flexible cost, or a savings/investing goal —
     -- carried on the category for budgeting features to key off.
     id INTEGER NOT NULL,
     "key" VARCHAR(50) NOT NULL,
     name VARCHAR(100) NOT NULL,
     cat_type VARCHAR(20) NOT NULL
       CHECK (cat_type IN ('income', 'expense', 'savings', 'investing')),
     position INTEGER DEFAULT 0 NOT NULL,
     flex_type VARCHAR(20) DEFAULT 'flex' NOT NULL
       CHECK (flex_type IN ('fixed', 'flex', 'goal')),
     PRIMARY KEY (id),
     UNIQUE ("key")
   )`,
  `CREATE TABLE category_sync (
     -- Per-(year, category) membership: a row means this category's Cash Flow
     -- values for that year are computed from transactions instead of
     -- hand-entered. category is a categories."key", so it survives renames.
     year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
     category VARCHAR(50) NOT NULL,
     PRIMARY KEY (year, category),
     FOREIGN KEY (category) REFERENCES categories ("key")
   )`,
  `CREATE TABLE credit_cards (
     -- Tracked credit cards. category_id optionally links a card to the spend
     -- category it is paid from.
     id INTEGER NOT NULL,
     name VARCHAR(100) NOT NULL,
     credit_limit FLOAT NOT NULL,
     rewards_pct FLOAT NOT NULL,
     annual_fee FLOAT NOT NULL,
     category_id INTEGER,
     PRIMARY KEY (id),
     FOREIGN KEY (category_id) REFERENCES categories (id)
   )`,
  `CREATE TABLE entries (
     -- One value per (year, month, category) cell of Cash Flow. category is a
     -- categories."key". value MAY be negative (manual adjustments), so no sign
     -- CHECK. A cell whose (year, category) is in category_sync is computed from
     -- transactions and ignores any stored value here.
     id INTEGER NOT NULL,
     year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
     month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
     category VARCHAR(50) NOT NULL,
     value FLOAT NOT NULL,
     PRIMARY KEY (id),
     CONSTRAINT uq_entry UNIQUE (year, month, category),
     FOREIGN KEY (category) REFERENCES categories ("key")
   )`,
  `CREATE TABLE match_rules (
     -- Learned auto-categorization: a normalized description (pattern) maps to a
     -- category. Upserted when the user categorizes; applied on import/create.
     id INTEGER NOT NULL,
     pattern VARCHAR(200) NOT NULL,
     category_id INTEGER NOT NULL,
     PRIMARY KEY (id),
     FOREIGN KEY (category_id) REFERENCES categories (id)
   )`,
  `CREATE TABLE portfolio_accounts (
     -- Named investment accounts holding portfolio_entries.
     id INTEGER NOT NULL,
     name VARCHAR(100) NOT NULL,
     PRIMARY KEY (id)
   )`,
  `CREATE TABLE portfolio_entries (
     -- One holding within an account. amount = units held, price = cost basis
     -- per unit, market_price = latest price per unit. These money fields are
     -- exempt from cent-rounding (see validate.round2), hence no sign CHECK.
     id INTEGER NOT NULL,
     account_id INTEGER NOT NULL,
     ticker VARCHAR(20) NOT NULL,
     asset_name VARCHAR(100) NOT NULL,
     amount FLOAT NOT NULL,
     price FLOAT NOT NULL,
     market_price FLOAT NOT NULL,
     PRIMARY KEY (id),
     FOREIGN KEY (account_id) REFERENCES portfolio_accounts (id)
   )`,
  `CREATE TABLE transactions (
     -- The transaction ledger. category_id NULL means uncategorized. amount is a
     -- positive magnitude in dollars (rounded to cents at write); direction is
     -- tx_type, which for a categorized row mirrors the category's cat_type.
     id INTEGER NOT NULL,
     date DATE NOT NULL,                                    -- ISO 'YYYY-MM-DD'
     description VARCHAR(200) DEFAULT '' NOT NULL,
     category_id INTEGER,
     amount FLOAT DEFAULT 0 NOT NULL CHECK (amount >= 0),
     notes VARCHAR(500) DEFAULT '' NOT NULL,
     tx_type VARCHAR(10) DEFAULT 'expense' NOT NULL
       CHECK (tx_type IN ('income', 'expense', 'savings', 'investing')),
     PRIMARY KEY (id),
     FOREIGN KEY (category_id) REFERENCES categories (id)
   )`,
  `CREATE TABLE forecast_planned (
     -- Planned one-off future income/expenses for the Cash Flow Forecast.
     -- amount is a positive magnitude; flow decides its sign in the projection.
     id INTEGER NOT NULL,
     label VARCHAR(100) NOT NULL,
     amount FLOAT NOT NULL CHECK (amount >= 0),
     flow VARCHAR(10) NOT NULL CHECK (flow IN ('income', 'expense')),
     date DATE NOT NULL,                                    -- ISO 'YYYY-MM-DD'
     PRIMARY KEY (id)
   )`,
  `CREATE TABLE budget_amounts (
     -- Budget envelopes: ONE recurring monthly target per category, applied to
     -- every month (not stored per-month). category is a categories."key" (an
     -- expense/savings/investing category) and is the primary key, so a category
     -- has at most one budget. Actual spend is computed from transactions per
     -- month at read time, never stored here.
     category VARCHAR(50) NOT NULL,
     amount FLOAT NOT NULL CHECK (amount >= 0),
     PRIMARY KEY (category),
     FOREIGN KEY (category) REFERENCES categories ("key")
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

  // ── Convenience views ──────────────────────────────────────────────────────
  // Read-only, pre-joined shapes for users querying the DB directly. They add
  // category/account names, a sortable month_num, an effective direction, and
  // derived valuations — none of which is stored. Safe to drop/recreate.

  `CREATE VIEW v_transactions AS
     -- Every transaction with its category resolved to a name and an effective
     -- direction: a categorized row takes tx_type from the category (so it is
     -- correct even if the stored tx_type predates a category re-type); an
     -- uncategorized row keeps its stored tx_type. signed_amount is a cash-flow
     -- convention — income positive, every outflow (expense/savings/investing)
     -- negative.
     SELECT
       t.id,
       t.date,
       t.description,
       t.amount,
       COALESCE(c.cat_type, t.tx_type) AS tx_type,
       CASE WHEN COALESCE(c.cat_type, t.tx_type) = 'income'
            THEN t.amount ELSE -t.amount END AS signed_amount,
       t.category_id,
       c."key" AS category_key,
       c.name  AS category_name,
       t.notes
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id`,

  `CREATE VIEW v_cash_flow AS
     -- Cash Flow manual entries with the category resolved to a name/type.
     -- month is the 1-12 number (sort by year, month); month_name is its label.
     -- Cells whose (year, category) is in category_sync are computed from
     -- transactions and do NOT appear here.
     SELECT
       e.year,
       e.month,
       ${monthNameCase('e.month')} AS month_name,
       e.category AS category_key,
       c.name     AS category_name,
       c.cat_type,
       e.value
     FROM entries e
     LEFT JOIN categories c ON c."key" = e.category`,

  `CREATE VIEW v_balance_sheet AS
     -- Balance Sheet entries with the account resolved to a label/type.
     -- month is the 1-12 number (sort by year, month); month_name is its label.
     SELECT
       b.year,
       b.month,
       ${monthNameCase('b.month')} AS month_name,
       b.category AS account_key,
       col.label  AS account_label,
       col.col_type,
       b.value
     FROM balance_entries b
     LEFT JOIN balance_columns col ON col."key" = b.category`,

  `CREATE VIEW v_budget AS
     -- Budget envelopes with the category resolved to a name. The target is a
     -- single recurring figure applied to every month. Actual spend is not
     -- stored; aggregate v_transactions by month for actuals.
     SELECT
       t.category AS category_key,
       c.name     AS category_name,
       c.cat_type,
       t.amount   AS target_amount
     FROM budget_amounts t
     LEFT JOIN categories c ON c."key" = t.category`,

  `CREATE VIEW v_portfolio AS
     -- Portfolio holdings with their account name and derived valuation. The
     -- cost_basis / market_value / gain columns are computed at query time.
     SELECT
       p.id,
       p.account_id,
       a.name AS account_name,
       p.ticker,
       p.asset_name,
       p.amount       AS units,
       p.price        AS unit_cost,
       p.market_price AS unit_price,
       p.amount * p.price                        AS cost_basis,
       p.amount * p.market_price                 AS market_value,
       p.amount * (p.market_price - p.price)     AS gain
     FROM portfolio_entries p
     LEFT JOIN portfolio_accounts a ON a.id = p.account_id`,
];

function createBaselineSchema(db) {
  for (const stmt of DDL) db.exec(stmt);
}

module.exports = { SCHEMA_VERSION, createBaselineSchema };
