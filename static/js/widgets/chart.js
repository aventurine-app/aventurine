'use strict';

// ─── chart.js ────────────────────────────────────────────────────────────────
// Shared hand-rolled multi-series SVG chart, exposed as window.FinanceChart. A
// copy of the renderer the Dashboard uses (dashboard.js), moved into a reusable
// module so other pages (Spending Trends, and others later) get the same frame,
// smoothing, nice-tick axis, entrance animation and responsive redraw without a
// per-page copy. Dashboard and forecast still have their own copies and can
// migrate here later.
//
// Two forms share the frame: render() draws smoothed lines (one measure over
// time), renderStacked() draws stacked columns (a part-to-whole breakdown over
// time, for Reports → Investing). They share niceTicks, the axis, the padding,
// the label stride and the responsive mount, which would otherwise be duplicated
// in a second widget file.
//
// Series shape:  [{ label, color, points: [{ year, monthIdx, value }] }]
// Slots:         [{ year, monthIdx }]  — the x-axis columns to plot across.
//
// Uses the existing globals escapeHtml (escape.js) and CURRENCY_SYMBOL
// (currency.js), which the page loads before this file.

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  // Two series palettes, both read from CSS tokens at colorMap() time so they
  // retone on a theme swap; the arrays are only first-paint fallbacks for the
  // rare frame before styles resolve.
  //
  //   'accent' (default) — the accent-derived --chart-* ramp (style.css). One
  //       measure over time; the series are variations of the same thing, so
  //       following the UI accent is exactly right.
  //   'categorical'      — the merchant spectrum, --cat-* (style.css). For a
  //       chart whose series are CATEGORIES, where hue is the label rather
  //       than decoration and eight rungs of one accent can't be told apart.
  const PALETTE = [
    '#8fb088', '#5c7152', '#a9c1a4', '#33402d',
    '#7c9670', '#b6c8b2', '#647a59', '#5a6f50',
  ];
  const CAT_PALETTE = [
    '#404e77', '#776a40', '#407777', '#5c7740',
    '#77406a', '#40774e', '#5c4077', '#774040',
  ];

  function readPalette(name) {
    const cs = getComputedStyle(document.documentElement);
    const [fallbacks, token] = name === 'categorical'
      ? [CAT_PALETTE, 'cat']
      : [PALETTE, 'chart'];
    return fallbacks.map((fb, i) => cs.getPropertyValue(`--${token}-${i + 1}`).trim() || fb);
  }

  const CHART_RATIO = 200 / 800;
  const CHART_PAD = { l: 56, r: 20, t: 18, b: 30 };
  const observers = new Map();

  function niceTicks(min, max, target = 4) {
    if (max <= min) return [min];
    const rough = (max - min) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm < 2) step = 2 * mag;
    else if (norm < 5) step = 5 * mag;
    else step = 10 * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
  }

  // Axis labels come from axisFormatter (currency.js), which is handed the whole
  // tick set: formatting ticks one at a time made distinct gridlines share a
  // label whenever the step wasn't a round thousand (step 200 → "$9K, $9K, $9K").

  function fmtTooltip(n) {
    return formatCurrency(n, true);
  }

  function smoothPath(pts) {
    const f = (n) => Math.round(n * 100) / 100;
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
    // Catmull-Rom tangents let a segment OVERSHOOT the two points it connects: a
    // run of equal values followed by a rise bows the curve past the flat part
    // first. On a chart whose axis is fitted to the data that shows as extra
    // curvature; on a zero-based one (Reports → Investing) it draws the line
    // BELOW zero between two months of zero. Clamping each control point to its
    // segment's y-range reduces the curvature at a peak slightly and keeps the
    // curve within its endpoints' range.
    const clamp = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
    let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1y = clamp(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y);
      const c2y = clamp(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y);
      d += ` C ${f(p1.x + (p2.x - p0.x) / 6)} ${f(c1y)},`
        + ` ${f(p2.x - (p3.x - p1.x) / 6)} ${f(c2y)},`
        + ` ${f(p2.x)} ${f(p2.y)}`;
    }
    return d;
  }

  function buildChartSVG({ series, slots, W, animate = true, zeroBase = false }) {
    const N = slots.length;
    const allValues = series.flatMap((s) => s.points.map((p) => p.value));
    if (allValues.length === 0) return null;

    const H = Math.max(Math.round(W * CHART_RATIO), 170);
    const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
    const CW = W - PL - PR;
    const CH = H - PT - PB;

    // zeroBase floors the axis at zero. The line form fits its ticks to the
    // data by default, which is right for a bare line; it is NOT right once the
    // line carries an AREA FILL, because a filled shape reads its height from
    // the baseline and a baseline of 1,800 states a swing that isn't there. Any
    // report pairing this chart with a stacked one (Reports → Investing) also
    // needs both halves on the same floor, or the same months look volatile
    // above and steady below.
    const lo = Math.min(...allValues);
    const yTicks = niceTicks(zeroBase ? Math.min(0, lo) : lo, Math.max(...allValues), 4);
    const minVal = yTicks[0];
    const maxVal = yTicks[yTicks.length - 1];
    const valRange = maxVal - minVal || 1;

    const xScale = (i) => PL + (i / (N - 1 || 1)) * CW;
    const yScale = (v) => PT + CH - ((v - minVal) / valRange) * CH;
    const rnd = Math.random().toString(36).slice(2, 9);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    const fmtAxis = axisFormatter(yTicks);
    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
    }

    if (minVal < 0 && maxVal > 0) {
      const y0 = yScale(0);
      svg += `<line class="chart-zero" x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}"/>`;
    }

    svg += xAxisLabels(slots, xScale, H - PB + 18);

    series.forEach((s, si) => {
      const pointMap = new Map(s.points.map((p) => [`${p.year}-${p.monthIdx}`, p.value]));
      const slotData = slots.map((sl, i) => ({ ...sl, i, value: pointMap.get(`${sl.year}-${sl.monthIdx}`) ?? null }));
      const drawn = slotData.filter((sl) => sl.value !== null);
      const linePts = drawn.map((sl) => ({ x: xScale(sl.i), y: yScale(sl.value) }));
      const delay = si * 140;

      if (linePts.length > 1) {
        const baseY = H - PB;
        const lineD = smoothPath(linePts);
        const areaD = `${lineD} L ${linePts[linePts.length - 1].x} ${baseY} L ${linePts[0].x} ${baseY} Z`;
        const lineTopY = Math.min(...linePts.map((p) => p.y));
        const gradId = `areagrad-${rnd}-${si}`;
        svg += `<defs>
                <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse"
                                x1="0" y1="${lineTopY}" x2="0" y2="${baseY}">
                    <stop offset="0%"   stop-color="${s.color}" stop-opacity="0.30"/>
                    <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
                </linearGradient>
            </defs>`;
        svg += `<path class="chart-area-fill" d="${areaD}" fill="url(#${gradId})" style="animation-delay:${delay + 400}ms"/>`;
        svg += `<path class="chart-line" d="${lineD}" pathLength="1" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" style="animation-delay:${delay}ms"/>`;
      }

      drawn.forEach((sl, di) => {
        const x = xScale(sl.i);
        const y = yScale(sl.value);
        const isEnd = di === drawn.length - 1;
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

  /** The month labels under the plot. Shared by both chart forms so a line and
   *  a stack of the same months read the same across a report: every slot while
   *  they fit, then a widening stride, and the newest slot is always labelled
   *  unless it would crowd the one before it. January prints its YEAR instead
   *  of its name when the span crosses one, which is the only date context a
   *  12- or 24-month axis needs. */
  function xAxisLabels(slots, xAt, y) {
    const N = slots.length;
    const multiYear = new Set(slots.map((s) => s.year)).size > 1;
    const stride = N <= 8 ? 1 : N <= 14 ? 2 : N <= 26 ? 3 : 6;
    const lastDist = (N - 1) % stride;
    let out = '';
    slots.forEach((s, i) => {
      const isLast = i === N - 1;
      if (!isLast && i % stride !== 0) return;
      if (isLast && lastDist !== 0 && lastDist < 2) return;
      const label = (multiYear && s.monthIdx === 0) ? s.year : MONTHS_SHORT[s.monthIdx];
      out += `<text class="chart-label" x="${xAt(i)}" y="${y}" text-anchor="middle">${label}</text>`;
    });
    return out;
  }

  // ─── Stacked columns ───────────────────────────────────────────────────────
  // One column per slot, split into a segment per series, growing from a zero
  // baseline. Written for Reports → Investing, which shows amounts per merchant
  // over the same months.
  //
  // Geometry notes:
  //   - Columns sit at BAND CENTRES (PL + (i + 0.5) * band), not at the line
  //     form's endpoints-on-the-axis scale. A bar drawn at x = PL has half its
  //     width outside the plot; a band is the only layout where the first and
  //     last columns are whole.
  //   - The bar is CAPPED at BAR_MAX and never fills its band. The leftover is
  //     air between columns, which is what makes a stack read as one column
  //     rather than as a wall.
  //   - Segments are separated by a 2px GAP OF SURFACE, not by a stroke. A
  //     border around a segment adds ink that isn't data, and on a thin segment
  //     the border becomes most of the segment.
  //   - Only the top of the whole column is rounded (BAR_RADIUS), and only when
  //     the segment is tall enough to take a radius without deforming. The
  //     baseline end stays square: it is a shared zero, not a data end.
  //   - The y axis starts at zero, always. A stacked column whose baseline is
  //     not zero states a proportion that isn't true.
  const BAR_MAX = 24;
  const BAR_RADIUS = 4;
  const SEG_GAP = 2;
  // A band this tall or shorter keeps its full height and forgoes its gap. The
  // gap exists to separate two fills; on a 3px band it eats most of the fill
  // and a column of small contributors turns into a barcode, which is a worse
  // failure than two neighbouring bands touching. The bands that DO have room
  // all keep the same 2px, so the gap is still one consistent width wherever
  // it is drawn.
  const SEG_GAP_MIN_H = 5;

  /** A rect with only its top corners rounded, or a plain rect when there is no
   *  room for the radius (a short segment with rounded corners reads as a lozenge
   *  rather than as a bar end). */
  function topRoundedRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    if (rr < 1.5) return `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
    return `<path d="M ${x} ${y + h} L ${x} ${y + rr} A ${rr} ${rr} 0 0 1 ${x + rr} ${y}`
      + ` L ${x + w - rr} ${y} A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr} L ${x + w} ${y + h} Z"/>`;
  }

  function buildStackedSVG({ series, slots, W, animate = true }) {
    const N = slots.length;
    if (!N || !series.length) return null;

    const valueAt = (s, sl) => {
      const hit = s.points.find((p) => p.year === sl.year && p.monthIdx === sl.monthIdx);
      return hit ? Number(hit.value) || 0 : 0;
    };
    const totals = slots.map((sl) => series.reduce((sum, s) => sum + valueAt(s, sl), 0));
    const maxTotal = Math.max(...totals);
    if (!(maxTotal > 0)) return null;

    const H = Math.max(Math.round(W * CHART_RATIO), 170);
    const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
    const CW = W - PL - PR;
    const CH = H - PT - PB;

    const yTicks = niceTicks(0, maxTotal, 4);
    const maxVal = yTicks[yTicks.length - 1] || 1;
    const baseY = PT + CH;
    const yScale = (v) => baseY - (v / maxVal) * CH;

    const band = CW / N;
    const barW = Math.max(3, Math.min(BAR_MAX, band * 0.62));
    const xCentre = (i) => PL + band * (i + 0.5);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    const fmtAxis = axisFormatter(yTicks);
    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
    }
    svg += xAxisLabels(slots, xCentre, H - PB + 18);

    slots.forEach((sl, i) => {
      if (!(totals[i] > 0)) return;
      const x = xCentre(i) - barW / 2;
      // Which series actually appear in THIS column, bottom-first. A series
      // that contributed nothing this month draws nothing and, crucially, does
      // not spend a gap — otherwise a column with one contributor would carry
      // seven invisible seams.
      const parts = series
        .map((s) => ({ s, value: valueAt(s, sl) }))
        .filter((p) => p.value > 0);

      // The whole column scales up from the baseline as one piece, so the stack
      // assembles the way it is read rather than each segment sprouting alone.
      svg += `<g class="chart-col" style="transform-origin:0px ${baseY}px;animation-delay:${Math.min(i * 22, 500)}ms">`;
      svg += `<title>${MONTHS[sl.monthIdx]} ${sl.year}: ${fmtTooltip(totals[i])}</title>`;

      let bottom = 0;
      parts.forEach((p, pi) => {
        const top = bottom + p.value;
        const yTop = yScale(top);
        const yBottom = yScale(bottom);
        const isTop = pi === parts.length - 1;
        // The gap is taken off the TOP of every segment but the highest, so it
        // falls between two fills and the column still meets the baseline. A
        // band with no room to spare keeps its height instead (SEG_GAP_MIN_H).
        const raw = yBottom - yTop;
        const gap = isTop || raw <= SEG_GAP_MIN_H ? 0 : SEG_GAP;
        const h = Math.max(raw - gap, 1);
        const yDraw = yTop + gap;
        const shape = isTop
          ? topRoundedRect(x, yDraw, barW, h, BAR_RADIUS)
          : `<rect x="${x}" y="${yDraw}" width="${barW}" height="${h}"/>`;
        svg += `<g class="chart-seg" fill="${p.s.color}">${shape}`
          + `<title>${escapeHtml(p.s.label)} — ${MONTHS[sl.monthIdx]} ${sl.year}: ${fmtTooltip(p.value)}</title></g>`;
        bottom = top;
      });
      svg += '</g>';
    });

    svg += '</svg>';
    return svg;
  }

  /** Render stacked columns into a container. Pass empty `series` to clear. */
  function renderStacked(containerId, { series, slots }) {
    mount(containerId, series.length > 0 && slots.length > 0, (W, animate) =>
      buildStackedSVG({ series, slots, W, animate }));
  }

  /** Draw into a container and keep it responsive: re-render on resize, with the
   *  first paint animating and resizes not. `build(W)` returns the SVG for a
   *  given pixel width. Shared by both chart forms, which is the main reason
   *  stacked bars live in this file rather than a separate one. */
  function mount(containerId, hasData, build) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const existing = observers.get(containerId);
    if (existing) { existing.disconnect(); observers.delete(containerId); }

    if (!hasData) { el.innerHTML = ''; return; }

    const target = el.parentElement || el;
    let animate = true;       // flips off after the first successful paint
    let lastW = 0;
    let sawInitial = false;   // has the observer delivered its first callback?
    const draw = (w) => {
      w = Math.round(w);
      if (w > 0 && w !== lastW) {
        lastW = w;
        el.innerHTML = build(w, animate) || '';
        animate = false;
      }
    };
    const obs = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      // The observer always fires once right after observe(). If the sync
      // paint below already ran (animate now false), that first callback is
      // synthetic, not a real resize — adopt its width as the baseline and
      // skip the repaint so the entrance animation isn't cancelled a frame in.
      // (clientWidth from the sync paint can differ from contentRect.width if
      // layout shifts in between, so a width compare alone won't catch this.)
      if (!sawInitial) {
        sawInitial = true;
        if (!animate) { lastW = w; return; }
      }
      draw(w);
    });
    obs.observe(target);
    observers.set(containerId, obs);
    draw(target.clientWidth);
  }

  /** Render smoothed lines into a container. Pass empty `series` to clear.
   *  `zeroBase` floors the y axis at zero — see buildChartSVG. */
  function render(containerId, { series, slots, zeroBase }) {
    mount(containerId, series.length > 0 && slots.length > 0, (W, animate) =>
      buildChartSVG({ series, slots, W, animate, zeroBase }));
  }

  /** Map<key, colour>, assigned in order. `palette` is 'accent' (default) or
   *  'categorical'; see the palette block at the top of this file. */
  function colorMap(keys, palette) {
    const colors = readPalette(palette);
    return new Map(keys.map((k, i) => [k, colors[i % colors.length]]));
  }

  window.FinanceChart = { render, renderStacked, colorMap, PALETTE, CAT_PALETTE };
}());
