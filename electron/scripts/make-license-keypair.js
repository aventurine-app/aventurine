'use strict';

// Generate the Ed25519 pair that signs unlock keys. Run ONCE, on a machine you
// trust, and treat the private half as the crown jewels: anyone holding it can
// mint licenses for your product forever.
//
//   node scripts/make-license-keypair.js [--out <dir>]
//
// The private key is written to a 0600 FILE and never printed. That is
// deliberate: anything on stdout ends up in scrollback, in a terminal log, and
// in whatever tooling you were running at the time. Pipe the file where it
// needs to go instead:
//
//   wrangler secret put SIGNING_KEY_PKCS8 < <dir>/aventurine-signing.pkcs8
//
// Then back the file up offline (a password manager is fine) and delete it from
// disk. Losing it is survivable — generate a new pair, add its public half at
// the NEXT slot in PUBLIC_KEYS, and issue under that slot, so every key already
// sold keeps verifying. Leaking it is not: you would have to rotate and reissue.
//
// The script refuses to overwrite an existing key file. Clobbering a signing
// key that is already in production would silently invalidate every license
// ever issued under it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const outDir = path.resolve(
  argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : os.homedir()
);
const privatePath = path.join(outDir, 'aventurine-signing.pkcs8');

if (fs.existsSync(privatePath)) {
  console.error(`Refusing to overwrite an existing signing key:\n  ${privatePath}\n`);
  console.error('If this key is live, overwriting it invalidates every license');
  console.error('already issued. Move it aside deliberately if you really mean to.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// license.js stores and rebuilds the raw 32 bytes, so strip the fixed 12-byte
// SPKI preamble here.
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(privatePath, pkcs8, { mode: 0o600 });
try {
  fs.chmodSync(privatePath, 0o600);
} catch {
  // best-effort; Windows ACLs may refuse
}

console.log(`
Signing pair generated.

PUBLIC KEY — paste into PUBLIC_KEYS[0] in electron/backend/license.js:

  '${rawPublic.toString('base64')}',

PRIVATE KEY — written to (mode 0600, NOT printed):

  ${privatePath}

Next:

  wrangler secret put SIGNING_KEY_PKCS8 < ${privatePath}

Then back that file up somewhere offline and delete it from disk. It is the
only thing that can mint licenses for your product, and it is not recoverable.
`);
