'use strict';

// The ledger search term for a group of transactions that belong to one
// merchant: a substring shared by EVERY row in the group, which is what makes a
// merchant link land on the whole group rather than the one row whose
// description we happened to keep. Searching a single raw description would
// miss its own siblings the moment a trailing store number varies — the exact
// case the user clicks through to understand.
//
// Derived from the descriptions themselves, never from a name: a label can be a
// user override ("Movies" for NETFLIX.COM) or a curated display name, and
// searching those can find nothing. Recall is guaranteed by construction (a
// common substring is a substring of every row); precision is not, and doesn't
// need to be — the result lands in an ordinary, visible Name filter chip the
// user can edit.
//
// Lifted out of handlers/recurring.js, which originated this rule for the
// Recurring calendar's merchant link, once handlers/topMerchants.js needed the
// same term for the same reason (a bar is a merchant; clicking it should show
// that merchant's transactions).

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

/** Tidy a common substring into something a person would plausibly have typed
 *  into the ledger's Name filter, or null if there's nothing usable left.
 *  Cutting characters only ever widens a substring search, so this can't cost
 *  the recall the term is chosen for — it's purely about what the filter chip
 *  ends up reading. */
function tidySearchTerm(term) {
  let t = String(term).trim();
  // A common substring routinely ends (or starts) mid-way through a store or
  // reference number the group's descriptions disagreed on — "NETFLIX.COM
  // 86677" out of ...8667797 and ...8667799. That fragment is noise, and the
  // letters beside it are already doing the identifying.
  const stripped = t.replace(/[^A-Za-z0-9]*\d+$/, '').replace(/^\d+[^A-Za-z0-9]*/, '');
  if (/[A-Za-z]/.test(stripped)) t = stripped;
  t = t.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  // Too little to search on — a lone "&", or two characters that would drag in
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
  // Only tidy a substring the group DISAGREED on. When every description
  // matched, the term is already a whole real description — reference number
  // and all — and trimming it there would widen a search that was exact.
  return running === latest ? latest : (tidySearchTerm(running) || latest);
}

/**
 * commonSearchTerm for every detection key in `rows` at once, as a
 * key -> term Map. Accumulates the running substring in one pass instead of
 * bucketing the rows, since the caller (the Recurring page) wants a term for
 * every group in the ledger rather than a chosen few.
 */
function searchTermByKey(rows) {
  const common = new Map(); // detection key -> running common substring
  const latest = new Map(); // detection key -> most recent raw description
  for (const t of rows) {
    const key = normaliseDesc(t.description);
    if (!key) continue;
    const desc = String(t.description || '');
    latest.set(key, desc); // rows arrive date-ordered, so the last one wins
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
