'use strict';

// ─── Budget (recurring envelopes) ────────────────────────────────────────────
// One standing target per category, applied to every month — there is no
// per-month target. The page shows each budgeted category as an envelope whose
// bar fills from the *viewed* month's actual spending; the ‹ month › switcher
// only changes which month's spend you're looking at, never the budget itself.
//
// Categories without a budget are hidden from the dashboard and tucked behind an
// "Add a budget" menu, so the grid stays focused on the budgets that matter and
// unused ones are one click away.
//
// Data is server-side: GET /api/budget?year=&month= returns every budgetable
// category with its global `target` and the month's `spent`; targets are written
// through POST/DELETE /api/budget/target ({ category, value }).
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), formatCurrency / stripCurrencyValue / applyCurrencyFormat
// (currency.js), UI (ui.js).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Budgetable category types, in the order their sections stack down the page.
// Income isn't budgeted — it's surfaced only as a small reference figure.
const GROUPS = [
  ['expense', 'Expense'],
  ['savings', 'Savings'],
  ['investing', 'Investing'],
];

const state = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),
  data: null,
  // Keys the user is drafting a budget for: shown as an empty envelope before a
  // target is saved. Transient UI state, cleared when the month changes.
  drafts: new Set(),
  // A draft key whose input should grab focus after the next render.
  pendingFocus: null,
  // The open add-budget popover, or null.
  menu: null,
};

const monthName = () => MONTHS[state.monthIndex];
const fmtMoney = (n) => formatCurrency(n, true);

/** The server row for a category key (or undefined). */
function catRow(key) {
  return state.data ? state.data.categories.find((c) => c.key === key) : undefined;
}

/** A category's saved recurring target (0 when unbudgeted). */
function catTarget(key) {
  const c = catRow(key);
  return c ? c.target : 0;
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
  renderIncome();
  renderGroups();
}

// ─── Income reference (demoted) ──────────────────────────────────────────────

function renderIncome() {
  const el = document.getElementById('budget-income');
  if (!el || !state.data) return;
  const received = state.data.summary.received || 0;
  el.textContent = `${fmtMoney(received)} income in ${monthName()}`;
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

  // First run: nothing budgeted yet — one focused call to action beats three
  // sparse, empty group sections.
  const anyBudgeted = cats.some((c) => c.target > 0) || state.drafts.size > 0;
  if (!anyBudgeted) {
    el.innerHTML = UI.emptyState({
      icon: 'target',
      title: 'Set up your budgets',
      desc: 'Give a category a monthly target and it becomes an envelope you can track. The target carries to every month.',
      action: { label: 'Add a budget', name: 'add-budget', icon: 'plus', primary: true },
    });
    el.querySelector('[data-empty-action="add-budget"]')
      ?.addEventListener('click', (e) => openAddMenu(e.currentTarget, null));
    return;
  }

  let html = '';
  for (const [type, label] of GROUPS) {
    const group = cats.filter((c) => c.cat_type === type);
    if (!group.length) continue;
    const cards = group.filter((c) => c.target > 0 || state.drafts.has(c.key));
    const addable = group.filter((c) => c.target === 0 && !state.drafts.has(c.key));
    if (!cards.length && !addable.length) continue;

    html += `<section class="budget-group" data-type="${type}">
      <div class="budget-group-head">
        <span class="budget-group-title">${label}</span>
        <span class="budget-group-count">${cards.length}</span>
      </div>
      <div class="budget-grid">
        ${cards.map(envelopeCard).join('')}
        ${addable.length ? addTile(type) : ''}
      </div>
    </section>`;
  }
  el.innerHTML = html;
  wireGroups(el);
  focusPendingDraft(el);
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
    statusText = 'Set an amount';
    statusCls = 'muted';
  } else if (over) {
    statusText = `${fmtMoney(c.spent - c.target)} over`;
    statusCls = 'neg';
  } else {
    statusText = `${fmtMoney(c.remaining)} left`;
    statusCls = 'pos';
  }

  const name = escapeHtml(c.name);
  return `<article class="budget-env${hasTarget ? '' : ' is-draft'}" data-key="${escapeHtml(c.key)}">
    <div class="budget-env-head">
      <span class="budget-env-name" title="${name}">${name}</span>
      <span class="budget-env-status ${statusCls}">${statusText}</span>
      <button type="button" class="budget-env-remove" data-remove="${escapeHtml(c.key)}"
              aria-label="Remove budget for ${name}" title="Remove budget">×</button>
    </div>
    <div class="budget-bar">
      <div class="budget-bar-fill bar-${band}" style="width:${widthPct}%"></div>
    </div>
    <div class="budget-env-foot">
      <span class="budget-env-spent">${fmtMoney(c.spent)}</span>
      <span class="budget-env-of">of</span>
      <input type="text" class="budget-target-input" inputmode="decimal" spellcheck="false"
             autocomplete="off" placeholder="—" aria-label="Monthly budget for ${name}"
             data-key="${escapeHtml(c.key)}" value="${hasTarget ? formatCurrency(c.target, true, { editable: true }) : ''}">
    </div>
  </article>`;
}

function addTile(type) {
  const plus = UI.ICONS.plus;
  return `<button type="button" class="budget-addtile" data-addtype="${type}" aria-haspopup="menu">
    ${plus}<span>Add a budget</span>
  </button>`;
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireGroups(root) {
  root.querySelectorAll('.budget-target-input').forEach((input) => {
    input.addEventListener('input', () => applyCurrencyFormat(input));
    input.addEventListener('change', () => commitTarget(input));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
  root.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeBudget(btn.dataset.remove));
  });
  root.querySelectorAll('.budget-addtile').forEach((tile) => {
    tile.addEventListener('click', () => openAddMenu(tile, tile.dataset.addtype));
  });
}

function focusPendingDraft(root) {
  if (!state.pendingFocus) return;
  const input = root.querySelector(`.budget-target-input[data-key="${CSS.escape(state.pendingFocus)}"]`);
  state.pendingFocus = null;
  if (!input) return;
  input.focus();
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function commitTarget(input) {
  const key = input.dataset.key;
  const raw = stripCurrencyValue(input.value);

  if (raw === '' || Number(raw) === 0) {
    // Cleared → drop the budget (a never-saved draft just vanishes locally).
    await removeBudget(key);
    return;
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return;
  await apiFetch('/api/budget/target', { method: 'POST', body: JSON.stringify({ category: key, value: amount }) });
  state.drafts.delete(key);
  load();
}

async function removeBudget(key) {
  const wasSaved = catTarget(key) > 0;
  state.drafts.delete(key);
  if (wasSaved) {
    await apiFetch('/api/budget/target', { method: 'DELETE', body: JSON.stringify({ category: key }) });
    load();
  } else {
    render();
  }
}

// ─── Add-budget popover ──────────────────────────────────────────────────────
// A category with no budget lives here until the user picks it. `type` scopes
// the list to one group (from a group's add tile) or is null for all groups
// (the first-run empty state).

function addableByType(type) {
  const cats = state.data.categories.filter(
    (c) => c.target === 0 && !state.drafts.has(c.key) && (!type || c.cat_type === type)
  );
  return cats;
}

function menuItemHtml(c) {
  const hint = c.spent > 0 ? `<span class="budget-addmenu-hint">${fmtMoney(c.spent)} spent</span>` : '';
  return `<button type="button" class="budget-addmenu-item" role="menuitem" data-key="${escapeHtml(c.key)}">
    <span class="budget-addmenu-name">${escapeHtml(c.name)}</span>${hint}
  </button>`;
}

function openAddMenu(anchor, type) {
  closeAddMenu();
  const menu = document.createElement('div');
  menu.className = 'budget-addmenu';
  menu.setAttribute('role', 'menu');

  if (type) {
    menu.innerHTML = addableByType(type).map(menuItemHtml).join('');
  } else {
    // All groups, each under a small label.
    menu.innerHTML = GROUPS.map(([t, label]) => {
      const items = addableByType(t);
      if (!items.length) return '';
      return `<div class="budget-addmenu-group">${label}</div>${items.map(menuItemHtml).join('')}`;
    }).join('');
  }

  document.body.appendChild(menu);
  positionMenu(menu, anchor);

  menu.querySelectorAll('.budget-addmenu-item').forEach((item) => {
    item.addEventListener('click', () => { const key = item.dataset.key; closeAddMenu(); startDraft(key); });
  });

  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeAddMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeAddMenu(); anchor.focus(); } };
  const onScroll = () => closeAddMenu();
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
  state.menu = { el: menu, onDoc, onKey, onScroll };

  menu.querySelector('.budget-addmenu-item')?.focus();
}

function closeAddMenu() {
  if (!state.menu) return;
  const { el, onDoc, onKey, onScroll } = state.menu;
  document.removeEventListener('mousedown', onDoc);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('scroll', onScroll, true);
  el.remove();
  state.menu = null;
}

/** Place the fixed-position menu under the anchor, flipping at viewport edges. */
function positionMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, r.right - mw);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function startDraft(key) {
  state.drafts.add(key);
  state.pendingFocus = key;
  render();
}

// ─── Month navigation ────────────────────────────────────────────────────────

function step(delta) {
  let m = state.monthIndex + delta;
  let y = state.year;
  if (m < 0) { m = 11; y -= 1; }
  else if (m > 11) { m = 0; y += 1; }
  state.monthIndex = m;
  state.year = y;
  state.drafts.clear();
  closeAddMenu();
  load();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('budget-prev').addEventListener('click', () => step(-1));
  document.getElementById('budget-next').addEventListener('click', () => step(1));
  window.addEventListener('currencychange', () => { if (state.data) render(); });
  load();
});
