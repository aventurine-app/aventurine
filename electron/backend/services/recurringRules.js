'use strict';

// What a recurring schedule is MADE OF, beyond its own description key. Pure
// functions over already-loaded rows; DB access stays in handlers/recurring.js.
//
// WHY THIS EXISTS. detectRecurringSeries groups by ONE normaliseDesc key and
// counts every row under it, and a merchant can send something else under the
// SAME description: a $72 expense reimbursement from the same employer, on an
// off-cycle day, is counted as a paycheck. It splits one clean 14-day gap into
// 9 and 5 and drags the regularity score under MIN_REGULARITY, which deletes the
// whole series.
//
// That is not reachable by tuning a threshold — it needs one key to be less than
// a whole schedule — so a schedule can carry an amount band
// (recurring_overrides.amount_min/amount_max). The band is honoured on every
// read but nothing writes one any more: it came in with the schedule builder and
// outlived it. A database that already has one keeps behaving as it did, which
// is why withinBand stays; the case is otherwise unaddressed until something
// offers the band again.
//
// Membership is recomputed from transactions on every read, exactly as a
// detected series is. Nothing here stores transaction ids, so re-importing a
// statement (which renumbers rows) leaves a schedule intact.
//
// normaliseDesc itself is UNCHANGED and still the schedule's identity — a
// schedule with no band behaves exactly as it did before this module existed.

const { normaliseDesc } = require('./predictions');

/** True when `amount` falls inside a band. A missing band admits everything,
 *  which is what an un-built schedule has. */
function withinBand(amount, band) {
  if (!band) return true;
  if (band.min != null && amount < band.min) return false;
  if (band.max != null && amount > band.max) return false;
  return true;
}

/**
 * normaliseDesc over a transaction, memoized per description string.
 *
 * The cache is the point: detection reads every row three times (once per
 * direction bucket), while a real ledger holds far fewer distinct descriptions
 * than rows (963 across 1,628 in the ledger this was measured on).
 */
function makeKeyResolver() {
  const cache = new Map();
  return function keyOf(tx) {
    const desc = tx.description || '';
    let key = cache.get(desc);
    if (key === undefined) {
      key = normaliseDesc(desc);
      cache.set(desc, key);
    }
    return key;
  };
}

module.exports = { withinBand, makeKeyResolver };
