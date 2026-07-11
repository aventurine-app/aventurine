'use strict';

// Port of tests/test_database.py — create / open / unlock, the filesystem
// browser, data isolation across switches, and the 423 lock gate when an
// encrypted DB is restored at startup.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeClient } = require('./helpers');
const { createConn } = require('../conn');
const { dispatch } = require('../routes');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\x00', 'latin1');

const header = (p) => {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(16);
  const n = fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n);
};

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-db-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('db: status reports active db', (t) => {
  const c = makeClient(t);
  const s = c.get('/api/db/status').body;
  assert.equal(s.ok, true);
  assert.equal(s.path, path.resolve(process.env.AVENTURINE_DB_PATH));
  assert.equal(s.encrypted, false);
  assert.equal(s.locked, false);
  assert.equal(s.encryption_available, true);
});

test('db: create plain db, seeded and immediately usable', (t) => {
  const c = makeClient(t);
  const p = path.join(tmpDir(t), 'fresh.db');
  const r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, p);
  assert.ok(header(p).equals(SQLITE_MAGIC));
  assert.equal(c.get('/api/data').status, 200);
  assert.equal(c.get('/api/db/status').body.encrypted, false);
});

test('db: create refuses existing file and directory paths', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const p = path.join(dir, 'exists.db');
  fs.writeFileSync(p, 'do not clobber me');
  let r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(p, 'utf8'), 'do not clobber me');

  r = c.post('/api/db/create', { path: dir });
  assert.equal(r.status, 400);
});

test('db: create encrypted requires password; file is not plaintext', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  let r = c.post('/api/db/create', { path: path.join(dir, 'enc.db'), encrypt: true });
  assert.equal(r.status, 400);

  const p = path.join(dir, 'enc2.db');
  r = c.post('/api/db/create', { path: p, encrypt: true, password: 's3cret' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.encrypted, true);
  assert.ok(!header(p).equals(SQLITE_MAGIC));
  assert.equal(c.get('/api/data').status, 200);
});

test('db: open round trip preserves data', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const a = path.join(dir, 'a.db');
  const b = path.join(dir, 'b.db');

  assert.equal(c.post('/api/db/create', { path: a }).status, 200);
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-01-15',
      description: 'only in A',
      tx_type: 'expense',
      amount: 12.34,
    }).status,
    200
  );

  assert.equal(c.post('/api/db/create', { path: b }).status, 200);
  let descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(!descs.includes('only in A'));

  assert.equal(c.post('/api/db/open', { path: a }).status, 200);
  descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(descs.includes('only in A'));
});

test('db: save-as copies the active db and switches to the copy', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const a = path.join(dir, 'a.db');
  const b = path.join(dir, 'b.db');

  assert.equal(c.post('/api/db/create', { path: a }).status, 200);
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-03-01',
      description: 'before save-as',
      tx_type: 'expense',
      amount: 7.5,
    }).status,
    200
  );

  const r = c.post('/api/db/save-as', { path: b });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, b);
  assert.equal(r.body.encrypted, false);
  // Active DB is now the copy, carrying the data.
  assert.equal(c.get('/api/db/status').body.path, b);
  let descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(descs.includes('before save-as'));

  // Writes land in the copy, not the original.
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-03-02',
      description: 'only in copy',
      tx_type: 'expense',
      amount: 1,
    }).status,
    200
  );
  assert.equal(c.post('/api/db/open', { path: a }).status, 200);
  descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(descs.includes('before save-as'));
  assert.ok(!descs.includes('only in copy'));
});

test('db: save-as refuses existing file and the current path', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const a = path.join(dir, 'a.db');
  assert.equal(c.post('/api/db/create', { path: a }).status, 200);

  const taken = path.join(dir, 'taken.db');
  fs.writeFileSync(taken, 'do not clobber me');
  let r = c.post('/api/db/save-as', { path: taken });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'do not clobber me');

  r = c.post('/api/db/save-as', { path: a });
  assert.equal(r.status, 409);
});

test('db: save-as preserves encryption and key', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const a = path.join(dir, 'enc.db');
  const b = path.join(dir, 'enc-copy.db');

  assert.equal(
    c.post('/api/db/create', { path: a, encrypt: true, password: 'pw7' }).status,
    200
  );
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-04-01',
      description: 'encrypted tx',
      tx_type: 'expense',
      amount: 3,
    }).status,
    200
  );

  const r = c.post('/api/db/save-as', { path: b });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.encrypted, true);
  // The copy is genuinely encrypted on disk…
  assert.ok(!header(b).equals(SQLITE_MAGIC));
  // …and reopening it requires the inherited key. Switch off the copy first
  // (back to the encrypted original, which needs its own password).
  assert.equal(c.post('/api/db/open', { path: a, password: 'pw7' }).status, 200);
  let r2 = c.post('/api/db/open', { path: b });
  assert.equal(r2.status, 401);
  assert.equal(r2.body.error, 'password_required');
  r2 = c.post('/api/db/open', { path: b, password: 'pw7' });
  assert.equal(r2.status, 200);
  const descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(descs.includes('encrypted tx'));
});

test('db: open missing file is 404', (t) => {
  const c = makeClient(t);
  const r = c.post('/api/db/open', { path: path.join(tmpDir(t), 'nope.db') });
  assert.equal(r.status, 404);
});

test('db: open foreign sqlite refused before switching', (t) => {
  const c = makeClient(t);
  const Database = require('better-sqlite3-multiple-ciphers');
  const p = path.join(tmpDir(t), 'foreign.db');
  const con = new Database(p);
  con.exec('CREATE TABLE t (x)');
  con.close();
  const r = c.post('/api/db/open', { path: p });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.includes('Aventurine'));
  assert.equal(c.get('/api/data').status, 200, 'still on the original DB');
});

test('db: open encrypted password flow', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  const p = path.join(dir, 'enc.db');
  assert.equal(
    c.post('/api/db/create', { path: p, encrypt: true, password: 'pw1' }).status,
    200
  );
  assert.equal(
    c.post('/api/transactions', {
      date: '2026-02-01',
      description: 'secret tx',
      tx_type: 'expense',
      amount: 5,
    }).status,
    200
  );

  assert.equal(c.post('/api/db/create', { path: path.join(dir, 'other.db') }).status, 200);

  let r = c.post('/api/db/open', { path: p });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'password_required');

  r = c.post('/api/db/open', { path: p, password: 'wrong' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'invalid_password');

  r = c.post('/api/db/open', { path: p, password: 'pw1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.encrypted, true);
  const descs = c.get('/api/transactions').body.transactions.map((x) => x.description);
  assert.ok(descs.includes('secret tx'));
});

test('db: browse lists dirs and db files only', (t) => {
  const c = makeClient(t);
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.db'), 'x');
  fs.writeFileSync(path.join(dir, 'b.sqlite3'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, '.hidden'));

  const r = c.get(`/api/db/browse?path=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.path, dir);
  assert.deepStrictEqual(r.body.dirs, ['sub']);
  assert.deepStrictEqual(r.body.files, ['a.db', 'b.sqlite3']);
  assert.equal(r.body.parent, path.dirname(dir));
});

test('db: browse defaults to home; rejects non-directories', (t) => {
  const c = makeClient(t);
  const r = c.get('/api/db/browse');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.path, os.homedir());

  const p = path.join(tmpDir(t), 'f.db');
  fs.writeFileSync(p, 'x');
  assert.equal(c.get(`/api/db/browse?path=${encodeURIComponent(p)}`).status, 404);
});

test('db: locked startup gates data APIs until unlock', (t) => {
  // Create an encrypted DB with one client…
  const c = makeClient(t);
  const dir = tmpDir(t);
  const p = path.join(dir, 'enc.db');
  assert.equal(
    c.post('/api/db/create', { path: p, encrypt: true, password: 'pw9' }).status,
    200
  );

  // …then simulate a restart: a fresh conn whose pointer file names the
  // encrypted DB and whose data dir is isolated. AVENTURINE_DB_PATH must be
  // absent or it would override the pointer.
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 'active-db.json'),
    JSON.stringify({ path: p, encrypted: true })
  );
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
  });
  const c2 = {
    get: (u) => dispatch(conn2, 'GET', u, null),
    post: (u, b) => dispatch(conn2, 'POST', u, b),
  };

  const s = c2.get('/api/db/status').body;
  assert.equal(s.locked, true);
  assert.equal(s.encrypted, true);
  assert.equal(s.path, p);

  // Data APIs are gated; /api/db/* is not.
  assert.equal(c2.get('/api/data').status, 423);
  assert.equal(c2.post('/api/transactions', {}).status, 423);

  let r = c2.post('/api/db/unlock', { password: 'nope' });
  assert.equal(r.status, 401);
  assert.equal(c2.get('/api/data').status, 423);

  r = c2.post('/api/db/unlock', { password: 'pw9' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.locked, false);
  assert.equal(c2.get('/api/data').status, 200);
});
