'use strict';

// ─── escape.js ──────────────────────────────────────────────────────────────
// The one HTML escaper, loaded by base.html before every other script so the
// global is available everywhere. Every user-controlled string MUST pass
// through this before being interpolated into innerHTML — forgetting it is
// the main XSS risk in this app (the CSP is the backstop, not the defence).
//
// Previously five files each carried their own copy (tables.js, home.js,
// transactions.js, txfileimport.js, settingsCategories.js); they now all
// alias this global.

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
