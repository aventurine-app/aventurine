'use strict';

// Fetch and stage the Windows (win32-x64) prebuilt binary for
// better-sqlite3-multiple-ciphers at the Electron ABI, so an electron-builder
// `--win` cross-build from this Linux host ships a binary that loads on Windows.
//
// The cross-platform counterpart to setup-native-abis.js (which stages the
// host-Node and Electron *linux* binaries for `npm test` / `npm start`). NOT a
// postinstall step — it applies only when packaging for Windows, so
// `npm run dist:win` runs it on demand. It uses the same `bindings` ABI-keyed
// probe path: at runtime on Windows the package looks for
// lib/binding/node-v{ABI}-win32-x64/better_sqlite3.node.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3-multiple-ciphers');
const PREBUILD = path.join(__dirname, '..', 'node_modules', '.bin', 'prebuild-install');
const BUILT = path.join(PKG_DIR, 'build', 'Release', 'better_sqlite3.node');

const electronVersion = require('electron/package.json').version;
const electronAbi = require('node-abi').getAbi(electronVersion, 'electron');

const PLATFORM = 'win32';
const ARCH = 'x64';

// Pull the win32-x64 prebuild for this Electron version into build/Release.
execFileSync(
  PREBUILD,
  ['--runtime=electron', `--target=${electronVersion}`, `--platform=${PLATFORM}`, `--arch=${ARCH}`, '--force'],
  { cwd: PKG_DIR, stdio: 'inherit' },
);

// Park it at the ABI-keyed Windows path the runtime will probe.
const dest = path.join(PKG_DIR, 'lib', 'binding', `node-v${electronAbi}-${PLATFORM}-${ARCH}`);
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(BUILT, path.join(dest, 'better_sqlite3.node'));
console.log(`[win-abi] parked Electron ABI ${electronAbi} (win32-x64) -> ${path.relative(PKG_DIR, dest)}`);

// Remove the ABI-ambiguous shared location so each runtime falls through to its
// matching ABI directory (the linux binaries are already staged).
fs.rmSync(path.join(PKG_DIR, 'build'), { recursive: true, force: true });
console.log('[win-abi] removed build/ (ABI-ambiguous shared path)');
