'use strict';

// Shared test client. Each makeClient() builds an isolated conn against a fresh
// tempfile DB selected via AVENTURINE_DB_PATH (which also suppresses
// pointer-file writes), and returns HTTP-shaped helpers so a test reads like a
// request.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConn } = require('../conn');
const { dispatch } = require('../routes');
const { adoptAccount } = require('../services/accounts');

function makeClient(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-api-'));
  const dbPath = path.join(dir, 'test.db');
  const prev = process.env.AVENTURINE_DB_PATH;
  process.env.AVENTURINE_DB_PATH = dbPath;
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
    // services/accounts), for tests that need an account to exist without the
    // transactions an import would insert.
    adopt: (key) => adoptAccount(conn.db(), key),
  };
}

module.exports = { makeClient };
