'use strict';

// ─── Spending Trends (Reports) ────────────────────────────────────────────────
// Plots each expense category's monthly spending over a trailing window, with
// per-category toggles (like the Home charts).
//
// Data comes from GET /api/trends (monthly per-category expense sums). The chart
// is the shared FinanceChart (chart.js).
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency (currency.js),
// FinanceChart (chart.js).

const WINDOW_LABELS = { 6: '6 Months', 12: '12 Months', 36: '3 Years', 60: '5 Years' };
const ALLOWED_WINDOWS = [6, 12, 36, 60];

const state = {
  window: 12,
  data: null,      // { window, months, categories:[{key,name,monthly}] }
  enabled: null,   // Set<categoryKey> currently plotted
  colors: null,    // Map<key, color>
};

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
