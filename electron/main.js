// ─── Electron shell for oliv ─────────────────────────────────────────
//
// The backend lives in THIS process (electron/backend/) and the renderer
// reaches it over IPC ('api:request' → backend/routes.dispatch). There is no
// HTTP server, no socket, no port — which retires the whole localhost attack
// surface the Flask era needed middleware for (host allowlist, origin gate,
// per-launch token, DNS-rebinding defence): nothing else on the machine can
// reach a channel that only this renderer holds.
//
// Pages are pre-rendered static HTML in pages/ (see MIGRATION.md), served
// from the custom app:// scheme. The fixed origin (app://oliv) keeps
// localStorage (theme, currency symbol, zoom) stable across
// launches — no more persisted-port dance.

const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { initUpdater } = require('./updater');

const APP_HOST = 'oliv';
const APP_ORIGIN = `app://${APP_HOST}`;

// Repo layout: electron/ sits next to pages/ and static/.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(PROJECT_ROOT, 'pages');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');

// Route → page file, mirroring the old Flask pages blueprint so the
// navbar's absolute hrefs keep working unchanged.
const PAGE_ROUTES = {
    '/':                'home.html',
    '/income-expenses': 'income-expenses.html',
    '/balance-sheet':   'balance-sheet.html',
    '/portfolio':       'portfolio.html',
    '/categories':      'categories.html',
    '/transactions':    'transactions.html',
    '/credit-cards':    'credit-cards.html',
    '/budget':          'budget.html',
    '/cash-flow-forecast': 'cash-flow-forecast.html',
    '/spending-trends': 'spending-trends.html',
    '/report-card':     'report-card.html',
};

// app:// must be registered as standard+secure BEFORE app.whenReady so the
// renderer treats it as a normal origin (localStorage, fetch, etc.).
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Kill the default File/Edit/View menu — base.html owns the title bar.
Menu.setApplicationMenu(null);

// Dev (npm start) gets its own profile so it never shares state with an
// installed /opt/Oliv build. Both default to the 'oliv' userData dir, so
// running dev while the packaged app is open makes the second instance fight
// the first for the Chromium DOM-Storage LevelDB lock: the renderer's first
// localStorage access then stalls ~4s (twice — localStorage + sessionStorage)
// before falling back to in-memory, which is the "blank for seconds on launch"
// symptom. A distinct dev userData dir (its own Local Storage AND its own
// data/finance.db) sidesteps the collision entirely. Must run before
// whenReady → startBackend, which derives OLIV_DATA_DIR from userData.
if (!app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'oliv-dev'));
}

// ─── Backend (in-process) ───────────────────────────────────────────────────

let conn = null;
// The single app window. The updater broadcasts status to it (updater.js).
let mainWindow = null;

function startBackend() {
    // Same data-dir contract as the Flask era: <userData>/data.
    process.env.OLIV_DATA_DIR = path.join(app.getPath('userData'), 'data');
    const { createConn } = require('./backend/conn');
    const { dispatch } = require('./backend/routes');
    conn = createConn();
    conn.init();

    // The single data-plane channel. The renderer sends HTTP-shaped requests
    // (method, '/api/...', body); routing/validation/status codes all live in
    // backend/ — the bridge is a dumb pipe and never trusts the renderer.
    ipcMain.handle('api:request', (_e, method, url, body) => {
        if (typeof method !== 'string' || typeof url !== 'string') {
            return { status: 400, body: { ok: false, error: 'invalid request' } };
        }
        return dispatch(conn, method, url, body ?? null);
    });
}

// ─── Window-control + zoom IPC (unchanged from the Flask era) ───────────────

ipcMain.on('window-min', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('window-max', () => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else                 w.maximize();
});
ipcMain.on('window-close', () => BrowserWindow.getFocusedWindow()?.close());

ipcMain.on('zoom-set', (_e, level) => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    const clamped = Math.max(-3, Math.min(5, Number(level) || 0));
    w.webContents.setZoomLevel(clamped);
});

// Native file dialogs for the New / Open Database modal (dbactions.js).
// The renderer only ever receives a path string (or null); all file I/O
// happens in backend/, which validates the path itself.
const DB_FILE_FILTERS = [
    { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
    { name: 'All Files',       extensions: ['*'] },
];

ipcMain.handle('db-choose-new-path', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(w, {
        title:       'New Database',
        defaultPath: 'finance.db',
        filters:     DB_FILE_FILTERS,
    });
    return r.canceled ? null : r.filePath;
});

ipcMain.handle('db-choose-existing-path', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, {
        title:      'Open Database',
        properties: ['openFile'],
        filters:    DB_FILE_FILTERS,
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

// Save dialog for Export Transactions (txexport.js). The chosen format
// drives the filter and the suggested file name; the renderer's format
// string is untrusted, so anything unknown falls back to CSV.
const EXPORT_FILE_FILTERS = {
    csv: { name: 'CSV (Comma-Separated Values)',    extensions: ['csv'] },
    ofx: { name: 'OFX (Open Financial Exchange)',   extensions: ['ofx'] },
    qfx: { name: 'QFX (Quicken Web Connect)',       extensions: ['qfx'] },
    qif: { name: 'QIF (Quicken Interchange Format)', extensions: ['qif'] },
};

ipcMain.handle('export-choose-path', async (e, format) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const fmt = Object.prototype.hasOwnProperty.call(EXPORT_FILE_FILTERS, format)
        ? format : 'csv';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const r = await dialog.showSaveDialog(w, {
        title:       'Export Transactions',
        defaultPath: `transactions-${today}.${fmt}`,
        filters:     [EXPORT_FILE_FILTERS[fmt], { name: 'All Files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePath;
});

// ─── app:// protocol ────────────────────────────────────────────────────────

/** Resolve a decoded URL path inside `root`, refusing anything that escapes
 *  it (.. tricks, absolute injections). Returns the absolute path or null. */
function safeJoin(root, urlPath) {
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
    return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

// Text types get an explicit utf-8 Content-Type: there is no Flask response
// header any more to declare the charset, and without one Chromium falls back
// to windows-1252 (mojibake for every em-dash in the UI). The HTML also
// carries <meta charset="utf-8"> — this is the belt to that braces.
const TEXT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

async function serveFile(file) {
    const res = await net.fetch(pathToFileURL(file).href);
    const type = TEXT_TYPES[path.extname(file).toLowerCase()];
    if (!type) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Type', type);
    return new Response(res.body, { status: res.status, headers });
}

// The shared chrome (head CSS block, title bar, sidebar, settings/db modals,
// script block) lives once in pages/partials/ and is spliced into each page
// at its <!-- @include name --> markers — server-side includes without a
// server or a build step. Everything is read fresh per request so the normal
// dev loop (edit → Ctrl+R) covers partials too. A missing partial throws,
// which fails the page load loudly instead of shipping half a page.
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');
const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

async function servePage(file) {
    const html = (await fs.promises.readFile(file, 'utf8')).replace(
        INCLUDE_RE,
        (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'),
    );
    return new Response(html, {
        status:  200,
        headers: { 'Content-Type': TEXT_TYPES['.html'] },
    });
}

function registerAppProtocol() {
    protocol.handle('app', (request) => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
        // decodeURIComponent throws on a malformed %-escape; fail the request
        // closed (400) instead of letting the exception escape the handler.
        let p;
        try { p = decodeURIComponent(url.pathname); }
        catch { return new Response('bad request', { status: 400 }); }

        if (p in PAGE_ROUTES) {
            return servePage(path.join(PAGES_DIR, PAGE_ROUTES[p]));
        }
        if (p.startsWith('/static/')) {
            const file = safeJoin(STATIC_DIR, p.slice('/static/'.length));
            if (file) return serveFile(file);
        }
        return new Response('not found', { status: 404 });
    });
}

// ─── Window ─────────────────────────────────────────────────────────────────

async function createWindow() {
    const win = new BrowserWindow({
        width:  1280,
        height: 800,
        title:  'Oliv',
        // Frameless: the page draws its own title bar (base.html snapshot).
        frame:            false,
        backgroundColor:  '#212121',
        webPreferences: {
            // Set explicitly (not via defaults) so a future Electron major
            // or an accidental edit can't silently weaken them.
            contextIsolation: true,
            nodeIntegration:  false,
            sandbox:          true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    // One legitimate origin. Deny window.open entirely and block navigation
    // anywhere else, so even a successful XSS can't steer the window (and its
    // preload bridge) to remote content.
    //
    // NOTE: compare protocol+host, NOT URL.origin — Node's URL parser returns
    // the literal string "null" as the origin of any custom scheme, so an
    // origin comparison silently blocks every in-app link click.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, navUrl) => {
        let u = null;
        try { u = new URL(navUrl); } catch { /* malformed → block */ }
        if (!u || u.protocol !== 'app:' || u.host !== APP_HOST) e.preventDefault();
    });

    // The app needs no camera, mic, geolocation, notifications, USB, etc.
    const sess = win.webContents.session;
    sess.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);

    // Killing the default menu (above) also dropped its reload accelerators,
    // so the dev loop's "Ctrl+R to pick up renderer changes" went dead.
    // Wire reload back to the keys by hand. reload() re-fetches the current
    // page through the app:// handler (re-splicing partials) without leaving
    // the page the user is on.
    win.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        const key = input.key.toLowerCase();
        const isReload = key === 'f5' || (input.control && key === 'r');
        if (!isReload) return;
        e.preventDefault();
        win.webContents.reload();
    });

    mainWindow = win;
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

    await win.loadURL(`${APP_ORIGIN}/`);
    return win;
}

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    registerAppProtocol();
    try {
        startBackend();
    } catch (err) {
        console.error('[electron] backend failed to start:', err);
        dialog.showErrorBox('Oliv', `The database backend failed to start:\n${err.message}`);
        app.quit();
        return;
    }
    await createWindow();

    // In-app updates (packaged Windows only; inert IPC handlers elsewhere).
    initUpdater({ getWindow: () => mainWindow });

    // macOS: re-open the main window from the dock. No-op elsewhere.
    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // macOS convention: apps stay running after all windows close.
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (conn) {
        conn.closeAll();
        conn = null;
    }
});
