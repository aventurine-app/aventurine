'use strict';

// Route table + dispatcher. The IPC layer carries ordinary HTTP-shaped
// requests ({method, path, body}) so the frontend's fetch() call sites port
// 1:1; this module is the (much smaller) stand-in for Flask's URL map.
//
// Patterns use Flask's syntax — '/api/transactions/<int:tx_id>' — so the route
// table in routes.js matches the Python blueprints it replaced and the two
// grep side by side.
//
// Dispatch contract (what api.js's fetch-mimic relies on):
//   dispatch(ctx, method, url, body) -> { status, body }
//   - handler returns a body object        -> 200
//   - handler throws ApiError(msg, status[, extra]) -> {ok:false, error:msg, ...extra}
//   - no route                              -> 404 {ok:false, error:'not found'}
//   - unactivated install, any non-/api/license path
//                                           -> 402 {ok:false, error:'license_required'}
//     (the license gate below; checked first, since nothing else can happen)
//   - locked DB, non-/api/db/ path          -> 423 {ok:false, error:'db_locked'}
//     (the _check_db_lock middleware, relocated)

const fs = require('fs');
const path = require('path');
const { isLicensed } = require('./license');

const { ApiError } = require('./validate');

/** Persist an unexpected handler failure to <data dir>/backend-errors.log so
 *  it survives when the main-process console isn't visible (desktop launch).
 *  Best-effort: logging must never mask or replace the original failure. */
// Cap the log so a failure that repeats on every request cannot fill the disk.
// Past it the file is truncated rather than rotated: this is a debugging aid,
// the useful entries are the recent ones, and a second file would be a second
// thing carrying query text around.
const ERROR_LOG_MAX_BYTES = 1 << 20; // 1 MiB

function logBackendError(method, reqPath, e) {
  console.error(`[backend] ${method} ${reqPath} failed:`, e);
  try {
    const dir = process.env.AVENTURINE_DATA_DIR;
    if (!dir) return;
    const file = path.join(dir, 'backend-errors.log');
    // A SQLite error message can carry the statement that failed, so this file
    // can hold fragments of the user's ledger. It sits in the data dir, beside
    // finance.db for anyone on the default location. Owner-only, like the
    // database — appendFileSync creates with the umask (0644 on a typical Linux
    // account) and only applies a mode when it creates the file, so the chmod
    // is unconditional rather than create-only.
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first write */ }
    const entry = `${new Date().toISOString()} ${method} ${reqPath}\n${(e && e.stack) || e}\n\n`;
    if (size + entry.length > ERROR_LOG_MAX_BYTES) fs.writeFileSync(file, entry);
    else fs.appendFileSync(file, entry);
    fs.chmodSync(file, 0o600);
  } catch {
    // disk full / read-only data dir — nothing more we can do
  }
}

function compile(pattern) {
  const names = [];
  const types = [];
  const regexSrc = pattern
    .split('/')
    .map((seg) => {
      const m = /^<(?:(int):)?([A-Za-z_][A-Za-z0-9_]*)>$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[2]);
      types.push(m[1] || 'str');
      return m[1] === 'int' ? '(\\d+)' : '([^/]+)';
    })
    .join('/');
  const regex = new RegExp(`^${regexSrc}$`);
  return { regex, names, types };
}

// ─── License gate ───────────────────────────────────────────────────────────
//
// A SOFT gate: an unactivated install is a working transaction manager, and
// everything built on top of the ledger is what the key buys.
//
// This replaced a total lockout, which itself replaced a read-only gate. The
// lockout fixed one problem with the read-only version: a gate has to be
// stateable in one sentence, and "writes are refused" was not. The sentence
// here is "your transactions are free, the insights are paid", which is short
// enough to print on the locked screen.
//
// The upgrade path is what makes this shape worth it. A separately shipped demo
// build would need its own release, its own packaging gate, and a second
// download at the moment of purchase, and a database it created could exceed
// the paid build's schema version. One binary avoids all of that: the ledger
// built before purchase is kept, and activation is a paste rather than a
// re-install.
//
// The list below is an ALLOW list, so a new route is locked until it is
// explicitly freed. That is the safer default for a paid app: a feature left
// locked by mistake shows up the first time anyone uses it, while a feature
// left free by mistake does not.
//
// What is free, and why:
//   /api/license      activation would otherwise be impossible
//   /api/db/          a ledger needs a database to live in, including an
//                     encrypted one; blocking this would leave the free tier
//                     with nowhere to store data
//   /api/onboarding   first-run setup, which is how the ledger gets started
//   /api/app-settings theme, currency, auto-match. Preferences are not a
//                     feature, and a free tier that cannot be configured is
//                     not a representative sample of the paid one
//   /api/transactions the free tier IS this: list, edit, import, export
//   /api/categories   a ledger without categories is not a ledger
//   /api/balance/columns  Balance Sheet columns double as accounts, and import
//                     needs to pick one. The MONEY on the Balance Sheet lives
//                     at /api/balance/data and /api/balance/entry, which are
//                     not on this list
//   /api/data, /api/balance/data  the Dashboard's Month to Month section reads
//                     both. See the caveat below
//
// CAVEAT, accepted for now: those last two also feed the Dashboard's Year to
// Year section and the Statements grids, so the backend cannot distinguish a
// free reader from a paid one there. Year to Year is therefore HIDDEN in the
// renderer rather than locked, and the renderer ships as loose editable files,
// so that one section is a display choice and not a boundary. The fix, if it is
// ever wanted, is to trim both payloads to the current year while unlicensed;
// it was left out because it is the one place where licensing would change a
// response body instead of blocking an address.
//
// The gate lives HERE, in one place, rather than in the handlers: no feature
// module references licensing, the same arrangement as _check_db_lock. It also
// means bypassing it requires editing and rebuilding the app rather than
// changing something in the renderer, which is the limit of any offline
// scheme.
// Each entry frees ITSELF and its path segments below it, and nothing else —
// see the matcher. Trailing slashes are not needed and not used.
const FREE_PREFIXES = [
  '/api/license',
  '/api/db',
  '/api/onboarding',
  '/api/app-settings',
  '/api/transactions',
  '/api/categories',
  '/api/balance/columns',
];

// Matched whole, not by prefix, so freeing '/api/data' cannot accidentally
// free a future '/api/dataset'.
const FREE_EXACT = new Set(['/api/data', '/api/balance/data']);

// A prefix frees the address itself and everything under a '/' below it, never
// an address that merely STARTS with the same characters: a bare startsWith let
// '/api/transactions' free a future '/api/transactions-admin', and
// '/api/license' free '/api/licenses'. Nothing collides today; the point is
// that the list stays an allowlist as routes are added, which is the whole
// reason it is an allowlist rather than a deny list.
function isLicenseGated(path) {
  if (FREE_EXACT.has(path)) return false;
  return !FREE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function buildRouter(routes) {
  const compiled = routes.map(([method, pattern, fn]) => ({
    method,
    fn,
    ...compile(pattern),
  }));

  function dispatch(ctx, method, url, body) {
    const qIdx = url.indexOf('?');
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = Object.fromEntries(new URLSearchParams(qIdx === -1 ? '' : url.slice(qIdx + 1)));

    // Checked BEFORE the lock, the reverse of the read-only era. Then, a locked
    // encrypted DB reported 423 first because supplying the passphrase was the
    // next available action. Now it is not: an unactivated install cannot open,
    // unlock or read anything, so activation is the only next action, and
    // reporting the lock would prompt for a passphrase on a screen the user
    // cannot reach.
    if (path.startsWith('/api/') && isLicenseGated(path) && !isLicensed()) {
      return { status: 402, body: { ok: false, error: 'license_required' } };
    }

    // _check_db_lock, relocated: while the active DB is encrypted and no
    // passphrase has been supplied, every data API returns 423; /api/db/* stays
    // reachable so status/unlock/open/create work, and /api/license does too —
    // activation applies to the INSTALL, not to any one database, so it must
    // respond before and without an unlock.
    // Segment-anchored for the same reason as the license allowlist above: this
    // is a deny gate, so a prefix that matches more than it means to is an
    // exemption nobody asked for.
    const underPrefix = (p) => path === p || path.startsWith(p + '/');
    if (
      ctx.state.locked &&
      path.startsWith('/api/') &&
      !underPrefix('/api/db') &&
      !underPrefix('/api/license')
    ) {
      return { status: 423, body: { ok: false, error: 'db_locked' } };
    }

    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      try {
        const params = {};
        r.names.forEach((name, i) => {
          // SECURITY/ROBUSTNESS: decodeURIComponent throws URIError on a
          // malformed %-escape (e.g. a lone '%'). Decoding INSIDE the try turns
          // a bad path param into a 400 here; outside it, the URIError would
          // escape dispatch, reject the 'api:request' IPC promise, and appear as
          // an unhandled rejection in the renderer.
          params[name] =
            r.types[i] === 'int' ? parseInt(m[i + 1], 10) : decodeURIComponent(m[i + 1]);
        });
        const result = r.fn(ctx, { params, query, body: body ?? null });
        return { status: 200, body: result };
      } catch (e) {
        if (e instanceof ApiError) {
          return {
            status: e.status,
            body: { ok: false, error: e.message, ...(e.extra || {}) },
          };
        }
        if (e instanceof URIError) {
          // Malformed percent-encoding in a path param: a client error, not
          // a backend fault — don't log it as a 500 or leak internals.
          return { status: 400, body: { ok: false, error: 'bad request' } };
        }
        // Unexpected failure: log loudly, return a generic 500 (never leak
        // internals to the renderer).
        logBackendError(method, path, e);
        return { status: 500, body: { ok: false, error: 'internal error' } };
      }
    }
    return { status: 404, body: { ok: false, error: 'not found' } };
  }

  return { dispatch };
}

module.exports = { buildRouter };
