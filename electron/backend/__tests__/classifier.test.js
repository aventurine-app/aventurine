'use strict';

// The on-device classifier (services/classifier.js) against its held-out eval
// corpus (fixtures/classifier-eval.json): describable-but-unseen merchants the
// lexicon doesn't name, plus hard negatives that must stay blank.
//
// The contract, in priority order:
//   • PRECISION IS ABSOLUTE — it must never miscategorize. A wrong category is
//     worse than a blank one (the user was told they'd fill some in). This is
//     the same trust rule the lexicon lives under.
//   • RECALL IS A BONUS — it should recover a healthy share of readable
//     merchants, but abstaining is always an acceptable answer.
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
  // Floor, not a target — the model currently sits well above this. It exists
  // to catch a regression that silently guts recall, not to chase coverage.
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
  // Emits a confidence that clears the import auto-apply bar, tagged as its own
  // source so the blend order stays legible.
  const hit = classify('METRO SPORTING GOODS');
  assert.equal(hit.source, 'classifier');
  assert.ok(hit.confidence >= 0.8);
});
