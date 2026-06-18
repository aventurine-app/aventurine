'use strict';

// ─── Budget Buckets (Account Tracking) ───────────────────────────────────────
// Per-month envelope budgeting: set a target per spending/savings category and
// watch a progress bar fill from your actual transactions, with a zero-based
// "left to budget" roll-up. All data is server-side (GET /api/budget); targets
// are written through POST/DELETE /api/budget/target.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), CURRENCY_SYMBOL / formatCurrency / stripCurrencyValue /
// applyCurrencyFormat (currency.js).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const state = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),
  data: null,
};

const monthName = () => MONTHS[state.monthIndex];

// ─── Currency formatting (compact, currency-symbol aware) ────────────────────

const _RE_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

function fmtMoney(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const [intPart, decPart] = abs.toFixed(2).split('.');
  return sign + CURRENCY_SYMBOL + intPart.replace(_RE_THOUSANDS, ',') + (decPart === '00' ? '' : '.' + decPart);
}

function infoIcon(tip) {
  const t = escapeHtml(tip);
  return `<span class="fc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">i</span>`;
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function load() {
  const res = await apiFetch(`/api/budget?year=${state.year}&month=${monthName()}`);
  if (!res.ok) return;
  state.data = await res.json();
  render();
}

function render() {
  document.getElementById('budget-month-label').textContent = `${monthName()} ${state.year}`;
  renderSummary();
  renderList();
}

// ─── Zero-based summary ──────────────────────────────────────────────────────

function renderSummary() {
  const el = document.getElementById('budget-summary');
  if (!el || !state.data) return;
  const s = state.data.summary;

  // Expected income is editable; the rest are read-outs.
  const expectedTip = 'What you expect to take in this month — the figure "left to budget" '
    + 'is measured against, so it\'s meaningful from day 1. It defaults to your average '
    + 'monthly income from recent months; type a number to set your own, or clear it to go '
    + 'back to the average.';
  const sourceNote = s.incomeSource === 'override'
    ? 'custom'
    : 'auto · avg of recent months';
  const incomeStat = `<div class="budget-stat">
      <span class="budget-stat-label">Expected income${infoIcon(expectedTip)}</span>
      <input type="text" id="budget-income-input" class="budget-income-input" inputmode="decimal"
             spellcheck="false" autocomplete="off" placeholder="—" value="${formatCurrency(s.expectedIncome, true)}">
      <span class="budget-stat-sub">${fmtMoney(s.received)} received · ${escapeHtml(sourceNote)}</span>
    </div>`;

  const stats = [
    ['Budgeted', fmtMoney(s.budgeted), '',
      'The sum of every envelope target you have set for this month.'],
    ['Left to budget', fmtMoney(s.leftToBudget), s.leftToBudget < 0 ? 'neg' : 'pos',
      "Expected income minus everything you've budgeted. Zero means every dollar has a job; "
      + 'negative means you have budgeted more than you expect to bring in.'],
    ['Spent', `${fmtMoney(s.spent)} of ${fmtMoney(s.budgeted)}`, s.spent > s.budgeted ? 'neg' : '',
      'Total actual spending across all budgeted categories this month, against the total you budgeted.'],
  ];

  let html = `<div class="budget-stats">${incomeStat}`;
  for (const [label, value, cls, tip] of stats) {
    html += `<div class="budget-stat">
      <span class="budget-stat-label">${label}${infoIcon(tip)}</span>
      <span class="budget-stat-value ${cls}">${value}</span>
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;

  const incomeInput = document.getElementById('budget-income-input');
  incomeInput.addEventListener('input', () => applyCurrencyFormat(incomeInput));
  incomeInput.addEventListener('change', () => commitIncome(incomeInput));
  incomeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); incomeInput.blur(); } });
}

async function commitIncome(input) {
  const raw = stripCurrencyValue(input.value);
  const body = { year: state.year, month: monthName() };
  if (raw === '') {
    // Cleared → revert to the auto average (drop any override).
    if (state.data.summary.incomeSource !== 'override') return;
    await apiFetch('/api/budget/income', { method: 'DELETE', body: JSON.stringify(body) });
  } else {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return;
    await apiFetch('/api/budget/income', { method: 'POST', body: JSON.stringify({ ...body, amount }) });
  }
  load();
}

// ─── Envelope rows ───────────────────────────────────────────────────────────

function renderList() {
  const el = document.getElementById('budget-list');
  if (!el || !state.data) return;
  const cats = state.data.categories;

  if (!cats.length) {
    el.innerHTML = UI.emptyState({
      icon: 'target',
      title: 'No budget categories yet',
      desc: 'Add expense, savings, or investing categories and they’ll appear here as budget envelopes.',
      action: { label: 'Manage categories', href: '/categories', icon: 'plus', primary: true },
    });
    return;
  }

  let html = '<ul class="budget-rows">';
  for (const c of cats) {
    const hasTarget = c.target > 0;
    const ratio = hasTarget ? c.spent / c.target : 0;
    const widthPct = Math.min(ratio, 1) * 100;
    const over = hasTarget && c.spent > c.target;
    // Bar colour bands: green ≤75%, yellow ≤90%, red past 90% (incl. over budget).
    let band = 'green';
    if (ratio > 0.90) band = 'red';
    else if (ratio > 0.75) band = 'yellow';

    let statusText;
    let statusCls;
    if (!hasTarget) {
      statusText = c.spent > 0 ? `${fmtMoney(c.spent)} spent` : 'No target';
      statusCls = 'muted';
    } else if (over) {
      statusText = `${fmtMoney(c.spent - c.target)} over`;
      statusCls = 'neg';
    } else {
      statusText = `${fmtMoney(c.remaining)} left`;
      statusCls = 'pos';
    }

    html += `<li class="budget-row" data-key="${escapeHtml(c.key)}">
      <div class="budget-row-top">
        <span class="budget-cat-name">${escapeHtml(c.name)}</span>
        <span class="budget-cat-spend">${fmtMoney(c.spent)}<span class="budget-of"> / </span><input
            type="text" class="budget-target-input" inputmode="decimal" spellcheck="false"
            autocomplete="off" placeholder="No target"
            data-key="${escapeHtml(c.key)}" value="${hasTarget ? formatCurrency(c.target, true) : ''}"></span>
      </div>
      <div class="budget-bar${hasTarget ? '' : ' budget-bar-untracked'}">
        <div class="budget-bar-fill bar-${band}" style="width:${widthPct}%"></div>
      </div>
      <div class="budget-row-status ${statusCls}">${statusText}</div>
    </li>`;
  }
  html += '</ul>';
  el.innerHTML = html;

  el.querySelectorAll('.budget-target-input').forEach((input) => {
    input.addEventListener('input', () => applyCurrencyFormat(input));
    input.addEventListener('change', () => commitTarget(input));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
}

async function commitTarget(input) {
  const key = input.dataset.key;
  const raw = stripCurrencyValue(input.value);
  const body = { year: state.year, month: monthName(), category: key };

  if (raw === '' || Number(raw) === 0) {
    await apiFetch('/api/budget/target', { method: 'DELETE', body: JSON.stringify(body) });
  } else {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return;
    await apiFetch('/api/budget/target', { method: 'POST', body: JSON.stringify({ ...body, value: amount }) });
  }
  load();
}

// ─── Month navigation + copy ─────────────────────────────────────────────────

function step(delta) {
  let m = state.monthIndex + delta;
  let y = state.year;
  if (m < 0) { m = 11; y -= 1; }
  else if (m > 11) { m = 0; y += 1; }
  state.monthIndex = m;
  state.year = y;
  load();
}

async function copyLastMonth() {
  const fromIndex = state.monthIndex === 0 ? 11 : state.monthIndex - 1;
  const fromYear = state.monthIndex === 0 ? state.year - 1 : state.year;
  const hasTargets = state.data && state.data.categories.some((c) => c.target > 0);
  if (hasTargets && !confirm(`Overwrite this month's targets with those from ${MONTHS[fromIndex]} ${fromYear}?`)) {
    return;
  }
  const res = await apiFetch('/api/budget/copy', {
    method: 'POST',
    body: JSON.stringify({
      from_year: fromYear, from_month: MONTHS[fromIndex],
      to_year: state.year, to_month: monthName(),
    }),
  });
  if (res.ok) load();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('budget-prev').addEventListener('click', () => step(-1));
  document.getElementById('budget-next').addEventListener('click', () => step(1));
  document.getElementById('budget-copy').addEventListener('click', copyLastMonth);
  window.addEventListener('currencychange', render);
  load();
});
