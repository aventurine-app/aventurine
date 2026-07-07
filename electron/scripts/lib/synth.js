'use strict';

// Synthetic training-data generator for the on-device categorizer (Phase 3 of
// the import-moat plan). We never touch a real user's transactions: instead we
// run the import normalizer *backwards* — wrapping known merchants and
// category-indicative descriptor words in the same processor prefixes, POS/ACH
// markers, store numbers, cities and state tails that real bank exports staple
// on — to manufacture a labeled corpus that is 100% ours and license-clean.
//
// Two jobs:
//   1. POSITIVES teach category signal. Sources: the shipped lexicon (named
//      brands) AND per-category DESCRIPTOR words (grill/dental/apparel/…), so
//      the model generalizes to UNSEEN-but-describable merchants, not just the
//      brands we already hard-code.
//   2. NEGATIVES teach abstention. A large, varied 'unknown' class — person
//      payees, "<word> LLC", bank operations, gibberish merchant codes — so the
//      classifier can actively predict "leave this blank" instead of forcing a
//      wrong guess (precision-over-recall: a wrong category is worse than none).
//
// Deterministic: a seeded RNG makes the dataset — and therefore the trained
// model — byte-reproducible. Dependency-free.

const { MERCHANTS, KEYWORDS } = require('../../backend/services/merchantCategories');

// ── Seeded RNG (mulberry32) ────────────────────────────────────────────────
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const chance = (rng, p) => rng() < p;

// ── Noise vocab (the stuff the normalizer strips) ──────────────────────────
const PROC_PREFIX = ['SQ *', 'TST* ', 'SP ', 'PP*', 'PAYPAL *', 'TOAST* ', 'CLOVER ', 'SQC*'];
const TXN_MARKER = [
  'POS DEBIT', 'POS PURCHASE', 'ACH DEBIT', 'DEBIT CARD PURCHASE',
  'CHECKCARD', 'PURCHASE AUTHORIZED ON 04/12', 'RECURRING', 'VISA DDA PUR',
  'ONLINE PAYMENT', 'ELECTRONIC PMT',
];
const STATES = ['CA', 'TX', 'NY', 'FL', 'IL', 'WA', 'GA', 'PA', 'OH', 'MI', 'NC', 'AZ', 'CO', 'MA'];
const CITIES = [
  'CHICAGO', 'AUSTIN', 'PORTLAND', 'DENVER', 'SEATTLE', 'BROOKLYN', 'MIAMI', 'DALLAS',
  'PHOENIX', 'ATLANTA', 'BOSTON', 'HOUSTON', 'ORLANDO', 'NASHVILLE', 'SACRAMENTO', 'TAMPA',
];

/** Wrap a clean merchant string in random, realistic bank-export noise. The
 *  normalizer strips most of it back off at train and infer time alike — the
 *  point is to teach the model that surviving filler (cities, "online") is
 *  non-discriminative, and to mirror real inputs. */
function addNoise(rng, merchant) {
  let s = merchant.toUpperCase();
  if (chance(rng, 0.35)) s = pick(rng, PROC_PREFIX) + s;
  else if (chance(rng, 0.4)) s = pick(rng, TXN_MARKER) + ' ' + s;
  if (chance(rng, 0.3)) s += ' #' + Math.floor(rng() * 9000 + 100);
  if (chance(rng, 0.35)) s += ' ' + pick(rng, CITIES);
  if (chance(rng, 0.3)) s += ' ' + pick(rng, STATES);
  if (chance(rng, 0.15)) s += ' ' + Math.floor(rng() * 8999 + 1000);
  if (chance(rng, 0.1)) s = s + '.COM';
  return s;
}

// ── Category descriptor words — the generalization fuel ─────────────────────
// Words that strongly imply a category on their own, so the model can label a
// merchant it has never seen ("COASTAL DERMATOLOGY GROUP" -> health via
// "dermatology"). Deliberately broader than the precision-first KEYWORDS list.
const DESCRIPTORS = {
  dining: ['grill', 'grille', 'kitchen', 'bistro', 'diner', 'eatery', 'cantina', 'taqueria',
    'trattoria', 'osteria', 'brasserie', 'gastropub', 'pizzeria', 'ristorante', 'steakhouse',
    'sushi', 'ramen', 'noodle house', 'creamery', 'bakery', 'roasters', 'coffeehouse',
    'taphouse', 'alehouse', 'smokehouse', 'grillhouse', 'churrascaria', 'pho', 'dumpling house',
    'burrito co', 'taco shop', 'donuts', 'ice cream', 'gelato', 'patisserie'],
  groceries: ['market', 'grocery', 'grocers', 'supermarket', 'mercado', 'carniceria',
    'foods', 'produce', 'food mart', 'marketplace', 'fresh foods', 'natural foods'],
  automobile: ['automotive', 'auto repair', 'auto parts', 'tire', 'tires', 'lube center',
    'collision', 'transmission', 'muffler', 'brakes', 'autobody', 'car wash', 'service station',
    'garage', 'motors', 'auto center', 'oil change', 'smog check', 'auto glass'],
  health: ['pharmacy', 'dental', 'dentistry', 'orthodontics', 'orthodontist', 'chiropractic',
    'dermatology', 'pediatrics', 'physical therapy', 'wellness center', 'medical group',
    'clinic', 'family medicine', 'optometry', 'optical', 'vision center', 'urgent care',
    'cardiology', 'radiology', 'health center', 'sports medicine', 'behavioral health'],
  utilities: ['electric', 'power company', 'energy', 'gas company', 'water district',
    'sanitation', 'utility', 'utilities', 'wireless', 'broadband', 'communications',
    'telecom', 'fiber', 'cable', 'sewer authority'],
  entertainment: ['cinema', 'cinemas', 'theatre', 'movies', 'arcade', 'bowling lanes',
    'entertainment', 'gaming', 'studios', 'records', 'amusement park', 'comedy club',
    'billiards', 'laser tag', 'skating rink', 'water park', 'aquatic center', 'water sports',
    'adventure park', 'fun center', 'trampoline park'],
  shopping: ['boutique', 'outfitters', 'apparel', 'clothing co', 'footwear', 'shoes',
    'jewelers', 'jewelry', 'furniture', 'home goods', 'hardware', 'mercantile',
    'department store', 'emporium', 'trading co', 'sporting goods', 'toys'],
  travel: ['airlines', 'airways', 'hotel', 'motel', 'suites', 'resort', 'lodge', 'hostel',
    'hospitality', 'tours', 'cruise line', 'vacation rentals', 'car rental', 'inn & suites',
    'travel agency'],
  insurance: ['insurance', 'assurance', 'casualty', 'indemnity', 'underwriters',
    'insurance agency', 'insurance services', 'mutual insurance', 'life & annuity'],
  rent: ['apartments', 'apartment homes', 'property management', 'realty', 'leasing',
    'mortgage', 'home loans', 'property group', 'residential mgmt'],
};

// Neutral proper-ish tokens combined with descriptors. These appear across ALL
// categories, so they carry no category signal — the descriptor does. That is
// exactly what we want the model to learn.
const NEUTRAL = ['sunrise', 'golden', 'blue', 'main street', 'downtown', 'riverside', 'oak',
  'maple', 'summit', 'coastal', 'urban', 'metro', 'evergreen', 'lakeside', 'north', 'south',
  'valley', 'harbor', 'liberty', 'central', 'grand', 'sunset', 'park avenue', 'union'];
const PLACEY = [...CITIES.map((c) => c.toLowerCase()), 'westfield', 'fairview', 'georgetown',
  'clarkson', 'brentwood', 'kingsport', 'edgewater'];

// ── Names / business words for the 'unknown' negative class ─────────────────
const FIRST = ['james', 'maria', 'robert', 'linda', 'michael', 'patricia', 'david', 'susan',
  'john', 'jennifer', 'daniel', 'sarah', 'marco', 'aisha', 'chen', 'raj', 'omar', 'sofia',
  'kevin', 'nicole', 'brandon', 'emily', 'tyler', 'hannah'];
const LAST = ['smith', 'johnson', 'williams', 'garcia', 'miller', 'davis', 'rodriguez',
  'martinez', 'anderson', 'thomas', 'lee', 'walker', 'hall', 'nguyen', 'patel', 'kim',
  'brooks', 'reed', 'cooper', 'murphy', 'levine', 'dickey', 'wetzel', 'conrad'];
const BIZ_ABSTRACT = ['summit', 'apex', 'pinnacle', 'meridian', 'cornerstone', 'vanguard',
  'keystone', 'ironclad', 'blackstone', 'redwood', 'silverline', 'northgate', 'brightpath',
  'clearwater', 'stonebridge', 'foundry', 'catalyst', 'horizon', 'legacy', 'sterling'];
const BIZ_SUFFIX = ['llc', 'inc', 'co', 'group', 'holdings', 'partners', 'enterprises',
  'associates', 'services', 'solutions', 'consulting', 'corp', 'ventures', 'industries'];
const BANK_OPS = [
  'ATM WITHDRAWAL', 'MOBILE DEPOSIT', 'OVERDRAFT FEE', 'MONTHLY SERVICE FEE', 'MAINTENANCE FEE',
  'WIRE TRANSFER OUT', 'INTL WIRE FEE', 'CHECK', 'RETURNED ITEM FEE', 'FOREIGN TRANSACTION FEE',
  'CASH ADVANCE FEE', 'INTEREST CHARGE ON PURCHASES', 'LATE PAYMENT CHARGE', 'STOP PAYMENT FEE',
  'ONLINE TRANSFER TO SAVINGS', 'EXTERNAL TRANSFER', 'ACH HOLD', 'BALANCE ADJUSTMENT',
  'CARD REPLACEMENT FEE', 'ANNUAL MEMBERSHIP FEE', 'CREDIT CARD PAYMENT', 'WESTERN UNION',
];
const P2P = ['ZELLE TO', 'ZELLE FROM', 'VENMO PAYMENT', 'CASH APP', 'PAYPAL', 'ZELLE PAYMENT FROM'];
const GIBBER = ['zentro', 'xqplex', 'vantiq', 'norvex', 'quilo', 'braxid', 'omnica', 'zephyx',
  'kolt', 'druvo', 'plentt', 'yestra', 'oncava', 'wexbo', 'trilix', 'fenopy'];
const GIBBER_TAIL = ['outpost', 'holdings', 'trading', 'systems', 'labs', 'depot', 'exchange', 'supply'];

// ── Generators ──────────────────────────────────────────────────────────────
function genPositivesFromLexicon(rng, out, perEntry) {
  for (const list of [MERCHANTS, KEYWORDS]) {
    for (const [needle, key] of list) {
      for (let i = 0; i < perEntry; i++) {
        // For keywords (generic terms) sometimes attach a neutral head so the
        // token sits inside a plausible merchant, not bare.
        const base = list === KEYWORDS && chance(rng, 0.6)
          ? `${pick(rng, [...NEUTRAL, ...PLACEY])} ${needle}`
          : needle;
        out.push({ text: addNoise(rng, base), label: key });
      }
    }
  }
}

function genPositivesFromDescriptors(rng, out, perDescriptor) {
  for (const [key, words] of Object.entries(DESCRIPTORS)) {
    for (const w of words) {
      for (let i = 0; i < perDescriptor; i++) {
        const head = pick(rng, [...NEUTRAL, ...PLACEY, pick(rng, LAST)]);
        const form = rng();
        let merchant;
        if (form < 0.45) merchant = `${head} ${w}`;
        else if (form < 0.75) merchant = `${w} of ${pick(rng, PLACEY)}`;
        else if (form < 0.9) merchant = `the ${head} ${w}`;
        else merchant = w;
        out.push({ text: addNoise(rng, merchant), label: key });
      }
    }
  }
}

function genUnknown(rng, out, count) {
  for (let i = 0; i < count; i++) {
    const r = rng();
    let text;
    if (r < 0.25) {
      text = `${pick(rng, FIRST)} ${pick(rng, LAST)}`.toUpperCase();
    } else if (r < 0.45) {
      text = `${pick(rng, [...BIZ_ABSTRACT, pick(rng, LAST)])} ${pick(rng, BIZ_SUFFIX)}`.toUpperCase();
    } else if (r < 0.62) {
      text = pick(rng, BANK_OPS) + (chance(rng, 0.4) ? ' ' + Math.floor(rng() * 8999 + 1000) : '');
    } else if (r < 0.78) {
      text = `${pick(rng, P2P)} ${pick(rng, FIRST)} ${pick(rng, LAST)}`.toUpperCase();
    } else if (r < 0.9) {
      text = `${pick(rng, GIBBER)} ${pick(rng, GIBBER_TAIL)}`.toUpperCase()
        + (chance(rng, 0.5) ? ' ' + Math.floor(rng() * 8999 + 1000) : '');
    } else {
      // Two neutral/place tokens with no category word — a merchant we can't read.
      text = `${pick(rng, [...NEUTRAL, ...PLACEY])} ${pick(rng, [...BIZ_ABSTRACT, ...PLACEY])}`.toUpperCase();
    }
    out.push({ text, label: 'unknown' });
  }
}

/** Build the full labeled dataset. Counts are chosen so 'unknown' is well
 *  represented (drives abstention) without swamping the real categories. */
function generateDataset(opts = {}) {
  const {
    seed = 1234567,
    perLexiconEntry = 6,
    perDescriptor = 40,
    unknownCount = 14000,
  } = opts;
  const rng = makeRng(seed);
  const out = [];
  genPositivesFromLexicon(rng, out, perLexiconEntry);
  genPositivesFromDescriptors(rng, out, perDescriptor);
  genUnknown(rng, out, unknownCount);
  // Deterministic shuffle so train/val split isn't ordered by class.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { generateDataset, DESCRIPTORS, makeRng };
