'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved color theme before first paint. Loaded as a classic
// (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Sets the data-theme attribute on <html> from localStorage so the saved
// theme is the FIRST paint, with no flash of the default theme on nav.

(function () {
    const t = localStorage.getItem('color-theme');
    if (t) document.documentElement.dataset.theme = t;
}());
