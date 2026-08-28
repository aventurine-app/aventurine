'use strict';

// The on-device classifier (services/classifier.js) against its held-out eval
// corpus (fixtures/classifier-eval.json): describable-but-unseen merchants the
// lexicon doesn't name, plus hard negatives that must stay blank.
//
// The contract, in priority order:
//   • PRECISION FIRST — it must not miscategorize. A wrong category is worse than
//     a blank one, which the UI already states will occur. Same rule as the
//     lexicon.
//   • RECALL SECOND — it should categorize a reasonable share of readable
//     merchants, but returning null is always an acceptable result.
//
// (Abstention on the 119-row hazard corpus is fenced separately, through the
// full categorize() pipeline, in lexiconLint.test.js.)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { classify } = require('../services/classifier');

const evalSet = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'classifier-eval.json'), 'utf8')
);

test('classifier: precision is perfect on the eval set (never miscategorizes)', () => {
  let wrong = 0;
  let falsePositive = 0;
  for (const { desc, expected } of evalSet) {
    const hit = classify(desc);
    const got = hit ? hit.categoryKey : null;
    if (expected === null) {
      if (got !== null) falsePositive++;
    } else if (got !== null && got !== expected) {
      wrong++;
    }
  }
  assert.equal(wrong, 0, 'no describable merchant categorized to the wrong bucket');
  assert.equal(falsePositive, 0, 'no should-be-blank row guessed');
});

test('classifier: recovers a healthy share of describable-unseen merchants', () => {
  const positives = evalSet.filter((r) => r.expected !== null);
  let covered = 0;
  for (const { desc, expected } of positives) {
    const hit = classify(desc);
    if (hit && hit.categoryKey === expected) covered++;
  }
  const recall = covered / positives.length;
  // A floor, not a target — the model currently sits well above this. It catches
  // a regression that drops recall, rather than driving coverage up.
  assert.ok(recall >= 0.6, `recall ${(recall * 100).toFixed(0)}% fell below the 60% floor`);
});

test('classifier: abstains on names, generic LLCs, bank ops, gibberish', () => {
  for (const d of [
    'MARIA GARCIA',
    'STERLING CONSULTING PARTNERS',
    'ATM WITHDRAWAL 08/14',
    'ZENTRO OUTPOST 4471',
    'ZELLE TO MICHAEL BROOKS',
    'THE CORNER STORE', // a bare ambiguous token must not clear the gate
  ]) {
    assert.equal(classify(d), null, `should abstain on "${d}"`);
  }
});

test('classifier: reads descriptive merchants the lexicon never names', () => {
  assert.equal(classify('METRO SPORTING GOODS').categoryKey, 'shopping');
  assert.equal(classify('SUNRISE AUTOMOTIVE SERVICE').categoryKey, 'automobile');
  assert.equal(classify('HARBOR BEHAVIORAL HEALTH').categoryKey, 'health');
  // Returns a confidence above the import auto-apply threshold, tagged with its
  // source so the tier order stays traceable.
  const hit = classify('METRO SPORTING GOODS');
  assert.equal(hit.source, 'classifier');
  assert.ok(hit.confidence >= 0.8);
});
