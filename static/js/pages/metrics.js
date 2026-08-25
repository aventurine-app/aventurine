'use strict';

// ─── Metrics (Reports) ───────────────────────────────────────────────────────
// A tab of the Reports page (pages/reports.html): the selected year's money,
// broken down. Four headline totals with year-over-year pills, the six ratios
// those totals imply, and the four money goals graded met / missed.
//
// This is the old standalone "Yearly Report Card" page, which had no route into
// it, turned into a report. The shape changed with the move: a wall of one card
// per year became ONE year chosen from a picker, because that is how every other
// report on this page is read (Cash Flow picks a year, Spending and Forecast
// pick a window) and because a breakdown of six ratios needs the room that
// stacking every year at once was spending.
//
// All computation is server-side (GET /api/report-card, newest year first);
// this script picks a year out of the response and formats it. The picker
// mirrors the Cash Flow tab's year picker (widgets/cashflow-sankey.js).
//
// Globals (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), formatCurrency (currency.js), UI.emptyState (ui.js).

(function () {
  // Goals whose `value` is an absolute ratio (rendered as a plain percent) vs.
  // goals whose `value` is a year-over-year fractional change (signed percent).
  const TREND_GOALS = new Set(['spending_trend', 'income_trend']);

  const state = {
    years: [],    // the /api/report-card rows, newest first
    year: null,   // selected year (number)
  };

  // ─── Formatting ────────────────────────────────────────────────────────────

  const fmtMoney = (n) => formatCurrency(n, true);

  /** A 0..1 ratio as a whole-ish percent ("62%"); null → "N/A". */
  function fmtPct(ratio) {
    if (ratio == null || !Number.isFinite(ratio)) return 'N/A';
    return `${Math.round(ratio * 100)}%`;
  }

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

  // ─── Pieces ────────────────────────────────────────────────────────────────

  /** A year-over-year change pill under a headline figure. `goodWhenUp` colours
   *  an increase green (income) or red (expenses). */
  function changePill(change, goodWhenUp) {
    if (!change) return '<span class="met-change met-change-none">first year</span>';
    // pct null with a real change → grew from zero ("new").
    if (change.pct == null) {
      return '<span class="met-change met-change-up">new</span>';
    }
    const up = change.pct > 0.0005;
    const down = change.pct < -0.0005;
    const arrow = up ? '▲' : down ? '▼' : '■';
    const good = up ? goodWhenUp : down ? !goodWhenUp : null;
    const tone = good === null ? 'flat' : good ? 'good' : 'bad';
    return `<span class="met-change met-change-${tone}">${arrow} ${escapeHtml(fmtSignedPct(change.pct))} YoY</span>`;
  }

  function figure(label, value, change, goodWhenUp) {
    const neg = Number.isFinite(value) && value < 0 ? ' met-figure-negative' : '';
    return `<div class="met-figure${neg}">
    <span class="met-figure-label">${escapeHtml(label)}</span>
    <span class="met-figure-value">${escapeHtml(fmtMoney(value))}</span>
    ${changePill(change, goodWhenUp)}
  </div>`;
  }

  /** One ratio tile. `sub` names what the percentage is about (only the largest
   *  expense tile has one) and is omitted when there is nothing to name. */
  function metric(label, ratio, tip, sub) {
    const na = ratio == null || !Number.isFinite(ratio) ? ' met-metric-na' : '';
    return `<div class="met-metric${na}">
    <div class="met-metric-label">${escapeHtml(label)}${infoIcon(tip)}</div>
    <div class="met-metric-value">${escapeHtml(fmtPct(ratio))}</div>
    ${sub ? `<div class="met-metric-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
  }

  // status → icon glyph. 'na' (goal invalid or no year-over-year change) is a
  // neutral gray dash; 'met' a check, 'miss' a cross.
  const GOAL_ICON = { met: '✓', miss: '✕', na: '–' };

  function goalRow(g) {
    const val = TREND_GOALS.has(g.key) ? fmtSignedPct(g.value) : fmtPct(g.value);
    const status = g.status || (g.met ? 'met' : 'miss');
    const icon = GOAL_ICON[status] || GOAL_ICON.na;
    return `<li class="met-goal met-goal-${status}">
    <span class="met-goal-icon" aria-hidden="true">${icon}</span>
    <span class="met-goal-label">${escapeHtml(g.label)}</span>
    <span class="met-goal-value">${escapeHtml(val)}</span>
  </li>`;
  }

  function body(y) {
    const goals = (y.goals || []).length
      ? `<ul class="met-goals">${y.goals.map(goalRow).join('')}</ul>`
      : '<p class="met-goal-label">Not enough data to evaluate goals this year.</p>';

    return `<div class="met-figures">
      ${figure('Income', y.income, y.changes.income, true)}
      ${figure('Expenses', y.expenses, y.changes.expenses, false)}
      ${figure('Net', y.net, y.changes.net, true)}
      ${figure('Saved & Invested', y.transfers, y.changes.transfers, true)}
    </div>

    <div class="met-metrics">
      ${metric('Cash Flow Margin', y.metrics.cashFlowMargin,
        'The share of income left after expenses. Transfers to savings or a brokerage are money moved, not spent, so they don’t reduce it.')}
      ${metric('Expense-to-Income', y.metrics.expenseToIncome,
        'Total expenses divided by total income. Lower is better — under 70% earns full marks.')}
      ${metric('Debt-to-Income', y.metrics.debtToIncome,
        'Total debt from your Balance Sheet (latest month this year) divided by the year’s income. Shows N/A when you track no debt. Under 25% earns full marks.')}
      ${metric('Savings Rate', y.metrics.savingsRate,
        'The share of income you moved into your own savings or brokerage accounts, across every transfer category.')}
      ${metric('Invested', y.metrics.investedRate,
        'The share of income that went to the Investing category specifically. Money moved to any other transfer category counts towards the savings rate, not this one.')}
      ${metric('Largest Expense', y.metrics.topExpenseShare,
        'The share of the year’s spending that went to its single biggest category.',
        y.topExpense ? y.topExpense.name : null)}
    </div>

    <div class="met-goals-wrap">
      <div class="met-goals-title">Goals</div>
      ${goals}
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
        desc: 'Add a year of income and expenses and Aventurine works out the ratios behind it, and grades the year against four money goals.',
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
    menu.querySelectorAll('button[data-year]').forEach((b) =>
      b.addEventListener('click', () => {
        const y = parseInt(b.dataset.year, 10);
        menu.hidden = true;
        if (y === state.year) return;
        state.year = y;
        btn.textContent = String(y);
        render();
      }));
  }

  function wireYearPicker() {
    const btn = document.getElementById('metrics-year-btn');
    const menu = document.getElementById('metrics-year-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!btn.disabled) menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', () => { menu.hidden = true; });
  }

  async function load() {
    const res = await apiFetch('/api/report-card');
    if (!res.ok) return;
    const data = await res.json();
    // The endpoint already sorts newest-first; the picker and the default
    // selection both lean on that order.
    state.years = data.years || [];
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
