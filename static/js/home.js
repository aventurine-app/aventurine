// ─── Home dashboard ──────────────────────────────────────────────────────────
// Renders five sections on the homepage:
//   1. Net worth over time (line chart from balance data)
//   2. Accounts breakdown (donut by account type, current month)
//   3. Income & Expenses monthly totals (line chart)
//   4. Per-account balances (line chart, user picks which accounts to compare)
//   5. Upcoming Expenses (predicted recurring spends from the transactions ledger)
// All charts are built as inline SVG by hand — no chart library. The
// ResizeObserver-based observeChart() helper redraws on container resize.

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i]));

// escapeHtml is a global from escape.js (loaded by base.html). All
// user-controlled label values go through it before innerHTML interpolation.
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const _RE_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

const ACCOUNT_COLORS = [
    'rgba(120,185,255,0.9)',
    'rgba(100,210,140,0.9)',
    'rgba(255,165,80,0.9)',
    'rgba(180,130,255,0.9)',
    'rgba(255,120,170,0.9)',
    'rgba(255,210,80,0.9)',
    'rgba(80,210,200,0.9)',
    'rgba(255,100,100,0.9)',
];

/** Find the most recent (year, month) entry across the dataset. */
function findMostRecentPoint(entries) {
    let bestYear = null, bestMonthIdx = -1;
    for (const [yearStr, months] of Object.entries(entries)) {
        const year = parseInt(yearStr);
        for (const month of Object.keys(months)) {
            const idx = MONTH_INDEX.get(month);
            if (idx === undefined) continue;
            if (bestYear === null || year > bestYear || (year === bestYear && idx > bestMonthIdx)) {
                bestYear = year;
                bestMonthIdx = idx;
            }
        }
    }
    return bestYear !== null ? { year: bestYear, month: MONTHS[bestMonthIdx] } : null;
}

/**
 * Last-observation-carried-forward snapshot of the balance sheet: for each
 * account column, the value from the most recent month it was actually
 * filled in. A balance carries forward until the user enters a newer one, so
 * a row that only updates one account doesn't blank out the rest of the pie.
 * Returns a { key: value } map over the latest known value per column.
 */
function latestValueByColumn(entries) {
    const latest = {};   // key -> { year, monthIdx, value }
    for (const [yearStr, months] of Object.entries(entries)) {
        const year = parseInt(yearStr);
        for (const [month, cats] of Object.entries(months)) {
            const idx = MONTH_INDEX.get(month);
            if (idx === undefined) continue;
            for (const [key, val] of Object.entries(cats)) {
                const prev = latest[key];
                if (!prev || year > prev.year || (year === prev.year && idx > prev.monthIdx)) {
                    latest[key] = { year, monthIdx: idx, value: val };
                }
            }
        }
    }
    const out = {};
    for (const [key, rec] of Object.entries(latest)) out[key] = rec.value;
    return out;
}

// Uses CURRENCY_SYMBOL from currency.js (loaded globally in base.html).
// Read at call time so a user changing the symbol in Settings is reflected
// on the next render without a full reload of this script.
function fmtValue(n) {
    if (n === null) return '—';
    const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
    const sign = n < 0 ? '-' : '';
    return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
}

// ─── Accounts pie ────────────────────────────────────────────────────────────
// Single donut summarising the balance sheet at its latest known state. One
// slice per account type — Investments, Cash, Retirement, Debt — sized by
// the sum of each column's most recent value (carried forward via
// latestValueByColumn, so a partially-filled latest month doesn't blank out
// accounts that were only updated in an earlier month). Debt is shown as its absolute
// magnitude so the slice has visible area; the colour (--accent-tertiary) flags it
// as a liability rather than an asset.

/** Pull the four accent colours from the theme so a palette swap retones
 *  the pie alongside the rest of the chrome. */
function getAccountsPieColors() {
    const cs = getComputedStyle(document.documentElement);
    const v  = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
        cash:       v('--accent-primary', '#7C8F4A'),
        investment: v('--accent400', '#94AB5B'),
        retirement: v('--accent300', '#B1BF7A'),
        debt:       v('--accent-tertiary',    '#e2585b'),
    };
}

function renderAccountsPie(data) {
    const pieEl    = document.getElementById('accounts-pie');
    const legendEl = document.getElementById('accounts-legend');
    if (!pieEl || !legendEl) return;

    const entries = data.entries || {};
    const columns = data.columns || [];
    const recent  = findMostRecentPoint(entries);

    if (!recent) {
        pieEl.style.display = 'none';
        pieEl.innerHTML = '';
        legendEl.innerHTML = UI.emptyState({
            icon: 'donut', compact: true,
            title: 'No capital to show yet',
            desc: 'Add your account balances and Oliv will chart how your assets and debts split.',
            action: { label: 'Add balances', href: '/balance-sheet', icon: 'plus', primary: true },
        });
        return;
    }

    pieEl.style.display = '';
    const curr = latestValueByColumn(entries);
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
            icon: 'donut', compact: true,
            title: 'All balances are zero',
            desc: 'Enter some non-zero account balances to see your capital profile.',
        });
        return;
    }

    // Segmented stroke ring: each slice is a circle stroke with a dash the
    // length of its arc, rotated to start at 12 o'clock. Small gaps between
    // segments give the modern "broken ring" look, and stroke dashes can be
    // transitioned, which is what drives the sweep-in animation below.
    const size = 280, cx = size / 2, cy = size / 2;
    const sw   = 34;                              // ring thickness
    const r    = (size - sw) / 2 - 2;
    const C    = 2 * Math.PI * r;
    const gap  = slices.length > 1 ? 3 : 0;       // no gap on a lone slice
    const f2   = (n) => Math.round(n * 100) / 100;

    let acc = 0;
    const arcs = slices.map((s, i) => {
        const len   = Math.max((s.value / total) * C - gap, 1.5);
        const start = (acc / total) * C + gap / 2;
        acc += s.value;
        // Arcs render at zero length (dasharray "0 C") and transition to
        // data-dash after insertion — a staggered clockwise sweep. The
        // transition is inline because the per-arc stagger delay must only
        // apply to the dash, never to the opacity hover (home.css §6).
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
        return `<div class="accounts-legend-item">
            <span class="accounts-legend-dot" style="background:${s.color}"></span>
            <div class="accounts-legend-text">
                <div class="accounts-legend-label">${s.label}</div>
                <div class="accounts-legend-value">${fmtValue(s.signed)}</div>
            </div>
            <div class="accounts-legend-pct">${pct.toFixed(1)}%</div>
        </div>`;
    }).join('');
}

// Both datasets flow through Store (store.js) so navigating away from Home
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
 * to that single entry — the same carry-forward the Capital Profile pie uses
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
 * Pick 3-5 "nice" tick values that cover [min, max] using only 1, 2, or 5
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

function fmtAxis(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1_000_000) return sign + CURRENCY_SYMBOL + (abs / 1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000)     return sign + CURRENCY_SYMBOL + (abs / 1_000).toFixed(0) + 'K';
    return sign + CURRENCY_SYMBOL + abs.toFixed(0);
}

function fmtTooltip(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const [intPart, decPart] = abs.toFixed(2).split('.');
    return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
}

// ─── Hand-rolled SVG line chart ──────────────────────────────────────────────
// One unified renderer for every line chart on the page (Net Worth, Income &
// Expenses, Account Balances) so they all share an identical frame: same
// gutters, same nice-tick Y axis, same dashed grid, same label typography,
// same entrance animation. Lines render as smoothed bezier curves with a
// soft gradient fill underneath; frame chrome (grid/labels) uses theme
// variables so the charts retone with the palette and stay legible in the
// light theme. Animation keyframes live in home.css §10.

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
        // Tension 1/6 — the classic Catmull-Rom pass-through conversion.
        d += ` C ${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)},`
           + ` ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)},`
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
    const yTicks = niceTicks(Math.min(...allValues), Math.max(...allValues), 4);
    const minVal = yTicks[0];
    const maxVal = yTicks[yTicks.length - 1];
    const valRange = maxVal - minVal || 1;

    const xScale = i => PL + (i / (N - 1 || 1)) * CW;
    const yScale = v => PT + CH - ((v - minVal) / valRange) * CH;

    // Unique id per render so multiple charts on the page never collide
    // on the area-fill linearGradient ids.
    const rnd = Math.random().toString(36).slice(2, 9);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="home-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    // Horizontal grid + Y labels (right-aligned in the left gutter).
    // Styling lives in home.css (.chart-grid / .chart-label) so the frame
    // chrome follows the theme instead of hard-coded dark-mode rgba values.
    for (const v of yTicks) {
        const y = yScale(v);
        svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
        svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtAxis(v)}</text>`;
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
 * user-driven re-renders like the range picker or account toggles, which
 * call observeChart again); pure window resizes re-render without the
 * entrance so the chart doesn't strobe while dragging. The width guard
 * also swallows the ResizeObserver's immediate same-size callback, which
 * would otherwise cancel the entrance animation one frame in.
 */
function observeChart(containerId, renderFn) {
    const existing = chartObservers.get(containerId);
    if (existing) existing.disconnect();
    const el = document.getElementById(containerId);
    if (!el) return;
    // Observe the parent so shrinking the window triggers a re-render —
    // the chart div itself can't shrink below the SVG it already contains.
    const target = el.parentElement || el;

    let animate     = true;   // flips off after the first successful paint
    let lastW       = 0;
    let sawInitial  = false;  // has the observer delivered its first callback?
    const render = (w) => {
        w = Math.round(w);
        if (w > 0 && w !== lastW) {
            lastW = w;
            el.innerHTML = renderFn(w, animate) || '';
            animate = false;
        }
    };

    const obs = new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        // A ResizeObserver always fires once immediately after observe().
        // If the synchronous paint below already ran (animate is now false),
        // that first callback is synthetic, not a real resize — adopt its
        // content-box width as the baseline and return WITHOUT repainting,
        // so the entrance animation isn't cancelled a frame in. We can't tell
        // this apart by width alone: the sync paint uses clientWidth, this
        // reports contentRect.width, and a layout shift in between (e.g. the
        // page scrollbar appearing as other cards populate) makes them differ.
        if (!sawInitial) {
            sawInitial = true;
            if (!animate) { lastW = w; return; }
        }
        render(w);
    });
    obs.observe(target);
    chartObservers.set(containerId, obs);
    // Immediate first paint (animated). If layout isn't ready yet (width 0),
    // the observer's first callback above performs the animated paint instead.
    render(target.clientWidth);
}

// ─── Net worth section (summary + range-picker + chart) ─────────────────────
//
// The Net Worth card owns its own state machine: a single string telling us
// which time window to display. Changing the range re-derives the chart
// slots, the filtered points, and the % change shown in the summary block.
//
// Ranges:
//   year — January through the current month of the current calendar year.
//          Change = year-to-date.
//   12mo — trailing 12 months ending on the current month. Change = 12-month.
//   24mo — trailing 24 months ending on the current month. Change = 24-month.
//   5yr  — trailing 60 months ending on the current month. Change = 5-year.

let networthRange = 'year';

const RANGE_LABELS = {
    year: 'This Year',
    '12mo': 'Last 12 Months',
    '24mo': 'Last 24 Months',
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
    const slots = getRangeSlots(networthRange);
    const filtered = filterPointsToSlots(all.points, slots);

    const valueEl  = document.getElementById('networth-value');
    const changeEl = document.getElementById('networth-change');
    const btnEl    = document.getElementById('networth-range-btn');

    if (btnEl) btnEl.textContent = RANGE_LABELS[networthRange];

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

    if (filtered.length === 0) {
        container.innerHTML = all.points.length === 0
            ? UI.emptyState({
                icon: 'chart',
                title: 'No net worth to chart yet',
                desc: 'Track your account balances and Oliv will plot your net worth over time.',
                action: { label: 'Add balances', href: '/balance-sheet', icon: 'plus', primary: true },
            })
            : UI.emptyState({
                icon: 'search', compact: true,
                title: 'Nothing in this range',
                desc: 'There’s no balance data for the selected period — try a longer range.',
            });
        return;
    }

    // Read --accent-primary from the theme so the line, gradient, and nodes
    // retone with the chrome when the palette in style.css changes.
    const accentColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-primary').trim() || '#7c8f4a';
    const series = [{ label: 'Net Worth', color: accentColor, points: filtered }];

    observeChart('networth-chart', (W, animate) => buildChartSVG({ series, slots, W, animate }));
}

/** Wire a range-picker button + dropdown (Net Worth, Income & Expenses, and
 *  Account Balances each have one). `onSelect` receives the chosen range key
 *  and re-renders its section. The outer click handler closes the dropdown
 *  when the user clicks anywhere else. */
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

/** Pull income/expense colours from the theme so a palette swap retones the
 *  chart alongside the rest of the chrome. Income tracks the primary accent
 *  (favourable direction); expenses share --accent-tertiary with delta indicators. */
function getIEColors() {
    const cs = getComputedStyle(document.documentElement);
    const v  = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
        income:   v('--accent-primary', '#7C8F4A'),
        expenses: v('--accent-tertiary',    '#e2585b'),
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
let ieRange = 'year';
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
        return `<button class="account-toggle ${active}" data-series="${s.label}">
            <span class="account-toggle-dot" style="background:${s.color}"></span>
            ${s.label}
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

    const btnEl = document.getElementById('ie-range-btn');
    if (btnEl) btnEl.textContent = RANGE_LABELS[ieRange];

    const series = computeIESeries(data);
    const hasAnyData = series.some(s => s.points.length > 0);

    if (!hasAnyData) {
        container.innerHTML = UI.emptyState({
            icon: 'wallet',
            title: 'No income or expenses yet',
            desc: 'Add your monthly income and expense figures to chart your cash flow.',
            action: { label: 'Open Cash Flow', href: '/income-expenses', icon: 'plus', primary: true },
        });
        const selEl = document.getElementById('ie-selector');
        if (selEl) selEl.innerHTML = '';
        chartObservers.get('ie-chart')?.disconnect();
        return;
    }

    renderIESelector(series);

    // Same windowing as Net Worth: build the slot list for the selected
    // range and drop points outside it so the Y axis scales to the window.
    const slots = getRangeSlots(ieRange);
    const visible = series
        .filter(s => !ieHidden.has(s.label))
        .map(s => ({ ...s, points: filterPointsToSlots(s.points, slots) }));

    if (visible.length === 0) {
        container.innerHTML = UI.emptyState({
            icon: 'chart', compact: true,
            title: 'Nothing selected',
            desc: 'Pick Income or Expenses above to plot it.',
        });
        chartObservers.get('ie-chart')?.disconnect();
        return;
    }
    if (!visible.some(s => s.points.length > 0)) {
        container.innerHTML = UI.emptyState({
            icon: 'search', compact: true,
            title: 'Nothing in this range',
            desc: 'Try a longer range to see your cash flow.',
        });
        chartObservers.get('ie-chart')?.disconnect();
        return;
    }

    observeChart('ie-chart', (W, animate) => buildChartSVG({ series: visible, slots, W, animate }));
}

let appData = null;
let selectedAccounts = new Set();
let accountRange = 'year';

function buildColorMap(columns) {
    return new Map((columns || []).map((c, i) => [c.key, ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]]));
}

function renderAccountChart() {
    const container = document.getElementById('account-chart');
    if (!container || !appData) return;

    const btnEl = document.getElementById('account-range-btn');
    if (btnEl) btnEl.textContent = RANGE_LABELS[accountRange];

    const keys = [...selectedAccounts];
    if (keys.length === 0) {
        container.innerHTML = UI.emptyState({
            icon: 'chart', compact: true,
            title: 'Nothing selected',
            desc: 'Pick an account above to compare balances over time.',
        });
        chartObservers.get('account-chart')?.disconnect();
        return;
    }

    // Same windowing as Net Worth: build the slot list for the selected
    // range and drop points outside it so the Y axis scales to the window.
    const slots = getRangeSlots(accountRange);
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
            icon: 'search', compact: true,
            title: 'Nothing in this range',
            desc: 'These accounts have no balances in the selected period.',
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

// ─── Upcoming expenses (recurring-spend predictions) ─────────────────────────
// The detection itself is in the backend (electron/backend/services/predictions.js): the ledger
// is scanned for regular charges and the next one per merchant is projected.
// This card just fetches /api/predictions/upcoming and renders the list.

const CYCLE_LABELS = {
    weekly:    'Weekly',
    biweekly:  'Every 2 weeks',
    monthly:   'Monthly',
    quarterly: 'Quarterly',
    yearly:    'Yearly',
};

/** Human "Due …" string for a prediction. The T00:00:00 suffix forces
 *  local-time parsing — a bare ISO date parses as UTC and can shift a day
 *  backwards in western timezones. */
function fmtDueLabel(item) {
    if (item.due_in_days <= 0) return 'Due now';
    if (item.due_in_days === 1) return 'Due tomorrow';
    const d = new Date(item.next_date + 'T00:00:00');
    return `Due ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Fetch and render the Upcoming Expenses card. Failures and empty results
 * both fall through to a quiet empty state — a brand-new ledger simply has
 * no patterns yet, which isn't an error worth surfacing.
 *
 * SECURITY: item.description comes straight from user transaction data and
 * passes through escapeHtml before innerHTML interpolation.
 */
async function renderUpcomingExpenses() {
    const el = document.getElementById('upcoming-list');
    if (!el) return;
    const cancelSkeleton = UI.skeletonGuard(() => { el.innerHTML = UI.skRows(3); });

    let items = [];
    try {
        const res = await apiFetch('/api/predictions/upcoming');
        if (res.ok) items = (await res.json()).upcoming || [];
    } catch (e) {
        // Network hiccup — fall through to the empty state.
    }
    cancelSkeleton();

    if (items.length === 0) {
        el.innerHTML = UI.emptyState({
            icon: 'calendar', compact: true,
            title: 'No upcoming expenses yet',
            desc: 'Oliv flags recurring charges automatically once it sees a few months of transactions.',
            action: { label: 'Add transactions', href: '/transactions', icon: 'plus' },
        });
        return;
    }

    el.innerHTML = items.map(item => {
        const dueClass = item.due_in_days <= 0 ? ' upcoming-due-now' : '';
        return `<div class="upcoming-item">
            <div class="upcoming-text">
                <div class="upcoming-name">${escapeHtml(item.description)}</div>
                <div class="upcoming-meta">
                    <span>${CYCLE_LABELS[item.cycle] || escapeHtml(item.cycle)}</span>
                    <span class="upcoming-due${dueClass}">${fmtDueLabel(item)}</span>
                </div>
            </div>
            <div class="upcoming-amount">${fmtValue(item.amount)}</div>
        </div>`;
    }).join('');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/** Inject loading skeletons into the dashboard's chart and list slots. Shown
 *  only when the data fetch outlasts the skeletonGuard delay (cold loads);
 *  warm cached loads render straight to content with no flash (see store.js). */
function showHomeSkeletons() {
    const fill = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    fill('networth-chart',  UI.skChart(220));
    fill('ie-chart',        UI.skChart(220));
    fill('account-chart',   UI.skChart(220));
    fill('accounts-pie',    '<div class="skeleton skeleton-circle" style="width:200px;height:200px"></div>');
    fill('accounts-legend', UI.skRows(3));
}

/** Fetch both datasets in parallel and render all dashboard sections. */
async function init() {
    // Independent fetch — kick it off first so it loads alongside the charts.
    renderUpcomingExpenses();
    const cancelSkeletons = UI.skeletonGuard(showHomeSkeletons);
    const [balanceData, ieDataFetched] = await Promise.all([fetchBalanceData(), fetchIEData()]);
    cancelSkeletons();
    appData = balanceData;
    ieData  = ieDataFetched;
    renderNetworthSection(appData);
    renderIEChart(ieData);
    wireRangePicker('networth-range-btn', 'networth-range-menu', range => {
        networthRange = range;
        renderNetworthSection(appData);
    });
    wireRangePicker('ie-range-btn', 'ie-range-menu', range => {
        ieRange = range;
        renderIEChart(ieData);
    });
    wireRangePicker('account-range-btn', 'account-range-menu', range => {
        accountRange = range;
        renderAccountChart();
    });
    renderAccountsPie(appData);
    const firstCol = (appData.columns || [])[0];
    if (firstCol) selectedAccounts.add(firstCol.key);
    renderAccountSelector(appData);
    renderAccountChart();
}

document.addEventListener('DOMContentLoaded', init);
