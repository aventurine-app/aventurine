'use strict';

// Mint an unlock key locally, for development and for support requests.
// Production keys come from the activation worker, which verifies the purchase
// with Gumroad first; this script performs no verification on its inputs.
//
//   node scripts/mint-license-key.js --private <base64-pkcs8> \
//        --email buyer@example.com --license GUMROAD-KEY [--slot 0] [--entitlement 1]
//
// With no --private it generates a THROWAWAY pair and prints both halves, for
// testing a key end to end before the worker exists: paste the printed public
// key into PUBLIC_KEYS and the unlock key into the app.

const crypto = require('node:crypto');
const { encode, licenseIdFor, appMajor } = require('../backend/license');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

if (!args.email || !args.license) {
  console.error('usage: mint-license-key.js --email <addr> --license <gumroad-key> [--private <b64>] [--slot 0] [--entitlement N]');
  process.exit(1);
}

let privateKey;
let throwaway = null;
if (args.private) {
  privateKey = crypto.createPrivateKey({
    key: Buffer.from(args.private, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  throwaway = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
}

const key = encode(
  {
    slot: Number(args.slot ?? 0),
    licenseId: licenseIdFor(args.license),
    issued: new Date().toISOString().slice(0, 10),
    entitlement: Number(args.entitlement ?? Math.max(1, appMajor())),
    email: args.email,
  },
  (body) => crypto.sign(null, body, privateKey)
);

if (throwaway) {
  console.log(`\nTHROWAWAY public key — paste into PUBLIC_KEYS[${Number(args.slot ?? 0)}] in backend/license.js:\n  '${throwaway}',`);
}
console.log(`\nUNLOCK KEY for ${args.email}:\n\n${key.replace(/(.{50})/g, '$1\n')}\n`);
