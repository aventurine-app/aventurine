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

  // flex_type is seeded per the canonical taxonomy: contractual bills are
  // 'fixed', savings/investing buckets are 'goal', the rest default to 'flex'.
  const flexOf = (key) => cats.find((c) => c.key === key).flex_type;
  assert.equal(flexOf('rent'), 'fixed');
  assert.equal(flexOf('insurance'), 'fixed');
  assert.equal(flexOf('groceries'), 'flex');
  assert.equal(flexOf('savings'), 'goal');
  assert.equal(flexOf('investing'), 'goal');
  assert.ok(cats.every((c) => ['fixed', 'flex', 'goal'].includes(c.flex_type)));

  const yr = new Date().getFullYear();

  // The bootstrap year starts fully synced (every category computed from
  // transactions), mirroring the yearAdd default — a first import populates
  // Cash Flow without any sync configuration. The user opts cells OUT.
  const syncRows = db.prepare('SELECT year, category FROM category_sync').all();
  assert.equal(syncRows.length, cats.length, 'every category synced for the bootstrap year');
  assert.ok(syncRows.every((r) => r.year === yr));

  assert.ok(db.prepare('SELECT 1 FROM active_years WHERE year=?').get(yr));
  assert.ok(db.prepare('SELECT 1 FROM balance_active_years WHERE year=?').get(yr));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM balance_columns').get().c, 5);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM portfolio_accounts').get().c, 1);
  assert.equal(
    db.prepare('SELECT value FROM app_settings WHERE "key"=?').get('tx_fuzzy_threshold').value,
    '1'
  );

  for (const t of ['active_years', 'app_settings', 'balance_entries', 'categories',
    'category_sync', 'credit_cards', 'entries', 'match_rules', 'portfolio_accounts',
    'portfolio_entries', 'transactions', 'forecast_planned', 'budget_amounts',
    'accounts', 'account_balance_anchors', 'balance_sync']) {
    assert.ok(tableExists(db, t), `table ${t} present`);
  }
  db.close();
});

test('seed is idempotent', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);
  seedDefaults(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories').get().c, 18);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM portfolio_accounts').get().c, 1);

  // Re-seeding never resurrects sync rows the user opted out of: the sync
  // seeding is tied to the bootstrap-year INSERT, which only fires once.
  db.prepare("DELETE FROM category_sync WHERE category = 'groceries'").run();
  seedDefaults(db);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM category_sync WHERE category = 'groceries'").get().c,
    0,
    'user sync opt-out survives a re-seed'
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

test('migration v5: a pre-flex_type categories table gains the column + seeded values', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);

  // Rebuild categories in its pre-v5 shape (no flex_type) and drop the stored
  // version below 5 so bootstrapSchema takes the migration path.
  db.exec('DROP TABLE categories');
  db.exec(`CREATE TABLE categories (
     id INTEGER NOT NULL, "key" VARCHAR(50) NOT NULL, name VARCHAR(100) NOT NULL,
     cat_type VARCHAR(20) NOT NULL, position INTEGER DEFAULT 0 NOT NULL,
     PRIMARY KEY (id), UNIQUE ("key"))`);
  const ins = db.prepare(
    'INSERT INTO categories ("key", name, cat_type, position) VALUES (?, ?, ?, ?)'
  );
  ins.run('rent', 'Rent', 'expense', 0);
  ins.run('groceries', 'Groceries', 'expense', 1);
  ins.run('savings', 'Savings', 'savings', 2);
  db.pragma('user_version = 4');

  bootstrapSchema(db); // climbs 4 -> SCHEMA_VERSION, running migration v5
  assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);

  const flex = Object.fromEntries(
    db.prepare('SELECT "key", flex_type FROM categories').all().map((r) => [r.key, r.flex_type])
  );
  assert.equal(flex.rent, 'fixed', 'a contractual bill becomes fixed');
  assert.equal(flex.savings, 'goal', 'a savings category becomes a goal');
  assert.equal(flex.groceries, 'flex', 'everything else defaults to flex');
  db.close();
});

test('migration v7: a pre-accounts DB gains accounts, anchors, and a rebuilt ledger', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);

  // Rebuild transactions in its pre-v7 shape (no account_id/transfer_peer_id,
  // no transfer tx_types in the CHECK), drop the v7 tables and view, and lower
  // the stored version so bootstrapSchema takes the migration path.
  db.exec('DROP VIEW v_transactions');
  db.exec('DROP TABLE transactions');
  db.exec(`CREATE TABLE transactions (
     id INTEGER NOT NULL, date DATE NOT NULL,
     description VARCHAR(200) DEFAULT '' NOT NULL, category_id INTEGER,
     amount FLOAT DEFAULT 0 NOT NULL CHECK (amount >= 0),
     notes VARCHAR(500) DEFAULT '' NOT NULL,
     tx_type VARCHAR(10) DEFAULT 'expense' NOT NULL
       CHECK (tx_type IN ('income', 'expense', 'savings', 'investing')),
     PRIMARY KEY (id))`);
  db.exec('DROP TABLE accounts');
  db.exec('DROP TABLE account_balance_anchors');
  const groceriesId = db.prepare("SELECT id FROM categories WHERE \"key\"='groceries'").get().id;
  db.prepare(
    "INSERT INTO transactions (date, description, category_id, amount, tx_type) VALUES (?, ?, ?, ?, ?)"
  ).run('2026-03-05', 'SAFEWAY #1842', groceriesId, 88.12, 'expense');
  db.pragma('user_version = 6');

  bootstrapSchema(db); // climbs 6 -> SCHEMA_VERSION, running migration v7
  assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);

  // The ledger survived the rebuild, byte-for-byte where it matters.
  const t = db.prepare('SELECT * FROM transactions').get();
  assert.equal(t.description, 'SAFEWAY #1842');
  assert.equal(t.amount, 88.12);
  assert.equal(t.category_id, groceriesId);
  assert.equal(t.account_id, null, 'pre-accounts rows are unassigned');
  assert.equal(t.transfer_peer_id, null);

  // The rebuilt CHECK admits the transfer pair types...
  db.prepare(
    "INSERT INTO transactions (date, description, amount, tx_type) VALUES (?, ?, ?, ?)"
  ).run('2026-03-06', 'to savings', 500, 'transfer_out');
  // ...and still rejects garbage.
  assert.throws(() =>
    db.prepare(
      "INSERT INTO transactions (date, description, amount, tx_type) VALUES (?, ?, ?, ?)"
    ).run('2026-03-07', 'x', 1, 'nonsense')
  );

  // New tables and the account-aware view are in place.
  assert.ok(tableExists(db, 'accounts'));
  assert.ok(tableExists(db, 'account_balance_anchors'));
  const viewRow = db
    .prepare("SELECT account_name, signed_amount FROM v_transactions WHERE tx_type = 'transfer_out'")
    .get();
  assert.equal(viewRow.account_name, null);
  assert.equal(viewRow.signed_amount, -500, 'transfer_out is an outflow of its account');
  db.close();
});

test('migration v8: balance_sync arrives seeded for already-linked columns', () => {
  const db = connect(tmpFile());
  bootstrapSchema(db);
  seedDefaults(db);

  // Reshape to pre-v8: no balance_sync, one account already linked to the
  // checking column (the founder-style DB that was showing derived values).
  db.exec('DROP TABLE balance_sync');
  db.prepare(
    "INSERT INTO accounts (name, kind, balance_column) VALUES ('My Checking', 'checking', 'checking')"
  ).run();
  db.pragma('user_version = 7');

  bootstrapSchema(db); // climbs 7 -> SCHEMA_VERSION, running migration v8
  assert.equal(Number(db.pragma('user_version', { simple: true })), SCHEMA_VERSION);
  assert.ok(tableExists(db, 'balance_sync'));

  const yr = new Date().getFullYear();
  assert.ok(
    db.prepare('SELECT 1 FROM balance_sync WHERE year = ? AND category = ?').get(yr, 'checking'),
    'linked column seeded as synced, so derived values keep showing'
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM balance_sync WHERE category != 'checking'").get().c,
    0,
    'unlinked columns stay manual'
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
