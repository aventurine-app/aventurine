'use strict';

// License verification. The property under test is narrow and load-bearing:
// the app can CHECK a key and can never MINT one. Everything else here defends
// the wire format, since a format drift silently invalidates every key already
// sold.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../license');
const golden = require('./fixtures/license-format.json');

/** Install a public key at a slot for the duration of one test. */
function withKey(t, slot, rawB64) {
  const prev = L.PUBLIC_KEYS[slot];
  L.PUBLIC_KEYS[slot] = rawB64;
  t.after(() => {
    L.PUBLIC_KEYS[slot] = prev;
  });
}

/** A throwaway signer, so tests never depend on the production pair. */
function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
    sign: (body) => crypto.sign(null, body, privateKey),
  };
}

const BASE = {
  licenseId: L.licenseIdFor('GUM-TEST-0001'),
  issued: '2026-08-18',
  entitlement: 1,
  email: 'buyer@example.com',
};

// ─── Golden format ──────────────────────────────────────────────────────────

test('golden keys still verify and decode to the same fields', (t) => {
  withKey(t, 0, golden.publicKeySlot0);
  for (const c of golden.valid) {
    const res = L.verify(c.key, { major: 1 });
    assert.ok(res.ok, `${c.desc}: ${res.reason}`);
    assert.deepStrictEqual(res.license, c.expect, c.desc);
  }
});

// ─── The core property ──────────────────────────────────────────────────────

test('a key signed by anyone else is rejected', (t) => {
  const real = pair();
  const attacker = pair();
  withKey(t, 0, real.raw);

  const forged = L.encode(BASE, attacker.sign);
  assert.deepStrictEqual(L.verify(forged, { major: 1 }), { ok: false, reason: 'bad_signature' });
});

test('the email cannot be swapped without breaking the signature', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);

  // The watermark's whole job: a pirate must not be able to keep a valid key
  // and put a throwaway address on it.
  const issued = L.encode(BASE, real.sign);
  const buf = L.b32decode(issued);
  const emailAt = 14;
  Buffer.from('pirate@nowhere.xx').copy(buf, emailAt);
  assert.deepStrictEqual(
    L.verify(L.b32encode(buf), { major: 1 }),
    { ok: false, reason: 'bad_signature' }
  );
});

test('every single-byte tamper is caught', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const buf = L.b32decode(L.encode(BASE, real.sign));

  for (let i = 0; i < buf.length; i++) {
    const copy = Buffer.from(buf);
    copy[i] ^= 0x01;
    const res = L.verify(L.b32encode(copy), { major: 1 });
    assert.ok(!res.ok, `byte ${i} flipped but still verified`);
  }
});

// ─── Parsing ────────────────────────────────────────────────────────────────

test('formatting noise in a pasted key is tolerated', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const key = L.encode(BASE, real.sign);

  for (const variant of [
    key.replace(/(.{5})/g, '$1-'),
    key.replace(/(.{40})/g, '$1\n'),
    `  ${key.toLowerCase()}  `,
    key.replace(/(.{10})/g, '$1 '),
  ]) {
    assert.ok(L.verify(variant, { major: 1 }).ok, 'should survive reformatting');
  }
});

test('Crockford aliases fold, stray characters do not', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const key = L.encode(BASE, real.sign);

  // I/L -> 1 and O -> 0 are the classic transcription slips; they self-correct.
  const slipped = key.replace(/1/g, 'I').replace(/0/g, 'O');
  assert.ok(L.verify(slipped, { major: 1 }).ok, 'I/O aliases should fold back');

  // U is deliberately absent from the alphabet, so it is a paste error.
  assert.equal(L.verify(`${key}U`, { major: 1 }).reason, 'malformed');
  assert.equal(L.verify(key.replace(/./, '!'), { major: 1 }).reason, 'malformed');
});

test('junk, empties and truncations are malformed, never a crash', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const key = L.encode(BASE, real.sign);

  for (const junk of ['', '   ', null, undefined, 42, {}, 'HELLO', key.slice(0, 40), key.slice(0, -8)]) {
    const res = L.verify(junk, { major: 1 });
    assert.ok(!res.ok, `${JSON.stringify(junk)} must not verify`);
  }
});

test('an unpopulated key slot verifies nothing', (t) => {
  const real = pair();
  withKey(t, 0, null);
  assert.deepStrictEqual(
    L.verify(L.encode(BASE, real.sign), { major: 1 }),
    { ok: false, reason: 'unknown_key' }
  );
});

test('slots are independent, so rotation strands nobody', (t) => {
  const oldPair = pair();
  const newPair = pair();
  withKey(t, 0, oldPair.raw);
  withKey(t, 1, newPair.raw);

  assert.ok(L.verify(L.encode({ ...BASE, slot: 0 }, oldPair.sign), { major: 1 }).ok);
  assert.ok(L.verify(L.encode({ ...BASE, slot: 1 }, newPair.sign), { major: 1 }).ok);
  // A key is bound to its slot; the signature does not travel.
  assert.equal(
    L.verify(L.encode({ ...BASE, slot: 1 }, oldPair.sign), { major: 1 }).reason,
    'bad_signature'
  );
});

// ─── Entitlement ────────────────────────────────────────────────────────────

test('entitlement gates by major version and names the license', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const key = L.encode({ ...BASE, entitlement: 1 }, real.sign);

  assert.ok(L.verify(key, { major: 1 }).ok, '1.x covered');
  const res = L.verify(key, { major: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'entitlement');
  // The license still comes back, so the UI can say WHOSE license needs the
  // upgrade instead of showing a forgery warning to a paying customer.
  assert.equal(res.license.email, 'buyer@example.com');
});

// ─── Stored license ─────────────────────────────────────────────────────────

function withConfigDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-'));
  const prev = process.env.AVENTURINE_CONFIG_DIR;
  process.env.AVENTURINE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.AVENTURINE_CONFIG_DIR;
    else process.env.AVENTURINE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('activate stores, status re-verifies, deactivate forgets', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);

  assert.deepStrictEqual(L.status(), { state: 'unlicensed' });

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  assert.ok(L.activate(key).ok);

  const st = L.status();
  assert.equal(st.state, 'licensed');
  assert.equal(st.license.email, 'buyer@example.com');

  L.deactivate();
  assert.deepStrictEqual(L.status(), { state: 'unlicensed' });
});

test('a rejected key is not stored', (t) => {
  const real = pair();
  const attacker = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);

  assert.equal(L.activate(L.encode(BASE, attacker.sign)).ok, false);
  assert.deepStrictEqual(L.status(), { state: 'unlicensed' });
});

test('an edited license file reports invalid rather than licensed', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);

  L.activate(L.encode({ ...BASE, entitlement: 99 }, real.sign));
  // Only the KEY is stored, so hand-editing the file cannot fake a license:
  // the signature is re-checked on every read.
  fs.writeFileSync(L.licenseFile(), JSON.stringify({ key: 'NOTAKEY', email: 'me@x.com' }));
  assert.equal(L.status().state, 'invalid');
});

test('license.json lands outside the data directory', (t) => {
  const dir = withConfigDir(t);
  // It must not travel with a copied database (pointer file, backups).
  assert.equal(path.dirname(L.licenseFile()), dir);
  assert.notEqual(path.resolve(dir), path.resolve(process.env.AVENTURINE_DATA_DIR || '.data'));
});

// ─── API surface ────────────────────────────────────────────────────────────

const { makeClient } = require('./helpers');
const { createConn } = require('../conn');
const { dispatch } = require('../routes');

test('api: status, activate, deactivate', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);
  const c = makeClient(t);

  let r = c.get('/api/license');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(
    { state: r.body.state, licensed: r.body.licensed, license: r.body.license },
    { state: 'unlicensed', licensed: false, license: null }
  );

  r = c.post('/api/license/activate', { key: 'garbage' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'malformed');
  assert.ok(r.body.error.length > 10, 'carries copy the UI can show as-is');

  r = c.post('/api/license/activate', { key: L.encode({ ...BASE, entitlement: 99 }, real.sign) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.licensed, true);
  assert.equal(r.body.license.email, 'buyer@example.com');

  assert.equal(c.get('/api/license').body.licensed, true);
  assert.equal(c.del('/api/license').body.licensed, false);
  assert.equal(c.get('/api/license').body.licensed, false);
});

test('api: activation works while the database is still locked', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);

  // An encrypted DB restored from the pointer starts locked. A license belongs
  // to the INSTALL, so its panel must answer before any passphrase is supplied
  // — otherwise a user could never see why the app is gated.
  const c = makeClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-db-'));
  const p = path.join(dir, 'enc.db');
  assert.equal(c.post('/api/db/create', { path: p, encrypt: true, password: 'pw9' }).status, 200);

  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'active-db.json'), JSON.stringify({ path: p, encrypted: true }));
  const prevDbPath = process.env.AVENTURINE_DB_PATH;
  const prevDataDir = process.env.AVENTURINE_DATA_DIR;
  delete process.env.AVENTURINE_DB_PATH;
  process.env.AVENTURINE_DATA_DIR = dataDir;
  const conn2 = createConn();
  conn2.init();
  t.after(() => {
    conn2.closeAll();
    if (prevDbPath !== undefined) process.env.AVENTURINE_DB_PATH = prevDbPath;
    if (prevDataDir === undefined) delete process.env.AVENTURINE_DATA_DIR;
    else process.env.AVENTURINE_DATA_DIR = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(dispatch(conn2, 'GET', '/api/db/status', null).body.locked, true);
  assert.equal(dispatch(conn2, 'GET', '/api/data', null).status, 423, 'data still gated');

  assert.equal(dispatch(conn2, 'GET', '/api/license', null).status, 200);
  const activated = dispatch(conn2, 'POST', '/api/license/activate', {
    key: L.encode({ ...BASE, entitlement: 99 }, real.sign),
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.licensed, true);
});
