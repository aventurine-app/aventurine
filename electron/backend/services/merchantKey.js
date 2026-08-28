'use strict';

// Merchant identity — the grouping rule shared by every report that counts a
// ledger by merchant rather than by category (Reports → Spending's Top
// Merchants, Reports → Investing's per-merchant breakdown).
//
// Extracted from handlers/topMerchants.js for the same reason
// services/merchantSearch.js was: a second report needed the same rule, and two
// copies would drift, leaving the two reports with different merchant counts
// for one ledger.
//
// TWO TIERS, in the same precision-first order the rest of the app names a
// merchant in:
//   1. transactions.display_name, when the import lexicon matched the row —
//      falling back to the same lexicon at READ time when nothing is stored, so
//      rows imported before display_name existed do not form a second group
//      beside the brand's (see resolvedName).
//      It is a curated name (see the clean-display-name rule), so it groups a
//      brand across descriptions with no text in common ("SQ *BLUE BOTTLE 1234"
//      and "BLUEBOTTLECOFFEE.COM" become one group), and it is what allows the
//      row to carry a brand icon.
//   2. Otherwise the leading content tokens of normaliseMerchant(description) —
//      the same front-end the lexicon and the classifier read the row through
//      (services/textFeatures.js), so the processor prefix, POS/ACH marker, card
//      mask, store number, phone number and trailing state code are already
//      gone.
// A row with neither (a description of pure digits, or none at all) matches no
// merchant and gets a null key, since a bar has to be labelled. Callers handle
// those rows differently — Top Merchants drops them, Investing folds them into
// its "Other" slice so the stack still totals what the line above it plots.
//
// WHY A BOUNDED PREFIX, and not the whole normalised string: merchants append
// arbitrary per-charge data to the END of a description. Noise also arrives at
// the FRONT ("WEB PMTS Greenspring"), which a positional key cannot remove on
// its own — that is what STOP_TOKENS below is for, and why the two are used
// together. Once the furniture is removed the leading tokens are the stable part
// and the tail is the noisy part. The recurring detector's normaliseDesc() is
// not enough here on its own — it removes only DIGITS, so an alphanumeric
// reference survives as its letters ("AMZN Mktp US*RT4G81N23" and
// "...*2K9LM4881" became "amzn mktp us rtgn" and "amzn mktp us klm", two groups
// for one merchant). Tokens mixing letters and digits are dropped for the same
// reason: merchant names do not take that form. normaliseDesc is NOT changed —
// it is the persisted key of recurring_overrides and is oracle-pinned, so
// widening it would orphan saved schedule corrections.

const { normaliseMerchant } = require('./textFeatures');
const { merchantDisplayName } = require('./categorize');

// ── Grouping strength ────────────────────────────────────────────────────────
// How many leading content tokens make up an unnamed row's grouping key: the
// one dial for how hard these reports fold descriptions together. Fewer tokens
// = stronger folding = more risk of two businesses sharing a group.
//
// 2 is measured. At 3, one bank's "GIANT #6300 ... PA" and "GIANT 6300 RED LION
// PA" stay two groups because the location text differs. At 1, keys degrade to
// single generic words ("med", "org", "store", "dental") that collide as a
// ledger grows. 2 keeps a qualifier on the name without keeping the location.
const KEY_TOKENS = 2;

// Statement furniture that survives NOISE_PATTERNS, which is shared with the
// classifier and so cannot be widened for grouping alone (its tokenization is
// baked into the trained model). Two kinds live here:
//   - plurals and variants the shared patterns do not match: "\bpmt\b" does not
//     match "PMTS", which is why "WEB PMTS Greenspring" kept a "pmts" token.
//   - bare payment-processor prefixes. NOISE_PATTERNS strips these only when
//     followed by '*' ("SQ *CAFE"), so "SP GRAMS28" and "WL *Steam" left an
//     "sp"/"wl" token that then used up a slot in the key.
const STOP_TOKENS = new Set([
  'pmt', 'pmts', 'payments', 'purchases', 'debit', 'check', 'card', 'draft', 'memo', 'misc',
  'des', 'indn', 'ppd', 'ccd', 'tel', 'ref', 'conf', 'trace', 'seq', 'trn', 'trns', 'trnsfr',
  'xfer', 'transfer', 'transfers', 'bill', 'billpay', 'epay', 'echeck',
  'sq', 'sp', 'tst', 'wl', 'py', 'ls', 'uep', 'pp', 'qsr',
  'the', 'inc', 'llc',
]);

// A brand name may carry a digit or two at one END ("5 Guys", "7-Eleven",
// "84 Lumber", "ISC2"). A digit anywhere ELSE means a store or reference code
// ("t1221", "9a2b", "nb39r93n0"). The two errors differ in cost: dropping
// "5guys" removes the merchant name itself.
const BRAND_WITH_DIGITS = /^\d{1,2}[a-z]+$|^[a-z]+\d{1,2}$/;
// 'y' counts as a vowel, so "xfinity" survives.
const HAS_VOWEL = /[aeiouy]/;

/** The identifying tokens of a raw description, noisiest parts already removed
 *  by normaliseMerchant. NOT textFeatures.tokenize: that drops 1-character
 *  tokens, which suits classifier features but would fold "SHOP A" and "SHOP B"
 *  onto one bar. '&' is kept, as it appears in brand names ("stop & shop"). */
function merchantTokens(description) {
  const cleaned = normaliseMerchant(description);
  if (!cleaned) return [];
  return cleaned.split(/[^a-z0-9&]+/).filter((t) => {
    if (!t || /^\d+$/.test(t)) return false;                        // bare numbers
    if (/\d/.test(t) && !BRAND_WITH_DIGITS.test(t)) return false;   // store/ref codes
    // A long run of letters with no vowel is a reference code, not a word:
    // "SGQBDG". Threshold kept high enough that initialisms (CVS, KFC, TJX)
    // pass.
    if (t.length >= 4 && !HAS_VOWEL.test(t)) return false;
    return !STOP_TOKENS.has(t);
  });
}

/** The curated name for a row, or ''. Falls back to the lexicon at READ time
 *  when nothing is stored, so a merchant does not split into two groups because
 *  some of its rows were imported before display_name existed (v8) or before
 *  the lexicon covered the brand. Same dictionary either way, so this widens
 *  coverage but never generates a name. It also re-names a row whose stored
 *  name was cleared by a description edit — for GROUPING only; the ledger
 *  display is unchanged. */
function resolvedName(row) {
  const stored = String(row.display_name || '').trim();
  if (stored) return stored;
  return String(merchantDisplayName(row.description) || '').trim();
}

/** The merchant key for this row, or null when neither tier matches. Prefixed
 *  so a curated name and a token key cannot collide in one key space (a lexicon
 *  name is lowercased, which is all the token key guarantees either). */
function merchantKey(row) {
  const name = resolvedName(row);
  if (name) return `n:${name.toLowerCase()}`;
  const desc = merchantTokens(row.description).slice(0, KEY_TOKENS).join(' ');
  return desc ? `d:${desc}` : null;
}

module.exports = {
  merchantKey,
  merchantTokens,
  resolvedName,
  KEY_TOKENS,
  STOP_TOKENS,
};
