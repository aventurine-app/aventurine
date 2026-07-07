'use strict';

// Authoring aid for the merchant lexicon: vet a candidate needle BEFORE adding
// it to backend/services/merchantCategories.js.
//
//   node scripts/lexicon-check.js "blue bottle" "casey's" ...
//
// For each candidate it reports the hazards the lint fence
// (backend/__tests__/lexiconLint.test.js) would catch, plus soft signals the
// fence can't check mechanically (substring overlap with existing needles —
// fine when categories agree, a judgment call when they don't, since MERCHANTS
// resolves by longest-needle-first and KEYWORDS by array order).

const path = require('path');
const fs = require('fs');

const backend = path.join(__dirname, '..', 'backend');
const { MERCHANTS, KEYWORDS } = require(path.join(backend, 'services', 'merchantCategories'));
const { normaliseMerchant } = require(path.join(backend, 'services', 'categorize'));

const HAZARDS = JSON.parse(
  fs.readFileSync(path.join(backend, '__tests__', 'fixtures', 'lexicon-hazards.json'), 'utf8')
);

const candidates = process.argv.slice(2);
if (candidates.length === 0) {
  console.error('usage: node scripts/lexicon-check.js "<candidate needle>" [...more]');
  process.exit(2);
}

const ALL = [
  ...MERCHANTS.map(([n, k]) => [n, k, 'merchant']),
  ...KEYWORDS.map(([n, k]) => [n, k, 'keyword']),
];

let problems = 0;
for (const raw of candidates) {
  const needle = raw.toLowerCase().trim();
  console.log(`\n── "${needle}"`);
  let ok = true;

  const survived = normaliseMerchant(needle);
  if (survived !== needle) {
    console.log(`  ✗ does not survive normaliseMerchant (becomes "${survived}") — it can never match`);
    ok = false;
  }
  if (needle.length < 4) {
    console.log('  ✗ under 4 chars — must be vetted onto the shortlist in lexiconLint.test.js');
    ok = false;
  }

  for (const [existing, key, kind] of ALL) {
    if (existing === needle) {
      console.log(`  ✗ already in the lexicon (${kind} -> ${key})`);
      ok = false;
    } else if (existing.includes(needle)) {
      console.log(`  • is a substring of existing ${kind} "${existing}" (${key}) — longest-first decides; check the category agrees`);
    } else if (needle.includes(existing)) {
      console.log(`  • contains existing ${kind} "${existing}" (${key}) — your longer needle would win; check that's intended`);
    }
  }

  for (const hazard of HAZARDS) {
    const cleaned = normaliseMerchant(hazard);
    if (cleaned.includes(needle)) {
      console.log(`  ✗ hides inside hazard "${hazard}" — would confidently miscategorize it`);
      ok = false;
    }
  }

  if (ok) console.log('  ✓ no collisions found (still: only add brands with one obvious category)');
  else problems++;
}

process.exit(problems ? 1 : 0);
