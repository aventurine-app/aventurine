'use strict';

// Fetch + park the macOS prebuilt binaries for
// better-sqlite3-multiple-ciphers at the Electron ABI, for BOTH darwin
// arches, so `npm run dist:mac` can produce an arm64 .dmg and an x64 .dmg
// from one runner (GitHub's macOS runners are Apple Silicon, so the Intel
// build is a cross-build even though the host is a Mac).
//
// This is the macOS companion to setup-win-abi.js (Windows cross-build) and
// setup-native-abis.js (the postinstall that parks the host-Node and
// host-arch Electron binaries for `npm test` / `npm start`). Same mechanism
// as both: the `bindings` loader probes lib/binding/node-v{ABI}-{platform}-
// {arch}/better_sqlite3.node at require() time, so parking a binary at that
// path is all it takes for the packaged app to load it.
//
// Not a postinstall step — it only matters when packaging for macOS, so
// `npm run dist:mac` runs it on demand. Re-parking the host arch (already
// done by postinstall) is harmless: it writes the same bytes back.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3-multiple-ciphers');
const PREBUILD = path.join(__dirname, '..', 'node_modules', '.bin', 'prebuild-install');
const BUILT = path.join(PKG_DIR, 'build', 'Release', 'better_sqlite3.node');

const electronVersion = require('electron/package.json').version;
const electronAbi = require('node-abi').getAbi(electronVersion, 'electron');

const PLATFORM = 'darwin';
const ARCHES = ['arm64', 'x64'];

for (const arch of ARCHES) {
    // Pull the darwin-<arch> prebuild for this Electron version into build/Release.
    execFileSync(
        PREBUILD,
        ['--runtime=electron', `--target=${electronVersion}`, `--platform=${PLATFORM}`, `--arch=${arch}`, '--force'],
        { cwd: PKG_DIR, stdio: 'inherit' },
    );

    // Park it at the ABI-keyed macOS path the runtime will probe.
    const dest = path.join(PKG_DIR, 'lib', 'binding', `node-v${electronAbi}-${PLATFORM}-${arch}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(BUILT, path.join(dest, 'better_sqlite3.node'));
    console.log(`[mac-abi] parked Electron ABI ${electronAbi} (${PLATFORM}-${arch}) -> ${path.relative(PKG_DIR, dest)}`);
}

// Remove the ABI-ambiguous shared location so each runtime falls through to
// its own ABI directory (the host binaries are already parked).
fs.rmSync(path.join(PKG_DIR, 'build'), { recursive: true, force: true });
console.log('[mac-abi] removed build/ (ABI-ambiguous shared path)');
