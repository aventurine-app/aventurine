'use strict';

// ============================================================================
// currency.js — User-configurable currency symbol + currency formatters.
// ============================================================================
//
// Loaded globally from base.html, before every other JS file, so the symbol
// is available wherever currency is rendered (tables, portfolio, home,
// insights).
//
// Storage model:
//   - The user's chosen symbol lives in localStorage under 'currency_symbol'.
//   - Default is '$' on first run.
//   - Changes from the Settings page write through setCurrencySymbol(),
//     which dispatches a 'currencychange' window event for any open page
//     to react to (e.g. re-render the visible tables). Pages that don't
//     listen will pick up the new symbol on their next normal render.
//
// Editing model in cells:
//   - The currency symbol is part of the input's value, e.g. '$1,234'.
//   - applyCurrencyFormat() runs on every keystroke: strips the symbol +
//     commas + non-numeric noise, reformats with commas, prepends the
//     current symbol, and restores the caret to the same logical position.
//   - When the user clears the cell, the value goes back to empty so the
//     placeholder ('—') shows through.
//   - On save, stripCurrencyValue() removes the symbol + commas so the
//     backend receives a plain number.

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * Normalise a currency symbol to something safe to interpolate into HTML.
 * The symbol is read back from localStorage and flows, unescaped, into
 * innerHTML in several renderers (home.js, transactions.js, …). setter
 * enforces a 3-char cap, but a value placed in localStorage by any other
 * means (a prior bug, another tab, devtools) would bypass that — so we
 * re-sanitise at every read: strip the characters that carry markup
 * meaning and cap the length. Caller still controls the '$' fallback.
 */
function sanitizeCurrencySymbol(raw) {
    return String(raw ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 3);
}

// Mutable global. Pages that format currency at render time should read this
// (not a captured-at-load constant) so a navigation away and back picks up
// any symbol change made meanwhile.
let CURRENCY_SYMBOL = sanitizeCurrencySymbol(localStorage.getItem('currency_symbol')) || '$';

// ─── Number format ────────────────────────────────────────────────────────
// Group/decimal separators, symbol position, and cent-hiding. Same storage
// model as CURRENCY_SYMBOL: mutable globals seeded from localStorage, changed
// through setters that persist and fire 'currencychange' so open pages
// re-render. Renderers read these live at format time, so a navigation away
// and back (or a fired event) always picks up the latest choice.

const NUMBER_FORMATS = {
    us:    { group: ',', decimal: '.' },   // 1,234.56
    eu:    { group: '.', decimal: ',' },   // 1.234,56
    space: { group: ' ', decimal: ',' },   // 1 234,56
};

let NUMBER_FORMAT_KEY = NUMBER_FORMATS[localStorage.getItem('number_format')]
    ? localStorage.getItem('number_format') : 'us';
let NUMBER_FORMAT = NUMBER_FORMATS[NUMBER_FORMAT_KEY];

// Where the symbol sits relative to the number: 'prefix' ($1,234) / 'suffix' (1.234 €).
let SYMBOL_POSITION = localStorage.getItem('symbol_position') === 'suffix' ? 'suffix' : 'prefix';

// Display-only: round to whole units and drop the fractional part. NEVER honored
// for editable inputs — they pass {editable:true} so the cents survive the
// stripCurrencyValue() round-trip; hiding them there would truncate on save.
let HIDE_CENTS = localStorage.getItem('hide_cents') === '1';

function _fireFormatChange() {
    window.dispatchEvent(new CustomEvent('currencychange', { detail: { symbol: CURRENCY_SYMBOL } }));
}

/** Set the grouping/decimal style. `key` is one of NUMBER_FORMATS (falls back to 'us'). */
function setNumberFormat(key) {
    NUMBER_FORMAT_KEY = NUMBER_FORMATS[key] ? key : 'us';
    NUMBER_FORMAT = NUMBER_FORMATS[NUMBER_FORMAT_KEY];
    localStorage.setItem('number_format', NUMBER_FORMAT_KEY);
    _fireFormatChange();
}

/** Set the symbol position: 'prefix' or 'suffix'. */
function setSymbolPosition(pos) {
    SYMBOL_POSITION = pos === 'suffix' ? 'suffix' : 'prefix';
    localStorage.setItem('symbol_position', SYMBOL_POSITION);
    _fireFormatChange();
}

/** Toggle display-only cent hiding. */
function setHideCents(on) {
    HIDE_CENTS = !!on;
    localStorage.setItem('hide_cents', on ? '1' : '');
    _fireFormatChange();
}

// How negative amounts read: 'minus' (-$1,234.56) or 'paren' (($1,234.56),
// accounting style). Display-only — editable inputs always use a plain leading
// minus so stripCurrencyValue() can parse them back.
let NEGATIVE_STYLE = localStorage.getItem('negative_style') === 'paren' ? 'paren' : 'minus';

/** Set the negative-number style: 'minus' or 'paren'. */
function setNegativeStyle(style) {
    NEGATIVE_STYLE = style === 'paren' ? 'paren' : 'minus';
    localStorage.setItem('negative_style', NEGATIVE_STYLE);
    _fireFormatChange();
}

// ─── Date format ──────────────────────────────────────────────────────────
// formatDate() is the single date renderer for app-controlled date text (the
// transactions list, etc.). <input type="date"> fields are formatted by the OS
// and unaffected. Default 'long' keeps the prior "Jun 18, 2026" look.

const DATE_FORMATS = ['long', 'iso', 'us', 'eu'];
const _MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let DATE_FORMAT = DATE_FORMATS.includes(localStorage.getItem('date_format'))
    ? localStorage.getItem('date_format') : 'long';

/** Set the date display format: one of DATE_FORMATS (falls back to 'long'). */
function setDateFormat(key) {
    DATE_FORMAT = DATE_FORMATS.includes(key) ? key : 'long';
    localStorage.setItem('date_format', DATE_FORMAT);
    _fireFormatChange();
}

/**
 * Render an ISO date string ('YYYY-MM-DD') in the user's chosen format. Returns
 * '' for falsy input and echoes back anything that doesn't parse as Y-M-D.
 */
function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return iso;
    const pad = (x) => String(x).padStart(2, '0');
    switch (DATE_FORMAT) {
        case 'iso': return `${y}-${pad(m)}-${pad(d)}`;
        case 'us':  return `${pad(m)}/${pad(d)}/${y}`;
        case 'eu':  return `${pad(d)}/${pad(m)}/${y}`;
        default:    return `${_MONTHS_SHORT[m - 1]} ${d}, ${y}`;
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Update the user's currency symbol. Empties or whitespace-only inputs
 * fall back to '$'. The maxlength of 3 keeps long pasted strings from
 * breaking the layout (covers '$', '€', 'CHF', etc.). Fires a
 * 'currencychange' window event with the new symbol in event.detail.
 */
function setCurrencySymbol(raw) {
    const symbol  = sanitizeCurrencySymbol(raw) || '$';
    CURRENCY_SYMBOL = symbol;
    localStorage.setItem('currency_symbol', symbol);
    window.dispatchEvent(new CustomEvent('currencychange', { detail: { symbol } }));
}

/**
 * Format a number for display with the current currency symbol baked in,
 * e.g. 1234.5 → '$1,234.50'. Returns an empty string for falsy/NaN input
 * so empty totals render as the placeholder '—' (decided by the caller).
 *
 * The output keeps trailing .00 by default — pass stripZeros=true to drop
 * a .00 suffix (used for compact display in totals where ".00" is noise).
 */
function formatCurrency(num, stripZeros = false, opts = {}) {
    if (num === null || num === undefined || isNaN(num)) return '';
    const { group, decimal } = NUMBER_FORMAT;
    const n = Number(num);
    const negative = n < 0;
    const hideCents = HIDE_CENTS && !opts.editable;

    // Format the magnitude, then apply sign/style around the whole thing so the
    // minus sits outside the symbol ("-$1,234.56", "-1.234,56€").
    const mag = Math.abs(n);
    let intStr, decStr;
    if (hideCents) {
        intStr = String(Math.round(mag));
        decStr = '';
    } else {
        [intStr, decStr] = mag.toFixed(2).split('.');
    }
    const intFormatted = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, group);
    const dropDecimals = hideCents || (stripZeros && decStr === '00');
    const body = dropDecimals ? intFormatted : intFormatted + decimal + decStr;
    const withSymbol = SYMBOL_POSITION === 'suffix' ? body + CURRENCY_SYMBOL : CURRENCY_SYMBOL + body;

    if (!negative) return withSymbol;
    // Editable inputs must round-trip through stripCurrencyValue(), so they
    // always use a plain leading minus regardless of the chosen style.
    if (!opts.editable && NEGATIVE_STYLE === 'paren') return '(' + withSymbol + ')';
    return '-' + withSymbol;
}

/**
 * Strip the currency symbol + commas from a string so parseFloat can read
 * it. Tolerant of any whitespace and of the user partially typing/deleting
 * the symbol. Used by every save handler in tables.js / portfolio.js.
 */
function stripCurrencyValue(str) {
    const { group, decimal } = NUMBER_FORMAT;
    let s = String(str).replace(new RegExp(_escapeForRegex(CURRENCY_SYMBOL), 'g'), '');
    // Drop grouping separators: strip the format's group char and any
    // stray whitespace (the space format groups with spaces; pasted values
    // may too), then re-point the decimal separator at '.' for parseFloat.
    s = s.split(group).join('').replace(/\s/g, '');
    if (decimal !== '.') s = s.split(decimal).join('.');
    return s.trim();
}

/**
 * Reformat an input's value as '<SYMBOL><formatted-number>' while
 * preserving the caret position relative to the underlying DIGITS. Cousin
 * of applyCommaFormat (in tables.js) but with the symbol baked into the
 * value, so applyCurrencyFormat is what currency-bearing inputs use.
 *
 * The algorithm is the same as applyCommaFormat: count digits to the left
 * of the caret before reformatting, then walk the rebuilt string until we
 * pass that many digits on the same side of the decimal point. The only
 * twist is that we skip over the leading symbol when looking for the caret
 * landing spot, so backspacing through the value can't get stuck on the
 * symbol prefix.
 *
 * Pass {allowEmpty: true} (the default) to let an empty input stay empty
 * — that's what we want for placeholder display.
 */
function applyCurrencyFormat(input) {
    const { group, decimal } = NUMBER_FORMAT;
    const suffix = SYMBOL_POSITION === 'suffix';
    const raw = input.value;
    const pos = input.selectionStart;

    // Reduce to digits + a single internal '.' decimal point. Only the
    // configured decimal separator counts as a decimal; the grouping
    // separator (and everything else, incl. the symbol) is dropped.
    let cleaned = '';
    for (const ch of raw) {
        if (ch >= '0' && ch <= '9') cleaned += ch;
        else if (ch === decimal && !cleaned.includes('.')) cleaned += '.';
    }

    // Empty cell → keep empty so the placeholder shows. This also covers
    // the "user backspaced through the symbol with nothing else there"
    // case: we don't want a lonely symbol to remain in the input.
    if (cleaned === '' || cleaned === '.') {
        input.value = '';
        return;
    }

    // Count digits to the left of the caret in the BEFORE state, plus whether
    // the caret was past the decimal — separators don't count as digits, so
    // this is independent of the chosen format and symbol position.
    const beforeCursor = raw.slice(0, pos);
    const digitsBeforeCursor = (beforeCursor.match(/\d/g) || []).length;
    const afterDecimal = beforeCursor.includes(decimal);

    // Rebuild the numeric part with the configured separators, then attach the
    // symbol on the chosen side.
    const dotIdx  = cleaned.indexOf('.');
    const intPart = dotIdx === -1 ? cleaned : cleaned.slice(0, dotIdx);
    const decPart = dotIdx === -1 ? ''      : cleaned.slice(dotIdx + 1);
    const intGrouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
    const numStr = dotIdx === -1 ? intGrouped : intGrouped + decimal + decPart;
    input.value = suffix ? numStr + CURRENCY_SYMBOL : CURRENCY_SYMBOL + numStr;

    // Walk the numeric portion, counting digits, and stop where we hit the
    // same digit count on the same side of the decimal as before — the caret's
    // logical "same place". `offset` skips a leading (prefix) symbol so the
    // index maps back onto the full value.
    const offset = suffix ? 0 : CURRENCY_SYMBOL.length;
    let digitCount  = 0;
    let pastDecimal = false;
    let newPos      = offset + numStr.length;
    for (let i = 0; i < numStr.length; i++) {
        if (digitCount === digitsBeforeCursor && pastDecimal === afterDecimal) {
            newPos = offset + i;
            break;
        }
        const ch = numStr[i];
        if (ch === decimal) pastDecimal = true;
        else if (ch >= '0' && ch <= '9') digitCount++;
    }
    input.setSelectionRange(newPos, newPos);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Escape a string for safe use inside a RegExp constructor. */
function _escapeForRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
