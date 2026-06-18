'use strict';

// ─── Cash Flow Forecast (Reports) ────────────────────────────────────────────
// Projects a running WEEKLY balance forward from a starting balance the user
// picks by selecting a Balance Sheet account (the app uses that account's latest
// available balance), the recurring charges detected in their ledger, and any
// planned items they add here. All computation is server-side (GET
// /api/forecast); this page renders the line chart + summary and owns the
// planned-items CRUD form.
//
// The chart is a self-contained inline-SVG renderer (single weekly series) —
// deliberately not shared with home.js's multi-series renderer yet; see the
// plan's charting note. It uses the same .chart-* class hooks, styled locally
// in forecast.css.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), CURRENCY_SYMBOL / formatCurrency / stripCurrencyValue /
// applyCurrencyFormat (currency.js).

const ALLOWED_MONTHS = [1, 3, 6];

const state = {
  months: 3,
  account: null,        // selected Balance-Sheet account key; null = server default
  includeSavings: true, // count savings/investing transfers as outflows
  data: null,           // last /api/forecast payload
  editing: null,        // planned-item id being edited, or null
};

// ─── Currency formatting (mirrors home.js's compact axis/tooltip helpers) ────

const _RE_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

function fmtMoney(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const [intPart, decPart] = abs.toFixed(2).split('.');
  return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
}

function fmtAxis(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + CURRENCY_SYMBOL + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000)     return sign + CURRENCY_SYMBOL + (abs / 1_000).toFixed(0) + 'K';
  return sign + CURRENCY_SYMBOL + abs.toFixed(0);
}

// ─── Explanatory tooltips ─────────────────────────────────────────────────────
// A small "i" badge that reveals a CSS hover/focus card (styled in forecast.css,
// no inline handlers so it stays CSP-clean). The same text is the aria-label so
// screen readers get the explanation too.
function infoIcon(tip) {
  const t = escapeHtml(tip);
  return `<span class="fc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">i</span>`;
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function load() {
  let url = `/api/forecast?months=${state.months}`;
  if (state.account !== null) url += `&account=${encodeURIComponent(state.account)}`;
  if (!state.includeSavings) url += '&include_savings=0';
  const res = await apiFetch(url);
  if (!res.ok) return;
  state.data = await res.json();

  // Keep local selection in step with the account the server actually resolved
  // (e.g. the default it picked on first load).
  state.account = state.data.start_account;
  syncAccountSelect();
  renderSummary();
  renderChartResponsive();
  renderPlanned();
}

// ─── Starting-account picker ─────────────────────────────────────────────────

const accountSelect = () => document.getElementById('forecast-account-select');

/** Rebuild the account drop-down from the latest payload: one option per Balance
 *  Sheet account, labelled with its latest available balance, the resolved
 *  starting account pre-selected. */
function syncAccountSelect() {
  const el = accountSelect();
  if (!el || !state.data) return;
  const accounts = state.data.accounts || [];
  if (!accounts.length) {
    el.innerHTML = '<option value="">No accounts</option>';
    el.disabled = true;
    return;
  }
  el.disabled = false;
  el.innerHTML = accounts.map((a) => {
    const bal = a.balance != null ? formatCurrency(a.balance, true) : 'no balance yet';
    const sel = a.key === state.data.start_account ? ' selected' : '';
    return `<option value="${escapeHtml(a.key)}"${sel}>${escapeHtml(`${a.label} — ${bal}`)}</option>`;
  }).join('');
}

function commitAccount() {
  const el = accountSelect();
  if (!el || el.value === '') return;
  if (el.value === state.account) return;
  state.account = el.value;
  load();
}

// ─── Summary strip ───────────────────────────────────────────────────────────

function renderSummary() {
  const el = document.getElementById('forecast-summary');
  if (!el || !state.data) return;
  const { summary, series, accounts, start_account, include_savings } = state.data;
  if (!series.length) {
    el.innerHTML = UI.emptyState({
      icon: 'forecast',
      title: 'No forecast yet',
      desc: 'Add a few transactions or a planned item and Oliv will project your balance forward.',
      action: { label: 'Add transactions', href: '/transactions', icon: 'plus', primary: true },
    });
    return;
  }

  const lowest = summary.lowest;
  const lowestLabel = lowest ? lowest.label : '—';
  const months = summary.monthsUsed || 0;
  const typicalNet = (summary.avgIncome || 0) - (summary.avgExpense || 0);

  const startAccount = (accounts || []).find((a) => a.key === start_account);
  const startNote = startAccount
    ? `Starting from your latest ${startAccount.label} balance`
    : 'Starting from zero — add a Balance Sheet account';
  const historyNote = months > 0
    ? `typical month from your last ${months} month${months > 1 ? 's' : ''} of transactions`
    : 'not enough transaction history yet — add a few months for a meaningful trend';
  const savingsNote = include_savings === false ? ' · savings & investing excluded' : '';
  const sourceNote = `${startNote} · ${historyNote}${savingsNote}`;

  const stats = [
    ['Typical monthly net', months > 0 ? fmtMoney(typicalNet) : '—', typicalNet < 0 ? 'neg' : '',
      'Your average actual income minus expenses per month, measured over the last '
      + `${months || 'N'} complete month${months === 1 ? '' : 's'} of transactions. This is the slope `
      + 'the line follows before any planned items are applied.'],
    ['Projected end balance', fmtMoney(summary.endBalance), summary.endBalance < 0 ? 'neg' : '',
      'Where this forecast expects you to land: your starting balance plus each projected '
      + "month's net (a typical month, adjusted by planned items) through the end of the horizon."],
    ['Lowest point', lowest ? `${fmtMoney(lowest.balance)} · week of ${lowestLabel}` : '—', lowest && lowest.balance < 0 ? 'neg' : '',
      'The lowest your running balance is projected to dip to in this window, and the week '
      + 'it happens — the cash crunch to watch for.'],
  ];

  let html = '<div class="forecast-stats">';
  for (const [label, value, cls, tip] of stats) {
    html += `<div class="forecast-stat">
      <span class="forecast-stat-label">${label}${infoIcon(tip)}</span>
      <span class="forecast-stat-value ${cls}">${value}</span>
    </div>`;
  }
  html += '</div>';
  html += `<div class="forecast-source">${escapeHtml(sourceNote)}</div>`;
  if (summary.belowZero) {
    html += '<div class="forecast-warning">⚠ Balance is projected to drop below zero in this window.</div>';
  }
  el.innerHTML = html;
}

// ─── Chart (self-contained inline SVG, single weekly series) ─────────────────

const CHART_RATIO = 220 / 800;
const CHART_PAD = { l: 60, r: 22, t: 20, b: 32 };
let chartObserver = null;

function readAccent() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-secondary').trim();
  return v || '#6fb1ff';
}

function niceTicks(min, max, target = 4) {
  if (max <= min) return [min];
  const rough = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if      (norm < 2) step = 2  * mag;
  else if (norm < 5) step = 5  * mag;
  else               step = 10 * mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Catmull-Rom → bezier smoothing (same construction as home.js). */
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

function buildChartSVG(W, animate) {
  const series = state.data ? state.data.series : [];
  if (!series.length) return '<p class="forecast-empty">No data to chart yet.</p>';

  const values = series.map((s) => s.balance);
  // Always include 0 in the range so a dip toward/below zero reads honestly.
  const yTicks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4);
  const minVal = yTicks[0];
  const maxVal = yTicks[yTicks.length - 1];
  const valRange = maxVal - minVal || 1;

  const H = Math.max(Math.round(W * CHART_RATIO), 200);
  const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
  const CW = W - PL - PR;
  const CH = H - PT - PB;
  const N = series.length;

  const xScale = (i) => PL + (i / (N - 1 || 1)) * CW;
  const yScale = (v) => PT + CH - ((v - minVal) / valRange) * CH;

  const color = readAccent();
  const rnd = Math.random().toString(36).slice(2, 9);
  const lowestWeek = state.data.summary.lowest && state.data.summary.lowest.weekStart;

  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="forecast-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

  for (const v of yTicks) {
    const y = yScale(v);
    svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
    svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtAxis(v)}</text>`;
  }

  if (minVal < 0 && maxVal > 0) {
    const y0 = yScale(0);
    svg += `<line class="chart-zero" x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}"/>`;
  }

  // X labels — weekly points crowd quickly (up to ~26 on the 6-month horizon),
  // so show at most ~8 evenly-spaced labels plus the final week.
  const stride = Math.max(1, Math.ceil(N / 8));
  series.forEach((s, i) => {
    if (i % stride !== 0 && i !== N - 1) return;
    svg += `<text class="chart-label" x="${xScale(i)}" y="${H - PB + 18}" text-anchor="middle">${escapeHtml(s.label)}</text>`;
  });

  const linePts = series.map((s, i) => ({ x: xScale(i), y: yScale(s.balance) }));
  const baseY = H - PB;
  const lineD = smoothPath(linePts);
  const areaD = `${lineD} L ${linePts[N - 1].x} ${baseY} L ${linePts[0].x} ${baseY} Z`;
  const topY = Math.min(...linePts.map((p) => p.y));
  const gradId = `fcgrad-${rnd}`;

  svg += `<defs><linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="0" y1="${topY}" x2="0" y2="${baseY}">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>`;
  if (N > 1) {
    svg += `<path class="chart-area-fill" d="${areaD}" fill="url(#${gradId})"/>`;
    svg += `<path class="chart-line" d="${lineD}" pathLength="1" fill="none" stroke="${color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  series.forEach((s, i) => {
    const x = xScale(i);
    const y = yScale(s.balance);
    const isLow = s.weekStart === lowestWeek;
    const dotCls = `chart-dot${isLow ? ' chart-dot-low' : ''}${s.balance < 0 ? ' chart-dot-neg' : ''}`;
    svg += `<circle class="${dotCls}" cx="${x}" cy="${y}" r="${isLow ? 4.5 : 3}" fill="${color}">
      <title>Week of ${escapeHtml(s.label)}: ${fmtMoney(s.balance)} (net ${fmtMoney(s.net)})</title>
    </circle>`;
  });

  svg += '</svg>';
  return svg;
}

function renderChartResponsive() {
  const el = document.getElementById('forecast-chart');
  if (!el) return;
  const target = el.parentElement || el;
  if (chartObserver) chartObserver.disconnect();

  let animate = true;
  let lastW = 0;
  const render = (w) => {
    w = Math.round(w);
    if (w > 0 && w !== lastW) {
      lastW = w;
      el.innerHTML = buildChartSVG(w, animate);
      animate = false;
    }
  };
  chartObserver = new ResizeObserver((entries) => render(entries[0].contentRect.width));
  chartObserver.observe(target);
  render(target.clientWidth);
}

// ─── Planned items ───────────────────────────────────────────────────────────

function renderPlanned() {
  const el = document.getElementById('planned-list');
  if (!el || !state.data) return;
  const items = state.data.planned || [];

  let html = '';
  if (!items.length) {
    html += UI.emptyState({
      icon: 'calendar', compact: true,
      title: 'No planned items',
      desc: 'Add one-off income or expenses you already know about to refine the projection.',
    });
  } else {
    html += '<ul class="planned-rows">';
    for (const it of items) {
      const sign = it.flow === 'income' ? '+' : '−';
      html += `<li class="planned-row" data-id="${it.id}">
        <span class="planned-flow planned-flow-${it.flow}"></span>
        <span class="planned-text">
          <span class="planned-label">${escapeHtml(it.label)}</span>
          <span class="planned-date">${escapeHtml(it.date)}</span>
        </span>
        <span class="planned-amount planned-amount-${it.flow}">${sign}${fmtMoney(it.amount)}</span>
        <span class="planned-actions">
          <button type="button" class="planned-edit" data-id="${it.id}" aria-label="Edit">Edit</button>
          <button type="button" class="planned-delete" data-id="${it.id}" aria-label="Delete">Delete</button>
        </span>
      </li>`;
    }
    html += '</ul>';
  }
  el.innerHTML = html;

  el.querySelectorAll('.planned-edit').forEach((b) =>
    b.addEventListener('click', () => openForm(Number(b.dataset.id))));
  el.querySelectorAll('.planned-delete').forEach((b) =>
    b.addEventListener('click', () => deletePlanned(Number(b.dataset.id))));
}

/** Build (or rebuild) the add/edit form. `item` populates it for an edit. */
function openForm(id) {
  const items = (state.data && state.data.planned) || [];
  const item = id != null ? items.find((i) => i.id === id) : null;
  state.editing = item ? item.id : null;

  let form = document.getElementById('planned-form');
  if (!form) {
    form = document.createElement('form');
    form.id = 'planned-form';
    form.className = 'planned-form';
    const card = document.getElementById('planned-list').closest('.forecast-card');
    card.insertBefore(form, document.getElementById('planned-list'));
  }
  form.innerHTML = `
    <input type="text" id="pf-label" class="pf-input" maxlength="100" placeholder="Description"
           value="${item ? escapeHtml(item.label) : ''}">
    <select id="pf-flow" class="pf-input">
      <option value="expense"${item && item.flow === 'expense' ? ' selected' : ''}>Expense</option>
      <option value="income"${item && item.flow === 'income' ? ' selected' : ''}>Income</option>
    </select>
    <input type="text" id="pf-amount" class="pf-input" inputmode="decimal" placeholder="Amount"
           value="${item ? formatCurrency(item.amount, true) : ''}">
    <input type="date" id="pf-date" class="pf-input" value="${item ? escapeHtml(item.date) : ''}">
    <button type="submit" class="pf-save db-btn-primary">${item ? 'Save' : 'Add'}</button>
    <button type="button" class="pf-cancel" id="pf-cancel">Cancel</button>
    <p class="pf-error" id="pf-error" hidden></p>
  `;

  const amount = form.querySelector('#pf-amount');
  amount.addEventListener('input', () => applyCurrencyFormat(amount));
  form.querySelector('#pf-cancel').addEventListener('click', closeForm);
  form.addEventListener('submit', submitForm);
  form.querySelector('#pf-label').focus();
}

function closeForm() {
  const form = document.getElementById('planned-form');
  if (form) form.remove();
  state.editing = null;
}

async function submitForm(e) {
  e.preventDefault();
  const err = document.getElementById('pf-error');
  const label = document.getElementById('pf-label').value.trim();
  const flow = document.getElementById('pf-flow').value;
  const amount = Number(stripCurrencyValue(document.getElementById('pf-amount').value));
  const date = document.getElementById('pf-date').value;

  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!label) return fail('Description is required.');
  if (!Number.isFinite(amount) || amount <= 0) return fail('Enter an amount greater than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Pick a date.');

  const body = JSON.stringify({ label, flow, amount, date });
  const editingId = state.editing;
  const res = editingId != null
    ? await apiFetch(`/api/forecast/planned/${editingId}`, { method: 'PUT', body })
    : await apiFetch('/api/forecast/planned', { method: 'POST', body });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return fail(data.error || 'Could not save the item.');
  }
  closeForm();
  load();
}

async function deletePlanned(id) {
  const res = await apiFetch(`/api/forecast/planned/${id}`, { method: 'DELETE' });
  if (res.ok) load();
}

// ─── Controls ────────────────────────────────────────────────────────────────

function wireRangePicker() {
  const btn = document.getElementById('forecast-range-btn');
  const menu = document.getElementById('forecast-range-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.querySelectorAll('button[data-months]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = parseInt(b.dataset.months, 10);
      if (!ALLOWED_MONTHS.includes(m)) return;
      state.months = m;
      btn.textContent = `${m} Month${m === 1 ? '' : 's'}`;
      menu.hidden = true;
      load();
    }));
}

function wireAccountSelect() {
  const el = accountSelect();
  if (!el) return;
  el.addEventListener('change', commitAccount);
}

function wireSavingsToggle() {
  const btn = document.getElementById('forecast-savings-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    state.includeSavings = !state.includeSavings;
    btn.setAttribute('aria-pressed', String(state.includeSavings));
    btn.classList.toggle('active', state.includeSavings);
    load();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireRangePicker();
  wireAccountSelect();
  wireSavingsToggle();
  document.getElementById('planned-add-btn').addEventListener('click', () => openForm(null));
  load();
  // Re-render currency-bearing UI if the symbol changes in Settings.
  window.addEventListener('currencychange', () => { syncAccountSelect(); renderSummary(); renderChartResponsive(); renderPlanned(); });
});
