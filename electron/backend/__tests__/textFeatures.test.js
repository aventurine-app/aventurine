'use strict';

// The shared text front-end (services/textFeatures.js). These tests pin the
// exact token/feature output because the classifier's weights are trained
// against it — any drift here silently invalidates the shipped model.

const test = require('node:test');
const assert = require('node:assert');

const { normaliseMerchant, tokenize, features } = require('../services/textFeatures');

test('normaliseMerchant still strips processor noise (parity with old categorize)', () => {
  assert.equal(normaliseMerchant('SQ *BLUE BOTTLE COFFEE 866-123-4567 CA'), 'blue bottle coffee');
  assert.equal(normaliseMerchant('CHECKCARD 1234 SHELL OIL'), 'shell oil');
  assert.equal(normaliseMerchant(''), '');
  assert.equal(normaliseMerchant(null), '');
});

test('tokenize drops 1-char tokens and pure-number runs, keeps &', () => {
  assert.deepEqual(tokenize('AT&T WIRELESS 5'), ['at&t', 'wireless']);
  assert.deepEqual(tokenize('POS DEBIT 4521 AUSTIN DERMATOLOGY'), ['debit', 'austin', 'dermatology']);
  assert.deepEqual(tokenize(''), []);
});

test('features emit prefixed word unigrams + adjacent bigrams', () => {
  assert.deepEqual(features('AUTO PARTS'), ['w:auto', 'b:auto parts', 'w:parts']);
  assert.deepEqual(features('NETFLIX'), ['w:netflix']);
  assert.deepEqual(features(''), []);
});
