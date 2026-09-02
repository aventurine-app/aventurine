'use strict';

// ─── Dashboard ───────────────────────────────────────────────────────────────
// Two stacked sections, both on the page at once, each with a heading row
// carrying the one control that scopes its three cards:
//
// "Month to Month" — the monthly view, defaulting to the current month with a
// section-level stepper (arrows + a year and a month picker) to look back at
// any earlier month:
//   1. Monthly Cash Flow (horizontal bars: the month's income / expenses /
//      transfers totals, each bar subdivided into its categories, from the
//      Cash Flow statement — /api/data)
//   2. Spending (bar chart: the month's expense total per category, same data)
//   3. Balances (donut by account type, latest known balances)
//
// "Year to Year" — the long-run view, scoped by a range picker:
//   4. Net worth over time (line chart from balance data)
//   5. Income & Expenses monthly totals (line chart)
//   6. Per-account balances (line chart, user picks which accounts to compare)
//
// All charts are built as inline SVG by hand — no chart library. The
// ResizeObserver-based observeChart() helper redraws on container resize, and
// performs the first (animated) paint once a container has a width.

(function () {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i]));

    // escapeHtml is a global from escape.js (loaded by pages/partials/scripts.html). All
    // user-controlled label values go through it before innerHTML interpolation.

    // Chart series palette — read from the accent-derived --chart-* tokens (style.css)
    // at use time so every graph follows the UI accent and retones on a palette/theme
    // swap. The fallbacks mirror the light-theme accent ramp for the rare first paint
    // before styles resolve.
    const CHART_PALETTE_FALLBACK = [
        '#8fb088', '#5c7152', '#a9c1a4', '#33402d',
        '#7c9670', '#b6c8b2', '#647a59', '#5a6f50',
    ];
    function readChartPalette() {
        const cs = getComputedStyle(document.documentElement);
        return CHART_PALETTE_FALLBACK.map((fb, i) =>
            cs.getPropertyValue(`--chart-${i + 1}`).trim() || fb);
    }

    /**
     * Last-observation-carried-forward snapshot of the balance sheet: for each
     * account column, the value from the most recent month it was actually
     * filled in. A balance carries forward until the user enters a newer one, so
     * a row that only updates one account doesn't blank out the rest of the pie.
     * `cutoff` ({ year, monthIdx }, optional) caps the search — months after it
     * are ignored, giving the snapshot "as of" that month.
     * Returns a { key: value } map over the latest known value per column.
     */
    function latestValueByColumn(entries, cutoff) {
        const cutoffT = cutoff ? cutoff.year * 12 + cutoff.monthIdx : Infinity;
        const latest = {};   // key -> { t, value } with t = year * 12 + monthIdx
        for (const [yearStr, months] of Object.entries(entries)) {
            const year = parseInt(yearStr);
            for (const [month, cats] of Object.entries(months)) {
                const idx = MONTH_INDEX.get(month);
                if (idx === undefined) continue;
                const t = year * 12 + idx;
                if (t > cutoffT) continue;
                for (const [key, val] of Object.entries(cats)) {
                    const prev = latest[key];
                    if (!prev || t > prev.t) latest[key] = { t, value: val };
                }
            }
        }
        const out = {};
        for (const [key, rec] of Object.entries(latest)) out[key] = rec.value;
        return out;
    }

    // Uses CURRENCY_SYMBOL from currency.js (loaded globally in pages/partials/scripts.html).
    // Read at call time so a user changing the symbol in Settings is reflected
    // on the next render without a full reload of this script.
    function fmtValue(n) {
        if (n === null) return '—';
        return formatCurrency(n, true);
    }

    // ─── Accounts pie ────────────────────────────────────────────────────────────
    // Single donut summarising the balance sheet as of the month shown by the
    // section stepper (dashboardMonth). One slice per account type — Investments, Cash,
    // Retirement, Debt — sized by the sum of each column's most recent value at
    // or before that month (carried forward via latestValueByColumn, so a
    // partially-filled month doesn't blank out accounts that were only updated
    // earlier). Debt is shown as its absolute magnitude so the slice has visible
    // area; its distinct accent shade and the legend label mark it as a
    // liability rather than an asset.

    /** Pull the four slice colours from the accent-derived --chart-* tokens so the
     *  Balances pie follows the UI accent and retones on a palette/theme swap.
     *  Four well-separated stops keep the slices distinguishable within the single-hue
     *  accent family; the green/red tokens stay reserved for the numeric figures. */
    function getAccountsPieColors() {
        const cs = getComputedStyle(document.documentElement);
        const v  = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
        return {
            investment: v('--chart-1', '#8fb088'),
            cash:       v('--chart-2', '#5c7152'),
            retirement: v('--chart-3', '#a9c1a4'),
            debt:       v('--chart-4', '#33402d'),
        };
    }

    function renderAccountsPie(data) {
        const pieEl    = document.getElementById('accounts-pie');
        const legendEl = document.getElementById('accounts-legend');
        if (!pieEl || !legendEl) return;

        const entries = data.entries || {};
        const columns = data.columns || [];
        const curr    = latestValueByColumn(entries, dashboardMonth);

        if (Object.keys(curr).length === 0) {
            pieEl.style.display = 'none';
            pieEl.innerHTML = '';
            // Distinguish a truly empty balance sheet from a stepped-back month
            // that predates the first recorded balance.
            const hasAnyData = Object.keys(latestValueByColumn(entries)).length > 0;
            legendEl.innerHTML = hasAnyData ? UI.emptyState({
                icon: null, compact: true,
                title: `No balances by ${dashboardMonthLabel()}`,
            }) : UI.emptyState({
                icon: null, compact: true,
                title: 'No balances to show yet',
                action: { label: 'Add balances', href: '/statements#balance-sheet', primary: true },
            });
            return;
        }

        pieEl.style.display = '';
        const sumType = (type) => columns
            .filter(c => c.type === type)
            .reduce((s, c) => s + (curr[c.key] ?? 0), 0);

        const colors = getAccountsPieColors();
        const raw = [
            { label: 'Investments', signed: sumType('investment'), color: colors.investment },
            { label: 'Cash',        signed: sumType('cash'),       color: colors.cash },
            { label: 'Retirement',  signed: sumType('retirement'), color: colors.retirement },
            { label: 'Debt',        signed: sumType('debt'),       color: colors.debt },
        ];
        // Slice magnitudes are absolute — a debt of 12k contributes the same
        // visual weight as 12k in assets. Skip types with no data so the pie
        // doesn't draw zero-area wedges.
        const slices = raw
            .map(s => ({ ...s, value: Math.abs(s.signed) }))
            .filter(s => s.value > 0);

        const total = slices.reduce((s, x) => s + x.value, 0);
        if (total === 0) {
            pieEl.style.display = 'none';
            pieEl.innerHTML = '';
            legendEl.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: 'All balances are zero',
                action: { label: 'Edit balances', href: '/statements#balance-sheet', primary: true },
            });
            return;
        }

        // Segmented stroke ring: each slice is a circle stroke with a dash the
        // length of its arc, rotated to start at 12 o'clock. Slices meet edge to
        // edge — their colours are what separate them, and a gap in a ring that
        // sums to a whole reads as missing money. Stroke dashes can be
        // transitioned, which is what drives the sweep-in animation below.
        const size = 280, cx = size / 2, cy = size / 2;
        const sw   = 34;                              // ring thickness
        const r    = (size - sw) / 2 - 2;
        const C    = 2 * Math.PI * r;
        const f2   = (n) => Math.round(n * 100) / 100;

        let acc = 0;
        const arcs = slices.map((s, i) => {
            const len   = Math.max((s.value / total) * C, 3);
            const start = (acc / total) * C;
            acc += s.value;
            // Arcs render at zero length (dasharray "0 C") and transition to
            // data-dash after insertion — a staggered clockwise sweep. The
            // transition is inline because the per-arc stagger delay must only
            // apply to the dash, never to the opacity hover (dashboard.css §6).
            return `<circle class="donut-arc" cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${s.color}" stroke-width="${sw}"
            stroke-dasharray="0 ${f2(C)}" data-dash="${f2(len)} ${f2(C - len)}"
            stroke-dashoffset="${f2(-start)}"
            style="transition: stroke-dasharray 0.9s cubic-bezier(0.25, 0.1, 0.25, 1) ${i * 110}ms, opacity 0.15s ease 0s">
            <title>${escapeHtml(s.label)}: ${fmtValue(s.signed)}</title>
        </circle>`;
        }).join('');

        // Centre readout: assets minus debt at the displayed month — the same
        // sign convention computeNetWorth() uses for the Net Worth chart.
        const net = raw.reduce((t, s) => t + (s.label === 'Debt' ? -s.signed : s.signed), 0);

        pieEl.innerHTML = `
        <svg viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet" class="accounts-pie-svg">
            <g transform="rotate(-90 ${cx} ${cy})">${arcs}</g>
            <text class="donut-center-label" x="${cx}" y="${cy - 10}" text-anchor="middle">Net</text>
            <text class="donut-center-value" x="${cx}" y="${cy + 16}" text-anchor="middle">${fmtValue(net)}</text>
        </svg>
    `;

        // Kick the sweep: double rAF guarantees one frame paints at zero length
        // before the dash targets are set, so the transition always runs.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            pieEl.querySelectorAll('.donut-arc').forEach(arc => {
                arc.setAttribute('stroke-dasharray', arc.dataset.dash);
            });
        }));

        legendEl.innerHTML = slices.map(s => {
            const pct = (s.value / total) * 100;
            // The share sits on the label's line rather than in a separate column,
            // so the figure below it gets the legend's full width — in a
            // third-width card a percent column would truncate the dollar
            // amounts.
            return `<div class="accounts-legend-item">
            <span class="accounts-legend-dot" style="background:${s.color}"></span>
            <div class="accounts-legend-text">
                <div class="accounts-legend-head">
                    <div class="accounts-legend-label">${escapeHtml(s.label)}</div>
                    <div class="accounts-legend-pct">${pct.toFixed(1)}%</div>
                </div>
                <div class="accounts-legend-value">${fmtValue(s.signed)}</div>
            </div>
        </div>`;
        }).join('');
    }

    // Both datasets flow through Store (store.js) so navigating away from Dashboard
    // and back returns to a populated dashboard immediately, with a background
    // revalidation if anything changed elsewhere.
    const fetchBalanceData = () => Store.ensure('balance');
    const fetchIEData      = () => Store.ensure('ie');

    /**
     * Compute net-worth time-series points across all available years.
     * Treats `debt` columns as negative contributions. Returned points are
     * (year, monthIdx, value) tuples for the SVG chart builder; the range
     * picker filters down to the visible window in renderNetworthSection.
     *
     * Each populated month's value carries every column's most recent value
     * forward (the running `latest` map), so a month that only updates one
     * account still reports net worth across all accounts instead of dropping
     * to that single entry — the same carry-forward the Balances pie uses
     * (latestValueByColumn). A column contributes nothing until its first entry.
     */
    function computeNetWorth(data) {
        const allYears = (data.years || []).slice().sort((a, b) => a - b);
        const columns  = data.columns || [];
        const debtKeys = new Set(columns.filter(c => c.type === 'debt').map(c => c.key));

        // Gather every populated month, then visit them oldest-first so the
        // carry-forward only ever pulls values from earlier months.
        const monthsInOrder = [];
        for (const year of allYears) {
            const months = (data.entries || {})[String(year)] || {};
            for (const [month, cats] of Object.entries(months)) {
                const idx = MONTH_INDEX.get(month);
                if (idx === undefined) continue;
                monthsInOrder.push({ year, monthIdx: idx, cats });
            }
        }
        monthsInOrder.sort((a, b) => a.year !== b.year ? a.year - b.year : a.monthIdx - b.monthIdx);

        const latest = {};   // key -> most recent value seen up to this month
        const points = [];
        for (const { year, monthIdx, cats } of monthsInOrder) {
            for (const [key, val] of Object.entries(cats)) latest[key] = val;
            let total = 0;
            for (const [key, val] of Object.entries(latest)) {
                total += debtKeys.has(key) ? -val : val;
            }
            points.push({ year, monthIdx, value: total });
        }

        return { points, years: allYears };
    }

    /**
     * Pick 3-5 "nice" tick values that cover [min, max] using only 2, 5, or 10
     * times a power of ten as the step. Used for Y-axis labels so a chart of
     * $73K-$128K labels at $80K, $100K, $120K instead of $73,456 and $128,902.
     *
     * The returned range from ticks[0] to ticks[last] is the snapped chart
     * range — wider than [min, max] by at most one step on each side, so the
     * grid lines line up with the labels.
     */
    function niceTicks(min, max, target = 3) {
        if (max <= min) return [min];
        const rough = (max - min) / target;
        const mag = Math.pow(10, Math.floor(Math.log10(rough)));
        const norm = rough / mag;
        // Only 2, 5, or 10 × power of ten as steps — keeps the labels to even
        // round numbers ($20K, $50K, $100K), no awkward $30K or $15K. Target
        // of 3 lands at 3-4 ticks for typical ranges.
        let step;
        if      (norm < 2) step = 2  * mag;
        else if (norm < 5) step = 5  * mag;
        else               step = 10 * mag;
        const niceMin = Math.floor(min / step) * step;
        const niceMax = Math.ceil(max  / step) * step;
        const ticks = [];
        // Round each tick to suppress floating-point fuzz from accumulated +=.
        for (let v = niceMin; v <= niceMax + step / 2; v += step) {
            ticks.push(Math.round(v * 1e6) / 1e6);
        }
        return ticks;
    }

    // Axis labels come from axisFormatter (currency.js), which is handed the whole
    // tick set. Formatting ticks one at a time made distinct gridlines share a
    // label whenever the nice-tick step wasn't a round thousand — a 9,000-9,400
    // axis (step 200) read "$9K, $9K, $9K".

    function fmtTooltip(n) {
        return formatCurrency(n, true);
    }

    // ─── Hand-rolled SVG line chart ──────────────────────────────────────────────
    // One unified renderer for every line chart on the page (Net Worth, Income &
    // Expenses, Account Balances) so they all share an identical frame: same
    // gutters, same nice-tick Y axis, same dashed grid, same label typography,
    // same entrance animation. Lines render as smoothed bezier curves with a
    // soft gradient fill underneath; frame chrome (grid/labels) uses theme
    // variables so the charts retone with the palette and stay legible in the
    // light theme. Animation keyframes live in dashboard.css §10.

    const CHART_RATIO = 200 / 800;
    const chartObservers = new Map();

    // Frame shared by every chart: left gutter sized for the widest Y label,
    // identical top/right/bottom margins, so all charts line up across cards.
    const CHART_PAD = { l: 56, r: 20, t: 18, b: 30 };

    /**
     * Catmull-Rom → cubic-bezier smoothing. Produces a curve that passes
     * through every data point (no value is misrepresented) while reading as
     * a flowing line instead of a jagged polyline. Falls back to straight
     * segments below 3 points, where smoothing is meaningless.
     */
    const clampSeg = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));

    function smoothPath(pts) {
        const f = (n) => Math.round(n * 100) / 100;
        if (pts.length < 3) {
            return pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
        }
        let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2] || p2;
            // Tension 1/6 — the standard Catmull-Rom pass-through conversion,
            // with each control point CLAMPED to its segment's y-range.
            // Unclamped, a tangent lets a segment overshoot the two points it
            // connects: a run of equal values followed by a rise bows the curve
            // past the flat part first, and between two months of zero it draws
            // below zero, a value neither endpoint has. The cost is slightly less
            // curvature at a peak. Same fix as widgets/chart.js:smoothPath and
            // widgets/forecast.js:bezierSegments; the three chart engines each
            // hold a copy of this curve, so a change here applies to all three.
            const c1y = clampSeg(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y);
            const c2y = clampSeg(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y);
            d += ` C ${f(p1.x + (p2.x - p0.x) / 6)} ${f(c1y)},`
               + ` ${f(p2.x - (p3.x - p1.x) / 6)} ${f(c2y)},`
               + ` ${f(p2.x)} ${f(p2.y)}`;
        }
        return d;
    }

    /**
     * Build one inline SVG line chart from a list of series.
     *
     *   series:  [{ label, color, points: [{year, monthIdx, value}] }]
     *   years:   year list — used to generate slots when `slots` isn't passed.
     *            Each year becomes 12 month slots on the x-axis.
     *   slots:   explicit [{year, monthIdx}, ...] list. When provided,
     *            overrides `years` so the caller can render any custom
     *            date range (used by the Net Worth range picker).
     *   W:       target width in pixels (height = W * CHART_RATIO).
     *   animate: replay the entrance animation (line draw-in, fades). True on
     *            first paint and user-driven re-renders; false on resizes —
     *            observeChart() manages this.
     *
     * SECURITY: series.label is user-controlled (column name) and is escaped
     * before being placed inside the <title> tooltip. All other strings
     * interpolated here are numeric or attribute-safe constants.
     */
    function buildChartSVG({ series, years, slots: customSlots, W, animate = true }) {
        const slots = customSlots || (() => {
            const s = [];
            for (const year of years || []) {
                for (let m = 0; m < 12; m++) s.push({ year, monthIdx: m });
            }
            return s;
        })();
        const N = slots.length;

        const allValues = series.flatMap(s => s.points.map(p => p.value));
        if (allValues.length === 0) return null;

        // Height follows width, but never below a floor — in the narrow aside
        // column a pure ratio would leave ~75px of chart, squashing the Y axis
        // into unreadability.
        const H  = Math.max(Math.round(W * CHART_RATIO), 170);
        const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
        const CW = W - PL - PR;
        const CH = H - PT - PB;

        // Every chart snaps its value range to "nice" tick boundaries so the
        // grid labels read as clean round numbers ($80K, $100K, $120K) instead
        // of arbitrary padded values — one scale treatment everywhere.
        //
        // Before snapping, enforce a minimum vertical span (scaled to the
        // values' magnitude, with an absolute floor near zero) and centre the
        // data within it. Without this a flat or plateaued series collapses to
        // a zero-height range and glues the line to the bottom axis; centring a
        // padded span instead lays a flat stretch mid-chart. The extra head/
        // footroom also keeps peaks and troughs off the frame edges. Series with
        // real variation already exceed the minimum span, so they're unaffected.
        const dataLo = Math.min(...allValues);
        const dataHi = Math.max(...allValues);
        const mid    = (dataLo + dataHi) / 2;
        const span   = Math.max(dataHi - dataLo, Math.abs(mid) * 0.25, 1);
        const pad    = span * 0.1;
        const yTicks = niceTicks(mid - span / 2 - pad, mid + span / 2 + pad, 4);
        const minVal = yTicks[0];
        const maxVal = yTicks[yTicks.length - 1];
        const valRange = maxVal - minVal || 1;

        const xScale = i => PL + (i / (N - 1 || 1)) * CW;
        const yScale = v => PT + CH - ((v - minVal) / valRange) * CH;

        // Unique id per render so multiple charts on the page never collide
        // on the area-fill linearGradient ids.
        const rnd = Math.random().toString(36).slice(2, 9);

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

        // Horizontal grid + Y labels (right-aligned in the left gutter).
        // Styling lives in dashboard.css (.chart-grid / .chart-label) so the frame
        // chrome follows the theme instead of hard-coded dark-mode rgba values.
        const fmtAxis = axisFormatter(yTicks);
        for (const v of yTicks) {
            const y = yScale(v);
            svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }

        // Zero line — emphasised when values straddle zero.
        if (minVal < 0 && maxVal > 0) {
            const y0 = yScale(0);
            svg += `<line class="chart-zero" x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}"/>`;
        }

        // X labels: month abbreviations at a density that fits N; on charts
        // spanning multiple years, each January shows the year instead. The
        // final slot (current month) is labeled too unless it would collide
        // with the previous label.
        const multiYear = new Set(slots.map(s => s.year)).size > 1;
        const stride    = N <= 8 ? 1 : N <= 14 ? 2 : N <= 26 ? 3 : 6;
        const lastDist  = (N - 1) % stride;
        slots.forEach((s, i) => {
            const isLast = i === N - 1;
            if (!isLast && i % stride !== 0) return;
            if (isLast && lastDist !== 0 && lastDist < 2) return;
            const label = (multiYear && s.monthIdx === 0) ? s.year : MONTHS_SHORT[s.monthIdx];
            svg += `<text class="chart-label" x="${xScale(i)}" y="${H - PB + 18}" text-anchor="middle">${label}</text>`;
        });

        // Lines, area fills, and dots per series. Each series gets a smoothed
        // curve, a soft gradient under it, and a pulsing halo on its latest
        // point; entrance animations are staggered per series.
        series.forEach((s, si) => {
            const pointMap = new Map(s.points.map(p => [`${p.year}-${p.monthIdx}`, p.value]));
            const slotData = slots.map((sl, i) => ({
                ...sl,
                i,
                value: pointMap.get(`${sl.year}-${sl.monthIdx}`) ?? null,
            }));

            const drawn   = slotData.filter(sl => sl.value !== null);
            const linePts = drawn.map(sl => ({ x: xScale(sl.i), y: yScale(sl.value) }));
            const delay   = si * 140;

            if (linePts.length > 1) {
                const baseY = H - PB;
                const lineD = smoothPath(linePts);
                const areaD = `${lineD} L ${linePts[linePts.length - 1].x} ${baseY}`
                            + ` L ${linePts[0].x} ${baseY} Z`;

                // Anchor the gradient to the line's actual vertical extent so
                // the fade is consistent whether the series sits high or low —
                // tone near the line, transparent at the baseline. Opacity is
                // kept low enough that overlapping series don't turn muddy.
                const lineTopY = Math.min(...linePts.map(p => p.y));
                const gradId   = `areagrad-${rnd}-${si}`;
                svg += `<defs>
                <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse"
                                x1="0" y1="${lineTopY}" x2="0" y2="${baseY}">
                    <stop offset="0%"   stop-color="${s.color}" stop-opacity="0.30"/>
                    <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
                </linearGradient>
            </defs>`;
                svg += `<path class="chart-area-fill" d="${areaD}" fill="url(#${gradId})" style="animation-delay:${delay + 400}ms"/>`;
                // pathLength="1" normalises the dash math for the CSS draw-in.
                svg += `<path class="chart-line" d="${lineD}" pathLength="1" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" style="animation-delay:${delay}ms"/>`;
            }

            drawn.forEach((sl, di) => {
                const x = xScale(sl.i);
                const y = yScale(sl.value);
                const isEnd = di === drawn.length - 1;
                // Dots cascade in behind the line draw; the cap keeps dense
                // charts (60 slots) from dragging the entrance out.
                const dotDelay = Math.min(delay + 300 + di * 18, delay + 900);
                if (isEnd && linePts.length > 1) {
                    svg += `<circle class="chart-pulse" cx="${x}" cy="${y}" r="4" style="stroke:${s.color}; animation-delay:${delay + 1100}ms"/>`;
                }
                svg += `<circle class="chart-dot${isEnd ? ' chart-dot-end' : ''}" cx="${x}" cy="${y}" r="${isEnd ? 4.5 : 3}" fill="${s.color}" style="animation-delay:${dotDelay}ms">
                <title>${escapeHtml(s.label)} — ${MONTHS[sl.monthIdx]} ${sl.year}: ${fmtTooltip(sl.value)}</title>
            </circle>`;
            });
        });

        svg += '</svg>';
        return svg;
    }

    /**
     * Render a chart and keep it responsive by re-rendering whenever its
     * container resizes. Stores the observer per-container so old observers
     * are torn down when new data is loaded.
     *
     * The first paint of each registration animates (initial load, and
     * user-driven re-renders like the range picker or account toggles, which call
     * observeChart again); plain window resizes re-render without the entrance so
     * the chart does not flicker while dragging. The width guard also discards the
     * ResizeObserver's immediate same-size callback, which would otherwise cancel
     * the entrance animation one frame in.
     *
     * `fillHeight` makes a chart redraw when the host's HEIGHT changes too, and
     * passes that height to renderFn as its third argument. Only a chart that
     * derives its height from the host rather than from its width should set this
     * (Monthly Cash Flow, see dashboard.css §4) — for every other chart the host's
     * height comes from the SVG just drawn into it, so tracking it would trigger a
     * repaint on each render.
     */
    function observeChart(containerId, renderFn, { fillHeight = false } = {}) {
        const existing = chartObservers.get(containerId);
        if (existing) existing.disconnect();
        const el = document.getElementById(containerId);
        if (!el) return;
        // Observe the parent so shrinking the window triggers a re-render — the
        // chart div cannot shrink below the SVG it already contains.
        const target = el.parentElement || el;

        let animate     = true;   // flips off after the first successful paint
        let lastW       = 0;
        let lastH       = 0;
        let sawInitial  = false;  // has the observer delivered its first callback?
        const render = (w, h) => {
            w = Math.round(w);
            h = Math.round(h);
            if (w > 0 && (w !== lastW || (fillHeight && h !== lastH))) {
                lastW = w;
                lastH = h;
                el.innerHTML = renderFn(w, animate, h) || '';
                animate = false;
            }
        };

        const obs = new ResizeObserver(entries => {
            const w = Math.round(entries[0].contentRect.width);
            const h = Math.round(entries[0].contentRect.height);
            // A ResizeObserver always fires once immediately after observe(). If
            // the synchronous paint below already ran (animate is now false), that
            // first callback is not a real resize — record its content-box width as
            // the baseline and return WITHOUT repainting, so the entrance animation
            // is not cancelled a frame in. Width alone cannot distinguish the two
            // cases: the sync paint uses clientWidth, this reports
            // contentRect.width, and a layout shift in between (e.g. the page
            // scrollbar appearing as other cards populate) makes them differ.
            //
            // Height is the exception for a fillHeight chart: the sync paint
            // measured the host before the row's other cards finished filling, so a
            // first callback reporting a DIFFERENT height is a real change (a
            // neighbouring card grew) and must be drawn. This callback still lands
            // before the frame paints, so the entrance animation is re-armed rather
            // than skipped.
            if (!sawInitial) {
                sawInitial = true;
                if (!animate) {
                    lastW = w;
                    if (!fillHeight || h === lastH) { lastH = h; return; }
                    animate = true;
                }
            }
            render(w, h);
        });
        obs.observe(target);
        chartObservers.set(containerId, obs);
        // Immediate first paint (animated). If layout isn't ready yet (width 0),
        // the observer's first callback above performs the animated paint instead.
        render(target.clientWidth, target.clientHeight);
    }

    // ─── Time range (Year to Year section) ───────────────────────────────────────
    //
    // One shared range for every Year to Year chart, picked from the dropdown on
    // that section's heading row (the stepper's counterpart). Changing it re-derives
    // each chart's slots, filtered points, and the Net Worth % change.
    //
    // Ranges:
    //   year — January through the current month of the current calendar year.
    //          Change = year-to-date.
    //   12mo — trailing 12 months ending on the current month. Change = 12-month.
    //   24mo — trailing 24 months ending on the current month. Change = 24-month.
    //   5yr  — trailing 60 months ending on the current month. Change = 5-year.

    let overtimeRange = 'year';

    const RANGE_LABELS = {
        year: 'Year to Date',
        '12mo': 'Last Year',
        '24mo': 'Last 2 Years',
        '5yr':  'Last 5 Years',
    };

    /** Trailing N-month window ending on the current calendar month. */
    function trailingMonthSlots(n) {
        const now = new Date();
        const yr  = now.getFullYear();
        const mo  = now.getMonth();
        const s = [];
        for (let i = n - 1; i >= 0; i--) {
            const total = yr * 12 + mo - i;
            s.push({ year: Math.floor(total / 12), monthIdx: total % 12 });
        }
        return s;
    }

    /** Build the {year, monthIdx} slot list the chart should span for a range. */
    function getRangeSlots(range) {
        if (range === '12mo') return trailingMonthSlots(12);
        if (range === '24mo') return trailingMonthSlots(24);
        if (range === '5yr')  return trailingMonthSlots(60);
        // 'year' (default) — Jan through current month of this calendar year.
        const now = new Date();
        const yr  = now.getFullYear();
        const mo  = now.getMonth();
        const s = [];
        for (let m = 0; m <= mo; m++) s.push({ year: yr, monthIdx: m });
        return s;
    }

    /** Keep only the points that fall inside the given slot list. */
    function filterPointsToSlots(allPoints, slots) {
        const key = s => `${s.year}-${s.monthIdx}`;
        const allowed = new Set(slots.map(key));
        return allPoints.filter(p => allowed.has(key(p)));
    }

    /** Absolute + percent change from the first to the last data point in the
     *  filtered range. Returns null when there aren't enough points or the base
     *  is 0 (percent would be undefined). */
    function computeRangeChange(filtered) {
        if (filtered.length < 2) return null;
        const first = filtered[0].value;
        const last  = filtered[filtered.length - 1].value;
        if (first === 0) return null;
        return { delta: last - first, pct: ((last - first) / Math.abs(first)) * 100 };
    }

    /** Update the summary text (value + change) and (re)render the chart. */
    function renderNetworthSection(balanceData) {
        const all   = computeNetWorth(balanceData);
        const slots = getRangeSlots(overtimeRange);
        const filtered = filterPointsToSlots(all.points, slots);

        const valueEl  = document.getElementById('networth-value');
        const changeEl = document.getElementById('networth-change');

        // Summary value = most recent data point overall (not affected by range).
        const currentVal = all.points.length > 0
            ? all.points[all.points.length - 1].value
            : null;
        if (valueEl) valueEl.textContent = fmtValue(currentVal);

        // Change = first→last within the selected range. Shows the absolute
        // delta in currency followed by the percentage in parentheses, e.g.
        // "+ $30,000 (5.00 %)".
        if (changeEl) {
            const change = computeRangeChange(filtered);
            if (change === null) {
                changeEl.textContent = '—';
                changeEl.className = 'networth-change stat-change-neutral';
            } else {
                const sign = change.delta >= 0 ? '+' : '-';
                const absDelta = fmtValue(Math.abs(change.delta));
                const pctStr = Math.abs(change.pct).toFixed(2);
                changeEl.textContent = `${sign} ${absDelta} (${pctStr} %)`;
                changeEl.className = 'networth-change ' + (change.delta >= 0 ? 'stat-change-up' : 'stat-change-down');
            }
        }

        const container = document.getElementById('networth-chart');
        if (!container) return;

        // With no balances at all the summary is two em dashes over an empty
        // state — two placeholders stacked, which also pushes the notice off the
        // card's centre. Hide it and give the empty state the whole card. A range
        // that happens to be empty keeps the summary, since those figures are
        // real.
        document.querySelector('.networth-card')
            ?.classList.toggle('is-empty', all.points.length === 0);

        if (filtered.length === 0) {
            container.innerHTML = all.points.length === 0
                ? UI.emptyState({
                    icon: null,
                    title: 'No net worth to chart yet',
                    action: { label: 'Add balances', href: '/statements#balance-sheet', primary: true },
                })
                : UI.emptyState({
                    icon: null, compact: true,
                    title: 'Nothing in this range',
                });
            return;
        }

        // Read the first chart stop so the net-worth line, gradient and nodes
        // retone when the user swaps either palette. --chart-1, not
        // --accent-primary: it resolves TO the accent under the default graph
        // palette, and to the first colourful stop under the other one, so a
        // single-series chart still belongs to the same set as every other.
        // Net worth is a neutral metric, not a gain/loss figure, so it tracks
        // the palette rather than the finance-positive green (which stays
        // reserved for the +/- delta numbers and the income/asset indicators).
        const accentColor = getComputedStyle(document.documentElement)
            .getPropertyValue('--chart-1').trim() || '#8fb088';
        const series = [{ label: 'Net Worth', color: accentColor, points: filtered }];

        observeChart('networth-chart', (W, animate) => buildChartSVG({ series, slots, W, animate }));
    }

    /** Wire the toolbar range-picker button + dropdown. `onSelect` receives the
     *  chosen range key and re-renders the Year to Year charts. The outer click
     *  handler closes the dropdown when the user clicks anywhere else. */
    function wireRangePicker(btnId, menuId, onSelect) {
        const btn  = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!btn || !menu) return;

        btn.addEventListener('click', e => {
            e.stopPropagation();
            menu.hidden = !menu.hidden;
        });

        menu.addEventListener('click', e => {
            const item = e.target.closest('[data-range]');
            if (!item) return;
            menu.hidden = true;
            onSelect(item.dataset.range);
        });

        document.addEventListener('click', e => {
            if (menu.hidden) return;
            if (!menu.contains(e.target) && !btn.contains(e.target)) {
                menu.hidden = true;
            }
        });
    }

    // ─── Income & Expenses + Account Balances charts ─────────────────────────────

    /** Pull income/expense line colours from the two NAMED chart tokens
     *  (--chart-income / --chart-expense, style.css) so the chart retones on a
     *  palette/theme swap. Named rather than numbered because these two series
     *  mean something: under the accent ramp they resolve to the base accent and
     *  a high-contrast shade of it (income leading, expenses apart from it within
     *  the single-hue family), and under a palette with hues to spend they resolve
     *  to green and red. Reading a slot number here would pin them to the former. */
    function getIEColors() {
        const cs = getComputedStyle(document.documentElement);
        const v  = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
        return {
            income:   v('--chart-income', '#8fb088'),
            expenses: v('--chart-expense', '#33402d'),
        };
    }

    function computeIESeries(data) {
        const years = (data.years || []).slice().sort((a, b) => a - b);
        const columns = data.columns || [];

        const incomeKeys  = new Set(columns.filter(c => c.type === 'income').map(c => c.key));
        const expenseKeys = new Set(columns.filter(c => c.type === 'expense').map(c => c.key));

        const incomePoints  = [];
        const expensePoints = [];

        for (const year of years) {
            const months = (data.entries || {})[String(year)] || {};
            for (const [month, cats] of Object.entries(months)) {
                const monthIdx = MONTH_INDEX.get(month);
                if (monthIdx === undefined) continue;
                let incomeTotal = 0, expenseTotal = 0;
                let hasIncome = false, hasExpense = false;
                for (const [key, val] of Object.entries(cats)) {
                    if (incomeKeys.has(key))  { incomeTotal  += val; hasIncome  = true; }
                    if (expenseKeys.has(key)) { expenseTotal += val; hasExpense = true; }
                }
                if (hasIncome)  incomePoints.push({ year, monthIdx, value: incomeTotal });
                if (hasExpense) expensePoints.push({ year, monthIdx, value: expenseTotal });
            }
        }

        incomePoints.sort((a, b)  => a.year !== b.year ? a.year - b.year : a.monthIdx - b.monthIdx);
        expensePoints.sort((a, b) => a.year !== b.year ? a.year - b.year : a.monthIdx - b.monthIdx);

        const colors = getIEColors();
        return [
            { label: 'Income',   color: colors.income,   points: incomePoints },
            { label: 'Expenses', color: colors.expenses, points: expensePoints },
        ];
    }

    let ieData  = null;
    // Series hidden via the legend toggles. Both lines start visible; the set
    // holds labels the user has switched off.
    const ieHidden = new Set();

    /**
     * Render the Income/Expenses legend as toggle buttons (same chrome as the
     * Account Balances selector). Clicks flip the series in/out of `ieHidden`
     * and re-render the chart. Labels are the fixed strings 'Income'/'Expenses'.
     */
    function renderIESelector(series) {
        const container = document.getElementById('ie-selector');
        if (!container) return;

        container.innerHTML = series.map(s => {
            const active = ieHidden.has(s.label) ? '' : 'active';
            return `<button class="account-toggle ${active}" data-series="${escapeHtml(s.label)}">
            <span class="account-toggle-dot" style="background:${s.color}"></span>
            ${escapeHtml(s.label)}
        </button>`;
        }).join('');

        container.querySelectorAll('.account-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const label = btn.dataset.series;
                if (ieHidden.has(label)) {
                    ieHidden.delete(label);
                    btn.classList.add('active');
                } else {
                    ieHidden.add(label);
                    btn.classList.remove('active');
                }
                renderIEChart(ieData);
            });
        });
    }

    function renderIEChart(data) {
        const container = document.getElementById('ie-chart');
        if (!container) return;

        const series = computeIESeries(data);
        const hasAnyData = series.some(s => s.points.length > 0);

        if (!hasAnyData) {
            container.innerHTML = UI.emptyState({
                icon: null,
                title: 'No income or expenses yet',
                action: { label: 'Open Statements', href: '/statements#cash-flow', primary: true },
            });
            const selEl = document.getElementById('ie-selector');
            if (selEl) selEl.innerHTML = '';
            chartObservers.get('ie-chart')?.disconnect();
            return;
        }

        renderIESelector(series);

        // Same windowing as Net Worth: build the slot list for the selected
        // range and drop points outside it so the Y axis scales to the window.
        const slots = getRangeSlots(overtimeRange);
        const visible = series
            .filter(s => !ieHidden.has(s.label))
            .map(s => ({ ...s, points: filterPointsToSlots(s.points, slots) }));

        if (visible.length === 0) {
            container.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: 'Nothing selected',
            });
            chartObservers.get('ie-chart')?.disconnect();
            return;
        }
        if (!visible.some(s => s.points.length > 0)) {
            container.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: 'Nothing in this range',
            });
            chartObservers.get('ie-chart')?.disconnect();
            return;
        }

        observeChart('ie-chart', (W, animate) => buildChartSVG({ series: visible, slots, W, animate }));
    }

    let appData = null;
    const selectedAccounts = new Set();

    function buildColorMap(columns) {
        const palette = readChartPalette();
        return new Map((columns || []).map((c, i) => [c.key, palette[i % palette.length]]));
    }

    function renderAccountChart() {
        const container = document.getElementById('account-chart');
        if (!container || !appData) return;

        const keys = [...selectedAccounts];
        if (keys.length === 0) {
            // Nothing selected vs nothing selectable: with no accounts at all
            // there are no chips above to act on, so the card points at the
            // Balance Sheet the way its neighbours do.
            container.innerHTML = (appData.columns || []).length === 0
                ? UI.emptyState({
                    icon: null,
                    title: 'No accounts to compare yet',
                    action: { label: 'Add balances', href: '/statements#balance-sheet', primary: true },
                })
                : UI.emptyState({
                    icon: null, compact: true,
                    title: 'Nothing selected',
                });
            chartObservers.get('account-chart')?.disconnect();
            return;
        }

        // Same windowing as Net Worth: build the slot list for the selected
        // range and drop points outside it so the Y axis scales to the window.
        const slots = getRangeSlots(overtimeRange);
        const allYears = (appData.years || []).slice().sort((a, b) => a - b);
        const colorMap = buildColorMap(appData.columns);
        const series = keys.map(key => {
            const col = (appData.columns || []).find(c => c.key === key);
            const points = [];
            for (const year of allYears) {
                const months = (appData.entries || {})[String(year)] || {};
                for (const [month, cats] of Object.entries(months)) {
                    const monthIdx = MONTH_INDEX.get(month);
                    if (monthIdx === undefined || !(key in cats)) continue;
                    points.push({ year, monthIdx, value: cats[key] });
                }
            }
            points.sort((a, b) => a.year !== b.year ? a.year - b.year : a.monthIdx - b.monthIdx);
            return {
                label: col ? col.label : key,
                color: colorMap.get(key),
                points: filterPointsToSlots(points, slots),
            };
        });

        const hasAnyData = series.some(s => s.points.length > 0);
        if (!hasAnyData) {
            container.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: 'Nothing in this range',
            });
            chartObservers.get('account-chart')?.disconnect();
            return;
        }

        observeChart('account-chart', (W, animate) => buildChartSVG({ series, slots, W, animate }));
    }

    /**
     * Render the buttons that let the user pick which accounts to plot on the
     * Account Balances chart. Clicks toggle the account in/out of `selectedAccounts`
     * and trigger a chart re-render.
     *
     * SECURITY: col.key and col.label are user-controlled — both pass through
     * escapeHtml before being placed in the button's HTML.
     */
    function renderAccountSelector(data) {
        const container = document.getElementById('account-selector');
        if (!container) return;

        const columns = data.columns || [];
        if (columns.length === 0) {
            container.innerHTML = '';
            return;
        }

        const colorMap = buildColorMap(columns);

        container.innerHTML = columns.map(col => {
            const active = selectedAccounts.has(col.key) ? 'active' : '';
            const color = colorMap.get(col.key);
            return `<button class="account-toggle ${active}" data-key="${escapeHtml(col.key)}">
            <span class="account-toggle-dot" style="background:${color}"></span>
            ${escapeHtml(col.label)}
        </button>`;
        }).join('');

        container.querySelectorAll('.account-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                if (selectedAccounts.has(key)) {
                    selectedAccounts.delete(key);
                    btn.classList.remove('active');
                } else {
                    selectedAccounts.add(key);
                    btn.classList.add('active');
                }
                renderAccountChart();
            });
        });
    }

    // ─── Month to Month (one month of the Cash Flow statement) ──────────────────
    // The section's two charts read one month of the Cash Flow statement (the
    // same /api/data payload the Year to Year charts use): per-type totals feed
    // the Monthly Cash Flow horizontal bars, per-expense-category values feed
    // the Spending bars. The statement is the blend point — synced cells are
    // computed from transactions, the rest are hand-entered — so the section
    // lights up for import users and manual bookkeepers alike. The section-level
    // stepper defaults to the current month — month-to-date — and reaches any
    // earlier month, either a step at a time on the arrows or straight there
    // through its year and month pickers; both charts follow it (no fetch: the
    // month is sliced out of the already-loaded dataset).

    let dashboardMonth = (() => {
        const now = new Date();
        return { year: now.getFullYear(), monthIdx: now.getMonth() };
    })();

    function isCurrentDashboardMonth() {
        const now = new Date();
        return dashboardMonth.year === now.getFullYear() && dashboardMonth.monthIdx === now.getMonth();
    }

    function dashboardMonthLabel() {
        return `${MONTHS[dashboardMonth.monthIdx]} ${dashboardMonth.year}`;
    }

    // Monthly Cash Flow rows, in display order, on the three named chart tokens —
    // the same two getIEColors reads plus transfers, so this card and the Income
    // & Expenses line chart use identical colours for income.
    // Under the accent ramp that is the base accent, its high-contrast shade and
    // an intermediate stop; under a palette with hues to spend, green/red/blue.
    const MCF_ROWS = [
        { key: 'income',   label: 'Income',    token: '--chart-income',   fallback: '#8fb088' },
        { key: 'expense',  label: 'Expenses',  token: '--chart-expense',  fallback: '#33402d' },
        { key: 'transfer', label: 'Transfers', token: '--chart-transfer', fallback: '#5c7152' },
    ];

    /**
     * Build one inline SVG horizontal bar chart: one row per flow type, amount on
     * the X axis. Same frame chrome as the other charts (nice-tick axis, dashed
     * grid, label typography); each bar is annotated with its exact value at the
     * end, so the month's statement reads without hovering.
     *
     * Height comes from the HOST, not from the width: three rows have no aspect
     * ratio to honour, so the chart takes the height its card was given (`avail`,
     * measured by observeChart's fillHeight mode) and shares it out between the
     * bands, which is what lets it fill a card stretched tall by its neighbour
     * instead of leaving dead space. Band growth moves the bars apart; bar
     * thickness follows only part of the way and stops, so a very tall card gets
     * an airy chart rather than three slabs. Without a measurement it falls back
     * to the natural band, i.e. the height this chart has always drawn at.
     *
     * Each bar is subdivided into its categories: `segments` tile the bar in
     * proportion to their share of the type, shaded from the type's base colour
     * (nearest the axis) fading outward, separated by a hairline gap, forming
     * per-category bars within the flow-type bar. Each segment carries a value
     * tooltip; the row's total is annotated at the end.
     *
     *   rows: [{ label, color, value, segments: [{ name, value }] }]
     *         — values ≥ 0; segments optional (a bare bar is drawn without them).
     *
     * SECURITY: segment names are user-controlled category labels — escaped in
     * the <title> tooltip.
     */
    function buildHBarChartSVG({ rows, W, avail = 0, animate = true }) {
        if (rows.length === 0) return null;

        // Left gutter fits the row labels, right gutter the value annotations.
        const PL = 96, PR = 96, PT = 8, PB = 30;
        const MIN_BAND = 44;                   // natural vertical space per bar row
        const BAND = Math.max(MIN_BAND, Math.round((avail - PT - PB) / rows.length));
        // 0.36 is the natural 16-in-44 ratio, so a band at its floor draws the
        // bar it always did; 34 is where a bar stops reading as a bar.
        const BAR  = Math.round(Math.min(34, BAND * 0.36));
        const H  = PT + rows.length * BAND + PB;
        const CW = W - PL - PR;
        const f2 = (n) => Math.round(n * 100) / 100;

        const xTicks = niceTicks(0, Math.max(...rows.map(r => r.value)), 4);
        const maxVal = xTicks[xTicks.length - 1] || 1;
        const xScale = v => PL + (v / maxVal) * CW;
        const plotBottom = PT + rows.length * BAND;

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

        const fmtAxis = axisFormatter(xTicks);
        for (const v of xTicks) {
            const x = xScale(v);
            svg += `<line class="chart-grid" x1="${f2(x)}" y1="${PT}" x2="${f2(x)}" y2="${plotBottom}"/>`;
            svg += `<text class="chart-label" x="${f2(x)}" y="${plotBottom + 18}" text-anchor="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }

        // Bar corners: rounded right end only — the bar must sit flat on the axis.
        // The radius tracks the thickness (4 at the natural 16) so a bar that
        // grew with the card doesn't keep a cap sized for a thinner one.
        const RR  = Math.min(BAR / 4, 6);
        const MIN_SEG = 8;                     // floor on a segment's width (see allocateSegmentWidths)

        rows.forEach((r, i) => {
            const yMid = PT + BAND * (i + 0.5);
            const y    = yMid - BAR / 2;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(yMid)}" text-anchor="end" dominant-baseline="middle">${escapeHtml(r.label)}</text>`;

            const len = xScale(r.value) - PL;
            // Split the bar into its category segments; fall back to a single
            // segment (labelled with the flow type) when none are supplied.
            const segs = (r.segments && r.segments.length)
                ? r.segments
                : (r.value > 0 ? [{ name: r.label, value: r.value }] : []);

            if (len > 0) {
                // Segments tile the bar edge to edge — no gap between them; the
                // shade ramp is what separates one from the next.
                const widths = allocateSegmentWidths(segs.map(sg => sg.value), len, MIN_SEG);
                let x0 = PL;
                segs.forEach((seg, j) => {
                    const xe   = x0 + widths[j];
                    const w    = xe - x0;
                    const last = j === segs.length - 1;
                    // Butt-jointed paths leave a hairline of card background at the
                    // seam once antialiased, which looks like the gap being
                    // removed. Every segment but the last runs half a pixel long and
                    // the next one paints over it (later paths take precedence in
                    // the DOM and in hit-testing), so the joint is solid.
                    const xd = last ? xe : xe + 0.5;
                    if (w >= 0.5) {
                        const fill  = segmentShade(r.color, j, segs.length);
                        const round = last && w > RR;
                        const d = round
                            ? `M ${f2(x0)} ${f2(y)} L ${f2(xd - RR)} ${f2(y)}`
                              + ` Q ${f2(xd)} ${f2(y)} ${f2(xd)} ${f2(y + RR)}`
                              + ` L ${f2(xd)} ${f2(y + BAR - RR)}`
                              + ` Q ${f2(xd)} ${f2(y + BAR)} ${f2(xd - RR)} ${f2(y + BAR)}`
                              + ` L ${f2(x0)} ${f2(y + BAR)} Z`
                            : `M ${f2(x0)} ${f2(y)} L ${f2(xd)} ${f2(y)}`
                              + ` L ${f2(xd)} ${f2(y + BAR)} L ${f2(x0)} ${f2(y + BAR)} Z`;
                        svg += `<path class="chart-hbar" d="${d}" fill="${fill}" style="animation-delay:${i * 80 + j * 40}ms">
                <title>${escapeHtml(seg.name)}: ${fmtTooltip(seg.value)}</title>
            </path>`;
                    }
                    x0 = xe;
                });
            }

            svg += `<text class="chart-bar-value" x="${f2(PL + Math.max(len, 0) + 8)}" y="${f2(yMid)}" dominant-baseline="middle" style="animation-delay:${i * 80 + 350}ms">${fmtValue(r.value)}</text>`;
        });

        svg += '</svg>';
        return svg;
    }

    /**
     * Share `total` px out between `values` in proportion, but never let a
     * segment fall below `minW` — a category worth 0.3% of the month is a
     * two-pixel sliver otherwise, which is a tooltip nobody can hit. Slivers are
     * raised to the floor and the surplus is taken back from the segments that
     * have room above it, in proportion to that room, so the bar's TOTAL length
     * still lands exactly on its value (the number the axis and the end
     * annotation are read against). Only the internal split is nudged, and the
     * per-segment tooltip still carries the exact figure.
     *
     * When the bar is too short to give everyone the floor, it splits evenly:
     * at that size the bar is a total, not a breakdown.
     */
    function allocateSegmentWidths(values, total, minW) {
        const n = values.length;
        if (n === 0) return [];
        if (n * minW >= total) return values.map(() => total / n);

        const sum = values.reduce((a, b) => a + b, 0) || 1;
        const widths = values.map(v => (v / sum) * total);

        let deficit = 0;
        const raised = widths.map((w) => {
            if (w >= minW) return false;
            deficit += minW - w;
            return true;
        });
        if (deficit === 0) return widths;

        // Room available above the floor among the segments not being raised.
        // n * minW < total guarantees this pool covers the deficit.
        let room = 0;
        widths.forEach((w, i) => { if (!raised[i]) room += w - minW; });
        const scale = room > 0 ? (room - deficit) / room : 0;
        return widths.map((w, i) => (raised[i] ? minW : minW + (w - minW) * scale));
    }

    /** Shade for the j-th of n category segments within one flow-type bar: the
     *  type's base colour at full strength for the segment nearest the axis,
     *  fading toward the page background outward, so the bar reads as one colour
     *  subdivided into category segments. Nested color-mix is valid — the base
     *  token may itself be a color-mix expression, as it is under the accent ramp,
     *  where --chart-income and friends resolve to accent mixes. */
    function segmentShade(base, j, n) {
        if (n <= 1) return base;
        const pct = Math.round(100 - (j / (n - 1)) * 45);   // 100% (axis) → 55% (outer)
        return `color-mix(in srgb, ${base} ${pct}%, var(--background))`;
    }

    /** Render the Monthly Cash Flow card from the month's per-type totals, each
     *  bar split into its categories (`segments`, keyed by flow type). */
    function renderMonthlyCashflow(totals, segments) {
        const container = document.getElementById('mcf-chart');
        if (!container) return;

        const cs = getComputedStyle(document.documentElement);
        const rows = MCF_ROWS.map(r => ({
            label: r.label,
            color: cs.getPropertyValue(r.token).trim() || r.fallback,
            value: (totals && totals[r.key]) || 0,
            segments: (segments && segments[r.key]) || [],
        }));

        if (!rows.some(r => r.value > 0)) {
            chartObservers.get('mcf-chart')?.disconnect();
            // The month card leads to the statement, its neighbours to balances
            // and the ledger — one destination each, so the row doesn't repeat
            // the same button three times.
            container.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: isCurrentDashboardMonth() ? 'No activity this month yet' : `Nothing in ${dashboardMonthLabel()}`,
                action: { label: 'Open Statements', href: '/statements#cash-flow', primary: true },
            });
            return;
        }

        observeChart(
            'mcf-chart',
            (W, animate, H) => buildHBarChartSVG({ rows, W, avail: H, animate }),
            { fillHeight: true },
        );
    }

    /**
     * Build one inline SVG bar chart: one bar per category, value on the Y axis.
     * Shares the line charts' frame (same pad, grid, nice-tick axis, label
     * typography) so the Spending card lines up with everything else; the bars'
     * grow-in entrance lives in dashboard.css §11.
     *
     *   bars: [{ label, color, value }] — in user category order, values > 0.
     *
     * SECURITY: bar labels are user-controlled category names — escaped both in
     * the axis label and the <title> tooltip.
     */
    function buildBarChartSVG({ bars, W, avail = 0, animate = true }) {
        if (bars.length === 0) return null;

        const { l: PL, r: PR, t: PT } = CHART_PAD;
        const CW    = W - PL - PR;
        const slotW = CW / bars.length;
        const f2 = (n) => Math.round(n * 100) / 100;

        // Each name gets one band. In a third-width card with a month's worth of
        // categories that band is a few characters wide, which turns every label
        // into an initial ("Uti…", "Ent…"), so past that point the names tilt
        // instead — and the chart buys the room out of its bottom padding rather
        // than out of the plot. Labels short enough to sit flat still do.
        const LABEL_PX  = 6.5;   // ≈ one character at the 11px label size
        const flatChars = Math.max(4, Math.floor(slotW / LABEL_PX));
        const longest   = Math.max(...bars.map(b => b.label.length));
        const rotate    = flatChars < Math.min(longest, 8);
        const TILT      = 35;
        // A tilted label runs down-right from its bar's centre, so the leftmost
        // bar's label is the one that can run off the chart — cap every label at
        // what fits under that one (the SVG is clipped by .chart-area, so an
        // overrun is a cut-off word, not an overflow).
        const fitChars  = Math.floor((PL + slotW / 2) / (LABEL_PX * Math.cos(TILT * Math.PI / 180)));
        const maxChars  = rotate ? Math.max(6, Math.min(16, fitChars)) : flatChars;
        const labels = bars.map(b => (b.label.length > maxChars
            ? b.label.slice(0, maxChars - 1).trimEnd() + '…'
            : b.label));

        const extra = rotate
            ? Math.round(Math.max(...labels.map(l => l.length)) * LABEL_PX * Math.sin(TILT * Math.PI / 180))
            : 0;
        const PB = CHART_PAD.b + extra;
        // Height comes from the HOST where there is one (`avail`, measured by
        // observeChart's fillHeight mode): a row of categories has no aspect
        // ratio to honour, and taking the card's height is what puts the bars in
        // the space a taller neighbour opened up instead of leaving it blank
        // under them. The tilt's extra bottom padding comes out of that height,
        // so the labels never push the SVG past the card clipping it. Without a
        // measurement it falls back to the width-derived height this chart has
        // always drawn at.
        const H  = Math.max(avail, Math.round(W * CHART_RATIO), 170) + (avail ? 0 : extra);
        const CH = H - PT - PB;

        // Spending is always ≥ 0, so the axis is anchored at zero and snapped to
        // nice ticks above the tallest bar.
        const yTicks = niceTicks(0, Math.max(...bars.map(b => b.value)), 4);
        const maxVal = yTicks[yTicks.length - 1] || 1;
        const yScale = v => PT + CH - (v / maxVal) * CH;
        const baseY  = PT + CH;

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

        const fmtAxis = axisFormatter(yTicks);
        for (const v of yTicks) {
            const y = yScale(v);
            svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }

        const barW = Math.min(slotW * 0.6, 64);

        bars.forEach((b, i) => {
            const cx = PL + slotW * (i + 0.5);
            const x  = cx - barW / 2;
            const y  = yScale(b.value);
            const h  = baseY - y;
            // Rounded top corners only — the bar must sit flat on the baseline.
            const r  = Math.min(4, barW / 2, h);
            const d  = `M ${f2(x)} ${f2(baseY)} L ${f2(x)} ${f2(y + r)}`
                     + ` Q ${f2(x)} ${f2(y)} ${f2(x + r)} ${f2(y)}`
                     + ` L ${f2(x + barW - r)} ${f2(y)}`
                     + ` Q ${f2(x + barW)} ${f2(y)} ${f2(x + barW)} ${f2(y + r)}`
                     + ` L ${f2(x + barW)} ${f2(baseY)} Z`;
            svg += `<path class="chart-bar" d="${d}" fill="${b.color}" style="animation-delay:${i * 60}ms">
            <title>${escapeHtml(b.label)}: ${fmtTooltip(b.value)}</title>
        </path>`;

            // Category name under the bar (the tooltip carries the full one when
            // even the tilted label has to be cut).
            const ly = H - PB + 18;
            svg += rotate
                ? `<text class="chart-label" x="${f2(cx)}" y="${ly}" text-anchor="end"
                    transform="rotate(-${TILT} ${f2(cx)} ${ly})">${escapeHtml(labels[i])}</text>`
                : `<text class="chart-label" x="${f2(cx)}" y="${ly}" text-anchor="middle">${escapeHtml(labels[i])}</text>`;
        });

        svg += '</svg>';
        return svg;
    }

    /** Render the Spending card from the month's per-category totals. */
    function renderSpendingChart(cats) {
        const container = document.getElementById('spending-chart');
        if (!container) return;

        if (cats.length === 0) {
            chartObservers.get('spending-chart')?.disconnect();
            container.innerHTML = isCurrentDashboardMonth()
                ? UI.emptyState({
                    icon: null,
                    title: 'No spending this month yet',
                    action: { label: 'Add transactions', href: '/transactions', primary: true },
                })
                : UI.emptyState({
                    icon: null, compact: true,
                    title: `Nothing in ${dashboardMonthLabel()}`,
                });
            return;
        }

        const palette = readChartPalette();
        const bars = cats.map((c, i) => ({
            label: c.name,
            color: palette[i % palette.length],
            value: c.total,
        }));
        observeChart(
            'spending-chart',
            (W, animate, H) => buildBarChartSVG({ bars, W, avail: H, animate }),
            { fillHeight: true },
        );
    }

    /** Update the stepper label/buttons, fetch the month (cached per page load),
     *  and (re)render both monthly charts. */
    /**
     * Slice one month out of the Cash Flow statement payload: per-type totals
     * for the Monthly Cash Flow bars plus per-expense-category values for the
     * Spending bars. Every column contributes to its type's total whatever its
     * cell holds (synced or hand-entered — the statement already resolved
     * that); the Spending list keeps only positive expense cells, in the
     * user's category order (the order `data.columns` arrives in — the same
     * left-to-right order the Cash Flow statement shows).
     */
    function sliceStatementMonth(data) {
        const cells = ((data.entries || {})[String(dashboardMonth.year)] || {})[MONTHS[dashboardMonth.monthIdx]] || {};
        const totals = { income: 0, expense: 0, transfer: 0 };
        // Per-type category breakdown (positive cells only, in column order) so
        // each Monthly Cash Flow bar can be drawn as its categories stacked.
        const segments = { income: [], expense: [], transfer: [] };
        const categories = [];
        for (const col of data.columns || []) {
            const val = cells[col.key];
            if (typeof val !== 'number') continue;
            if (col.type in totals) {
                totals[col.type] += val;
                if (val > 0) segments[col.type].push({ key: col.key, name: col.label, value: val });
            }
            if (col.type === 'expense' && val > 0) {
                categories.push({ key: col.key, name: col.label, total: val });
            }
        }
        return { totals, segments, categories };
    }

    async function renderMonthSection() {
        const monthEl = document.getElementById('dashboard-month-label');
        const yearEl  = document.getElementById('dashboard-year-label');
        const nextBtn = document.getElementById('dashboard-month-next');
        if (monthEl) monthEl.textContent = MONTHS[dashboardMonth.monthIdx];
        if (yearEl)  yearEl.textContent  = String(dashboardMonth.year);
        if (nextBtn) nextBtn.disabled = isCurrentDashboardMonth();

        let data = ieData;
        if (!data) {
            const cancelSkeleton = UI.skeletonGuard(() => {
                for (const id of ['mcf-chart', 'spending-chart']) {
                    chartObservers.get(id)?.disconnect();
                    const el = document.getElementById(id);
                    if (el) el.innerHTML = UI.skChart(id === 'mcf-chart' ? 180 : 220);
                }
            });
            try {
                // Deduped with init()'s fetch by Store — one request per load.
                data = await fetchIEData();
            } catch {
                // Fetch failure — fall through to the empty states.
                data = { entries: {}, columns: [] };
            }
            cancelSkeleton();
            ieData = data;
        }

        const month = sliceStatementMonth(data);
        renderMonthlyCashflow(month.totals, month.segments);
        renderSpendingChart(month.categories);
        // The Balances donut is month-scoped too. Balance data has not arrived on
        // the first call from init(); that path renders the pie once the fetch
        // completes.
        if (appData) renderAccountsPie(appData);
    }

    /** Step the monthly view back/forward. Forward stops at the current month
     *  (the next button is disabled there too — this is the belt to its braces). */
    function shiftDashboardMonth(delta) {
        const now = new Date();
        const target = dashboardMonth.year * 12 + dashboardMonth.monthIdx + delta;
        if (target > now.getFullYear() * 12 + now.getMonth()) return;
        dashboardMonth = { year: Math.floor(target / 12), monthIdx: ((target % 12) + 12) % 12 };
        renderMonthSection();
    }

    /** The last month a year can show: the future is never a month to look at,
     *  so the current year stops at today's month and every earlier year runs
     *  to December. Same clamp shiftDashboardMonth applies to the arrows. */
    function lastMonthIdxOfYear(year) {
        const now = new Date();
        return year === now.getFullYear() ? now.getMonth() : 11;
    }

    /**
     * Years the year picker offers, newest first: every year the statement holds
     * (`data.years` — the active years, which import auto-creates for the history
     * it touches), plus the current one so a fresh database still has something
     * to pick, plus whatever year the arrows have walked into so the picker can
     * always show the year it is actually on. Future years are dropped for the
     * same reason future months are.
     */
    function dashboardYearOptions() {
        const thisYear = new Date().getFullYear();
        const years = new Set([thisYear, dashboardMonth.year]);
        for (const y of (ieData && ieData.years) || []) years.add(y);
        return [...years].filter(y => y <= thisYear).sort((a, b) => b - a);
    }

    function wireMonthStepper() {
        const prev     = document.getElementById('dashboard-month-prev');
        const next     = document.getElementById('dashboard-month-next');
        const monthBtn = document.getElementById('dashboard-month-label');
        const yearBtn  = document.getElementById('dashboard-year-label');
        if (prev) prev.addEventListener('click', () => shiftDashboardMonth(-1));
        if (next) next.addEventListener('click', () => shiftDashboardMonth(1));

        // Every caption each picker can show, sized once: the labels hold that
        // width for good, so stepping from May to September neither moves the
        // arrows nor resizes the menus. Any 4-digit year measures the same (the
        // labels are tabular-nums), so today's stands in for all of them.
        if (monthBtn) UI.lockPickerWidth(monthBtn, MONTHS);
        if (yearBtn)  UI.lockPickerWidth(yearBtn, [String(new Date().getFullYear())]);

        // Two pickers rather than one list of recent months: a single menu can
        // only reasonably carry a year or so of them, which put anything older
        // behind a run of arrow clicks. Year then month reaches any month in the
        // ledger in two clicks, however far back it goes. Both lists are built
        // on open, so they pick up the statement's years once it has loaded.
        if (yearBtn) yearBtn.addEventListener('click', e => {
            e.stopPropagation();
            const items = dashboardYearOptions().map(year => ({
                label: String(year),
                selected: year === dashboardMonth.year,
                // Carrying the month across can land past today (December, then
                // this year) — clamp it to the year's last month, the same place
                // the arrows would have stopped.
                action: () => {
                    const monthIdx = Math.min(dashboardMonth.monthIdx, lastMonthIdxOfYear(year));
                    dashboardMonth = { year, monthIdx };
                    renderMonthSection();
                },
            }));
            UI.openMenu(yearBtn, items);
        });

        if (monthBtn) monthBtn.addEventListener('click', e => {
            e.stopPropagation();
            const last = lastMonthIdxOfYear(dashboardMonth.year);
            const items = [];
            for (let monthIdx = 0; monthIdx <= last; monthIdx++) {
                items.push({
                    label: MONTHS[monthIdx],
                    selected: monthIdx === dashboardMonth.monthIdx,
                    action: () => {
                        dashboardMonth = { year: dashboardMonth.year, monthIdx };
                        renderMonthSection();
                    },
                });
            }
            UI.openMenu(monthBtn, items);
        });
    }

    // ─── Bootstrap ───────────────────────────────────────────────────────────────

    /** Inject loading skeletons into the dashboard's chart and list slots. Shown
     *  only when the data fetch takes longer than the skeletonGuard delay (cold
     *  loads); warm cached loads render content directly with no flash (see
     *  store.js). */
    function showDashboardSkeletons() {
        const fill = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        fill('networth-chart',  UI.skChart(220));
        fill('ie-chart',        UI.skChart(220));
        fill('account-chart',   UI.skChart(220));
        // Fluid, like the ring it replaces (.accounts-pie is a share of the card
        // body, not a fixed 220px) — a fixed-size skeleton overflows the column.
        fill('accounts-pie',    '<div class="skeleton skeleton-circle" style="width:100%;aspect-ratio:1"></div>');
        fill('accounts-legend', UI.skRows(3));
    }

    // ── First run ─────────────────────────────────────────────────────────────
    // On a database with no user data, the dashboard has nothing to render, so it
    // is replaced by a single invitation to import. The check is computed from
    // data (GET /api/onboarding), so it never appears for someone with real
    // history and is never permanently lost — it stops appearing once any data
    // exists, or once the user skips it.
    //
    // Skipping applies immediately and is stored server-side: the ordinary
    // dashboard returns with its per-card empty states, each linking to the
    // matching page.
    async function maybeOfferOnboarding() {
        const hero = document.getElementById('dashboard-firstrun');
        if (!hero || !window.Onboarding) return;

        let state;
        try {
            const r = await apiFetch('/api/onboarding');
            if (!r.ok) return;
            state = await r.json();
        } catch {
            return;   // a failed check must not hide a working dashboard
        }
        if (!state.fresh || state.dismissed) return;

        const setHero = (on) => {
            hero.hidden = !on;
            // Each section carries a scope control; while the hero replaces them
            // those controls would have no data to scope.
            document.querySelectorAll('.dashboard-section')
                .forEach(el => el.classList.toggle('is-preempted', on));
        };
        setHero(true);

        document.getElementById('dashboard-firstrun-skip').addEventListener('click', async () => {
            setHero(false);
            try {
                await apiFetch('/api/app-settings/onboarding_dismissed', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: 'on' }),
                });
            } catch {
                // Worst case the invitation returns next launch; nothing breaks.
            }
        });

        document.getElementById('dashboard-firstrun-start').addEventListener('click', () => {
            Onboarding.start({
                onFinished: ({ imported }) => {
                    setHero(false);
                    if (!imported) return;
                    // A completed import changes every dataset this page holds —
                    // a new account, new transactions, and the Cash Flow cells
                    // computed from them. Reload rather than re-run init(): the
                    // dashboard's wiring (stepper, range picker, Store subscriptions) is
                    // bound once per load and would double up on a second pass.
                    Store.invalidate('balance');
                    Store.invalidate('ie');
                    location.reload();
                },
            });
        });
    }

    // ─── Financial Freedom ───────────────────────────────────────────────────
    // One measurement of the whole ledger (GET /api/financial-freedom): the FI
    // number, 25 x average yearly expenses, and the share of it the Balance
    // Sheet's latest net worth has reached. Two tiles in one card, in the
    // Metrics tab's headline-figure idiom, since that is where the card came
    // from: a per-year version there changed with the report's year picker, and
    // a target that moves with a picker is not a target.
    //
    // Progress is a FILL, not one of the Metrics gauges: a gauge pre-colours the
    // track into good/caution/bad ranges, and progress towards a target has no
    // such ranges, only how much of the way is covered. The fill's length against
    // the track's end IS that reading, so it wears one hue.

    const FI_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** "Mar 2025" from the payload's { year, month } (month 1-12). */
    function fmtAsOf(asOf) {
        if (!asOf || !Number.isInteger(asOf.month) || asOf.month < 1 || asOf.month > 12) return '';
        return `${FI_MONTHS[asOf.month - 1]} ${asOf.year}`;
    }

    /** A 0..1 share as a whole percent ("62%", "-5%"); null → "N/A". */
    function fmtShare(r) {
        return r == null || !Number.isFinite(r) ? 'N/A' : `${Math.round(r * 100)}%`;
    }

    function fiInfo(tip) {
        const t = escapeHtml(tip);
        return `<span class="fc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">i</span>`;
    }

    function fiTile(label, tip, value, extraHtml, sub, { na = false, negative = false } = {}) {
        return `<div class="fi-tile${na ? ' fi-tile-na' : ''}">
            <div class="fi-label">${escapeHtml(label)}${fiInfo(tip)}</div>
            <span class="fi-value${negative ? ' fi-value-negative' : ''}">${escapeHtml(value)}</span>
            ${extraHtml || ''}
            ${sub ? `<span class="fi-sub">${escapeHtml(sub)}</span>` : ''}
        </div>`;
    }

    function renderFreedom(fi) {
        const host = document.getElementById('freedom-body');
        if (!host) return;

        const hasNumber = Number.isFinite(fi.number);
        const n = Array.isArray(fi.yearsAveraged) ? fi.yearsAveraged.length : 0;
        const numberTile = fiTile(
            'FI Number',
            'Your Financial Independence (FI) number: average yearly expenses across your tracked years, multiplied by 25, the amount commonly held to be enough to live on without working. The current year is left out of the average while an earlier full year exists, since it is not finished yet.',
            hasNumber ? fmtValue(fi.number) : 'N/A',
            '',
            hasNumber ? `25 × ${fmtValue(fi.avgExpenses)} average yearly expenses over ${n} year${n === 1 ? '' : 's'}` : '',
            { na: !hasNumber }
        );

        const hasProgress = Number.isFinite(fi.progress);
        const filled = hasProgress ? Math.max(0, Math.min(1, fi.progress)) * 100 : 0;
        const asOf = fmtAsOf(fi.netWorthAsOf);
        const reading = hasProgress
            ? `${fmtShare(fi.progress)} of the FI number reached, net worth ${fmtValue(fi.netWorth)}${asOf ? ` as of ${asOf}` : ''}`
            : 'no value yet';
        const track = `<div class="fi-track" role="img" aria-label="${escapeHtml(`Progress to FI: ${reading}`)}">
            ${hasProgress ? `<span class="fi-fill" style="width:${filled.toFixed(3)}%"></span>` : ''}
        </div>`;
        const progressTile = fiTile(
            'Progress to FI',
            'Net worth from your Balance Sheet (everything you own minus everything you owe), at the latest month with a balance, divided by the FI number. Shows N/A until the Balance Sheet holds a balance and a year holds expenses.',
            fmtShare(fi.progress),
            track,
            Number.isFinite(fi.netWorth) ? `Net worth ${fmtValue(fi.netWorth)}${asOf ? ` as of ${asOf}` : ''}` : '',
            { na: !hasProgress, negative: hasProgress && fi.progress < 0 }
        );

        host.innerHTML = numberTile + progressTile;
    }

    // Requested only once the backend has confirmed the install is licensed.
    // The route is paid, and a 402 raises the activation screen (core/api.js),
    // which must never happen on the Dashboard at launch — so neither the
    // pre-paint hint nor an unanswered check is enough to ask on.
    let freedomLoaded = false;
    async function loadFreedom() {
        if (freedomLoaded || !document.getElementById('freedom-body')) return;
        const tier = window.licenseActions && window.licenseActions.tier ? window.licenseActions.tier() : null;
        if (tier !== 'full') return;
        freedomLoaded = true;
        try {
            const r = await apiFetch('/api/financial-freedom');
            if (!r.ok) { freedomLoaded = false; return; }
            renderFreedom(await r.json());
        } catch {
            freedomLoaded = false;   // a failed card must not hide a working dashboard
        }
    }

    /** Fetch both datasets in parallel and render all dashboard sections. */
    async function init() {
        wireMonthStepper();
        // Kick this off first so the Month to Month section loads alongside the
        // Year to Year charts (its statement fetch is deduped with the one below).
        renderMonthSection();
        const cancelSkeletons = UI.skeletonGuard(showDashboardSkeletons);
        const [balanceData, ieDataFetched] = await Promise.all([fetchBalanceData(), fetchIEData()]);
        cancelSkeletons();
        appData = balanceData;
        ieData  = ieDataFetched;
        renderNetworthSection(appData);
        renderIEChart(ieData);
        wireRangePicker('dashboard-range-btn', 'dashboard-range-menu', range => {
            overtimeRange = range;
            const btn = document.getElementById('dashboard-range-btn');
            if (btn) btn.textContent = RANGE_LABELS[range];
            renderNetworthSection(appData);
            renderIEChart(ieData);
            renderAccountChart();
        });
        renderAccountsPie(appData);
        const firstCol = (appData.columns || [])[0];
        if (firstCol) selectedAccounts.add(firstCol.key);
        renderAccountSelector(appData);
        renderAccountChart();

        // Repaint when a background revalidation lands fresh data (store.js
        // warm path serves the sessionStorage snapshot first, then refetches).
        // Registered after the initial render so the cold-path notify doesn't
        // trigger a redundant second paint.
        Store.subscribe('balance', data => {
            appData = data;
            renderNetworthSection(appData);
            renderAccountsPie(appData);
            renderAccountSelector(appData);
            renderAccountChart();
        });
        Store.subscribe('ie', data => {
            ieData = data;
            renderIEChart(ieData);
        });
    }

    /** Repaint every chart from the data already in hand (no refetch). Charts
     *  bake the --chart-* and --accent-primary tokens into SVG attributes at
     *  draw time, so a theme swap leaves them wearing the old palette. Settings
     *  no longer reloads the page for this, so the modal the user is standing
     *  in stays open. */
    function repaintCharts() {
        if (appData) {
            renderNetworthSection(appData);
            renderAccountsPie(appData);
            // The selector's dots carry their colour inline too, so they need
            // the same repaint as the chart they key.
            renderAccountSelector(appData);
            renderAccountChart();
        }
        if (ieData) renderIEChart(ieData);
        renderMonthSection();
    }

    document.addEventListener('DOMContentLoaded', () => {
        init();
        window.addEventListener('themechange', repaintCharts);
        // Whichever comes first: the license check may have answered before this
        // script ran (then the tier is already known) or may still be in flight
        // (then the event says when).
        loadFreedom();
        window.addEventListener('aventurine:license-tier', loadFreedom);
        window.addEventListener('currencychange', () => {
            if (freedomLoaded) { freedomLoaded = false; loadFreedom(); }
        });
        // Runs alongside the dashboard load, not before it: the hero appears once
        // the check resolves, and a database with data never waits on it. Bound
        // once per page load (init() is not re-entered — see above).
        maybeOfferOnboarding();
    });
}());
