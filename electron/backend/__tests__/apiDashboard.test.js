'use strict';

// Dashboard layouts (handlers/dashboard.js): the saved tabs of cards behind the
// customizable Dashboard. What is worth pinning is what the page cannot see: a
// database that never saved one answers with nothing, a save replaces the whole
// set, the open tab falls back sensibly, and a malformed write is refused whole,
// leaving whatever was stored exactly as it was.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

const card = (over = {}) => ({
  id: 'c1', type: 'networth', x: 0, y: 0, w: 4, h: 6,
  settings: {}, period: { preset: 'ytd', month: null }, color: null,
  ...over,
});
const layout = (over = {}) => ({ id: 'L1', name: 'Overview', cards: [card()], ...over });

function getDashboard(c) {
  const r = c.get('/api/dashboard');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('dashboard: a fresh database has no saved layouts', (t) => {
  const c = makeClient(t);
  assert.deepStrictEqual(getDashboard(c), { active: null, layouts: [] });
});

test('dashboard: save then read back, in tab order, with the open tab', (t) => {
  const c = makeClient(t);
  const body = {
    active: 'L2',
    layouts: [
      layout(),
      layout({
        id: 'L2', name: 'Month Close',
        cards: [
          card({ id: 'a', type: 'spending', w: 6, color: 'blue', period: { preset: 'month', month: null } }),
          card({ id: 'b', type: 'spending', x: 6, w: 6, period: { preset: 'month', month: '2026-08' } }),
          card({ id: 'c', type: 'upcoming', y: 6, settings: { title: 'Bills' }, period: { preset: 'd30', month: null } }),
        ],
      }),
    ],
  };
  const r = c.put('/api/dashboard', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The acknowledgement is the stored state, so the page needs no second GET.
  assert.deepStrictEqual(r.body.layouts, body.layouts);
  assert.equal(r.body.active, 'L2');
  assert.deepStrictEqual(getDashboard(c), { active: 'L2', layouts: body.layouts });
});

test('dashboard: a save replaces the whole set', (t) => {
  const c = makeClient(t);
  c.put('/api/dashboard', { active: 'L1', layouts: [layout(), layout({ id: 'L2', name: 'Second' })] });
  c.put('/api/dashboard', { active: 'L2', layouts: [layout({ id: 'L2', name: 'Second' })] });
  const saved = getDashboard(c);
  assert.deepStrictEqual(saved.layouts.map((l) => l.id), ['L2']);
  assert.equal(saved.active, 'L2');
});

test('dashboard: an open tab that is not in the set falls back to the first', (t) => {
  const c = makeClient(t);
  const r = c.put('/api/dashboard', { active: 'nope', layouts: [layout(), layout({ id: 'L2', name: 'Second' })] });
  assert.equal(r.status, 200);
  assert.equal(getDashboard(c).active, 'L1');
});

test('dashboard: an empty list returns to the default', (t) => {
  const c = makeClient(t);
  c.put('/api/dashboard', { active: 'L1', layouts: [layout()] });
  const r = c.put('/api/dashboard', { active: 'L1', layouts: [] });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(getDashboard(c), { active: null, layouts: [] });
});

test('dashboard: the open tab survives a reorder', (t) => {
  const c = makeClient(t);
  const a = layout();
  const b = layout({ id: 'L2', name: 'Second' });
  c.put('/api/dashboard', { active: 'L2', layouts: [a, b] });
  c.put('/api/dashboard', { active: 'L2', layouts: [b, a] });
  const saved = getDashboard(c);
  assert.deepStrictEqual(saved.layouts.map((l) => l.id), ['L2', 'L1']);
  assert.equal(saved.active, 'L2');
});

// Every refusal must leave the stored set as it was: the payload is validated
// whole before anything is written.
const REFUSED = {
  'an unknown card type': layout({ cards: [card({ type: 'stocks' })] }),
  'a card past the grid edge': layout({ cards: [card({ x: 10, w: 4 })] }),
  'a card with no width': layout({ cards: [card({ w: 0 })] }),
  'a fractional cell': layout({ cards: [card({ y: 1.5 })] }),
  'a card taller than the cap': layout({ cards: [card({ h: 40 })] }),
  'two cards with one id': layout({ cards: [card(), card({ y: 6 })] }),
  'an unknown period': layout({ cards: [card({ period: { preset: 'decade', month: null } })] }),
  'a pinned month on a range': layout({ cards: [card({ period: { preset: 'ytd', month: '2026-01' } })] }),
  'a malformed month': layout({ cards: [card({ period: { preset: 'month', month: '2026-13' } })] }),
  'an unknown color': layout({ cards: [card({ color: 'chartreuse' })] }),
  'settings that are not an object': layout({ cards: [card({ settings: ['a'] })] }),
  'settings past the size cap': layout({ cards: [card({ settings: { blob: 'x'.repeat(3000) } })] }),
  'a blank layout name': layout({ name: '   ' }),
  'a layout name past the cap': layout({ name: 'x'.repeat(33) }),
  'a malformed layout id': layout({ id: 'has space' }),
  'cards that are not a list': layout({ cards: { 0: card() } }),
};

for (const [what, bad] of Object.entries(REFUSED)) {
  test(`dashboard: refuses ${what}, and keeps what was stored`, (t) => {
    const c = makeClient(t);
    c.put('/api/dashboard', { active: 'L1', layouts: [layout()] });
    const before = getDashboard(c);
    const r = c.put('/api/dashboard', { active: 'L1', layouts: [bad] });
    assert.equal(r.status, 400, `${what} should be refused: ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(getDashboard(c), before);
  });
}

test('dashboard: refuses two layouts with one id, and more layouts than the cap', (t) => {
  const c = makeClient(t);
  assert.equal(c.put('/api/dashboard', { active: 'L1', layouts: [layout(), layout()] }).status, 400);
  const many = Array.from({ length: 9 }, (_, i) => layout({ id: `L${i}`, name: `Tab ${i}` }));
  assert.equal(c.put('/api/dashboard', { active: 'L0', layouts: many }).status, 400);
  assert.equal(c.put('/api/dashboard', { active: 'L1' }).status, 400);
  assert.deepStrictEqual(getDashboard(c), { active: null, layouts: [] });
});
