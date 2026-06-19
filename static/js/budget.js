'use strict';

// ─── Budget (Envelope target-vs-actual) ──────────────────────────────────────
// Per-month zero-based budgeting: set a target per spending/savings/investing
// category and watch a progress bar fill from your actual transactions, with a
// "left to budget" roll-up and an allocation meter (budgeted vs expected income).
// All data is server-side (GET /api/budget); targets are written through
// POST/DELETE /api/budget/target, the income override through /api/budget/income.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), CURRENCY_SYMBOL / formatCurrency / stripCurrencyValue /
// applyCurrencyFormat (currency.js), UI (ui.js).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Budgetable category types, in the order their sections stack down the page.
// Income isn't budgeted — it's the inflow that drives "left to budget".
const GROUPS = [
  ['expense', 'Expense'],
  ['savings', 'Savings'],
  ['investing', 'Investing'],
];

const state = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),
  data: null,
};

const monthName = () => MONTHS[state.monthIndex];

// ─── Currency formatting (compact, currency-symbol aware) ────────────────────
function fmtMoney(n) {
  return formatCurrency(n, true);
}

function infoIcon(tip) {
  const t = escapeHtml(tip);
  return `<span class="fc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">i</span>`;
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function load() {
  document.getElementById('budget-month-label').textContent = `${monthName()} ${state.year}`;
  const res = await apiFetch(`/api/budget?year=${state.year}&month=${monthName()}`);
  if (!res.ok) return;
  state.data = await res.json();
  render();
}

function render() {
  document.getElementById('budget-month-label').textContent = `${monthName()} ${state.year}`;
  renderSummary();
  renderGroups();
}

// ─── Zero-based summary + allocation meter ───────────────────────────────────

function renderSummary() {
  const el = document.getElementById('budget-summary');
  if (!el || !state.data) return;
  const s = state.data.summary;

  const expectedTip = 'What you expect to take in this month — the figure "left to budget" '
    + 'is measured against, so it\'s meaningful from day 1. It defaults to your average '
    + 'monthly income from recent months; type a number to set your own, or clear it to go '
    + 'back to the average.';
  const sourceNote = s.incomeSource === 'override' ? 'custom' : 'auto · avg of recent months';

  // "Left to budget" is the hero of zero-based budgeting: zero means every
  // dollar has a job, negative means you've over-committed.
  let leftCls = 'pos';
  let leftHint = 'still to assign';
  if (s.leftToBudget < 0) { leftCls = 'neg'; leftHint = 'over-committed'; }
  else if (s.leftToBudget === 0) { leftCls = 'balanced'; leftHint = 'every dollar assigned'; }

  // Allocation meter — how much of expected income is already budgeted.
  const allocPct = s.expectedIncome > 0
    ? Math.min(s.budgeted / s.expectedIncome, 1) * 100
    : (s.budgeted > 0 ? 100 : 0);
  const allocBand = s.leftToBudget < 0 ? 'neg' : (s.leftToBudget === 0 ? 'balanced' : 'pos');

  el.innerHTML = `
    <div class="budget-stats">
      <div class="budget-stat budget-stat-income">
        <span class="budget-stat-label">Expected income${infoIcon(expectedTip)}</span>
        <input type="text" id="budget-income-input" class="budget-income-input" inputmode="decimal"
               spellcheck="false" autocomplete="off" placeholder="—" aria-label="Expected income"
               value="${formatCurrency(s.expectedIncome, true, { editable: true })}">
        <span class="budget-stat-sub">${fmtMoney(s.received)} received · ${escapeHtml(sourceNote)}</span>
      </div>

      <div class="budget-stat">
        <span class="budget-stat-label">Budgeted${infoIcon('The sum of every envelope target you have set for this month.')}</span>
        <span class="budget-stat-value">${fmtMoney(s.budgeted)}</span>
        <span class="budget-stat-sub">${fmtMoney(s.spent)} spent so far</span>
      </div>

      <div class="budget-stat budget-stat-hero">
        <span class="budget-stat-label">Left to budget${infoIcon('Expected income minus everything you have budgeted. Zero means every dollar has a job; negative means you have budgeted more than you expect to bring in.')}</span>
        <span class="budget-stat-value ${leftCls}">${fmtMoney(s.leftToBudget)}</span>
        <span class="budget-stat-sub ${leftCls}">${leftHint}</span>
      </div>
    </div>

    <div class="budget-alloc">
      <div class="budget-alloc-bar">
        <div class="budget-alloc-fill alloc-${allocBand}" style="width:${allocPct}%"></div>
      </div>
      <div class="budget-alloc-legend">
        <span>${fmtMoney(s.budgeted)} budgeted</span>
        <span>of ${fmtMoney(s.expectedIncome)} expected</span>
      </div>
    </div>`;

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

// ─── Envelope groups ─────────────────────────────────────────────────────────

function renderGroups() {
  const el = document.getElementById('budget-groups');
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

  let html = '';
  for (const [type, label] of GROUPS) {
    const group = cats.filter((c) => c.cat_type === type);
    if (!group.length) continue;

    const budgeted = group.reduce((a, c) => a + c.target, 0);
    const spent = group.reduce((a, c) => a + c.spent, 0);

    html += `<section class="budget-group" data-type="${type}">
      <div class="budget-group-head">
        <span class="budget-group-title">${label}</span>
        <span class="budget-group-count">${group.length}</span>
        <span class="budget-group-totals">${fmtMoney(spent)} <span class="budget-group-of">of</span> ${fmtMoney(budgeted)}</span>
      </div>
      <div class="budget-grid">${group.map(envelopeCard).join('')}</div>
    </section>`;
  }
  el.innerHTML = html;

  el.querySelectorAll('.budget-target-input').forEach((input) => {
    input.addEventListener('input', () => applyCurrencyFormat(input));
    input.addEventListener('change', () => commitTarget(input));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
}

function envelopeCard(c) {
  const hasTarget = c.target > 0;
  const ratio = hasTarget ? c.spent / c.target : 0;
  const widthPct = Math.min(ratio, 1) * 100;
  const over = hasTarget && c.spent > c.target;

  // Bar colour bands: green ≤75%, amber ≤90%, red past 90% (incl. over budget).
  let band = 'green';
  if (ratio > 0.90) band = 'red';
  else if (ratio > 0.75) band = 'yellow';

  let statusText;
  let statusCls;
  if (!hasTarget) {
    statusText = c.spent > 0 ? 'Untracked' : 'No target';
    statusCls = 'muted';
  } else if (over) {
    statusText = `${fmtMoney(c.spent - c.target)} over`;
    statusCls = 'neg';
  } else {
    statusText = `${fmtMoney(c.remaining)} left`;
    statusCls = 'pos';
  }

  return `<article class="budget-env${hasTarget ? '' : ' is-untracked'}" data-key="${escapeHtml(c.key)}">
    <div class="budget-env-head">
      <span class="budget-env-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
      <span class="budget-env-status ${statusCls}">${statusText}</span>
    </div>
    <div class="budget-bar">
      <div class="budget-bar-fill bar-${band}" style="width:${widthPct}%"></div>
    </div>
    <div class="budget-env-foot">
      <span class="budget-env-spent">${fmtMoney(c.spent)}</span>
      <span class="budget-env-of">of</span>
      <input type="text" class="budget-target-input" inputmode="decimal" spellcheck="false"
             autocomplete="off" placeholder="—" aria-label="Target for ${escapeHtml(c.name)}"
             data-key="${escapeHtml(c.key)}" value="${hasTarget ? formatCurrency(c.target, true, { editable: true }) : ''}">
    </div>
  </article>`;
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
