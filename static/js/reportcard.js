'use strict';

// ─── Yearly Report Card (Reports) ─────────────────────────────────────────────
// One card per year of activity (newest first). Each card shows the year's
// income / expenses / saving & investing with year-over-year change pills, three
// derived ratios, and the five goal outcomes (met or missed).
//
// All computation is server-side (GET /api/report-card); this page only formats
// and lays out the response.
//
// Globals (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), CURRENCY_SYMBOL (currency.js).

const _RE_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

// Goals whose `value` is an absolute ratio (rendered as a plain percent) vs.
// goals whose `value` is a year-over-year fractional change (signed percent).
const TREND_GOALS = new Set(['spending_trend', 'income_trend']);

// ─── Formatting ────────────────────────────────────────────────────────────────

function fmtMoney(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const [intPart, decPart] = abs.toFixed(2).split('.');
  return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
}

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

// ─── Pieces ─────────────────────────────────────────────────────────────────────

/** A year-over-year change pill under a headline figure. `goodWhenUp` colours
 *  an increase green (income, savings) or red (expenses). */
function changePill(change, goodWhenUp) {
  if (!change) return '<span class="rc-change rc-change-none">first year</span>';
  // pct null with a real change → grew from zero ("new").
  if (change.pct == null) {
    return '<span class="rc-change rc-change-up">new</span>';
  }
  const up = change.pct > 0.0005;
  const down = change.pct < -0.0005;
  const arrow = up ? '▲' : down ? '▼' : '■';
  const good = up ? goodWhenUp : down ? !goodWhenUp : null;
  const tone = good === null ? 'flat' : good ? 'good' : 'bad';
  return `<span class="rc-change rc-change-${tone}">${arrow} ${escapeHtml(fmtSignedPct(change.pct))} YoY</span>`;
}

function figure(label, value, change, goodWhenUp) {
  return `<div class="rc-figure">
    <span class="rc-figure-label">${escapeHtml(label)}</span>
    <span class="rc-figure-value">${escapeHtml(fmtMoney(value))}</span>
    ${changePill(change, goodWhenUp)}
  </div>`;
}

function metric(label, ratio, tip) {
  return `<div class="rc-metric">
    <div class="rc-metric-label">${escapeHtml(label)}${infoIcon(tip)}</div>
    <div class="rc-metric-value">${escapeHtml(fmtPct(ratio))}</div>
  </div>`;
}

function goalRow(g) {
  const val = TREND_GOALS.has(g.key) ? fmtSignedPct(g.value) : fmtPct(g.value);
  const icon = g.met ? '✓' : '✕';
  return `<li class="rc-goal rc-goal-${g.met ? 'met' : 'miss'}">
    <span class="rc-goal-icon" aria-hidden="true">${icon}</span>
    <span class="rc-goal-label">${escapeHtml(g.label)}</span>
    <span class="rc-goal-value">${escapeHtml(val)}</span>
  </li>`;
}

function card(y) {
  const goals = y.goals.length
    ? `<ul class="rc-goals">${y.goals.map(goalRow).join('')}</ul>`
    : '<p class="rc-empty-goals">Not enough data to evaluate goals this year.</p>';

  return `<section class="rc-card">
    <header class="rc-card-head">
      <h2 class="rc-title">${escapeHtml(String(y.year))}</h2>
    </header>

    <div class="rc-figures">
      ${figure('Income', y.income, y.changes.income, true)}
      ${figure('Expenses', y.expenses, y.changes.expenses, false)}
      ${figure('Saving & Investing', y.savings, y.changes.savings, true)}
    </div>

    <div class="rc-metrics">
      ${metric('Expense-to-Income', y.metrics.expenseToIncome,
        'Total expenses divided by total income. Lower is better — under 70% earns full marks.')}
      ${metric('Debt-to-Income', y.metrics.debtToIncome,
        'Total debt from your Balance Sheet (latest month this year) divided by the year’s income. Shows N/A when you track no debt. Under 25% earns full marks.')}
      ${metric('Cash Flow Margin', y.metrics.cashFlowMargin,
        'The share of income left after every tracked outflow — expenses, saving and investing.')}
    </div>

    <div class="rc-goals-wrap">
      <div class="rc-goals-title">Goals</div>
      ${goals}
    </div>
  </section>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────────

let lastData = null;

function render() {
  const host = document.getElementById('rc-cards');
  if (!host || !lastData) return;
  const years = lastData.years || [];
  if (!years.length) {
    host.innerHTML = UI.emptyState({
      icon: 'target',
      title: 'No report cards yet',
      desc: 'Add transactions across a year and Oliv grades it against five money goals — one card per year.',
      action: { label: 'Add transactions', href: '/transactions', icon: 'plus', primary: true },
    });
    return;
  }
  host.innerHTML = years.map(card).join('');
}

async function load() {
  const res = await apiFetch('/api/report-card');
  if (!res.ok) return;
  lastData = await res.json();
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('currencychange', render);
  load();
});
