'use strict';

// The rule a user-built recurring schedule is made of, and the summaries the
// builder dialog reads. Pure functions over already-loaded rows; DB access
// stays in handlers/recurring.js.
//
// WHY THIS EXISTS. detectRecurringSeries groups by ONE normaliseDesc key and
// counts every row under it. Two real ledgers break that:
//
//   1. A bank renames a deposit. One payroll arriving as "DIRECT DEP ACME",
//      then "PAYROLL ACME", then "ACME" is three keys, so three series of a
//      third the length each, and the older two eventually fall outside
//      LAPSED_GRACE_DAYS and vanish. The income never stopped; it was renamed,
//      and a rename reads as a cancellation.
//   2. A merchant sends something else under the SAME description. A $72
//      expense reimbursement from the same employer, on an off-cycle day, is
//      counted as a paycheck. It splits one clean 14-day gap into 9 and 5 and
//      drags the regularity score under MIN_REGULARITY, which deletes the whole
//      series.
//
// Neither is reachable by tuning a threshold: case 1 needs several keys to be
// one schedule, and case 2 needs one key to be less than a whole schedule. So a
// user-built schedule carries a RULE instead of a key:
//
//   - a set of description keys (recurring_aliases), all folded to one, and
//   - an amount band (recurring_overrides.amount_min/amount_max).
//
// Membership is still recomputed from transactions on every read, exactly as a
// detected series is. Nothing here stores transaction ids, so re-importing a
// statement (which renumbers rows) leaves a built schedule intact, and a future
// charge matching the rule joins the series without the user touching it.
//
// normaliseDesc itself is UNCHANGED and still the schedule's identity — a
// schedule with no aliases and no band behaves exactly as it did before this
// module existed.

const { normaliseDesc, median } = require('./predictions');

// An off-cycle extra under a shared description is separated from the real
// charge by ORDER OF MAGNITUDE, not by a few percent, so the suggested band is
// deliberately wide: it has to drop a $72 reimbursement sitting among $1,450
// paychecks without touching a utility bill that swings from $40 to $300.
// Measured against a real ledger: 0.25x/4x drops the three stray rows from a
// 46-deposit payroll (confidence 0.93 -> 0.98) and keeps every row of a
// 6-charge variable bill.
const BAND_LOW_RATIO = 0.25;
const BAND_HIGH_RATIO = 4;

/**
 * The suggested amount band for a set of charge amounts, or null when there is
 * nothing to suggest from. Anchored on the median rather than the mean so the
 * outliers this is meant to exclude do not drag the band over themselves.
 */
function suggestAmountBand(amounts) {
  const usable = amounts.filter((a) => Number.isFinite(a) && a > 0);
  if (!usable.length) return null;
  const mid = median(usable);
  if (!(mid > 0)) return null;
  return { min: round(mid * BAND_LOW_RATIO), max: round(mid * BAND_HIGH_RATIO) };
}

/** Cents, without the float-multiply error round2 exists to avoid. Band bounds
 *  are advisory, so a plain fixed-point round is enough here. */
function round(n) {
  return Number(n.toFixed(2));
}

/** True when `amount` falls inside a band. A missing band admits everything,
 *  which is what an un-built schedule has. */
function withinBand(amount, band) {
  if (!band) return true;
  if (band.min != null && amount < band.min) return false;
  if (band.max != null && amount > band.max) return false;
  return true;
}

/**
 * A description-key resolver that folds aliases onto their schedule's key,
 * memoized per description string.
 *
 * The cache is the point: detection reads every row three times (once per
 * direction bucket) and the summaries below read them again, while a real
 * ledger holds far fewer distinct descriptions than rows (963 across 1,628 in
 * the ledger this was measured on). `aliases` is a Map of alias key -> schedule
 * key; an empty one still gives plain normaliseDesc.
 */
function makeKeyResolver(aliases) {
  const cache = new Map();
  return function keyOf(tx) {
    const desc = tx.description || '';
    let key = cache.get(desc);
    if (key === undefined) {
      const raw = normaliseDesc(desc);
      key = aliases.get(raw) ?? raw;
      cache.set(desc, key);
    }
    return key;
  };
}

/**
 * Group rows by their RAW normaliseDesc key (never the folded one — the
 * builder's job is to show the user the separate keys so they can decide which
 * belong together) and summarise each group into the line the dialog draws:
 * how many charges, over what span, in what amount range.
 *
 * `description` is the group's NEWEST spelling, since that is the one a future
 * import will carry and therefore the one the user recognizes.
 */
function summariseByKey(rows) {
  const groups = new Map();
  for (const t of rows) {
    const key = normaliseDesc(t.description);
    if (!key) continue; // a description of pure digits names no merchant
    let g = groups.get(key);
    if (!g) {
      g = { key, description: t.description, direction: t.tx_type, amounts: [], dates: [], last_date: '' };
      groups.set(key, g);
    }
    g.amounts.push(t.amount);
    g.dates.push(t.date);
    if (t.date >= g.last_date) {
      g.last_date = t.date;
      g.description = t.description; // newest spelling wins
      g.direction = t.tx_type;
    }
  }

  return [...groups.values()].map((g) => {
    const dates = g.dates.slice().sort();
    return {
      key: g.key,
      description: g.description,
      direction: g.direction,
      count: dates.length,
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      amount_min: round(Math.min(...g.amounts)),
      amount_max: round(Math.max(...g.amounts)),
      amount_median: round(median(g.amounts)),
    };
  });
}

module.exports = {
  suggestAmountBand,
  withinBand,
  makeKeyResolver,
  summariseByKey,
  BAND_LOW_RATIO,
  BAND_HIGH_RATIO,
};
