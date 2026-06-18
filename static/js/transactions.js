// ─── Transactions page ────────────────────────────────────────────────────────
// Independent ledger of dated rows. Each row's direction (income vs expense)
// is implicit from its category's cat_type — no separate Type column.
//
// Display mode is read-only; clicking the pencil flips a row into edit mode
// (inputs in place), and "Add Transaction" prepends a synthetic "new" row
// with the same edit-mode UI. One row can be in edit mode at a time;
// entering edit mode on another row cancels the current one.
//
// Import lives in txfileimport.js — kept separate so the format-handling
// code there can grow without bloating this file.
//
// State:
//   txState.rows         — list of transactions, newest first
//   txState.categories   — category vocabulary (shared with I&E + Settings)
//   txState.editingId    — id of the row being edited, 'new' for the add row,
//                          or null when nothing is being edited
//   txState.filters      — Transactions Search controls, raw input values;
//                          a blank value means that filter is off

const txState = {
    rows:       [],
    categories: [],
    editingId:  null,
    filters: {
        dateFrom:  '',
        dateTo:    '',
        name:      '',
        amountMin: '',
        amountMax: '',
        type:      '',
        category:  '',   // '' all | 'none' uncategorized | category id
    },
};

// ─── HTML safety ─────────────────────────────────────────────────────────────
// User-controlled strings (description, notes, category name) all pass
// through this before being placed in innerHTML. Alias of the shared global
// in escape.js (loaded by base.html).
const txEsc = escapeHtml;

// ─── Formatters ──────────────────────────────────────────────────────────────
// CURRENCY_SYMBOL is from currency.js, loaded globally in base.html.
const TX_THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

function txFmtAmount(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
    return CURRENCY_SYMBOL + intPart.replace(TX_THOUSANDS, ',') + '.' + decPart;
}

// Display the date as "Mon DD, YYYY" — friendlier than ISO for the row.
const TX_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function txFmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return `${TX_MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

function txTodayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function txApiList() {
    const r = await apiFetch('/api/transactions');
    if (!r.ok) throw new Error('failed to list transactions');
    return r.json();
}

async function txApiCreate(payload) {
    const r = await apiFetch('/api/transactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'failed to create');
    return data.transaction;
}

async function txApiUpdate(id, payload) {
    const r = await apiFetch(`/api/transactions/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'failed to update');
    return data.transaction;
}

async function txApiDelete(id) {
    const r = await apiFetch(`/api/transactions/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('failed to delete');
}

// ─── SVG icons ───────────────────────────────────────────────────────────────
// Inlined so the action buttons don't depend on an icon font / external sprite.
const TX_ICONS = {
    pencil: '<svg viewBox="0 0 20 20" fill="none"><path d="M14.5 3.5l2 2-9.5 9.5-3 1 1-3 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    check:  '<svg viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:  '<svg viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    trash:  '<svg viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ─── Category lookup helpers ─────────────────────────────────────────────────
// Look up the row whose `id` matches — used in both directions: rendering
// a transaction needs the category's `name` and `cat_type` to colour the
// amount; reading an edited row only needs the id.

function txCategoryById(id) {
    return txState.categories.find(c => c.id === id) || null;
}

function txCategoryName(id) {
    return txCategoryById(id)?.name ?? null;
}

function txCategoryType(id) {
    return txCategoryById(id)?.cat_type ?? null;
}

// ─── Row rendering ───────────────────────────────────────────────────────────

function txRenderDisplayRow(t) {
    const catName = txCategoryName(t.category_id);
    const catCell = catName
        ? `<span class="tx-category-pill">${txEsc(catName)}</span>`
        : `<span class="tx-category-pill tx-category-empty">Uncategorized</span>`;

    const TYPE_META = {
        income:    { label: 'Income',    cls: 'tx-type-income',    amtCls: 'tx-amount-income',    sign: '+ ' },
        expense:   { label: 'Expense',   cls: 'tx-type-expense',   amtCls: 'tx-amount-expense',   sign: '- ' },
        savings:   { label: 'Savings',   cls: 'tx-type-savings',   amtCls: 'tx-amount-savings',   sign: '- ' },
        investing: { label: 'Investing', cls: 'tx-type-investing', amtCls: 'tx-amount-investing', sign: '- ' },
    };
    const meta        = TYPE_META[t.tx_type] || TYPE_META.expense;
    const amountClass = meta.amtCls;
    const sign        = meta.sign;
    const typeLabel   = meta.label;
    const typeClass   = meta.cls;

    return `
        <tr class="tx-row" data-id="${t.id}">
            <td class="tx-col-date">${txEsc(txFmtDate(t.date))}</td>
            <td class="tx-col-description">${txEsc(t.description)}</td>
            <td class="tx-col-type"><span class="tx-type-pill ${typeClass}">${typeLabel}</span></td>
            <td class="tx-col-category">${catCell}</td>
            <td class="tx-col-amount ${amountClass}">${sign}${txFmtAmount(t.amount)}</td>
            <td class="tx-col-notes">${txEsc(t.notes)}</td>
            <td class="tx-col-actions tx-actions-cell">
                <div class="tx-action-group">
                    <button class="tx-action-btn tx-action-edit"   data-action="edit"   data-id="${t.id}" title="Edit">${TX_ICONS.pencil}</button>
                    <button class="tx-action-btn tx-action-delete" data-action="delete" data-id="${t.id}" title="Delete">${TX_ICONS.trash}</button>
                </div>
            </td>
        </tr>
    `;
}

function txRenderEditRow(t, { isNew }) {
    // Category options — include an "Uncategorized" sentinel so the user
    // can save without picking a category. Backend treats null category_id
    // as Uncategorized.
    const TYPE_ORDER = ['income', 'expense', 'savings', 'investing'];
    const TYPE_LABELS = { income: 'Income', expense: 'Expense', savings: 'Savings', investing: 'Investing' };
    const groups = {};
    TYPE_ORDER.forEach(k => { groups[k] = []; });
    txState.categories.forEach(c => { (groups[c.cat_type] || (groups[c.cat_type] = [])).push(c); });
    TYPE_ORDER.forEach(k => groups[k].sort((a, b) => a.position - b.position));
    const catOptions = ['<option value="">Uncategorized</option>']
        .concat(TYPE_ORDER.flatMap(k => {
            if (!groups[k].length) return [];
            const opts = groups[k].map(c => {
                const sel = c.id === t.category_id ? 'selected' : '';
                return `<option value="${c.id}" ${sel}>${txEsc(c.name)}</option>`;
            }).join('');
            return [`<optgroup label="${TYPE_LABELS[k]}">${opts}</optgroup>`];
        })).join('');

    const rowClass  = isNew ? 'tx-row tx-new' : 'tx-row tx-editing';
    const rowId     = isNew ? 'new' : t.id;
    const txType    = t.tx_type || 'expense';
    return `
        <tr class="${rowClass}" data-id="${rowId}">
            <td class="tx-col-date">
                <input type="date" class="tx-input tx-input-date" data-field="date"
                       value="${txEsc(t.date || '')}">
            </td>
            <td class="tx-col-description">
                <input type="text" class="tx-input tx-input-description" data-field="description"
                       value="${txEsc(t.description || '')}" placeholder="Description">
            </td>
            <td class="tx-col-type">
                <select class="tx-select tx-input-type" data-field="tx_type">
                    <option value="expense"  ${txType === 'expense'   ? 'selected' : ''}>Expense</option>
                    <option value="income"   ${txType === 'income'    ? 'selected' : ''}>Income</option>
                    <option value="savings"  ${txType === 'savings'   ? 'selected' : ''}>Savings</option>
                    <option value="investing"${txType === 'investing' ? 'selected' : ''}>Investing</option>
                </select>
            </td>
            <td class="tx-col-category">
                <select class="tx-select tx-input-category" data-field="category_id">${catOptions}</select>
            </td>
            <td class="tx-col-amount">
                <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-field="amount"
                       value="${t.amount != null ? t.amount : ''}" placeholder="0.00">
            </td>
            <td class="tx-col-notes">
                <input type="text" class="tx-input tx-input-notes" data-field="notes"
                       value="${txEsc(t.notes || '')}" placeholder="Optional">
            </td>
            <td class="tx-col-actions tx-actions-cell">
                <div class="tx-action-group">
                    <button class="tx-action-btn tx-action-save"   data-action="save"   data-id="${rowId}" title="Save">${TX_ICONS.check}</button>
                    <button class="tx-action-btn tx-action-cancel" data-action="cancel" data-id="${rowId}" title="Cancel">${TX_ICONS.cross}</button>
                </div>
            </td>
        </tr>
    `;
}

function txEmptyRow(filtered) {
    const inner = filtered
        ? UI.emptyState({
            icon: 'search', compact: true,
            title: 'No matching transactions',
            desc: 'Nothing matches your current filters — adjust or clear them to see more.',
            action: { label: 'Clear filters', name: 'tx-clear-filters' },
        })
        : UI.emptyState({
            icon: 'receipt',
            title: 'No transactions yet',
            desc: 'Add a transaction by hand, or import a statement from your bank to get started.',
            action: { label: 'Add transaction', name: 'tx-add', icon: 'plus', primary: true },
        });
    return `<tr class="tx-empty-row"><td colspan="7">${inner}</td></tr>`;
}

// Skeleton placeholder rows shown while the ledger loads (cold fetch only).
// Reuses .tx-row so each placeholder is exactly one real row tall.
function txSkeletonRows(n) {
    const cell = (w) => `<td><div class="skeleton skeleton-line sk-w-${w}"></div></td>`;
    const row = '<tr class="tx-row tx-skeleton-row">'
        + cell('75') + cell('90') + cell('50') + cell('60') + cell('50') + cell('40') + cell('40')
        + '</tr>';
    return row.repeat(n);
}

// ─── Transactions Search ─────────────────────────────────────────────────────
// Client-side filtering of the already-loaded rows: every filled-in control
// narrows the table on each keystroke. The same criteria are re-expressed as
// the export endpoint's `filters` body field, so Export saves exactly what
// the table shows.

function txParseAmountFilter(raw) {
    const v = parseFloat(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(v) ? v : null;
}

function txRowMatchesFilters(t) {
    const f = txState.filters;
    if (f.dateFrom && t.date < f.dateFrom) return false;
    if (f.dateTo   && t.date > f.dateTo)   return false;
    const name = f.name.trim().toLowerCase();
    if (name && !(t.description || '').toLowerCase().includes(name)) return false;
    const min = txParseAmountFilter(f.amountMin);
    const max = txParseAmountFilter(f.amountMax);
    if (min !== null && t.amount < min) return false;
    if (max !== null && t.amount > max) return false;
    if (f.type && t.tx_type !== f.type) return false;
    if (f.category === 'none') {
        if (t.category_id != null) return false;
    } else if (f.category) {
        if (t.category_id !== parseInt(f.category, 10)) return false;
    }
    return true;
}

function txVisibleRows() {
    return txState.rows.filter(txRowMatchesFilters);
}

// The active filters as the export endpoint's `filters` payload, or null
// when none are on (= export the whole ledger).
function txExportFilters() {
    const f = txState.filters;
    const out = {};
    if (f.dateFrom)     out.date_from = f.dateFrom;
    if (f.dateTo)       out.date_to   = f.dateTo;
    if (f.name.trim())  out.description = f.name.trim();
    const min = txParseAmountFilter(f.amountMin);
    const max = txParseAmountFilter(f.amountMax);
    if (min !== null)   out.amount_min = min;
    if (max !== null)   out.amount_max = max;
    if (f.type)         out.tx_type = f.type;
    if (f.category === 'none')  out.category_id = null;
    else if (f.category)        out.category_id = parseInt(f.category, 10);
    return Object.keys(out).length ? out : null;
}

// Field key in txState.filters → control id in the search bar.
const TX_SEARCH_FIELDS = {
    dateFrom:  'tx-search-date-from',
    dateTo:    'tx-search-date-to',
    name:      'tx-search-name',
    amountMin: 'tx-search-amount-min',
    amountMax: 'tx-search-amount-max',
    type:      'tx-search-type',
    category:  'tx-search-category',
};

function txSearchPopulateCategories() {
    const sel = document.getElementById('tx-search-category');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = ['<option value="">All</option>', '<option value="none">Uncategorized</option>']
        .concat(txState.categories.map(c => `<option value="${c.id}">${txEsc(c.name)}</option>`))
        .join('');
    sel.value = prev;
    if (sel.value !== prev) {   // selected category no longer exists
        sel.value = '';
        txState.filters.category = '';
    }
}

// Reset every search field and re-render. Shared by the search bar's Clear
// button and the "Clear filters" action in the filtered-empty state.
function txClearFilters() {
    for (const [key, id] of Object.entries(TX_SEARCH_FIELDS)) {
        const el = document.getElementById(id);
        if (el) el.value = '';
        txState.filters[key] = '';
    }
    txRender();
}

function txSearchInit() {
    for (const [key, id] of Object.entries(TX_SEARCH_FIELDS)) {
        const el = document.getElementById(id);
        el?.addEventListener('input', () => {
            txState.filters[key] = el.value;
            // A filter that hides the row being edited cancels the edit —
            // otherwise editingId points at a row that's no longer in the
            // DOM and "Add Transaction" stays blocked.
            if (txState.editingId !== null && txState.editingId !== 'new') {
                const t = txState.rows.find(r => r.id === txState.editingId);
                if (!t || !txRowMatchesFilters(t)) txState.editingId = null;
            }
            txRender();
        });
    }
    document.getElementById('tx-search-clear')?.addEventListener('click', txClearFilters);
}

// ─── Render orchestration ────────────────────────────────────────────────────

function txRender() {
    const tbody = document.getElementById('tx-tbody');
    if (!tbody) return;

    const out = [];

    // Synthetic "new" row pinned to the top while editingId === 'new'. Its
    // category defaults to the first available row's id; the user can pick
    // a different one or leave it blank (Uncategorized) before saving.
    if (txState.editingId === 'new') {
        const defaultCatId = txState.categories[0]?.id ?? null;
        out.push(txRenderEditRow({
            date:        txTodayIso(),
            description: '',
            category_id: defaultCatId,
            amount:      '',
            notes:       '',
        }, { isNew: true }));
    }

    const visible = txVisibleRows();
    if (visible.length === 0 && txState.editingId !== 'new') {
        out.push(txEmptyRow(txState.rows.length > 0));
    } else {
        for (const t of visible) {
            if (t.id === txState.editingId) {
                out.push(txRenderEditRow(t, { isNew: false }));
            } else {
                out.push(txRenderDisplayRow(t));
            }
        }
    }

    tbody.innerHTML = out.join('');
    txWireEditRow();
    txFocusFirstInput();
}

/**
 * Direction is owned by the category (Category.cat_type): when the edit
 * row has a category selected, the Type select mirrors it and locks; only
 * Uncategorized rows pick their own type. The backend enforces the same
 * rule, this just keeps the UI honest about it.
 */
function txWireEditRow() {
    const row = document.querySelector('tr.tx-new, tr.tx-editing');
    if (!row) return;
    const catSel  = row.querySelector('.tx-input-category');
    const typeSel = row.querySelector('.tx-input-type');
    if (!catSel || !typeSel) return;

    const syncType = () => {
        const catId = catSel.value === '' ? null : parseInt(catSel.value, 10);
        if (catId != null) {
            const type = txCategoryType(catId);
            if (type) typeSel.value = type;
            typeSel.disabled = true;
        } else {
            typeSel.disabled = false;
        }
    };
    catSel.addEventListener('change', syncType);
    syncType();
}

function txFocusFirstInput() {
    if (txState.editingId == null) return;
    const sel = txState.editingId === 'new'
        ? 'tr.tx-new .tx-input-description'
        : `tr.tx-editing[data-id="${txState.editingId}"] .tx-input-description`;
    const el = document.querySelector(sel);
    if (el) el.focus();
}

// ─── Edit-mode actions ───────────────────────────────────────────────────────

function txEnterEdit(id) {
    txState.editingId = id;
    txRender();
}

function txCancelEdit() {
    txState.editingId = null;
    txRender();
}

function txReadEditedRow() {
    const sel = txState.editingId === 'new' ? 'tr.tx-new' : 'tr.tx-editing';
    const row = document.querySelector(sel);
    if (!row) return null;
    const get = (field) => row.querySelector(`[data-field="${field}"]`)?.value;
    const rawAmount   = (get('amount') || '').toString().replace(/,/g, '').trim();
    const amount      = parseFloat(rawAmount);
    const categoryRaw = get('category_id');
    return {
        date:        get('date'),
        description: (get('description') || '').trim(),
        tx_type:     get('tx_type') || 'expense',
        category_id: categoryRaw === '' ? null : parseInt(categoryRaw, 10),
        amount:      Number.isFinite(amount) ? amount : NaN,
        notes:       (get('notes') || '').trim(),
    };
}

async function txSaveEdit() {
    const payload = txReadEditedRow();
    if (!payload) return;

    if (!payload.date)                    { alert('Date is required.');          return; }
    if (!Number.isFinite(payload.amount)) { alert('Amount must be a number.');   return; }

    try {
        let saved;
        if (txState.editingId === 'new') {
            saved = await txApiCreate(payload);
            txState.rows.unshift(saved);
        } else {
            saved = await txApiUpdate(txState.editingId, payload);
            const idx = txState.rows.findIndex(r => r.id === saved.id);
            if (idx !== -1) txState.rows[idx] = saved;
        }
        txState.editingId = null;
        txSortRows();
        txRender();

        // After saving a categorized transaction, look for similar uncategorized
        // ones and prompt the user to apply the same category to them.
        if (saved.category_id != null && saved.description) {
            txCheckSimilar(saved);
        }
    } catch (err) {
        alert('Save failed: ' + err.message);
    }
}

async function txDeleteRow(id) {
    const t = txState.rows.find(r => r.id === id);
    if (!t) return;
    const label = t.description ? `"${t.description}"` : `the transaction from ${txFmtDate(t.date)}`;
    if (!confirm(`Delete ${label}?\nThis cannot be undone.`)) return;
    try {
        await txApiDelete(id);
        txState.rows = txState.rows.filter(r => r.id !== id);
        if (txState.editingId === id) txState.editingId = null;
        txRender();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

function txSortRows() {
    // Newest date first; ties broken by id desc (proxy for insertion order).
    txState.rows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return b.id - a.id;
    });
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function txOnTableClick(e) {
    // CTAs rendered inside the empty state (Add transaction / Clear filters).
    const emptyBtn = e.target.closest('button[data-empty-action]');
    if (emptyBtn) {
        if (emptyBtn.dataset.emptyAction === 'tx-add')               txOnAddClick();
        else if (emptyBtn.dataset.emptyAction === 'tx-clear-filters') txClearFilters();
        return;
    }
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id;
    if (action === 'edit')   txEnterEdit(parseInt(id, 10));
    if (action === 'save')   txSaveEdit();
    if (action === 'cancel') txCancelEdit();
    if (action === 'delete') txDeleteRow(parseInt(id, 10));
}

function txOnTableKey(e) {
    if (txState.editingId == null) return;
    if (e.key === 'Enter')  { e.preventDefault(); txSaveEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); txCancelEdit(); }
}

function txOnAddClick() {
    if (txState.editingId !== null) return;   // finish current edit first
    txEnterEdit('new');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function txInit() {
    const tbodyEl = document.getElementById('tx-tbody');
    const cancelSkeleton = UI.skeletonGuard(() => {
        if (tbodyEl) tbodyEl.innerHTML = txSkeletonRows(8);
    });
    try {
        const data = await txApiList();
        txState.rows       = data.transactions || [];
        txState.categories = data.categories   || [];
        txSortRows();
    } catch (err) {
        console.error(err);
    }
    cancelSkeleton();
    txSearchPopulateCategories();
    txRender();

    const tbody = document.getElementById('tx-tbody');
    tbody?.addEventListener('click',   txOnTableClick);
    tbody?.addEventListener('keydown', txOnTableKey);
    document.querySelector('.tx-add-btn')?.addEventListener('click', txOnAddClick);
    txSearchInit();
    // Import/export handlers are owned by txfileimport.js / txexport.js so
    // this file doesn't have to know about file dialects, preview UIs, or
    // rules engines. Export lives in the search bar and saves the rows the
    // active filters leave visible.
    document.querySelector('.tx-import-btn')?.addEventListener('click', () => TxFileImport.run());
    document.querySelector('.tx-export-btn')?.addEventListener('click', () =>
        TxFileExport.run({ filters: txExportFilters(), count: txVisibleRows().length }));
}

document.addEventListener('DOMContentLoaded', txInit);

// Re-fetch and re-render after a successful file import.
window.addEventListener('transactions:reload', async () => {
    txState.editingId = null;
    try {
        const data = await txApiList();
        txState.rows       = data.transactions || [];
        txState.categories = data.categories   || [];
        txSortRows();
    } catch (err) {
        console.error(err);
    }
    txSearchPopulateCategories();
    txRender();
});

// ─── Categorize-similar feature ──────────────────────────────────────────────
// After saving a categorized transaction, silently check whether any other
// uncategorized rows share the same description. If so, show a modal letting
// the user apply the same category to all (or a subset) of them.

async function txCheckSimilar(saved) {
    try {
        const params = new URLSearchParams({
            description: saved.description,
            exclude_id:  saved.id,
        });
        const r = await apiFetch(`/api/transactions/similar?${params}`);
        if (!r.ok) return;
        const data = await r.json();
        if (data.transactions && data.transactions.length > 0) {
            txShowSimilarModal(saved, data.transactions);
        }
    } catch (_) {
        // Non-critical path — swallow silently.
    }
}

function txShowSimilarModal(saved, matches) {
    const catName = txCategoryName(saved.category_id) ?? 'the selected category';

    const rows = matches.map(t => {
        const isIncome = t.tx_type === 'income';
        const amtClass = isIncome ? 'tx-amount-income' : 'tx-amount-expense';
        const sign     = isIncome ? '+ ' : '− ';
        return `
            <tr>
                <td class="tx-similar-col-check">
                    <input type="checkbox" class="tx-similar-cb" data-id="${t.id}" checked>
                </td>
                <td class="tx-similar-col-date">${txEsc(txFmtDate(t.date))}</td>
                <td>${txEsc(t.description)}</td>
                <td class="tx-similar-col-amount ${amtClass}">${sign}${txFmtAmount(t.amount)}</td>
            </tr>
        `;
    }).join('');

    const html = `
        <div class="tx-similar-overlay" id="tx-similar-overlay">
            <div class="tx-similar-dialog">
                <div class="tx-similar-header">
                    <span class="tx-similar-title">Categorize similar transactions</span>
                    <button class="tx-import-close" id="tx-similar-close" aria-label="Close">&times;</button>
                </div>
                <div class="tx-similar-hint">
                    Applying <strong>${txEsc(catName)}</strong> to uncategorized transactions
                    matching <em>&ldquo;${txEsc(saved.description)}&rdquo;</em>
                </div>
                <div class="tx-similar-body">
                    <div class="tx-similar-table-wrap">
                        <table class="tx-similar-table">
                            <thead>
                                <tr>
                                    <th class="tx-similar-col-check">
                                        <input type="checkbox" id="tx-similar-check-all" checked title="Select all">
                                    </th>
                                    <th>Date</th>
                                    <th>Description</th>
                                    <th class="tx-similar-col-amount">Amount</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="tx-similar-footer">
                    <button class="tx-similar-skip" id="tx-similar-skip">Skip</button>
                    <button class="button-primary tx-similar-apply" id="tx-similar-apply">
                        Apply to ${matches.length} selected
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    const overlay  = document.getElementById('tx-similar-overlay');
    const applyBtn = document.getElementById('tx-similar-apply');
    const allCb    = document.getElementById('tx-similar-check-all');

    function getCheckedIds() {
        return [...overlay.querySelectorAll('.tx-similar-cb:checked')]
            .map(cb => parseInt(cb.dataset.id, 10));
    }

    function updateApplyBtn() {
        const n = getCheckedIds().length;
        applyBtn.textContent = `Apply to ${n} selected`;
        applyBtn.disabled    = n === 0;
    }

    function close() { overlay.remove(); }

    overlay.querySelectorAll('.tx-similar-cb').forEach(cb =>
        cb.addEventListener('change', updateApplyBtn)
    );

    allCb.addEventListener('change', () => {
        overlay.querySelectorAll('.tx-similar-cb').forEach(cb => {
            cb.checked = allCb.checked;
        });
        updateApplyBtn();
    });

    document.getElementById('tx-similar-close').addEventListener('click', close);
    document.getElementById('tx-similar-skip').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    applyBtn.addEventListener('click', async () => {
        const ids = getCheckedIds();
        if (!ids.length) return;
        applyBtn.disabled    = true;
        applyBtn.textContent = 'Applying…';
        try {
            const r = await apiFetch('/api/transactions/categorize-similar', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                // No tx_type — the backend derives it from the category.
                body:    JSON.stringify({
                    ids,
                    category_id: saved.category_id,
                }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'failed');
            close();
            window.dispatchEvent(new Event('transactions:reload'));
        } catch (err) {
            applyBtn.disabled    = false;
            updateApplyBtn();
            alert('Failed to apply: ' + err.message);
        }
    });
}
