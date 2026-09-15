'use strict';

// Route table + dispatcher. The IPC layer carries ordinary HTTP-shaped
// requests ({method, path, body}), so every call site reads like a fetch();
// this module is the URL map.
//
// Patterns name their typed params inline: '/api/transactions/<int:tx_id>'.
// The type is load-bearing, not decoration — it is what keeps a literal
// segment like '/api/transactions/similar' from being swallowed by an id
// pattern sitting next to it in the table.
//
// Dispatch contract (what api.js's fetch-mimic relies on):
//   dispatch(ctx, method, url, body) -> { status, body }
//   - handler returns a body object        -> 200
//   - handler throws ApiError(msg, status[, extra]) -> {ok:false, error:msg, ...extra}
//   - no route                              -> 404 {ok:false, error:'not found'}
//   - locked DB, non-/api/db/ path          -> 423 {ok:false, error:'db_locked'}
//     (the _check_db_lock middleware, relocated)

const fs = require('fs');
const path = require('path');

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

    // _check_db_lock, relocated: while the active DB is encrypted and no
    // passphrase has been supplied, every data API returns 423; /api/db/* stays
    // reachable so status/unlock/open/create work.
    // Segment-anchored on purpose: this is a deny gate, so a prefix that matches
    // more than it means to is an exemption nobody asked for. A bare startsWith
    // would let '/api/db' exempt a future '/api/dbexport'.
    const underPrefix = (p) => path === p || path.startsWith(p + '/');
    if (
      ctx.state.locked &&
      path.startsWith('/api/') &&
      !underPrefix('/api/db')
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
