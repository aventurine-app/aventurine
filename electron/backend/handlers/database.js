'use strict';

// Database management blueprint — port of routes/database.py: status, the
// in-modal filesystem browser, create / open / unlock with the same error
// strings and status codes (dbactions.js keys its UI off them).

const fs = require('fs');
const os = require('os');
const path = require('path');

const { bad } = require('../validate');
const { connect, verifyKey } = require('../db');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\x00', 'latin1');
const DB_EXTS = new Set(['.db', '.sqlite', '.sqlite3']);

function expandUser(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function status(ctx) {
  return ctx.statusPayload();
}

/** Directory listing for the in-modal file browser (mirror of browse_fs):
 *  directories plus database-looking files only, dotfiles skipped. Reachable
 *  while locked on purpose (the unlock prompt's "open a different database"
 *  flow needs it). On Windows the parent of a drive root is the sentinel
 *  'drives', which lists the available drive letters. */
function browse(ctx, { query }) {
  const raw = (query.path || '').trim();

  if (raw === 'drives' && process.platform === 'win32') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try {
        fs.accessSync(root);
        drives.push(root);
      } catch {
        // drive letter not present
      }
    }
    return { ok: true, path: 'drives', parent: null, sep: path.sep, dirs: drives, files: [] };
  }

  const p = path.resolve(expandUser(raw || '~'));
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) bad('Not a folder', 404);

  const dirs = [];
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    bad(`Cannot read that folder: ${e.code || e.constructor.name}`, 403);
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    try {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isFile() && DB_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(entry.name);
      }
    } catch {
      continue; // broken symlink / no permission on the entry
    }
  }

  let parent = path.dirname(p);
  if (parent === p) {
    // filesystem root: '/' on POSIX, 'C:\' on Windows
    parent = process.platform === 'win32' ? 'drives' : null;
  }
  return { ok: true, path: p, parent, sep: path.sep, dirs, files };
}

/** Expand ~ and resolve to an absolute path (mirror of _normalise_path). */
function normalisePath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) bad('No file path provided');
  const p = path.resolve(expandUser(raw.trim()));
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {
    // missing file is fine here — create needs it absent, open checks later
  }
  if (stat && stat.isDirectory()) bad('That path is a directory — include a file name');
  return p;
}

/** PRAGMA quick_check + core-table presence over an already-keyed connection
 *  factory (mirror of _validate_finance_db). Returns error string or null. */
function validateFinanceDb(openFn) {
  let tables;
  try {
    const con = openFn();
    try {
      const row = con.prepare('PRAGMA quick_check').get();
      const verdict = row ? Object.values(row)[0] : null;
      if (verdict !== 'ok') return 'SQLite integrity check failed';
      tables = new Set(
        con
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name)
      );
    } finally {
      con.close();
    }
  } catch {
    return 'Not a valid database file';
  }
  if (!tables.has('active_years')) return 'Not an Oliv database (core tables missing)';
  return null;
}

function create(ctx, { body }) {
  const data = body || {};
  const p = normalisePath(data.path);

  const encrypt = !!data.encrypt;
  const password = data.password;
  if (encrypt && (typeof password !== 'string' || !password)) {
    bad('A password is required to encrypt the database');
  }

  if (fs.existsSync(p)) bad('A file already exists at that location', 409);
  // Containment: a path the renderer relayed but didn't get from a native
  // dialog needs the user's out-of-renderer confirmation before we write.
  ctx.authorizeWrite(p);
  try {
    const parent = path.dirname(p);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    // Prove the location is writable BEFORE switching the engine over, so a
    // bad path fails cleanly without touching the current DB ('wx' = O_EXCL).
    fs.closeSync(fs.openSync(p, 'wx'));
    fs.unlinkSync(p);
  } catch (e) {
    bad(`Cannot create a file there: ${e.code || e.constructor.name}`);
  }

  return ctx.switchTo(p, encrypt, encrypt ? password : null, { create: true });
}

/** Save a copy of the active database at a new path, then make that copy the
 *  working file (a "Save As", not a backup-and-stay). The copy is byte-for-byte
 *  so the on-disk format — including SQLCipher encryption and key — is
 *  preserved; the new file is activated with the same encrypted flag + key. */
function saveAs(ctx, { body }) {
  // No handle exists while locked, and we have no key to re-open the copy.
  if (ctx.state.locked) bad('db_locked', 423);

  const data = body || {};
  const dest = normalisePath(data.path);
  const src = ctx.state.path;
  if (path.resolve(dest) === path.resolve(src)) {
    bad('Choose a location other than the current database file', 409);
  }
  if (fs.existsSync(dest)) bad('A file already exists at that location', 409);
  ctx.authorizeWrite(dest); // confirm non-dialog destinations (see create)

  // Flush pending writes so the on-disk bytes are current before we copy them.
  // (Default rollback-journal mode already commits to the main file; the
  // checkpoint is a no-op there but keeps this correct if WAL is ever enabled.)
  try {
    ctx.db().pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // not in WAL mode — nothing to checkpoint
  }

  try {
    const parent = path.dirname(dest);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    // COPYFILE_EXCL closes the race between the existsSync check above and the
    // write: if a file appeared in between, fail rather than clobber it.
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    bad(`Cannot save a copy there: ${e.code || e.constructor.name}`);
  }

  return ctx.switchTo(dest, ctx.state.encrypted, ctx.state.key);
}

function open(ctx, { body }) {
  const data = body || {};
  const p = normalisePath(data.path);
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) bad('No file found at that location', 404);

  // Encryption is detected from the file itself: a plaintext SQLite file has
  // a fixed 16-byte magic header; a SQLCipher file does not.
  let header;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      header = Buffer.alloc(16);
      const n = fs.readSync(fd, header, 0, 16, 0);
      header = header.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    bad(`Cannot read that file: ${e.code || e.constructor.name}`);
  }

  const encrypted = !(header.length >= 16 && header.equals(SQLITE_MAGIC));
  return activateExisting(ctx, p, encrypted, data.password);
}

function unlock(ctx, { body }) {
  if (!ctx.state.locked) return ctx.statusPayload();
  const data = body || {};
  return activateExisting(ctx, ctx.state.path, true, data.password);
}

/** Re-protect the active (encrypted) DB — drops the key, flips to locked. */
function lock(ctx) {
  return ctx.lock();
}

/** Change the active DB's encryption in place: encrypt / change / decrypt.
 *  Validation + the file-backup rollback live in conn.rekey(); this just maps
 *  the request shape onto it. */
function encryption(ctx, { body }) {
  const data = body || {};
  const action = data.action;
  if (action !== 'encrypt' && action !== 'change' && action !== 'decrypt') {
    bad('unknown encryption action');
  }
  return ctx.rekey({
    action,
    currentPassword: data.currentPassword,
    newPassword: data.newPassword,
  });
}

function activateExisting(ctx, p, encrypted, password) {
  let err;
  let key;
  if (encrypted) {
    if (typeof password !== 'string' || !password) bad('password_required', 401);
    if (!verifyKey(p, password)) bad('invalid_password', 401);
    err = validateFinanceDb(() => connect(p, password));
    key = password;
  } else {
    err = validateFinanceDb(() => connect(p, null));
    key = null;
  }
  if (err) bad(err);
  return ctx.switchTo(p, encrypted, key);
}

const routes = [
  ['GET', '/api/db/status', status],
  ['GET', '/api/db/browse', browse],
  ['POST', '/api/db/create', create],
  ['POST', '/api/db/save-as', saveAs],
  ['POST', '/api/db/open', open],
  ['POST', '/api/db/unlock', unlock],
  ['POST', '/api/db/lock', lock],
  ['POST', '/api/db/encryption', encryption],
];

// normalisePath is shared with the transactions-export route, which accepts
// a user-chosen destination path under the same rules as create/open.
module.exports = { routes, normalisePath };
