'use strict';

// On-device cold-start categorization — the bundled-data layer. matchRules.js
// categorizes from this user's prior assignments; this module categorizes a
// description with no prior history at all. Three tiers, run in order of
// decreasing precision:
//   1. merchant lexicon  — named brands, substring match  (merchantCategories)
//   2. keyword rules      — generic descriptive terms       (merchantCategories)
//   3. classifier         — statistical fallback for unseen  (classifier.js)
//      merchants the first two miss; returns null unless confident.
//
// Pure logic plus one read-only category lookup; no network call, so
// categorization stays on the user's machine. Order at the call site: learned
// MatchRules first, then this module.
//
// Application rule (see merchantCategories.js): auto-apply only above a
// confidence bar and only within the row's flow direction, so a built-in match
// cannot flip an inflow into an outflow (or vice versa) or miscategorize a
// refund. Within the outflow family a match may change the KIND — imported
// debits arrive as 'expense' by sign, and a debit to a named brokerage is a
// transfer (a contribution), not spending.

const { MERCHANTS, KEYWORDS, merchantDisplayFor } = require('./merchantCategories');
const { normaliseMerchant } = require('./textFeatures');
const { classify } = require('./classifier');
const { autoMatchEnabled } = require('./matchRules');

// Confidence scores per source, and the bar an import must clear to auto-apply.
const MERCHANT_CONFIDENCE = 0.95;
const KEYWORD_CONFIDENCE = 0.82;
const AUTO_APPLY_CONFIDENCE = 0.8;

// Longest needle first so a specific merchant ("uber eats") matches before a
// prefix of it ("uber"); computed once at load.
const MERCHANTS_BY_LEN = [...MERCHANTS].sort((a, b) => b[0].length - a[0].length);

/** Tiers 1-2 only (merchant lexicon, then keyword rules) — the deterministic,
 *  substring-matched layer. Exposed separately from categorize() so the trainer
 *  can measure what the lexicon alone leaves blank without running tier 3,
 *  whose output depends on whichever classifier model is on disk at the time
 *  (stale or circular for calibration purposes). */
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
  // Tier 3: statistical fallback for merchants the lexicon does not name.
  // Returns null unless it clears its own calibrated margin gate, and runs only
  // on rows the precision-first tiers left blank, so it never overrides them.
  return classify(description);
}

/**
 * Auto-categorize still-uncategorized tx-like objects in place from the
 * built-in lexicon; returns the count categorized. Mirrors
 * matchRules.applyAutoMatch's shape (gating, in-place mutation, batch DB read)
 * and runs AFTER it, so learned per-user rules take priority.
 *
 * Guards: same on/off setting as learned matching; only categories that still
 * exist in this DB; only confident matches; and only within the row's flow
 * direction — a match never turns an inflow into an outflow or vice versa.
 * Within outflows it MAY change the kind: imported debits arrive as 'expense'
 * (sign only), so a transfer category applying to one narrows it (a Robinhood
 * debit is a contribution to a brokerage — a transfer, not a spend) rather than
 * flipping it. Inflows are never changed: a deposit from a brokerage is a
 * withdrawal, not income, so it stays blank.
 */
function applyBuiltinCategorize(db, transactions) {
  if (!autoMatchEnabled(db)) return 0;

  // key -> {id, cat_type} for the keys this DB actually has, so defaults the
  // user renamed or deleted are skipped rather than failing.
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
    // Direction guard: a match may change an outflow's kind (expense →
    // transfer) but never cross the inflow/outflow line.
    const refinesOutflow =
      t.tx_type === 'expense' && cat.cat_type === 'transfer';
    if (cat.cat_type !== t.tx_type && !refinesOutflow) continue;
    t.category_id = cat.id;
    t.tx_type = cat.cat_type;
    n++;
  }
  return n;
}

// ── Clean display names ───────────────────────────────────────────────────────
// The ledger shows a curated merchant name (display_name) for rows the MERCHANT
// tier matches — dictionary lookup only, never a string generated from the
// description, so a name can be absent but never mangled. Keyword and
// classifier hits get no name: they identify a *kind* of business, not a
// specific one. Same longest-needle-first scan as tier 1, so the name always
// comes from the same needle the categorizer matched.

/** Canonical merchant name for a raw bank description, or null when no merchant
 *  needle matches. Generic needles that categorize but must not rename (null in
 *  DISPLAY_OVERRIDES) are skipped in favour of a shorter named needle
 *  ("PAVILIONS SUPERMARKET" → "Pavilions"). Pure. */
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
 * (same on/off gate, in-place mutation). Independent of which tier — or whether
 * any — categorized the row: the lexicon name applies even when a learned rule
 * set the category first or a guard blocked the built-in match. A name
 * identical to the description is skipped (nothing extra to show).
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
