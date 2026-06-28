'use strict';

// Schema bootstrap, keyed on `PRAGMA user_version`.
//
//   1. Fresh DB (no app tables) -> create the baseline schema, stamp the version.
//   2. Already initialised        -> run any numbered migrations whose version
//                                     exceeds the DB's stored user_version, then
//                                     re-stamp. Each migration is additive and
//                                     idempotent so a re-run is harmless.

const { SCHEMA_VERSION, createBaselineSchema } = require('./schema');

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

// Numbered, in-place migrations from an existing DB up to SCHEMA_VERSION. Keyed
// by the version they bring the DB TO; each runs only when the stored
// user_version is below its key. Keep them additive + idempotent.
const MIGRATIONS = [
  // v2 — Cash Flow Forecast: planned-items table (see schema.js baseline).
  [2, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS forecast_planned (
       id INTEGER NOT NULL,
       label VARCHAR(100) NOT NULL,
       amount FLOAT NOT NULL,
       flow VARCHAR(10) NOT NULL,
       date DATE NOT NULL,
       PRIMARY KEY (id)
     )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_forecast_planned_date ON forecast_planned (date)');
  }],
  // v3 — Budget Buckets: per-month per-category targets (see schema.js baseline).
  [3, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS budget_targets (
       id INTEGER NOT NULL,
       year INTEGER NOT NULL,
       month VARCHAR(20) NOT NULL,
       category VARCHAR(50) NOT NULL,
       amount FLOAT NOT NULL,
       PRIMARY KEY (id),
       CONSTRAINT uq_budget_target UNIQUE (year, month, category)
     )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_budget_targets_year ON budget_targets (year)');
  }],
  // v4 — Budget Buckets: optional per-month expected-income override.
  [4, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS budget_income (
       year INTEGER NOT NULL,
       month VARCHAR(20) NOT NULL,
       amount FLOAT NOT NULL,
       PRIMARY KEY (year, month)
     )`);
  }],
  // v5 — Categories gain flex_type (fixed cost / flexible cost / goal). ADD
  // COLUMN is not idempotent, so guard on the column already existing (a
  // re-bootstrap, or a fresh DB whose baseline already carries it). New rows
  // default to 'flex'; we seed the existing rows to mirror the fresh-DB intent —
  // savings/investing categories are goals, the standard fixed bills are fixed.
  [5, (db) => {
    const hasCol = db.pragma('table_info(categories)').some((c) => c.name === 'flex_type');
    if (!hasCol) {
      db.exec(`ALTER TABLE categories ADD COLUMN flex_type VARCHAR(20) DEFAULT 'flex' NOT NULL
                 CHECK (flex_type IN ('fixed', 'flex', 'goal'))`);
      db.exec("UPDATE categories SET flex_type = 'goal' WHERE cat_type IN ('savings', 'investing')");
      db.exec("UPDATE categories SET flex_type = 'fixed' WHERE \"key\" IN ('rent', 'insurance')");
    }
  }],
];

function bootstrapSchema(db) {
  if (!tableExists(db, 'active_years')) {
    createBaselineSchema(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  // Already initialised — climb from the stored version to SCHEMA_VERSION.
  let version = Number(db.pragma('user_version', { simple: true })) || 0;
  for (const [target, run] of MIGRATIONS) {
    if (version < target) {
      run(db);
      db.pragma(`user_version = ${target}`);
      version = target;
    }
  }
}

module.exports = { bootstrapSchema, tableExists };
