'use strict';

// Request-validation helpers shared by every handler — port of utils.py (plus
// parseIsoDate from services/transactions.py). One copy of each rule; the
// handlers import from here. Don't re-implement these locally.

const VALID_MONTHS = [
  'January', 'February', 'March',     'April',   'May',      'June',
  'July',    'August',   'September', 'October', 'November', 'December',
];

/** Error carrying an HTTP-ish status; the IPC router turns it into the same
 *  { ok:false, error, ...extra } + status envelope Flask's _bad() produced.
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
 * long/not a string (mirror of _clean_label).
 */
function cleanLabel(raw) {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label || label.length > 100) return null;
  return label;
}

/**
 * True only for real, finite numbers (mirror of _is_finite_number — Python
 * rejected bool there because bool subclasses int; JS booleans fail the
 * typeof check naturally). One stored NaN would corrupt every reader.
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Mirror of _validate_year: integer (not bool) in [1000, 9999]. */
function validateYear(year) {
  return typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999;
}

/**
 * Round to 2 decimals exactly like Python's round(x, 2), so the cents stored
 * at the write boundary stay identical across the port.
 *
 * Python rounds on the EXACT decimal value of the double (ties to even), so
 * naive `x * 100` scaling diverges on boundary values (2.675 stores as
 * 2.67499999..., must give 2.67; the float multiply drags it to 2.68). This
 * decomposes the double into its exact mantissa×2^exponent with BigInt and
 * does the half-even division exactly. Verified against a Python oracle in
 * __tests__ — don't replace with Math.round/toFixed without re-running it.
 */
const _F64 = new DataView(new ArrayBuffer(8));
function round2(x) {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0); // Python preserves -0.0's sign
  _F64.setFloat64(0, Math.abs(x));
  const bits = _F64.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exp;
  if (expBits === 0) {
    exp = -1074; // subnormal
  } else {
    mantissa |= 0x10000000000000n;
    exp = expBits - 1075;
  }
  // |x| = mantissa * 2^exp exactly; we need round-half-even(|x| * 100).
  let cents;
  if (exp >= 0) {
    cents = (mantissa * 100n) << BigInt(exp);
  } else {
    const num = mantissa * 100n;
    const den = 1n << BigInt(-exp);
    const q = num / den;
    const r2 = (num % den) * 2n;
    if (r2 > den) cents = q + 1n;
    else if (r2 < den) cents = q;
    else cents = q % 2n === 0n ? q : q + 1n; // exact tie → even
  }
  const result = Number(cents) / 100;
  return neg ? -result : result;
}

/** Strict 'YYYY-MM-DD' -> the same string, or null on any parse failure
 *  (mirror of _parse_iso_date; dates stay ISO strings throughout Node). */
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
 * Validate a (year, month, category[, value]) payload — mirror of _parse_entry.
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
  ApiError,
  bad,
  cleanLabel,
  isFiniteNumber,
  validateYear,
  round2,
  parseIsoDate,
  parseEntry,
};
