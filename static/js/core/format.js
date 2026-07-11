'use strict';

// ─── format.js ──────────────────────────────────────────────────────────────
// Shared plain-number formatting + the app-wide debounce. Loaded globally
// (pages/partials/scripts.html) before any page/widget script, so every
// consumer — tables.js, portfolio.js, credit_cards.js — gets the same copy.
// Extracted from tables.js, which had grown into the de-facto utils home;
// currency-aware formatting (symbols, hide-cents, separators) stays in
// currency.js — these helpers are symbol-agnostic.
//
//   debounce(fn, delay)      → trailing-edge debounced wrapper of fn.
//   applyCommaFormat(input)  → live-reformat a text input with thousand
//                              separators, preserving the caret position.
//   formatDisplay(num)       → read-only display string: commas, ".00"
//                              hidden, other decimals kept.

(function () {
    // Precompiled — formatWithCommas / applyCommaFormat run inside input
    // event listeners, so recreating these per keystroke would be wasteful.
    const _RE_NON_DECIMAL  = /[^0-9.]/g;
    const _RE_NON_DIGIT    = /[^0-9]/g;
    const _RE_THOUSANDS    = /\B(?=(\d{3})+(?!\d))/g;
    const _RE_SINGLE_DIGIT = /[0-9]/;

    /** Strip non-numeric chars, then insert thousand separators into the integer part. */
    function formatWithCommas(raw) {
        const clean  = String(raw).replace(_RE_NON_DECIMAL, '');
        const dotIdx = clean.indexOf('.');
        const intPart = dotIdx === -1 ? clean : clean.slice(0, dotIdx);
        const decPart = dotIdx === -1 ? '' : clean.slice(dotIdx);
        return intPart.replace(_RE_THOUSANDS, ',') + decPart;
    }

    /**
     * Reformat an input's value with commas in-place while preserving the caret
     * position relative to the underlying DIGITS — without this, the cursor
     * would jump to the end of the field every time a comma was inserted.
     *
     * We compute (a) how many digits sit to the left of the caret before
     * formatting and (b) whether the caret was already past the decimal point,
     * then walk the formatted string until we hit the same digit count on the
     * same side of the decimal.
     */
    function applyCommaFormat(input) {
        const raw = input.value;
        const pos = input.selectionStart;
        const beforeCursor = raw.slice(0, pos);
        const digitsBeforeCursor = beforeCursor.replace(_RE_NON_DIGIT, '').length;
        const afterDecimal = beforeCursor.includes('.');

        const formatted = formatWithCommas(raw);
        input.value = formatted;

        let digitCount  = 0;
        let pastDecimal = false;
        let newPos      = formatted.length;
        for (let i = 0; i < formatted.length; i++) {
            if (digitCount === digitsBeforeCursor && pastDecimal === afterDecimal) {
                newPos = i;
                break;
            }
            if (formatted[i] === '.') {
                pastDecimal = true;
            } else if (_RE_SINGLE_DIGIT.test(formatted[i])) {
                digitCount++;
            }
        }
        input.setSelectionRange(newPos, newPos);
    }

    /**
     * Format a number for read-only display (totals, footer cells, computed
     * spans). Hides ".00" so whole-dollar values look clean. Decimals like .50
     * are preserved as ".50".
     */
    function formatDisplay(num) {
        const fixed = num.toFixed(2);
        const [intStr, decStr] = fixed.split('.');
        const intFormatted = intStr.replace(_RE_THOUSANDS, ',');
        return decStr === '00' ? intFormatted : intFormatted + '.' + decStr;
    }

    /**
     * Standard trailing-edge debounce. Used by every cell save handler so we get
     * one API call per ~600 ms of typing instead of one per keystroke. Returns
     * a function whose arguments are forwarded to fn on each fire.
     */
    function debounce(fn, delay) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
    }

    window.debounce = debounce;
    window.applyCommaFormat = applyCommaFormat;
    window.formatDisplay = formatDisplay;
}());
