'use strict';

// Connection manager — owns the live database handle and the runtime switch
// logic. This is the Node counterpart of dbstate.rebind_engine + the
// routes/database.py _switch_to helper, with the same rollback guarantee:
// if migrating/seeding a candidate database fails, the previous database
// stays active and untouched.
//
// Factory, not singleton, so tests build isolated instances (the way each
// Python test built a fresh app via create_app()).

const fs = require('fs');

const { connect, sqlQuote } = require('./db');
const { createDbState } = require('./dbstate');
const { bootstrapSchema } = require('./migrate');
const { seedDefaults } = require('./seed');
const { ApiError } = require('./validate');

function secureChmod(p) {
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort; Windows ACLs / odd filesystems may refuse
  }
}

function createConn() {
  const dbstate = createDbState();
  const { state } = dbstate;
  let handle = null;

  /** Open + migrate + seed the DB named by current state (startup path).
   *  A locked (encrypted, no key yet) DB stays unopened until unlock. */
  function init() {
    dbstate.loadInitialState();
    if (!state.locked) {
      handle = connect(state.path, state.encrypted ? state.key : null);
      bootstrapSchema(handle);
      seedDefaults(handle);
      if (!state.encrypted) secureChmod(state.path);
    }
  }

  /** The live handle. Locked/missing -> the same 423 the Flask gate gave. */
  function db() {
    if (state.locked || !handle) throw new ApiError('db_locked', 423);
    return handle;
  }

  function statusPayload() {
    return {
      ok: true,
      path: state.path,
      encrypted: state.encrypted,
      locked: state.locked,
      // Encryption ships in-binary now; field kept for frontend compat.
      encryption_available: true,
    };
  }

  /**
   * Switch the live handle to (path, encrypted, key); migrate + seed; persist
   * the pointer. Rolls back to the previous DB if anything fails — the live
   * handle and state are only replaced once the candidate is fully ready.
   */
  function switchTo(path, encrypted, key, { create = false } = {}) {
    let candidate = null;
    try {
      candidate = connect(path, encrypted ? key : null);
      bootstrapSchema(candidate);
      seedDefaults(candidate);
    } catch (e) {
      if (candidate) {
        try { candidate.close(); } catch { /* already closed */ }
      }
      if (create) {
        try { fs.unlinkSync(path); } catch { /* never created / already gone */ }
        throw new ApiError('Could not initialise the new database', 500);
      }
      throw new ApiError(
        'Database could not be migrated (was it made by a newer version of the app?)',
        400
      );
    }
    // Success: adopt the candidate, then retire the old handle.
    state.path = path;
    state.encrypted = encrypted;
    state.key = key;
    const old = handle;
    handle = candidate;
    if (old) {
      try { old.close(); } catch { /* already closed */ }
    }
    if (create || !encrypted) secureChmod(path);
    dbstate.savePointer();
    return statusPayload();
  }

  /**
   * Re-protect an encrypted database: drop the in-memory key and close the
   * handle, so the DB is locked (the next /api/* answers 423 and the renderer
   * shows the unlock prompt). Only meaningful for an encrypted DB — an
   * unencrypted file has no passphrase to re-enter, so there's nothing to
   * protect. Idempotent: locking an already-locked DB just reports status.
   */
  function lock() {
    if (!state.encrypted) throw new ApiError('database is not encrypted', 400);
    state.key = null; // state.locked is now true (encrypted && key == null)
    if (handle) {
      try { handle.close(); } catch { /* already closed */ }
      handle = null;
    }
    return statusPayload();
  }

  /**
   * Change the on-disk encryption of the ACTIVE database in place via
   * `PRAGMA rekey`, preserving the cipher recipe (sqlcipher / legacy=4) so the
   * result reopens with connect(). Three actions:
   *   'encrypt' — plaintext DB -> encrypted with `newPassword`.
   *   'change'  — encrypted DB -> re-encrypted with `newPassword` (verifies
   *               `currentPassword` against the in-memory key first).
   *   'decrypt' — encrypted DB -> plaintext (verifies `currentPassword`).
   *
   * Data-integrity guard: the file is copied to a sidecar backup before the
   * rekey; on any failure the backup is restored and the original key/handle
   * reopened, so a botched rekey can never leave a corrupt or half-keyed DB.
   */
  function rekey({ action, currentPassword, newPassword }) {
    if (state.locked || !handle) throw new ApiError('db_locked', 423);

    const needsCurrent = action === 'change' || action === 'decrypt';
    if (needsCurrent) {
      if (!state.encrypted) throw new ApiError('database is not encrypted', 400);
      if (currentPassword !== state.key) throw new ApiError('invalid_password', 401);
    }
    if (action === 'encrypt' && state.encrypted) {
      throw new ApiError('database is already encrypted', 400);
    }
    if (action === 'encrypt' || action === 'change') {
      if (typeof newPassword !== 'string' || !newPassword) {
        throw new ApiError('A password is required', 400);
      }
      if (/\x00/.test(newPassword)) {
        throw new ApiError('invalid database passphrase', 400);
      }
    }

    const target = state.path;
    const backup = target + '.rekey-bak';
    try { fs.unlinkSync(backup); } catch { /* no stale backup */ }
    // Flush to the main file (no-op outside WAL) so the byte-copy is current.
    try { handle.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL */ }
    fs.copyFileSync(target, backup);

    try {
      if (action === 'encrypt') {
        // Configure the cipher on this (plaintext) connection, then rekey to
        // encrypt with the very recipe connect() will later open it under.
        handle.pragma('cipher=sqlcipher');
        handle.pragma('legacy=4');
        handle.pragma(`rekey = ${sqlQuote(newPassword)}`);
      } else if (action === 'change') {
        handle.pragma(`rekey = ${sqlQuote(newPassword)}`);
      } else { // decrypt
        handle.pragma("rekey = ''");
      }
      const row = handle.prepare('PRAGMA quick_check').get();
      const verdict = row ? Object.values(row)[0] : null;
      if (verdict !== 'ok') throw new Error('integrity check failed after rekey');
    } catch (e) {
      // Roll back: restore the pre-rekey bytes and reopen under the OLD state.
      try { if (handle) handle.close(); } catch { /* already closed */ }
      handle = null;
      try { fs.copyFileSync(backup, target); } catch { /* leave backup for recovery */ }
      try { handle = connect(target, state.encrypted ? state.key : null); } catch { /* surfaced as 423 next call */ }
      try { fs.unlinkSync(backup); } catch { /* keep for manual recovery */ }
      throw new ApiError('Could not change encryption — the database was left unchanged', 500);
    }

    if (action === 'encrypt') { state.encrypted = true; state.key = newPassword; }
    else if (action === 'change') { state.key = newPassword; }
    else { state.encrypted = false; state.key = null; }

    secureChmod(target);
    dbstate.savePointer();
    try { fs.unlinkSync(backup); } catch { /* best-effort cleanup */ }
    return statusPayload();
  }

  function closeAll() {
    if (handle) {
      try { handle.close(); } catch { /* already closed */ }
      handle = null;
    }
  }

  return { state, init, db, statusPayload, switchTo, lock, rekey, closeAll };
}

module.exports = { createConn };
