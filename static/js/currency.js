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
function formatCurrency(num, stripZeros = false) {
    if (num === null || num === undefined || isNaN(num)) return '';
    const fixed = Number(num).toFixed(2);
    const [intStr, decStr] = fixed.split('.');
    const intFormatted = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const body = (stripZeros && decStr === '00') ? intFormatted : intFormatted + '.' + decStr;
    return CURRENCY_SYMBOL + body;
}

/**
 * Strip the currency symbol + commas from a string so parseFloat can read
 * it. Tolerant of any whitespace and of the user partially typing/deleting
 * the symbol. Used by every save handler in tables.js / portfolio.js.
 */
function stripCurrencyValue(str) {
    return String(str).replace(new RegExp(_escapeForRegex(CURRENCY_SYMBOL), 'g'), '').replace(/,/g, '').trim();
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
    const raw = input.value;
    const pos = input.selectionStart;
    const symLen = CURRENCY_SYMBOL.length;

    // Strip symbol/commas/other junk to get pure digits (+ optional decimal).
    // Anything that isn't a digit or a period is dropped — letters, extra
    // punctuation, whitespace, the symbol itself.
    const cleaned = raw.replace(/[^0-9.]/g, '');

    // Empty cell → keep empty so the placeholder shows. This also covers
    // the "user backspaced through the symbol with nothing else there"
    // case: we don't want a lonely '$' to remain in the input.
    if (cleaned === '' || cleaned === '.') {
        input.value = '';
        return;
    }

    // Count digits to the left of the caret in the BEFORE state, ignoring
    // the symbol + commas. Also note whether the caret was past the decimal.
    const beforeCursor = raw.slice(0, pos);
    const digitsBeforeCursor = (beforeCursor.replace(/[^0-9]/g, '') || '').length;
    const afterDecimal = beforeCursor.includes('.');

    // Build the new value: symbol + comma-formatted digits/decimal.
    const dotIdx  = cleaned.indexOf('.');
    const intPart = dotIdx === -1 ? cleaned : cleaned.slice(0, dotIdx);
    const decPart = dotIdx === -1 ? '' : cleaned.slice(dotIdx);
    const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + decPart;
    input.value = CURRENCY_SYMBOL + formatted;

    // Walk the new value past the symbol, counting digits, and stop where
    // we hit the same digit count on the same side of the decimal as
    // before. That's the caret's logical "same place" landing spot.
    let digitCount  = 0;
    let pastDecimal = false;
    let newPos      = input.value.length;
    for (let i = symLen; i < input.value.length; i++) {
        if (digitCount === digitsBeforeCursor && pastDecimal === afterDecimal) {
            newPos = i;
            break;
        }
        const ch = input.value[i];
        if (ch === '.') pastDecimal = true;
        else if (ch >= '0' && ch <= '9') digitCount++;
    }
    input.setSelectionRange(newPos, newPos);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Escape a string for safe use inside a RegExp constructor. */
function _escapeForRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
