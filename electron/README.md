# Electron shell for aventurine

The desktop app. Electron with an **in-process Node backend** (`backend/`):
the renderer talks to it over a single IPC channel — there is no HTTP server,
no socket, and no port. (The former Python/Flask backend was ported to Node
in June 2026; the port map lived in `MIGRATION.md`, since deleted — see git
history.)

## First-time setup

From this `electron/` directory:

```bash
flatpak-spawn --host npm install
```

`postinstall` (`scripts/setup-native-abis.js`) parks the prebuilt
`better-sqlite3-multiple-ciphers` binary at the ABI-keyed paths for both host
Node and Electron, so `npm test` and `npm start` share one `node_modules` with
no rebuild step. (Drops `node_modules/` next to this README.)

## Running

```bash
flatpak-spawn --host npm start    # the app
flatpak-spawn --host npm test     # backend test suite (host Node, no Electron)
flatpak-spawn --host npm run smoke            # backend stack under real Electron
flatpak-spawn --host npx electron scripts/verify-e2e.js   # boots the app, asserts from the renderer
```

What `npm start` does:

1. Electron starts and `main.js` sets `AVENTURINE_DATA_DIR` to `<userData>/data`.
2. `backend/conn.js` `init()` opens/migrates/seeds the SQLite DB in-process.
3. A window loads the `app://aventurine` scheme; pages come from `pages/*.html`
   (partials spliced in at serve time), static assets from `static/`.
4. The renderer calls `window.financeApi.request(...)` → `ipcMain.handle('api:request')`
   → `backend/router.js` `dispatch`.

Dev loop: renderer changes (HTML in `../pages/`, JS/CSS in `../static/`) →
Ctrl+R in the window. Backend changes (`backend/`, `main.js`, `preload.js`) →
restart `npm start`.

## Data location

User data (finance.db, the `active-db.json` pointer, backups) lives in the
OS-appropriate userData directory:

| OS      | Path                                                  |
| ------- | ----------------------------------------------------- |
| Linux   | `~/.config/Aventurine/data/`                 |
| macOS   | `~/Library/Application Support/Aventurine/data/` |
| Windows | `%APPDATA%\Aventurine\data\`                 |

(Packaged builds; `npm start` uses a separate `aventurine-dev` profile — see
main.js. Profiles from the app's Oliv era are migrated on first launch.)
First launch creates this directory and seeds a fresh DB.
`AVENTURINE_DB_PATH` overrides the DB path and suppresses pointer writes
(the test suite uses it).

## What to validate

- [ ] Electron window opens with the Home page rendered.
- [ ] Navigate to Income & Expenses; edit a cell.
- [ ] Close and re-launch. Your edit from the previous run is still there.

## Notes / limitations

- No app icon, no menu-bar customisation, no signing yet.
- No auto-reload on backend changes; restart the app to pick up backend edits.
  Frontend changes (JS/CSS/HTML) take effect on page refresh (Ctrl+R).
- Electron is pinned to a major with upstream `better-sqlite3-multiple-ciphers`
  prebuilds (no C toolchain on this machine); when bumping Electron, confirm a
  matching `electron-v<ABI>` release asset exists first.
