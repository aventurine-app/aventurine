'use strict';

// ─── escape.js ──────────────────────────────────────────────────────────────
// The one HTML escaper, loaded first by pages/partials/scripts.html — before
// every other script — so the global is available everywhere. Every
// user-controlled string MUST pass through this before being interpolated
// into innerHTML; forgetting it is the main XSS risk in this app (the CSP is
// the backstop, not the defence). It escapes quotes as well as angle
// brackets, so it is safe inside an attribute value too, not only in text.
//
// Five files previously each carried a copy (tables.js, dashboard.js,
// transactions.js, txfileimport.js, settingsCategories.js); they now all alias
// this global.

(function () {
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    window.escapeHtml = escapeHtml;
}());
