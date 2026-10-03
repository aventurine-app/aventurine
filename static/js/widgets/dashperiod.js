'use strict';

// ─── dashperiod.js ────────────────────────────────────────────────────────────
// Every Dashboard card carries its own period, and this file is the one place a
// period's meaning is decided: the months (or days) a card covers, and the words
// its header shows for them. Pure, like dashgrid.js: no DOM, and `now` is a
// parameter, so electron/backend/__tests__/dashPeriod.test.js can pin a date.
//
// A SPEC is what a card stores: { preset, month }
//   preset   'month'                         one calendar month
//            'm3' 'm6' 'ytd' 'y1' 'y3' 'y5'   months ending with the current one
//            'd14' 'd30' 'd60'                days ahead from today (Upcoming Bills)
//            'f1' 'f3' 'f6'                   months ahead (Balance Forecast)
//   month    'YYYY-MM' fixes a 'month' preset on that month. null follows the
//            current month, so it moves on by itself when the month turns.
//
// THE RANGES END WITH THE CURRENT, PARTIAL MONTH, the rule the Dashboard's Year
// to Year range always followed: "1Y" is the twelve months ending with this one,
// and YTD is January through this month. A month in the future is never a
// period, so a pin past the current month falls back to it.
//
// SLOTS are { year, monthIdx } (monthIdx 0-11), the shape widgets/chart.js plots
// across, so a resolved period hands its months straight to a chart.
//
// Dual-environment: window.DashPeriod in the browser, module.exports under Node.

(function () {
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

    const PRESETS = {
        month: { kind: 'month', name: 'Month' },
        m3:  { kind: 'range', months: 3,  name: 'Past 3 months', short: '3M' },
        m6:  { kind: 'range', months: 6,  name: 'Past 6 months', short: '6M' },
        ytd: { kind: 'range', name: 'Year to date', short: 'YTD' },
        y1:  { kind: 'range', months: 12, name: 'Past year', short: '1Y' },
        y3:  { kind: 'range', months: 36, name: 'Past 3 years', short: '3Y' },
        y5:  { kind: 'range', months: 60, name: 'Past 5 years', short: '5Y' },
        d14: { kind: 'ahead', days: 14, name: 'Next 14 days', short: '14 days' },
        d30: { kind: 'ahead', days: 30, name: 'Next 30 days', short: '30 days' },
        d60: { kind: 'ahead', days: 60, name: 'Next 60 days', short: '60 days' },
        f1:  { kind: 'ahead', months: 1, name: 'Next month', short: '1 month' },
        f3:  { kind: 'ahead', months: 3, name: 'Next 3 months', short: '3 months' },
        f6:  { kind: 'ahead', months: 6, name: 'Next 6 months', short: '6 months' },
    };

    const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
    const toIndex = (s) => s.year * 12 + s.monthIdx;
    const fromIndex = (t) => ({ year: Math.floor(t / 12), monthIdx: ((t % 12) + 12) % 12 });
    const currentSlot = (now) => ({ year: now.getFullYear(), monthIdx: now.getMonth() });

    /** 'YYYY-MM' → slot, or null when it is not one. */
    function parseMonth(text) {
        const m = MONTH_RE.exec(String(text || ''));
        return m ? { year: Number(m[1]), monthIdx: Number(m[2]) - 1 } : null;
    }
    const formatMonth = (s) => `${s.year}-${String(s.monthIdx + 1).padStart(2, '0')}`;

    /** Every month from `a` to `b`, both included. */
    function monthsBetween(a, b) {
        const out = [];
        for (let t = toIndex(a); t <= toIndex(b); t++) out.push(fromIndex(t));
        return out;
    }

    const yy = (year) => `’${String(year).slice(2)}`;

    /** "October 2026" / "January – October 2026" / "November 2025 – October 2026". */
    function longLabel(slots) {
        const a = slots[0], b = slots[slots.length - 1];
        if (slots.length === 1) return `${MONTH_NAMES[a.monthIdx]} ${a.year}`;
        return a.year === b.year
            ? `${MONTH_NAMES[a.monthIdx]} – ${MONTH_NAMES[b.monthIdx]} ${b.year}`
            : `${MONTH_NAMES[a.monthIdx]} ${a.year} – ${MONTH_NAMES[b.monthIdx]} ${b.year}`;
    }

    /** The header's form: "Oct 2026" / "Jan – Oct 2026" / "Nov ’25 – Oct ’26". */
    function shortLabel(slots) {
        const a = slots[0], b = slots[slots.length - 1];
        if (slots.length === 1) return `${MONTH_SHORT[a.monthIdx]} ${a.year}`;
        return a.year === b.year
            ? `${MONTH_SHORT[a.monthIdx]} – ${MONTH_SHORT[b.monthIdx]} ${b.year}`
            : `${MONTH_SHORT[a.monthIdx]} ${yy(a.year)} – ${MONTH_SHORT[b.monthIdx]} ${yy(b.year)}`;
    }

    const dayLabel = (d) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
    const startOfDay = (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

    /**
     * Resolve a spec against `now`. Month and range periods answer with their
     * `slots` (first to last), a long `label` for prose and screen readers and a
     * `short` one for the card header. Look-ahead periods answer with the dates
     * they span (`start` today, `end` inclusive) and, for the forecast presets,
     * `months` ahead. An unknown preset reads as the current month.
     */
    function resolve(spec, now = new Date()) {
        const preset = spec && Object.hasOwn(PRESETS, spec.preset) ? spec.preset : 'month';
        const def = PRESETS[preset];

        if (def.kind === 'ahead') {
            const start = startOfDay(now);
            const end = def.days
                ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + def.days - 1)
                : new Date(start.getFullYear(), start.getMonth() + def.months, start.getDate() - 1);
            return {
                kind: 'ahead', preset, days: def.days || null, months: def.months || null,
                start, end,
                label: `${def.name}, ${dayLabel(start)} – ${dayLabel(end)}`,
                short: def.name,
            };
        }

        const current = currentSlot(now);
        let slots;
        if (def.kind === 'month') {
            const pinned = parseMonth(spec && spec.month);
            slots = [pinned && toIndex(pinned) <= toIndex(current) ? pinned : current];
        } else if (preset === 'ytd') {
            slots = monthsBetween({ year: current.year, monthIdx: 0 }, current);
        } else {
            slots = monthsBetween(fromIndex(toIndex(current) - (def.months - 1)), current);
        }
        return {
            kind: def.kind,
            preset,
            slots,
            first: slots[0],
            last: slots[slots.length - 1],
            // The single month that is the one in progress: a card names it
            // "this month" in its empty state rather than as a past month.
            isCurrentMonth: def.kind === 'month' && toIndex(slots[0]) === toIndex(current),
            label: longLabel(slots),
            short: shortLabel(slots),
        };
    }

    /**
     * A spec a card may hold: `allowed` is the card's list of presets and
     * `fallback` the spec it starts with. Anything else in a stored spec (an
     * unknown preset, a pin on a range, a field an older build stored) is
     * dropped rather than trusted, so a hand-edited or older layout still loads.
     */
    function clean(spec, allowed, fallback) {
        const s = spec && typeof spec === 'object' ? spec : {};
        const base = allowed.includes(s.preset) ? s : fallback;
        return {
            preset: base.preset,
            month: base.preset === 'month' && parseMonth(base.month) ? base.month : null,
        };
    }

    const DashPeriod = {
        PRESETS, MONTH_NAMES, MONTH_SHORT,
        resolve, clean, formatMonth, monthsBetween, longLabel,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DashPeriod;
    else window.DashPeriod = DashPeriod;
}());
