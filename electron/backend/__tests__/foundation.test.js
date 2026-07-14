'use strict';

// Foundation tests for the data layer (db / migrate / seed). Run on host Node,
// no Electron needed:  flatpak-spawn --host npx --prefix electron node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, verifyKey } = require('../db');
const { bootstrapSchema, tableExists } = require('../migrate');
const { seedDefaults } = require('../seed');
const { SCHEMA_VERSION } = require('../schema');

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
  assert.equal(cats.length, 18, 'eighteen default categories');

  const yr = new Date().getFullYear();
  assert.ok(db.prepare('SELECT 1 FROM active_years WHERE year=?').get(yr));
  assert.ok(db.prepare('SELECT 1 FROM balance_active_years WHERE year=?').get(yr));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM balance_columns').get().c, 5);
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
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 18);
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
  db.prepare('DELETE FROM categories WHERE "key" = ?').run('groceries');
  seedDefaults(db);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE "key" = ?').get('groceries'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 17);
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
  assert.deepEqual(runs, ['income', 'expense', 'savings', 'investing']);
  db.close();
});

test('seed heals a drifted system bucket (name + type), leaves the rest alone', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // A DB written before the uncat_* lock existed can hold a renamed/re-typed
  // system bucket (the real-world case: "UNc"). Seeding on open must restore
  // the canonical row — but never touch user-owned rows or the position.
  db.prepare(
    "UPDATE categories SET name = 'UNc', cat_type = 'income', position = 99 WHERE \"key\" = 'uncat_expense'"
  ).run();
  db.prepare("UPDATE categories SET name = 'Eating Out' WHERE \"key\" = 'dining'").run();

  seedDefaults(db);

  const uncat = db.prepare('SELECT * FROM categories WHERE "key" = ?').get('uncat_expense');
  assert.equal(uncat.name, 'Uncategorized');
  assert.equal(uncat.cat_type, 'expense');
  assert.equal(uncat.position, 99); // reordering system buckets is allowed
  // User renames of ordinary categories survive.
  assert.equal(
    db.prepare('SELECT name FROM categories WHERE "key" = ?').get('dining').name,
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
  db.prepare("DELETE FROM categories WHERE \"key\" = 'groceries'").run();
  bootstrapSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 17);
  db.close();
});

test('v8 migration adds transactions.display_name and refreshes v_transactions', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  // Rewind to the v7 shape: no display_name column, view without it. (The
  // view must go first — SQLite refuses to drop a column a view references.)
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
