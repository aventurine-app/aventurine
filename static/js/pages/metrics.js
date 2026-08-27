'use strict';

// ─── Metrics (Reports) ───────────────────────────────────────────────────────
// A tab of the Reports page (pages/reports.html): the selected year's money,
// broken down. One composition bar splitting the year's income into what was
// spent / put away / left, four headline totals each carrying a sparkline of
// every tracked year, and the six ratios those totals imply, drawn as meters
// with the goal targets notched on them.
//
// This is the old standalone "Yearly Report Card" page, which had no route into
// it, turned into a report. The shape changed with the move: a wall of one card
// per year became ONE year chosen from a picker, because that is how every other
// report on this page is read (Cash Flow picks a year, Spending and Forecast
// pick a window) and because a breakdown of six ratios needs the room that
// stacking every year at once was spending.
//
// The GOALS ARE NOT A SECTION. They used to be a list under the ratios, and
// every one of them restated a number already on the card: four ARE ratio tiles
// (expenses vs 70% of income, debt vs 25%, saving vs 20%, investing vs its
// 15–20% band) and two ARE the year-over-year pills on Income and Expenses. So
// each goal is now drawn where its number already lives — a target notch and a
// badge on the tile, the pill's own colour on the trends — which grades the
// same six goals without printing any of them twice.
//
// GRADING IS THREE-LEVEL, not pass/fail: hit or beaten (green), slightly off
// (amber), off (red). The levels come from the backend's `status`; this file
// never decides one. That is also why the meter fill is no longer one flat hue
// — the verdict is the thing worth seeing from across the card, and an 18px
// badge is too small to be the only place it is said.
//
// All computation is server-side (GET /api/report-card, newest year first);
// this script picks a year out of the response and formats it. The picker
// mirrors the Cash Flow tab's year picker (widgets/cashflow-sankey.js).
//
// Globals (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), formatCurrency (currency.js), UI.emptyState (ui.js).

(function () {
  // Goal key → the metrics field whose tile grades it. The other two goals
  // (spending_trend, income_trend) are graded by the YoY pill on their figure,
  // so they have no tile and are absent here.
  const GOAL_BY_METRIC = {
    expenseToIncome: 'expense_ratio',
    debtToIncome: 'debt_to_income',
    savingsRate: 'savings_rate',
    investedRate: 'invested_rate',
  };

  // Sparkline geometry, in user units. Drawn at this size 1:1 (no
  // preserveAspectRatio stretching) so the marker dot stays a circle and the
  // stroke keeps its width.
  const SPARK = { w: 82, h: 26, pad: 3 };

  // Mirrors NEAR_TREND in electron/backend/services/reportCard.js: an adverse
  // year-over-year move smaller than this is "slightly off", not "off". The two
  // trend goals are graded on the pills rather than on a tile, so this is the
  // one grading threshold the renderer has to hold a copy of.
  const NEAR_TREND = 0.02;

  const state = {
    years: [],    // the /api/report-card rows, newest first
    year: null,   // selected year (number)
    asc: [],      // the same rows oldest-first — the sparklines' x axis
  };

  // ─── Formatting ────────────────────────────────────────────────────────────

  const fmtMoney = (n) => formatCurrency(n, true);

  /** A 0..1 ratio as a whole-ish percent ("62%"); null → "N/A". */
  function fmtPct(ratio) {
    if (ratio == null || !Number.isFinite(ratio)) return 'N/A';
    return `${Math.round(ratio * 100)}%`;
  }

  /** A goal band as one compact label ("15–20%"). */
  function fmtRange([lo, hi]) {
    return `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;
  }

  /** A 0..1 ratio as a position along the meter track, in percent. */
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
   * One figure's value across every tracked year, with the selected year's
   * point marked. Scaled to the series' own min..max (it is a shape, not a
   * measurement — the figure beside it is the measurement), and skipped below
   * two points because a single point has no trend to draw.
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
    // Adverse, but barely: the same amber the goal tiles use for "slightly
    // off". Only on the percentage form — NEAR_TREND is a share, and the
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

  /**
   * The year's income, split into where it went. Full width is whichever is
   * larger — what came in, or what went out and away — so a year that spent
   * more than it earned fills the bar and gets a notch showing where income
   * ran out, instead of a segment quietly rescaling to hide the overshoot.
   *
   * Drawn only when there was income: "where the year's income went" is not a
   * question a year with none can answer, and every percentage below is a share
   * OF income. The bar itself is aria-hidden — the legend under it is the same
   * split in text, so nothing here is reachable only by looking.
   */
  function composition(y) {
    const income = y.income || 0;
    if (!(income > 0)) return '';
    const expenses = Math.max(0, y.expenses || 0);
    const saved = Math.max(0, y.transfers || 0);
    const left = income - expenses - saved;
    const denom = Math.max(income, expenses + saved);
    if (!(denom > 0)) return '';

    const bands = [
      { cls: 'spent', label: 'Expenses', amount: expenses },
      { cls: 'saved', label: 'Saved & Invested', amount: saved },
    ];
    if (left > 0) bands.push({ cls: 'left', label: 'Left over', amount: left });
    const shown = bands.filter((b) => b.amount > 0);

    const segs = shown
      .map((b) => `<span class="met-band met-band-${b.cls}" style="width:${((b.amount / denom) * 100).toFixed(3)}%"></span>`)
      .join('');
    // Only when the year overspent: the point on the bar where income ran out.
    const overspent = left < 0
      ? `<span class="met-band-notch" style="left:${((income / denom) * 100).toFixed(3)}%"></span>`
      : '';

    const legend = shown
      .map((b) => `<li class="met-key met-key-${b.cls}">
        <span class="met-key-dot" aria-hidden="true"></span>
        <span class="met-key-label">${escapeHtml(b.label)}</span>
        <span class="met-key-value">${escapeHtml(fmtPct(b.amount / income))}</span>
        <span class="met-key-amount">${escapeHtml(fmtMoney(b.amount))}</span>
      </li>`)
      .join('');

    return `<div class="met-composition">
      <div class="met-bar" aria-hidden="true">${segs}${overspent}</div>
      <ul class="met-keys">${legend}</ul>
    </div>`;
  }

  // status → badge glyph. 'met' a check, 'near' an attention mark, 'miss' a
  // cross; 'na' gets no badge at all (the value already reads N/A, so a neutral
  // dash beside it says nothing twice). Each is paired with its colour, never
  // carried by the colour alone.
  const GOAL_WORD = { met: 'met', near: 'close', miss: 'missed' };
  const GOAL_ICON = { met: '✓', near: '!', miss: '✕' };

  /**
   * One ratio tile: the percentage, a meter drawing it against a full 0–100%
   * track, and — where the ratio backs a goal — a notch at the goal's target
   * plus a ✓/✕ badge.
   *
   * A GRADED tile's fill takes the goal's colour — green hit or beaten, amber
   * slightly off, red off — because the verdict is what the card is read for
   * and an 18px badge is too small to be the only place it is said. An ungraded
   * ratio keeps the neutral accent: there is no verdict, so there is no colour
   * to give it. Colour is never alone — every graded tile carries the badge
   * glyph too. Ratios above 100% clamp the fill (a meter has an end); the value
   * text keeps saying the real number.
   *
   * The tick lane under the track is reserved on every tile, targets or not, so
   * a row of tiles keeps one baseline. `sub` (the biggest expense category's
   * name) rides on the value's own line rather than a line of its own, for the
   * same reason: only one tile has one, and a whole extra line pushed that
   * tile's meter out of step with the two beside it.
   */
  function metric(label, ratio, tip, opts) {
    const o = opts || {};
    const goal = o.goal || null;
    const known = ratio != null && Number.isFinite(ratio);
    const na = known ? '' : ' met-metric-na';
    const fill = known ? Math.max(0, Math.min(1, ratio)) : 0;

    // A goal is either a LINE (stay under 70%) or a BAND (put 15-20% away). A
    // line gets a notch; a band gets a shaded stretch of track and NO notches —
    // five points apart they crowded the band they were supposed to bracket,
    // and the shading already has two edges. One label sits centred under it,
    // because the band is one goal, not two.
    const range = goal && Array.isArray(goal.range) ? goal.range.map(clampPct) : null;
    const hasTarget = !range && goal && goal.target != null && Number.isFinite(goal.target);

    let band = '';
    let notch = '';
    let tick = '';
    if (range) {
      const [lo, hi] = range;
      band = `<span class="met-meter-band" style="left:${lo.toFixed(3)}%;width:${Math.max(0, hi - lo).toFixed(3)}%"></span>`;
      tick = `<span class="met-meter-tick" style="left:${((lo + hi) / 2).toFixed(3)}%">${escapeHtml(fmtRange(goal.range))}</span>`;
    } else if (hasTarget) {
      const at = clampPct(goal.target);
      notch = `<span class="met-meter-notch" style="left:${at.toFixed(3)}%"></span>`;
      tick = `<span class="met-meter-tick" style="left:${at.toFixed(3)}%">${escapeHtml(fmtPct(goal.target))}</span>`;
    }

    // The meter fill takes the goal's verdict, so a row of tiles reads at a
    // glance; an ungraded ratio keeps the neutral accent, because there is no
    // verdict to give it.
    const graded = goal && goal.status && goal.status !== 'na' ? ` met-graded-${goal.status}` : '';

    const glyph = goal ? GOAL_ICON[goal.status] : null;
    const badge = glyph
      ? `<span class="met-status met-status-${goal.status}" role="img"
          aria-label="${escapeHtml(goal.label)}: ${GOAL_WORD[goal.status]}"
          title="${escapeHtml(goal.label)}">${glyph}</span>`
      : '';

    return `<div class="met-metric${na}${graded}">
    <div class="met-metric-label">${escapeHtml(label)}${infoIcon(tip)}</div>
    <div class="met-metric-row">
      <span class="met-metric-value">${escapeHtml(fmtPct(ratio))}</span>
      ${badge}
      ${o.sub ? `<span class="met-metric-sub">${escapeHtml(o.sub)}</span>` : ''}
    </div>
    <div class="met-meter">
      <div class="met-meter-track" aria-hidden="true">
        ${band}
        <div class="met-meter-fill" style="width:${(fill * 100).toFixed(3)}%"></div>
        ${notch}
      </div>
      ${tick}
    </div>
  </div>`;
  }

  function body(y) {
    const goals = new Map((y.goals || []).map((g) => [g.key, g]));
    const goalFor = (metricKey) => goals.get(GOAL_BY_METRIC[metricKey]) || null;

    return `${composition(y)}

    <div class="met-figures">
      ${figure('Income', y.income, y.changes.income, true, 'income')}
      ${figure('Expenses', y.expenses, y.changes.expenses, false, 'expenses')}
      ${figure('Net', y.net, y.changes.net, true, 'net')}
      ${figure('Saved & Invested', y.transfers, y.changes.transfers, true, 'transfers')}
    </div>

    <div class="met-metrics">
      ${metric('Cash Flow Margin', y.metrics.cashFlowMargin,
        'The share of income left after expenses. Transfers to savings or a brokerage are money moved, not spent, so they don’t reduce it.')}
      ${metric('Expense-to-Income', y.metrics.expenseToIncome,
        'Total expenses divided by total income. Lower is better — under 70% earns full marks.',
        { goal: goalFor('expenseToIncome') })}
      ${metric('Debt-to-Income', y.metrics.debtToIncome,
        'Total debt from your Balance Sheet (latest month this year) divided by the year’s income. Shows N/A when you track no debt. Under 25% earns full marks.',
        { goal: goalFor('debtToIncome') })}
      ${metric('Savings Rate', y.metrics.savingsRate,
        'The share of income you moved into your own savings or brokerage accounts, across every transfer category. 20% or more earns full marks.',
        { goal: goalFor('savingsRate') })}
      ${metric('Invested', y.metrics.investedRate,
        'The share of income that went to the Investing category specifically. Money moved to any other transfer category counts towards the savings rate, not this one. 15% to 20% earns full marks, and beating it still counts.',
        { goal: goalFor('investedRate') })}
      ${metric('Largest Expense', y.metrics.topExpenseShare,
        'The share of the year’s spending that went to its single biggest category.',
        { sub: y.topExpense ? y.topExpense.name : null })}
    </div>`;
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  function render() {
    const host = document.getElementById('metrics-body');
    if (!host) return;
    const y = state.years.find((row) => row.year === state.year);
    if (!y) {
      host.innerHTML = UI.emptyState({
        icon: 'target',
        title: 'No metrics yet',
        desc: 'Add a year of income and expenses and Aventurine works out the ratios behind it, and grades the year against six money goals.',
        action: { label: 'Add transactions', href: '/transactions', primary: true },
      });
      return;
    }
    host.innerHTML = body(y);
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
    // The endpoint already sorts newest-first; the picker and the default
    // selection both lean on that order. The sparklines want the other one, so
    // the ascending copy is taken once here rather than per figure per render.
    state.years = data.years || [];
    state.asc = [...state.years].sort((a, b) => a.year - b.year);
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
