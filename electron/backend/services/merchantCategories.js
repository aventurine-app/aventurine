'use strict';

// Built-in, on-device knowledge for cold-start auto-categorization (used by
// services/categorize.js). This is the bundled "lexicon" half of the import
// moat: it lets a brand-new user's *first* import be categorized before any
// per-user MatchRules exist. It ships in the binary — no network, no telemetry.
//
// Mapped categories use the stable default category keys from seed.js
// (food, automobile, utilities, rent, health, entertainment, general, income,
// …). categorize.js resolves a key to this DB's category row at runtime and
// skips any key the user has deleted, so a customised taxonomy never breaks.
//
// Design rule: PRECISION OVER RECALL. A confident wrong category costs more
// user trust than leaving a row blank (the user fixes blanks in one click, and
// that fix trains a MatchRule). So keep entries unambiguous; when a token has
// two common meanings, omit it rather than guess. Recall is recovered later by
// the learned-rules layer and a future trained classifier.

// ── Noise stripping ───────────────────────────────────────────────────────────
// Bank descriptions bury the merchant in transport noise: payment-network
// prefixes, POS/ACH markers, store numbers, card masks, phone numbers, city/
// state tails. These patterns are removed (in order) before matching so
// "SQ *BLUE BOTTLE COFFEE 866-123 CA" reduces to "blue bottle coffee".
const NOISE_PATTERNS = [
  // Payment-processor / aggregator prefixes (the "<proc> *<merchant>" idiom).
  /\b(sq|tst|sp|pp|paypal|google|goog|apl|apple|amzn mktp|amazon mktpl|amzn|toast|clover|venmo|cash app|zelle)\s*\*+\s*/gi,
  // Transaction-type markers banks staple onto the front.
  /\b(pos|ach|web|recur(?:ring)?|autopay|auto pay|electronic|online|mobile|debit card purchase|debit card|credit card|checkcard|check card|chkcard|visa dda pur|visa|mastercard|purchase authorized on|purchase|payment|pmt|withdrawal|ext trnsfr)\b/gi,
  // Card masks, reference/auth numbers, store numbers, phone numbers.
  /[x*]{2,}\d+/gi, // xxxx1234 / ****1234
  /#\s*\d+/g, // store #1234
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, // embedded dates
  /\b\d{3,}\b/g, // standalone id/auth/store-number runs (merchant names rarely contain them)
  // Trailing US state abbreviation (a frequent tail on POS rows).
  /\s+(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\s*$/i,
];

// ── Merchant lexicon ──────────────────────────────────────────────────────────
// [normalized-substring, category-key]. Matched as a substring of the cleaned
// description, longest needle first (so "uber eats" beats "uber"). High
// confidence — these are named brands with a single obvious category.
const MERCHANTS = [
  // Groceries — supermarkets & grocery delivery
  ['whole foods', 'groceries'], ['trader joe', 'groceries'], ['safeway', 'groceries'],
  ['kroger', 'groceries'], ['aldi', 'groceries'], ['publix', 'groceries'],
  ['wegmans', 'groceries'], ['sprouts', 'groceries'], ['instacart', 'groceries'],
  ['grocery', 'groceries'], ['supermarket', 'groceries'],

  // Dining — restaurants, fast food, coffee, food delivery
  ['uber eats', 'dining'], ['ubereats', 'dining'], ['doordash', 'dining'],
  ['grubhub', 'dining'], ['postmates', 'dining'], ['mcdonald', 'dining'],
  ['starbucks', 'dining'], ['chipotle', 'dining'], ['taco bell', 'dining'],
  ['burger king', 'dining'], ['wendys', 'dining'], ["wendy's", 'dining'],
  ['subway', 'dining'], ['dunkin', 'dining'], ['panera', 'dining'],
  ['chick-fil-a', 'dining'], ['chick fil a', 'dining'], ['popeyes', 'dining'],
  ['dominos', 'dining'], ["domino's", 'dining'], ['pizza hut', 'dining'],
  ['kfc', 'dining'],

  // Auto & Transport — fuel, rideshare, parts, service
  ['shell', 'automobile'], ['chevron', 'automobile'], ['exxon', 'automobile'],
  ['texaco', 'automobile'], ['valero', 'automobile'], ['marathon petro', 'automobile'],
  ['circle k', 'automobile'], ['lyft', 'automobile'], ['autozone', 'automobile'],
  ['oreilly auto', 'automobile'], ["o'reilly auto", 'automobile'], ['jiffy lube', 'automobile'],
  ['valvoline', 'automobile'], ['firestone', 'automobile'],
  // 'mobil' is last in this group and shorter than 't mobile'/'tmobile' below;
  // longest-needle-first matching means the carrier wins over the gas station.
  ['mobil', 'automobile'],

  // Entertainment — streaming, gaming, media
  ['netflix', 'entertainment'], ['spotify', 'entertainment'], ['hulu', 'entertainment'],
  ['disney plus', 'entertainment'], ['disney+', 'entertainment'], ['hbo max', 'entertainment'],
  ['paramount+', 'entertainment'], ['peacock', 'entertainment'], ['youtube premium', 'entertainment'],
  ['prime video', 'entertainment'], ['steam games', 'entertainment'], ['steampowered', 'entertainment'],
  ['playstation', 'entertainment'], ['nintendo', 'entertainment'], ['xbox', 'entertainment'],
  ['twitch', 'entertainment'], ['patreon', 'entertainment'], ['ticketmaster', 'entertainment'],
  ['fandango', 'entertainment'], ['amc theatres', 'entertainment'], ['regal cinemas', 'entertainment'],
  ['audible', 'entertainment'],

  // Health — pharmacies, fitness, care
  ['cvs', 'health'], ['walgreens', 'health'], ['rite aid', 'health'],
  ['planet fitness', 'health'], ['la fitness', 'health'], ['equinox', 'health'],
  ['24 hour fitness', 'health'], ['gnc', 'health'], ['quest diagnostics', 'health'],
  ['labcorp', 'health'],

  // Utilities — telecom, internet, power, water
  ['comcast', 'utilities'], ['xfinity', 'utilities'], ['verizon', 'utilities'],
  ['at&t', 'utilities'], ['t mobile', 'utilities'], ['t-mobile', 'utilities'],
  ['tmobile', 'utilities'], ['spectrum', 'utilities'], ['centurylink', 'utilities'],
  ['cox comm', 'utilities'], ['pg&e', 'utilities'], ['duke energy', 'utilities'],
  ['national grid', 'utilities'], ['con edison', 'utilities'], ['coned', 'utilities'],

  // Shopping — big-box & online retail
  ['amazon', 'shopping'], ['amzn mktp', 'shopping'], ['walmart', 'shopping'],
  ['target', 'shopping'], ['costco', 'shopping'], ['best buy', 'shopping'],
  ['home depot', 'shopping'], ['lowes', 'shopping'], ["lowe's", 'shopping'],
  ['ikea', 'shopping'], ['etsy', 'shopping'], ['ebay', 'shopping'],

  // Travel — airlines, hotels, booking
  ['united airlines', 'travel'], ['delta air', 'travel'], ['american airlines', 'travel'],
  ['southwest air', 'travel'], ['jetblue', 'travel'], ['alaska air', 'travel'],
  ['marriott', 'travel'], ['hilton', 'travel'], ['hyatt', 'travel'],
  ['airbnb', 'travel'], ['expedia', 'travel'], ['booking.com', 'travel'],
  ['priceline', 'travel'],

  // Insurance — carriers (a dedicated bucket makes the "insurance" keyword safe)
  ['geico', 'insurance'], ['state farm', 'insurance'], ['progressive ins', 'insurance'],
  ['allstate', 'insurance'], ['liberty mutual', 'insurance'], ['nationwide ins', 'insurance'],

  // Income — payroll / deposits (direction-guarded in categorize.js)
  ['adp payroll', 'income'], ['gusto pay', 'income'], ['payroll', 'income'],
  ['direct deposit', 'income'],
];

// ── Keyword rules ─────────────────────────────────────────────────────────────
// [normalized-substring, category-key]. Generic descriptive terms (a notch less
// certain than a named brand). Checked only after the merchant lexicon misses.
// Still kept high-precision: no bare "store"/"shop"/"online"/"gas" (gas = fuel
// vs. gas utility) — ambiguous words are intentionally absent.
const KEYWORDS = [
  ['restaurant', 'dining'], ['coffee', 'dining'], ['cafe', 'dining'],
  ['pizzeria', 'dining'], ['taqueria', 'dining'], ['bakery', 'dining'],
  ['steakhouse', 'dining'], ['sushi', 'dining'],
  ['supermarket', 'groceries'], ['grocery', 'groceries'],
  ['pharmacy', 'health'], ['dental', 'health'], ['dentist', 'health'],
  ['clinic', 'health'], ['hospital', 'health'], ['fitness', 'health'],
  ['parking', 'automobile'], ['toll', 'automobile'],
  ['airlines', 'travel'], ['hotel', 'travel'],
  // A dedicated Insurance category makes this token safe to map now (previously
  // ambiguous between auto/health/home with no bucket to land in).
  ['insurance', 'insurance'],
  // Rent is hard to detect generically (bare "rent" is a substring of "parent"/
  // "current"; and "payment" is stripped as noise), so only unambiguous tokens.
  ['mortgage', 'rent'], ['property manage', 'rent'], ['leasing office', 'rent'],
];

module.exports = { NOISE_PATTERNS, MERCHANTS, KEYWORDS };
