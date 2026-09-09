'use strict';

// Request-validation helpers shared by every handler. One copy of each rule;
// the handlers import from here. Don't re-implement these locally.

const VALID_MONTHS = [
  'January', 'February', 'March',     'April',   'May',      'June',
  'July',    'August',   'September', 'October', 'November', 'December',
];

// Months persist on disk as 1-12 integers (so `ORDER BY year, month` sorts
// chronologically for anyone querying the DB directly). The API contract — and
// every request/response payload — uses the English month NAME; these two
// helpers convert at the storage boundary. parseEntry still returns the name
// callers convert with monthNumber() at the
// INSERT and monthName() when shaping a response.
const _MONTH_TO_NUM = new Map(VALID_MONTHS.map((name, i) => [name, i + 1]));

/** English month name -> 1..12, or null if not a valid month name. */
function monthNumber(name) {
  return _MONTH_TO_NUM.get(name) ?? null;
}

/** 1..12 -> English month name, or null if out of range. */
function monthName(num) {
  return VALID_MONTHS[num - 1] ?? null;
}

/** Error carrying an HTTP-ish status; the IPC router turns it into the
 *  { ok:false, error, ...extra } + status envelope every failed route returns.
 *  `extra` covers bodies with fields beyond the message (e.g. the category
 *  delete 409 ships transactions/entries counts). */
class ApiError extends Error {
  constructor(message, status = 400, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Throw the standard bad-request error (mirror of utils._bad as a throw). */
function bad(message, status = 400, extra = null) {
  throw new ApiError(message, status, extra);
}

/**
 * Normalise a user-supplied label: trimmed string, or null when empty/too
 * long, or not a string.
 */
function cleanLabel(raw) {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label || label.length > 100) return null;
  return label;
}

/**
 * True only for real, finite numbers. Booleans are rejected by the typeof
 * check, and NaN/Infinity by Number.isFinite. One stored NaN would corrupt
 * every reader of that column.
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Integer (not bool) in [1000, 9999]. */
function validateYear(year) {
  return typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999;
}

/**
 * Round to 2 decimals (cents), half away from zero.
 *
 * The shift is done in the DECIMAL domain via exponent notation, not by
 * multiplying by 100. `x * 100` is a binary float multiply that introduces its
 * own error on top of the value's: 2.675 is stored as 2.674999999999999822, and
 * multiplying drags it to 267.50000000000003, which then rounds UP for the
 * wrong reason. Re-exponentiating the number's own shortest round-trip form
 * (what `toExponential` gives) shifts the point without touching the digits, so
 * what rounds is the decimal the user actually typed.
 *
 * Half away from zero is the ordinary commercial rule and the one a person
 * typing an amount expects: 2.675 -> 2.68, and -2.675 -> -2.68 by symmetry.
 * `Math.round` alone cannot do this, since it breaks ties toward +Infinity and
 * would send -2.675 to -2.67.
 */
function shiftExp(x, places) {
  // toExponential always yields "<mantissa>e<+|-><exp>", so this is a pure
  // decimal-point move with no arithmetic on the mantissa.
  const [mantissa, exp] = x.toExponential().split('e');
  return Number(`${mantissa}e${Number(exp) + places}`);
}

function round2(x) {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0); // keep -0's sign, as Math.round does
  const abs = Math.abs(x);

  const shifted = shiftExp(abs, 2);
  // Past 2^53 there are no fractional cents left to round, and the shift would
  // overflow to Infinity. The value is already whole; hand it back untouched.
  if (!Number.isFinite(shifted)) return x;

  const result = shiftExp(Math.round(shifted), -2);
  return neg ? -result : result;
}

/** Strict 'YYYY-MM-DD' -> the same string, or null on any parse failure
 *  (dates stay ISO strings end to end). */
function parseIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject day overflow (e.g. 2026-02-30 silently becoming March 2).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/**
 * Validate a (year, month, category[, value]) payload.
 * Returns the parsed object or throws ApiError. Values are rounded to cents at
 * this write boundary so float artifacts never persist.
 */
function parseEntry(data, { requireValue = true } = {}) {
  if (!data || typeof data !== 'object') bad('invalid request');
  const { year, month, category } = data;
  if (!validateYear(year)) bad('invalid year');
  if (!VALID_MONTHS.includes(month)) bad('invalid month');
  if (typeof category !== 'string' || !category) bad('invalid category');
  if (category.length > 100) bad('category too long');
  const parsed = { year, month, category };
  if (requireValue) {
    const value = data.value;
    if (!isFiniteNumber(value)) bad('invalid value');
    parsed.value = round2(value);
  }
  return parsed;
}

module.exports = {
  VALID_MONTHS,
  monthNumber,
  monthName,
  ApiError,
  bad,
  cleanLabel,
  isFiniteNumber,
  validateYear,
  round2,
  parseIsoDate,
  parseEntry,
};
