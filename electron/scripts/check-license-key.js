'use strict';

// Verify an unlock key against the public keys this build ships with.
//
//   node scripts/check-license-key.js "<key>"
//   node scripts/check-license-key.js < key.txt
//
// Two jobs. At DEPLOY time it is the gate on the riskiest seam in the whole
// licensing design: the activation worker and backend/license.js are two
// independent implementations of one wire format, and a drift between them is
// invisible until a paying customer cannot activate. Mint a key with the worker
// and run it through here before shipping either side.
//
// For support, it reports why a key fails to verify, requiring nothing from the
// customer but the key itself.

const { verify, appMajor, PUBLIC_KEYS } = require('../backend/license');

function main(key) {
  if (!key) {
    console.error('usage: check-license-key.js "<key>"   (or pipe it on stdin)');
    process.exit(2);
  }
  if (!PUBLIC_KEYS.some(Boolean)) {
    console.error('WARNING: no public keys are configured in backend/license.js,');
    console.error('so nothing can verify. Run scripts/make-license-keypair.js first.\n');
  }

  const res = verify(key);
  if (res.ok) {
    console.log('VALID');
    console.log(`  registered to  ${res.license.email}`);
    console.log(`  license id     ${res.license.licenseId}`);
    console.log(`  issued         ${res.license.issued}`);
    console.log(`  covers up to   ${res.license.entitlement}.x  (this build is ${appMajor()}.x)`);
    process.exit(0);
  }

  console.log(`INVALID (${res.reason})`);
  console.log({
    malformed: '  Not a well-formed key. Truncated paste, or a different format version.',
    unknown_key: '  Signed under a key slot this build does not carry. Wrong app version,\n  or the worker is issuing under a slot that was never shipped.',
    bad_signature: '  Well-formed but not signed by us. Either a forgery, a single mistyped\n  character, or the worker and this build disagree on the wire format.',
    revoked: `  Genuine, but ${res.license?.licenseId} is in REVOKED_LICENSE_IDS, so this\n  build refuses it. Sold to ${res.license?.email}.`,
    entitlement: `  Genuine, but covers ${res.license?.entitlement}.x and this build is ${appMajor()}.x.`,
  }[res.reason] || '');
  process.exit(1);
}

const arg = process.argv.slice(2).join(' ').trim();
if (arg) main(arg);
else {
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => main(buf.trim()));
}
