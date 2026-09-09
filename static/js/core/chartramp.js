'use strict';

// ─── chartramp.js ───────────────────────────────────────────────────────────
// The gold spending ramp as the CHARTS draw it, in one copy.
//
// --chart-outflow-* is eight steps deepest first (style.css), but the charts
// start it at --chart-expense — the named token the Dashboard's Expenses line,
// its pill and its Monthly Cash Flow expense bar are all drawn in — and only
// walk lighter from there. Without the trim the same card's biggest spending
// band came out several steps deeper than the line beside it, reading as a
// browner family rather than as the strongest step of the one gold set.
//
// Two files draw expense bands off this ramp — the Dashboard's Monthly Cash
// Flow and Spending cards, and the Cash Flow report's Sankey — and they are on
// two different pages, so neither can hold the rule for the other. Two copies
// could drift, and the drift would show as two cards disagreeing about which
// gold means "the biggest thing you spent on".
//
//   ChartRamp.outflow() → the trimmed ramp, deepest first.

(function () {
    // First-paint fallbacks, matching the light theme's tokens.
    const OUTFLOW_FALLBACK = [
        '#826400', '#916f00', '#a17c02', '#b28a06',
        '#c39a0e', '#d3ab1e', '#e2bd3c', '#eed168',
    ];

    // The colour a value paints as. The named tokens are not literals —
    // --chart-expense is `var(--chart-outflow-4)` — and getPropertyValue can
    // hand back that text rather than a colour, so the value is put on a probe
    // element and read back resolved. Both sides of the match go through this,
    // so it holds either way round.
    //
    // The probe is created and removed inside one compute() pass rather than
    // parked in the document: reading it back forces a style flush per call, so
    // it is only worth holding for the run of calls that need it, and nothing is
    // left in the DOM afterwards.
    function makeProbe() {
        const el = document.createElement('span');
        el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        (document.body || document.documentElement).appendChild(el);
        return {
            resolve(value) {
                el.style.color = '';
                el.style.color = value;
                return getComputedStyle(el).color || value;
            },
            done() { el.remove(); },
        };
    }

    /**
     * The spending ramp with every step DEEPER than --chart-expense dropped.
     *
     * The start is found by MATCHING that token against the ramp rather than by
     * cutting a fixed number of steps, because the slot it points at is a
     * palette decision — Aventurine takes step 4, Gemstone step 2 (themes.css) —
     * and a fixed cut would trim the wrong end of a palette whose ramp starts
     * deep. A palette pointing --chart-expense somewhere off the ramp matches
     * nothing and keeps all eight steps.
     *
     * The cost is a shorter ramp — five steps in the stock palettes — so the
     * wrap that gives two categories one colour arrives sooner. Every band and
     * bar drawn from it prints its own name and figure, which is what let the
     * ramp grade magnitude rather than identity in the first place.
     */
    function compute() {
        const cs = getComputedStyle(document.documentElement);
        const ramp = OUTFLOW_FALLBACK.map(
            (fb, i) => cs.getPropertyValue(`--chart-outflow-${i + 1}`).trim() || fb);
        const named = cs.getPropertyValue('--chart-expense').trim();
        if (!named) return ramp;

        const probe = makeProbe();
        try {
            const target = probe.resolve(named);
            const start = ramp.findIndex(step => probe.resolve(step) === target);
            return start > 0 ? ramp.slice(start) : ramp;
        } finally {
            probe.done();
        }
    }

    // Computing the ramp costs nine getComputedStyle reads and nine probe style
    // writes, and the Dashboard asks for it twice per month render, so the
    // answer is held until the tokens behind it move. Only a theme or graph
    // palette swap moves them, and both dispatch 'themechange' (shell/
    // settings.js). This listener is registered when the shared script block
    // loads, ahead of every page script, so the cache is already cleared by the
    // time a chart's own 'themechange' listener repaints.
    let cached = null;
    window.addEventListener('themechange', () => { cached = null; });

    function outflow() {
        if (!cached) cached = compute();
        // A copy: the cache is shared by every caller on the page, and a caller
        // that sorted or spliced the array in place would repaint the others.
        return cached.slice();
    }

    window.ChartRamp = { outflow };
})();
