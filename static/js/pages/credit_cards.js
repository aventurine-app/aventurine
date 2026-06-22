'use strict';

// ─── Credit Cards page ──────────────────────────────────────────────────────
// One container card per credit card. The user fills in four fields
// (available credit, rewards %, annual fee, linked expense category) and the
// card answers with derived planning stats:
//
//   - Monthly utilization  = avg monthly spend ÷ available credit, colour-
//     scaled against credit-building guidance (≤15% green … >50% red)
//   - Avg monthly spend    = served by the backend per expense category
//     (recent active months of the Cash Flow data — see
//     electron/backend/services/creditCards.js for the averaging policy)
//   - Annual rewards       = avg monthly spend × 12 × rewards %
//   - Net annual gain      = annual rewards − annual fee
//
// The backend ships monthly_spend for EVERY expense category up front, so
// switching a card's category dropdown recomputes instantly with no fetch.
//
// What it borrows from globals already loaded by base.html / this page:
//   escapeHtml (escape.js); CURRENCY_SYMBOL, formatCurrency,
//   applyCurrencyFormat, stripCurrencyValue (currency.js);
//   debounce + the .confirm-* dialog classes (tables.js / tables.css).

// ─── State ──────────────────────────────────────────────────────────────────
let CC_CARDS      = [];   // card objects, mutated in place by the inputs
let CC_CATEGORIES = [];   // [{id, name}] expense categories, Settings order
let CC_SPEND      = {};   // {category_id (str): avg monthly spend}

// Utilization tiers — conventional credit-building guidance. `pct` is the
// inclusive upper bound of each band.
const CC_UTIL_TIERS = [
    { pct: 15,       cls: 'cc-util-good', label: 'Excellent' },
    { pct: 30,       cls: 'cc-util-ok',   label: 'Good'      },
    { pct: 50,       cls: 'cc-util-high', label: 'High'      },
    { pct: Infinity, cls: 'cc-util-bad',  label: 'Very High' },
];

// ─── API client ─────────────────────────────────────────────────────────────
const ccApi = (() => {
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const sendJson = (url, method, body) =>
        apiFetch(url, { method, headers: jsonHeaders, body: JSON.stringify(body) });
    return {
        getAll:     ()          => apiFetch('/api/credit-cards/data').then(r => r.json()),
        createCard: ()          => sendJson('/api/credit-cards', 'POST', {}).then(r => r.json()),
        updateCard: (id, patch) => sendJson(`/api/credit-cards/${id}`, 'PUT', patch),
        deleteCard: (id)        => apiFetch(`/api/credit-cards/${id}`, { method: 'DELETE' }),
    };
})();

// ─── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const data    = await ccApi.getAll();
    CC_CARDS      = data.cards;
    CC_CATEGORIES = data.categories;
    CC_SPEND      = data.monthly_spend;
    renderGrid();
    document.getElementById('cc-add-btn').addEventListener('click', addCard);
});

function renderGrid() {
    const grid = document.getElementById('cc-grid');
    grid.innerHTML = '';
    if (!CC_CARDS.length) {
        const empty = document.createElement('p');
        empty.className   = 'cc-empty';
        empty.textContent = 'No cards yet — add your first credit card to start planning.';
        grid.appendChild(empty);
        return;
    }
    for (const card of CC_CARDS) {
        grid.appendChild(buildCard(card));
    }
}

// ─── Card builder ───────────────────────────────────────────────────────────

function buildCard(card) {
    const el = document.createElement('div');
    el.className = 'cc-card';
    el.dataset.cardId = card.id;

    // ── Header: editable name + remove button ──────────────────────────────
    const top = document.createElement('div');
    top.className = 'cc-card-top';

    const nameInput = document.createElement('input');
    nameInput.type        = 'text';
    nameInput.className   = 'cc-name-input';
    nameInput.value       = card.name;
    nameInput.maxLength   = 100;
    nameInput.placeholder = 'Card name';
    const saveName = debounce(async () => {
        const name = nameInput.value.trim();
        if (!name || name === card.name) return;
        card.name = name;
        await ccApi.updateCard(card.id, { name });
    }, 600);
    nameInput.addEventListener('input', saveName);
    // An emptied name field snaps back to the last saved name on blur —
    // the backend rejects blank names, so don't pretend it stuck.
    nameInput.addEventListener('blur', () => {
        if (!nameInput.value.trim()) nameInput.value = card.name;
    });
    top.appendChild(nameInput);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'cc-remove-btn';
    removeBtn.title     = 'Remove card';
    removeBtn.setAttribute('aria-label', 'Remove card');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => confirmRemoveCard(card));
    top.appendChild(removeBtn);
    el.appendChild(top);

    // ── User-entered fields ─────────────────────────────────────────────────
    const fields = document.createElement('div');
    fields.className = 'cc-fields';

    const refresh = () => updateStats(card, el);

    fields.appendChild(buildMoneyField(card, 'credit_limit', 'Available Credit', refresh));

    // Rewards % — plain decimal input with a fixed % suffix.
    const pctField = document.createElement('label');
    pctField.className = 'cc-field';
    const pctLabel = document.createElement('span');
    pctLabel.className   = 'cc-field-label';
    pctLabel.textContent = 'Rewards / Cash Back';
    pctField.appendChild(pctLabel);
    const pctWrap = document.createElement('div');
    pctWrap.className = 'cc-pct-wrap';
    const pctInput = document.createElement('input');
    pctInput.type        = 'text';
    pctInput.inputMode   = 'decimal';
    pctInput.className   = 'cc-input';
    pctInput.placeholder = '0';
    if (card.rewards_pct) pctInput.value = String(card.rewards_pct);
    const savePct = debounce(() => ccApi.updateCard(card.id, { rewards_pct: card.rewards_pct }), 600);
    pctInput.addEventListener('input', () => {
        const cleaned = pctInput.value.replace(/[^0-9.]/g, '');
        if (cleaned !== pctInput.value) pctInput.value = cleaned;
        card.rewards_pct = Math.min(100, parseFloat(cleaned) || 0);
        refresh();
        savePct();
    });
    pctWrap.appendChild(pctInput);
    const pctSuffix = document.createElement('span');
    pctSuffix.className   = 'cc-pct-suffix';
    pctSuffix.textContent = '%';
    pctWrap.appendChild(pctSuffix);
    pctField.appendChild(pctWrap);
    fields.appendChild(pctField);

    fields.appendChild(buildMoneyField(card, 'annual_fee', 'Annual Fee', refresh));

    // Linked expense category dropdown.
    const catField = document.createElement('label');
    catField.className = 'cc-field';
    const catLabel = document.createElement('span');
    catLabel.className   = 'cc-field-label';
    catLabel.textContent = 'Expense Category';
    catField.appendChild(catLabel);
    const select = document.createElement('select');
    select.className = 'cc-input cc-select';
    const noneOpt = document.createElement('option');
    noneOpt.value       = '';
    noneOpt.textContent = '— None —';
    select.appendChild(noneOpt);
    for (const cat of CC_CATEGORIES) {
        const opt = document.createElement('option');
        opt.value       = String(cat.id);
        opt.textContent = cat.name;
        select.appendChild(opt);
    }
    select.value = card.category_id == null ? '' : String(card.category_id);
    select.addEventListener('change', () => {
        card.category_id = select.value === '' ? null : parseInt(select.value, 10);
        refresh();
        ccApi.updateCard(card.id, { category_id: card.category_id });
    });
    catField.appendChild(select);
    fields.appendChild(catField);

    el.appendChild(fields);

    // ── Derived stats ───────────────────────────────────────────────────────
    // Static skeleton (no user-controlled strings); values are filled by
    // updateStats() via textContent.
    const stats = document.createElement('div');
    stats.className = 'cc-stats';
    stats.innerHTML = `
        <div class="cc-util">
            <div class="cc-util-head">
                <span class="cc-stat-label">Monthly Utilization</span>
                <span class="cc-util-value">—</span>
            </div>
            <div class="cc-util-bar"><div class="cc-util-fill"></div></div>
        </div>
        <div class="cc-stat-row">
            <span class="cc-stat-label">Avg Monthly Spend</span>
            <span class="cc-stat-value cc-spend-value">—</span>
        </div>
        <div class="cc-stat-row">
            <span class="cc-stat-label">Annual Rewards</span>
            <span class="cc-stat-value cc-rewards-value">—</span>
        </div>
        <div class="cc-stat-row">
            <span class="cc-stat-label">Net Annual Gain</span>
            <span class="cc-stat-value cc-gain-value">—</span>
        </div>
        <p class="cc-stats-hint"></p>`;
    el.appendChild(stats);

    updateStats(card, el);
    return el;
}

/** Build one currency field (Available Credit / Annual Fee). */
function buildMoneyField(card, field, labelText, refresh) {
    const wrap = document.createElement('label');
    wrap.className = 'cc-field';
    const label = document.createElement('span');
    label.className   = 'cc-field-label';
    label.textContent = labelText;
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.type        = 'text';
    input.inputMode   = 'decimal';
    input.className   = 'cc-input';
    input.placeholder = formatCurrency(0, true, { editable: true });
    if (card[field]) input.value = formatCurrency(card[field], true, { editable: true });
    const save = debounce(() => ccApi.updateCard(card.id, { [field]: card[field] }), 600);
    input.addEventListener('input', () => {
        applyCurrencyFormat(input);
        card[field] = parseFloat(stripCurrencyValue(input.value)) || 0;
        refresh();
        save();
    });
    wrap.appendChild(input);
    return wrap;
}

// ─── Derived stats ──────────────────────────────────────────────────────────

/** Recompute and paint one card's stats block from its current fields. */
function updateStats(card, el) {
    const utilValue  = el.querySelector('.cc-util-value');
    const utilFill   = el.querySelector('.cc-util-fill');
    const spendEl    = el.querySelector('.cc-spend-value');
    const rewardsEl  = el.querySelector('.cc-rewards-value');
    const gainEl     = el.querySelector('.cc-gain-value');
    const hintEl     = el.querySelector('.cc-stats-hint');

    const tierClasses = CC_UTIL_TIERS.map(t => t.cls);
    const resetTier = node => node.classList.remove(...tierClasses);
    resetTier(utilValue);
    resetTier(utilFill);

    if (card.category_id == null) {
        utilValue.textContent = '—';
        utilFill.style.width  = '0%';
        spendEl.textContent   = '—';
        rewardsEl.textContent = '—';
        gainEl.textContent    = '—';
        gainEl.classList.remove('cc-gain-positive', 'cc-gain-negative');
        hintEl.textContent = 'Pick an expense category to see utilization and rewards.';
        return;
    }

    const spend = CC_SPEND[String(card.category_id)] || 0;
    spendEl.textContent = formatCurrency(spend, true) || formatCurrency(0, true);

    // Utilization — needs a credit limit to be meaningful.
    if (card.credit_limit > 0) {
        const util = (spend / card.credit_limit) * 100;
        const tier = CC_UTIL_TIERS.find(t => util <= t.pct);
        utilValue.textContent = `${util.toFixed(1)}% · ${tier.label}`;
        utilValue.classList.add(tier.cls);
        utilFill.classList.add(tier.cls);
        utilFill.style.width = Math.min(util, 100) + '%';
        hintEl.textContent = '';
    } else {
        utilValue.textContent = '—';
        utilFill.style.width  = '0%';
        hintEl.textContent = 'Enter the card’s available credit to see utilization.';
    }

    // Rewards & net gain are annual figures: the monthly average spend
    // annualized, so they can be compared against the annual fee.
    const annualRewards = spend * 12 * (card.rewards_pct / 100);
    const gain          = annualRewards - card.annual_fee;
    rewardsEl.textContent = formatCurrency(annualRewards, true) || formatCurrency(0, true);
    gainEl.textContent    = (gain >= 0 ? '+' : '−') + (formatCurrency(Math.abs(gain), true) || formatCurrency(0, true));
    gainEl.classList.toggle('cc-gain-positive', gain >= 0);
    gainEl.classList.toggle('cc-gain-negative', gain < 0);
}

// ─── Add / remove ───────────────────────────────────────────────────────────

async function addCard() {
    const data = await ccApi.createCard();
    if (!data.ok) return;
    CC_CARDS.push(data.card);
    if (CC_CARDS.length === 1) {
        renderGrid();           // replaces the empty-state message
    } else {
        document.getElementById('cc-grid').appendChild(buildCard(data.card));
    }
    // Drop focus into the new card's name so renaming is one keystroke away.
    const grid = document.getElementById('cc-grid');
    const nameInput = grid.lastElementChild.querySelector('.cc-name-input');
    nameInput.focus();
    nameInput.select();
}

/** Confirm + delete a card. Same .confirm-* dialog chrome as the trackers. */
function confirmRemoveCard(card) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p>Remove card <strong>${escapeHtml(card.name)}</strong>?<br>This cannot be undone.</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-delete">Remove</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-close-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.confirm-delete').addEventListener('click', async () => {
        overlay.remove();
        await ccApi.deleteCard(card.id);
        CC_CARDS = CC_CARDS.filter(c => c.id !== card.id);
        document.querySelector(`.cc-card[data-card-id="${card.id}"]`)?.remove();
        if (!CC_CARDS.length) renderGrid();
    });
}
