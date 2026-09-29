'use strict';

// services/merchantSuggest.js — the brand index behind the Recurring editor's
// Name suggestions. The endpoint that serves them (GET /api/recurring/brands,
// which resolves each category key against the user's own taxonomy) is covered
// in recurring.test.js; this file pins the pure half: what counts as a match,
// and the order the matches come back in.
//
// Order is the part worth pinning. The list is short and the top row is what a
// user takes with one Enter, so a query that plainly names one merchant has to
// put that merchant first — not merely somewhere in the list.

const test = require('node:test');
const assert = require('node:assert');

const { suggestMerchants, BRANDS } = require('../services/merchantSuggest');

const names = (q, limit) => suggestMerchants(q, limit).map((b) => b.name);

test('merchant suggest: a prefix of the name puts that merchant first', () => {
  assert.equal(names('netfl')[0], 'Netflix');
  assert.equal(names('chipot')[0], 'Chipotle');
});

test('merchant suggest: a whole word inside the name matches', () => {
  // The half of the name a user reaches for when the first word is the generic
  // one — they think "Panda Express", and typing either word has to find it.
  assert.ok(names('express').includes('Panda Express'));
});

test('merchant suggest: a name starting with the query outranks one merely containing it', () => {
  const list = names('star');
  const starts = list.findIndex((n) => n.toLowerCase().startsWith('star'));
  const contains = list.findIndex((n) => !n.toLowerCase().startsWith('star'));
  assert.ok(starts === 0, `the list leads with a name that starts with it: ${list}`);
  assert.ok(contains === -1 || starts < contains, 'and everything else follows');
});

test('merchant suggest: an alternate lexicon spelling still finds the brand', () => {
  assert.deepStrictEqual(names("wendy's"), ["Wendy's"], 'the needle matches even when the display name does not');
});

test('merchant suggest: one merchant is offered once, however many spellings it has', () => {
  const list = names('wendy');
  assert.deepStrictEqual(list, [...new Set(list)]);
  assert.deepStrictEqual(list, ["Wendy's"]);
});

test('merchant suggest: a query too short, empty or unknown returns nothing', () => {
  assert.deepStrictEqual(suggestMerchants('n'), []);
  assert.deepStrictEqual(suggestMerchants(''), []);
  assert.deepStrictEqual(suggestMerchants(null), []);
  assert.deepStrictEqual(suggestMerchants('zzzqqxnotabrand'), []);
});

test('merchant suggest: the cap is honoured', () => {
  assert.ok(suggestMerchants('a', 5).length <= 5);
  assert.ok(suggestMerchants('co', 3).length <= 3);
});

test('merchant suggest: the same query twice gives the same list, in the same order', () => {
  assert.deepStrictEqual(names('ma'), names('ma'), 'a list that reshuffled would move the row under the pointer');
});

test('merchant suggest: every brand carries a name and a category key to offer', () => {
  assert.ok(BRANDS.length > 100, 'the lexicon is the whole point');
  for (const brand of BRANDS) {
    assert.ok(brand.name && typeof brand.name === 'string', `named: ${JSON.stringify(brand)}`);
    assert.ok(brand.category_key, `categorized: ${brand.name}`);
    assert.ok(brand.needles.length, `searchable: ${brand.name}`);
  }
});

test('merchant suggest: generic needles categorize but are never offered as names', () => {
  // merchantDisplayFor returns null for these — "grocery" is not a merchant.
  for (const generic of ['grocery', 'supermarket', 'payroll', 'direct deposit']) {
    assert.ok(!BRANDS.some((b) => b.name.toLowerCase() === generic), generic);
  }
});
