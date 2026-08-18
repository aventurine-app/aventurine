'use strict';

// Generate the Ed25519 pair that signs unlock keys. Run ONCE, offline, and
// treat the output as the crown jewels:
//
//   • PUBLIC (raw 32 bytes, base64) goes into PUBLIC_KEYS in backend/license.js
//     at the slot you are issuing under, and ships inside the app.
//   • PRIVATE (PKCS8 DER, base64) goes into the activation worker as a secret
//     (`wrangler secret put SIGNING_KEY_PKCS8`) and into an offline backup.
//     It must never be committed, logged, or pasted anywhere else — anyone
//     holding it can mint licenses for your product forever.
//
// Losing the private key is survivable: generate a new pair, add its public
// half at the NEXT slot, and issue under that slot. Every previously sold key
// keeps verifying against its own slot, so no customer is stranded.
//
//   node scripts/make-license-keypair.js

const crypto = require('node:crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// Strip the fixed 12-byte SPKI preamble; license.js stores and rebuilds the
// raw 32 bytes.
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });

console.log(`
PUBLIC KEY — paste into PUBLIC_KEYS in electron/backend/license.js
─────────────────────────────────────────────────────────────────
  '${rawPublic.toString('base64')}',

PRIVATE KEY — wrangler secret put SIGNING_KEY_PKCS8
─────────────────────────────────────────────────────────────────
${pkcs8.toString('base64')}

Back the private key up offline now. This is the only time it is printed.
`);
