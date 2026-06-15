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
