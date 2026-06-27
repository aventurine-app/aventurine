'use strict';

// On-device cold-start categorization — the bundled-knowledge layer of the
// import moat. Where matchRules.js categorizes from what THIS user has taught
// the app, this module categorizes a description with no prior history at all,
// using the shipped merchant lexicon + keyword rules (merchantCategories.js).
//
// It is pure logic + one read-only category lookup; no network, ever (the
// whole point — categorization stays on the user's machine). Blend order at the
// call site is: learned MatchRules first (they personalise and win), then this.
//
// Trust rule (see merchantCategories.js): only auto-apply above a confidence
// bar and only when the category's direction matches the row's, so a built-in
// guess never silently flips an expense into income or miscategorizes a refund.

const { NOISE_PATTERNS, MERCHANTS, KEYWORDS } = require('./merchantCategories');
const { autoMatchEnabled } = require('./matchRules');

// Confidence scores per source, and the bar an import must clear to auto-apply.
const MERCHANT_CONFIDENCE = 0.95;
const KEYWORD_CONFIDENCE = 0.82;
const AUTO_APPLY_CONFIDENCE = 0.8;

// Longest needle first so a specific merchant ("uber eats") wins over a prefix
// of it ("uber"); computed once at load.
const MERCHANTS_BY_LEN = [...MERCHANTS].sort((a, b) => b[0].length - a[0].length);

/** Reduce a raw bank description to the bare merchant token: lowercased, with
 *  payment-network prefixes, POS/ACH markers, card masks, store/phone/ref
 *  numbers and trailing state codes stripped. Pure. */
function normaliseMerchant(description) {
  let s = String(description == null ? '' : description).toLowerCase();
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Best built-in category for a description, or null when nothing clears the
 *  bar. Returns {categoryKey, confidence, source}. Pure — no DB, no per-user
 *  state; resolution of the key to this DB's category id happens in the caller. */
function categorize(description) {
  const cleaned = normaliseMerchant(description);
  if (!cleaned) return null;

  for (const [needle, key] of MERCHANTS_BY_LEN) {
    if (cleaned.includes(needle)) {
      return { categoryKey: key, confidence: MERCHANT_CONFIDENCE, source: 'merchant' };
    }
  }
  for (const [needle, key] of KEYWORDS) {
    if (cleaned.includes(needle)) {
      return { categoryKey: key, confidence: KEYWORD_CONFIDENCE, source: 'keyword' };
    }
  }
  return null;
}

/**
 * Auto-categorize still-uncategorized tx-like objects in place from the
 * built-in lexicon; returns the count categorized. Mirrors
 * matchRules.applyAutoMatch's shape (gating, in-place mutation, batch DB read)
 * and is meant to run AFTER it, so learned per-user rules always take priority.
 *
 * Guards: same on/off setting as learned matching; only categories that still
 * exist in this DB; only confident matches; and only when the category's
 * direction (cat_type) equals the row's current tx_type — never flips a row's
 * income/expense direction on a guess.
 */
function applyBuiltinCategorize(db, transactions) {
  if (!autoMatchEnabled(db)) return 0;

  // key -> {id, cat_type} for the keys this DB actually has (respects a user
  // who renamed/deleted defaults: a missing key is simply skipped).
  const catByKey = new Map(
    db.prepare('SELECT id, "key" AS key, cat_type FROM categories').all().map((c) => [c.key, c])
  );

  let n = 0;
  for (const t of transactions) {
    if (t.category_id != null || !t.description) continue;
    const hit = categorize(t.description);
    if (!hit || hit.confidence < AUTO_APPLY_CONFIDENCE) continue;
    const cat = catByKey.get(hit.categoryKey);
    if (!cat) continue;
    // Direction guard: don't let a built-in guess flip the row's direction.
    if (cat.cat_type !== t.tx_type) continue;
    t.category_id = cat.id;
    t.tx_type = cat.cat_type;
    n++;
  }
  return n;
}

module.exports = {
  MERCHANT_CONFIDENCE,
  KEYWORD_CONFIDENCE,
  AUTO_APPLY_CONFIDENCE,
  normaliseMerchant,
  categorize,
  applyBuiltinCategorize,
};
