'use strict';

// Route table + dispatcher. The IPC layer carries ordinary HTTP-shaped
// requests ({method, path, body}) so the frontend's fetch() call sites port
// 1:1; this module is the (much smaller) stand-in for Flask's URL map.
//
// Patterns use Flask's own syntax — '/api/transactions/<int:tx_id>' — so the
// route table in routes.js reads identically to the Python blueprints it
// replaces, greppable side by side during review.
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
function logBackendError(method, reqPath, e) {
  console.error(`[backend] ${method} ${reqPath} failed:`, e);
  try {
    const dir = process.env.FINANCE_LAB_DATA_DIR;
    if (!dir) return;
    fs.appendFileSync(
      path.join(dir, 'backend-errors.log'),
      `${new Date().toISOString()} ${method} ${reqPath}\n${(e && e.stack) || e}\n\n`
    );
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
    // passphrase has been supplied, every data API answers 423; /api/db/*
    // stays reachable so status/unlock/open/create work.
    if (
      ctx.state.locked &&
      path.startsWith('/api/') &&
      !path.startsWith('/api/db/')
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
          // malformed %-escape (e.g. a lone '%'). Decoding INSIDE the try
          // turns a bad path param into a clean 400 here; left outside, the
          // URIError would escape dispatch, reject the 'api:request' IPC
          // promise, and surface as an unhandled rejection in the renderer.
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
