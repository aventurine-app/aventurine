'use strict';

// Activate a throwaway license for the current process.
//
// The 402 read-only gate (backend/router.js) applies to the real app, which is
// exactly what the verification scripts boot — so without this, every script
// that writes anything would fail against a fresh profile.
//
// This is NOT a bypass shipped to users. electron-builder's `files:` allowlist
// covers main.js, preload.js, backend/, node_modules/ and package.json;
// scripts/ is not in it and never reaches a packaged build. The pair is
// generated per run and its public half is pushed onto PUBLIC_KEYS in memory
// only, so nothing here can validate a key a user might hold, and no key minted
// here survives the process.
//
// Call it AFTER app.whenReady() — main.js sets AVENTURINE_CONFIG_DIR from
// userData in startBackend(), and its ready handler is registered first, so by
// the time a script's own handler runs the license lands in the right profile.
//
// For an interactive `npm start` loop, don't use this: generate the real pair
// once (scripts/make-license-keypair.js), then mint yourself a key
// (scripts/mint-license-key.js) and activate it through the UI like a customer.

const crypto = require('node:crypto');
const license = require('../../backend/license');

function installDevLicense({ email = 'dev@localhost' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  license.PUBLIC_KEYS[0] = publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(12)
    .toString('base64');

  const key = license.encode(
    {
      licenseId: '00'.repeat(8),
      issued: new Date().toISOString().slice(0, 10),
      // Every major version, so bumping package.json never turns the
      // verification scripts red on an entitlement check.
      entitlement: 255,
      email,
    },
    (body) => crypto.sign(null, body, privateKey)
  );

  const res = license.activate(key);
  if (!res.ok) throw new Error(`dev license failed to activate: ${res.reason}`);
  return res.license;
}

module.exports = { installDevLicense };
