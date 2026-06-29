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
});

// Native save/open dialogs for the New / Open Database modal. Each returns
// a Promise resolving to an absolute path string, or null when cancelled —
// no filesystem access is exposed to the page beyond picking a path.
contextBridge.exposeInMainWorld('electronFile', {
    chooseNewDbPath:      () => ipcRenderer.invoke('db-choose-new-path'),
    chooseExistingDbPath: () => ipcRenderer.invoke('db-choose-existing-path'),
    // Save dialog for Export Transactions; format selects the file filter
    // and suggested name. Same contract: a path string, or null on cancel.
    chooseExportPath:     (format) => ipcRenderer.invoke('export-choose-path', format),
});

// The data plane. Every /api/* call the page makes goes through here
// (static/js/api.js wraps it in a fetch-shaped interface) straight to the
// in-process backend — no HTTP server, no socket, no port. The renderer can
// only pass (method, url, body); routing and validation live in the main
// process (electron/backend/), so this bridge stays a dumb pipe.
contextBridge.exposeInMainWorld('financeApi', {
    request: (method, url, body) => ipcRenderer.invoke('api:request', method, url, body),
});
