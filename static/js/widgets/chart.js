'use strict';

// ─── chart.js ────────────────────────────────────────────────────────────────
// Shared hand-rolled multi-series SVG chart, exposed as window.FinanceChart. A
// copy of the renderer the Dashboard uses (dashboard.js), moved into a reusable
// module so other pages (Spending Trends, and others later) get the same frame,
// smoothing, nice-tick axis, entrance animation and responsive redraw without a
// per-page copy. Dashboard and forecast still have their own copies and can
// migrate here later.
//
// Three forms share the frame: render() draws smoothed lines (one measure over
// time), renderStacked() draws stacked columns (a part-to-whole breakdown over
// time, for Reports → Investing), and renderArea() draws a stacked AREA (the
// same breakdown as one continuous shape, for Reports → Spending). They share
// niceTicks, the axis, the padding, the label stride and the responsive mount,
// which would otherwise be duplicated in a second widget file.
//
// STACKED COLUMNS vs STACKED AREA is a question about the months, not a style
// choice. Columns suit months that are separate deposits — a month with nothing
// put away is a real gap, and columns draw a gap. Spending is continuous: there
// is no month without any, so the months are samples of one running quantity
// and an unbroken shape is what that is. The area form is also the only one of
// the three with the visual mass to sit beside the Cash Flow sankey.
//
// Series shape:  [{ label, color, points: [{ year, monthIdx, value }], id? }]
//                `id` is optional and opaque: the stacked-area form stamps it on
//                each band as data-series, so a click in the plot names a series.
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
  //   'categorical'      — the --cat-* ramp (style.css). For a chart whose
  //       series are CATEGORIES rather than one measure over time. What that
  //       ramp IS depends on the graph palette: eight steps of the accent under
  //       Aventurine, eight distinct hues under Gemstone (themes.css).
  const PALETTE = [
    '#8fb088', '#5c7152', '#a9c1a4', '#33402d',
    '#7c9670', '#b6c8b2', '#647a59', '#5a6f50',
  ];
  const CAT_PALETTE = [
    '#1e2422', '#283a36', '#33514b', '#3e6860',
    '#4b7f75', '#659188', '#80a29c', '#99b3ae',
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

  // The y axis labels are set FLUSH LEFT at the SVG's own left edge rather than
  // right-aligned against the plot. The chart fills its card column, so x=0 is
  // the card's content edge — the same line the card title sits on, which is
  // what the labels line up with. Right-aligning them indented every label by
  // whatever it was short of the widest one, so a "$0" tick sat ~30px in from
  // the title above it and the card read as two left edges.
  const Y_LABEL_X = 0;

  // …and the plot then starts where the widest label ends, so CHART_PAD.l is
  // only the fallback. A fixed column was sized for the longest label a chart
  // might ever carry, which left an axis reading "$0 … $40" paying for one
  // reading "$120.5K": dead card between the numbers and the first gridline.
  // MEASURED, not counted per character, for the reason the Spending rail's
  // width is measured — the font, the theme and the app zoom all move it, and
  // a hard-coded width drifts the moment any of them changes. Floored so a
  // short axis still leaves the first x-axis label (centred on the plot's left
  // edge) inside the card, and capped so one freak label cannot eat the plot.
  const AXIS_LABEL_PX = 11;        // mirrors .chart-label in trends.css / forecast.css
  const AXIS_LABEL_TRACK = 0.05;   // …and its letter-spacing, in em
  const AXIS_GAP = 12;
  const AXIS_PAD_MIN = 28;
  const AXIS_PAD_MAX = 96;
  let labelCtx = null;

  function axisPadLeft(labels) {
    if (!labels.length) return CHART_PAD.l;
    let widest = 0;
    try {
      if (!labelCtx) labelCtx = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(document.documentElement);
      const family = cs.getPropertyValue('--font-h3').trim() || 'sans-serif';
      const weight = cs.getPropertyValue('--weight-semibold').trim() || '600';
      labelCtx.font = `${weight} ${AXIS_LABEL_PX}px ${family}`;
      for (const t of labels) {
        const track = t.length * AXIS_LABEL_PX * AXIS_LABEL_TRACK;
        widest = Math.max(widest, labelCtx.measureText(t).width + track);
      }
    } catch (_err) {
      return CHART_PAD.l;   // no canvas to measure with: keep the fixed column
    }
    return Math.round(Math.min(AXIS_PAD_MAX, Math.max(AXIS_PAD_MIN, widest + AXIS_GAP)));
  }
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

  // A chart is normally as tall as its width says (CHART_RATIO, floored at 170),
  // which is right for one sitting alone in a card. `fill` lets it take the box
  // it was given instead, for a chart laid out BESIDE something taller: the
  // Spending report puts the rail next to the plot, and on a narrow window the
  // rail is the taller of the two, so a ratio-only chart left a slab of card
  // under its x axis. It only ever GROWS to the box — a box shorter than the
  // ratio is left alone, since the answer to a cramped chart is not a flatter
  // one.
  function boxHeight(W, boxH = 0, fill = false) {
    const ratio = Math.max(Math.round(W * CHART_RATIO), 170);
    return fill ? Math.max(ratio, Math.round(boxH) || 0) : ratio;
  }

  function buildChartSVG({ series, slots, W, boxH = 0, fill = false, animate = true, zeroBase = false }) {
    const N = slots.length;
    const allValues = series.flatMap((s) => s.points.map((p) => p.value));
    if (allValues.length === 0) return null;

    const H = boxHeight(W, boxH, fill);
    const { r: PR, t: PT, b: PB } = CHART_PAD;
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

    // The axis labels are what set the left padding, so they are formatted
    // before the plot is measured rather than at the point they are drawn.
    const fmtAxis = axisFormatter(yTicks);
    const PL = axisPadLeft(yTicks.map(fmtAxis));
    const CW = W - PL - PR;

    const xScale = (i) => PL + (i / (N - 1 || 1)) * CW;
    const yScale = (v) => PT + CH - ((v - minVal) / valRange) * CH;
    const rnd = Math.random().toString(36).slice(2, 9);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${Y_LABEL_X}" y="${y}" text-anchor="start" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
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
      // A series the caller has marked `dim` stays drawn and steps back, which
      // is how the Spending rail's focus reads: the other categories are still
      // the context the focused one is being judged against, so removing them
      // would answer a different question. Styled in trends.css.
      const dim = s.dim ? ' data-dim="true"' : '';

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
        svg += `<path class="chart-area-fill" d="${areaD}" fill="url(#${gradId})"${dim} style="animation-delay:${delay + 400}ms"/>`;
        svg += `<path class="chart-line" d="${lineD}" pathLength="1" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"${dim} style="animation-delay:${delay}ms"/>`;
      }

      drawn.forEach((sl, di) => {
        const x = xScale(sl.i);
        const y = yScale(sl.value);
        const isEnd = di === drawn.length - 1;
        const dotDelay = Math.min(delay + 300 + di * 18, delay + 900);
        if (isEnd && linePts.length > 1) {
          svg += `<circle class="chart-pulse" cx="${x}" cy="${y}" r="4"${dim} style="stroke:${s.color}; animation-delay:${delay + 1100}ms"/>`;
        }
        svg += `<circle class="chart-dot${isEnd ? ' chart-dot-end' : ''}" cx="${x}" cy="${y}" r="${isEnd ? 4.5 : 3}" fill="${s.color}"${dim} style="animation-delay:${dotDelay}ms">
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
  /** Every value a stacked form needs, read once: a slot-indexed row per series
   *  plus the per-slot column totals. Shared by the columns and the area, which
   *  stack the same numbers and differ only in what they draw with them.
   *
   *  The lookup used to be a linear `find` over the series' points at every
   *  cell, which is series x slots x points reads — at a five-year window with a
   *  dozen categories that is six figures of comparisons before a single path is
   *  written, and it ran again on every resize callback. A slot a series has no
   *  point for counts as zero: a stack cannot skip a month the way a line can,
   *  since leaving one out would shift every band above it sideways. */
  function stackValues(series, slots) {
    const N = slots.length;
    const slotIndex = new Map(slots.map((sl, i) => [`${sl.year}-${sl.monthIdx}`, i]));
    const values = series.map((s) => {
      const row = new Array(N).fill(0);
      for (const p of s.points) {
        const i = slotIndex.get(`${p.year}-${p.monthIdx}`);
        if (i !== undefined) row[i] += Number(p.value) || 0;
      }
      return row;
    });
    const totals = slots.map((sl, i) => values.reduce((sum, row) => sum + row[i], 0));
    return { values, totals };
  }

  function topRoundedRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    if (rr < 1.5) return `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
    return `<path d="M ${x} ${y + h} L ${x} ${y + rr} A ${rr} ${rr} 0 0 1 ${x + rr} ${y}`
      + ` L ${x + w - rr} ${y} A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr} L ${x + w} ${y + h} Z"/>`;
  }

  function buildStackedSVG({ series, slots, W, animate = true }) {
    const N = slots.length;
    if (!N || !series.length) return null;

    const { values, totals } = stackValues(series, slots);
    const maxTotal = Math.max(...totals);
    if (!(maxTotal > 0)) return null;

    const H = boxHeight(W);
    const { r: PR, t: PT, b: PB } = CHART_PAD;
    const CH = H - PT - PB;

    const yTicks = niceTicks(0, maxTotal, 4);
    const maxVal = yTicks[yTicks.length - 1] || 1;
    const baseY = PT + CH;
    const yScale = (v) => baseY - (v / maxVal) * CH;

    // Labels first, then the plot: see axisPadLeft.
    const fmtAxis = axisFormatter(yTicks);
    const PL = axisPadLeft(yTicks.map(fmtAxis));
    const CW = W - PL - PR;

    const band = CW / N;
    const barW = Math.max(3, Math.min(BAR_MAX, band * 0.62));
    const xCentre = (i) => PL + band * (i + 0.5);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${Y_LABEL_X}" y="${y}" text-anchor="start" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
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
        .map((s, si) => ({ s, value: values[si][i] }))
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

  // ─── Stacked area ──────────────────────────────────────────────────────────
  // The same part-to-whole reading as the columns above, drawn as one filled
  // shape per series stacked on the one below. Written for Reports → Spending.
  //
  // Geometry notes:
  //   - Boundaries are STRAIGHT, not smoothed. Every other line in this file
  //     runs through smoothPath, but a stacked area is a set of CUMULATIVE
  //     boundaries whose only guarantee is that each sits at or above the one
  //     under it. Two clamped Catmull-Rom curves hold that at their endpoints
  //     and not in between, so a thin band under a steep one can cross its own
  //     neighbour mid-segment and paint a category as negative. Straight
  //     segments cannot.
  //   - The FIRST series is the bottom band. Callers hand them over biggest
  //     first, so the --cat-* ramp grades magnitude rather than identity — the
  //     rule the Cash Flow sankey already applies to its expense side.
  //   - The stack is REVEALED LEFT TO RIGHT, by one clip rect widening across
  //     every band at once, and not by each band rising from the baseline. The
  //     x axis is time, so a wipe along it plays the months in the order they
  //     happened, which is the same entrance the line form's stroke-dash draw
  //     already makes; growing upward animated along the value axis instead and
  //     read as the totals changing. One shared rect also means the bands
  //     arrive together, so the stack is never briefly a set of shapes that do
  //     not add up.
  //   - Bands are separated by their own GRADIENT, not by a stroke and not by a
  //     gap. An area has no air between its parts to take a gap out of, and a
  //     stroke in the card's colour drew a hard line through the middle of the
  //     shape — near-white on light and near-black on dark, which read as a
  //     border rather than as a seam. Each band instead runs full strength at
  //     its own TOP edge and fades toward its bottom, so every boundary is a
  //     strong edge meeting a faint one and the separation comes from the fill
  //     itself.
  //   - Bands sit at a fraction of full opacity and lift to full under the
  //     pointer, which is the Cash Flow sankey's ribbon idiom (0.42 resting,
  //     0.72 hovered) applied to a stack. The transparency is what lets the grid
  //     read through the fill, so the chart still has an axis behind it rather
  //     than six blocks of paint.
  //   - The y axis starts at zero, always, for the reason the columns do.
  //   - Values come from stackValues, shared with the columns above.
  //
  // The band's own fade, top edge to bottom edge. This is the gradient only —
  // the band's overall transparency is an `opacity` on the path (trends.css), so
  // hovering can lift the whole band without the fade having to be rebuilt. The
  // bottom stops well short of transparent: it is the boundary that has to stay
  // visible against the band under it, and a band that reached the card's colour
  // would look like a hole.
  const AREA_FILL_TOP = 1;
  const AREA_FILL_BOTTOM = 0.55;

  function buildAreaSVG({ series, slots, W, boxH = 0, fill = false, animate = true }) {
    const N = slots.length;
    if (!N || !series.length) return null;

    const { values, totals } = stackValues(series, slots);
    const maxTotal = Math.max(...totals);
    if (!(maxTotal > 0)) return null;

    const H = boxHeight(W, boxH, fill);
    const { r: PR, t: PT, b: PB } = CHART_PAD;
    const CH = H - PT - PB;

    const yTicks = niceTicks(0, maxTotal, 4);
    const maxVal = yTicks[yTicks.length - 1] || 1;
    const baseY = PT + CH;
    const yScale = (v) => baseY - (v / maxVal) * CH;

    // Labels first, then the plot: see axisPadLeft.
    const fmtAxis = axisFormatter(yTicks);
    const PL = axisPadLeft(yTicks.map(fmtAxis));
    const CW = W - PL - PR;
    const xScale = (i) => PL + (i / (N - 1 || 1)) * CW;
    const rnd = Math.random().toString(36).slice(2, 9);
    const f = (n) => Math.round(n * 100) / 100;

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${Y_LABEL_X}" y="${y}" text-anchor="start" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
    }
    svg += xAxisLabels(slots, xScale, H - PB + 18);

    // One hit strip per month, carrying that month's whole reading as a native
    // tooltip. The question a stack is read for ("what made up March") needs
    // every value at one x, which is what a strip can carry and a shape cannot.
    // The same strips are emitted twice, for two different jobs:
    //   - once UNDER the bands, so the empty plot above the stack still answers;
    //   - once inside each band, CLIPPED to that band's own shape, so the strip
    //     the pointer actually lands on belongs to a band and can light it up.
    // Hit testing takes the topmost element, so a clipped strip wins wherever
    // its band is drawn and the background strip answers everywhere else.
    //
    // Geometry and tooltip text are built ONCE per month here and the markup is
    // assembled from them, rather than re-formatting every series' value for
    // every band the strips are repeated into.
    const halfBand = CW / (N - 1 || 1) / 2;
    const strip = slots.map((sl, i) => {
      if (!(totals[i] > 0)) return null;
      const x0 = Math.max(PL, xScale(i) - halfBand);
      const x1 = Math.min(W - PR, xScale(i) + halfBand);
      const rows = series
        .map((sr, si) => ({ label: sr.label, value: values[si][i] }))
        .filter((p) => p.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((p) => `${p.label}: ${fmtTooltip(p.value)}`);
      const tip = [`${MONTHS[sl.monthIdx]} ${sl.year}`, ...rows, `Total: ${fmtTooltip(totals[i])}`].join('\n');
      return `<rect class="chart-hit" x="${f(x0)}" y="${PT}" width="${f(x1 - x0)}" height="${CH}" fill="transparent">`
        + `<title>${escapeHtml(tip)}</title></rect>`;
    });

    svg += strip.join('');

    // The entrance wipe. It used to be a clipPath on a GROUP wrapping every
    // band AND every band's copy of the strips, so an animating clip forced the
    // browser to re-clip that whole subtree each frame — hundreds of nested
    // clipped rects — which is what made the stack stutter and then appear all
    // at once. The clip goes on the band paths themselves instead: same reveal,
    // a handful of simple shapes to re-clip, and the transparent strips never
    // needed revealing.
    const clipId = `bandwipe-${rnd}`;
    svg += `<defs><clipPath id="${clipId}">`
      + `<rect class="chart-band-wipe" x="${PL}" y="${PT}" width="${CW}" height="${CH}"`
      + ` style="transform-origin:${PL}px 0px"/></clipPath></defs>`;

    let base = slots.map(() => 0);
    series.forEach((s, si) => {
      const row = values[si];
      const top = base.map((b, i) => b + row[i]);
      let d = `M ${f(xScale(0))} ${f(yScale(top[0]))}`;
      for (let i = 1; i < N; i++) d += ` L ${f(xScale(i))} ${f(yScale(top[i]))}`;
      for (let i = N - 1; i >= 0; i--) d += ` L ${f(xScale(i))} ${f(yScale(base[i]))}`;
      d += ' Z';

      // The gradient spans THIS band's own extent, not the whole plot. Anchored
      // to the plot it was one ramp sliced across every band, so a band's shade
      // said where it sat on the chart rather than where its own edges were,
      // and the bottom band — the thickest, and the one with a flat baseline to
      // read against — got almost none of the ramp at all.
      const yTop = Math.min(...top.map(yScale));
      const yBottom = Math.max(yTop + 1, ...base.map(yScale));
      const gradId = `bandgrad-${rnd}-${si}`;
      const bandClip = `bandclip-${rnd}-${si}`;
      svg += `<defs>
                <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse"
                                x1="0" y1="${f(yTop)}" x2="0" y2="${f(yBottom)}">
                    <stop offset="0%"   stop-color="${s.color}" stop-opacity="${AREA_FILL_TOP}"/>
                    <stop offset="100%" stop-color="${s.color}" stop-opacity="${AREA_FILL_BOTTOM}"/>
                </linearGradient>
                <clipPath id="${bandClip}"><path d="${d}"/></clipPath>
            </defs>`;
      // A band only repeats the strips for the months it actually occupies —
      // the neighbours count too, since the shape between two months slopes
      // across half of each strip beside them. The rest were emitted only to be
      // clipped away to nothing, and on a ledger where most categories are used
      // in a few months that was the bulk of the nodes in the chart.
      const bandStrips = strip
        .map((mk, i) => (mk && (row[i] > 0 || row[i - 1] > 0 || row[i + 1] > 0) ? mk : ''))
        .join('');
      // The group is what :hover is read off — the strips inside it are the hit
      // target, and CSS lifts the sibling path. The path carries no <title> of
      // its own: the strips cover it, so that title could never be reached, and
      // a band's name is already in the month reading they carry.
      // `s.id`, when the caller supplies one, rides out on the group so a click
      // in the plot can be traced back to the series without the page having to
      // re-derive it from a position — the series list it handed in is already
      // filtered, so an index would mean two places agreeing on that filter.
      // `s.active` marks the one series the caller has singled out, so CSS can
      // hold it at its hovered fill for as long as it is the selected one.
      svg += `<g class="chart-band-group"${s.id == null ? '' : ` data-series="${escapeHtml(String(s.id))}"`}${s.active ? ' data-active="true"' : ''}>`
        + `<path class="chart-band" d="${d}" fill="url(#${gradId})" clip-path="url(#${clipId})"${s.dim ? ' data-dim="true"' : ''}/>`
        + `<g clip-path="url(#${bandClip})">${bandStrips}</g>`
        + `</g>`;
      base = top;
    });

    svg += '</svg>';
    return svg;
  }

  /** Render a stacked area into a container. Pass empty `series` to clear.
   *  Series are drawn bottom-up in the order given. */
  function renderArea(containerId, { series, slots, fill }) {
    mount(containerId, series.length > 0 && slots.length > 0, (W, animate, boxH) =>
      buildAreaSVG({ series, slots, W, boxH, fill, animate }));
  }

  /** Render stacked columns into a container. Pass empty `series` to clear. */
  function renderStacked(containerId, { series, slots }) {
    mount(containerId, series.length > 0 && slots.length > 0, (W, animate) =>
      buildStackedSVG({ series, slots, W, animate }));
  }

  /** Draw into a container and keep it responsive: re-render on resize, with the
   *  first paint animating and resizes not. `build(W, animate, H)` returns the
   *  SVG for a given pixel width, with the container's measured height alongside
   *  it for the forms that fill their box (see `fill` in buildChartSVG). Shared
   *  by all three chart forms, which is the main reason stacked bars live in
   *  this file rather than a separate one. */
  function mount(containerId, hasData, build) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const existing = observers.get(containerId);
    if (existing) { existing.disconnect(); observers.delete(containerId); }

    if (!hasData) { el.innerHTML = ''; return; }

    const target = el.parentElement || el;
    let animate = true;       // flips off after the first successful paint
    let lastW = 0;
    let lastH = 0;
    let sawInitial = false;   // has the observer delivered its first callback?
    const draw = (w, h) => {
      w = Math.round(w);
      h = Math.round(h) || 0;
      // Height changes redraw too, for a chart told to fill its box. The 2px
      // tolerance is what keeps that from oscillating: a filled chart makes its
      // own container taller, so an exact compare would have every paint feed
      // the observer a new number to paint again.
      if (w > 0 && (w !== lastW || Math.abs(h - lastH) > 2)) {
        lastW = w;
        lastH = h;
        el.innerHTML = build(w, animate, h) || '';
        animate = false;
      }
    };
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const w = Math.round(width);
      // The observer always fires once right after observe(). If the sync
      // paint below already ran (animate now false), that first callback is
      // synthetic, not a real resize — adopt its width as the baseline and
      // skip the repaint so the entrance animation isn't cancelled a frame in.
      // (clientWidth from the sync paint can differ from contentRect.width if
      // layout shifts in between, so a width compare alone won't catch this.)
      if (!sawInitial) {
        sawInitial = true;
        if (!animate) { lastW = w; lastH = Math.round(height); return; }
      }
      draw(w, height);
    });
    obs.observe(target);
    observers.set(containerId, obs);
    draw(target.clientWidth, target.clientHeight);
  }

  /** Render smoothed lines into a container. Pass empty `series` to clear.
   *  `zeroBase` floors the y axis at zero and `fill` lets the chart take its
   *  container's height — see buildChartSVG. */
  function render(containerId, { series, slots, zeroBase, fill }) {
    mount(containerId, series.length > 0 && slots.length > 0, (W, animate, boxH) =>
      buildChartSVG({ series, slots, W, boxH, fill, animate, zeroBase }));
  }

  /** Map<key, colour>, assigned in order. `palette` is 'accent' (default) or
   *  'categorical'; see the palette block at the top of this file. */
  function colorMap(keys, palette) {
    const colors = readPalette(palette);
    return new Map(keys.map((k, i) => [k, colors[i % colors.length]]));
  }

  window.FinanceChart = { render, renderStacked, renderArea, colorMap, PALETTE, CAT_PALETTE };
}());
