'use strict';

// ─── donut.js ───────────────────────────────────────────────────────────────
// The segmented ring the Dashboard's Balances card and the Portfolio page share.
//
// Each slice is a circle stroke whose dash is the length of its arc, rotated to
// start at 12 o'clock. Slices meet edge to edge: their colours separate them,
// and a gap in a ring that sums to a whole reads as missing money. Stroke dashes
// can be transitioned, which is what drives the clockwise sweep-in.
//
//   DonutChart.render(host, { slices, centerLabel, centerValue, linkHint, animate })
//
//   animate    true (default) sweeps the ring in; pass false to redraw it in
//              place, as when a figure changes while the user is typing
//
//   slices: [{ label, color, value, valueText, href? }]
//     value      the arc's size, already a positive magnitude
//     valueText  what the slice is worth, as the user reads it (may be signed)
//     href       optional; makes the slice a link
//
// The ring's look lives in donut.css. Nothing here reads a colour token: the
// caller decides what each slice is painted.
//
// SECURITY: labels are user-controlled account names, so they are escaped
// before they reach innerHTML.

(function () {
    const SIZE = 280;
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const RING_WIDTH = 34;
    const RADIUS = (SIZE - RING_WIDTH) / 2 - 2;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    const MIN_ARC = 3;   // a sliver of a slice still has to be visible and hoverable

    const f2 = (n) => Math.round(n * 100) / 100;

    function buildArc(slice, index, start, total, { linkHint, animate }) {
        const len  = Math.max((slice.value / total) * CIRCUMFERENCE, MIN_ARC);
        const dash = `${f2(len)} ${f2(CIRCUMFERENCE - len)}`;
        // An animated arc renders at zero length and transitions to data-dash
        // after insertion. The transition is inline because the per-arc stagger
        // delay must only apply to the dash, never to the opacity hover.
        const arc = `<circle class="donut-arc" cx="${CX}" cy="${CY}" r="${RADIUS}" fill="none"
            stroke="${escapeHtml(slice.color)}" stroke-width="${RING_WIDTH}"
            stroke-dasharray="${animate ? `0 ${f2(CIRCUMFERENCE)}` : dash}"
            data-dash="${dash}"
            stroke-dashoffset="${f2(-start)}"
            style="transition: ${animate ? `stroke-dasharray 0.9s cubic-bezier(0.25, 0.1, 0.25, 1) ${index * 110}ms, ` : ''}opacity 0.15s ease 0s">
            <title>${escapeHtml(slice.label)}: ${escapeHtml(slice.valueText)}</title>
        </circle>`;

        if (!slice.href) return `<g class="donut-slice">${arc}</g>`;

        const aria = `${slice.label}: ${slice.valueText}${linkHint ? ` — ${linkHint}` : ''}`;
        return `<a class="donut-link" href="${escapeHtml(slice.href)}" tabindex="0" role="link"
            aria-label="${escapeHtml(aria)}">${arc}</a>`;
    }

    function render(host, { slices, centerLabel, centerValue, linkHint = '', animate = true }) {
        const total = slices.reduce((sum, s) => sum + s.value, 0);

        let offset = 0;
        const arcs = slices.map((slice, i) => {
            const start = (offset / total) * CIRCUMFERENCE;
            offset += slice.value;
            return buildArc(slice, i, start, total, { linkHint, animate });
        }).join('');

        host.innerHTML = `
        <svg viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="xMidYMid meet" class="accounts-pie-svg">
            <g transform="rotate(-90 ${CX} ${CY})">${arcs}</g>
            <text class="donut-center-label" x="${CX}" y="${CY - 10}" text-anchor="middle">${escapeHtml(centerLabel)}</text>
            <text class="donut-center-value" x="${CX}" y="${CY + 16}" text-anchor="middle">${escapeHtml(centerValue)}</text>
        </svg>`;

        if (!animate) return;

        // Double rAF guarantees one frame paints at zero length before the dash
        // targets are set, so the transition always runs.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            host.querySelectorAll('.donut-arc').forEach((arc) => {
                arc.setAttribute('stroke-dasharray', arc.dataset.dash);
            });
        }));
    }

    window.DonutChart = { render };
})();
