'use strict';

// Low-level database connection. One connection at a time; callers (handlers)
// receive the live handle.
//
// Encryption uses SQLCipher via better-sqlite3-multiple-ciphers. The
// `cipher=sqlcipher` + `legacy=4` pragmas pin SQLCipher 4 defaults; this is the
// app's on-disk encryption format and must stay stable for existing encrypted
// DBs to keep opening (see MIGRATION.md).

const Database = require('better-sqlite3-multiple-ciphers');

/** SQL string literal: the only escape inside a single-quoted SQLite string
 *  is a doubled quote. Same rule the Python code used; correct for any value. */
function sqlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Open a connection at `path`. When `key` is given the file is treated as
 * SQLCipher-encrypted and keyed before any read. A wrong key surfaces as a
 * "file is not a database" error on the first statement, not here.
 */
function connect(path, key = null) {
  const db = new Database(path);
  if (key != null) {
    // Reject a NUL byte: it truncates the C-string SQLCipher receives, turning
    // a wrong passphrase into a *different* wrong key (mirrors the Python
    // guard). Every other character, spaces included, is a valid passphrase.
    if (typeof key !== 'string' || key.indexOf('\u0000') !== -1) {
      db.close();
      throw new Error('invalid database passphrase');
    }
    db.pragma('cipher=sqlcipher');
    db.pragma('legacy=4');
    db.pragma(`key = ${sqlQuote(key)}`);
  }
  // foreign_keys must be OFF: referential rules are enforced in the handlers,
  // not the engine. This must be explicit — better-sqlite3-multiple-ciphers is
  // compiled with SQLITE_DEFAULT_FOREIGN_KEYS=1 (unlike stock SQLite/
  // better-sqlite3), so without this the declared FKs would be enforced.
  db.pragma('foreign_keys = OFF');
  return db;
}

/** True when `key` decrypts the SQLCipher DB at `path` (mirrors verify_key). */
function verifyKey(path, key) {
  let db;
  try {
    db = connect(path, key);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

module.exports = { connect, verifyKey, sqlQuote };
