'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved color theme before first paint. Loaded as a classic
// (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Sets the data-theme attribute on <html> from localStorage so the saved
// theme is the FIRST paint, with no flash of the default theme on nav.
//
// Stored 'color-theme' values: '' (light, the default), 'dark', 'colorful'
// (light, with an accent sidebar — see themes.css), or 'system' (follow the OS).
// 'system' is the only value that needs resolving; every other one IS the
// data-theme, so adding a theme means adding a CSS block and a picker button,
// not editing this file. The live picker (settings.js) keeps 'system' in sync
// when the OS preference flips while the app is open.
//
// 'ui-density' = 'compact' tightens table row heights (else comfortable). Both
// land on <html> as data-* before first paint to avoid a layout flash on nav.

(function () {
    const t = localStorage.getItem('color-theme');
    const effective = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')
        : t;
    if (effective) document.documentElement.dataset.theme = effective;

    if (localStorage.getItem('ui-density') === 'compact') {
        document.documentElement.dataset.density = 'compact';
    }

    // Activation screen, pre-paint. The backend is the authority on licensing
    // (electron/backend/router.js answers 402 to everything but /api/license
    // until a key is stored), but that verdict arrives over an async IPC round
    // trip, which is one paint too late: an activated user would see a flash of
    // the activation screen, and an unactivated one a flash of the app they
    // cannot use. So the last known verdict is cached here as a rendering hint
    // and the real status corrects it a moment later (shell/license.js).
    //
    // Nothing is gated on this value — forging it buys a view of an app whose
    // every request still returns 402 — which is why a spoofable store is the
    // right place for it.
    if (localStorage.getItem('license-activated') !== '1') {
        document.documentElement.dataset.licenseGate = 'on';
    }

    // Tag the host OS so the custom title bar (titlebar.css) can match the
    // platform's native window controls: macOS traffic lights on the left,
    // square Windows-style controls on the right elsewhere. Set pre-paint so
    // the bar never flashes the wrong layout. electronWindow comes from the
    // preload bridge; absent in a plain browser (no chrome there to style).
    const plat = window.electronWindow && window.electronWindow.platform;
    document.documentElement.dataset.platform =
        plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux';
}());
