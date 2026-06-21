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
//   txState.editingId    — 'new' while the inline add row is open, else null.
//                          (Existing rows are edited via the bulk-edit modal,
//                          not in place.)
//   txState.selectedIds  — Set of checked transaction ids; drives the header
//                          Edit/Delete buttons and the two action modals
//   txState.filters      — Transactions Search controls, raw input values;
//                          a blank value means that filter is off

const txState = {
    rows:        [],
    categories:  [],
    editingId:   null,
    selectedIds: new Set(),
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
// formatCurrency / formatDate are from currency.js, loaded globally. Amounts
// are shown as a magnitude (the row's income/expense colour carries direction),
// so we pass the absolute value — no negative styling here.
function txFmtAmount(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return formatCurrency(Math.abs(n));
}

function txFmtDate(iso) {
    return formatDate(iso);
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

    const selected = txState.selectedIds.has(t.id);
    return `
        <tr class="tx-row${selected ? ' tx-selected' : ''}" data-id="${t.id}">
            <td class="tx-col-select"><input type="checkbox" class="tx-checkbox tx-row-cb" data-id="${t.id}" ${selected ? 'checked' : ''} aria-label="Select transaction"></td>
            <td class="tx-col-date">${txEsc(txFmtDate(t.date))}</td>
            <td class="tx-col-description">${txEsc(t.description)}</td>
            <td class="tx-col-type"><span class="tx-type-pill ${typeClass}">${typeLabel}</span></td>
            <td class="tx-col-category">${catCell}</td>
            <td class="tx-col-amount ${amountClass}">${sign}${txFmtAmount(t.amount)}</td>
            <td class="tx-col-notes">${txEsc(t.notes)}</td>
        </tr>
    `;
}

// Category <option>/<optgroup> markup for an edit control, grouped by type and
// led by an "Uncategorized" sentinel (backend treats null category_id as
// Uncategorized). Shared by the inline add row and the bulk-edit modal.
function txCategoryOptions(selectedId) {
    const TYPE_ORDER = ['income', 'expense', 'savings', 'investing'];
    const TYPE_LABELS = { income: 'Income', expense: 'Expense', savings: 'Savings', investing: 'Investing' };
    const groups = {};
    TYPE_ORDER.forEach(k => { groups[k] = []; });
    txState.categories.forEach(c => { (groups[c.cat_type] || (groups[c.cat_type] = [])).push(c); });
    TYPE_ORDER.forEach(k => groups[k].sort((a, b) => a.position - b.position));
    return ['<option value="">Uncategorized</option>']
        .concat(TYPE_ORDER.flatMap(k => {
            if (!groups[k].length) return [];
            const opts = groups[k].map(c => {
                const sel = c.id === selectedId ? 'selected' : '';
                return `<option value="${c.id}" ${sel}>${txEsc(c.name)}</option>`;
            }).join('');
            return [`<optgroup label="${TYPE_LABELS[k]}">${opts}</optgroup>`];
        })).join('');
}

// The six editable field cells (date / description / type / category / amount /
// notes) for one transaction. Each input carries a data-field so txReadFields()
// can read it back. Used both as <td>s in the inline add row and (re-tagged by
// the caller's container) as cells in the bulk-edit modal.
function txEditFieldsCells(t) {
    const txType = t.tx_type || 'expense';
    return `
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
            <select class="tx-select tx-input-category" data-field="category_id">${txCategoryOptions(t.category_id)}</select>
        </td>
        <td class="tx-col-amount">
            <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-field="amount"
                   value="${t.amount != null ? t.amount : ''}" placeholder="0.00">
        </td>
        <td class="tx-col-notes">
            <input type="text" class="tx-input tx-input-notes" data-field="notes"
                   value="${txEsc(t.notes || '')}" placeholder="Optional">
        </td>
    `;
}

// The inline add row — the only inline editor left (existing rows edit via the
// modal). Save/Cancel live in the leading select cell now that the Actions
// column is gone.
function txRenderEditRow(t, { isNew }) {
    const rowId = isNew ? 'new' : t.id;
    return `
        <tr class="tx-row tx-new" data-id="${rowId}">
            <td class="tx-col-select tx-new-actions">
                <div class="tx-action-group">
                    <button class="tx-action-btn tx-action-save"   data-action="save"   data-id="${rowId}" title="Save">${TX_ICONS.check}</button>
                    <button class="tx-action-btn tx-action-cancel" data-action="cancel" data-id="${rowId}" title="Cancel">${TX_ICONS.cross}</button>
                </div>
            </td>
            ${txEditFieldsCells(t)}
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
        + '<td class="tx-col-select"></td>'
        + cell('75') + cell('90') + cell('50') + cell('60') + cell('50') + cell('40')
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
            // txRender() prunes the selection to the rows that remain visible,
            // so a filter change never leaves an off-screen row selected.
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

    // Selection only ever covers rows the user can see: drop any ids that the
    // current filters hide, so a bulk action never touches an off-screen row.
    const visibleIds = new Set(visible.map(t => t.id));
    for (const id of txState.selectedIds) {
        if (!visibleIds.has(id)) txState.selectedIds.delete(id);
    }

    if (visible.length === 0 && txState.editingId !== 'new') {
        out.push(txEmptyRow(txState.rows.length > 0));
    } else {
        for (const t of visible) out.push(txRenderDisplayRow(t));
    }

    tbody.innerHTML = out.join('');
    const newRow = document.querySelector('tr.tx-new');
    if (newRow) txWireDirectionLock(newRow);
    txFocusFirstInput();
    txUpdateSelectionUI();

    // Keep the sidebar's uncategorized-count pill live. Every mutation on this
    // page lands in txState.rows before re-rendering, so count from there
    // rather than re-fetching the count endpoint.
    window.setUncatBadge?.(txState.rows.filter(r => r.category_id == null).length);
}

/**
 * Direction is owned by the category (Category.cat_type): when an edit control
 * group has a category selected, its Type select mirrors it and locks; only
 * Uncategorized rows pick their own type. The backend enforces the same rule,
 * this just keeps the UI honest about it. `scope` is any element containing a
 * .tx-input-category + .tx-input-type pair (the inline row or a modal row).
 */
function txWireDirectionLock(scope) {
    const catSel  = scope.querySelector('.tx-input-category');
    const typeSel = scope.querySelector('.tx-input-type');
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
    if (txState.editingId !== 'new') return;
    document.querySelector('tr.tx-new .tx-input-description')?.focus();
}

// ─── Selection ───────────────────────────────────────────────────────────────
// Checkbox state lives in txState.selectedIds; the header Edit/Delete buttons
// and the select-all box are derived from it on every render.

function txUpdateSelectionUI() {
    const n = txState.selectedIds.size;
    const editBtn   = document.querySelector('.tx-edit-btn');
    const deleteBtn = document.querySelector('.tx-delete-btn');
    if (editBtn)   { editBtn.disabled   = n === 0; editBtn.querySelector('.tx-btn-label').textContent   = n ? `Edit (${n})` : 'Edit'; }
    if (deleteBtn) { deleteBtn.disabled = n === 0; deleteBtn.querySelector('.tx-btn-label').textContent = n ? `Delete (${n})` : 'Delete'; }

    const all = document.getElementById('tx-select-all');
    if (all) {
        const visible = txVisibleRows();
        all.checked       = visible.length > 0 && n === visible.length;
        all.indeterminate = n > 0 && n < visible.length;
    }
}

function txToggleSelect(id, on) {
    if (on) txState.selectedIds.add(id);
    else    txState.selectedIds.delete(id);
    document.querySelector(`tr.tx-row[data-id="${id}"]`)?.classList.toggle('tx-selected', on);
    txUpdateSelectionUI();
}

function txToggleSelectAll(on) {
    txState.selectedIds = on ? new Set(txVisibleRows().map(t => t.id)) : new Set();
    txRender();
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

// Read one edit-control group (the inline add row or a bulk-edit modal row)
// into an update/create payload. `scope` is any element containing the
// data-field inputs.
function txReadFields(scope) {
    if (!scope) return null;
    const get = (field) => scope.querySelector(`[data-field="${field}"]`)?.value;
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

// Save the inline add row (create only — existing rows save through the modal).
async function txSaveEdit() {
    const payload = txReadFields(document.querySelector('tr.tx-new'));
    if (!payload) return;

    if (!payload.date)                    { alert('Date is required.');          return; }
    if (!Number.isFinite(payload.amount)) { alert('Amount must be a number.');   return; }

    try {
        const saved = await txApiCreate(payload);
        txState.rows.unshift(saved);
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

// ─── Bulk actions (selected rows) ─────────────────────────────────────────────

// The transactions currently checked, in display order.
function txSelectedRows() {
    const sel = txState.selectedIds;
    return txState.rows.filter(r => sel.has(r.id));
}

// Warning modal → permanently delete every selected row. Mirrors the app-wide
// .confirm-overlay pattern (see tables.js confirmDelete). Deletes loop the
// single-row endpoint; failures stay selected so the user can retry.
function txConfirmBulkDelete() {
    const ids = txSelectedRows().map(t => t.id);
    if (!ids.length) return;
    const plural = ids.length === 1 ? '' : 's';

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p>Delete <strong>${ids.length}</strong> transaction${plural}?<br>
               This permanently removes ${ids.length === 1 ? 'it' : 'them'} and cannot be undone.</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-delete">Delete</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('.confirm-delete').addEventListener('click', async (e) => {
        e.target.disabled = true;
        const failed = [];
        for (const id of ids) {
            try {
                await txApiDelete(id);
                txState.rows = txState.rows.filter(r => r.id !== id);
            } catch (_) {
                failed.push(id);
            }
        }
        close();
        txState.selectedIds = new Set(failed);
        txRender();
        if (failed.length) alert(`${failed.length} transaction${failed.length === 1 ? '' : 's'} could not be deleted.`);
    });
}

// Editing modal → every selected row laid out with all fields editable and one
// Save-all button. Reuses the inline editor's field cells + direction lock;
// saves loop the single-row update endpoint (which owns the direction rule and
// match-rule learning), so a row that fails stays selected for a retry.
function txOpenBulkEditModal() {
    const txs = txSelectedRows();
    if (!txs.length) return;
    const plural = txs.length === 1 ? '' : 's';

    const bodyRows = txs.map(t => `
        <tr class="tx-edit-row" data-id="${t.id}">${txEditFieldsCells(t)}</tr>
    `).join('');

    const overlay = document.createElement('div');
    overlay.className = 'tx-edit-overlay';
    overlay.id = 'tx-edit-overlay';
    overlay.innerHTML = `
        <div class="tx-edit-dialog">
            <div class="tx-edit-header">
                <span class="tx-edit-title">Edit ${txs.length} transaction${plural}</span>
                <button class="tx-import-close" id="tx-edit-close" aria-label="Close">&times;</button>
            </div>
            <div class="tx-edit-body">
                <div class="tx-edit-table-wrap">
                    <table class="tx-edit-table">
                        <thead>
                            <tr>
                                <th class="tx-col-date">Date</th>
                                <th class="tx-col-description">Description</th>
                                <th class="tx-col-type">Type</th>
                                <th class="tx-col-category">Category</th>
                                <th class="tx-col-amount">Amount</th>
                                <th class="tx-col-notes">Notes</th>
                            </tr>
                        </thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>
            <div class="tx-edit-footer">
                <button class="tx-similar-skip" id="tx-edit-cancel">Cancel</button>
                <button class="button-primary" id="tx-edit-save">Save all changes</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    // Each row's Type select mirrors + locks to its category, same as the inline row.
    overlay.querySelectorAll('.tx-edit-row').forEach(row => txWireDirectionLock(row));

    const close = () => overlay.remove();
    const saveBtn = overlay.querySelector('#tx-edit-save');
    overlay.querySelector('#tx-edit-close').addEventListener('click', close);
    overlay.querySelector('#tx-edit-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    saveBtn.addEventListener('click', async () => {
        // Validate every row up front so a bad field doesn't leave a half-saved batch.
        const edits = [];
        for (const row of overlay.querySelectorAll('.tx-edit-row')) {
            const payload = txReadFields(row);
            if (!payload.date)                    { alert('Every transaction needs a date.');      return; }
            if (!Number.isFinite(payload.amount)) { alert('Every amount must be a number.');       return; }
            edits.push({ id: parseInt(row.dataset.id, 10), payload });
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        const failed = [];
        for (const { id, payload } of edits) {
            try {
                const saved = await txApiUpdate(id, payload);
                const idx = txState.rows.findIndex(r => r.id === saved.id);
                if (idx !== -1) txState.rows[idx] = saved;
            } catch (_) {
                failed.push(id);
            }
        }
        close();
        txState.selectedIds = new Set(failed);
        txSortRows();
        txRender();
        if (failed.length) alert(`${failed.length} transaction${failed.length === 1 ? '' : 's'} could not be saved.`);
    });
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
    if (action === 'save')   txSaveEdit();
    if (action === 'cancel') txCancelEdit();
}

// Delegated checkbox handling for the row checkboxes (re-rendered constantly,
// so we listen on the tbody rather than each box).
function txOnTableChange(e) {
    const cb = e.target.closest('.tx-row-cb');
    if (!cb) return;
    txToggleSelect(parseInt(cb.dataset.id, 10), cb.checked);
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

// Fetch the ledger + category vocabulary into txState and sort. A failure
// leaves the previous state intact (and logs) rather than blanking the table.
// Shared by the initial load and the post-import reload.
async function txLoad() {
    try {
        const data = await txApiList();
        txState.rows       = data.transactions || [];
        txState.categories = data.categories   || [];
        txSortRows();
    } catch (err) {
        console.error(err);
    }
}

async function txInit() {
    const tbodyEl = document.getElementById('tx-tbody');
    const cancelSkeleton = UI.skeletonGuard(() => {
        if (tbodyEl) tbodyEl.innerHTML = txSkeletonRows(8);
    });
    await txLoad();
    cancelSkeleton();
    txSearchPopulateCategories();
    txRender();

    const tbody = document.getElementById('tx-tbody');
    tbody?.addEventListener('click',   txOnTableClick);
    tbody?.addEventListener('keydown', txOnTableKey);
    tbody?.addEventListener('change',  txOnTableChange);
    document.querySelector('.tx-add-btn')?.addEventListener('click', txOnAddClick);

    // Selection-driven header actions + the select-all header checkbox.
    document.querySelector('.tx-edit-btn')?.addEventListener('click', txOpenBulkEditModal);
    document.querySelector('.tx-delete-btn')?.addEventListener('click', txConfirmBulkDelete);
    document.getElementById('tx-select-all')?.addEventListener('change', (e) => txToggleSelectAll(e.target.checked));
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
    txState.selectedIds.clear();
    await txLoad();
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
