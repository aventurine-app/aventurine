'use strict';

// ─── chart.js ────────────────────────────────────────────────────────────────
// Shared hand-rolled multi-series SVG line chart, exposed as window.FinanceChart.
// It's a faithful copy of the renderer the Home dashboard uses (home.js), lifted
// into a reusable module so other pages (Spending Trends, and later others) get
// the identical frame, smoothing, nice-tick axis, entrance animation, and
// responsive redraw — without a per-page copy. Home/forecast keep their own code
// for now; they can migrate here later.
//
// Series shape:  [{ label, color, points: [{ year, monthIdx, value }] }]
// Slots:         [{ year, monthIdx }]  — the x-axis columns to plot across.
//
// Uses the existing globals escapeHtml (escape.js) and CURRENCY_SYMBOL
// (currency.js), which the page loads before this file.

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const _RE_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

  // Default palette (matches home.js ACCOUNT_COLORS) — cycled per series.
  const PALETTE = [
    'rgba(120,185,255,0.9)',
    'rgba(100,210,140,0.9)',
    'rgba(255,165,80,0.9)',
    'rgba(180,130,255,0.9)',
    'rgba(255,120,170,0.9)',
    'rgba(255,210,80,0.9)',
    'rgba(80,210,200,0.9)',
    'rgba(255,100,100,0.9)',
  ];

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

  function fmtAxis(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1_000_000) return sign + CURRENCY_SYMBOL + (abs / 1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000) return sign + CURRENCY_SYMBOL + (abs / 1_000).toFixed(0) + 'K';
    return sign + CURRENCY_SYMBOL + abs.toFixed(0);
  }

  function fmtTooltip(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const [intPart, decPart] = abs.toFixed(2).split('.');
    return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
  }

  function smoothPath(pts) {
    const f = (n) => Math.round(n * 100) / 100;
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
    let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      d += ` C ${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)},`
        + ` ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)},`
        + ` ${f(p2.x)} ${f(p2.y)}`;
    }
    return d;
  }

  function buildChartSVG({ series, slots, W, animate = true }) {
    const N = slots.length;
    const allValues = series.flatMap((s) => s.points.map((p) => p.value));
    if (allValues.length === 0) return null;

    const H = Math.max(Math.round(W * CHART_RATIO), 170);
    const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
    const CW = W - PL - PR;
    const CH = H - PT - PB;

    const yTicks = niceTicks(Math.min(...allValues), Math.max(...allValues), 4);
    const minVal = yTicks[0];
    const maxVal = yTicks[yTicks.length - 1];
    const valRange = maxVal - minVal || 1;

    const xScale = (i) => PL + (i / (N - 1 || 1)) * CW;
    const yScale = (v) => PT + CH - ((v - minVal) / valRange) * CH;
    const rnd = Math.random().toString(36).slice(2, 9);

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="home-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtAxis(v)}</text>`;
    }

    if (minVal < 0 && maxVal > 0) {
      const y0 = yScale(0);
      svg += `<line class="chart-zero" x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}"/>`;
    }

    const multiYear = new Set(slots.map((s) => s.year)).size > 1;
    const stride = N <= 8 ? 1 : N <= 14 ? 2 : N <= 26 ? 3 : 6;
    const lastDist = (N - 1) % stride;
    slots.forEach((s, i) => {
      const isLast = i === N - 1;
      if (!isLast && i % stride !== 0) return;
      if (isLast && lastDist !== 0 && lastDist < 2) return;
      const label = (multiYear && s.monthIdx === 0) ? s.year : MONTHS_SHORT[s.monthIdx];
      svg += `<text class="chart-label" x="${xScale(i)}" y="${H - PB + 18}" text-anchor="middle">${label}</text>`;
    });

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

  /** Render into a container and keep it responsive (re-render on resize; the
   *  first paint animates, resizes don't). Pass empty `series` to clear. */
  function render(containerId, { series, slots }) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const existing = observers.get(containerId);
    if (existing) { existing.disconnect(); observers.delete(containerId); }

    if (!series.length || !slots.length) { el.innerHTML = ''; return; }

    const target = el.parentElement || el;
    let animate = true;       // flips off after the first successful paint
    let lastW = 0;
    let sawInitial = false;   // has the observer delivered its first callback?
    const draw = (w) => {
      w = Math.round(w);
      if (w > 0 && w !== lastW) {
        lastW = w;
        el.innerHTML = buildChartSVG({ series, slots, W: w, animate }) || '';
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

  function colorMap(keys) {
    return new Map(keys.map((k, i) => [k, PALETTE[i % PALETTE.length]]));
  }

  window.FinanceChart = { render, colorMap, PALETTE };
}());
