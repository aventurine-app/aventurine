'use strict';

// ─── Title bar wiring ───────────────────────────────────────────────────
//   • Window controls (min / max / close) → ipc bridge in preload.js
//   • The open database's name, centered on the bar
//
// The File and Settings buttons live in the sidebar and are wired in nav.js.

(function () {
    const bar = document.querySelector('.titlebar');
    if (!bar) return;

    // ── Window controls ───────────────────────────────────────────────
    bar.addEventListener('click', e => {
        const btn = e.target.closest('.titlebar-btn[data-action]');
        if (!btn) return;
        const w = window.electronWindow;
        if (!w) return;
        switch (btn.dataset.action) {
            case 'min':   w.minimize();       break;
            case 'max':   w.toggleMaximize(); break;
            case 'close': w.close();          break;
        }
    });

    // ── Active database name (center of the bar) ──────────────────────
    // Show the file name of the open database. Every DB switch (New / Open /
    // Save As / Unlock) reloads the page, so reading status once on load is
    // enough — no live updates to maintain. A locked DB still reports its
    // path, so the name shows behind the unlock prompt too.
    const titleEl = bar.querySelector('.titlebar-title');
    if (titleEl) {
        dbStatus()
            .then(s => {
                const p = s && typeof s.path === 'string' ? s.path : '';
                titleEl.textContent = dbDisplayName(p);
                if (p) titleEl.title = p; // full path on hover
            })
            .catch(() => { /* status unreachable — leave the title blank */ });
    }

    // Basename of a DB path, minus a trailing SQLite extension — a clean
    // "name" to display, not the full filesystem path.
    function dbDisplayName(p) {
        if (!p) return '';
        const base = p.split(/[\\/]/).pop() || p;
        return base.replace(/\.(db|sqlite|sqlite3)$/i, '');
    }
}());
