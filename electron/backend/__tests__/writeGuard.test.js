'use strict';

// Renderer-trust-boundary containment for file writes (conn.js authorizeWrite,
// wired into db create / save-as / export). The backend only ever writes to a
// path the renderer relayed; the Electron shell injects a guard so a path the
// user didn't pick from a native dialog needs an out-of-renderer confirmation.
// Off the Electron boundary (no guard) writes stay unrestricted — proven by the
// rest of the suite, which never installs one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeClient } = require('./helpers');

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-guard-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Install a guard that records the paths it was asked to confirm and answers
 *  with `verdict`. Returns the call log so tests can assert prompt counts. */
function installGuard(conn, verdict) {
  const prompted = [];
  conn.setWriteGuard({
    confirm: (p) => {
      prompted.push(p);
      return verdict;
    },
  });
  return prompted;
}

test('guard: non-dialog create path is allowed when the user confirms', (t) => {
  const c = makeClient(t);
  const prompted = installGuard(c.conn, true);
  const p = path.join(tmpDir(t), 'confirmed.db');

  const r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.existsSync(p));
  assert.deepEqual(prompted, [path.resolve(p)]);
});

test('guard: non-dialog create path is refused (403) when the user declines', (t) => {
  const c = makeClient(t);
  installGuard(c.conn, false);
  const p = path.join(tmpDir(t), 'declined.db');

  const r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'write_not_authorized');
  // Refused before any filesystem side effect.
  assert.ok(!fs.existsSync(p));
});

test('guard: a dialog-issued (approved) path writes without prompting', (t) => {
  const c = makeClient(t);
  const prompted = installGuard(c.conn, false); // would refuse if consulted
  const p = path.join(tmpDir(t), 'from-dialog.db');

  c.conn.approveWrite(p); // what main.js does when a native dialog returns it
  const r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.existsSync(p));
  assert.equal(prompted.length, 0);
});

test('guard: export to a non-dialog path is gated, then chunk loop never re-prompts', (t) => {
  const c = makeClient(t);
  const prompted = installGuard(c.conn, true);
  const dest = path.join(tmpDir(t), 'export.csv');

  // Two transactions so the export spans the meta/header/body/footer path.
  c.post('/api/transactions', { date: '2026-01-01', description: 'a', amount: 10, tx_type: 'income' });
  c.post('/api/transactions', { date: '2026-01-02', description: 'b', amount: 5, tx_type: 'expense' });

  // Drive the real client-style chunk loop to completion.
  let offset = 0;
  let done = false;
  while (!done) {
    const r = c.post('/api/transactions/export', { format: 'csv', path: dest, offset });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    offset = r.body.exported;
    done = r.body.done;
  }
  assert.ok(fs.existsSync(dest));
  // Prompted exactly once for the destination across every chunk.
  assert.deepEqual(prompted, [path.resolve(dest)]);
});

test('guard: declined export writes nothing and leaves no .part behind', (t) => {
  const c = makeClient(t);
  installGuard(c.conn, false);
  const dest = path.join(tmpDir(t), 'nope.csv');

  const r = c.post('/api/transactions/export', { format: 'csv', path: dest, offset: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'write_not_authorized');
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(dest + '.part'));
});

test('guard: absent (host-Node / no shell) leaves writes unrestricted', (t) => {
  const c = makeClient(t); // makeClient never installs a guard
  const p = path.join(tmpDir(t), 'unguarded.db');
  const r = c.post('/api/db/create', { path: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.existsSync(p));
});
