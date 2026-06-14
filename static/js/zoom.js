'use strict';

// ─── App zoom ───────────────────────────────────────────────────────────────
// Ctrl/Cmd + +  : zoom in
// Ctrl/Cmd + -  : zoom out
// Ctrl/Cmd + 0  : reset to 100%
//
// The renderer owns the canonical zoom value (persisted in localStorage so
// it survives restarts). main.js just receives the new level over IPC and
// applies it to the live webContents.
//
// Chromium's zoom-level scale: each integer is ~20%; useful range is
// [-3, +5] → roughly 50% .. 250%. We step in halves for a smoother feel
// than full integer jumps.

(function () {
    if (!window.electronWindow) return;   // not running under Electron

    const STEP = 0.5;
    const MIN  = -3;
    const MAX  = 5;
    const KEY  = 'zoom_level';

    let level = parseFloat(localStorage.getItem(KEY) ?? '0');
    if (!isFinite(level)) level = 0;

    const apply = () => {
        localStorage.setItem(KEY, String(level));
        window.electronWindow.setZoom(level);
    };

    // Restore the saved level on every page load. New BrowserWindows /
    // navigations come up at 100% by default until we push the value back.
    if (level !== 0) apply();

    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        // = and + share a key (+ is shift+=); accept both. Same for the
        // numpad's dedicated +/- keys which also produce these `.key` values.
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            level = Math.min(MAX, level + STEP);
            apply();
        } else if (e.key === '-') {
            e.preventDefault();
            level = Math.max(MIN, level - STEP);
            apply();
        } else if (e.key === '0') {
            e.preventDefault();
            level = 0;
            apply();
        }
    });
}());
