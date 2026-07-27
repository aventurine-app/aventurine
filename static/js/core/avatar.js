'use strict';

// ─── avatar.js ──────────────────────────────────────────────────────────────
// Shared merchant avatar: a deterministic colour + initials circle, hashed
// from a merchant label. Loaded globally (pages/partials/scripts.html) so
// every consumer — transactions.js, recurring.js — renders the SAME merchant
// the SAME colour everywhere in the app, without a lookup table to maintain.
// No real merchant logos are bundled or fetched (offline, no network calls —
// see PRODUCT.md); CSS for the .avatar-circle classes lives in ui.css.
//
// Extracted from transactions.js, which originated this algorithm for the
// ledger's row icon.

(function () {
    // Fast, deterministic string hash (djb2) — no cryptographic properties
    // needed, just a stable, well-distributed bucket per merchant name.
    function avatarHashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) + str.charCodeAt(i);
            h |= 0;
        }
        return Math.abs(h);
    }

    // First letters of the first two words, or the first two characters of a
    // single word. Leading punctuation is stripped per word first — raw bank
    // strings the lexicon didn't clean up often start a word with '*' or '#'
    // (POS prefixes like "SQ *MERCHANT"), which would otherwise become the
    // initial itself. '?' covers the no-description edge case (never hashed
    // to a colour — see merchantAvatarHtml).
    function avatarInitials(name) {
        const words = String(name || '').trim().split(/\s+/)
            .map(w => w.replace(/^[^a-zA-Z0-9]+/, ''))
            .filter(Boolean);
        if (words.length === 0) return '?';
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    }

    // Trimmed copy of the noise patterns the backend categorizer strips before
    // matching (electron/backend/services/merchantCategories.js NOISE_PATTERNS)
    // — this file can't require() that Node module (the renderer runs with
    // nodeIntegration off), and colour-grouping only needs the *row-varying*
    // noise gone, not lexicon-grade precision, so this is a deliberately
    // smaller subset: payment-processor '*' prefixes, card masks, and
    // store/phone/trace/confirmation numbers. Without this, two deposits from
    // the same payroll processor ("DIRECT DEP ACME CORP ID:41355400" vs
    // "...ID:64140689") hashed as different merchants purely because their
    // trailing reference number differs — the same bug class the categorizer
    // solves for matching, just for colour instead of a category.
    const AVATAR_NOISE = [
        /\b(sq|tst|sp|pp|paypal|google|goog|apl|apple|toast|clover|venmo|cash app|zelle)\s*\*+\s*/gi,
        /[x*]{2,}\d+/gi,
        /\*+/g,
        /#\s*\d+/g,
        /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
        /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, // embedded dates
        /\b\d{3,}\b/g, // standalone id/auth/store-number runs
    ];

    function avatarColorKey(label) {
        let s = String(label || '').toLowerCase();
        for (const re of AVATAR_NOISE) s = s.replace(re, ' ');
        return s.replace(/\s+/g, ' ').trim();
    }

    // 8 fixed slots (.avatar-circle-0..7 in ui.css) — light/desaturated steps
    // of the same 8 hues as the dataviz skill's categorical palette, evenly
    // spaced by hue angle for pastel distinguishability (see ui.css for why).
    // The colour hash runs on the noise-stripped key (above) so unrecognized
    // merchants with a varying trailing reference number still land on one
    // colour; initials stay on the original label — the first-two-words
    // heuristic rarely touches that trailing noise anyway, and it's what's
    // actually printed alongside it.
    const AVATAR_SLOTS = 8;

    /** '<span class="avatar-circle avatar-circle-N">XY</span>' for a merchant
     *  label. `label` is expected pre-escaped-safe (callers pass it through
     *  escapeHtml themselves, matching how every other renderer in this app
     *  builds HTML strings). */
    function merchantAvatarHtml(label) {
        const initials = avatarInitials(label);
        const colorKey = avatarColorKey(label);
        const slot = colorKey ? avatarHashString(colorKey) % AVATAR_SLOTS : 0;
        return `<span class="avatar-circle avatar-circle-${slot}" aria-hidden="true">${escapeHtml(initials)}</span>`;
    }

    window.merchantAvatarHtml = merchantAvatarHtml;
}());
