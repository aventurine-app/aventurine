'use strict';

// ─── Spending Trends (Reports) ────────────────────────────────────────────────
// Plots each expense category's monthly spending over a trailing window, with
// per-category toggles (like the Home charts) and a biggest-movers panel
// comparing the recent half of the window to the earlier half.
//
// Data comes from GET /api/trends (monthly per-category expense sums). The chart
// is the shared FinanceChart (chart.js). Movers are computed here.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency (currency.js),
// FinanceChart (chart.js).

const WINDOW_LABELS = { 6: '6 Months', 12: '12 Months', 36: '3 Years', 60: '5 Years' };
const ALLOWED_WINDOWS = [6, 12, 36, 60];
const MOVERS_PER_SIDE = 5;
const EPS = 0.005; // ignore sub-cent "movement" (float noise)

const state = {
  window: 12,
  data: null,      // { window, months, categories:[{key,name,monthly}] }
  enabled: null,   // Set<categoryKey> currently plotted
  colors: null,    // Map<key, color>
};

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtMoney(n) {
  return formatCurrency(n, true) || (CURRENCY_SYMBOL + '0');
}
function fmtSigned(n) {
  return (n < 0 ? '-' : '+') + fmtMoney(Math.abs(n));
}

const ymToSlot = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return { year: y, monthIdx: m - 1 };
};

// ─── Data ────────────────────────────────────────────────────────────────────

async function load() {
  const res = await apiFetch(`/api/trends?window=${state.window}`);
  if (!res.ok) return;
  state.data = await res.json();

  const keys = state.data.categories.map((c) => c.key);
  // Preserve the user's on/off choices across window changes; default-on for
  // categories we haven't seen before.
  if (!state.enabled) {
    state.enabled = new Set(keys);
  } else {
    const next = new Set();
    for (const k of keys) if (state.enabled.has(k) || !state.seenKeys.has(k)) next.add(k);
    state.enabled = next;
  }
  state.seenKeys = new Set(keys);
  state.colors = FinanceChart.colorMap(keys);

  render();
}

function render() {
  document.getElementById('trends-range-btn').textContent = WINDOW_LABELS[state.window];
  renderSelector();
  renderChart();
  renderMovers();
}

// ─── Category selector chips ─────────────────────────────────────────────────

function renderSelector() {
  const el = document.getElementById('trends-selector');
  if (!el || !state.data) return;
  const cats = state.data.categories;
  if (!cats.length) {
    el.innerHTML = '';   // the chart area below shows the full empty state
    return;
  }

  el.innerHTML = cats
    .map((c) => {
      const on = state.enabled.has(c.key);
      const color = state.colors.get(c.key);
      return `<button type="button" class="trends-chip${on ? ' active' : ''}" data-key="${escapeHtml(c.key)}">
        <span class="trends-chip-dot" style="background:${on ? color : 'transparent'};border-color:${color}"></span>
        ${escapeHtml(c.name)}
      </button>`;
    })
    .join('');

  el.querySelectorAll('.trends-chip').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.key;
      if (state.enabled.has(key)) state.enabled.delete(key);
      else state.enabled.add(key);
      renderSelector();
      renderChart();
    }));
}

// ─── Chart ───────────────────────────────────────────────────────────────────

function renderChart() {
  const container = document.getElementById('trends-chart');
  if (!container || !state.data) return;
  const { months, categories } = state.data;
  const slots = months.map(ymToSlot);

  const series = categories
    .filter((c) => state.enabled.has(c.key))
    .map((c) => ({
      label: c.name,
      color: state.colors.get(c.key),
      points: months.map((ym, i) => {
        const slot = slots[i];
        return { year: slot.year, monthIdx: slot.monthIdx, value: c.monthly[ym] || 0 };
      }),
    }));

  if (!series.length) {
    FinanceChart.render('trends-chart', { series: [], slots: [] }); // disconnect observer + clear
    container.innerHTML = categories.length === 0
      ? UI.emptyState({
          icon: 'chart',
          title: 'No spending to chart yet',
          desc: 'Categorize some transactions and Oliv will chart how your spending shifts over time.',
          action: { label: 'Add transactions', href: '/transactions', icon: 'plus', primary: true },
        })
      : UI.emptyState({
          icon: 'chart', compact: true,
          title: 'Nothing selected',
          desc: 'Pick a category above to plot it.',
        });
    return;
  }
  FinanceChart.render('trends-chart', { series, slots });
}

// ─── Biggest movers (recent half vs earlier half) ────────────────────────────

function computeMovers() {
  const { months, categories } = state.data;
  const n = months.length;
  const half = Math.floor(n / 2);
  if (half < 1) return [];

  return categories.map((c) => {
    const val = (i) => c.monthly[months[i]] || 0;
    let first = 0;
    let second = 0;
    for (let i = 0; i < half; i++) first += val(i);
    for (let i = n - half; i < n; i++) second += val(i);
    const avgFirst = first / half;
    const avgSecond = second / half;
    const change = avgSecond - avgFirst;
    const pct = avgFirst > EPS ? (change / avgFirst) * 100 : null; // null = grew from ~nothing
    return { name: c.name, change, pct };
  });
}

function moverRow(m, dir) {
  const arrow = dir === 'up' ? '▲' : '▼';
  const pct = m.pct === null ? 'new' : `${arrow} ${Math.abs(m.pct).toFixed(0)}%`;
  return `<li class="trends-mover">
    <span class="trends-mover-name">${escapeHtml(m.name)}</span>
    <span class="trends-mover-fig">
      <span class="trends-mover-amt trends-mover-${dir}">${fmtSigned(m.change)}<span class="trends-mover-per">/mo</span></span>
      <span class="trends-mover-pct trends-mover-${dir}">${pct}</span>
    </span>
  </li>`;
}

function renderMovers() {
  const el = document.getElementById('trends-movers');
  const note = document.getElementById('trends-movers-note');
  if (!el || !state.data) return;

  const movers = computeMovers();
  const up = movers.filter((m) => m.change > EPS).sort((a, b) => b.change - a.change).slice(0, MOVERS_PER_SIDE);
  const down = movers.filter((m) => m.change < -EPS).sort((a, b) => a.change - b.change).slice(0, MOVERS_PER_SIDE);

  if (note) {
    note.textContent = `recent half vs earlier half · ${WINDOW_LABELS[state.window]}`;
  }

  const col = (title, items, dir) => `<div class="trends-mover-col">
    <div class="trends-mover-head">${title}</div>
    ${items.length
      ? `<ul class="trends-mover-list">${items.map((m) => moverRow(m, dir)).join('')}</ul>`
      : `<p class="trends-hint">No notable ${dir === 'up' ? 'increases' : 'decreases'}.</p>`}
  </div>`;

  el.innerHTML = col('Spending more', up, 'up') + col('Spending less', down, 'down');
}

// ─── Controls ────────────────────────────────────────────────────────────────

function wireRangePicker() {
  const btn = document.getElementById('trends-range-btn');
  const menu = document.getElementById('trends-range-menu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.querySelectorAll('button[data-window]').forEach((b) =>
    b.addEventListener('click', () => {
      const w = parseInt(b.dataset.window, 10);
      if (!ALLOWED_WINDOWS.includes(w)) return;
      state.window = w;
      menu.hidden = true;
      load();
    }));
}

document.addEventListener('DOMContentLoaded', () => {
  wireRangePicker();
  window.addEventListener('currencychange', render);
  load();
});
