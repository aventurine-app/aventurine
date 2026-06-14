# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Product context (the "why"):** for long-term goals, target audience, business strategy, priorities, and product guardrails, read [.claude/PRODUCT.md](.claude/PRODUCT.md). Consult it when making product/UX/scope decisions; this file covers the technical "how".

## What this is

Finance Lab — a desktop personal-finance app. **Electron with an in-process Node backend** (`electron/backend/`): the renderer talks to it over one IPC channel, there is **no HTTP server, no socket, no port**. Plain JS/CSS frontend, no build step. The former Python/Flask backend was fully ported to Node in June 2026 (see `MIGRATION.md` for the port map and the proofs); behavior, validation rules, error strings, and status codes were preserved 1:1, verified by the ported test suite and Python-generated oracle fixtures.

## Running

```bash
cd electron
npm install        # postinstall sorts native-module ABIs (see below)
npm start          # the app
npm test           # backend test suite (host Node, no Electron needed)
npm run smoke      # backend stack under the real Electron runtime
npx electron scripts/verify-e2e.js   # boots the real app, asserts from inside the renderer
```

**Environment quirk:** inside the flatpak (Codium) sandbox, run Node tooling via `flatpak-spawn --host` (e.g. `flatpak-spawn --host npm test` from `electron/`). `flatpak-spawn` drops shell env vars — pass them with `--env=VAR=value`.

Dev loop: renderer changes (HTML in `pages/`, JS/CSS in `static/`) → Ctrl+R in the app window. Backend changes (`electron/backend/`, `main.js`, `preload.js`) → restart `npm start`.

Env vars: `FINANCE_LAB_DATA_DIR` (dir for finance.db, active-db pointer, backups; main.js sets it to `<userData>/data`; defaults to `./.data` outside Electron), `FINANCE_LAB_DB_PATH` (overrides the DB path AND suppresses pointer-file writes; the test suite uses it).

### Native module / ABI dance (load-bearing)

`better-sqlite3-multiple-ciphers` is ABI-specific. `electron/scripts/setup-native-abis.js` (postinstall) fetches the prebuilt binary for host Node *and* for Electron and parks each at the `bindings` ABI-keyed path (`lib/binding/node-v<ABI>-…`), so `npm test` (host Node) and `npm start` (Electron) share one node_modules with no rebuild step. **Electron is pinned to a major that has upstream prebuilds** (no C toolchain on this machine); when bumping Electron, check `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases` for a matching `electron-v<ABI>` asset first, or the postinstall will fail loudly. Packaged releases should compile from source in CI regardless.

## Architecture

### Backend (`electron/backend/`) — runs in the Electron main process

- `routes.js` — the full route table + `dispatch`. Routes keep **Flask pattern syntax** (`/api/transactions/<int:tx_id>`) so they grep side-by-side with the git history of the Python blueprints they replaced.
- `router.js` — pattern matcher + dispatcher. Contract: handlers return a body object (→ 200) or throw `ApiError(msg, status[, extra])` (→ `{ok:false, error, ...extra}`); unknown route → 404; while the DB is locked every `/api/*` except `/api/db/*` answers **423** (the relocated `_check_db_lock`).
- `conn.js` — `createConn()` owns the live DB handle: `init()` (startup open+migrate+seed, stays closed when locked), `db()` (throws 423 when locked), `switchTo(path, encrypted, key, {create})` with **rollback to the previous DB on failure** (state/handle are only swapped once the candidate is fully ready), pointer persistence, 0600 chmod on files we create.
- `db.js` — `connect(path, key)` / `verifyKey`. **SQLCipher recipe (the on-disk encryption format — do not change):** `cipher=sqlcipher` + `legacy=4` + quoted `key`. NUL bytes in passphrases rejected. `foreign_keys` stays OFF — referential rules live in the handlers, not the engine (the lib is compiled with FK enforcement on by default, so this is set explicitly).
- `dbstate.js` — `createDbState()` factory: active path / encrypted flag / in-memory passphrase (never on disk), `active-db.json` pointer in the data dir.
- `schema.js` — the authoritative baseline DDL for a fresh DB (`SCHEMA_VERSION`). Categories have **no** `sync` column; per-table sync lives in its own `category_sync(year, category)` table.
- `migrate.js` — `PRAGMA user_version` runner: a fresh DB (no app tables) gets the baseline + version stamp; an already-initialised DB is a no-op. Future numbered migrations climb from `SCHEMA_VERSION`. (Pre-ship: no in-place migrations or legacy-DB adoption yet — changing the baseline means recreating dev DBs.)
- `seed.js` — idempotent defaults (14 categories, balance columns, portfolio account, app settings).
- `validate.js` — the one copy of request validation (`bad`/`ApiError`, `cleanLabel`, `isFiniteNumber`, `validateYear`, `parseEntry`, `parseIsoDate`, `VALID_MONTHS`) **plus `round2`: an exact BigInt port of Python's `round(x, 2)` (ties-to-even on the exact float value)** — money rounding must stay bit-identical to what the Python era stored; it is oracle-verified in tests. Never replace with `Math.round`/`toFixed`.
- `services/` — pure logic, no DB handle except where noted: `transactions.js` (`applyTxFields` — the direction rule lives here, `serialiseTx`), `categories.js`, `predictions.js` (recurring-expense heuristics; "today" is the **local** date like Python's `date.today()`), `creditCards.js` (recent-active-months spend average), `matchRules.js` (learned auto-categorization **and `sequenceRatio` — a faithful `difflib.SequenceMatcher.ratio()` port** (Ratcliff/Obershelp + autojunk), oracle-verified; the 0.85 interactive / 0.92 unattended fuzzy thresholds were tuned against it — don't "simplify" it without re-running the parity test), `txExport.js` (CSV/OFX/QFX/QIF serialisers behind the chunked `POST /api/transactions/export` — each call writes one chunk of rows to `<path>.part`, the final one appends the footer and renames it into place; the chunking is what makes the renderer's export progress bar real).
- `handlers/` — one module per feature (`incomeExpenses`, `categories`, `transactions`, `portfolio`, `creditCards`, `predictions`, `appSettings`, `database`, plus the `yearTable.js` factory used by Balance Sheet only). Handlers are **importable plain functions** `(ctx, {params, query, body})` — registration stays in routes.js, logic stays testable without Electron. Multi-statement mutations are wrapped in `db.transaction(...)`. Per-table sync read/write helpers live in `categorySync.js` (`syncedMap`, `isSynced`), shared by `incomeExpenses` and `creditCards`.
- `__tests__/` — the test suite (`node --test`): foundation, service parity, and full API behavior. **Oracle fixtures** (`fixtures/*.json`, golden values) pin `sequenceRatio`, `detectRecurringExpenses`, `recentMonthlyAverage`, and `round2` to known-good output.

### IPC + shell (`electron/main.js`, `preload.js`)

- One data channel: renderer calls `window.financeApi.request(method, url, body)` (preload) → `ipcMain.handle('api:request')` → `dispatch`. The bridge is a dumb pipe; routing/validation live behind it.
- Pages are served from the custom **`app://finance-lab`** scheme (registered standard+secure pre-ready): `/` and the six other page routes map to `pages/*.html`, `/static/*` maps to `static/` with a path-traversal guard. Page serving expands `<!-- @include name -->` markers from `pages/partials/` (see Frontend below) — server-side includes without a server or build step; partials are read per request, so the edit → Ctrl+R loop covers them. Fixed origin → localStorage (theme, currency, zoom) is stable across launches — the Flask-era persisted-port dance is gone.
- Window hardening unchanged: `contextIsolation`, `sandbox`, `nodeIntegration:false`, `window.open` denied, `will-navigate` locked to the app origin, all Chromium permission requests denied.
- The Flask-era host-allowlist / origin-gate / per-launch-token middleware is **retired, not lost** — there is no socket for any of it to defend. CSP now ships as a `<meta>` tag in each page (no response headers without a server); same policy: `script-src 'self'`, **no inline scripts or inline event handlers anywhere**.

### Frontend (`pages/` + `static/`)

- `pages/*.html` — **the canonical HTML**, one file per page, holding only what's page-specific (`<title>`, page CSS, page content, page scripts) around four `<!-- @include name -->` markers. The shared chrome lives **once** in `pages/partials/`: `head.html` (CSP + `theme-init.js` + global CSS), `chrome.html` (title bar, File dropdown, Settings dropdown + modals), `sidebar.html` (navbar + DB modal), `scripts.html` (the shared script block). The `app://` handler in `electron/main.js` splices them in at serve time; `scripts/verify-e2e.js` walks every route to prove each page assembles. The sidebar's `.active` link is set by `static/js/nav.js` from the URL — don't bake it into markup. Caveat: opening a page file directly in a plain browser skips the handler, so the chrome is absent there (page content + fixtures still work).
- `static/js/api.js` — **the one data seam.** Every page calls `apiFetch()` (fetch-shaped); it routes to IPC under Electron, falls back to real `fetch` if ever served over http, and serves **static fixtures in a plain browser** — so pure-UI work needs no backend: just open a page file. Never call `fetch('/api/…')` directly.
- Script order (load-bearing, lives in `pages/partials/head.html` + `scripts.html`): `theme-init.js` (head, blocking — applies saved color theme pre-paint from localStorage) → `escape.js` → `api.js` → `currency.js` → `dbactions.js` → `settings.js` → `settingsCategories.js` → `store.js` → `titlebar.js`, `zoom.js`, `nav.js` → per-page script.
- `static/js/txexport.js` — Export Transactions modal (Transactions page): format picker (CSV/OFX/QFX/QIF), destination via the `electronFile.chooseExportPath` native save dialog (Browse… is hidden in a plain browser), and the chunk loop against `POST /api/transactions/export` that drives the progress bar.
- Everything else (escapeHtml discipline, tables.js debounced saves, store.js sessionStorage cache, dbactions.js DB modal incl. the 423 unlock prompt, txfileimport.js client-side parsers, currency input model) is unchanged from before the migration.

### Business rules (unchanged — still load-bearing)

- **Direction rule:** a categorized Transaction's `tx_type` is owned by `Category.cat_type` — `applyTxFields` derives it on write, list endpoints re-derive at read time, category re-type re-types referencing transactions, `categorize-similar` takes no `tx_type`. Explicit `tx_type` applies only to uncategorized rows (feeds the `uncat_income`/`uncat_expense` sync buckets).
- **Learned auto-categorization:** user assignments upsert MatchRules (normalized description → category); imports/creates auto-apply only on high confidence (exact always; fuzzy only in fuzzy mode at 0.92 with all rules agreeing); un-categorizing forgets the rule; category delete drops its rules and unlinks credit cards. Gated by `tx_auto_match`.
- **Sync mode (per-table):** sync is a `(year, category)` membership in `category_sync`, set per year-table from Cash Flow's ⋮ → **Sync Settings** modal (single, or Sync-all/Unsync-all). A synced cell is computed from transactions (`syncSums`, the `uncat_income`/`uncat_expense` buckets sum NULL-category rows by `tx_type`); manual writes to a synced cell 409. The same category can be synced in one year and hand-entered in another. `/api/data` ships a `sync: {yearStr:[catKey,…]}` map so the renderer makes synced cells read-only. `POST /api/year/<int:year>/sync` toggles it; year delete clears its rows, year duplicate copies them.
- **Numbers:** money stored as positive-magnitude floats rounded to cents at the write boundary via `round2`; `isFiniteNumber` rejects NaN/Infinity/booleans everywhere. Portfolio amount/price fields are exempt from rounding, not from finiteness.
- **DB management:** one SQLite DB at a time at any user-chosen path; SQLCipher encryption at creation; open validates (`quick_check` + `active_years`) **before** switching; encrypted DBs restored from the pointer start LOCKED (423 + unlock prompt) until the passphrase is supplied.
