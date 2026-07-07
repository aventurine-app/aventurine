'use strict';

// Shared text front-end for both categorization layers: the deterministic
// lexicon (services/categorize.js) and the on-device classifier
// (services/classifier.js). Keeping normalization + tokenization in ONE place
// guarantees the model is trained and queried on exactly the bytes the lexicon
// sees — a drift here would silently wreck classifier precision.
//
// Dependency-free and pure. NOISE_PATTERNS lives in merchantCategories.js
// (data) so this module has no cycle with categorize.js/classifier.js.

const { NOISE_PATTERNS } = require('./merchantCategories');

/** Reduce a raw bank description to the bare merchant token: lowercased, with
 *  payment-network prefixes, POS/ACH markers, card masks, store/phone/ref
 *  numbers and trailing state codes stripped. Pure. */
function normaliseMerchant(description) {
  let s = String(description == null ? '' : description).toLowerCase();
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Split a normalized description into content tokens. Drops 1-char tokens and
 *  pure-number runs (dates/ids the normalizer didn't catch) — they carry no
 *  merchant signal and only add noise to the model. Keeps '&' (brand names). */
function tokenize(description) {
  const cleaned = normaliseMerchant(description);
  if (!cleaned) return [];
  return cleaned
    .split(/[^a-z0-9&]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/** Bag of features for the classifier: word unigrams + adjacent bigrams.
 *  Bigrams let "auto" + "parts" or "new" + "balance" carry more than the sum of
 *  their unigrams. Prefixed ('w:'/'b:') so the two feature spaces never collide.
 *  Returns a plain array (repeats allowed — multinomial NB counts them). */
function features(description) {
  const toks = tokenize(description);
  const feats = [];
  for (let i = 0; i < toks.length; i++) {
    feats.push('w:' + toks[i]);
    if (i + 1 < toks.length) feats.push('b:' + toks[i] + ' ' + toks[i + 1]);
  }
  return feats;
}

module.exports = { normaliseMerchant, tokenize, features };
