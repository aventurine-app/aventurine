'use strict';

// ─── Metrics (Reports) ───────────────────────────────────────────────────────
// A tab of the Reports page (pages/reports.html): the selected year's money,
// broken down, as TWO CARDS: the five headline totals (income, expenses,
// net, savings, invested), each carrying a sparkline of every tracked year
// under the number; and VITALS, the four ratios those totals imply, each drawn
// as a gauge with its ranges coloured in.
//
// Two cards rather than two sections of one: they answer two separate
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
  // Sparkline padding, as a percent of the chart box. The line is drawn in a
  // 0–100 box stretched to the tile's width (preserveAspectRatio="none"), so
  // the geometry is in percent and the height is
  // CSS (.met-spark). Vertical room is what keeps the marker dot on the
  // highest or lowest year inside the box; horizontally the line runs edge to
  // edge and overflow:visible lets the end dots overhang.
  const SPARK = { padX: 0, padY: 8 };

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
    const innerW = 100 - SPARK.padX * 2;
    const innerH = 100 - SPARK.padY * 2;
    const x = (i) => SPARK.padX + (i / (values.length - 1)) * innerW;
    // A flat series has no span to divide by; draw it down the middle.
    const y = (v) => SPARK.padY + (span === 0 ? innerH / 2 : innerH - ((v - min) / span) * innerH);
    const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    // The same line closed to the floor. The fill is what stops a run of pale
    // stroke from reading as a stray mark under the number it belongs to.
    const floor = (100 - SPARK.padY).toFixed(2);
    const area = `${x(0).toFixed(2)},${floor} ${pts} ${x(values.length - 1).toFixed(2)},${floor}`;
    // Two coordinate spaces in one picture: the line and its fill live in the
    // stretched inner box (non-scaling stroke keeps the line at CSS pixels),
    // and the marker sits in the outer, unstretched svg at percentage
    // coordinates, so it stays a circle at any tile width.
    const cx = x(activeIdx).toFixed(2);
    const cy = y(values[activeIdx]).toFixed(2);
    return `<svg class="met-spark" aria-hidden="true" focusable="false">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
        <polygon class="met-spark-area" points="${area}" />
        <polyline class="met-spark-line" points="${pts}" vector-effect="non-scaling-stroke" />
      </svg>
      <circle class="met-spark-dot" cx="${cx}%" cy="${cy}%" r="3" />
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
    <span class="met-figure-value">${escapeHtml(fmtMoney(value))}</span>
    ${changePill(change, goodWhenUp)}
    ${sparkline(s.values, s.idx)}
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

  // ─── Bodies ────────────────────────────────────────────────────────────────
  // One per card. The card frames, their titles and the info tooltip are
  // static markup in pages/reports.html — only the contents are rendered here,
  // so the year picker keeps the listener UI.wirePicker bound to it once.

  function figuresBody(y) {
    return `<div class="met-figures">
      ${figure('Income', y.income, y.changes.income, true, 'income')}
      ${figure('Expenses', y.expenses, y.changes.expenses, false, 'expenses')}
      ${figure('Net', y.net, y.changes.net, true, 'net')}
      ${figure('Savings', y.saved, y.changes.saved, true, 'saved')}
      ${figure('Invested', y.invested, y.changes.invested, true, 'invested')}
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
    const y = state.years.find((row) => row.year === state.year);

    // Nothing to report: the first card carries the empty state and the second
    // stays down, so an untouched database shows one invitation rather than two
    // empty frames.
    if (vitals) vitals.hidden = !y;
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
  }

  // ─── Year picker (mirrors the Cash Flow tab's) ─────────────────────────────

  // The chosen year is printed twice: in the picker button and as the shell's
  // heading, so the report's title and its control never disagree.
  function showYear(y) {
    const btn = document.getElementById('metrics-year-btn');
    const heading = document.getElementById('metrics-year-heading');
    if (btn) btn.textContent = y == null ? 'No data' : String(y);
    if (heading) heading.textContent = y == null ? '' : String(y);
  }

  function buildYearMenu() {
    const btn = document.getElementById('metrics-year-btn');
    const menu = document.getElementById('metrics-year-menu');
    if (!btn || !menu) return;

    if (!state.years.length) {
      showYear(null);
      btn.disabled = true;
      menu.innerHTML = '';
      return;
    }
    btn.disabled = false;
    showYear(state.year);
    menu.innerHTML = state.years
      .map((row) => `<button type="button" data-year="${row.year}">${row.year}</button>`)
      .join('');
  }

  function wireYearPicker() {
    UI.wirePicker('metrics-year-btn', 'metrics-year-menu', (b) => {
      const y = parseInt(b.dataset.year, 10);
      if (y === state.year) return;
      state.year = y;
      showYear(y);
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
