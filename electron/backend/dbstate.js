'use strict';

// Runtime database selection — port of dbstate.py. Tracks which file is active,
// whether it's SQLCipher-encrypted, and the in-memory passphrase (never on
// disk). Persists path + encrypted flag to <dataDir>/active-db.json so the same
// DB reopens on restart; an encrypted database therefore starts LOCKED until
// the passphrase is supplied again.
//
// AVENTURINE_DB_PATH (the test suite) bypasses the pointer file entirely and is
// never persisted, so tests cannot overwrite a real pointer.
//
// Factory, not singleton: each createDbState() holds its own state, so tests can
// build isolated instances the way create_app() did for Flask.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Folder name used under Documents for the out-of-the-box database location.
const APP_FOLDER = 'Aventurine';

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

/** The user's Documents folder. The Electron shell passes the resolved
 *  (localized, XDG-aware) path in AVENTURINE_DOCUMENTS_DIR; outside the shell
 *  this checks the usual location and falls back to the home directory when
 *  there is no Documents folder. */
function documentsDir() {
  const given = process.env.AVENTURINE_DOCUMENTS_DIR;
  if (given) return path.resolve(given);
  const guess = path.join(os.homedir(), 'Documents');
  try {
    if (fs.statSync(guess).isDirectory()) return guess;
  } catch {
    // no Documents folder on this machine
  }
  return os.homedir();
}

/**
 * Folder proposed for a NEW database file, so the New Database modal can offer
 * a location (name it and press Create) instead of making the user browse for
 * one every time.
 *
 * It is the folder the active database already lives in, so a database kept in
 * ~/Vault proposes ~/Vault for the next one — EXCEPT when that folder is the
 * app's own profile dir, which is internal and not a place to store user files.
 * A never-moved default database therefore falls through to
 * <Documents>/Aventurine. Nothing is created here: proposing a location does not
 * touch the disk (the create route mkdirs the parent when a file is written).
 */
function defaultDbDir(activePath) {
  if (typeof activePath === 'string' && activePath) {
    const dir = path.dirname(path.resolve(activePath));
    let profile = null;
    try {
      profile = path.resolve(dataDir());
    } catch {
      profile = null; // unwritable data dir — treat any folder as user-chosen
    }
    if (dir !== profile) return dir;
  }
  return path.join(documentsDir(), APP_FOLDER);
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
    // Owner-only: the pointer records the path of the user's financial DB.
    try {
      fs.chmodSync(pointerFile(), 0o600);
    } catch {
      // best-effort; may fail on Windows ACLs or unusual filesystems
    }
  }

  return { state, pointerFile, dbFilePath, loadInitialState, savePointer };
}

module.exports = { createDbState, dataDir, defaultDbDir };
