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
const path = require('path');

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

  // ─── File-write authorization (renderer-trust-boundary containment) ────────
  // The renderer is sandboxed: these backend file endpoints (db create /
  // save-as, transactions export) are its ONLY way to write to disk. A path
  // can reach them from three places — a native OS dialog, the in-modal file
  // browser, or free typing — and the renderer is the one relaying it, so a
  // compromised renderer could ask to write anywhere the user can.
  //
  // The Electron shell injects a guard (setWriteGuard) and pre-approves every
  // path it hands out through a native save/open dialog (approveWrite) — those
  // the renderer cannot drive. authorizeWrite() then lets dialog-issued paths
  // through untouched but routes any other path through a native confirmation
  // the renderer can't auto-dismiss. With no guard injected (host-Node tests,
  // smoke, plain-browser dev — no untrusted renderer) writes are unrestricted,
  // so behavior off the Electron boundary is unchanged.
  let writeGuard = null;
  const approvedWrites = new Set();
  const normWrite = (p) => path.resolve(p);

  function setWriteGuard(guard) {
    writeGuard = guard;
  }

  /** Mark a path the shell issued via a native dialog as user-authorized. */
  function approveWrite(p) {
    if (typeof p === 'string' && p) approvedWrites.add(normWrite(p));
  }

  /** Gate a pending file write. Throws ApiError(403) if the user declines a
   *  path that wasn't dialog-issued. No-op when no guard is wired. */
  function authorizeWrite(p) {
    if (!writeGuard) return;
    const key = normWrite(p);
    if (approvedWrites.has(key)) return;
    if (writeGuard.confirm(key)) {
      approvedWrites.add(key); // remember so chunked writes don't re-prompt
      return;
    }
    throw new ApiError('write_not_authorized', 403);
  }

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
      let restored = false;
      try { fs.copyFileSync(backup, target); restored = true; } catch { /* see below */ }
      try { handle = connect(target, state.encrypted ? state.key : null); } catch { /* surfaced as 423 next call */ }
      // Only discard the backup once the original bytes are safely back in
      // place. If the restore copy failed, the backup is the sole surviving
      // good copy — keep it for manual recovery rather than deleting it.
      if (restored) {
        try { fs.unlinkSync(backup); } catch { /* best-effort cleanup */ }
      }
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

  return {
    state, init, db, statusPayload, switchTo, lock, rekey, closeAll,
    setWriteGuard, approveWrite, authorizeWrite,
  };
}

module.exports = { createConn };
