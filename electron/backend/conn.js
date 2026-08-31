'use strict';

// Connection manager — holds the live database handle and the runtime switch
// logic. This is the Node counterpart of dbstate.rebind_engine + the
// routes/database.py _switch_to helper, with the same rollback guarantee: if
// migrating or seeding a candidate database fails, the previous database stays
// active and unmodified.
//
// Factory, not singleton, so tests build isolated instances (the way each Python
// test built a fresh app via create_app()).

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const { connect, sqlQuote } = require('./db');
const { createDbState, defaultDbDir } = require('./dbstate');
const { bootstrapSchema, SchemaTooNewError } = require('./migrate');
const { seedDefaults } = require('./seed');
const { ApiError } = require('./validate');

function secureChmod(p) {
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort; may fail on Windows ACLs or unusual filesystems
  }
}

/**
 * Constant-time passphrase comparison. `a !== b` returns as soon as two bytes
 * differ, so the time it takes leaks how much of a guess was right — the
 * classic way a comparison becomes an oracle for recovering a secret one
 * character at a time.
 *
 * The exposure here is modest (an attacker needs to be driving the renderer
 * already, and the passphrase they would be recovering unlocks a database they
 * could copy anyway), so this is hygiene rather than a live hole. It is also
 * one line, and "compare secrets in constant time" is not a rule worth having
 * an exception to.
 *
 * Hashing first is what makes the lengths equal: timingSafeEqual throws on
 * mismatched lengths, and length is not a secret worth the extra branch.
 */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/**
 * Overwrite a file with random bytes, then delete it. Used for the sidecar
 * backup a rekey leaves behind when the pre-rekey bytes were PLAINTEXT: an
 * ordinary unlink returns the blocks to the free list with the ledger still
 * legible in them, which is a poor way to finish the operation whose entire
 * purpose was to make that ledger unreadable.
 *
 * HONEST LIMIT: this is not a guaranteed erase, and cannot be one from user
 * space. A copy-on-write filesystem (btrfs, ZFS) writes the random bytes to new
 * blocks and leaves the originals for the next snapshot or balance to reclaim,
 * and any SSD's wear levelling may do the same underneath a filesystem that
 * would otherwise overwrite in place. It closes the straightforward case
 * (in-place filesystems, and undelete tools generally); it is not a defence
 * against someone imaging the disk. Best-effort throughout — failing to shred
 * must never fail the rekey, which has already succeeded by this point.
 */
function shredFile(p) {
  try {
    const { size } = fs.statSync(p);
    if (size > 0) {
      const fd = fs.openSync(p, 'r+');
      try {
        const buf = Buffer.allocUnsafe(Math.min(1 << 20, size));
        for (let off = 0; off < size; off += buf.length) {
          const n = Math.min(buf.length, size - off);
          crypto.randomFillSync(buf, 0, n);
          fs.writeSync(fd, buf, 0, n, off);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // unreadable / already gone / read-only — fall through to the unlink
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

function createConn() {
  const dbstate = createDbState();
  const { state } = dbstate;
  let handle = null;

  // ─── File-write authorization (renderer-trust-boundary containment) ────────
  // The renderer is sandboxed: these backend file endpoints (db create /
  // save-as, transactions export) are its ONLY way to write to disk. A path can
  // reach them from three places — a native OS dialog, the in-modal file
  // browser, or typed input — and the renderer relays it, so a compromised
  // renderer could request a write anywhere the user has permission.
  //
  // The Electron shell injects a guard (setWriteGuard) and pre-approves every
  // path it returns from a native save/open dialog (approveWrite), which the
  // renderer cannot drive. authorizeWrite() then passes dialog-issued paths
  // through unchanged and sends any other path through a native confirmation
  // the renderer cannot dismiss. With no guard injected (host-Node tests, smoke,
  // plain-browser dev — no untrusted renderer) writes are unrestricted, so
  // behavior outside Electron is unchanged.
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
   *  path that was not dialog-issued. No-op when no guard is wired.
   *
   *  `allowProposedDir` skips the prompt for a new file directly inside the
   *  folder the app proposed (defaultDbDir — the one the New Database modal
   *  displays before the user presses Create). That location did not come from
   *  the renderer, it is shown to the user first, and the only caller passing
   *  this flag refuses to overwrite an existing file — so a compromised renderer
   *  can at most create a new empty database in the app's own folder. Immediate
   *  children only: comparing the parent exactly excludes `..` escapes and
   *  subdirectories. */
  function authorizeWrite(p, { allowProposedDir = false } = {}) {
    if (!writeGuard) return;
    const key = normWrite(p);
    if (approvedWrites.has(key)) return;
    if (allowProposedDir && path.dirname(key) === defaultDbDir(state.path)) return;
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
      // The default location for a new database, plus the separator for joining
      // a file name onto it: the New Database modal pre-fills this location so
      // only the file name is required.
      default_dir: defaultDbDir(state.path),
      sep: path.sep,
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
    } catch (err) {
      if (candidate) {
        try { candidate.close(); } catch { /* already closed */ }
      }
      if (create) {
        try { fs.unlinkSync(path); } catch { /* never created / already gone */ }
        throw new ApiError('Could not initialise the new database', 500);
      }
      // A file from a NEWER build is not a migration failure and must not be
      // reported as one: nothing the user does to this app will open it, so the
      // message names the actual fix (run the newer version) instead of
      // implying a retry might work.
      if (err instanceof SchemaTooNewError) {
        throw new ApiError(
          'This database was created by a newer version of Aventurine. '
          + 'Update the app to open it.',
          400
        );
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
   * Re-lock an encrypted database: discard the in-memory key and close the
   * handle, so the DB is locked (the next /api/* returns 423 and the renderer
   * shows the unlock prompt). Only applies to an encrypted DB — an unencrypted
   * file has no passphrase to re-enter. Idempotent: locking an already-locked
   * DB returns the status unchanged.
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
   * reopened, so a failed rekey cannot leave a corrupt or half-keyed DB.
   */
  function rekey({ action, currentPassword, newPassword }) {
    if (state.locked || !handle) throw new ApiError('db_locked', 423);

    const needsCurrent = action === 'change' || action === 'decrypt';
    if (needsCurrent) {
      if (!state.encrypted) throw new ApiError('database is not encrypted', 400);
      if (!sameSecret(currentPassword, state.key)) {
        throw new ApiError('invalid_password', 401);
      }
    }
    if (action === 'encrypt' && state.encrypted) {
      throw new ApiError('database is already encrypted', 400);
    }
    if (action === 'encrypt' || action === 'change') {
      if (typeof newPassword !== 'string' || !newPassword) {
        throw new ApiError('A password is required', 400);
      }
      if (newPassword.includes('\x00')) {
        throw new ApiError('invalid database passphrase', 400);
      }
    }

    const target = state.path;
    const backup = target + '.rekey-bak';
    // A backup of a PLAINTEXT database is a second readable copy of the whole
    // ledger. It is worth making — a half-keyed database is unrecoverable and
    // this is the rollback — but it is worth making carefully: owner-only from
    // the moment it exists (copyFileSync applies the umask, which on a typical
    // Linux account is 0644), and shredded rather than unlinked on the way out.
    const plaintextBackup = !state.encrypted;
    try { fs.unlinkSync(backup); } catch { /* no stale backup */ }
    // Flush to the main file (no-op outside WAL) so the byte-copy is current.
    try { handle.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL */ }
    fs.copyFileSync(target, backup);
    secureChmod(backup);

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
    } catch {
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
        if (plaintextBackup) shredFile(backup);
        else { try { fs.unlinkSync(backup); } catch { /* best-effort cleanup */ } }
      }
      throw new ApiError('Could not change encryption — the database was left unchanged', 500);
    }

    if (action === 'encrypt') { state.encrypted = true; state.key = newPassword; }
    else if (action === 'change') { state.key = newPassword; }
    else { state.encrypted = false; state.key = null; }

    secureChmod(target);
    dbstate.savePointer();
    // The 'encrypt' case is the one that matters: the user has just asked for
    // this ledger to stop being readable on disk, and the backup is the last
    // plaintext copy of it. A NOTE ON WHAT SURVIVES: the backup is only cleared
    // on a rekey that finishes. One interrupted by a crash or a power loss
    // leaves it in place on purpose — at that point it may be the only intact
    // copy, so deleting it at the next launch would turn a recoverable failure
    // into data loss. It is at least owner-only, and named plainly enough to be
    // recognised.
    if (plaintextBackup) shredFile(backup);
    else { try { fs.unlinkSync(backup); } catch { /* best-effort cleanup */ } }
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
