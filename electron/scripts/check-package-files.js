'use strict';

// Guard against the "added a top-level electron/ file but forgot the
// electron-builder `files` allowlist" mistake. That `files:` list is an
// explicit allowlist (see electron-builder.yml): anything not named or globbed
// is silently dropped from the packaged app.asar. When the dropped file is app
// code that main.js require()s, the packaged app crashes at startup with
// "Cannot find module" — and nothing shows it in dev, where the file is right
// there on disk. (This is exactly what shipped a dead build once.)
//
// So: every top-level *.js in electron/ is app code that must ship. Dev-only
// scripts live under scripts/ (not globbed into the package), so they're out of
// scope here. This runs before every dist build (see package.json) and fails
// loudly if a top-level file isn't covered by the allowlist.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
const allow = new Set((cfg.files || []).filter((f) => typeof f === 'string'));

const topLevelJs = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.js') && fs.statSync(path.join(ROOT, f)).isFile());

const missing = topLevelJs.filter((f) => !allow.has(f));

if (missing.length) {
    console.error(
        '[check-package-files] FAIL — these top-level electron/ files are NOT in\n' +
        'the electron-builder `files` allowlist, so they would be dropped from the\n' +
        'packaged app.asar (the app then crashes at launch on require()):\n' +
        missing.map((f) => `    ${f}`).join('\n') +
        '\nAdd each to `files:` in electron-builder.yml.');
    process.exit(1);
}

console.log(`[check-package-files] ok — ${topLevelJs.length} top-level files all allowlisted`);

// ── Second guard: packaging icons vs. the app logo ───────────────────────────
// build/icon.png (linux) and build/icon.ico (win) are *copies* of the logo,
// rendered offline by scripts/make-icons.js — nothing regenerates them during a
// build. So editing static/icons/logo/logo.svg updates the title bar and leaves
// every installer, taskbar and launcher shipping the previous mark, silently.
// make-icons.js stamps the hash of the SVG it rendered from; compare it here.

const { sourceHash, SRC_SVG, BUILD_DIR, STAMP_FILE } = require('./make-icons.js');

const stampPath = path.join(BUILD_DIR, STAMP_FILE);
const stamped = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : null;
const current = sourceHash();

if (stamped !== current) {
    console.error(
        '[check-package-files] FAIL — the packaging icons in electron/build/ were\n' +
        `not rendered from the current ${path.relative(path.resolve(ROOT, '..'), SRC_SVG)}, so this\n` +
        'build would ship the old logo on every installer, launcher and taskbar.\n' +
        `    stamped: ${stamped || '(no stamp — icons predate the generator)'}\n` +
        `    current: ${current}\n` +
        'Run `node scripts/make-icons.js` and commit build/icon.png, build/icon.ico\n' +
        `and build/${STAMP_FILE}.`);
    process.exit(1);
}

console.log('[check-package-files] ok — build/icon.{png,ico} match the current logo.svg');
