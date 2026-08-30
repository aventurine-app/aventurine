'use strict';

// License verification. The main property under test: the app can CHECK a key
// and cannot MINT one. The rest of these tests pin the wire format, since a
// format change invalidates every key already sold.

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

  // I/L -> 1 and O -> 0 are common transcription errors; the decoder maps them
  // back.
  const slipped = key.replace(/1/g, 'I').replace(/0/g, 'O');
  assert.ok(L.verify(slipped, { major: 1 }).ok, 'I/O aliases should fold back');

  // U is not in the alphabet, so it indicates a paste error.
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
  // A key is bound to its slot; a signature from one slot does not verify under
  // another.
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
  // The license is still returned, so the UI can show which license needs the
  // upgrade instead of an invalid-key error.
  assert.equal(res.license.email, 'buyer@example.com');
});

// ─── Revocation ─────────────────────────────────────────────────────────────

/** Block one licenseId for the duration of a test. */
function withRevoked(t, id) {
  L.REVOKED_LICENSE_IDS.add(id);
  t.after(() => L.REVOKED_LICENSE_IDS.delete(id));
}

test('a revoked license is refused at every version, and names itself', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  assert.ok(L.verify(key, { major: 1 }).ok, 'valid before it is blocked');

  withRevoked(t, BASE.licenseId);
  const res = L.verify(key, { major: 1 });
  assert.equal(res.ok, false);
  // Not 'bad_signature': the key is genuine, we have simply stopped honouring
  // it, and support has to be able to tell those two apart from the reason code
  // alone. The license rides along so the blocked copy can be identified.
  assert.equal(res.reason, 'revoked');
  assert.equal(res.license.email, BASE.email);
  assert.equal(res.license.licenseId, BASE.licenseId);
});

test('revocation is checked before entitlement', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withRevoked(t, BASE.licenseId);

  // A key that is BOTH blocked and out of entitlement reports blocked, because
  // "get a fresh key from the activation page" is advice that cannot work: the
  // worker's deny list carries the same id and will refuse to issue one.
  const key = L.encode({ ...BASE, entitlement: 1 }, real.sign);
  assert.equal(L.verify(key, { major: 5 }).reason, 'revoked');
});

test('revoking one license leaves every other key alone', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  withRevoked(t, BASE.licenseId);

  const other = L.encode(
    { ...BASE, licenseId: L.licenseIdFor('GUM-TEST-0002'), email: 'other@example.com' },
    real.sign
  );
  assert.ok(L.verify(other, { major: 1 }).ok);
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

  // An encrypted DB restored from the pointer starts locked. A license applies to
  // the INSTALL, so /api/license must respond before any passphrase is supplied;
  // otherwise an install that is both locked and unactivated has no reachable
  // screen.
  const c = makeClient(t, { licensed: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-db-'));
  const p = path.join(dir, 'enc.db');

  // Creating it is free (the ledger has to have somewhere to live), so the
  // fixture reaches the state under test directly: an unactivated install
  // pointed at a locked encrypted database.
  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
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

  // Both gates are active, and which one responds depends on the route. A FREE
  // route is not license-gated, so it returns the lock status; a PAID one is
  // refused before the lock is checked, since a passphrase prompt leads nowhere
  // for an unpurchased feature.
  assert.equal(dispatch(conn2, 'GET', '/api/db/status', null).status, 200);
  assert.equal(dispatch(conn2, 'GET', '/api/data', null).status, 423);
  assert.equal(dispatch(conn2, 'GET', '/api/trends', null).status, 402);

  assert.equal(dispatch(conn2, 'GET', '/api/license', null).status, 200);
  const activated = dispatch(conn2, 'POST', '/api/license/activate', { key });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.licensed, true);

  // And now the lock is what is left: the app moves from the activation screen
  // to the passphrase prompt, one gate at a time.
  assert.equal(dispatch(conn2, 'GET', '/api/db/status', null).body.locked, true);
  assert.equal(dispatch(conn2, 'GET', '/api/data', null).status, 423, 'data still gated');
});

// ─── The activation gate ────────────────────────────────────────────────────

/** An unlicensed client with an isolated (empty) config dir. */
function unlicensedClient(t) {
  withConfigDir(t);
  return makeClient(t, { licensed: false });
}

test('gate: the free tier is a working transaction manager', (t) => {
  const c = unlicensedClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-free-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The sentence the gate has to be explainable in: your transactions are
  // free, the insights are paid. Everything here is the first half, and it has
  // to work end to end or the free tier is a demo of nothing.
  for (const url of [
    '/api/transactions',
    '/api/categories',
    '/api/data',
    '/api/balance/data',
    '/api/balance/columns',
    '/api/app-settings',
    '/api/onboarding',
    '/api/db/status',
  ]) {
    const r = c.get(url);
    assert.equal(r.status, 200, `${url} should be free (got ${r.status})`);
  }

  // Writes too. A ledger you can read but not build is the read-only gate
  // again, and that one was already tried and rejected.
  const allowed = [
    ['POST', '/api/transactions', { amount: 5, description: 'coffee', date: '2026-01-01' }],
    ['POST', '/api/categories', { name: 'Free tier', cat_type: 'expense' }],
    ['POST', '/api/transactions/import', {
      rows: [{ date: '2026-01-02', description: 'MARKET 118 YORK PA', amount: 12.4, tx_type: 'expense' }],
    }],
    ['PUT', '/api/app-settings/tx_auto_match', { value: 'off' }],
    ['POST', '/api/transactions/export', {
      path: path.join(dir, 'out.csv'), format: 'csv', offset: 0, limit: 100,
    }],
    ['POST', '/api/db/create', { path: path.join(dir, 'new.db') }],
  ];
  for (const [method, url, body] of allowed) {
    const r = dispatch(c.conn, method, url, body);
    assert.equal(r.status, 200, `${method} ${url} should be free (got ${r.status})`);
  }
});

test('gate: everything built on top of the ledger needs a key', (t) => {
  const c = unlicensedClient(t);

  // The paid half of the gate. These are whole pages with their own routes, which
  // is why they can be locked at the route level while the Dashboard's Year to
  // Year section cannot.
  const paid = [
    ['GET', '/api/forecast', null],
    ['GET', '/api/trends', null],
    ['GET', '/api/top-merchants', null],
    ['GET', '/api/recurring', null],
    ['GET', '/api/recurring/candidates', null],
    ['GET', '/api/predictions/upcoming', null],
    ['GET', '/api/report-card', null],
    ['GET', '/api/credit-cards/data', null],
    ['GET', '/api/portfolio/data', null],
    // The year grids on the Statements page. Import still writes year tables, but
    // it does so inside the backend rather than over these routes, so locking them
    // does not break the free tier's import.
    ['POST', '/api/entry', {}],
    ['DELETE', '/api/entry', {}],
    ['POST', '/api/year', {}],
    ['POST', '/api/balance/entry', {}],
    ['POST', '/api/balance/year', {}],
  ];
  for (const [method, url, body] of paid) {
    const r = dispatch(c.conn, method, url, body);
    assert.equal(r.status, 402, `${method} ${url} should be gated (got ${r.status})`);
    assert.equal(r.body.error, 'license_required');
  }
});

test('gate: the allowlist is closed by default', (t) => {
  const c = unlicensedClient(t);

  // A route freed by prefix must not free its neighbours by accident. These
  // three all begin with a free string and none of them is free: the money on
  // the Balance Sheet is not its column list, and /api/data is matched whole.
  for (const url of ['/api/balance/entry', '/api/balance/year/2026', '/api/report-card']) {
    assert.equal(dispatch(c.conn, 'POST', url, {}).status, 402, `${url} should be gated`);
  }
});

test('gate: /api/license is the one thing that answers', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  // Without this exemption activation could never happen, which is the only
  // reason it exists.
  assert.equal(dispatch(c.conn, 'GET', '/api/license', null).status, 200);
  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  assert.equal(dispatch(c.conn, 'POST', '/api/license/preview', { key }).status, 200);
  assert.equal(dispatch(c.conn, 'POST', '/api/license/activate', { key }).status, 200);
});

test('gate: activating lifts it immediately, removing puts it back', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  // Probed on a PAID route: the ledger routes respond either way, so they cannot
  // distinguish an activated install from an unactivated one.
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 402);

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  assert.equal(dispatch(c.conn, 'POST', '/api/license/activate', { key }).status, 200);
  // No restart, no cache to flush: the next request is already licensed.
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 200);

  assert.equal(dispatch(c.conn, 'DELETE', '/api/license', null).status, 200);
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 402);

  // And the free tier is untouched by any of it.
  assert.equal(dispatch(c.conn, 'GET', '/api/transactions', null).status, 200);
});

test('gate: entitlement is what makes a paid major upgrade possible', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  // A genuine license that covers 1.x.
  L.activate(L.encode({ ...BASE, entitlement: 1 }, real.sign));
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 200);

  // Now ship 5.0. appMajor() reads the cached package.json object, so mutating
  // it is the real code path, not a stub.
  const pkg = require('../../package.json');
  const realVersion = pkg.version;
  t.after(() => { pkg.version = realVersion; });
  pkg.version = '5.0.0';

  // The same key, still perfectly valid, no longer unlocks: this is the whole
  // upgrade lever, and the reason a refunded purchase eventually stops working
  // without the app ever needing a revocation list or a clock.
  const r = dispatch(c.conn, 'GET', '/api/trends', null);
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'license_required');

  // And the UI can still name the customer rather than crying forgery.
  const st = dispatch(c.conn, 'GET', '/api/license', null).body;
  assert.equal(st.state, 'invalid');
  assert.equal(st.reason, 'entitlement');
  assert.equal(st.license.email, BASE.email);
});

test('gate: a revoked license sends a licensed install back to the free tier', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);

  L.activate(L.encode({ ...BASE, entitlement: 99 }, real.sign));
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 200);

  // The key on disk does not change and is not deleted. status() re-verifies on
  // every read, so shipping the id is the whole mechanism.
  withRevoked(t, BASE.licenseId);
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 402);

  // Back to the free tier rather than to a dead app: the ledger is still theirs.
  assert.equal(dispatch(c.conn, 'GET', '/api/transactions', null).status, 200);

  const st = dispatch(c.conn, 'GET', '/api/license', null).body;
  assert.equal(st.state, 'invalid');
  assert.equal(st.reason, 'revoked');
  assert.ok(st.message, 'the renderer never maps reason codes itself');
  assert.equal(st.license.email, BASE.email);

  // And it cannot be pasted back in, which is the point of blocking it.
  const again = dispatch(c.conn, 'POST', '/api/license/activate', { key: L.encode({ ...BASE, entitlement: 99 }, real.sign) });
  assert.equal(again.status, 400);
  assert.equal(again.body.reason, 'revoked');
});

test('gate: which gate answers depends on whether the route is free', (t) => {
  const real = pair();
  withKey(t, 0, real.raw);
  const c = unlicensedClient(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lic-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const key = L.encode({ ...BASE, entitlement: 99 }, real.sign);
  const p = path.join(dir, 'enc.db');
  assert.equal(dispatch(c.conn, 'POST', '/api/db/create', { path: p, encrypt: true, password: 'pw9' }).status, 200);
  assert.equal(dispatch(c.conn, 'POST', '/api/db/lock', null).status, 200);

  const tx = { amount: 1, description: 'x', date: '2026-01-01' };

  // Free route, locked database: the passphrase is the thing the user can
  // actually do next, so the lock is what they are told about.
  const free = dispatch(c.conn, 'POST', '/api/transactions', tx);
  assert.equal(free.status, 423);
  assert.equal(free.body.error, 'db_locked');

  // Paid route, same locked database: the license is checked first, so 402 is
  // returned rather than 423.
  const paid = dispatch(c.conn, 'GET', '/api/trends', null);
  assert.equal(paid.status, 402);
  assert.equal(paid.body.error, 'license_required');

  // Activated, the paid route falls back to the lock like everything else.
  assert.equal(dispatch(c.conn, 'POST', '/api/license/activate', { key }).status, 200);
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 423);
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

  // Previewing is not activating. A preview must leave the install as unlicensed
  // as it found it; otherwise pasting a key would activate it without a further
  // step.
  assert.equal(c.get('/api/license').body.licensed, false);
  assert.equal(dispatch(c.conn, 'GET', '/api/trends', null).status, 402);
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
