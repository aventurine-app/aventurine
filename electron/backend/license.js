'use strict';

// ─── License verification ───────────────────────────────────────────────────
//
// Offline activation. The app ships a PUBLIC key and can therefore only CHECK
// unlock keys, never generate one — that asymmetry is the design. A symmetric
// scheme (hash or HMAC of the license + email) would put the recipe in this
// file, and since the source is published that recipe would be a keygen: anyone
// could supply their own email, compute a matching key, and unlock. With a
// signature the private half exists only in the activation worker, so a valid
// key proves that server verified the purchase with Gumroad.
//
// That is also what makes the email watermark effective. The address is inside
// the signed payload, so it cannot be replaced with a throwaway without breaking
// the signature: sharing a key means sharing the address that bought it.
//
// The app makes no network call, here or anywhere. Activation happens in the
// user's browser; this module only reads bytes the user pasted in.
//
// KEY FORMAT (v1) — Crockford base32 over:
//
//   byte  0      (format << 4) | keySlot     format 1, slot selects PUBLIC_KEYS
//   bytes 1-8    licenseId  = SHA-256(gumroad license key)[0..8]
//   bytes 9-10   issued     = days since 2020-01-01 (uint16 BE)
//   byte  11     entitlement= greatest app MAJOR version this license covers
//   byte  12     flags      (reserved, 0)
//   byte  13     emailLen   (1..255)
//   bytes 14..N  email, UTF-8
//   --------- everything above is signed ---------
//   last 64      Ed25519 signature
//
// `entitlement` is the upgrade lever: a key issued today covers 1.x, so when
// 2.0 ships every install returns to the activation page for a fresh key, and
// THAT request re-verifies against Gumroad live. That is how a refunded or
// charged-back purchase eventually stops working, with no clock in the app.
// REVOKED_LICENSE_IDS below is the targeted version of the same idea, for one
// key that has been published rather than for every key at a version boundary.
//
// The slot nibble is the rotation lever: if the signing key is ever exposed,
// issue under slot 1 and append its public half to PUBLIC_KEYS. Old keys still
// verify, so rotation does not invalidate existing licenses.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 1;
const HEADER_BYTES = 14;
const SIG_BYTES = 64;
const EPOCH_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86400000;

// Accepted signing keys, by slot. Each is the RAW 32-byte Ed25519 public key,
// base64. Generate a pair with `node scripts/make-license-keypair.js`; the
// private half goes in the activation worker's secrets and nowhere else.
//
// Slot 0 is a placeholder until the production pair is generated — no key
// verifies against it, so the app stays unlicensed rather than unlocking
// incorrectly. Tests push their own slot on and pop it off (see
// license.test.js).
const PUBLIC_KEYS = [
  // slot 0 — production. Private half lives only in the activation worker's
  // secrets (SIGNING_KEY_PKCS8) and an offline backup.
  'SbyQc1LuFC4Wh5uhuZpODQYIsEpIIPHEjks81JeZMLo=',
];

// ─── Revoked licenses ───────────────────────────────────────────────────────
//
// licenseIds that must stop unlocking this build: a key that has been published
// somewhere it should not have been. The ID is the handle rather than the unlock
// key itself because it is short, survives a re-issue (it is derived from the
// Gumroad key, and the worker returns a different unlock key each day), and is
// non-reversible. That last part matters: this file is published, so a list of
// real keys would be a list of WORKING keys.
//
// This is the weaker half of a pair, deliberately. The activation worker's deny
// list is what stops a leaked Gumroad key being exchanged for a fresh unlock key,
// and it bites the moment it deploys. This list only ever reaches someone who
// installs a build carrying it, because the app makes no network call and never
// will. Whoever never updates keeps working, which is the same bargain the whole
// offline design already made, and the reason the worker list is the first move
// and this one is the follow-up.
//
// Entries are lowercase hex, 16 characters. Get one from a Gumroad license key
// with `node scripts/license-id.js "<key>"`, or read it straight off About ->
// License in the copy being blocked. Add the SAME id to DENIED_LICENSE_IDS in
// the activation worker, or a blocked customer can simply re-activate.
const REVOKED_LICENSE_IDS = new Set([
  // '0123456789abcdef',
]);

// ─── Crockford base32 ───────────────────────────────────────────────────────
// Chosen over base64 because a key gets read aloud, retyped and pasted out of
// email clients: no case sensitivity, and I/L/O fold onto 1/1/0 so the classic
// transcription slips self-correct.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));
DECODE.set('I', 1);
DECODE.set('L', 1);
DECODE.set('O', 0);

function b32encode(buf) {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode, allowing the whitespace and dashes added when a key is formatted for
 *  readability. Any OTHER unexpected character is an error rather than being
 *  skipped, so a mangled paste is reported as such instead of failing later as
 *  a bad signature. */
function b32decode(str) {
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const ch of str.toUpperCase()) {
    if (ch === '-' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    const v = DECODE.get(ch);
    if (v === undefined) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── Verification ───────────────────────────────────────────────────────────

// An Ed25519 SPKI DER is a fixed 12-byte preamble followed by the raw 32-byte
// key, so the short raw form is stored in source and the DER form is rebuilt
// for createPublicKey at call time.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyForSlot(slot) {
  const raw = PUBLIC_KEYS[slot];
  if (!raw) return null;
  try {
    const der = Buffer.concat([SPKI_PREFIX, Buffer.from(raw, 'base64')]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** Current app MAJOR version — the number `entitlement` is compared against. */
function appMajor() {
  return parseInt(require('../package.json').version.split('.')[0], 10) || 0;
}

/**
 * Check an unlock key. Pure: no filesystem, no clock, no network.
 * @returns {{ok:true, license:object}|{ok:false, reason:string}}
 *   reason ∈ malformed | unknown_key | bad_signature | revoked | entitlement
 */
function verify(keyString, { major = appMajor() } = {}) {
  if (typeof keyString !== 'string' || !keyString.trim()) {
    return { ok: false, reason: 'malformed' };
  }
  const buf = b32decode(keyString.trim());
  if (!buf || buf.length < HEADER_BYTES + 1 + SIG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  const emailLen = buf[13];
  const bodyLen = HEADER_BYTES + emailLen;
  if (emailLen < 1 || buf.length !== bodyLen + SIG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }
  if (buf[0] >> 4 !== FORMAT) return { ok: false, reason: 'malformed' };

  const pub = publicKeyForSlot(buf[0] & 0x0f);
  if (!pub) return { ok: false, reason: 'unknown_key' };

  const body = buf.subarray(0, bodyLen);
  const sig = buf.subarray(bodyLen);
  if (!crypto.verify(null, body, pub, sig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const license = {
    licenseId: buf.subarray(1, 9).toString('hex'),
    issued: new Date(EPOCH_MS + buf.readUInt16BE(9) * DAY_MS).toISOString().slice(0, 10),
    entitlement: buf[11],
    email: body.subarray(HEADER_BYTES).toString('utf8'),
  };

  // Both of these are checked AFTER the signature so the caller can report WHICH
  // license was refused, rather than returning the same error for an invalid key.
  // Revocation is checked before entitlement because it is the more specific
  // answer: a blocked key is blocked at every version, and telling its holder to
  // visit the activation page for a fresh one would be a wild goose chase.
  if (REVOKED_LICENSE_IDS.has(license.licenseId)) {
    return { ok: false, reason: 'revoked', license };
  }
  if (license.entitlement < major) {
    return { ok: false, reason: 'entitlement', license };
  }
  return { ok: true, license };
}

/** Encode a payload. Exported for the minting scripts and the format fixture;
 *  the app never calls this, since it ships no private key. */
function encode({ slot = 0, licenseId, issued, entitlement, flags = 0, email }, sign) {
  const emailBuf = Buffer.from(email, 'utf8');
  if (emailBuf.length < 1 || emailBuf.length > 255) throw new Error('email length out of range');
  const body = Buffer.alloc(HEADER_BYTES + emailBuf.length);
  body[0] = (FORMAT << 4) | (slot & 0x0f);
  Buffer.from(licenseId, 'hex').copy(body, 1, 0, 8);
  body.writeUInt16BE(Math.round((Date.parse(issued) - EPOCH_MS) / DAY_MS), 9);
  body[11] = entitlement;
  body[12] = flags;
  body[13] = emailBuf.length;
  emailBuf.copy(body, HEADER_BYTES);
  return b32encode(Buffer.concat([body, sign(body)]));
}

/** The licenseId for a Gumroad license key — the stable, non-reversible handle
 *  the worker logs and the app displays for support. */
function licenseIdFor(gumroadKey) {
  return crypto.createHash('sha256').update(gumroadKey, 'utf8').digest().subarray(0, 8).toString('hex');
}

// ─── Stored license ─────────────────────────────────────────────────────────
//
// NOT in AVENTURINE_DATA_DIR: that directory travels with the user's database
// (pointer file, backups), and a license must not be copied along with it to
// another machine. It is stored beside the app profile instead.

function configDir() {
  const d = process.env.AVENTURINE_CONFIG_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const fallback = path.join(process.cwd(), '.config');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const licenseFile = () => path.join(configDir(), 'license.json');

/** The stored key string, or null. */
function readStoredKey() {
  try {
    const raw = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'));
    return typeof raw.key === 'string' ? raw.key : null;
  } catch {
    return null;
  }
}

function writeStoredKey(key) {
  const p = licenseFile();
  fs.writeFileSync(p, JSON.stringify({ key }, null, 2));
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort; may fail on Windows ACLs or unusual filesystems
  }
}

function clearStoredKey() {
  try {
    fs.unlinkSync(licenseFile());
  } catch {
    // already gone
  }
}

/** Re-verify whatever is on disk. The signature is the source of truth, so the
 *  stored form is the KEY, never a parsed record a tamperer could edit. */
function status() {
  const key = readStoredKey();
  if (!key) return { state: 'unlicensed' };
  const res = verify(key);
  if (!res.ok) return { state: 'invalid', reason: res.reason, license: res.license ?? null };
  return { state: 'licensed', license: res.license };
}

/** The gate's check, kept separate from status() because it runs on every
 *  mutating request. NOT cached: an Ed25519 verify plus a 200-byte read takes
 *  tens of microseconds, the app makes a handful of writes per interaction, and
 *  a cache could go stale or be modified between an activation and the next
 *  request. */
function isLicensed() {
  return status().state === 'licensed';
}

function activate(key) {
  const res = verify(key);
  if (!res.ok) return res;
  writeStoredKey(key.trim());
  return res;
}

module.exports = {
  verify,
  isLicensed,
  encode,
  licenseIdFor,
  status,
  activate,
  deactivate: clearStoredKey,
  appMajor,
  configDir,
  licenseFile,
  b32encode,
  b32decode,
  PUBLIC_KEYS,
  REVOKED_LICENSE_IDS,
  FORMAT,
};
