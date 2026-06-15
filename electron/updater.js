// ─── Auto-update (packaged Windows only) ─────────────────────────────────────
//
// In-app updates via electron-updater against the GitHub Releases feed (the
// `publish:` block in electron-builder.yml). The renderer drives it over IPC:
// it subscribes to 'update:status' broadcasts and calls 'update:check' /
// 'update:download' / 'update:install' (static/js/updater.js + the About modal).
//
// Scope guard (load-bearing): updates run ONLY when app.isPackaged AND the
// platform is win32. In dev (npm start) the auto-updater has no real install
// to replace; on Linux the rpm/deb packages are owned by the system package
// manager, which electron-updater can't drive. In those cases we register
// inert IPC handlers that answer { supported:false } so the renderer hides its
// update UI without having to know the platform itself.
//
// Download is opt-in (autoDownload=false): we only tell the user an update
// exists; they click Download, then Restart to install. quitAndInstall swaps
// in the new app and relaunches. OLIV_DATA_DIR lives under userData and is
// never touched by the swap, so DBs and backups survive updates.

const { ipcMain, app } = require('electron');

const SUPPORTED = app.isPackaged && process.platform === 'win32';

function initUpdater({ getWindow }) {
    // Remember the latest status so a page that loads after an event still
    // learns it (the renderer asks via 'update:get-state' on open).
    let lastStatus = { state: SUPPORTED ? 'idle' : 'unsupported' };

    function broadcast(status) {
        lastStatus = status;
        const win = getWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send('update:status', { ...status, version: app.getVersion() });
        }
    }

    if (!SUPPORTED) {
        ipcMain.handle('update:get-state', () => ({
            supported: false, version: app.getVersion(), state: 'unsupported',
        }));
        const inert = () => ({ supported: false });
        ipcMain.handle('update:check', inert);
        ipcMain.handle('update:download', inert);
        ipcMain.handle('update:install', inert);
        return;
    }

    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;          // opt-in: user clicks Download
    autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update applies on next quit

    const fail = (err) => broadcast({ state: 'error', message: String(err?.message || err) });

    autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }));
    autoUpdater.on('update-available',     (info) => broadcast({ state: 'available', newVersion: info.version }));
    autoUpdater.on('update-not-available', () => broadcast({ state: 'up-to-date' }));
    autoUpdater.on('download-progress',    (p) => broadcast({ state: 'downloading', percent: p.percent }));
    autoUpdater.on('update-downloaded',    (info) => broadcast({ state: 'downloaded', newVersion: info.version }));
    autoUpdater.on('error', fail);

    ipcMain.handle('update:get-state', () => ({
        supported: true, version: app.getVersion(), ...lastStatus,
    }));

    ipcMain.handle('update:check', async () => {
        try { await autoUpdater.checkForUpdates(); return { ok: true }; }
        catch (err) { fail(err); return { ok: false }; }
    });

    ipcMain.handle('update:download', async () => {
        try { await autoUpdater.downloadUpdate(); return { ok: true }; }
        catch (err) { fail(err); return { ok: false }; }
    });

    // isSilent=false (run the NSIS step), isForceRunAfter=true (relaunch after).
    ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(false, true); return { ok: true }; });

    // Check once shortly after launch. Network/feed errors surface as an
    // 'error' status, never an unhandled rejection.
    autoUpdater.checkForUpdates().catch(fail);
}

module.exports = { initUpdater };
