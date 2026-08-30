'use strict';

// Foundation tests for the data layer (db / migrate / seed). Run on host Node,
// no Electron needed:  flatpak-spawn --host npx --prefix electron node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');

const { connect, verifyKey } = require('../db');
const { bootstrapSchema, tableExists, SchemaTooNewError, MIGRATIONS } = require('../migrate');
const { seedDefaults } = require('../seed');
const { SCHEMA_VERSION, DDL } = require('../schema');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-test-'));
  return path.join(dir, 'finance.db');
}

test('fresh DB: baseline schema + seed', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);

  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);

  const cats = db.prepare('SELECT * FROM categories ORDER BY position').all();
  assert.equal(cats.length, 16, 'sixteen default categories');
  // The transfer block is two buckets — Emergency Fund was folded into Savings.
  assert.deepStrictEqual(
    cats.filter((c) => c.cat_type === 'transfer').map((c) => [c.key, c.name]),
    [['savings', 'Savings'], ['investing', 'Investing']]
  );

  const yr = new Date().getFullYear();
  assert.ok(db.prepare('SELECT 1 FROM active_years WHERE year=?').get(yr));
  assert.ok(db.prepare('SELECT 1 FROM balance_active_years WHERE year=?').get(yr));
  // Six starter accounts, every one of them HIDDEN: they exist as pre-named
  // choices for onboarding / the import picker, and none is on the user's
  // Balance Sheet until an import adopts it.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM balance_columns').get().c, 6);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM balance_columns WHERE hidden = 1').get().c, 6);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM portfolio_accounts').get().c, 1);
  assert.equal(
    db.prepare('SELECT value FROM app_settings WHERE "key"=?').get('tx_auto_match').value,
    'on'
  );

  for (const t of ['active_years', 'app_settings', 'balance_entries', 'categories',
    'credit_cards', 'entries', 'match_rules', 'portfolio_accounts',
    'portfolio_entries', 'transactions', 'forecast_planned', 'budget_amounts']) {
    assert.ok(tableExists(db, t), `table ${t} present`);
  }
  // Retired in v9 — a fresh DB must not carry the per-category sync table.
  assert.ok(!tableExists(db, 'category_sync'), 'category_sync absent');
  db.close();
});

test('seed is idempotent', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  seedDefaults(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 16);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM portfolio_accounts').get().c, 1);
  db.close();
});

test('seed does not resurrect a deleted default category', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // The user deletes a seeded category; reopening the DB (which re-runs
  // seedDefaults) must NOT bring it back — defaults are a starting template,
  // not an enforced set.
  db.prepare('DELETE FROM categories WHERE "key" = ?').run('food');
  seedDefaults(db);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE "key" = ?').get('food'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 15);
  db.close();
});

test('seed re-creates a missing system bucket at the end of its type block', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // A pre-lock DB could have deleted an uncat_* row. Unlike ordinary defaults,
  // the system buckets are load-bearing (NULL-category sums) and must come back.
  // Mirror what the old API delete did: remove the row AND compact positions.
  const old = db.prepare('SELECT position FROM categories WHERE "key" = ?').get('uncat_expense');
  db.prepare('DELETE FROM categories WHERE "key" = ?').run('uncat_expense');
  db.prepare('UPDATE categories SET position = position - 1 WHERE position > ?').run(old.position);
  seedDefaults(db);

  const uncat = db.prepare('SELECT * FROM categories WHERE "key" = ?').get('uncat_expense');
  assert.equal(uncat.name, 'Uncategorized');
  assert.equal(uncat.cat_type, 'expense');
  // Re-inserted at the end of the expense block: positions stay unique and
  // dense, and type blocks stay contiguous.
  const cats = db.prepare('SELECT cat_type, position FROM categories ORDER BY position').all();
  assert.deepEqual(cats.map((c) => c.position), cats.map((_, i) => i));
  const runs = cats.map((c) => c.cat_type).filter((tp, i, a) => i === 0 || tp !== a[i - 1]);
  assert.deepEqual(runs, ['income', 'expense', 'transfer']);
  db.close();
});

test('seed heals a drifted system bucket (name + type), leaves the rest alone', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // A DB written before the uncat_* lock existed can hold a renamed or re-typed
  // system bucket (observed case: "UNc"). Seeding on open must restore the
  // canonical row, without modifying user-created rows or the position.
  db.prepare(
    "UPDATE categories SET name = 'UNc', cat_type = 'income', position = 99 WHERE \"key\" = 'uncat_expense'"
  ).run();
  db.prepare("UPDATE categories SET name = 'Eating Out' WHERE \"key\" = 'food'").run();

  seedDefaults(db);

  const uncat = db.prepare('SELECT * FROM categories WHERE "key" = ?').get('uncat_expense');
  assert.equal(uncat.name, 'Uncategorized');
  assert.equal(uncat.cat_type, 'expense');
  assert.equal(uncat.position, 99); // reordering system buckets is allowed
  // User renames of ordinary categories survive.
  assert.equal(
    db.prepare('SELECT name FROM categories WHERE "key" = ?').get('food').name,
    'Eating Out'
  );
  db.close();
});

test('bootstrapSchema is a no-op on an already-initialised DB', () => {
  const p = tmpFile();
  const db = connect(p);
  bootstrapSchema(db);
  seedDefaults(db);
  // Drop a category so we can prove a second bootstrap does NOT recreate the
  // baseline (which would re-add tables / reset state).
  db.prepare("DELETE FROM categories WHERE \"key\" = 'food'").run();
  bootstrapSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 15);
  db.close();
});

test('v8 migration adds transactions.display_name and refreshes v_transactions', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // Revert to the v7 shape: no display_name column, view without it. (The view
  // must be dropped first — SQLite refuses to drop a column a view references.)
  db.exec('DROP VIEW v_transactions');
  db.exec('ALTER TABLE transactions DROP COLUMN display_name');
  db.pragma('user_version = 7');

  bootstrapSchema(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(db.pragma('table_info(transactions)').some((c) => c.name === 'display_name'));
  db.prepare(
    "INSERT INTO transactions (date, description, display_name) VALUES ('2026-07-01', 'SQ *CAFE 42', 'Cafe')"
  ).run();
  assert.equal(db.prepare('SELECT display_name FROM v_transactions').get().display_name, 'Cafe');
  db.close();
});

test('v9 migration drops category_sync and the entries it shadowed', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // Rewind to the v8 shape: the sync table exists, groceries is synced for
  // 2025, and a stale entry hides under that synced cell while a visible
  // manual entry lives in an unsynced cell.
  db.exec(`CREATE TABLE category_sync (
     year INTEGER NOT NULL,
     category VARCHAR(50) NOT NULL,
     PRIMARY KEY (year, category)
   )`);
  db.prepare("INSERT INTO category_sync (year, category) VALUES (2025, 'groceries')").run();
  db.prepare(
    "INSERT INTO entries (year, month, category, value) VALUES (2025, 3, 'groceries', 9999)"
  ).run();
  db.prepare(
    "INSERT INTO entries (year, month, category, value) VALUES (2025, 3, 'rent', 1500)"
  ).run();
  db.pragma('user_version = 8');

  bootstrapSchema(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(!tableExists(db, 'category_sync'), 'sync table dropped');
  // The shadowed (invisible) entry is gone; the visible manual value survives
  // as a per-cell override.
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM entries WHERE category = 'groceries'").get().c,
    0
  );
  assert.equal(
    db.prepare("SELECT value FROM entries WHERE category = 'rent'").get().value,
    1500
  );
  db.close();
});

test('connect() leaves foreign_keys OFF (handler-enforced integrity)', () => {
  // better-sqlite3-multiple-ciphers is compiled with foreign_keys ON by
  // default; connect() must switch it OFF since referential rules live in the
  // handlers, not the engine. A declared FK to a missing table must stay inert.
  const db = connect(tmpFile());
  assert.equal(db.pragma('foreign_keys', { simple: true }), 0, 'foreign_keys off');
  db.exec(`CREATE TABLE transactions (
    id INTEGER NOT NULL, date DATE NOT NULL,
    description VARCHAR(200) DEFAULT '' NOT NULL, category_id INTEGER,
    amount FLOAT DEFAULT 0 NOT NULL, notes VARCHAR(500) DEFAULT '' NOT NULL,
    tx_type VARCHAR(10) DEFAULT 'expense' NOT NULL, PRIMARY KEY (id),
    FOREIGN KEY(category_id) REFERENCES does_not_exist (id))`);
  db.prepare(
    "INSERT INTO transactions (date, description, category_id) VALUES ('2026-06-11', 'x', 1)"
  ).run();
  db.prepare('UPDATE transactions SET category_id = 2 WHERE id = 1').run();
  assert.equal(db.prepare('SELECT category_id FROM transactions').get().category_id, 2);
  db.close();
});

test('SQLCipher encrypted round trip (create, verify key, reopen)', () => {
  const p = tmpFile();
  const key = 'CorrectHorse#42';

  // Keying a brand-new file encrypts it.
  let db = connect(p, key);
  db.exec('CREATE TABLE probe (msg TEXT)');
  db.prepare("INSERT INTO probe (msg) VALUES ('hello')").run();
  db.close();

  // The raw file must not be a plaintext SQLite database.
  assert.ok(!fs.readFileSync(p).slice(0, 16).toString('utf8').startsWith('SQLite format 3'));

  assert.equal(verifyKey(p, key), true, 'correct key verifies');
  assert.equal(verifyKey(p, 'wrong-key'), false, 'wrong key rejected');

  db = connect(p, key);
  assert.equal(db.prepare('SELECT msg FROM probe').get().msg, 'hello');
  db.close();
});
// ─── Migration discipline ────────────────────────────────────────────────────
// These tests are the fence that keeps migrations switched ON: any change to
// the shape of the database has to arrive with a migration that carries an
// existing database to the same place, or one of them fails.

/** Structural fingerprint of a database: what the app and its queries actually
 *  depend on. Comments and identifier quoting are normalised away — a table
 *  rebuilt by a migration is stored as SQLite re-serialised it (quoted name, no
 *  comments), while a fresh one keeps schema.js's verbatim text including the
 *  self-describing comments it ships for external SQLite tools. That difference
 *  is cosmetic and deliberate; columns, types, defaults and CHECK constraints
 *  are not, and they survive this normalisation. */
function schemaFingerprint(db) {
  const norm = (sql) => String(sql || '')
    .replace(/--[^\n]*/g, ' ')   // line comments
    .replace(/"/g, '')           // identifier quoting (RENAME re-quotes names)
    .replace(/\s+/g, ' ')
    .trim();
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
  return rows.map((r) => `${r.type} ${r.name} :: ${norm(r.sql)}`).join('\n');
}

/** A database rewound to `version` by `rewind`, then climbed back up. */
function climbedFrom(version, rewind) {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  rewind(db);
  db.pragma(`user_version = ${version}`);
  bootstrapSchema(db);
  return db;
}

// The v13 shape: recurring_overrides before `removed` became `adopted`.
const V13_RECURRING = `CREATE TABLE recurring_overrides (
   "key" VARCHAR(200) NOT NULL,
   display_name VARCHAR(100),
   direction VARCHAR(10) CHECK (direction IN ('income', 'expense', 'transfer')),
   cycle VARCHAR(20)
     CHECK (cycle IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
   amount FLOAT CHECK (amount > 0),
   last_date DATE,
   removed INTEGER DEFAULT 0 NOT NULL CHECK (removed IN (0, 1)),
   PRIMARY KEY ("key")
 )`;

test('migration ladder: SCHEMA_VERSION is the top of it, with no gaps', () => {
  const keys = MIGRATIONS.map(([v]) => v);
  assert.deepStrictEqual(keys, [...keys].sort((a, b) => a - b), 'migrations are in order');
  assert.equal(new Set(keys).size, keys.length, 'no duplicate migration versions');
  assert.deepStrictEqual(
    keys,
    Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 2),
    'every version from 2 to SCHEMA_VERSION has exactly one migration'
  );
  assert.equal(
    keys[keys.length - 1],
    SCHEMA_VERSION,
    `SCHEMA_VERSION (${SCHEMA_VERSION}) must equal the highest migration key — a bump `
    + 'without a migration strands every existing database at the old shape'
  );
});

// The one that actually forces the discipline. It fails on ANY edit to the
// baseline DDL, which is the moment to ask: does an existing database need a
// migration to reach this same shape? (Almost always yes — the exception is a
// comment-only edit.) Then bump SCHEMA_VERSION, add the migration, and update
// the hash below in the same commit.
test('baseline schema is pinned: changing it requires a migration', () => {
  const EXPECTED_SCHEMA_VERSION = 14;
  const EXPECTED_DDL_HASH = 'ebac4ae3c22b969a40e5ab1b2806806192e82273d525ff0ad79c882f163dab24';

  const actual = crypto.createHash('sha256').update(DDL.join('\n')).digest('hex');
  assert.equal(
    actual, EXPECTED_DDL_HASH,
    '\n\n  schema.js DDL changed.\n'
    + '  A fresh database now has a shape that existing databases do NOT.\n\n'
    + '  1. Add a migration in migrate.js that carries an existing DB to the same shape.\n'
    + '  2. Bump SCHEMA_VERSION in schema.js.\n'
    + '  3. Update EXPECTED_SCHEMA_VERSION + EXPECTED_DDL_HASH in this test:\n'
    + `       EXPECTED_SCHEMA_VERSION = ${SCHEMA_VERSION}\n`
    + `       EXPECTED_DDL_HASH       = '${actual}'\n`
    + '  4. Add a case to the "migrated database matches a fresh one" test below.\n'
  );
  assert.equal(
    SCHEMA_VERSION, EXPECTED_SCHEMA_VERSION,
    'SCHEMA_VERSION moved without the baseline DDL changing — was the migration written '
    + 'but the baseline forgotten? A fresh DB would then be created at the OLD shape.'
  );
});

// The other half: a migration must land an existing database in the SAME place
// a fresh one starts. Add a case here whenever a migration is added.
test('a migrated database matches a fresh one', () => {
  const fresh = connect(tmpFile());
  bootstrapSchema(fresh);
  seedDefaults(fresh);
  const expected = schemaFingerprint(fresh);
  fresh.close();

  const cases = {
    // v12 — before recurring_overrides existed at all (climbs v13 + v14).
    12: (db) => db.exec('DROP TABLE recurring_overrides'),
    // v13 — recurring_overrides still carrying `removed` (climbs v14).
    13: (db) => {
      db.exec('DROP TABLE recurring_overrides');
      db.exec(V13_RECURRING);
    },
  };

  for (const [version, rewind] of Object.entries(cases)) {
    const db = climbedFrom(Number(version), rewind);
    assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
    assert.equal(
      schemaFingerprint(db), expected,
      `a database climbed from v${version} does not match a fresh one — its migration is incomplete`
    );
    db.close();
  }
});

test('a database from a NEWER version is refused, not opened', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);

  // Silently opening it is the failure this guards: migrate.js climbs and never
  // descends, so the app would query columns and tables it has no model of.
  assert.throws(() => bootstrapSchema(db), (err) => {
    assert.ok(err instanceof SchemaTooNewError);
    assert.equal(err.code, 'db_schema_too_new');
    assert.equal(err.found, SCHEMA_VERSION + 1);
    assert.equal(err.supported, SCHEMA_VERSION);
    return true;
  });
  db.close();
});

test('a failing migration rolls back whole and leaves the pre-migration backup', () => {
  const file = tmpFile();
  const db = connect(file);
  bootstrapSchema(db);
  seedDefaults(db);

  // A v13 recurring_overrides missing the `removed` column v14 reads: v14 gets
  // past CREATE and dies on the INSERT ... SELECT, half way through the table
  // rebuild — exactly the shape that used to leave a dropped table behind.
  db.exec('DROP TABLE recurring_overrides');
  db.exec(V13_RECURRING.replace(
    'removed INTEGER DEFAULT 0 NOT NULL CHECK (removed IN (0, 1)),', ''
  ));
  db.prepare('INSERT INTO recurring_overrides ("key", display_name) VALUES (?, ?)')
    .run('netflix', 'Netflix');
  db.pragma('user_version = 13');

  assert.throws(() => bootstrapSchema(db));

  // Rolled back whole: no half-built replacement, the original rows still there,
  // and the version still 13 so the climb is retried rather than skipped.
  assert.ok(!tableExists(db, 'recurring_overrides_new'), 'no half-built table left behind');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM recurring_overrides').get().c, 1);
  assert.equal(Number(db.pragma('user_version', { simple: true })), 13);

  // And the untouched copy taken before the climb started is still on disk.
  assert.ok(fs.existsSync(`${file}.v13-premigration-bak`), 'pre-migration backup kept');
  db.close();
});

test('a successful migration cleans up its backup', () => {
  const file = tmpFile();
  const db = connect(file);
  bootstrapSchema(db);
  seedDefaults(db);
  db.exec('DROP TABLE recurring_overrides');
  db.exec(V13_RECURRING);
  db.pragma('user_version = 13');

  bootstrapSchema(db);
  assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
  assert.ok(!fs.existsSync(`${file}.v13-premigration-bak`), 'backup removed on success');
  db.close();
});
