'use strict';

// Tests for the match-rules service. The headline test pins `sequenceRatio`
// to a fixture of known values (fixtures/similarity-ratios.json). Both fuzzy
// thresholds are tuned to this function's scale, so a change in its output is
// a change in which rows auto-categorize; the fixture is what makes that
// deliberate rather than accidental.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sequenceRatio, normalise } = require('../services/matchRules');

test('sequenceRatio holds its pinned values', () => {
  const oracle = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'similarity-ratios.json'), 'utf8')
  );
  assert.ok(oracle.length >= 50, 'oracle has enough cases');
  for (const { a, b, ratio } of oracle) {
    const got = sequenceRatio(a, b);
    assert.ok(
      Math.abs(got - ratio) < 1e-9,
      `ratio mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}: js=${got} py=${ratio}`
    );
  }
});

test('normalise lowercases and collapses whitespace', () => {
  assert.equal(normalise('  NETFLIX   #1234 '), 'netflix #1234');
  assert.equal(normalise(''), '');
  assert.equal(normalise(null), '');
  assert.equal(normalise('A\tB\nC'), 'a b c');
});

// The auto-match RULES (exact wins, the fixed 0.92 fuzzy bar, ambiguity leaves
// the row alone) are asserted against the shipped path — applyAutoMatch, via
// import — in apiTransactions.test.js. They are not re-tested here: this file
// covers the pure pieces those rules are built from.
