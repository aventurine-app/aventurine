'use strict';

// Sort better-sqlite3-multiple-ciphers prebuilt binaries into ABI-specific
// directories so host Node (unit tests) and Electron (the app) share one
// node_modules with no rebuild step.
//
// How it works: the package loads its binary through `bindings`, whose
// candidate list includes `lib/binding/node-v{ABI}-{platform}-{arch}/` —
// an ABI-keyed path probed at require() time by whichever runtime is
// loading. We fetch the prebuild for each runtime once, park each at its
// ABI path, and remove build/Release (probed earlier, ABI-ambiguous).
//
// Runs as the package's postinstall hook, so any npm install/rebuild that
// regenerates build/Release gets re-sorted automatically.
//
// NOTE: Electron is pinned to a major with upstream prebuilds (see
// package.json); when no prebuild exists for a new Electron ABI the fetch
// fails loudly here. Unblock by bumping the dep once upstream publishes, or
// installing a C toolchain (make/gcc) so prebuild-install's fallback can
// compile from source. Packaged releases always compile in CI regardless.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3-multiple-ciphers');
const PREBUILD = path.join(__dirname, '..', 'node_modules', '.bin', 'prebuild-install');
const BUILT = path.join(PKG_DIR, 'build', 'Release', 'better_sqlite3.node');

const electronVersion = require('electron/package.json').version;
const electronAbi = require('node-abi').getAbi(electronVersion, 'electron');
const nodeAbi = process.versions.modules;

function fetchPrebuild(args) {
  execFileSync(PREBUILD, args, { cwd: PKG_DIR, stdio: 'inherit' });
}

function park(abi) {
  const dest = path.join(PKG_DIR, 'lib', 'binding', `node-v${abi}-${process.platform}-${process.arch}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(BUILT, path.join(dest, 'better_sqlite3.node'));
  console.log(`[native-abis] parked ABI ${abi} -> ${path.relative(PKG_DIR, dest)}`);
}

// Host Node first (prebuild-install with no runtime args targets it).
if (!fs.existsSync(BUILT)) fetchPrebuild([]);
park(nodeAbi);

// Then Electron.
fetchPrebuild(['--runtime=electron', `--target=${electronVersion}`, '--force']);
park(electronAbi);

// Remove the ambiguous shared location so each runtime falls through to its
// own ABI directory.
fs.rmSync(path.join(PKG_DIR, 'build'), { recursive: true, force: true });
console.log('[native-abis] removed build/ (ABI-ambiguous shared path)');
