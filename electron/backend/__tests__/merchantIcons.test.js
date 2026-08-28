'use strict';

// Integrity fence for the bundled merchant brand icons (static/merchant-icons/
// + the generated static/js/core/merchant-icons.js), which are produced by
// scripts/fetch-merchant-icons.js from the merchant lexicon.
//
// Three things can break here without producing an error — a wrong avatar is not
// a crash, it is the wrong logo beside a merchant:
//   1. The manifest and the files do not match (icons pruned, manifest stale), so
//      the ledger renders broken images.
//   2. The manifest holds a slug no merchant can produce — an unreachable entry
//      counted as coverage, the same case lexiconLint.test.js checks for
//      DISPLAY_OVERRIDES.
//   3. The two slug functions diverge. The renderer cannot require() the lexicon
//      (nodeIntegration is off), so avatar.js:merchantIconSlug and
//      fetch-merchant-icons.js:slugify are two hand-maintained copies of one
//      rule. If they differ, EVERY icon stops matching, with no error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { MERCHANTS, merchantDisplayFor } = require('../services/merchantCategories.js');
const { slugify } = require('../../scripts/fetch-merchant-icons.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ICON_DIR = path.join(REPO_ROOT, 'static', 'merchant-icons');
const MANIFEST = path.join(REPO_ROOT, 'static', 'js', 'core', 'merchant-icons.js');
const AVATAR_JS = path.join(REPO_ROOT, 'static', 'js', 'core', 'avatar.js');

// avatar.js is a browser IIFE that hangs its exports off `window`; run it in a
// sandbox with the globals it touches so the real shipped file is what gets
// tested, not a copy of it.
function loadAvatar() {
  const sandbox = {
    window: {},
    document: { addEventListener() {} },
    escapeHtml: (s) => String(s),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(AVATAR_JS, 'utf8'), sandbox, { filename: 'avatar.js' });
  return sandbox.window;
}

function loadManifest() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(MANIFEST, 'utf8'), sandbox, { filename: 'merchant-icons.js' });
  return sandbox.window.MERCHANT_ICONS;
}

test('the two slug implementations agree', () => {
  const { merchantIconSlug } = loadAvatar();
  assert.strictEqual(typeof merchantIconSlug, 'function');

  // Every label the app can actually put through it, plus the shapes that make
  // the two definitions differ if one is edited carelessly.
  const labels = [
    ...MERCHANTS.map(([needle]) => needle),
    ...MERCHANTS.map(([needle]) => merchantDisplayFor(needle)).filter(Boolean),
    "Trader Joe's", 'Bath & Body Works', 'Stop & Shop', 'H-E-B', 'Chick-fil-A',
    'P.F. Chang\'s', 'E*TRADE', 'Disney+', '99 Ranch', 'Buc-ee\'s',
    'SQ *BLUE BOTTLE COFFEE 866-123 CA', '  spaced  out  ', '', null, undefined,
    'ÜBER', 'café', '7-Eleven',
  ];
  for (const label of labels) {
    assert.strictEqual(
      merchantIconSlug(label), slugify(label),
      `slug mismatch for ${JSON.stringify(label)} — avatar.js and ` +
      'fetch-merchant-icons.js must produce identical slugs',
    );
  }
});

test('every manifest entry points at a file that exists', () => {
  const map = loadManifest();
  assert.ok(map && typeof map === 'object', 'merchant-icons.js must define window.MERCHANT_ICONS');

  const missing = [...new Set(Object.values(map))]
    .filter((file) => !fs.existsSync(path.join(ICON_DIR, `${file}.png`)));
  assert.deepStrictEqual(
    missing, [],
    'manifest references icons that are not on disk — re-run ' +
    '`node scripts/fetch-merchant-icons.js --manifest`',
  );
});

test('every icon on disk is reachable from the manifest', () => {
  const map = loadManifest();
  const referenced = new Set(Object.values(map));
  const orphaned = fs.existsSync(ICON_DIR)
    ? fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -4))
      .filter((slug) => !referenced.has(slug))
    : [];
  assert.deepStrictEqual(
    orphaned, [],
    'icons are shipped that nothing can ever display — re-run ' +
    '`node scripts/fetch-merchant-icons.js --manifest`',
  );
});

test('every manifest slug is one a merchant label can produce', () => {
  const map = loadManifest();
  const reachable = new Set();
  for (const [needle] of MERCHANTS) {
    reachable.add(slugify(needle));
    const display = merchantDisplayFor(needle);
    if (display) reachable.add(slugify(display));
  }
  const unreachable = Object.keys(map).filter((slug) => !reachable.has(slug));
  assert.deepStrictEqual(
    unreachable, [],
    'manifest slugs that no lexicon needle or display name maps to (a merchant ' +
    'was renamed or removed) — re-run `node scripts/fetch-merchant-icons.js --manifest`',
  );
});

test('icons are small, square PNGs', () => {
  if (!fs.existsSync(ICON_DIR)) return;
  const files = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.png'));
  // Nothing forces the sweep to have run; but if it has, the assets ship in
  // every package, so an un-normalized file is a real size regression.
  const oversized = [];
  for (const f of files) {
    const p = path.join(ICON_DIR, f);
    const size = fs.statSync(p).size;
    if (size > 12 * 1024) oversized.push(`${f} (${size}B)`);
    const head = fs.readFileSync(p).subarray(0, 8);
    assert.strictEqual(
      head.toString('latin1', 1, 4), 'PNG',
      `${f} is not a PNG — the normalize step writes PNG only`,
    );
  }
  assert.deepStrictEqual(
    oversized, [],
    'icons above the size the 48px normalize step produces — they were not ' +
    'written by fetch-merchant-icons.js',
  );
});

test('no needle alias is claimed by two different brands', () => {
  const map = loadManifest();
  // Two display names that slug alike are the same brand written two ways
  // ("ButcherBox" / "Butcher Box"); slugging is meant to merge those, and the
  // generator does. The harmful collision is an alias: every needle contributes a
  // slug pointing at its brand's icon, so if one needle spelling is reachable
  // from two brands, the manifest keeps whichever was processed first and the
  // other brand's rows render the wrong logo.
  const claims = new Map(); // alias slug -> Set(brand slug)
  for (const [needle] of MERCHANTS) {
    const display = merchantDisplayFor(needle);
    if (!display) continue;
    const brand = slugify(display);
    const alias = slugify(needle);
    if (!alias || !map[alias]) continue; // no icon shipped, nothing to get wrong
    if (!claims.has(alias)) claims.set(alias, new Set());
    claims.get(alias).add(brand);
  }
  const contested = [...claims.entries()]
    .filter(([, brands]) => brands.size > 1)
    .map(([alias, brands]) => `${alias} -> ${[...brands].join(' / ')}`);
  assert.deepStrictEqual(
    contested, [],
    'these needle slugs are reachable from more than one brand, so one brand ' +
    'renders the other\'s logo',
  );
});
