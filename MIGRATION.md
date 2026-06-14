# Migration: Python/Flask backend → in-process Electron (Node) IPC

Status: **COMPLETE** (2026-06-11). The Python/Flask backend is removed; all
backend logic lives in the Electron main process (`electron/backend/`),
reached over IPC. This document remains as the record of how the port was
done and what was proven along the way.

Verification at completion:
- `npm test` — 68/68 (ported pytest suite + foundation + oracle parity)
- `npm run smoke` — backend stack under the real Electron runtime: PASS
- `electron scripts/verify-e2e.js` — real app boot, renderer asserts (IPC
  round-trip write, app:// navigation, live table render): 11/11 PASS
- Python-era artifacts deleted: app.py, routes/, services/, models/,
  migrations/, templates/ (snapshotted to pages/ first), tests/,
  bootstrap/config/dbstate/extensions/utils/year_table.py, requirements*,
  electron/build-python.sh, python-dist. Pre-refactor backup:
  `../Production-backup-20260611-070354.tar.gz`.

Notable deltas from the original plan (all documented in CLAUDE.md):
- The IPC layer carries HTTP-shaped requests through ONE channel
  ('api:request') into a route table keeping Flask pattern syntax — this let
  every frontend fetch() call site port mechanically to apiFetch().
- Electron pinned to 41.x: better-sqlite3-multiple-ciphers has no prebuild
  for Electron 42's ABI (146) yet and this machine lacks a C toolchain.
  scripts/setup-native-abis.js (postinstall) parks per-ABI prebuilds at the
  `bindings` ABI-keyed paths so host-Node tests and Electron share one
  node_modules. Bump Electron once upstream ships an ABI-146 prebuild.
- round2: Python's round(x,2) needed an exact BigInt float decomposition
  (ties-to-even on the exact value) — naive scaling diverges on 2.675 etc.
- predictions "today" is the LOCAL date (Python date.today() semantics).

## Why

The localhost HTTP server is the app's largest residual security surface — the
host allowlist, origin gate, per-launch token, DNS-rebinding defence, and the
"another local process/user can hit the port" risk all exist *only* because the
app talks to itself over a TCP socket other things can also reach. IPC has no
socket: that entire class of concern becomes structurally impossible rather than
mitigated. The app is pre-release (v0.1.0, zero installs), solo-developed, and
already vanilla-JS on the front end, so this is the cheapest moment to do it. It
also simplifies the code-signing/notarization story we're about to invest in
(one Electron app + one native module, vs. a recursively-signed PyInstaller
tree).

## De-risked up front

- **SQLCipher cross-binding compat — PROVEN.** A DB encrypted by the current
  Python `sqlcipher3-binary` (SQLCipher 4.12.0 defaults) opens in Node's
  `better-sqlite3-multiple-ciphers` with:
  ```js
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.pragma(`key=${JSON.stringify(passphrase)}`);
  ```
  Wrong key fails; default cipher fails. Existing users' encrypted DBs will open.
- **Toolchain:** host Node 22.22, npm 10.9, Electron 42.4. The binding installs
  from a prebuilt on host Node; the packaged app needs `electron-rebuild`
  against Electron's ABI (add to the build step).

## Architecture

- **Backend lives in `electron/backend/`**, all main-process modules:
  - `db.js` — connection management, SQLCipher keying, runtime engine rebind
    (replaces `dbstate.apply_engine_config`/`rebind_engine`).
  - `dbstate.js` — active-DB pointer (path + encrypted flag + in-memory key),
    `active-db.json` persistence (replaces `dbstate.py`).
  - `schema.js` — authoritative CREATE TABLE/INDEX DDL for a fresh DB (see Schema below).
  - `migrate.js` — `PRAGMA user_version` runner: a fresh DB (no app tables) gets
    the baseline + version stamp; an already-initialised DB is a no-op. Future
    numbered migrations climb from `SCHEMA_VERSION`.
  - `seed.js` — idempotent default seeding (port of `seed_defaults`).
  - `services/*.js` — **pure** ported logic (no DB handle): serializers,
    `applyTxFields`, predictions, match-rule confidence, credit-card average,
    and a faithful `difflib.SequenceMatcher.ratio` port (the 0.85/0.92
    thresholds were tuned against it).
  - `handlers/*.js` — one module per former blueprint. Each handler is an
    **importable plain function** `(db, payload) => result`; registration is
    `ipcMain.handle('domain:action', wrap(handlers.fn))` in `ipc.js`. This keeps
    the routes-thin/services-pure split the audit relied on and lets unit tests
    run without Electron.
- **Frontend seam:** `static/js/api.js` exposes the same call surface every page
  uses today, but routes through `window.financeApi.invoke('domain:action', payload)`
  (exposed by `preload.js` via `contextBridge`) instead of `fetch('/api/..')`.
  A **fixture-backed implementation** activates when `window.financeApi` is
  absent (plain browser), so pure-UI work needs no backend at all.
- **No network listener at all.** `main.js` stops spawning Python, stops the
  port dance, drops `waitForFlask`. The window loads from a custom `app://`
  protocol serving `templates/` + `static/` (more secure and origin-stable than
  `http://127.0.0.1:<port>`), or `loadFile` as a simpler first cut.

## Schema (authoritative baseline — see `schema.js`)

Tables: `active_years`, `app_settings`, `balance_active_years`, `balance_columns`,
`balance_entries`, `categories`, `category_sync`, `credit_cards`, `entries`,
`match_rules`, `portfolio_accounts`, `portfolio_entries`, `transactions`. Indexes
on the year/category/date/pattern columns (see `schema.js`).

Notes:
- `transactions.category_id` declares an FK to `categories(id)`, but the app runs
  with `foreign_keys` **OFF** and does manual existence checks in the handlers, so
  the constraint documents intent rather than being enforced at runtime.
- Per-table category sync lives in `category_sync(year, category)` — a row means
  that cell is computed from transactions rather than hand-entered.

## Migration runner

```
hasAppTables = table_exists('active_years')
if !hasAppTables:   createBaselineSchema(); PRAGMA user_version = SCHEMA_VERSION
// else: no-op today; future numbered migrations run for version < their number
seedDefaults()      // idempotent
```

Pre-ship there is no in-place migration or legacy-DB adoption path: changing the
baseline means recreating dev databases.

## IPC API surface (replaces the HTTP routes)

One channel per former endpoint, namespaced `domain:action`. Examples:
`data:get`, `entry:upsert`, `entry:delete`, `year:add`, `categories:list`,
`categories:create`, `tx:list`, `tx:create`, `tx:update`, `tx:import`,
`balance:*` (the year-table factory becomes a JS factory producing handler
sets), `portfolio:*`, `creditCards:*`, `predictions:upcoming`, `appSettings:*`,
`db:status|create|open|unlock|browse`. Validation helpers (`utils.py`:
`isFiniteNumber`, `cleanLabel`, `validateYear`, `parseEntry`) port to
`backend/validate.js` and stay the single copy.

## Port order (keeps the app runnable throughout — Python stays until the end)

1. **Data foundation** (`db`, `dbstate`, `schema`, `migrate`, `seed`) + unit
   tests proving it builds a correct schema and reads an existing Python DB. ← current
2. **Services** (pure) + unit tests (incl. a SequenceMatcher parity check).
3. **Validation helpers** + IPC handlers, unit-tested against a tempfile DB.
4. **Preload bridge + `api.js` seam + fixtures**; reroute every frontend
   `fetch('/api/..')` call site.
5. **Test suite** port to Vitest/`node:test`; Playwright E2E smoke for the
   critical paths (create/open/unlock DB, add tx, import).
6. **Switch `main.js`** to register IPC + serve via `app://`/`loadFile`; verify
   the real app end-to-end.
7. **Strip Python**: delete `app.py`, `routes/`, `services/*.py`, `models/`,
   `bootstrap.py`, `config.py`, `dbstate.py`, `utils.py`, `year_table.py`,
   `extensions.py`, `migrations/`, `requirements.txt`, `tests/*.py`,
   `electron/build-python.sh`, and the PyInstaller wiring. Update CLAUDE.md.

## Testing workflow after the cut

- UI change → Ctrl+R in the dev window (or plain browser with fixtures).
- Backend change → restart `npm start` (auto-restart via nodemon/electron-reload).
- Unit tests → `flatpak-spawn --host npx vitest` (host, no Electron).
- E2E → Playwright's Electron launcher.
- Never a full rebuild in dev; electron-builder runs only for releases.

## Rollback

Pre-refactor backup tarball: `../Production-backup-20260611-070354.tar.gz`.
