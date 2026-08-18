'use strict';

// Shared test client — the Node counterpart of tests/conftest.py. Each
// makeClient() builds an isolated conn against a fresh tempfile DB selected
// via AVENTURINE_DB_PATH (which also suppresses pointer-file writes), and
// returns HTTP-shaped helpers so the ported Python tests read 1:1.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConn } = require('../conn');
const { dispatch } = require('../routes');
const { adoptAccount } = require('../services/accounts');
const license = require('../license');

/** Give the client an ACTIVATED install, signed by a throwaway pair.
 *
 *  Without this every mutating test would meet the 402 read-only gate, so this
 *  is what keeps the suite testing features rather than licensing. Tests that
 *  care about the gate (or about the unlicensed state) pass { licensed: false }
 *  and drive it themselves. Both the key slot and the config dir are restored
 *  afterwards, so nothing leaks between files. */
function installTestLicense(t, dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const prevKey = license.PUBLIC_KEYS[0];
  const prevCfg = process.env.AVENTURINE_CONFIG_DIR;
  process.env.AVENTURINE_CONFIG_DIR = path.join(dir, 'config');
  license.PUBLIC_KEYS[0] = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  license.activate(
    license.encode(
      {
        licenseId: '00'.repeat(8),
        issued: '2026-01-01',
        // Every major version, so bumping the app's version never quietly
        // turns the whole suite red on an entitlement check.
        entitlement: 255,
        email: 'tests@example.com',
      },
      (body) => crypto.sign(null, body, privateKey)
    )
  );
  t.after(() => {
    license.PUBLIC_KEYS[0] = prevKey;
    if (prevCfg === undefined) delete process.env.AVENTURINE_CONFIG_DIR;
    else process.env.AVENTURINE_CONFIG_DIR = prevCfg;
  });
}

function makeClient(t, { licensed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-api-'));
  const dbPath = path.join(dir, 'test.db');
  const prev = process.env.AVENTURINE_DB_PATH;
  process.env.AVENTURINE_DB_PATH = dbPath;
  if (licensed) installTestLicense(t, dir);
  const conn = createConn();
  conn.init();
  t.after(() => {
    conn.closeAll();
    if (prev === undefined) delete process.env.AVENTURINE_DB_PATH;
    else process.env.AVENTURINE_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, url, body) => dispatch(conn, method, url, body ?? null);
  return {
    conn,
    dbPath,
    dir,
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u, b) => call('DELETE', u, b),
    // Make one of the seeded starter accounts visible, as an import would (see
    // services/accounts) — for the tests that need an account to exist without
    // also wanting the transactions an import would bring with it.
    adopt: (key) => adoptAccount(conn.db(), key),
  };
}

module.exports = { makeClient };
