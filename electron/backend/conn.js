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

const { connect } = require('./db');
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

  function closeAll() {
    if (handle) {
      try { handle.close(); } catch { /* already closed */ }
      handle = null;
    }
  }

  return { state, init, db, statusPayload, switchTo, closeAll };
}

module.exports = { createConn };
