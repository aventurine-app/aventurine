'use strict';

// The Dashboard's layout engine (static/js/widgets/dashgrid.js). The rules a
// user feels without being told: cards fall upward in reading order and leave
// no holes, a dragged card swaps with a neighbour once it passes that
// neighbour's middle, a resize pushes only what is below it, the keyboard swaps
// with the nearest card in the same columns, and a new card takes the highest
// open spot.

const test = require('node:test');
const assert = require('node:assert');

const DashGrid = require('../../../static/js/widgets/dashgrid.js');

const card = (id, x, y, w, h) => ({ id, x, y, w, h });
/** Positions keyed by id, for readable assertions. */
const at = (cards) => Object.fromEntries(cards.map((c) => [c.id, [c.x, c.y, c.w, c.h]]));

test('grid: stack drops each card onto the skyline of its columns', () => {
  const out = DashGrid.stack([card('a', 0, 5, 4, 3), card('b', 4, 9, 4, 2), card('c', 0, 0, 8, 2)]);
  // a and b rise to the top; c lands under the taller of the two columns it spans.
  assert.deepStrictEqual(at(out), { a: [0, 0, 4, 3], b: [4, 0, 4, 2], c: [0, 3, 8, 2] });
});

test('grid: a card past the edge is pulled in, and one wider than the grid is narrowed', () => {
  const out = DashGrid.stack([card('a', 10, 0, 4, 2), card('b', 0, 0, 20, 2)]);
  assert.deepStrictEqual(at(out), { a: [8, 0, 4, 2], b: [0, 2, 12, 2] });
});

test('grid: a packed layout packs to itself, and the input is never mutated', () => {
  const layout = [card('a', 0, 0, 4, 5), card('b', 4, 0, 4, 5), card('c', 8, 0, 4, 5), card('d', 0, 5, 6, 4)];
  const copy = JSON.parse(JSON.stringify(layout));
  assert.deepStrictEqual(at(DashGrid.pack(layout)), at(layout));
  DashGrid.arrangeMove(layout, { ...layout[0], x: 6, y: 5 });
  assert.deepStrictEqual(layout, copy);
});

test('grid: a dragged card swaps with the card below once it passes its middle', () => {
  const layout = [card('a', 0, 0, 4, 4), card('b', 0, 4, 4, 4)];
  // Up to b's middle (row 6), level included: a keeps its turn and stays on top.
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 1 })), at(layout));
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 4 })), at(layout));
  // Past it: a takes b's place, the way a list reorders under a drag.
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 5 })),
    { b: [0, 0, 4, 4], a: [0, 4, 4, 4] });
});

test('grid: a dragged card moves up past a card once it reaches its middle', () => {
  const layout = [card('a', 0, 0, 4, 4), card('b', 0, 4, 4, 4)];
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[1], y: 0 })),
    { b: [0, 0, 4, 4], a: [0, 4, 4, 4] });
});

test('grid: dropping onto an occupied cell pushes the occupant down, not aside', () => {
  const layout = [card('a', 0, 0, 4, 3), card('b', 4, 0, 4, 3)];
  const out = DashGrid.arrangeMove(layout, { ...layout[0], x: 4 });
  assert.deepStrictEqual(at(out), { a: [4, 0, 4, 3], b: [4, 3, 4, 3] });
});

test('grid: a card dragged in from outside the layout is placed like a moved one', () => {
  const layout = [card('a', 0, 0, 6, 3), card('b', 6, 0, 6, 3)];
  const out = DashGrid.arrangeMove(layout, card('new', 6, 0, 6, 2));
  assert.deepStrictEqual(at(out), { a: [0, 0, 6, 3], new: [6, 0, 6, 2], b: [6, 2, 6, 3] });
});

test('grid: a resize keeps the card in place and pushes only what is under it', () => {
  const layout = [card('a', 0, 0, 4, 3), card('b', 4, 0, 4, 3), card('c', 0, 3, 4, 3)];
  const out = DashGrid.arrangeInPlace(layout, { ...layout[0], h: 5 });
  assert.deepStrictEqual(at(out), { a: [0, 0, 4, 5], b: [4, 0, 4, 3], c: [0, 5, 4, 3] });
});

test('grid: the keyboard swaps with the nearest card sharing a column', () => {
  const layout = [card('a', 0, 0, 4, 2), card('b', 8, 0, 4, 2), card('c', 0, 2, 4, 2)];
  // b is nearer in reading order, but it shares no column with a.
  assert.deepStrictEqual(at(DashGrid.moveVertical(layout, 'a', 1)), { c: [0, 0, 4, 2], a: [0, 2, 4, 2], b: [8, 0, 4, 2] });
  assert.equal(DashGrid.moveVertical(layout, 'a', -1), null, 'already at the top');
  assert.equal(DashGrid.moveVertical(layout, 'c', 1), null, 'already at the bottom');
  assert.equal(DashGrid.moveVertical(layout, 'missing', 1), null);
});

test('grid: a new card takes the highest open spot, leftmost on a tie', () => {
  const layout = [card('a', 0, 0, 4, 6), card('b', 4, 0, 4, 2), card('c', 8, 0, 4, 4)];
  assert.deepStrictEqual(DashGrid.firstFit(layout, 4), { x: 4, y: 2 });
  assert.deepStrictEqual(DashGrid.firstFit(layout, 8), { x: 4, y: 4 });
  assert.deepStrictEqual(DashGrid.firstFit([], 6), { x: 0, y: 0 });
  assert.equal(DashGrid.bottom(layout), 6);
  assert.equal(DashGrid.bottom([]), 0);
});
