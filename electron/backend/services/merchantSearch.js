'use strict';

// The ledger search term for a group of transactions that belong to one
// merchant: a substring shared by EVERY row in the group, so a merchant link
// matches the whole group rather than the one row whose description was kept.
// Searching a single raw description misses the other rows as soon as a
// trailing store number varies.
//
// Derived from the descriptions themselves, never from a name: a label can be a
// user override ("Movies" for NETFLIX.COM) or a curated display name, and
// searching those can match nothing. Recall is guaranteed by construction (a
// common substring is a substring of every row); precision is not, and does not
// need to be — the result lands in a visible Name filter chip the user can
// edit.
//
// Moved out of handlers/recurring.js, which originated this rule for the
// Recurring calendar's merchant link, once handlers/topMerchants.js needed the
// same term for the same purpose (clicking a bar shows that merchant's
// transactions).

const { normaliseDesc } = require('./predictions');

/** Longest common substring of two strings, matched case-insensitively and
 *  returned in `a`'s own casing. Rolling-row DP — the running substring
 *  collapses to a few dozen characters after the first pair, so the quadratic
 *  step is paid once per merchant rather than once per transaction. */
function longestCommonSubstring(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  let best = 0;
  let end = 0;
  let prev = new Array(lb.length + 1).fill(0);
  for (let i = 1; i <= la.length; i++) {
    const row = new Array(lb.length + 1).fill(0);
    for (let j = 1; j <= lb.length; j++) {
      if (la[i - 1] !== lb[j - 1]) continue;
      row[j] = prev[j - 1] + 1;
      if (row[j] > best) { best = row[j]; end = i; }
    }
    prev = row;
  }
  return a.slice(end - best, end);
}

/** Trim a common substring down to something a person would plausibly type into
 *  the ledger's Name filter, or null if nothing usable is left. Cutting
 *  characters only widens a substring search, so recall is unaffected; this
 *  only changes the text shown in the filter chip. */
function tidySearchTerm(term) {
  let t = String(term).trim();
  // A common substring often ends (or starts) mid-way through a store or
  // reference number that differs across the group — "NETFLIX.COM 86677" out of
  // ...8667797 and ...8667799. That digit fragment is noise; the letters beside
  // it are what identify the merchant.
  const stripped = t.replace(/[^A-Za-z0-9]*\d+$/, '').replace(/^\d+[^A-Za-z0-9]*/, '');
  if (/[A-Za-z]/.test(stripped)) t = stripped;
  t = t.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  // Too short to search on — a lone "&", or two characters that would match
  // half the ledger. The caller falls back to a full description instead.
  return /[A-Za-z]/.test(t) && t.length >= 3 ? t : null;
}

/**
 * The search term for one merchant's descriptions, or null when there is
 * nothing to search on (no descriptions at all — a hand-added schedule with no
 * backing transactions).
 */
function commonSearchTerm(descriptions) {
  let running;   // running common substring
  let latest;    // most recent raw description (callers pass rows date-ordered)
  for (const d of descriptions) {
    const desc = String(d == null ? '' : d);
    if (!desc) continue;
    latest = desc;
    running = running === undefined ? desc : longestCommonSubstring(running, desc);
  }
  if (running === undefined) return null;
  // Trim only when the descriptions differ. When every description was
  // identical, the term is already a whole description — reference number and
  // all — and trimming it would widen a search that was exact.
  return running === latest ? latest : (tidySearchTerm(running) || latest);
}

/**
 * commonSearchTerm for every detection key in `rows` at once, as a key -> term
 * Map. Accumulates the running substring in one pass instead of bucketing the
 * rows, because the caller (the Recurring page) needs a term for every group in
 * the ledger rather than a few.
 */
function searchTermByKey(rows) {
  const common = new Map(); // detection key -> running common substring
  const latest = new Map(); // detection key -> most recent raw description
  for (const t of rows) {
    const key = normaliseDesc(t.description);
    if (!key) continue;
    const desc = String(t.description || '');
    latest.set(key, desc); // rows arrive date-ordered, so the last one is kept
    const running = common.get(key);
    common.set(key, running === undefined ? desc : longestCommonSubstring(running, desc));
  }

  const terms = new Map();
  for (const [key, sub] of common) {
    const full = latest.get(key);
    terms.set(key, sub === full ? full : tidySearchTerm(sub) || full);
  }
  return terms;
}

module.exports = { longestCommonSubstring, tidySearchTerm, commonSearchTerm, searchTermByKey };
