'use strict';

// Tests for the built-in cold-start categorizer (services/categorize.js): the
// description normaliser, the lexicon/keyword matcher, and — the headline — an
// accuracy run over a labeled corpus of messy bank descriptions
// (fixtures/categorize-corpus.json).
//
// The corpus is a CURATED dev set, not a guarantee of real-world accuracy; it
// is a regression fence so the two properties we actually care about can't
// silently rot:
//   • PRECISION — when it does categorize, it must be right (trust rule:
//     a confident wrong category is worse than a blank one).
//   • COVERAGE  — it categorizes the merchants it claims to know.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { normaliseMerchant, categorize } = require('../services/categorize');

test('normaliseMerchant strips processor prefixes, masks, store/phone numbers, state tails', () => {
  assert.equal(normaliseMerchant('SQ *BLUE BOTTLE COFFEE 866-123-4567 CA'), 'blue bottle coffee');
  assert.equal(normaliseMerchant("POS DEBIT MCDONALD'S #4521 CHICAGO IL"), "debit mcdonald's chicago");
  assert.equal(normaliseMerchant('AMZN MKTP US*2X4AB1CD3'), 'amzn mktp us*2x4ab1cd3');
  assert.equal(normaliseMerchant('CHECKCARD 1234 SHELL OIL'), 'shell oil');
  assert.equal(normaliseMerchant(''), '');
  assert.equal(normaliseMerchant(null), '');
});

test('categorize: named merchant beats keyword and a longer needle beats a prefix', () => {
  assert.equal(categorize('NETFLIX.COM').categoryKey, 'entertainment');
  assert.equal(categorize('UBER EATS 123 MAIN').categoryKey, 'dining'); // not "uber" -> automobile
  assert.equal(categorize('CVS/PHARMACY #1').source, 'merchant');       // cvs (merchant) over pharmacy (keyword)
});

test('categorize: abstains (returns null) on unknown merchants', () => {
  assert.equal(categorize('ZENTRO OUTPOST 4471'), null);
  assert.equal(categorize('JOHNSON & CO LLC'), null);
  assert.equal(categorize('ATM WITHDRAWAL'), null);
  assert.equal(categorize(''), null);
});

test('categorize: does not fire on ambiguous substrings (no false positives)', () => {
  // bare "rent" must not match via "parent"/"current"; "gas" is intentionally
  // not a keyword (fuel vs. gas utility).
  assert.equal(categorize('PARENT TEACHER ASSOC DUES'), null);
  assert.equal(categorize('CURRENT ACCOUNT FEE'), null);
  assert.equal(categorize('NATIONAL GAS SUPPLY CO'), null);
});

test('corpus: precision is perfect and coverage clears 90%', () => {
  const corpus = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'categorize-corpus.json'), 'utf8')
  );
  assert.ok(corpus.length >= 30, 'corpus has enough cases');

  let categorizable = 0, covered = 0, wrong = 0, falsePositives = 0;
  for (const { desc, expected } of corpus) {
    const hit = categorize(desc);
    const got = hit ? hit.categoryKey : null;
    if (expected === null) {
      if (got !== null) falsePositives++; // guessed on something we want left blank
      continue;
    }
    categorizable++;
    if (got === expected) covered++;
    else if (got !== null) wrong++; // categorized, but to the wrong bucket
  }

  // Precision: never miscategorize on this set (wrong bucket OR a guess on a
  // should-be-blank row both count against trust).
  assert.equal(wrong, 0, 'no rows categorized to the wrong bucket');
  assert.equal(falsePositives, 0, 'no rows guessed that should stay uncategorized');

  // Coverage of the merchants the lexicon claims to know.
  const coverage = covered / categorizable;
  assert.ok(coverage >= 0.9, `coverage ${(coverage * 100).toFixed(1)}% should be >= 90%`);
});
