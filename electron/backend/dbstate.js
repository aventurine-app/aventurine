'use strict';

// Runtime database selection — port of dbstate.py. Tracks which file is active,
// whether it's SQLCipher-encrypted, and the in-memory passphrase (never on
// disk). Persists path + encrypted flag to <dataDir>/active-db.json so the same
// DB reopens on restart; an encrypted database therefore starts LOCKED until
// the passphrase is supplied again.
//
// AVENTURINE_DB_PATH (the test suite) bypasses the pointer file entirely and
// is never persisted, so tests can't clobber a real pointer.
//
// Factory, not singleton: each createDbState() owns its state, so tests can
// build isolated instances exactly like create_app() did for Flask.

const fs = require('fs');
const path = require('path');

function dataDir() {
  const d = process.env.AVENTURINE_DATA_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  // Non-Electron fallback (dev/tests without the env var): a .data dir under
  // the cwd. The packaged app always sets AVENTURINE_DATA_DIR (main.js).
  const fallback = path.join(process.cwd(), '.data');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function createDbState() {
  const state = {
    path: null,
    encrypted: false,
    key: null, // passphrase — process memory only, never on disk
    get locked() {
      return this.encrypted && this.key == null;
    },
  };

  const pointerFile = () => path.join(dataDir(), 'active-db.json');
  const dbFilePath = () =>
    process.env.AVENTURINE_DB_PATH || path.join(dataDir(), 'finance.db');

  function loadInitialState() {
    const explicit = process.env.AVENTURINE_DB_PATH;
    if (explicit) {
      state.path = path.resolve(explicit);
      state.encrypted = false;
      state.key = null;
      return;
    }
    try {
      const d = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
      if (typeof d.path === 'string' && fs.statSync(d.path).isFile()) {
        state.path = d.path;
        state.encrypted = !!d.encrypted;
        state.key = null;
        return;
      }
    } catch {
      // missing/corrupt pointer -> fall back to the default DB
    }
    state.path = dbFilePath();
    state.encrypted = false;
    state.key = null;
  }

  function savePointer() {
    if (process.env.AVENTURINE_DB_PATH) return;
    const tmp = pointerFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ path: state.path, encrypted: state.encrypted }));
    fs.renameSync(tmp, pointerFile());
    // Owner-only: the pointer reveals where the user's financial DB lives.
    try {
      fs.chmodSync(pointerFile(), 0o600);
    } catch {
      // best-effort; Windows ACLs / odd filesystems may refuse
    }
  }

  return { state, pointerFile, dbFilePath, loadInitialState, savePointer };
}

module.exports = { createDbState, dataDir };
