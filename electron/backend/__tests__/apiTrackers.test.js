'use strict';

// Port of tests/test_year_table.py (Balance Sheet via the year-table factory)
// plus the cross-cutting non-finite-value rejections from tests/test_security.py
// that still apply in the IPC world. (The host/origin/CSP middleware tests are
// retired with the HTTP server itself — there is no socket any more.)

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

const PREFIX = '/api/balance';
const DEFAULT_TYPE = 'cash';
const KEY_PREFIX = 'bcol_';

function addColumn(c, label, colType = DEFAULT_TYPE) {
  const r = c.post(`${PREFIX}/columns`, { label, type: colType });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.column;
}

function getData(c) {
  const r = c.get(`${PREFIX}/data`);
  assert.equal(r.status, 200);
  return r.body;
}

test('balance: GET /data returns seed', (t) => {
  const c = makeClient(t);
  const data = getData(c);
  assert.ok('years' in data && 'entries' in data && 'columns' in data);
  assert.ok(data.years.length >= 1);
  assert.ok(data.columns.length >= 1);
  assert.deepStrictEqual(data.entries, {});
});

test('balance: entry upsert and delete', (t) => {
  const c = makeClient(t);
  const data = getData(c);
  const year = data.years[0];
  const col = data.columns[0].key;

  let r = c.post(`${PREFIX}/entry`, { year, month: 'January', category: col, value: 100.0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(getData(c).entries[String(year)].January[col], 100.0);

  r = c.post(`${PREFIX}/entry`, { year, month: 'January', category: col, value: 250.0 });
  assert.equal(r.status, 200);
  assert.equal(getData(c).entries[String(year)].January[col], 250.0);

  r = c.del(`${PREFIX}/entry`, { year, month: 'January', category: col });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(getData(c).entries, {});
});

test('balance: entry validation', (t) => {
  const c = makeClient(t);
  assert.equal(
    c.post(`${PREFIX}/entry`, { year: 42, month: 'January', category: 'x', value: 1 }).status,
    400
  );
  assert.equal(
    c.post(`${PREFIX}/entry`, { year: 2025, month: 'Jan', category: 'x', value: 1 }).status,
    400
  );
  assert.equal(
    c.post(`${PREFIX}/entry`, { year: 2025, month: 'January', category: 'x' }).status,
    400
  );
});

test('balance: year add and delete (idempotent add)', (t) => {
  const c = makeClient(t);
  assert.equal(c.post(`${PREFIX}/year`, { year: 2030 }).status, 200);
  assert.ok(getData(c).years.includes(2030));
  assert.equal(c.post(`${PREFIX}/year`, { year: 2030 }).status, 200);
  assert.equal(c.del(`${PREFIX}/year/2030`).status, 200);
  assert.ok(!getData(c).years.includes(2030));
});

test('balance: year duplicate copies entries; refuses existing target', (t) => {
  const c = makeClient(t);
  const data = getData(c);
  const src = data.years[0];
  const col = data.columns[0].key;
  c.post(`${PREFIX}/entry`, { year: src, month: 'March', category: col, value: 42.0 });

  let r = c.post(`${PREFIX}/year/${src}/duplicate`, { target_year: 2031 });
  assert.equal(r.status, 200);
  const after = getData(c);
  assert.ok(after.years.includes(2031));
  assert.equal(after.entries['2031'].March[col], 42.0);

  c.post(`${PREFIX}/year`, { year: 2032 });
  r = c.post(`${PREFIX}/year/${src}/duplicate`, { target_year: 2032 });
  assert.equal(r.status, 400);
});

test('balance: column add / rename / move / delete-with-data', (t) => {
  const c = makeClient(t);
  const col = addColumn(c, 'New Col');
  assert.ok(col.key.startsWith(KEY_PREFIX));
  assert.equal(col.label, 'New Col');
  assert.ok(getData(c).columns.some((x) => x.key === col.key));

  // rename
  let r = c.put(`${PREFIX}/columns/${col.key}`, { label: 'After' });
  assert.equal(r.status, 200);
  const labels = getData(c).columns.map((x) => x.label);
  assert.ok(labels.includes('After') && !labels.includes('New Col'));

  // delete refuses while data exists, force wipes
  const year = getData(c).years[0];
  c.post(`${PREFIX}/entry`, { year, month: 'January', category: col.key, value: 5.0 });
  r = c.del(`${PREFIX}/columns/${col.key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'has_data');
  assert.ok(getData(c).columns.some((x) => x.key === col.key));
  r = c.del(`${PREFIX}/columns/${col.key}?force=true`);
  assert.equal(r.status, 200);
  const after = getData(c);
  assert.ok(!after.columns.some((x) => x.key === col.key));
  assert.deepStrictEqual(after.entries, {});
});

test('balance: move swaps same-type neighbors', (t) => {
  const c = makeClient(t);
  const a = addColumn(c, 'A');
  const b = addColumn(c, 'B');
  const before = getData(c).columns.map((x) => x.key);
  const aIdx = before.indexOf(a.key);
  const bIdx = before.indexOf(b.key);
  assert.equal(bIdx, aIdx + 1, 'same-type columns adjacent');

  assert.equal(c.post(`${PREFIX}/columns/${b.key}/move`, { direction: 'up' }).status, 200);
  const after = getData(c).columns.map((x) => x.key);
  assert.equal(after.indexOf(b.key), aIdx);
  assert.equal(after.indexOf(a.key), bIdx);
});

test('balance: column type change relocates, keys stay unique', (t) => {
  const c = makeClient(t);
  const col = addColumn(c, 'Movable', 'cash');
  const r = c.put(`${PREFIX}/columns/${col.key}`, { type: 'investment' });
  assert.equal(r.status, 200);
  const data = getData(c);
  const moved = data.columns.find((x) => x.key === col.key);
  assert.equal(moved.type, 'investment');
  const keys = data.columns.map((x) => x.key);
  assert.equal(keys.length, new Set(keys).size, 'no duplicate column keys after type change');
});

test('balance: reorder rewrites order and retypes columns in one call', (t) => {
  const c = makeClient(t);
  const a = addColumn(c, 'A', 'cash');
  const b = addColumn(c, 'B', 'cash');
  const before = getData(c).columns;
  // Send the full ordering with b ahead of a, and move a into investment.
  const order = before.map((col) =>
    col.key === a.key ? { key: a.key, type: 'investment' } : { key: col.key, type: col.type }
  );
  // Put b before a in the submitted order.
  const aPos = order.findIndex((o) => o.key === a.key);
  const bPos = order.findIndex((o) => o.key === b.key);
  order.splice(aPos, 1);
  order.splice(bPos, 0, { key: a.key, type: 'investment' });

  const r = c.post(`${PREFIX}/columns/reorder`, { order });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const after = getData(c).columns;
  assert.deepEqual(
    after.map((x) => x.key),
    order.map((o) => o.key),
    'columns come back in the submitted order'
  );
  assert.equal(after.find((x) => x.key === a.key).type, 'investment', 'a retyped to investment');
});

test('balance: reorder rejects an incomplete or unknown ordering', (t) => {
  const c = makeClient(t);
  const a = addColumn(c, 'A');
  const all = getData(c).columns.map((x) => ({ key: x.key, type: x.type }));

  // Dropping a column from the order is rejected (must list every column).
  const short = all.filter((o) => o.key !== a.key);
  assert.equal(c.post(`${PREFIX}/columns/reorder`, { order: short }).status, 400);

  // An unknown key is rejected.
  const bogus = all.map((o, i) => (i === 0 ? { key: 'bcol_999999', type: o.type } : o));
  assert.equal(c.post(`${PREFIX}/columns/reorder`, { order: bogus }).status, 404);

  // An invalid type is rejected.
  const badType = all.map((o, i) => (i === 0 ? { key: o.key, type: 'nope' } : o));
  assert.equal(c.post(`${PREFIX}/columns/reorder`, { order: badType }).status, 400);
});

// ─── Non-finite / non-numeric value rejection (from test_security.py) ─────────
// In the IPC world these arrive as real JS values (no JSON parsing layer), but
// one stored NaN would still corrupt every reader — the validators must hold.

test('entry rejects non-finite and boolean values', (t) => {
  const c = makeClient(t);
  for (const v of [NaN, Infinity, -Infinity, true, '5']) {
    const r = c.post(`${PREFIX}/entry`, {
      year: 2025,
      month: 'January',
      category: 'cash',
      value: v,
    });
    assert.equal(r.status, 400, `value ${String(v)}`);
  }
});

test('transaction rejects non-finite amount', (t) => {
  const c = makeClient(t);
  const r = c.post('/api/transactions', {
    date: '2026-01-01',
    description: 'x',
    tx_type: 'expense',
    amount: NaN,
  });
  assert.equal(r.status, 400);
});

test('dispatch turns a malformed %-escape in a path param into a clean 400', (t) => {
  const c = makeClient(t);
  // A lone '%' is not a valid percent-encoding; decodeURIComponent throws a
  // URIError on it. dispatch must catch that and answer 400 rather than let
  // the exception escape and reject the IPC promise (unhandled in the renderer).
  const r = c.del(`${PREFIX}/columns/%`);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
});
