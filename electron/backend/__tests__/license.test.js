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
  const c = makeClient(t, { licensed: false });

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
  const c = makeClient(t, { licensed: false });
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

// ─── The read-only gate ─────────────────────────────────────────────────────

/** An unlicensed client with an isolated (empty) config dir. */
function unlicensedClient(t) {
  withConfigDir(t);
  return makeClient(t, { licensed: false });
}

test('gate: unlicensed installs are read-only, not walled off', (t) => {
  const c = unlicensedClient(t);

  // Reads all answer normally — the user can always see their own finances.
  for (const url of ['/api/data', '/api/categories', '/api/transactions', '/api/onboarding']) {
    assert.equal(c.get(url).status, 200, `${url} should stay readable`);
  }

  // Writes are refused, whatever their shape.
  const refused = [
    ['POST', '/api/transactions', { amount: 5, description: 'x', date: '2026-01-01' }],
    ['POST', '/api/categories', { name: 'X', cat_type: 'expense' }],
    ['POST', '/api/entry', {}],
    ['POST', '/api/transactions/import', { rows: [] }],
    ['PUT', '/api/transactions/1', {}],
    ['PUT', '/api/categories/1', {}],
    ['DELETE', '/api/transactions/1', null],
    ['DELETE', '/api/entry', {}],
  ];
  for (const [method, url, body] of refused) {
    const r = c.conn && dispatch(c.conn, method, url, body);
    assert.equal(r.status, 402, `${method} ${url} should be gated`);
    assert.equal(r.body.error, 'license_required');
  }
});

test('gate: taking your data with you always works', (t) => {
  const c = unlicensedClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-exp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Export is a POST only because it needs a body. Refusing it would make the
  // gate a data-hostage situation rather than a pricing one.
  const out = path.join(dir, 'out.csv');
  const r = dispatch(c.conn, 'POST', '/api/transactions/export', {
    path: out, format: 'csv', offset: 0, limit: 100,
  });
  assert.notEqual(r.status, 402, 'export must not be gated');
});

test('gate: database and preference routes stay open', (t) => {
  const c = unlicensedClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-db2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Reaching your data is not entering data.
  assert.equal(dispatch(c.conn, 'POST', '/api/db/create', { path: path.join(dir, 'new.db') }).status, 200);
  // Preferences are not financial data; blocking them strands the user in
  // states they cannot leave.
  assert.equal(dispatch(c.conn, 'PUT', '/api/app-settings/tx_auto_match', { value: 'off' }).status, 200);
});

test('gate: activating lifts it immediately, removing puts it back', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  const tx = { amount: 5, description: 'coffee', date: '2026-01-01' };
  assert.equal(dispatch(c.conn, 'POST', '/api/transactions', tx).status, 402);

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  assert.equal(dispatch(c.conn, 'POST', '/api/license/activate', { key }).status, 200);
  // No restart, no cache to flush: the next request is already licensed.
  assert.equal(dispatch(c.conn, 'POST', '/api/transactions', tx).status, 200);

  assert.equal(dispatch(c.conn, 'DELETE', '/api/license', null).status, 200);
  assert.equal(dispatch(c.conn, 'POST', '/api/transactions', tx).status, 402);
});

test('gate: entitlement is what makes a paid major upgrade possible', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  // A genuine license that covers 1.x.
  L.activate(L.encode({ ...BASE, entitlement: 1 }, real.sign));
  const tx = { amount: 5, description: 'coffee', date: '2026-01-01' };
  assert.equal(dispatch(c.conn, 'POST', '/api/transactions', tx).status, 200);

  // Now ship 5.0. appMajor() reads the cached package.json object, so mutating
  // it is the real code path, not a stub.
  const pkg = require('../../package.json');
  const realVersion = pkg.version;
  t.after(() => { pkg.version = realVersion; });
  pkg.version = '5.0.0';

  // The same key, still perfectly valid, no longer unlocks: this is the whole
  // upgrade lever, and the reason a refunded purchase eventually stops working
  // without the app ever needing a revocation list or a clock.
  const r = dispatch(c.conn, 'POST', '/api/transactions', tx);
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'license_required');

  // And the UI can still name the customer rather than crying forgery.
  const st = dispatch(c.conn, 'GET', '/api/license', null).body;
  assert.equal(st.state, 'invalid');
  assert.equal(st.reason, 'entitlement');
  assert.equal(st.license.email, BASE.email);
});

test('gate: a locked database reports the lock, not the license', (t) => {
  const c = unlicensedClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = path.join(dir, 'enc.db');
  assert.equal(dispatch(c.conn, 'POST', '/api/db/create', { path: p, encrypt: true, password: 'pw9' }).status, 200);
  assert.equal(dispatch(c.conn, 'POST', '/api/db/lock', null).status, 200);

  // Both gates apply, but the lock is the one the user can act on next: leading
  // with licensing would send them to the wrong screen.
  const r = dispatch(c.conn, 'POST', '/api/transactions', { amount: 1, description: 'x', date: '2026-01-01' });
  assert.equal(r.status, 423);
  assert.equal(r.body.error, 'db_locked');
});

// ─── Preview ────────────────────────────────────────────────────────────────

test('api: preview reads a key back without storing it', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);
  const c = makeClient(t, { licensed: false });

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  const r = c.post('/api/license/preview', { key });
  assert.equal(r.status, 200);
  assert.equal(r.body.license.email, 'buyer@example.com');

  // The whole point: looking is not activating. A preview must leave the
  // install exactly as unlicensed as it found it, or pasting a key you decided
  // against would quietly commit it.
  assert.equal(c.get('/api/license').body.licensed, false);
  assert.equal(
    dispatch(c.conn, 'POST', '/api/transactions', { amount: 1, description: 'x', date: '2026-01-01' }).status,
    402
  );
});

test('api: preview rejects what activate would reject, with the same words', (t) => {
  const real = pair();
  const attacker = pair();
  withKey(t, 0, real.raw);
  withConfigDir(t);
  const c = makeClient(t, { licensed: false });

  for (const key of ['garbage', L.encode(BASE, attacker.sign)]) {
    const p = c.post('/api/license/preview', { key });
    const a = c.post('/api/license/activate', { key });
    assert.equal(p.status, 400);
    assert.equal(p.body.reason, a.body.reason, 'preview and activate must agree');
    assert.equal(p.body.error, a.body.error, 'and say the same thing about it');
  }
});
