'use strict';

// Turn a Gumroad license key into the licenseId used by BOTH deny lists.
//
//   node scripts/license-id.js "<gumroad license key>"
//   node scripts/license-id.js < key.txt
//
// The id is SHA-256(key)[0..8] in hex: short, stable across re-issues, and
// non-reversible, which is what makes it safe to commit. Paste the same value
// into REVOKED_LICENSE_IDS in backend/license.js AND into DENIED_LICENSE_IDS in
// the activation worker. Only the worker takes effect without a release; the
// app's list reaches an install when it updates.
//
// A key that is already activated somewhere shows its id on About -> License,
// so a blocked customer can be identified from a screenshot alone.

const { licenseIdFor } = require('../backend/license');

function main(key) {
  if (!key) {
    console.error('usage: license-id.js "<gumroad license key>"   (or pipe it on stdin)');
    process.exit(2);
  }
  console.log(licenseIdFor(key));
}

const arg = process.argv.slice(2).join(' ').trim();
if (arg) main(arg);
else {
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => main(buf.trim()));
}
