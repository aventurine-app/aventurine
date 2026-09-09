'use strict';

// ─── chartmath.js ───────────────────────────────────────────────────────────
// The geometry every line chart in the app is drawn from, in one copy.
//
// There are three chart engines, and there is no fourth place for this to live:
//   - widgets/chart.js    — the Reports tab's lines and stacked columns
//   - widgets/forecast.js — the Balance Forecast's split history/projection
//   - pages/dashboard.js  — the Dashboard's own frame (it does not load chart.js)
//
// Each held its own copy of the tick maths and the curve, and the copies had
// already started to differ in ways that were invisible: niceTicks carried a
// default `target` of 3 in one file and 4 in the other two, which no call site
// ever exercised because all of them pass it. A real divergence would have been
// just as quiet — two cards on one page curving differently, or an axis picking
// different gridlines for the same numbers.
//
//   ChartMath.niceTicks()      → the gridline values for a range.
//   ChartMath.bezierSegments() → clamped Catmull-Rom control points, as data.
//   ChartMath.smoothPath()     → those segments as an SVG path string.
//   ChartMath.curveYAt()       → the y the DRAWN curve carries at an x.
//
// Pure: no DOM, no tokens, no currency. Axis LABELS are a separate concern and
// belong to axisFormatter (core/currency.js), which is handed a whole tick set
// so it can pick one scale for all of them.

(function () {
    /**
     * Gridline values covering [min, max], about `target` of them.
     *
     * Steps are only 2, 5 or 10 × a power of ten, so labels land on round
     * numbers ($20K, $50K, $100K) rather than an awkward $30K or $15K. The
     * range is widened to whole steps at both ends so the first and last
     * gridline sit outside the data rather than through it.
     */
    function niceTicks(min, max, target = 4) {
        if (max <= min) return [min];
        const rough = (max - min) / target;
        const mag = Math.pow(10, Math.floor(Math.log10(rough)));
        const norm = rough / mag;
        let step;
        if      (norm < 2) step = 2  * mag;
        else if (norm < 5) step = 5  * mag;
        else               step = 10 * mag;
        const niceMin = Math.floor(min / step) * step;
        const niceMax = Math.ceil(max / step) * step;
        const ticks = [];
        // Round each tick to suppress the floating-point fuzz that accumulates
        // across the += below.
        for (let v = niceMin; v <= niceMax + step / 2; v += step) {
            ticks.push(Math.round(v * 1e6) / 1e6);
        }
        return ticks;
    }

    // Control points are CLAMPED to their own segment's y-range. An unclamped
    // Catmull-Rom tangent lets a segment overshoot the two points it connects: a
    // run of equal values followed by a rise bows the curve past the flat part
    // first, and between two months of zero it draws BELOW zero — a value
    // neither endpoint has. On the Saved & Invested chart that drew a negative
    // month; on a balance line it drew an account going negative in a week where
    // it does not, contradicting the sentence the Forecast card prints from the
    // real values. The cost is slightly less curvature at a peak.
    const clampSeg = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));

    /**
     * Catmull-Rom → cubic-bezier control points, one segment per gap, at the
     * standard 1/6 tension.
     *
     * Returned as DATA rather than only as path text so the drawn line and
     * anything positioned against it (a Forecast pin) are read off the SAME
     * geometry — see curveYAt.
     */
    function bezierSegments(pts) {
        const segs = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2] || p2;
            segs.push({
                p1,
                p2,
                c1: { x: p1.x + (p2.x - p0.x) / 6, y: clampSeg(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y) },
                c2: { x: p2.x - (p3.x - p1.x) / 6, y: clampSeg(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y) },
            });
        }
        return segs;
    }

    /**
     * The segments above as an SVG path.
     *
     * The curve passes through every data point, so no value is misrepresented,
     * while reading as a flowing line instead of a jagged polyline. Below 3
     * points it falls back to straight segments, where smoothing is meaningless.
     */
    function smoothPath(pts) {
        const f = (n) => Math.round(n * 100) / 100;
        if (pts.length < 3) {
            return pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
        }
        let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
        for (const s of bezierSegments(pts)) {
            d += ` C ${f(s.c1.x)} ${f(s.c1.y)}, ${f(s.c2.x)} ${f(s.c2.y)}, ${f(s.p2.x)} ${f(s.p2.y)}`;
        }
        return d;
    }

    const bezierAt = (a, b, c, e, t) => {
        const u = 1 - t;
        return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * e;
    };

    /**
     * The y the DRAWN line carries at a given x, so a marker sits on the curve.
     *
     * Reading the y off the underlying value instead put a Forecast pin a whole
     * week's net away from the line: the chart plots each week at its weekEnd and
     * curves between those points, so mid-week the line is still moving, and the
     * larger the planned expense the further the pin sat from the drop it caused.
     * Straight-line interpolation closes most of that but not the smoothing's
     * curve, so the bezier is solved instead: x(t) is monotonic within a segment
     * (points step forward and the control offsets are a sixth of a neighbour
     * gap), so bisect for the t whose x matches and read that t's y. 24 halvings
     * is well under a pixel.
     */
    function curveYAt(segs, x) {
        if (!segs.length) return null;
        const seg = segs.find((s) => x >= s.p1.x && x <= s.p2.x)
            || (x < segs[0].p1.x ? segs[0] : segs[segs.length - 1]);
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (bezierAt(seg.p1.x, seg.c1.x, seg.c2.x, seg.p2.x, mid) < x) lo = mid;
            else hi = mid;
        }
        return bezierAt(seg.p1.y, seg.c1.y, seg.c2.y, seg.p2.y, (lo + hi) / 2);
    }

    window.ChartMath = { niceTicks, bezierSegments, smoothPath, curveYAt };
})();
