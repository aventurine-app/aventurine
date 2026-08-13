'use strict';

// Top Merchants (Reports → Spending) blueprint. Read-only: ranks the merchants
// the user spent the most with over a trailing window, for the bar chart that
// sits under Spending Trends. Trends answers "what did I spend it ON"
// (categories, month by month); this answers "who did I spend it WITH"
// (merchants, totalled) — the same ledger seen through the other axis.
//
// WHAT COUNTS AS SPENDING is exactly what the sibling report counts (see
// handlers/trends.js): a categorized row whose CATEGORY is an expense, plus an
// uncategorized row whose own tx_type says expense. Transfers and income are
// out, per the direction rule — money moved between your own accounts was
// never spent with anyone.
//
// WHAT COUNTS AS ONE MERCHANT — two tiers, in the same precision-first order
// the rest of the app names a merchant in:
//   1. transactions.display_name, when the import lexicon recognized the row —
//      falling back to the same lexicon at READ time when nothing is stored, so
//      rows imported before display_name existed do not strand a second bar
//      next to the brand's own (see resolvedName).
//      It is a curated identity (see the clean-display-name rule), so it groups
//      a brand across descriptions that don't resemble each other at all
//      ("SQ *BLUE BOTTLE 1234" and "BLUEBOTTLECOFFEE.COM" are one bar), and it
//      is what lets the bar carry a real brand icon.
//   2. Otherwise the leading content tokens of normaliseMerchant(description) —
//      the same front-end the lexicon and the classifier read the row through
//      (services/textFeatures.js), so the processor prefix, POS/ACH marker, card
//      mask, store number, phone number and trailing state code are already
//      gone. The label is then the newest raw description, never a string we
//      invented from it.
// A row that has neither (a description of pure digits) identifies no merchant
// and is skipped: a bar has to be able to say whose it is.
//
// WHY A BOUNDED PREFIX, and not the whole normalised string: merchants staple
// arbitrary per-charge data onto the END of a description. Noise does also
// arrive at the FRONT ("WEB PMTS Greenspring"), which a positional key cannot
// absorb on its own — that is what STOP_TOKENS below is for, and why the two
// have to work together. Once the furniture is gone the leading tokens are the
// stable part and the tail is the noisy part. The
// recurring detector's normaliseDesc() is not enough here on its own — it only
// removes DIGITS, so an alphanumeric reference survives as its letters
// ("AMZN Mktp US*RT4G81N23" and "...*2K9LM4881" became "amzn mktp us rtgn" and
// "amzn mktp us klm", two bars for one merchant). Tokens mixing letters and
// digits are dropped for the same reason: no merchant name looks like that.
// normaliseDesc itself is deliberately NOT changed — it is the persisted key of
// recurring_overrides and is oracle-pinned, so widening it would orphan saved
// schedule corrections.
//
// THE WINDOW is a count of CALENDAR MONTHS ending with the current, partial
// one. Trends excludes the running month because a half-finished month dents a
// per-month trend line; a ranking has no such shape to dent, and "who have I
// been spending with lately" that ignores everything since the 1st would read
// as broken. 'all' drops the date filter entirely.

const { normaliseMerchant } = require('../services/textFeatures');
const { merchantDisplayName } = require('../services/categorize');
const { commonSearchTerm } = require('../services/merchantSearch');
const { addMonthKey } = require('../services/forecast');
const { round2 } = require('../validate');

// Allowed trailing windows, in months, plus the un-windowed 'all'.
const ALLOWED_WINDOWS = new Set([3, 6, 12]);
const DEFAULT_WINDOW = 12;

// How many bars the chart draws. Fixed rather than a query param: the report is
// "top merchants", and a list long enough to scroll past is a table's job.
const TOP_N = 20;

// ── Grouping strength ────────────────────────────────────────────────────────
// How many leading content tokens make up an unnamed row's grouping key: the
// one dial for how hard this report folds descriptions together. Fewer tokens
// = stronger folding = more risk of two businesses sharing a bar.
//
// 2 is measured, not guessed. At 3, one bank's "GIANT #6300 ... PA" and
// "GIANT 6300 RED LION PA" stay two bars because the location text differs. At
// 1, keys degrade to single generic words ("med", "org", "store", "dental") that
// are unique only by luck and will collide as a ledger grows. 2 keeps a
// qualifier on the name without keeping the location.
const KEY_TOKENS = 2;

// Statement furniture that survives NOISE_PATTERNS, which is shared with the
// classifier and so cannot be widened for grouping alone (its tokenization is
// baked into the trained model). Two kinds live here:
//   - plurals and variants the shared patterns just miss: "\bpmt\b" does not
//     match "PMTS", which is why "WEB PMTS Greenspring" kept a "pmts" token.
//   - bare payment-processor prefixes. NOISE_PATTERNS only strips these when
//     followed by '*' ("SQ *CAFE"), so "SP GRAMS28" and "WL *Steam" leaked an
//     "sp"/"wl" token that then ate a slot in the key.
const STOP_TOKENS = new Set([
  'pmt', 'pmts', 'payments', 'purchases', 'debit', 'check', 'card', 'draft', 'memo', 'misc',
  'des', 'indn', 'ppd', 'ccd', 'tel', 'ref', 'conf', 'trace', 'seq', 'trn', 'trns', 'trnsfr',
  'xfer', 'transfer', 'transfers', 'bill', 'billpay', 'epay', 'echeck',
  'sq', 'sp', 'tst', 'wl', 'py', 'ls', 'uep', 'pp', 'qsr',
  'the', 'inc', 'llc',
]);

// A brand may legitimately carry a digit or two at one END ("5 Guys",
// "7-Eleven", "84 Lumber", "ISC2"). A digit anywhere ELSE means a store or
// reference code ("t1221", "9a2b", "nb39r93n0"). Getting this wrong is not
// symmetric: dropping "5guys" loses the merchant's own name.
const BRAND_WITH_DIGITS = /^\d{1,2}[a-z]+$|^[a-z]+\d{1,2}$/;
// 'y' counts as a vowel, so "xfinity" survives.
const HAS_VOWEL = /[aeiouy]/;

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The identifying tokens of a raw description, noisiest parts already removed
 *  by normaliseMerchant. Deliberately NOT textFeatures.tokenize: that drops
 *  1-character tokens, which is right for classifier features and wrong here —
 *  it would fold "SHOP A" and "SHOP B" onto one bar. '&' is kept: it is part of
 *  brand names ("stop & shop"). */
function merchantTokens(description) {
  const cleaned = normaliseMerchant(description);
  if (!cleaned) return [];
  return cleaned.split(/[^a-z0-9&]+/).filter((t) => {
    if (!t || /^\d+$/.test(t)) return false;                        // bare numbers
    if (/\d/.test(t) && !BRAND_WITH_DIGITS.test(t)) return false;   // store/ref codes
    // A long run of letters with no vowel is not a word, it is a reference:
    // "SGQBDG". Kept short so real initialisms (CVS, KFC, TJX) survive.
    if (t.length >= 4 && !HAS_VOWEL.test(t)) return false;
    return !STOP_TOKENS.has(t);
  });
}

/** The curated name for a row, or ''. Falls back to the lexicon at READ time
 *  when nothing is stored, so a merchant does not get two bars just because
 *  some of its rows were imported before display_name existed (v8) or before
 *  the lexicon learned the brand. Same dictionary either way, so this can widen
 *  coverage but never invent a name. Note it also re-names a row whose stored
 *  name was cleared by a description edit — for GROUPING only; the ledger still
 *  shows what it always showed. */
function resolvedName(row) {
  const stored = String(row.display_name || '').trim();
  if (stored) return stored;
  return String(merchantDisplayName(row.description) || '').trim();
}

/** The merchant this row belongs to, or null when it names none. Prefixed so a
 *  curated name and a token key can never collide in one key space (a lexicon
 *  name is lowercased, which is all the token key guarantees either). */
function merchantKey(row) {
  const name = resolvedName(row);
  if (name) return `n:${name.toLowerCase()}`;
  const desc = merchantTokens(row.description).slice(0, KEY_TOKENS).join(' ');
  return desc ? `d:${desc}` : null;
}

function topMerchantsGet(ctx, { query }) {
  const db = ctx.db();

  const raw = String(query.window == null ? '' : query.window).trim().toLowerCase();
  let window;
  if (raw === 'all') {
    window = 'all';
  } else {
    const n = parseInt(raw, 10);
    window = ALLOWED_WINDOWS.has(n) ? n : DEFAULT_WINDOW;
  }
  // First month included: `window` months ending with the current one.
  const from = window === 'all' ? null : addMonthKey(currentMonthKey(), -(window - 1));

  // A categorized row's direction is owned by its category (the direction rule
  // — a stored tx_type can lag a category re-type), an uncategorized row's by
  // its own tx_type. Deleting a category requires its transactions be moved
  // off it first, so the LEFT JOIN never misses on a categorized row.
  const rows = db
    .prepare(
      `SELECT t.description AS description, t.display_name AS display_name,
              t.amount AS amount, t.date AS date
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE (CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END) = 'expense'
          ${from ? 'AND substr(t.date, 1, 7) >= ?' : ''}
        ORDER BY t.date`
    )
    .all(...(from ? [from] : []));

  const groups = new Map(); // key -> { key, named, name, total, count, last_date }
  for (const r of rows) {
    const key = merchantKey(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, named: key.startsWith('n:'), name: '', total: 0, count: 0, last_date: null };
      groups.set(key, g);
    }
    g.total += Number(r.amount) || 0;
    g.count += 1;
    // Rows arrive date-ordered, so the newest label wins — for an unnamed
    // group that is the most recent raw description, which is the same row the
    // ledger would show at the top of the merchant's history.
    g.name = resolvedName(r) || String(r.description || '').trim();
    g.last_date = r.date;
  }

  // Name is the tiebreak so an equal-spend pair doesn't swap places between
  // two identical requests.
  const ranked = [...groups.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, TOP_N);

  // Ledger search terms, for the ONLY groups that end up on screen — the
  // common-substring walk is quadratic in description length, and a ledger can
  // hold thousands of merchants the chart will never draw. A named group needs
  // no walk at all: the ledger's Name filter matches display_name too, so the
  // curated name finds exactly the rows this bar was built from.
  const wanted = new Map(ranked.filter((g) => !g.named).map((g) => [g.key, []]));
  if (wanted.size) {
    for (const r of rows) {
      const bucket = wanted.get(merchantKey(r));
      if (bucket) bucket.push(r.description);
    }
  }

  const merchants = ranked.map((g) => ({
    key: g.key,
    name: g.name,
    total: round2(g.total),
    count: g.count,
    last_date: g.last_date,
    search: g.named ? g.name : commonSearchTerm(wanted.get(g.key) || []),
  }));

  return { ok: true, window, from, limit: TOP_N, merchants };
}

const routes = [['GET', '/api/top-merchants', topMerchantsGet]];

module.exports = { routes };
