'use strict';

// ─── Metrics (Reports) ───────────────────────────────────────────────────────
// A tab of the Reports page (pages/reports.html): the selected year's money,
// broken down, as THREE CARDS: the four headline totals, each carrying a
// sparkline of every tracked year; VITALS, the four ratios those totals imply,
// each drawn as a gauge with its ranges coloured in; and INFLATION, what the
// household's five big costs did against the year before, as five small-multiple
// lines sharing one scale.
//
// Three cards rather than three sections of one: they answer three separate
// questions, and the card border is the separator this page already uses (the
// Spending and Saved & Invested tabs are each two cards). The frames, titles and
// tooltips are static markup in pages/reports.html — this file fills them — so
// the year picker keeps the one listener UI.wirePicker bound to it.
//
// This is the old standalone "Yearly Report Card" page, which had no route into
// it, turned into a report. The shape changed with the move: a wall of one card
// per year became ONE year chosen from a picker, because that is how every other
// report on this page is read (Cash Flow picks a year, Spending and Forecast
// pick a window) and because a breakdown of six ratios needs the room that
// stacking every year at once was spending.
//
// THE RATIO TILES ARE GAUGES, not bars with a target on them. A meter that
// filled from the left graded the year in ONE place — the tip of the fill — so
// a reader had to already know what a good number was before the tile meant
// anything. The gauge inverts that: the whole track is pre-coloured into the
// three ranges the ratio can land in (`bands`, from the backend), the boundary
// between two ranges carries a tick and its percentage underneath, and the
// year's own value rides ABOVE the track in a waypoint pin that takes the
// colour of the range it landed in. The scale is readable before the value is,
// which is the thing the fill could not do.
//
// GRADING IS THREE-LEVEL, and it now comes from the band the value falls in
// rather than from the backend's per-goal `status`. That replaced the ✓/!/✕
// badge and the graded fill colour: with the ranges drawn on the track, a
// second verdict beside the number said the same thing twice. `goals` is still
// on the payload (other readers and the tests pin it) and this file no longer
// reads it — the two YoY pills grade themselves from `changes`.
//
// Colour is not the only carrier: each gauge is one role="img" whose label
// states the value, the range it fell in, and that range's verdict in words.
//
// All computation is server-side (GET /api/report-card, newest year first);
// this script picks a year out of the response and formats it. The picker
// mirrors the Cash Flow tab's year picker (widgets/cashflow-sankey.js).
//
// Globals (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), formatCurrency (currency.js), UI.emptyState (ui.js).

(function () {
  // Sparkline geometry, in user units. Drawn at this size 1:1 (no
  // preserveAspectRatio stretching) so the marker dot stays a circle and the
  // stroke keeps its width.
  const SPARK = { w: 82, h: 26, pad: 3 };

  // How close two of a gauge's boundary labels may sit, as a percent of the
  // track, before they are drawn as one range label instead of two crowded ones.
  // Sized for the NARROWEST the track ever gets — the four-column ratio grid just
  // above its 1100px breakpoint — and for a label to have AIR around it, not
  // merely to avoid overlapping: two percentages touching read as one number.
  const MIN_LABEL_GAP = 12;

  // Mirrors NEAR_TREND in electron/backend/services/reportCard.js: an adverse
  // year-over-year move smaller than this is "slightly off", not "off". The two
  // trend goals are graded on the pills rather than on a tile, so this is the
  // one grading threshold the renderer has to hold a copy of.
  const NEAR_TREND = 0.02;

  const state = {
    years: [],    // the /api/report-card rows, newest first
    year: null,   // selected year (number)
    asc: [],      // the same rows oldest-first — the sparklines' x axis
    bands: {},    // metric key → the gauge's coloured ranges (from the payload)
  };

  // ─── Formatting ────────────────────────────────────────────────────────────

  const fmtMoney = (n) => formatCurrency(n, true);

  /** A 0..1 ratio as a whole-ish percent ("62%"); null → "N/A". */
  function fmtPct(ratio) {
    if (ratio == null || !Number.isFinite(ratio)) return 'N/A';
    return `${Math.round(ratio * 100)}%`;
  }

  /** A 0..1 ratio as a position along the gauge track, in percent. */
  const clampPct = (r) => Math.max(0, Math.min(1, r)) * 100;

  /** A signed percentage change ("+8%", "−3%"); null → "—". */
  function fmtSignedPct(frac) {
    if (frac == null || !Number.isFinite(frac)) return '—';
    const pct = Math.round(Math.abs(frac) * 100);
    return `${frac < 0 ? '−' : '+'}${pct}%`;
  }

  function infoIcon(tip) {
    const t = escapeHtml(tip);
    return `<span class="fc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">i</span>`;
  }

  // ─── Sparkline ─────────────────────────────────────────────────────────────

  /**
   * One figure's value across every tracked year, with the selected year's point
   * marked. Scaled to the series' min..max, since it shows shape rather than
   * magnitude (the figure beside it gives the magnitude), and skipped below two
   * points, where there is no trend to draw.
   *
   * aria-hidden: the pill underneath already states the change in words and
   * every plotted value is one year-pick away, so this adds emphasis, not
   * information.
   */
  function sparkline(values, activeIdx) {
    if (!values || values.length < 2 || activeIdx < 0) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const innerW = SPARK.w - SPARK.pad * 2;
    const innerH = SPARK.h - SPARK.pad * 2;
    const x = (i) => SPARK.pad + (i / (values.length - 1)) * innerW;
    // A flat series has no span to divide by; draw it down the middle.
    const y = (v) => SPARK.pad + (span === 0 ? innerH / 2 : innerH - ((v - min) / span) * innerH);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    // The same line closed to the floor. The fill is what stops 80px of pale
    // stroke from reading as a stray mark next to the number it belongs to.
    const area = `${SPARK.pad},${SPARK.h - SPARK.pad} ${pts} ${SPARK.w - SPARK.pad},${SPARK.h - SPARK.pad}`;
    return `<svg class="met-spark" width="${SPARK.w}" height="${SPARK.h}"
      viewBox="0 0 ${SPARK.w} ${SPARK.h}" aria-hidden="true" focusable="false">
      <polygon class="met-spark-area" points="${area}" />
      <polyline class="met-spark-line" points="${pts}" />
      <circle class="met-spark-dot" cx="${x(activeIdx).toFixed(1)}" cy="${y(values[activeIdx]).toFixed(1)}" r="2.4" />
    </svg>`;
  }

  /** Every tracked year's value for one figure, oldest first, plus the index of
   *  the selected year within it. */
  function seriesFor(field) {
    return {
      values: state.asc.map((row) => (Number.isFinite(row[field]) ? row[field] : 0)),
      idx: state.asc.findIndex((row) => row.year === state.year),
    };
  }

  // ─── Pieces ────────────────────────────────────────────────────────────────

  /**
   * A year-over-year change pill under a headline figure. `goodWhenUp` colours
   * an increase green (income) or red (expenses).
   *
   * Growth from a non-positive prior year has no finite percentage, so the pill
   * falls back to the ABSOLUTE change rather than a special word: it is still a
   * real, signed movement, so it can carry the same arrow and the same
   * good/bad colour as every other pill. (It used to render a green "new"
   * whatever the figure was, which painted an expense appearing out of nowhere
   * as good news.)
   */
  function changePill(change, goodWhenUp) {
    if (!change) return '<span class="met-change met-change-none">first year</span>';
    const usePct = change.pct != null && Number.isFinite(change.pct);
    const delta = usePct ? change.pct : change.abs;
    const epsilon = usePct ? 0.0005 : 0.005;
    const up = delta > epsilon;
    const down = delta < -epsilon;
    const arrow = up ? '▲' : down ? '▼' : '■';
    const good = up ? goodWhenUp : down ? !goodWhenUp : null;
    // Adverse, but barely: the same amber a gauge's caution range uses. Only
    // on the percentage form — NEAR_TREND is a share, and the
    // fallback below is money, which has no comparable band.
    const near = good === false && usePct && Math.abs(change.pct) <= NEAR_TREND;
    const tone = good === null ? 'flat' : good ? 'good' : near ? 'near' : 'bad';
    const text = usePct ? fmtSignedPct(change.pct) : fmtMoney(Math.abs(change.abs));
    return `<span class="met-change met-change-${tone}">${arrow} ${escapeHtml(text)} YoY</span>`;
  }

  function figure(label, value, change, goodWhenUp, field) {
    const neg = Number.isFinite(value) && value < 0 ? ' met-figure-negative' : '';
    const s = seriesFor(field);
    return `<div class="met-figure${neg}">
    <span class="met-figure-label">${escapeHtml(label)}</span>
    <div class="met-figure-row">
      <span class="met-figure-value">${escapeHtml(fmtMoney(value))}</span>
      ${sparkline(s.values, s.idx)}
    </div>
    ${changePill(change, goodWhenUp)}
  </div>`;
  }

  // tone → the verdict, in words. The gauge is coloured, so the words are what
  // stop the verdict from being carried by colour alone; they go in the one
  // aria-label the gauge exposes, not on screen, because the ticks and the pin's
  // position already say it visually.
  const TONE_WORD = { good: 'on target', caution: 'caution', bad: 'off target' };

  /**
   * The range a ratio lands in: the FIRST band whose `to` it does not exceed, so
   * a value sitting exactly on a boundary belongs to the range below it (70%
   * expenses is inside "under 70%"), and a value off either end of the 0–100%
   * track clamps into an end range with no extra rule.
   */
  function bandFor(bands, ratio) {
    if (!bands || !bands.length) return null;
    if (ratio == null || !Number.isFinite(ratio)) return null;
    return bands.find((b) => ratio <= b.to) || bands[bands.length - 1];
  }

  /**
   * The gauge: a 0–100% track pre-coloured into its ranges, a tick and a label
   * at each boundary between two of them, and the year's value as a waypoint pin
   * above the track wearing the range's colour.
   *
   * ONLY the interior boundaries get a tick and a number. The track's two ends
   * ARE 0% and 100%, so labelling them would spend two more numbers saying what
   * the track's extent already says, on a tile that has three of them already.
   *
   * The pin is centred on the true value even at the extremes, where it overhangs
   * the track by about half its width. That overhang lands in the grid gutter or
   * the card padding (both 28px), and a pin nudged inwards to avoid it would be
   * pointing at a percentage the year did not have.
   *
   * role="img" with one label, because every part of this is one reading: read
   * out piecemeal it would be a list of coordinates.
   */
  function gauge(label, ratio, bands) {
    if (!bands || !bands.length) return '';

    const segs = bands
      .map((b) => {
        const from = clampPct(b.from);
        const width = Math.max(0, clampPct(b.to) - from);
        return `<span class="met-gauge-band met-gauge-${b.tone}" style="left:${from.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
      })
      .join('');

    const bounds = bands.slice(0, -1).map((b) => b.to);
    const ticks = bounds
      .map((at) => `<span class="met-gauge-tick" style="left:${clampPct(at).toFixed(3)}%"></span>`)
      .join('');
    // Two boundaries closer together than a label is wide get ONE label spanning
    // them ("15–20%"), centred between the pair. That is the right reading
    // anyway where a narrow band is bracketed by two boundaries — it names the
    // band — and it is the only way to keep both numbers when they will not fit
    // side by side.
    const groups = [];
    bounds.forEach((at) => {
      const last = groups[groups.length - 1];
      const near = last && clampPct(at) - clampPct(last[last.length - 1]) < MIN_LABEL_GAP;
      if (near) last.push(at);
      else groups.push([at]);
    });
    const scale = groups
      .map((g) => {
        const lo = clampPct(g[0]);
        const hi = clampPct(g[g.length - 1]);
        const text = g.length === 1
          ? fmtPct(g[0])
          : `${Math.round(g[0] * 100)}–${fmtPct(g[g.length - 1])}`;
        return `<span class="met-gauge-mark" style="left:${((lo + hi) / 2).toFixed(3)}%">${escapeHtml(text)}</span>`;
      })
      .join('');

    // The pin carries the value at the size the tile's headline number used to
    // be, because it IS that number now — printing it a second time under the
    // label said the same percentage twice, 30px apart. A ratio with no value
    // has nowhere on the track to stand, so it says so in the pin's lane instead
    // of leaving the tile with a label and an empty gauge.
    const hit = bandFor(bands, ratio);
    const pin = hit
      ? `<span class="met-pin met-pin-${hit.tone}" style="left:${clampPct(ratio).toFixed(3)}%">${escapeHtml(fmtPct(ratio))}</span>`
      : '<span class="met-gauge-none">N/A</span>';

    const reading = hit
      ? `${fmtPct(ratio)}, ${TONE_WORD[hit.tone]}, in the ${fmtPct(hit.from)} to ${fmtPct(hit.to)} range`
      : 'no value for this year';

    return `<div class="met-gauge" role="img" aria-label="${escapeHtml(`${label}: ${reading}`)}">
      <div class="met-gauge-pins">${pin}</div>
      <div class="met-gauge-track">${segs}${ticks}</div>
      <div class="met-gauge-scale">${scale}</div>
    </div>`;
  }

  /**
   * One ratio tile: the label, and the gauge that carries the value on its pin.
   *
   * There is NO headline percentage under the label. The pin says the same
   * number in the same size, and having both put one percentage on the tile
   * twice within a few pixels.
   */
  function metric(label, ratio, tip, opts) {
    const o = opts || {};
    const bands = (o.key && state.bands[o.key]) || null;
    const known = ratio != null && Number.isFinite(ratio);
    const na = known ? '' : ' met-metric-na';

    return `<div class="met-metric${na}">
    <div class="met-metric-label">${escapeHtml(label)}${infoIcon(tip)}</div>
    ${gauge(label, ratio, bands)}
  </div>`;
  }

  // ─── Inflation ─────────────────────────────────────────────────────────────
  // What each of the household's big costs did, year on year. Five small
  // multiples of the same chart — a line across the years, over and under a 0%
  // line — plus the whole year's expense change as the section's headline.
  //
  // A LINE, not columns. Five bars per chart times five charts is twenty-five
  // filled rectangles plus their two-tone colouring, and at ~90px tall that
  // reads as texture rather than as five trends. A line states the shape with
  // one mark, and the fill between it and 0% carries the sign — above the line
  // the cost rose, below it fell — so the colour is a consequence of the
  // geometry rather than a second thing to decode.
  //
  // THE FIVE CHARTS SHARE ONE SCALE, which is the point of drawing them as small
  // multiples rather than five independent charts. Scaled to its own data, a 3%
  // rise in Utilities and a 60% rise in Rent draw the identical line, and the one
  // question the section exists to answer — what got more expensive — becomes
  // unanswerable without reading five separate axes.
  //
  // THE LINE IS THE ONLY MARK. No point dots, no end caps, no out-of-range
  // arrowheads: at five charts by five years that is twenty-five symbols laid
  // over the thing they are annotating, and the shape is what the chart is for.
  // The per-year figures stay reachable through invisible full-height hover
  // strips, so dropping the symbols costs no value.
  //
  // SVG for the line, HTML for everything around it. The plot is drawn in a
  // 0–100 box with preserveAspectRatio="none" so it fills whatever width the
  // grid gives it, which would stretch a stroke and squash a dot — so the stroke
  // is `vector-effect="non-scaling-stroke"` and the dots are HTML positioned in
  // the same percentage space, which also keeps every axis label crisp text
  // rather than type scaled by a viewBox.

  // How many years of change each chart plots, ending with the selected one.
  const INF_YEARS = 5;

  // The furthest the shared axis will reach, in percentage points. A category
  // that barely existed one year and is normal the next produces a change in the
  // hundreds — and on a SHARED scale that one point flattens every other line to
  // the floor, which is the exact failure the shared scale was chosen to avoid.
  // So the axis stops at a doubling and a point past it is PINNED to the edge;
  // its real figure is still on the category's own label and in the year's
  // tooltip, so nothing is lost but the unreadable height.
  const INF_CLAMP = 100;

  // How far apart two axis labels must sit, as a percent of the plot's height,
  // before both are drawn. A lopsided scale (a 40% rise against a 0.5% dip) puts
  // its bound within a pixel or two of the 0% label; the bound is the one to
  // drop, since 0% is what every bar is measured from.
  const INF_TICK_GAP = 18;

  /** The tracked years in the chart's window, oldest first. Years the ledger
   *  does not track are simply absent rather than drawn empty — the x axis is
   *  the years there ARE, not a calendar. */
  function inflationWindow() {
    return state.asc.filter((r) => r.year <= state.year && r.year > state.year - INF_YEARS);
  }

  /** A round bound at or above `m` percentage points, so the axis ends on a
   *  number worth printing. */
  function niceBound(m) {
    if (!(m > 0)) return 0;
    const pow = Math.pow(10, Math.floor(Math.log10(m)));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) if (m <= step * pow) return step * pow;
    return 10 * pow;
  }

  /** An axis tick, in percentage points ("+20%", "0%", "\u22125%"). */
  function fmtTick(pp) {
    const n = Math.round(Math.abs(pp) * 10) / 10;
    return `${pp > 0 ? '+' : pp < 0 ? '\u2212' : ''}${n}%`;
  }

  function inflation(y) {
    const rows = inflationWindow();

    // Order and names come from the SELECTED year's row, so a renamed category
    // is charted under the name it has now.
    const cats = (y.inflation || []).map((c) => ({
      key: c.key,
      name: c.name,
      points: rows.map((r) => {
        const hit = (r.inflation || []).find((x) => x.key === c.key);
        return { year: r.year, pct: hit ? hit.pct : null };
      }),
    }));

    // A category the ledger has never charged anything to has no rise to report,
    // so it is left out rather than drawn empty.
    const drawn = cats.filter((c) => c.points.some((p) => p.pct != null));
    if (!drawn.length) {
      return '<p class="met-section-empty">Needs a second year of expenses to compare.</p>';
    }

    const vals = drawn
      .flatMap((c) => c.points.map((p) => p.pct))
      .filter((v) => v != null)
      .map((v) => v * 100);
    let hi = Math.min(niceBound(Math.max(0, ...vals)), INF_CLAMP);
    const lo = Math.max(-niceBound(Math.max(0, -Math.min(0, ...vals))), -INF_CLAMP);
    // Every change was exactly zero: there is no span to divide by, so give the
    // axis a nominal one and let every bar sit flat on the line.
    if (hi - lo === 0) hi = 1;

    const span = hi - lo;
    const frac = (v) => (v - lo) / span;
    // 0% sits at the ORIGIN whenever nothing fell — it only lifts off the floor
    // to make room for the years a cost came down.
    const topPct = (v) => (1 - frac(v)) * 100;

    // 0% is always drawn; a bound joins it only when there is room for both, and
    // only when it is not 0% under another name (an all-rises year has lo = 0).
    const zTop = topPct(0);
    const ticks = [];
    if (hi > 0 && Math.abs(topPct(hi) - zTop) >= INF_TICK_GAP) ticks.push([topPct(hi), fmtTick(hi)]);
    ticks.push([zTop, '0%']);
    if (lo < 0 && Math.abs(topPct(lo) - zTop) >= INF_TICK_GAP) ticks.push([topPct(lo), fmtTick(lo)]);
    const yAxis = ticks
      .map(([at, text]) => `<span class="inf-y-tick${text === '0%' ? ' inf-y-zero' : ''}" style="top:${at.toFixed(3)}%">${escapeHtml(text)}</span>`)
      .join('');

    const charts = drawn.map((c) => {
      const here = c.points.find((p) => p.year === state.year);
      const arrow = (v) => (v > 0 ? '\u25b2' : v < 0 ? '\u25bc' : '\u25a0');
      const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
      const head = here && here.pct != null
        ? `<span class="inf-cat-pct inf-${tone(here.pct)}">${escapeHtml(`${arrow(here.pct)} ${fmtSignedPct(here.pct)}`)}</span>`
        : '<span class="inf-cat-pct inf-flat">\u2014</span>';

      const n = c.points.length;
      // A year sits at the middle of its share of the width, which is also where
      // its label sits under the plot — the two are laid out in the same
      // percentage space so they cannot drift apart.
      const xAt = (i) => ((i + 0.5) / n) * 100;

      const plotted = c.points.map((p, i) => {
        if (p.pct == null) return null;
        // Past the shared axis' bound the line is pinned to the edge. Nothing
        // marks the point — the chart carries no symbols at all — so a pinned
        // line reads as "at or past the top", and the exact figure is on the
        // category's label and in the year's tooltip.
        const v = Math.max(lo, Math.min(hi, p.pct * 100));
        return { year: p.year, pct: p.pct, x: xAt(i), y: topPct(v) };
      });

      // The line breaks over a year with no comparison rather than leaping it,
      // so a gap in the ledger reads as a gap.
      const runs = [];
      plotted.forEach((pt) => {
        if (!pt) { runs.push(null); return; }
        const last = runs[runs.length - 1];
        if (Array.isArray(last)) last.push(pt);
        else runs.push([pt]);
      });
      const segs = runs.filter((r) => Array.isArray(r));

      // Two clipped copies of the same area, split at the 0% line: what is above
      // it is a cost that rose, what is below it is one that fell. Ids are keyed
      // by category, which is unique within the section.
      const upId = `inf-up-${c.key}`;
      const downId = `inf-down-${c.key}`;
      const areas = segs
        .filter((run) => run.length > 1)
        .map((run) => {
          const pts = run.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
          const back = `${run[run.length - 1].x.toFixed(2)},${zTop.toFixed(2)} ${run[0].x.toFixed(2)},${zTop.toFixed(2)}`;
          return `<polygon class="inf-area inf-area-up" clip-path="url(#${upId})" points="${pts} ${back}" />
            <polygon class="inf-area inf-area-down" clip-path="url(#${downId})" points="${pts} ${back}" />`;
        })
        .join('');
      const lines = segs
        .filter((run) => run.length > 1)
        .map((run) => `<polyline class="inf-stroke" vector-effect="non-scaling-stroke"
          points="${run.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ')}" />`)
        .join('');

      // Nothing is drawn for a point, so the values need a hover target that is
      // not a mark: one invisible strip per year, the full height of the plot.
      // Every figure stays reachable by pointer without putting a shape on a
      // chart that is meant to carry only the line.
      const hits = c.points
        .map((p, i) => `<span class="inf-hit" style="left:${(i / n) * 100}%;width:${(100 / n)}%"
          title="${escapeHtml(`${p.year}: ${p.pct == null ? 'no comparison' : fmtSignedPct(p.pct)}`)}"></span>`)
        .join('');

      const xs = c.points
        .map((p) => `<span class="inf-x-label${p.year === state.year ? ' inf-x-current' : ''}">${p.year}</span>`)
        .join('');

      // One label for the whole chart: read out mark by mark it would be a list
      // of coordinates.
      const spoken = c.points
        .map((p) => `${p.year} ${p.pct == null ? 'no comparison' : fmtSignedPct(p.pct)}`)
        .join(', ');

      return `<div class="inf-cat">
        <div class="inf-cat-head">
          <span class="inf-cat-name">${escapeHtml(c.name)}</span>
          ${head}
        </div>
        <div class="inf-chart" role="img" aria-label="${escapeHtml(`${c.name}, year-on-year change: ${spoken}`)}">
          <div class="inf-y">${yAxis}</div>
          <div class="inf-plot">
            <span class="inf-zero" style="top:${zTop.toFixed(3)}%"></span>
            <svg class="inf-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <defs>
                <clipPath id="${upId}"><rect x="0" y="0" width="100" height="${Math.max(0, zTop).toFixed(3)}" /></clipPath>
                <clipPath id="${downId}"><rect x="0" y="${zTop.toFixed(3)}" width="100" height="${Math.max(0, 100 - zTop).toFixed(3)}" /></clipPath>
              </defs>
              ${areas}${lines}
            </svg>
            ${hits}
          </div>
          <div class="inf-x">${xs}</div>
        </div>
      </div>`;
    }).join('');

    return `<div class="met-inflation">${charts}</div>`;
  }

  // ─── Bodies ────────────────────────────────────────────────────────────────
  // One per card. The card frames, their titles and the two info tooltips are
  // static markup in pages/reports.html — only the contents are rendered here,
  // so the year picker keeps the listener UI.wirePicker bound to it once.

  function figuresBody(y) {
    return `<div class="met-figures">
      ${figure('Income', y.income, y.changes.income, true, 'income')}
      ${figure('Expenses', y.expenses, y.changes.expenses, false, 'expenses')}
      ${figure('Net', y.net, y.changes.net, true, 'net')}
      ${figure('Saved & Invested', y.transfers, y.changes.transfers, true, 'transfers')}
    </div>`;
  }

  function vitalsBody(y) {
    return `<div class="met-metrics">
      ${metric('Expense-to-Income', y.metrics.expenseToIncome,
        'Total expenses divided by total income. Lower is better — under 70% earns full marks.',
        { key: 'expenseToIncome' })}
      ${metric('Debt-to-Income', y.metrics.debtToIncome,
        'Total debt from your Balance Sheet (latest month this year) divided by the year’s income. Shows N/A when you track no debt. Under 25% earns full marks.',
        { key: 'debtToIncome' })}
      ${metric('Savings Rate', y.metrics.savingsRate,
        'The share of income you moved into your own savings or brokerage accounts, across every transfer category. 20% or more earns full marks.',
        { key: 'savingsRate' })}
      ${metric('Investing Rate', y.metrics.investedRate,
        'The share of income that went to the Investing category specifically. Money moved to any other transfer category counts towards the savings rate, not this one. 15% to 40% is the healthy range.',
        { key: 'investedRate' })}
    </div>`;
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  function render() {
    const host = document.getElementById('metrics-body');
    if (!host) return;
    const vitals = document.getElementById('metrics-vitals-card');
    const infl = document.getElementById('metrics-inflation-card');
    const y = state.years.find((row) => row.year === state.year);

    // Nothing to report: the first card carries the empty state and the other
    // two stay down, so an untouched database shows one invitation rather than
    // three empty frames.
    if (vitals) vitals.hidden = !y;
    if (infl) infl.hidden = !y;
    if (!y) {
      host.innerHTML = UI.emptyState({
        icon: 'target',
        title: 'No metrics yet',
        desc: 'Add a year of income and expenses and Aventurine works out the ratios behind it, and grades the year against six money goals.',
        action: { label: 'Add transactions', href: '/transactions', primary: true },
      });
      return;
    }

    host.innerHTML = figuresBody(y);
    const vitalsHost = document.getElementById('metrics-vitals');
    if (vitalsHost) vitalsHost.innerHTML = vitalsBody(y);
    const inflHost = document.getElementById('metrics-inflation');
    if (inflHost) inflHost.innerHTML = inflation(y);
    // The Inflation card's own figure: the year's whole expense change, in the
    // same pill the headline figures carry, sitting where the other cards' range
    // pickers do.
    const inflFig = document.getElementById('metrics-inflation-figure');
    if (inflFig) inflFig.innerHTML = `<span class="met-section-figure">${changePill(y.changes.expenses, false)}</span>`;
  }

  // ─── Year picker (mirrors the Cash Flow tab's) ─────────────────────────────

  function buildYearMenu() {
    const btn = document.getElementById('metrics-year-btn');
    const menu = document.getElementById('metrics-year-menu');
    if (!btn || !menu) return;

    if (!state.years.length) {
      btn.textContent = 'No data';
      btn.disabled = true;
      menu.innerHTML = '';
      return;
    }
    btn.disabled = false;
    btn.textContent = String(state.year);
    menu.innerHTML = state.years
      .map((row) => `<button type="button" data-year="${row.year}">${row.year}</button>`)
      .join('');
  }

  function wireYearPicker() {
    UI.wirePicker('metrics-year-btn', 'metrics-year-menu', (b) => {
      const y = parseInt(b.dataset.year, 10);
      if (y === state.year) return;
      state.year = y;
      document.getElementById('metrics-year-btn').textContent = String(y);
      render();
    });
  }

  async function load() {
    const res = await apiFetch('/api/report-card');
    if (!res.ok) return;
    const data = await res.json();
    // The endpoint sorts newest-first, which the picker and the default selection
    // both rely on. The sparklines need ascending order, so that copy is made once
    // here rather than per figure per render.
    state.years = data.years || [];
    state.asc = [...state.years].sort((a, b) => a.year - b.year);
    // The coloured ranges are a constant of the report, not of a year, so they
    // ride once on the response rather than on every card.
    state.bands = data.bands || {};
    if (state.year === null || !state.years.some((row) => row.year === state.year)) {
      state.year = state.years.length ? state.years[0].year : null;
    }
    buildYearMenu();
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('metrics-body')) return;
    wireYearPicker();
    window.addEventListener('currencychange', render);
    load();
  });
}());
