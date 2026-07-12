'use strict';

// On-device cold-start categorization — the bundled-knowledge layer of the
// import moat. Where matchRules.js categorizes from what THIS user has taught
// the app, this module categorizes a description with no prior history at all.
// It has three tiers, tried in order of decreasing precision:
//   1. merchant lexicon  — named brands, substring match  (merchantCategories)
//   2. keyword rules      — generic descriptive terms       (merchantCategories)
//   3. classifier         — statistical fallback for unseen  (classifier.js)
//      merchants the first two miss; abstains unless confident.
//
// It is pure logic + one read-only category lookup; no network, ever (the
// whole point — categorization stays on the user's machine). Blend order at the
// call site is: learned MatchRules first (they personalise and win), then this.
//
// Trust rule (see merchantCategories.js): only auto-apply above a confidence
// bar and only when the category's direction matches the row's, so a built-in
// guess never silently flips an expense into income or miscategorizes a refund.

const { MERCHANTS, KEYWORDS, merchantDisplayFor } = require('./merchantCategories');
const { normaliseMerchant } = require('./textFeatures');
const { classify } = require('./classifier');
const { autoMatchEnabled } = require('./matchRules');

// Confidence scores per source, and the bar an import must clear to auto-apply.
const MERCHANT_CONFIDENCE = 0.95;
const KEYWORD_CONFIDENCE = 0.82;
const AUTO_APPLY_CONFIDENCE = 0.8;

// Longest needle first so a specific merchant ("uber eats") wins over a prefix
// of it ("uber"); computed once at load.
const MERCHANTS_BY_LEN = [...MERCHANTS].sort((a, b) => b[0].length - a[0].length);

/** Tiers 1-2 only (merchant lexicon, then keyword rules) — the deterministic,
 *  substring-matched layer. Exposed separately from categorize() so the
 *  trainer can ask "what does the lexicon alone leave blank?" without going
 *  through tier 3, whose answer depends on whatever classifier model happens
 *  to be on disk at the time (stale/circular for calibration purposes). */
function lexiconCategorize(description) {
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

/** Best built-in category for a description, or null when nothing clears the
 *  bar. Returns {categoryKey, confidence, source}. Pure — no DB, no per-user
 *  state; resolution of the key to this DB's category id happens in the caller. */
function categorize(description) {
  const hit = lexiconCategorize(description);
  if (hit) return hit;
  // Tier 3: statistical fallback for merchants the lexicon doesn't name. Returns
  // null (abstain) unless it clears its own calibrated margin gate, so it only
  // ever fills in blanks the precision-first tiers left — never overrides them.
  return classify(description);
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

// ── Clean display names ───────────────────────────────────────────────────────
// The ledger shows a curated merchant name (display_name) for rows the
// MERCHANT tier recognizes — dictionary lookup only, never a string generated
// from the description, so a name can't be mangled, only absent. Keyword and
// classifier hits get no name: they infer a *kind* of business, not an
// identity. Same longest-needle-first scan as tier 1, so the name always
// agrees with what the categorizer saw.

/** Canonical merchant name for a raw bank description, or null when the
 *  merchant lexicon doesn't recognize it. Generic needles that categorize but
 *  must not rename (null in DISPLAY_OVERRIDES) are skipped in favour of a
 *  shorter named needle ("PAVILIONS SUPERMARKET" → "Pavilions"). Pure. */
function merchantDisplayName(description) {
  const cleaned = normaliseMerchant(description);
  if (!cleaned) return null;
  for (const [needle] of MERCHANTS_BY_LEN) {
    if (cleaned.includes(needle)) {
      const name = merchantDisplayFor(needle);
      if (name) return name;
    }
  }
  return null;
}

/**
 * Fill in display_name on tx-like objects in place; returns the count named.
 * Runs after the categorize passes in importRows and mirrors their shape
 * (same on/off gate, in-place mutation). Independent of which tier — or
 * whether any — categorized the row: the merchant's identity is true even
 * when a learned rule got the category first or a guard held it back. A name
 * identical to the description is skipped (nothing to reveal).
 */
function applyDisplayNames(db, transactions) {
  if (!autoMatchEnabled(db)) return 0;
  let n = 0;
  for (const t of transactions) {
    if (t.display_name != null || !t.description) continue;
    const name = merchantDisplayName(t.description);
    if (!name || name === t.description) continue;
    t.display_name = name;
    n++;
  }
  return n;
}

module.exports = {
  MERCHANT_CONFIDENCE,
  KEYWORD_CONFIDENCE,
  AUTO_APPLY_CONFIDENCE,
  normaliseMerchant,
  lexiconCategorize,
  categorize,
  applyBuiltinCategorize,
  merchantDisplayName,
  applyDisplayNames,
};
