'use strict';

// ─── Preload bridge ─────────────────────────────────────────────────────────
//
// Runs in the renderer's isolated world before any page script. Exposes a
// tiny, well-defined API to the page via contextBridge — narrower than full
// IPC access on purpose. The renderer is sandboxed with nodeIntegration off
// and loads only app:// pages, so this bridge is its sole path to the main
// process; keeping that surface minimal is the whole point.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
    minimize:       () => ipcRenderer.send('window-min'),
    toggleMaximize: () => ipcRenderer.send('window-max'),
    close:          () => ipcRenderer.send('window-close'),
    // Apply a Chromium zoom level. Renderer keeps the canonical value in
    // localStorage and pushes it here whenever the user adjusts.
    setZoom:        (level) => ipcRenderer.send('zoom-set', level),
    // Host OS, so the custom title bar can dress its window controls to match
    // the platform (traffic lights on macOS, square controls on Windows/Linux).
    // 'darwin' | 'win32' | 'linux' — a plain string, read pre-paint in
    // theme-init.js. `process` is the limited global Electron injects into
    // sandboxed preloads, which still carries `platform`.
    platform:       process.platform,

    // ── Session history (static/js/shell/history.js) ──────────────────────
    // The renderer moves itself with history.back()/forward(); it only needs to
    // be told which directions exist, because a document cannot read its own
    // position in session history. Read-only, and read once per load — every
    // move replaces the document.
    navState:       () => ipcRenderer.invoke('nav-state'),
    // The mouse's side buttons arrive in the main process as window
    // 'app-command's, which Electron reports without acting on. `fn` receives
    // 'back' or 'forward'; the renderer decides what to do with it, so the lock
    // gate stays in one place. Registered once per document, which the page
    // load then discards along with the rest of the world.
    onNavCommand:   (fn) => ipcRenderer.on('nav-command', (_e, direction) => fn(direction)),
});

// Native save/open dialogs for the New / Open Database modal. Each returns a
// Promise resolving to an absolute path string, or null when cancelled; no
// filesystem access is exposed to the page beyond picking a path.
contextBridge.exposeInMainWorld('electronFile', {
    // `suggested` (optional) is where the save dialog opens — the destination
    // the modal is already showing, so "Change…" starts from it.
    chooseNewDbPath:      (suggested) => ipcRenderer.invoke('db-choose-new-path', suggested),
    chooseExistingDbPath: () => ipcRenderer.invoke('db-choose-existing-path'),
    // Save dialog for Export Transactions; format selects the file filter and
    // suggested name. Same contract: a path string, or null on cancel.
    chooseExportPath:     (format) => ipcRenderer.invoke('export-choose-path', format),
});

// The installed version string, shown in About (static/js/shell/titlebar.js).
// Comes from the main process because a sandboxed preload has no access to the
// app module.
contextBridge.exposeInMainWorld('electronApp', {
    getVersion: () => ipcRenderer.invoke('app:version'),
});

// The data plane. Every /api/* call the page makes goes through here
// (static/js/core/api.js wraps it in a fetch-shaped interface) straight to the
// in-process backend — no HTTP server, no socket, no port. The renderer can
// only pass (method, url, body); routing and validation live in the main
// process (electron/backend/), so this bridge stays a dumb pipe.
contextBridge.exposeInMainWorld('financeApi', {
    request: (method, url, body) => ipcRenderer.invoke('api:request', method, url, body),
});
