'use strict';

// Lint fence for the merchant lexicon (services/merchantCategories.js).
//
// The lexicon matches needles as SUBSTRINGS of a normalized description, so
// its failure mode is silent: a needle that hides inside an unrelated word
// ("mobil" in "mobile deposit", "shell" in "shelly") confidently
// miscategorizes, which is the one thing the trust rule forbids. These checks
// make every entry prove, mechanically, that it can't do that:
//
//   1. Structural: needles are pre-normalized, unique, reachable, and point at
//      categories that actually exist in the default taxonomy.
//   2. Hazard corpus (fixtures/lexicon-hazards.json): realistic statement
//      strings — bank ops, P2P payees, generic LLCs, city names, card-payment
//      rows — that must ALL abstain. Growing the lexicon means growing this
//      list with the traps the new needles could spring.
//
// Authoring aid: `node scripts/lexicon-check.js "<candidate needle>"` runs the
// same collision logic against a proposed entry before it lands here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { MERCHANTS, KEYWORDS } = require('../services/merchantCategories');
const { normaliseMerchant, categorize } = require('../services/categorize');
const { DEFAULT_CATEGORIES } = require('../seed');

const ALL_ENTRIES = [
  ...MERCHANTS.map(([n, k]) => [n, k, 'merchant']),
  ...KEYWORDS.map(([n, k]) => [n, k, 'keyword']),
];

// Three-letter needles individually vetted as safe substrings (brand initials
// that don't occur inside English words or names we could find). Anything new
// this short must be argued onto this list, not silently added.
const VETTED_SHORT_NEEDLES = new Set(['cvs', 'kfc', 'gnc', 'fpl', 'bbq', 'dmv', 'h&m']);

test('lexicon: every needle survives its own normalizer', () => {
  // A needle containing noise the normalizer strips ("visa", "payment", a long
  // digit run) can never match anything; it would be dead weight that looks
  // like coverage.
  for (const [needle, , kind] of ALL_ENTRIES) {
    assert.equal(
      normaliseMerchant(needle),
      needle,
      `${kind} needle "${needle}" does not survive normaliseMerchant — it can never match`
    );
  }
});

test('lexicon: needles are unique across merchants and keywords', () => {
  const seen = new Map();
  for (const [needle, key, kind] of ALL_ENTRIES) {
    const prev = seen.get(needle);
    assert.equal(prev, undefined, `"${needle}" (${kind} -> ${key}) duplicates ${prev}`);
    seen.set(needle, `${kind} -> ${key}`);
  }
});

test('lexicon: every category key exists in the default taxonomy', () => {
  const valid = new Set(DEFAULT_CATEGORIES.map(([key]) => key));
  for (const [needle, key] of ALL_ENTRIES) {
    assert.ok(valid.has(key), `"${needle}" maps to unknown category key "${key}"`);
  }
});

test('lexicon: needles shorter than 4 chars are individually vetted', () => {
  for (const [needle, , kind] of ALL_ENTRIES) {
    assert.ok(
      needle.length >= 4 || VETTED_SHORT_NEEDLES.has(needle),
      `${kind} needle "${needle}" is too short to be a safe substring — vet it and add to the allowlist`
    );
  }
});

test('lexicon: a general keyword never shadows a more specific one of another category', () => {
  // KEYWORDS is first-match-in-array-order (unlike MERCHANTS, which sorts
  // longest-first). If "hospital" preceded "animal hospital" with a different
  // category, the specific entry would be unreachable.
  for (let i = 0; i < KEYWORDS.length; i++) {
    for (let j = i + 1; j < KEYWORDS.length; j++) {
      const [general, generalKey] = KEYWORDS[i];
      const [specific, specificKey] = KEYWORDS[j];
      if (specific.includes(general) && generalKey !== specificKey) {
        assert.fail(
          `keyword "${general}" (${generalKey}) at index ${i} shadows ` +
            `"${specific}" (${specificKey}) at index ${j} — move the specific entry first`
        );
      }
    }
  }
});

test('lexicon: hazard corpus never triggers a category', () => {
  const hazards = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'lexicon-hazards.json'), 'utf8')
  );
  assert.ok(hazards.length >= 50, 'hazard corpus has enough cases');
  for (const desc of hazards) {
    const hit = categorize(desc);
    assert.equal(
      hit,
      null,
      `hazard "${desc}" categorized as ${hit && hit.categoryKey} (via ${hit && hit.source}) — ` +
        'a lexicon entry is hiding inside an unrelated description'
    );
  }
});
