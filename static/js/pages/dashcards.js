'use strict';

// ─── dashcards.js ─────────────────────────────────────────────────────────────
// The Dashboard's cards: what each widget type is called, which periods it
// offers, the sizes it comes in, the settings it has, how it loads its data and
// how it draws itself into the box the grid gives it. pages/dashboard.js places
// the cards and runs the page (layouts, Customize, the period picker); nothing
// in this file knows about the grid, edit mode or saving.
//
// A CARD DEFINITION (DashCards.TYPES[type]):
//   name, group, info      label, widget-list group, the header's "i" tip
//   periods, period        the presets it offers (widgets/dashperiod.js) and
//                          the spec a new card starts with
//   sizes, min             S/M/L/XL presets and the minimum, as [columns, rows]
//   defaults, fields       its settings, and the segmented choices for them
//                          that the header gear offers
//   gear                   a checkbox list in the header gear (Account
//                          Balances only), once its data has entries:
//                          { title, label, heading, options(ctx),
//                            toggle(ctx, key) → settings patch, available(ctx) }
//   chip(ctx, key)         → the settings patch for a click on one of its chips
//   uses                   the Store datasets it reads, so a background refresh
//                          of one redraws exactly the cards that read it
//   skeleton               'rows' for a list-shaped loading placeholder
//   load(ctx)              → Promise of the data it needs for its period
//   render(host, ctx)      draws into `host`, which is ctx.w × ctx.h pixels
//
// ctx is { card, period, data, w, h, animate, hub }: the stored card, its
// resolved period (DashPeriod.resolve), the loaded data, the box, whether this
// paint is an entrance, and the data hub (dashboard.js), whose store(name) and
// json(url) a card's load() reads through. load() gets { card, period, hub }.
// The widget list's schematic of each type is THUMBS, below.
//
// EVERY CARD IS DRAWN FOR A BOX, NOT FOR A PAGE. A card is as large as the user
// sized it on the grid, so each renderer reads ctx.w and ctx.h and decides what
// fits: the charts take the box's height exactly (FinanceChart's `fit`), and the
// lists show as many rows as there is room for.
//
// SECURITY: category, account and merchant names, transaction descriptions and
// card titles are user-controlled. Every one passes through escapeHtml before it
// reaches markup, and the chart reading builds its rows with textContent.

(function () {
    const MONTHS = DashPeriod.MONTH_NAMES;
    const MONTHS_ABBR = DashPeriod.MONTH_SHORT;
    const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i]));

    // ─── Shared helpers ──────────────────────────────────────────────────────

    // CURRENCY_SYMBOL and the number format are read at call time inside
    // formatCurrency (currency.js), so a change in Settings shows on the next
    // draw without a reload.
    const fmtValue = (n) => (n === null || n === undefined ? '—' : formatCurrency(n, true));

    function readRamp(prefix, fallbacks) {
        const cs = getComputedStyle(document.documentElement);
        return fallbacks.map((fb, i) => cs.getPropertyValue(`${prefix}${i + 1}`).trim() || fb);
    }
    const readToken = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    // The BALANCE ramp: eight grey steps (style.css). The Balances donut takes
    // three of them and the Account Balances chart walks all eight, one per
    // account, so a line in that chart is the same family of colour as its slice
    // in the donut. Grey is what an account BALANCE is in this app: money held
    // still, as against green arriving and gold leaving. Read at use time so a
    // theme or palette swap retones both; the array is a first-paint fallback.
    const BALANCE_FALLBACK = ['#4e5153', '#5c5f61', '#6a6d70', '#787b7e', '#878a8d', '#989b9e', '#a9acaf', '#bcbfc2'];
    const INFLOW_FALLBACK = ['#0a5b47', '#10744c', '#1a8b52', '#2ba25b', '#48b76b', '#72c983'];

    /** Every month in a period as { year, monthIdx }, first to last. */
    const slotsOf = (period) => period.slots || [];
    const slotKey = (s) => `${s.year}-${s.monthIdx}`;
    const pad2 = (n) => String(n).padStart(2, '0');
    const isoMonth = (s) => `${s.year}-${pad2(s.monthIdx + 1)}`;
    const lastDayOf = (s) => new Date(s.year, s.monthIdx + 1, 0).getDate();

    /** The ISO dates a month or range spans, both included. */
    function periodDates(period) {
        const a = period.first, b = period.last;
        return { from: `${isoMonth(a)}-01`, to: `${isoMonth(b)}-${pad2(lastDayOf(b))}` };
    }

    /**
     * Deep link into the Transactions ledger for the card's period, optionally
     * narrowed to one category or merchant. A single month keeps Cash Flow's
     * year+month shorthand (the Sankey's link, cashflow-sankey.js); a span of
     * months sends the from/to pair the ledger writes itself. `cat` is the stable
     * category key, so the link survives a rename.
     */
    function ledgerHref(period, { cat, name } = {}) {
        const q = new URLSearchParams();
        if (period.slots.length === 1) {
            q.set('year', String(period.first.year));
            q.set('month', String(period.first.monthIdx + 1));
        } else {
            const { from, to } = periodDates(period);
            q.set('from', from);
            q.set('to', to);
        }
        if (cat) q.set('cat', cat);
        if (name) q.set('name', name);
        return `/transactions?${q}`;
    }

    /**
     * The Cash Flow statement summed over a period: column key → total of its
     * cells across every month of the period. The statement is the blend point
     * (synced cells are computed from transactions, the rest are hand-entered),
     * so the cards that read it light up for import users and manual bookkeepers
     * alike. Months with no cells add nothing.
     */
    function statementTotals(data, slots) {
        const byKey = new Map();
        for (const s of slots) {
            const cells = ((data.entries || {})[String(s.year)] || {})[MONTHS[s.monthIdx]] || {};
            for (const [key, val] of Object.entries(cells)) {
                if (typeof val === 'number') byKey.set(key, (byKey.get(key) || 0) + val);
            }
        }
        return byKey;
    }

    /**
     * A period's statement, sliced the way the month cards read it: per-type
     * totals, each type's categories (positive cells only, in column order) and
     * the expense categories alone. `divisor` turns the totals into a monthly
     * average, which is how Monthly Cash Flow reads a span of months.
     */
    function sliceStatement(data, slots, divisor = 1) {
        const byKey = statementTotals(data, slots);
        const totals = { income: 0, expense: 0, transfer: 0 };
        const segments = { income: [], expense: [], transfer: [] };
        const categories = [];
        for (const col of data.columns || []) {
            const raw = byKey.get(col.key);
            if (typeof raw !== 'number') continue;
            const val = raw / divisor;
            if (col.type in totals) {
                totals[col.type] += val;
                if (val > 0) segments[col.type].push({ key: col.key, name: col.label, value: val });
            }
            if (col.type === 'expense' && val > 0) categories.push({ key: col.key, name: col.label, total: val });
        }
        return { totals, segments, categories };
    }

    /**
     * Category key → colour, for one period's flow segments. Expenses take the
     * gold ramp and income the green one, both assigned by AMOUNT rank rather
     * than by statement order: the rule the Sankey's bands follow, and what the
     * outflow ramp was stepped for, since it grades magnitude. Transfers get no
     * entry; their bar is drawn in --chart-transfer with the shade fade below.
     * More categories than steps wraps the ramp, and the bars are labelled and
     * carry a tooltip, so colour is never the only thing separating them.
     */
    function buildFlowColorMap(segments) {
        const map = new Map();
        const assign = (list, ramp) => {
            [...(list || [])].sort((a, b) => b.value - a.value)
                .forEach((seg, i) => map.set(seg.key, ramp[i % ramp.length]));
        };
        assign(segments && segments.expense, ChartRamp.outflow());
        assign(segments && segments.income, readRamp('--chart-inflow-', INFLOW_FALLBACK));
        return map;
    }

    /**
     * Last-observation-carried-forward snapshot of the balance sheet: for each
     * account column, the value from the most recent month it was filled in, at
     * or before `cutoff` ({ year, monthIdx }, optional). A balance carries forward
     * until the user enters a newer one, so a month that updates one account does
     * not blank out the rest.
     */
    function latestValueByColumn(entries, cutoff) {
        const cutoffT = cutoff ? cutoff.year * 12 + cutoff.monthIdx : Infinity;
        const latest = {};
        for (const [yearStr, months] of Object.entries(entries || {})) {
            const year = parseInt(yearStr, 10);
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

    /**
     * Net worth over every populated month, oldest first: { year, monthIdx,
     * value }. Debt columns count negative. Each month carries every column's
     * most recent value forward (the same carry-forward the Balances donut uses),
     * so a month that updates one account still reports net worth across all of
     * them. A column contributes nothing until its first entry.
     */
    function computeNetWorth(data) {
        const columns = data.columns || [];
        const debtKeys = new Set(columns.filter((c) => c.type === 'debt').map((c) => c.key));
        const months = [];
        for (const year of (data.years || []).slice().sort((a, b) => a - b)) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const idx = MONTH_INDEX.get(month);
                if (idx !== undefined) months.push({ year, monthIdx: idx, cats });
            }
        }
        months.sort((a, b) => a.year - b.year || a.monthIdx - b.monthIdx);
        const latest = {};
        return months.map(({ year, monthIdx, cats }) => {
            Object.assign(latest, cats);
            let total = 0;
            for (const [key, val] of Object.entries(latest)) total += debtKeys.has(key) ? -val : val;
            return { year, monthIdx, value: total };
        });
    }

    /** Keep only the points that fall in the period's months. */
    function inSlots(points, slots) {
        const allowed = new Set(slots.map(slotKey));
        return points.filter((p) => allowed.has(slotKey(p)));
    }

    /** First-to-last change across the points: null with fewer than two, or a
     *  base of 0 (where a percentage would be undefined). */
    function rangeChange(points) {
        if (points.length < 2) return null;
        const first = points[0].value, last = points[points.length - 1].value;
        if (first === 0) return null;
        return { delta: last - first, pct: ((last - first) / Math.abs(first)) * 100 };
    }

    // ─── Selector chips ──────────────────────────────────────────────────────
    // The Income & Expenses and Account Balances chips wear their series colour:
    // a border in it whether the series is on or off, the same colour as the fill
    // once it is on. --pill-ink is the ink that reads on that fill, picked from
    // its luminance, since the ramp runs dark to light.

    /** [r, g, b] from a #hex, rgb() or color(srgb) colour, else null. */
    function pillRgb(color) {
        const text = String(color || '').trim();
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
        if (hex) {
            let h = hex[1];
            if (h.length === 3) h = h.split('').map((c) => c + c).join('');
            return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        }
        const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
        if (rgb) {
            const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
            if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
        }
        // A token built with color-mix() computes to color(srgb r g b), 0-1 channels.
        const srgb = /^color\(\s*srgb\s+([^)]+)\)$/i.exec(text);
        if (srgb) {
            const parts = srgb[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map(Number);
            if (parts.length === 3 && parts.every(Number.isFinite)) return parts.map((v) => v * 255);
        }
        return null;
    }

    /** The colour a value paints as: tokens like --chart-income are var() text,
     *  not colours, so the value is put on a probe element and read back. */
    let pillProbe = null;
    function pillResolve(color) {
        if (!pillProbe) {
            pillProbe = document.createElement('span');
            pillProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
            document.body.appendChild(pillProbe);
        }
        pillProbe.style.color = '';
        pillProbe.style.color = color;
        return getComputedStyle(pillProbe).color || color;
    }

    function pillStyle(color) {
        if (!color) return '';
        const rgb = pillRgb(pillResolve(color));
        let ink = '';
        if (rgb) {
            const lin = rgb.map((v) => {
                const c = v / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
            ink = `--pill-ink:${L > 0.4 ? 'var(--text-primary)' : '#fff'};`;
        }
        return escapeHtml(`--pill-color:${color};${ink}`);
    }

    const chipsHtml = (chips) => `<div class="account-selector">${chips.map((c) =>
        `<button type="button" class="account-toggle${c.on ? ' active' : ''}" data-chip="${escapeHtml(c.key)}"
            aria-pressed="${c.on}" style="${pillStyle(c.color)}">${escapeHtml(c.label)}</button>`).join('')}</div>`;

    // ─── Chart frame ─────────────────────────────────────────────────────────
    // The line charts are FinanceChart.buildLine (widgets/chart.js), the
    // renderer every line chart in the app shares; `fit` makes one take its
    // card's height exactly. The bar charts below share its frame (pad, dashed
    // grid, nice-tick axis, label type) so a card of each reads as one family.
    const CHART_PAD = { l: 56, r: 20, t: 18, b: 30 };

    const lineChart = (series, slots, W, H, animate) =>
        FinanceChart.buildLine({ series, slots, W, boxH: H, fit: true, animate, centred: true, hover: true });

    /** Wrap one bar in a link to its category's transactions for the period.
     *  A bare bar (the transfer fallback row) has no key and stays inert. */
    function linkShape(period, key, label, value, markup) {
        if (!key) return markup;
        const aria = `${label}: ${fmtValue(value)} — view transactions for ${period.label}`;
        return `<a class="chart-link" href="${escapeHtml(ledgerHref(period, { cat: key }))}"`
             + ` tabindex="0" role="link" aria-label="${escapeHtml(aria)}">${markup}</a>`;
    }

    /**
     * Share `total` px out between `values` in proportion, but never let a
     * segment fall below `minW`: a category worth 0.3% of a month is otherwise a
     * two-pixel sliver nobody can hover. Slivers are raised to the floor and the
     * surplus is taken back from the segments with room above it, so the bar's
     * total length still lands exactly on its value. When the bar is too short to
     * give everyone the floor it splits evenly: at that size it is a total, not
     * a breakdown.
     */
    function allocateSegmentWidths(values, total, minW) {
        const n = values.length;
        if (n === 0) return [];
        if (n * minW >= total) return values.map(() => total / n);
        const sum = values.reduce((a, b) => a + b, 0) || 1;
        const widths = values.map((v) => (v / sum) * total);
        let deficit = 0;
        const raised = widths.map((w) => {
            if (w >= minW) return false;
            deficit += minW - w;
            return true;
        });
        if (deficit === 0) return widths;
        let room = 0;
        widths.forEach((w, i) => { if (!raised[i]) room += w - minW; });
        const scale = room > 0 ? (room - deficit) / room : 0;
        return widths.map((w, i) => (raised[i] ? minW : minW + (w - minW) * scale));
    }

    /** The j-th of n segments in one bar: the base colour nearest the axis,
     *  fading toward the page outward. Only the transfer row reaches this, since
     *  income and expense segments paint from the flow ramps instead. */
    function segmentShade(base, j, n) {
        if (n <= 1) return base;
        const pct = Math.round(100 - (j / (n - 1)) * 45);
        return `color-mix(in srgb, ${base} ${pct}%, var(--background))`;
    }

    /**
     * Horizontal bars, one row per flow type, each split into its categories:
     *   rows: [{ label, color, value, segments: [{ key, name, value, color? }] }]
     * Height is the box's: the bands share it out, and bar thickness follows
     * only part of the way, so a tall card gets an airy chart, not three slabs.
     */
    function buildHBarChartSVG({ rows, W, avail, animate, period }) {
        if (rows.length === 0) return null;
        const PL = 96, PR = 96, PT = 8, PB = 30;
        const BAND = Math.max(28, Math.round((avail - PT - PB) / rows.length));
        const BAR = Math.round(Math.min(34, BAND * 0.36));
        const H = PT + rows.length * BAND + PB;
        const CW = W - PL - PR;
        const f2 = (n) => Math.round(n * 100) / 100;
        const peak = Math.max(...rows.map((r) => r.value));
        const xTicks = ChartMath.niceTicks(0, peak, 4);
        const maxVal = xTicks[xTicks.length - 1] || 1;
        const xScale = (v) => PL + (v / maxVal) * CW;
        const plotBottom = PT + rows.length * BAND;

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;
        const fmtAxis = axisFormatter(xTicks);
        for (const v of xTicks) {
            const x = xScale(v);
            svg += `<line class="chart-grid" x1="${f2(x)}" y1="${PT}" x2="${f2(x)}" y2="${plotBottom}"/>`;
            svg += `<text class="chart-label" x="${f2(x)}" y="${plotBottom + 18}" text-anchor="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }
        // Rounded right end only: the bar sits flat on the axis.
        const RR = Math.min(BAR / 4, 6);
        rows.forEach((r, i) => {
            const yMid = PT + BAND * (i + 0.5);
            const y = yMid - BAR / 2;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(yMid)}" text-anchor="end" dominant-baseline="middle">${escapeHtml(r.label)}</text>`;
            const len = xScale(r.value) - PL;
            const segs = (r.segments && r.segments.length) ? r.segments
                : (r.value > 0 ? [{ name: r.label, value: r.value }] : []);
            if (len > 0) {
                const widths = allocateSegmentWidths(segs.map((sg) => sg.value), len, 8);
                let x0 = PL;
                segs.forEach((seg, j) => {
                    const xe = x0 + widths[j];
                    const w = xe - x0;
                    const last = j === segs.length - 1;
                    // Every segment but the last runs half a pixel long and the
                    // next paints over it, so the antialiased seam is solid.
                    const xd = last ? xe : xe + 0.5;
                    if (w >= 0.5) {
                        const fill = seg.color || segmentShade(r.color, j, segs.length);
                        const d = (last && w > RR)
                            ? `M ${f2(x0)} ${f2(y)} L ${f2(xd - RR)} ${f2(y)} Q ${f2(xd)} ${f2(y)} ${f2(xd)} ${f2(y + RR)}`
                              + ` L ${f2(xd)} ${f2(y + BAR - RR)} Q ${f2(xd)} ${f2(y + BAR)} ${f2(xd - RR)} ${f2(y + BAR)} L ${f2(x0)} ${f2(y + BAR)} Z`
                            : `M ${f2(x0)} ${f2(y)} L ${f2(xd)} ${f2(y)} L ${f2(xd)} ${f2(y + BAR)} L ${f2(x0)} ${f2(y + BAR)} Z`;
                        svg += linkShape(period, seg.key, seg.name, seg.value,
                            `<path class="chart-hbar" d="${d}" fill="${fill}" style="animation-delay:${i * 80 + j * 40}ms">
                <title>${escapeHtml(seg.name)}: ${fmtValue(seg.value)}</title></path>`);
                    }
                    x0 = xe;
                });
            }
            const end = Math.max(len, 0);
            svg += `<text class="chart-bar-value" x="${f2(PL + end + 8)}" y="${f2(yMid)}" dominant-baseline="middle" style="animation-delay:${i * 80 + 350}ms">${fmtValue(r.value)}</text>`;
        });
        return `${svg}</svg>`;
    }

    /**
     * Vertical bars, one per category: bars [{ key, label, color, value }].
     * Height is the box's; past a point the category names tilt rather than
     * shrinking to initials, and buy their room out of the bottom padding.
     */
    function buildBarChartSVG({ bars, W, avail, animate, period }) {
        if (bars.length === 0) return null;
        const { l: PL, r: PR, t: PT } = CHART_PAD;
        const CW = W - PL - PR;
        const slotW = CW / bars.length;
        const f2 = (n) => Math.round(n * 100) / 100;
        const LABEL_PX = 6.5;
        const flatChars = Math.max(4, Math.floor(slotW / LABEL_PX));
        const longest = Math.max(...bars.map((b) => b.label.length));
        const rotate = flatChars < Math.min(longest, 8);
        const TILT = 35;
        const fitChars = Math.floor((PL + slotW / 2) / (LABEL_PX * Math.cos(TILT * Math.PI / 180)));
        const maxChars = rotate ? Math.max(6, Math.min(16, fitChars)) : flatChars;
        const labels = bars.map((b) => (b.label.length > maxChars ? b.label.slice(0, maxChars - 1).trimEnd() + '…' : b.label));
        const extra = rotate
            ? Math.round(Math.max(...labels.map((l) => l.length)) * LABEL_PX * Math.sin(TILT * Math.PI / 180))
            : 0;
        const PB = CHART_PAD.b + extra;
        const H = Math.max(avail, 110);
        const CH = Math.max(20, H - PT - PB);
        const peak = Math.max(...bars.map((b) => b.value));
        const yTicks = ChartMath.niceTicks(0, peak, 4);
        const maxVal = yTicks[yTicks.length - 1] || 1;
        const yScale = (v) => PT + CH - (v / maxVal) * CH;
        const baseY = PT + CH;

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
            const x = cx - barW / 2;
            const y = yScale(b.value);
            const r = Math.min(4, barW / 2, baseY - y);
            const d = `M ${f2(x)} ${f2(baseY)} L ${f2(x)} ${f2(y + r)} Q ${f2(x)} ${f2(y)} ${f2(x + r)} ${f2(y)}`
                    + ` L ${f2(x + barW - r)} ${f2(y)} Q ${f2(x + barW)} ${f2(y)} ${f2(x + barW)} ${f2(y + r)} L ${f2(x + barW)} ${f2(baseY)} Z`;
            svg += linkShape(period, b.key, b.label, b.value,
                `<path class="chart-bar" d="${d}" fill="${b.color}" style="animation-delay:${i * 60}ms">
            <title>${escapeHtml(b.label)}: ${fmtValue(b.value)}</title></path>`);
            const ly = H - PB + 18;
            svg += rotate
                ? `<text class="chart-label" x="${f2(cx)}" y="${ly}" text-anchor="end" transform="rotate(-${TILT} ${f2(cx)} ${ly})">${escapeHtml(labels[i])}</text>`
                : `<text class="chart-label" x="${f2(cx)}" y="${ly}" text-anchor="middle">${escapeHtml(labels[i])}</text>`;
        });
        return `${svg}</svg>`;
    }

    /** An empty state sized for a card (UI.emptyState, no glyph tile: across a
     *  grid of cards, a row of icons reads as clutter rather than illustration). */
    const empty = (title, action = null) => UI.emptyState({ icon: null, compact: true, title, action });

    /** Lay a chart body out and hand back its plot box: `head` markup above, a
     *  plot below taking the rest of the height, `foot` markup under the plot. */
    function chartBody(host, { head = '', foot = '' } = {}) {
        host.innerHTML = `${head}<div class="dash-plot" data-plot></div>${foot}`;
        const plot = host.querySelector('[data-plot]');
        return { plot, W: plot.clientWidth, H: plot.clientHeight };
    }

    // ─── Period offers ───────────────────────────────────────────────────────
    // Trend cards draw change over time, so they offer ranges: the five the
    // Year to Year section's range group always had. Period cards add up or
    // snapshot a stretch of the statement, so they offer any month (the current
    // one follows the calendar) or a range added up. Look-ahead cards count
    // forward from today.
    const TREND = ['ytd', 'm6', 'y1', 'y3', 'y5'];
    const SPAN = ['month', 'm3', 'ytd', 'y1'];
    const THIS_MONTH = { preset: 'month', month: null };
    const YEAR_TO_DATE = { preset: 'ytd', month: null };

    const ADD_BALANCES = { label: 'Add balances', href: '/statements#balance-sheet', primary: true };
    const OPEN_STATEMENTS = { label: 'Open Statements', href: '/statements#cash-flow', primary: true };
    const ADD_TRANSACTIONS = { label: 'Add transactions', href: '/transactions', primary: true };

    /** Account key → colour, walking the balance ramp in COLUMN order and
     *  wrapping past the eighth. Column order rather than size rank: an account
     *  is an identity, and a line that changed colour whenever another account
     *  grew past it would be unreadable across a period change. */
    function accountColors(columns) {
        const palette = readRamp('--chart-balance-', BALANCE_FALLBACK);
        return new Map((columns || []).map((c, i) => [c.key, palette[i % palette.length]]));
    }

    /** Points for one balance column, oldest first. */
    function columnPoints(data, key) {
        const points = [];
        for (const year of data.years || []) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const monthIdx = MONTH_INDEX.get(month);
                if (monthIdx !== undefined && key in cats) points.push({ year, monthIdx, value: cats[key] });
            }
        }
        return points.sort((a, b) => a.year - b.year || a.monthIdx - b.monthIdx);
    }

    /** The accounts an Account Balances card plots: the stored choice among the
     *  accounts it offers, or the first one offered when it has not chosen yet
     *  (what the card always started with). */
    function plottedAccounts(settings, offered) {
        const keys = new Set(offered.map((c) => c.key));
        if (!Array.isArray(settings.plotted)) return new Set(offered.length ? [offered[0].key] : []);
        return new Set(settings.plotted.filter((k) => keys.has(k)));
    }

    /** Income and expense totals per month, from the statement's typed columns. */
    function incomeExpenseSeries(data) {
        const columns = data.columns || [];
        const incomeKeys = new Set(columns.filter((c) => c.type === 'income').map((c) => c.key));
        const expenseKeys = new Set(columns.filter((c) => c.type === 'expense').map((c) => c.key));
        const income = [], expenses = [];
        for (const year of data.years || []) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const monthIdx = MONTH_INDEX.get(month);
                if (monthIdx === undefined) continue;
                let inc = 0, exp = 0, hasInc = false, hasExp = false;
                for (const [key, val] of Object.entries(cats)) {
                    if (incomeKeys.has(key)) { inc += val; hasInc = true; }
                    if (expenseKeys.has(key)) { exp += val; hasExp = true; }
                }
                if (hasInc) income.push({ year, monthIdx, value: inc });
                if (hasExp) expenses.push({ year, monthIdx, value: exp });
            }
        }
        const byDate = (a, b) => a.year - b.year || a.monthIdx - b.monthIdx;
        // The two NAMED chart tokens: one step of the green income ramp and one
        // of the gold spending ramp, the split the Sankey and the Cash Flow bars
        // are drawn on. A slot number would pin both to one hue.
        return [
            { label: 'Income', color: readToken('--chart-income', '#10744c'), points: income.sort(byDate) },
            { label: 'Expenses', color: readToken('--chart-expense', '#b28a06'), points: expenses.sort(byDate) },
        ];
    }

    /** A toggle in a stored list: present → removed, absent → added. */
    const toggled = (list, key) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

    // Monthly Cash Flow rows, in display order, on the three named chart tokens:
    // green in, gold out, blue for money that only moved between the user's own
    // accounts (style.css carries the reasoning for the trio).
    const MCF_ROWS = [
        { key: 'income',   label: 'Income',    token: '--chart-income',   fallback: '#10744c' },
        { key: 'expense',  label: 'Expenses',  token: '--chart-expense',  fallback: '#b28a06' },
        { key: 'transfer', label: 'Transfers', token: '--chart-transfer', fallback: '#1d4ed8' },
    ];

    // The donut's slices are Balance Sheet totals per account type, so its
    // destination is the Balance Sheet, where those numbers are entered.
    const BALANCE_SHEET_HREF = '/statements#balance-sheet';

    /** The four slice colours: steps 1, 4 and 7 of the grey balance ramp for the
     *  assets (the three furthest apart it offers), and --chart-debt, the expense
     *  gold, for debt, so a liability never reads as one more shade of savings.
     *  Fixed BY TYPE, not by slice size, so a type keeps its colour across months. */
    function donutColors() {
        return {
            cash:       readToken('--chart-balance-1', '#4e5153'),
            investment: readToken('--chart-balance-4', '#787b7e'),
            retirement: readToken('--chart-balance-7', '#a9acaf'),
            debt:       readToken('--chart-debt', '#b28a06'),
        };
    }

    function renderDonut(host, ctx) {
        const data = ctx.data;
        const cutoff = ctx.period.last;
        const curr = latestValueByColumn(data.entries, cutoff);
        if (Object.keys(curr).length === 0) {
            // A truly empty balance sheet, or a month from before the first entry.
            host.innerHTML = Object.keys(latestValueByColumn(data.entries)).length
                ? empty(`No balances by ${ctx.period.label}`)
                : empty('No balances to show yet', ADD_BALANCES);
            return;
        }
        const columns = data.columns || [];
        const sumType = (type) => columns.filter((c) => c.type === type).reduce((s, c) => s + (curr[c.key] ?? 0), 0);
        const colors = donutColors();
        const raw = [
            { label: 'Investments', signed: sumType('investment'), color: colors.investment },
            { label: 'Cash',        signed: sumType('cash'),       color: colors.cash },
            { label: 'Retirement',  signed: sumType('retirement'), color: colors.retirement },
            { label: 'Debt',        signed: sumType('debt'),       color: colors.debt },
        ];
        // Magnitudes: a debt of 12k carries the same weight as 12k of assets.
        const slices = raw.map((s) => ({ ...s, value: Math.abs(s.signed) })).filter((s) => s.value > 0);
        const total = slices.reduce((s, x) => s + x.value, 0);
        if (total === 0) {
            host.innerHTML = empty('All balances are zero', { label: 'Edit balances', href: BALANCE_SHEET_HREF, primary: true });
            return;
        }

        // A segmented stroke ring: each slice is a circle stroke dashed to its
        // arc, edge to edge, since a gap in a ring that sums to a whole reads as
        // missing money. Dashes can transition, which drives the sweep-in.
        const size = 280, cx = size / 2, cy = size / 2, sw = 34;
        const r = (size - sw) / 2 - 2;
        const C = 2 * Math.PI * r;
        const f2 = (n) => Math.round(n * 100) / 100;
        let acc = 0;
        const arcs = slices.map((s, i) => {
            const len = Math.max((s.value / total) * C, 3);
            const start = (acc / total) * C;
            acc += s.value;
            const dash = `${f2(len)} ${f2(C - len)}`;
            return `<a class="donut-link" href="${BALANCE_SHEET_HREF}" tabindex="0" role="link"
                aria-label="${escapeHtml(`${s.label}: ${fmtValue(s.signed)} — open the Balance Sheet`)}">
                <circle class="donut-arc" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
                    stroke-dasharray="${ctx.animate ? `0 ${f2(C)}` : dash}" data-dash="${dash}" stroke-dashoffset="${f2(-start)}"
                    style="transition: stroke-dasharray 0.9s cubic-bezier(0.25, 0.1, 0.25, 1) ${i * 110}ms, opacity 0.15s ease 0s">
                    <title>${escapeHtml(s.label)}: ${fmtValue(s.signed)}</title></circle></a>`;
        }).join('');
        // Assets minus debt at the shown month: Net Worth's sign convention.
        const net = raw.reduce((t, s) => t + (s.label === 'Debt' ? -s.signed : s.signed), 0);
        const legend = slices.map((s) => `<a class="accounts-legend-item" href="${BALANCE_SHEET_HREF}">
            <span class="accounts-legend-dot" style="background:${s.color}"></span>
            <div class="accounts-legend-text">
                <div class="accounts-legend-head">
                    <div class="accounts-legend-label">${escapeHtml(s.label)}</div>
                    <div class="accounts-legend-pct">${((s.value / total) * 100).toFixed(1)}%</div>
                </div>
                <div class="accounts-legend-value">${fmtValue(s.signed)}</div>
            </div></a>`).join('');
        // A card too narrow for the ring beside the legend keeps the legend: the
        // figures are the reading, and the ring is their picture.
        const ring = ctx.w >= 300 ? `<div class="accounts-pie"><svg viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet" class="accounts-pie-svg">
            <g transform="rotate(-90 ${cx} ${cy})">${arcs}</g>
            <text class="donut-center-label" x="${cx}" y="${cy - 10}" text-anchor="middle">Net</text>
            <text class="donut-center-value" x="${cx}" y="${cy + 16}" text-anchor="middle">${fmtValue(net)}</text>
        </svg></div>` : '';
        host.innerHTML = `<div class="accounts-body"><div class="accounts-legend">${legend}</div>${ring}</div>`;
        // Double rAF: one frame paints at zero length before the targets are set,
        // so the sweep always runs. A resize redraw sets them directly instead.
        if (ctx.animate && ring) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                host.querySelectorAll('.donut-arc').forEach((arc) => arc.setAttribute('stroke-dasharray', arc.dataset.dash));
            }));
        }
    }

    // ─── Lists ───────────────────────────────────────────────────────────────
    // The list cards (Budgets, Top Merchants, Recent Transactions, Upcoming
    // Bills) show as many rows as their box has room for. A row is ROW_H tall,
    // the touch-target height; when the items outnumber the rows, the last row
    // becomes a link to the page that lists every one of them.
    const ROW_H = 44;

    // Recent Transactions asks for this many rows, under the server's cap
    // (handlers/transactions.js MAX_LIST_LIMIT). A card at its tallest fits about
    // 17, and its Show filter is applied here, so the request carries spare rows
    // for a filter to thin out.
    const TX_LIMIT = 50;

    /** Lay a list body out: `head` above, the list taking the rest. Returns the
     *  list element and how many rows fit in it. */
    function listBody(host, { head = '', foot = '' } = {}) {
        host.innerHTML = `${head}<div class="dash-list" data-list></div>${foot}`;
        const list = host.querySelector('[data-list]');
        return { list, fits: Math.max(1, Math.floor(list.clientHeight / ROW_H)) };
    }

    /** Fill `list` with rows for `items`, at most `fits` of them. Past that the
     *  last row links to `more.href`, reading `more.label` or else how many
     *  were left out. */
    function fillList(list, items, fits, rowHtml, more) {
        const overflow = items.length > fits;
        const shown = overflow ? items.slice(0, Math.max(1, fits - 1)) : items;
        const moreLabel = more.label || `${items.length - shown.length} more`;
        list.innerHTML = shown.map(rowHtml).join('')
            + (overflow ? `<a class="dash-more" href="${escapeHtml(more.href)}">${escapeHtml(moreLabel)}</a>` : '');
    }

    /** A card's headline figure over a muted line. Both arguments are markup:
     *  the caller escapes anything user-controlled in them. */
    const statHtml = (value, sub = '', cls = '') => `<div class="dash-stat">
        <div class="dash-stat-value${cls ? ` ${cls}` : ''}">${value}</div>${sub ? `<div class="dash-stat-sub">${sub}</div>` : ''}</div>`;

    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const pctWidth = (v) => `${(clamp01(v) * 100).toFixed(2)}%`;

    /** A horizontal track filled to `share` (0-1). Colours are token references,
     *  never user text. */
    const trackHtml = (share, color) => `<span class="dash-track" aria-hidden="true">
        <span class="dash-track-fill" style="width:${pctWidth(share)};background:${color}"></span></span>`;

    /** The money a ledger row moved, signed and coloured the way the ledger
     *  prints it (transactions.js TX_TYPE_META): + for income, − otherwise. */
    const TX_SIGN = { income: '+ ', expense: '- ', transfer: '- ' };
    const txAmountHtml = (type, amount) => {
        const kind = TX_SIGN[type] ? type : 'expense';
        return `<span class="dash-row-amt dash-amt-${kind}">${TX_SIGN[kind]}${escapeHtml(formatCurrency(amount))}</span>`;
    };

    /** 'YYYY-MM-DD' as a whole-day count, for day arithmetic without time zones. */
    const isoDay = (iso) => {
        const [y, m, d] = String(iso).split('-').map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
    };
    const isoOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    // ─── Savings Rate ────────────────────────────────────────────────────────
    // The share of income moved into the user's own savings or brokerage
    // accounts: the Transfer columns of the Cash Flow statement over its Income
    // columns, the Metrics tab's definition (services/reportCard.js), held to
    // the same 20% goal it grades against.
    const SAVINGS_GOAL = 0.2;
    const pctText = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

    /** Income and transfers per month of the period, and the rate in each. */
    function savingsMonths(data, slots) {
        const columns = data.columns || [];
        const types = new Map(columns.map((c) => [c.key, c.type]));
        return slots.map((slot) => {
            let income = 0, transfers = 0;
            const cells = ((data.entries || {})[String(slot.year)] || {})[MONTHS[slot.monthIdx]] || {};
            for (const [key, val] of Object.entries(cells)) {
                if (typeof val !== 'number') continue;
                if (types.get(key) === 'income') income += val;
                else if (types.get(key) === 'transfer') transfers += val;
            }
            return { slot, income, transfers, rate: income > 0 ? transfers / income : null };
        });
    }

    /** One column per month, the goal as a dashed rule across them. A month with
     *  no income has no rate and draws no column. */
    function buildRateChartSVG({ months, W, H, animate, goal }) {
        const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
        const f2 = (n) => Math.round(n * 100) / 100;
        const rates = months.filter((m) => m.rate !== null).map((m) => m.rate);
        const ticks = ChartMath.niceTicks(Math.min(0, ...rates), Math.max(goal, ...rates), 4);
        const lo = ticks[0], hi = ticks[ticks.length - 1];
        const CH = Math.max(20, H - PT - PB);
        const y = (v) => PT + CH - ((v - lo) / ((hi - lo) || 1)) * CH;
        const slotW = (W - PL - PR) / months.length;
        const barW = Math.min(slotW * 0.6, 40);
        const color = readToken('--chart-transfer', '#1d4ed8');
        const y0 = y(0);

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;
        for (const v of ticks) {
            svg += `<line class="chart-grid" x1="${PL}" y1="${f2(y(v))}" x2="${W - PR}" y2="${f2(y(v))}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(y(v))}" text-anchor="end" dominant-baseline="middle">${Math.round(v * 100)}%</text>`;
        }
        // Month labels thin out to every second, third... month as columns
        // narrow, counted back from the last month so it is always labelled.
        const every = Math.max(1, Math.ceil(36 / slotW));
        const last = months.length - 1;
        months.forEach((m, i) => {
            const cx = PL + slotW * (i + 0.5);
            if (m.rate !== null) {
                const top = Math.min(y(m.rate), y0), h = Math.abs(y0 - y(m.rate));
                const r = m.rate > 0 ? Math.min(4, barW / 2, h) : 0;
                const x = cx - barW / 2;
                const d = `M ${f2(x)} ${f2(top + h)} L ${f2(x)} ${f2(top + r)} Q ${f2(x)} ${f2(top)} ${f2(x + r)} ${f2(top)}`
                        + ` L ${f2(x + barW - r)} ${f2(top)} Q ${f2(x + barW)} ${f2(top)} ${f2(x + barW)} ${f2(top + r)} L ${f2(x + barW)} ${f2(top + h)} Z`;
                const tip = `${MONTHS[m.slot.monthIdx]} ${m.slot.year}: ${pctText(m.rate)}, ${fmtValue(m.transfers)} of ${fmtValue(m.income)}`;
                svg += `<path class="chart-bar" d="${d}" fill="${color}" style="animation-delay:${i * 50}ms"><title>${escapeHtml(tip)}</title></path>`;
            }
            if ((last - i) % every === 0) {
                svg += `<text class="chart-label" x="${f2(cx)}" y="${H - PB + 18}" text-anchor="middle">${MONTHS_ABBR[m.slot.monthIdx]}</text>`;
            }
        });
        svg += `<line class="chart-goal" x1="${PL}" y1="${f2(y(goal))}" x2="${W - PR}" y2="${f2(y(goal))}"><title>Goal: ${pctText(goal, 0)}</title></line>`;
        return `${svg}</svg>`;
    }

    // ─── Balance Forecast ────────────────────────────────────────────────────
    // The Reports forecast in miniature (widgets/forecast.js carries the
    // reasoning): recorded weekly balances to the left of today, the projection
    // to its right, one hue told apart by weight, solid over a filled area for
    // the past and dashed for the future.
    let forecastSeq = 0;

    function buildForecastSVG(d, W, H, animate) {
        const f2 = (n) => Math.round(n * 100) / 100;
        const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
        const anchor = d.anchor || { date: d.series[0].weekStart, balance: d.series[0].balance };
        const anchorPt = { date: anchor.date, balance: anchor.balance, anchor: true };
        const past = [...(d.history || []).map((h) => ({ date: h.weekEnd, balance: h.balance, label: h.label })), anchorPt];
        const future = [anchorPt, ...d.series.map((s) => ({ date: s.weekEnd, balance: s.balance, label: s.label, projected: true }))];

        // Zero joins the axis only when the line nears it, the report's rule:
        // on a healthy balance a zero baseline flattens every movement.
        const values = [...past, ...future].map((p) => p.balance);
        const lo = Math.min(...values), hi = Math.max(...values);
        const span = (hi - lo) || Math.abs(hi) || 1;
        const ticks = ChartMath.niceTicks(lo <= 0 || lo < span * 0.5 ? Math.min(0, lo) : lo, Math.max(0, hi), 4);
        const minV = ticks[0], maxV = ticks[ticks.length - 1];

        const domain = d.domain || { start: past[0].date, end: future[future.length - 1].date };
        const day0 = isoDay(domain.start);
        const days = Math.max(1, isoDay(domain.end) - day0);
        const CW = W - PL - PR, CH = Math.max(20, H - PT - PB);
        const x = (iso) => PL + ((isoDay(iso) - day0) / days) * CW;
        const y = (v) => PT + CH - ((v - minV) / ((maxV - minV) || 1)) * CH;
        const baseY = PT + CH;
        const color = readToken('--chart-1', '#8fb088');
        const id = `dash-fc-${++forecastSeq}`;

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart dash-forecast-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">
            <defs>
                <linearGradient id="${id}-past" gradientUnits="userSpaceOnUse" x1="0" y1="${PT}" x2="0" y2="${baseY}">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="${id}-next" gradientUnits="userSpaceOnUse" x1="0" y1="${PT}" x2="0" y2="${baseY}">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.11"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
                </linearGradient>
            </defs>`;
        const fmtAxis = axisFormatter(ticks);
        for (const v of ticks) {
            svg += `<line class="chart-grid" x1="${PL}" y1="${f2(y(v))}" x2="${W - PR}" y2="${f2(y(v))}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(y(v))}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }
        if (minV < 0 && maxV > 0) svg += `<line class="chart-zero" x1="${PL}" y1="${f2(y(0))}" x2="${W - PR}" y2="${f2(y(0))}"/>`;

        const todayX = f2(x(anchor.date));
        svg += `<line class="dash-fc-today" x1="${todayX}" y1="${PT}" x2="${todayX}" y2="${baseY}"/>`;
        const labelY = baseY + 18;
        svg += `<text class="chart-label" x="${PL}" y="${labelY}" text-anchor="start">${escapeHtml(fmtShortDate(domain.start))}</text>`;
        svg += `<text class="chart-label dash-fc-today-label" x="${todayX}" y="${labelY}" text-anchor="middle">Today</text>`;
        svg += `<text class="chart-label" x="${W - PR}" y="${labelY}" text-anchor="end">${escapeHtml(fmtShortDate(domain.end))}</text>`;

        const half = (pts, projected) => {
            if (pts.length < 2) return '';
            const xy = pts.map((p) => ({ x: x(p.date), y: y(p.balance) }));
            const line = ChartMath.smoothPath(xy);
            const area = `${line} L ${f2(xy[xy.length - 1].x)} ${baseY} L ${f2(xy[0].x)} ${baseY} Z`;
            return `<path class="dash-fc-area" d="${area}" fill="url(#${id}-${projected ? 'next' : 'past'})"/>
                <path class="${projected ? 'dash-fc-projected' : 'dash-fc-actual'}" d="${line}"${projected ? '' : ' pathLength="1"'}
                    fill="none" stroke="${color}" stroke-width="${projected ? 2 : 2.25}" stroke-linejoin="round" stroke-linecap="round"/>`;
        };
        svg += half(past, false) + half(future, true);

        // A dot per week, read through its tooltip, the way the report's are.
        const dot = (p) => {
            const tip = p.anchor ? `Today: ${fmtValue(p.balance)}`
                : `${p.projected ? 'Projected week' : 'Week'} of ${p.label}: ${fmtValue(p.balance)}`;
            const cls = `chart-dot dash-fc-dot${p.anchor ? ' is-anchor' : ''}${p.projected ? ' is-projected' : ''}${p.balance < 0 ? ' is-neg' : ''}`;
            return `<circle class="${cls}" cx="${f2(x(p.date))}" cy="${f2(y(p.balance))}" r="3" fill="${color}"><title>${escapeHtml(tip)}</title></circle>`;
        };
        svg += [...past, ...future.slice(1)].map(dot).join('');
        return `${svg}</svg>`;
    }

    // ─── Upcoming Bills ──────────────────────────────────────────────────────
    const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    /** "Today", "Tomorrow" or "In 9 days", counted from `today`. */
    const relativeDay = (iso, today) => {
        const n = isoDay(iso) - isoDay(today);
        return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
    };

    /** A month grid with the days a bill falls on marked: the month the period
     *  starts in, drawn beside the list when the card is wide enough. */
    function billCalendarHtml(bills, start) {
        const y = start.getFullYear(), m = start.getMonth();
        const lead = new Date(y, m, 1).getDay();
        const length = new Date(y, m + 1, 0).getDate();
        const prefix = `${y}-${pad2(m + 1)}-`;
        const due = new Set(bills.filter((b) => b.date.startsWith(prefix)).map((b) => Number(b.date.slice(8))));
        let cells = DAY_NAMES.map((d) => `<span class="dash-cal-dow">${d}</span>`).join('');
        cells += '<span class="dash-cal-day is-out"></span>'.repeat(lead);
        for (let d = 1; d <= length; d++) {
            const cls = `${due.has(d) ? ' is-due' : ''}${d === start.getDate() ? ' is-today' : ''}`;
            cells += `<span class="dash-cal-day${cls}">${d}</span>`;
        }
        return `<div class="dash-cal" aria-hidden="true"><div class="dash-cal-title">${MONTHS[m]} ${y}</div><div class="dash-cal-grid">${cells}</div></div>`;
    }

    // ─── The six cards the Dashboard has always had ──────────────────────────
    const TYPES = {
        networth: {
            name: 'Net Worth', group: 'Overview',
            info: 'Computed from the most recent entries in your Balance Sheet.',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 3], M: [4, 6], L: [6, 6], XL: [8, 7] }, min: [3, 3],
            defaults: {}, fields: [],
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            render(host, ctx) {
                const all = computeNetWorth(ctx.data);
                if (all.length === 0) {
                    host.innerHTML = empty('No net worth to chart yet', ADD_BALANCES);
                    return;
                }
                const points = inSlots(all, slotsOf(ctx.period));
                // The figure is the most recent net worth there is, whatever the
                // period; the change is the period's, first month to last.
                const change = rangeChange(points);
                const changeHtml = change === null
                    ? '<div class="networth-change stat-change-neutral">—</div>'
                    : `<div class="networth-change ${change.delta >= 0 ? 'stat-change-up' : 'stat-change-down'}">${change.delta >= 0 ? '+' : '-'} ${fmtValue(Math.abs(change.delta))} (${Math.abs(change.pct).toFixed(2)} %)</div>`;
                const head = `<div class="networth-summary"><div class="networth-value">${fmtValue(all[all.length - 1].value)}</div>${changeHtml}</div>`;
                // A card sized down to a tile is the figure alone.
                if (ctx.h < 150) { host.innerHTML = head; return; }
                if (points.length === 0) { host.innerHTML = head + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head });
                const color = readToken('--chart-networth', '#1a8b52');
                plot.innerHTML = lineChart([{ label: 'Net Worth', color, points }], slotsOf(ctx.period), W, H, ctx.animate) || '';
            },
        },

        accounts: {
            name: 'Account Balances', group: 'Overview',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [8, 7] }, min: [3, 4],
            // hidden: accounts left out of the chips (the gear). plotted: the
            // chips switched on; null until the user has chosen.
            defaults: { hidden: [], plotted: null }, fields: [],
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            gear: {
                title: 'Choose accounts',
                label: 'Choose accounts for this chart',
                heading: 'Accounts on this chart',
                options: (ctx) => (ctx.data.columns || []).map((c) => ({
                    key: c.key, label: c.label, on: !(ctx.card.settings.hidden || []).includes(c.key),
                })),
                // Stored as the HIDDEN set, so an account added later appears
                // without being asked for. Hiding one drops it from the plot too.
                toggle(ctx, key) {
                    const hidden = toggled(ctx.card.settings.hidden || [], key);
                    const plotted = Array.isArray(ctx.card.settings.plotted)
                        ? ctx.card.settings.plotted.filter((k) => !hidden.includes(k)) : null;
                    return { hidden, plotted };
                },
                // Only offered once there are accounts to offer.
                available: (ctx) => (ctx.data && (ctx.data.columns || []).length > 0),
            },
            chip(ctx, key) {
                const offered = (ctx.data.columns || []).filter((c) => !(ctx.card.settings.hidden || []).includes(c.key));
                return { plotted: toggled([...plottedAccounts(ctx.card.settings, offered)], key) };
            },
            render(host, ctx) {
                const data = ctx.data;
                const columns = data.columns || [];
                if (columns.length === 0) {
                    host.innerHTML = empty('No accounts to compare yet', ADD_BALANCES);
                    return;
                }
                const hidden = new Set(ctx.card.settings.hidden || []);
                const offered = columns.filter((c) => !hidden.has(c.key));
                const plotted = plottedAccounts(ctx.card.settings, offered);
                // Colours walk the full column list, so hiding an account never
                // recolours the ones that remain.
                const colors = accountColors(columns);
                const chips = chipsHtml(offered.map((c) => ({ key: c.key, label: c.label, color: colors.get(c.key), on: plotted.has(c.key) })));
                if (plotted.size === 0) { host.innerHTML = chips + empty('Nothing selected'); return; }
                const slots = slotsOf(ctx.period);
                const series = offered.filter((c) => plotted.has(c.key)).map((c) => ({
                    label: c.label, color: colors.get(c.key), points: inSlots(columnPoints(data, c.key), slots),
                }));
                if (!series.some((s) => s.points.length)) { host.innerHTML = chips + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head: chips });
                plot.innerHTML = lineChart(series, slots, W, H, ctx.animate) || '';
            },
        },

        incomeExpenses: {
            name: 'Income & Expenses', group: 'Cash flow',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [12, 6] }, min: [3, 4],
            // hidden: the series switched off on the card's chips.
            defaults: { hidden: [] }, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            chip: (ctx, key) => ({ hidden: toggled(ctx.card.settings.hidden || [], key) }),
            render(host, ctx) {
                const all = incomeExpenseSeries(ctx.data);
                if (!all.some((s) => s.points.length)) {
                    host.innerHTML = empty('No income or expenses yet', OPEN_STATEMENTS);
                    return;
                }
                const hidden = new Set(ctx.card.settings.hidden || []);
                const chips = chipsHtml(all.map((s) => ({ key: s.label, label: s.label, color: s.color, on: !hidden.has(s.label) })));
                const slots = slotsOf(ctx.period);
                const visible = all.filter((s) => !hidden.has(s.label)).map((s) => ({ ...s, points: inSlots(s.points, slots) }));
                if (visible.length === 0) { host.innerHTML = chips + empty('Nothing selected'); return; }
                if (!visible.some((s) => s.points.length)) { host.innerHTML = chips + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head: chips });
                plot.innerHTML = lineChart(visible, slots, W, H, ctx.animate) || '';
            },
        },

        cashflow: {
            name: 'Monthly Cash Flow', group: 'Cash flow',
            info: 'Where the shown month’s money went: total income, expenses, and transfers from your transactions ledger. Transfers are money moved to your own savings or brokerage accounts — neither income nor spending.',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 5], XL: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render(host, ctx) {
                const { period } = ctx;
                const slots = slotsOf(period);
                // Over a span of months each bar is the AVERAGE month, which is
                // what a card named Monthly Cash Flow shows, and it says so.
                const span = slots.length > 1;
                const month = sliceStatement(ctx.data, slots, slots.length);
                // One colour map for both month cards: a category is the same
                // colour as a segment here and as a bar in Spending.
                const colors = buildFlowColorMap(month.segments);
                const rows = MCF_ROWS.map((r) => ({
                    label: r.label,
                    color: readToken(r.token, r.fallback),
                    value: month.totals[r.key] || 0,
                    segments: (month.segments[r.key] || []).map((seg) => ({ ...seg, color: colors.get(seg.key) })),
                }));
                if (!rows.some((r) => r.value > 0)) {
                    host.innerHTML = empty(period.isCurrentMonth ? 'No activity this month yet' : `Nothing in ${period.label}`, OPEN_STATEMENTS);
                    return;
                }
                const note = span ? '<div class="dash-card-note">Monthly average</div>' : '';
                const { plot, W, H } = chartBody(host, { head: note });
                plot.innerHTML = buildHBarChartSVG({ rows, W, avail: H, animate: ctx.animate, period }) || '';
            },
        },

        balances: {
            name: 'Balances', group: 'Overview',
            info: 'How your Balance Sheet splits across account types in the shown month — cash, investment, retirement, and debt. Each account contributes its most recent balance from that month or earlier, carried forward until you record a newer one.',
            // A snapshot: one month, as of its end.
            periods: ['month'], period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            render: renderDonut,
        },

        spending: {
            name: 'Spending', group: 'Spending',
            info: 'What you’ve spent in each category in the shown month, from your transactions ledger.',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render(host, ctx) {
                const { period } = ctx;
                const slice = sliceStatement(ctx.data, slotsOf(period));
                if (slice.categories.length === 0) {
                    host.innerHTML = period.isCurrentMonth
                        ? empty('No spending this month yet', ADD_TRANSACTIONS)
                        : empty(`Nothing in ${period.label}`);
                    return;
                }
                const colors = buildFlowColorMap(slice.segments);
                const ramp = ChartRamp.outflow();
                const bars = slice.categories.map((c, i) => ({
                    key: c.key, label: c.name, value: c.total,
                    color: colors.get(c.key) || ramp[i % ramp.length],
                }));
                const { plot, W, H } = chartBody(host);
                plot.innerHTML = buildBarChartSVG({ bars, W, avail: H, animate: ctx.animate, period }) || '';
            },
        },

        // ─── Cards new with the customizable Dashboard ───────────────────────
        budgets: {
            name: 'Budgets', group: 'Spending',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 7] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: ['ie'],
            load: (ctx) => Promise.all([ctx.hub.store('ie'), ctx.hub.json('/api/budgets')])
                .then(([statement, saved]) => ({ statement, budgets: saved.budgets || [] })),
            // A target is one month's (handlers/budgets.js), so a span of months
            // is held to the target times its length. Spending turns red past
            // its target; money put away is drawn in blue and never graded, the
            // Budgets page's two kinds of circle (budgets.js carries the why).
            render(host, ctx) {
                const { statement, budgets } = ctx.data;
                const targets = new Map(budgets.filter((b) => b.amount > 0).map((b) => [b.category, b.amount]));
                const slots = slotsOf(ctx.period);
                const spent = statementTotals(statement, slots);
                const rows = (statement.columns || [])
                    .filter((c) => (c.type === 'expense' || c.type === 'transfer') && targets.has(c.key))
                    .map((c) => {
                        const target = targets.get(c.key) * slots.length;
                        // A negative cell is not progress toward a target.
                        const actual = Math.max(spent.get(c.key) || 0, 0);
                        const away = c.type === 'transfer';
                        return { key: c.key, label: c.label, target, actual, away, used: actual / target, over: !away && actual > target };
                    });
                if (rows.length === 0) {
                    host.innerHTML = empty('No budgets set', { label: 'Open Budgets', href: '/budgets', primary: true });
                    return;
                }
                rows.sort((a, b) => b.used - a.used || a.label.localeCompare(b.label));
                const spending = rows.filter((r) => !r.away);
                const head = ctx.h >= 230 && spending.length
                    ? statHtml(escapeHtml(fmtValue(spending.reduce((s, r) => s + r.actual, 0))),
                        `of ${escapeHtml(fmtValue(spending.reduce((s, r) => s + r.target, 0)))}`)
                    : '';
                const { list, fits } = listBody(host, { head });
                fillList(list, rows, fits, (r) => {
                    const color = r.away ? 'var(--accent-secondary)' : r.over ? 'var(--accent-negative)' : 'var(--accent-primary)';
                    const of = `${formatCurrency(r.actual)} of ${formatCurrency(r.target)}`;
                    const tip = r.away ? `${r.label}: ${of} put away` : r.over ? `${r.label}: ${of}, over budget` : `${r.label}: ${of}`;
                    return `<a class="dash-row dash-row-bar" href="${escapeHtml(ledgerHref(ctx.period, { cat: r.key }))}" title="${escapeHtml(tip)}">
                        <span class="dash-row-title">${escapeHtml(r.label)}</span>
                        <span class="dash-row-amt${r.over ? ' is-over' : ''}">${escapeHtml(fmtValue(r.actual))}<span class="dash-row-of"> / ${escapeHtml(fmtValue(r.target))}</span></span>
                        ${trackHtml(r.used, color)}</a>`;
                }, { href: '/budgets' });
            },
        },

        savingsRate: {
            name: 'Savings Rate', group: 'Cash flow',
            info: 'The share of income you moved into your own savings or brokerage accounts, across every transfer category.',
            periods: ['month', 'm3', 'm6', 'ytd', 'y1'], period: YEAR_TO_DATE,
            sizes: { S: [3, 3], M: [4, 5], L: [6, 5], XL: [8, 6] }, min: [3, 3],
            defaults: {}, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render(host, ctx) {
                const months = savingsMonths(ctx.data, slotsOf(ctx.period));
                const income = months.reduce((s, m) => s + m.income, 0);
                const transfers = months.reduce((s, m) => s + m.transfers, 0);
                if (income <= 0) {
                    const anything = Object.keys(ctx.data.entries || {}).length > 0;
                    host.innerHTML = !anything ? empty('No income or expenses yet', OPEN_STATEMENTS)
                        : empty(ctx.period.isCurrentMonth ? 'No income this month yet' : `No income in ${ctx.period.label}`);
                    return;
                }
                const head = statHtml(escapeHtml(pctText(transfers / income)), `Goal ${pctText(SAVINGS_GOAL, 0)}`);
                // A single month, or a card sized down to a tile, is the figure alone.
                if (months.length === 1 || ctx.h < 150) { host.innerHTML = head; return; }
                const { plot, W, H } = chartBody(host, { head });
                plot.innerHTML = buildRateChartSVG({ months, W, H, animate: ctx.animate, goal: SAVINGS_GOAL });
            },
        },

        merchants: {
            name: 'Top Merchants', group: 'Spending',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: [],
            load(ctx) {
                const { first, last } = ctx.period;
                return ctx.hub.json(`/api/top-merchants?start=${isoMonth(first)}&end=${isoMonth(last)}`);
            },
            // Bars scale to the period's top merchant, and each tooltip carries
            // its share of everything spent.
            render(host, ctx) {
                const { period } = ctx;
                const merchants = (ctx.data && ctx.data.merchants) || [];
                if (merchants.length === 0) {
                    host.innerHTML = period.isCurrentMonth
                        ? empty('No spending this month yet', ADD_TRANSACTIONS)
                        : empty(`Nothing in ${period.label}`);
                    return;
                }
                const spent = ctx.data.total || 0;
                const max = merchants[0].total || 1;
                const color = 'var(--chart-expense)';
                const { list, fits } = listBody(host);
                fillList(list, merchants, fits, (m) => {
                    const share = spent > 0 ? `, ${pctText(m.total / spent)} of spending` : '';
                    const tip = `${m.name}: ${m.count} transaction${m.count === 1 ? '' : 's'}${share}`;
                    const inner = `${merchantAvatarHtml(m.name)}<span class="dash-row-title">${escapeHtml(m.name)}</span>
                        <span class="dash-row-amt">${escapeHtml(fmtValue(m.total))}</span>${trackHtml(m.total / max, color)}`;
                    return m.search
                        ? `<a class="dash-row dash-row-bar has-avatar" href="${escapeHtml(ledgerHref(period, { name: m.search }))}" title="${escapeHtml(tip)}">${inner}</a>`
                        : `<div class="dash-row dash-row-bar has-avatar" title="${escapeHtml(tip)}">${inner}</div>`;
                }, { href: ledgerHref(period) });
            },
        },

        transactions: {
            name: 'Recent Transactions', group: 'Spending',
            // The newest rows, whatever their date: no period picker or link.
            noPeriod: true,
            periods: SPAN, period: { preset: 'm3', month: null },
            sizes: { S: [4, 5], M: [6, 6], L: [8, 7], XL: [12, 7] }, min: [4, 4],
            defaults: { show: 'all' },
            fields: [{ key: 'show', label: 'Show', options: [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']] }],
            skeleton: 'rows',
            uses: [],
            load(ctx) {
                return ctx.hub.json(`/api/transactions?limit=${TX_LIMIT}`);
            },
            render(host, ctx) {
                const show = ctx.card.settings.show;
                const all = ctx.data.transactions || [];
                const rows = all.filter((t) => show === 'all' || t.tx_type === show);
                if (rows.length === 0) {
                    host.innerHTML = empty('No transactions yet', ADD_TRANSACTIONS);
                    return;
                }
                const cats = new Map((ctx.data.categories || []).map((c) => [c.id, c]));
                const wide = ctx.w >= 560;
                const { list, fits } = listBody(host);
                fillList(list, rows, fits, (t) => {
                    const label = t.display_name || t.description || '';
                    const cat = cats.get(t.category_id);
                    const date = escapeHtml(fmtShortDate(t.date));
                    const catHtml = cat
                        ? `<span class="tx-category-pill tx-category-${escapeHtml(cat.cat_type)}">${escapeHtml(cat.name)}</span>`
                        : '<span class="tx-category-pill tx-category-empty">Uncategorized</span>';
                    return wide
                        ? `<div class="dash-row dash-row-tx is-wide"><span class="dash-row-date">${date}</span>${merchantAvatarHtml(label)}
                            <span class="dash-row-title" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${catHtml}${txAmountHtml(t.tx_type, t.amount)}</div>`
                        : `<div class="dash-row dash-row-tx">${merchantAvatarHtml(label)}<span class="dash-row-main">
                            <span class="dash-row-title" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                            <span class="dash-row-sub">${date} · ${escapeHtml(cat ? cat.name : 'Uncategorized')}</span></span>${txAmountHtml(t.tx_type, t.amount)}</div>`;
                // The response stops at TX_LIMIT rows, so past that the count of
                // what was left out is not known and the link just opens them.
                }, { href: '/transactions', label: all.length >= TX_LIMIT ? 'View all' : '' });
            },
        },

        upcoming: {
            name: 'Upcoming Bills', group: 'Planning',
            noLink: true,
            periods: ['d14', 'd30', 'd60'], period: { preset: 'd30', month: null },
            sizes: { S: [3, 5], M: [4, 6], L: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: [],
            // The Recurring page answers one calendar month at a time, so a span
            // that crosses a month end asks for each month it touches.
            load(ctx) {
                const { start, end } = ctx.period;
                const months = DashPeriod.monthsBetween(
                    { year: start.getFullYear(), monthIdx: start.getMonth() },
                    { year: end.getFullYear(), monthIdx: end.getMonth() });
                return Promise.all(months.map((s) => ctx.hub.json(`/api/recurring?month=${isoMonth(s)}`)));
            },
            render(host, ctx) {
                const { period } = ctx;
                const from = isoOf(period.start), to = isoOf(period.end);
                const names = new Map();
                const seen = new Set();
                const bills = [];
                for (const page of ctx.data) {
                    for (const s of page.series || []) names.set(s.key, s.display_name || s.description || s.key);
                    for (const o of page.occurrences || []) {
                        const id = `${o.key}|${o.date}`;
                        if (o.direction !== 'expense' || o.date < from || o.date > to || seen.has(id)) continue;
                        seen.add(id);
                        bills.push(o);
                    }
                }
                if (bills.length === 0) {
                    const schedules = ctx.data.some((page) => (page.series || []).length > 0);
                    host.innerHTML = schedules
                        ? empty(`Nothing due in the ${period.short.toLowerCase()}`)
                        : empty('No recurring bills yet', { label: 'Open Recurring', href: '/recurring', primary: true });
                    return;
                }
                bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
                const total = bills.reduce((s, b) => s + b.amount, 0);
                const head = ctx.h >= 170
                    ? statHtml(escapeHtml(fmtValue(total)), `${bills.length} bill${bills.length === 1 ? '' : 's'}`) : '';
                const tight = ctx.w < 340;
                const calendar = ctx.w >= 540 && ctx.h >= 250 ? billCalendarHtml(bills, period.start) : '';
                host.innerHTML = `${head}<div class="dash-bills">${calendar}<div class="dash-list" data-list></div></div>`;
                const list = host.querySelector('[data-list]');
                const fits = Math.max(1, Math.floor(list.clientHeight / ROW_H));
                fillList(list, bills, fits, (b) => {
                    const name = names.get(b.key) || b.key;
                    const [, m, d] = b.date.split('-').map(Number);
                    return `<div class="dash-row dash-row-bill${tight ? ' is-tight' : ''}" title="${escapeHtml(`${name}: ${formatCurrency(b.amount, true)}`)}">
                        <span class="dash-datechip${b.date === from ? ' is-today' : ''}"><span>${MONTHS_ABBR[m - 1]}</span><b>${d}</b></span>
                        ${tight ? '' : merchantAvatarHtml(name)}
                        <span class="dash-row-main"><span class="dash-row-title">${escapeHtml(name)}</span>
                            <span class="dash-row-sub">${relativeDay(b.date, from)}</span></span>
                        <span class="dash-row-amt">${escapeHtml(formatCurrency(b.amount))}</span></div>`;
                }, { href: '/recurring' });
            },
        },

        forecast: {
            name: 'Balance Forecast', group: 'Planning',
            info: 'Projects one account\'s balance forward, week by week. Each week combines your typical spending and income (averaged over recent complete months).',
            periods: ['f1', 'f3', 'f6'], period: { preset: 'f3', month: null },
            sizes: { S: [3, 4], M: [6, 5], L: [8, 6], XL: [12, 6] }, min: [3, 3],
            defaults: {}, fields: [],
            uses: [],
            load: (ctx) => ctx.hub.json(`/api/forecast?months=${ctx.period.months}`),
            render(host, ctx) {
                const d = ctx.data;
                const series = d.series || [];
                const anything = series.length > 0
                    && ((d.history && d.history.length > 0) || (d.planned || []).length > 0 || !!d.start_balance);
                if (!anything) {
                    host.innerHTML = empty('Nothing to forecast yet', ADD_TRANSACTIONS);
                    return;
                }
                const { summary } = d;
                const account = (d.accounts || []).find((a) => a.key === d.start_account);
                const sub = `${account ? `${escapeHtml(account.label)} · ` : ''}${escapeHtml(fmtShortDate(summary.endDate))}`;
                let head = statHtml(escapeHtml(fmtValue(summary.endBalance)), sub, summary.endBalance < 0 ? 'is-neg' : '');
                if (summary.belowZero && summary.lowest) {
                    head += `<div class="dash-card-alert">Runs out of money the week of ${escapeHtml(summary.lowest.label)}, down to ${escapeHtml(fmtValue(summary.lowest.balance))}.</div>`;
                }
                if (ctx.h < 150) { host.innerHTML = head; return; }
                const { plot, W, H } = chartBody(host, { head });
                plot.innerHTML = buildForecastSVG(d, W, H, ctx.animate);
            },
        },
    };

    // ─── Widget list ─────────────────────────────────────────────────────────
    // Each widget's picture in the Customize panel: a schematic of its shape in
    // three inks (dashboard.css .dash-thumb), not its data, so the panel opens
    // without loading anything.
    const THUMBS = {
        networth: '<rect class="t-ink" x="8" y="8" width="40" height="8" rx="2"/><rect class="t-mute" x="8" y="20" width="26" height="4" rx="2"/>'
            + '<path class="t-line t-a" d="M8 60 C24 56 32 46 48 48 S78 36 92 32 108 26 112 24"/>',
        accounts: '<rect class="t-chip t-a" x="8" y="8" width="22" height="7" rx="3.5"/><rect class="t-chip t-mute" x="34" y="8" width="22" height="7" rx="3.5"/>'
            + '<path class="t-line t-a" d="M8 58 C30 54 40 44 60 46 S96 34 112 30"/><path class="t-line t-c" d="M8 40 C30 42 48 36 66 38 S98 46 112 44"/>',
        incomeExpenses: '<rect class="t-chip t-a" x="8" y="8" width="22" height="7" rx="3.5"/><rect class="t-chip t-b" x="34" y="8" width="22" height="7" rx="3.5"/>'
            + '<path class="t-line t-a" d="M8 36 C28 30 44 38 62 32 S96 26 112 28"/><path class="t-line t-b" d="M8 56 C28 50 44 58 62 50 S96 52 112 46"/>',
        cashflow: '<rect class="t-fill t-a" x="30" y="14" width="74" height="10" rx="2"/><rect class="t-fill t-b" x="30" y="32" width="56" height="10" rx="2"/>'
            + '<rect class="t-fill t-c" x="30" y="50" width="22" height="10" rx="2"/><rect class="t-mute" x="8" y="16" width="16" height="5" rx="2"/>'
            + '<rect class="t-mute" x="8" y="34" width="16" height="5" rx="2"/><rect class="t-mute" x="8" y="52" width="16" height="5" rx="2"/>',
        balances: '<circle class="t-ring t-mute" cx="84" cy="36" r="20"/><path class="t-ring t-a" d="M84 16 A20 20 0 0 1 103 42"/>'
            + '<path class="t-ring t-b" d="M103 42 A20 20 0 0 1 72 52"/><rect class="t-ink" x="8" y="18" width="34" height="6" rx="2"/>'
            + '<rect class="t-mute" x="8" y="30" width="26" height="5" rx="2"/><rect class="t-ink" x="8" y="44" width="30" height="6" rx="2"/>',
        spending: '<rect class="t-fill t-b" x="12" y="18" width="12" height="44" rx="2"/><rect class="t-fill t-b" x="32" y="30" width="12" height="32" rx="2"/>'
            + '<rect class="t-fill t-b" x="52" y="38" width="12" height="24" rx="2"/><rect class="t-fill t-b" x="72" y="46" width="12" height="16" rx="2"/>'
            + '<rect class="t-fill t-b" x="92" y="52" width="12" height="10" rx="2"/>',
        budgets: '<rect class="t-mute" x="8" y="12" width="104" height="6" rx="3"/><rect class="t-fill t-a" x="8" y="12" width="70" height="6" rx="3"/>'
            + '<rect class="t-mute" x="8" y="32" width="104" height="6" rx="3"/><rect class="t-fill t-neg" x="8" y="32" width="104" height="6" rx="3"/>'
            + '<rect class="t-mute" x="8" y="52" width="104" height="6" rx="3"/><rect class="t-fill t-c" x="8" y="52" width="44" height="6" rx="3"/>',
        savingsRate: '<rect class="t-ink" x="8" y="8" width="30" height="8" rx="2"/><line class="t-goal" x1="8" y1="38" x2="112" y2="38"/>'
            + '<rect class="t-fill t-c" x="14" y="42" width="12" height="20" rx="2"/><rect class="t-fill t-c" x="36" y="34" width="12" height="28" rx="2"/>'
            + '<rect class="t-fill t-c" x="58" y="40" width="12" height="22" rx="2"/><rect class="t-fill t-c" x="80" y="28" width="12" height="34" rx="2"/>'
            + '<rect class="t-fill t-c" x="102" y="36" width="10" height="26" rx="2"/>',
        merchants: '<circle class="t-fill t-mute" cx="13" cy="15" r="5"/><rect class="t-fill t-b" x="24" y="12" width="80" height="6" rx="3"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="36" r="5"/><rect class="t-fill t-b" x="24" y="33" width="54" height="6" rx="3"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="57" r="5"/><rect class="t-fill t-b" x="24" y="54" width="32" height="6" rx="3"/>',
        transactions: '<circle class="t-fill t-mute" cx="13" cy="15" r="5"/><rect class="t-ink" x="24" y="12" width="52" height="6" rx="2"/><rect class="t-fill t-neg" x="90" y="12" width="22" height="6" rx="2"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="36" r="5"/><rect class="t-ink" x="24" y="33" width="40" height="6" rx="2"/><rect class="t-fill t-pos" x="90" y="33" width="22" height="6" rx="2"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="57" r="5"/><rect class="t-ink" x="24" y="54" width="46" height="6" rx="2"/><rect class="t-fill t-neg" x="90" y="54" width="22" height="6" rx="2"/>',
        upcoming: '<rect class="t-chip t-mute" x="8" y="8" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="10" width="48" height="5" rx="2"/><rect class="t-mute" x="32" y="18" width="28" height="4" rx="2"/>'
            + '<rect class="t-chip t-mute" x="8" y="30" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="32" width="40" height="5" rx="2"/><rect class="t-mute" x="32" y="40" width="22" height="4" rx="2"/>'
            + '<rect class="t-chip t-mute" x="8" y="52" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="54" width="44" height="5" rx="2"/><rect class="t-mute" x="32" y="62" width="30" height="4" rx="2"/>',
        forecast: '<line class="t-goal" x1="60" y1="8" x2="60" y2="64"/><path class="t-line t-a" d="M8 50 C22 46 34 52 46 44 S56 38 60 38"/>'
            + '<path class="t-line t-a t-dash" d="M60 38 C72 34 84 42 96 32 S108 26 112 24"/>',
    };

    const thumbHtml = (type) => `<svg class="dash-thumb" viewBox="0 0 120 72" aria-hidden="true">${THUMBS[type] || ''}</svg>`;

    // The Customize panel's groups, in the order they list.
    const GROUPS = ['Overview', 'Cash flow', 'Spending', 'Planning'].map((name) => ({
        name,
        types: Object.keys(TYPES).filter((type) => TYPES[type].group === name),
    }));

    // ─── Default layout ──────────────────────────────────────────────────────
    // The Dashboard as it always was: the Year to Year cards over the Month to
    // Month ones, so a database that never saved a layout opens on the page its
    // user already knows.
    // A card here is { type, x, y, w, h, period?, settings? }; the page fills in
    // the id and anything left out from the card's own definition.
    const MONTH_THIS = { preset: 'month', month: null };
    const OVERVIEW = {
        name: 'Overview',
        cards: [
            { type: 'networth', x: 0, y: 0, w: 4, h: 6 },
            { type: 'accounts', x: 4, y: 0, w: 4, h: 6 },
            { type: 'incomeExpenses', x: 8, y: 0, w: 4, h: 6 },
            { type: 'cashflow', x: 0, y: 6, w: 4, h: 6, period: MONTH_THIS },
            { type: 'balances', x: 4, y: 6, w: 4, h: 6, period: MONTH_THIS },
            { type: 'spending', x: 8, y: 6, w: 4, h: 6, period: MONTH_THIS },
        ],
    };

    window.DashCards = { TYPES, GROUPS, OVERVIEW, thumbHtml };
}());
