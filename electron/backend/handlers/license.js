'use strict';

// License endpoints. The only handler that touches no database: activation has
// to work before a DB is unlocked (and before one exists at all), which is why
// router.js exempts /api/license from the 423 lock alongside /api/db.

const license = require('../license');
const { bad } = require('../validate');

// The message text for each reason code, kept here so the renderer does not
// map reason codes itself.
const REASONS = {
  malformed: "That key doesn't look complete. Copy the whole key from the activation page and try again.",
  unknown_key: 'That key was issued for a different version of Aventurine.',
  bad_signature: "That key isn't valid. Check for a missed character, or re-run activation to get a fresh copy.",
  entitlement: 'That license covers an earlier version. Visit the activation page to get a key for this one.',
};

function shape(st) {
  return {
    state: st.state,
    licensed: st.state === 'licensed',
    appMajor: license.appMajor(),
    license: st.license ?? null,
    ...(st.reason ? { reason: st.reason, message: REASONS[st.reason] } : {}),
  };
}

function get() {
  return shape(license.status());
}

/** Read a key WITHOUT storing it, so the panel can show the registered address
 *  before the user activates. Verification happens here rather than in the
 *  renderer: the public key and the verification result stay in the main
 *  process, where a page cannot modify them. */
function preview(ctx, { body }) {
  const key = (body || {}).key;
  if (typeof key !== 'string') bad('key must be a string');
  const res = license.verify(key);
  if (!res.ok) {
    bad(REASONS[res.reason] || 'That key could not be verified.', 400, { reason: res.reason });
  }
  return { license: res.license };
}

function activate(ctx, { body }) {
  const key = (body || {}).key;
  if (typeof key !== 'string') bad('key must be a string');
  const res = license.activate(key);
  if (!res.ok) {
    bad(REASONS[res.reason] || 'That key could not be verified.', 400, { reason: res.reason });
  }
  return shape(license.status());
}

function deactivate() {
  license.deactivate();
  return shape(license.status());
}

const routes = [
  ['GET', '/api/license', get],
  ['POST', '/api/license/preview', preview],
  ['POST', '/api/license/activate', activate],
  ['DELETE', '/api/license', deactivate],
];

module.exports = { routes };
