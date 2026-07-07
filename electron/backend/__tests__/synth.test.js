'use strict';

// The synthetic training-data generator (scripts/lib/synth.js). It must be
// deterministic — the shipped model weights are reproducible only if the same
// seed yields byte-identical data — and it must produce well-formed, well-
// balanced labels. This does NOT test model accuracy (that's classifier.test.js
// against the held-out eval corpus); it guards the data pipeline.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { generateDataset } = require(path.join('..', '..', 'scripts', 'lib', 'synth'));
const { DEFAULT_CATEGORIES } = require('../seed');

test('generator is deterministic for a given seed', () => {
  const a = generateDataset({ seed: 42, perLexiconEntry: 2, perDescriptor: 5, unknownCount: 500 });
  const b = generateDataset({ seed: 42, perLexiconEntry: 2, perDescriptor: 5, unknownCount: 500 });
  assert.equal(a.length, b.length);
  assert.deepEqual(a.slice(0, 50), b.slice(0, 50));
});

test('a different seed yields different data', () => {
  const a = generateDataset({ seed: 1, perLexiconEntry: 2, perDescriptor: 5, unknownCount: 500 });
  const b = generateDataset({ seed: 2, perLexiconEntry: 2, perDescriptor: 5, unknownCount: 500 });
  assert.notDeepEqual(a.slice(0, 50), b.slice(0, 50));
});

test('every label is a real category key or "unknown"', () => {
  const valid = new Set([...DEFAULT_CATEGORIES.map(([k]) => k), 'unknown']);
  const data = generateDataset({ perLexiconEntry: 1, perDescriptor: 2, unknownCount: 300 });
  for (const { text, label } of data) {
    assert.ok(valid.has(label), `bad label "${label}"`);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
  }
});

test('"unknown" is well represented (drives abstention)', () => {
  const data = generateDataset();
  const unknown = data.filter((d) => d.label === 'unknown').length;
  // Enough negatives that the classifier can learn to predict "leave blank".
  assert.ok(unknown / data.length > 0.25, `unknown share ${(unknown / data.length).toFixed(2)} too low`);
});
