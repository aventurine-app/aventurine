'use strict';

// Merchant name suggestions, drawn from the BUNDLED lexicon
// (services/merchantCategories.js) rather than from the user's ledger.
//
// The two are different questions and both have a place. GET
// /api/recurring/similar searches the ledger: "which of my transactions is
// this?". This one searches the brand list the app ships with: "what is this
// merchant called, and what kind of spending is it?" — which is the only
// question a schedule for a charge that has never posted can ask, since there
// are no transactions to search.
//
// Two things come back with the name, and both are free consequences of getting
// the spelling right:
//   - the CATEGORY, because the lexicon is a needle -> category-key table to
//     begin with (it is what cold-start auto-categorization runs on);
//   - the AVATAR, because static/js/core/avatar.js slugs a label and looks it
//     up in the generated icon manifest, and the lexicon's display names are
//     what generated that manifest (electron/scripts/fetch-merchant-icons.js).
//     So nothing here mentions icons: naming the merchant exactly is what draws
//     one, on the calendar chip and everywhere else the schedule appears.
//
// Nothing is associated with any transaction. A suggestion fills in two form
// fields; it does not claim a row, an alias or a history.

const { MERCHANTS, merchantDisplayFor } = require('./merchantCategories');

/**
 * One entry per DISPLAY NAME, not per lexicon needle: "wendys" and "wendy's"
 * both name Wendy's, and offering the user two spellings of one merchant would
 * be noise. The needles are kept as the search surface, so typing either
 * spelling still finds the brand.
 *
 * Generic needles (merchantDisplayFor returns null for "grocery", "payroll", …)
 * categorize but must never rename, so they are not names to suggest.
 *
 * The FIRST needle's category wins where a brand's spellings disagree. The
 * lexicon is written one brand at a time, so its spellings share a category in
 * practice; taking the first keeps the tie-break stated rather than accidental.
 *
 * Built once at require time. ~1600 brands of a few words each — a few hundred
 * KB of strings held for the life of the process, against rebuilding the index
 * on every keystroke.
 */
const BRANDS = (() => {
  const byName = new Map(); // display name -> { name, lower, category_key, needles }
  for (const [needle, categoryKey] of MERCHANTS) {
    const name = merchantDisplayFor(needle);
    if (!name) continue;
    let brand = byName.get(name);
    if (!brand) {
      brand = { name, lower: name.toLowerCase(), category_key: categoryKey, needles: [] };
      byName.set(name, brand);
    }
    brand.needles.push(needle);
  }
  return [...byName.values()].sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0));
})();

/** How well `brand` answers `q`, as a rank where lower is better, or -1 for no
 *  match at all. The order is how confident the match is that this is the
 *  merchant being typed, which is what decides the list's order:
 *    0  the name starts with what was typed        ("net" -> Netflix)
 *    1  a word inside the name starts with it      ("fargo" -> Wells Fargo)
 *    2  the name contains it anywhere              ("flix" -> Netflix)
 *    3  a lexicon needle matches, but the name does not — the alternate
 *       spellings ("wendy's" -> Wendy's), which are real matches and are still
 *       worth less than anything the user can see themselves typing. */
function matchRank(brand, q) {
  if (brand.lower.startsWith(q)) return 0;
  const at = brand.lower.indexOf(q);
  if (at > 0 && !/[a-z0-9]/.test(brand.lower[at - 1])) return 1;
  if (at > 0) return 2;
  return brand.needles.some((n) => n.includes(q)) ? 3 : -1;
}

/**
 * The merchants matching `q`, best first, capped at `limit`.
 *
 * A linear scan of the brand list. At ~1600 short strings per keystroke this
 * measures well under a millisecond, and an index would have to be rebuilt
 * whenever the lexicon grows for no gain the user could perceive.
 *
 * Ties inside a rank keep alphabetical order (BRANDS is sorted), so the same
 * query always produces the same list — a list that reshuffled between
 * keystrokes would move the row under the pointer.
 */
function suggestMerchants(q, limit = 8) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return []; // one letter matches too much to be a suggestion

  const hits = [];
  for (const brand of BRANDS) {
    const rank = matchRank(brand, needle);
    if (rank >= 0) hits.push({ rank, brand });
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, limit).map(({ brand }) => ({
    name: brand.name,
    category_key: brand.category_key,
  }));
}

module.exports = { suggestMerchants, BRANDS };
