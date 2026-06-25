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

// Rows per page. The ledger is loaded and filtered entirely client-side, so
// pagination just windows the filtered list — it never re-queries the backend.
const TX_PAGE_SIZE = 100;

const txState = {
    rows:        [],
    categories:  [],
    editingId:   null,
    selectedIds: new Set(),
    page:        1,   // 1-based; clamped to the visible-row count on every render
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

// ─── Pagination ──────────────────────────────────────────────────────────────
// Windows the filtered rows into pages of TX_PAGE_SIZE. Selection and export
// still operate on the full filtered set — only what the table draws is paged.

function txPageCount(visibleCount) {
    return Math.max(1, Math.ceil(visibleCount / TX_PAGE_SIZE));
}

// Keep txState.page within [1, pageCount] — bulk-deleting the tail of the list
// or tightening a filter can otherwise leave us pointing past the last page.
function txClampPage(visibleCount) {
    txState.page = Math.min(Math.max(1, txState.page), txPageCount(visibleCount));
}

// The slice of `visible` belonging to the current page.
function txPagedRows(visible) {
    const start = (txState.page - 1) * TX_PAGE_SIZE;
    return visible.slice(start, start + TX_PAGE_SIZE);
}

// Jump to a page and redraw, scrolling the table back into view so the user
// isn't left staring at the old scroll position after the rows swap out.
function txGoToPage(p) {
    if (!Number.isFinite(p)) return;
    txState.page = p;
    txRender();
    document.querySelector('.tx-wrapper')?.scrollIntoView({ block: 'nearest' });
}

// Page numbers to show: always first + last + a window around the current page,
// with '…' gaps standing in for the runs we skip.
function txPageNumbers(current, total) {
    const out = [];
    let last = 0;
    for (let p = 1; p <= total; p++) {
        if (p === 1 || p === total || (p >= current - 1 && p <= current + 1)) {
            if (last && p - last > 1) out.push('…');
            out.push(p);
            last = p;
        }
    }
    return out;
}

function txRenderPagination(totalVisible) {
    const el = document.getElementById('tx-pagination');
    if (!el) return;
    const row = document.getElementById('tx-footer-row');
    const pages = txPageCount(totalVisible);
    if (totalVisible === 0 || pages <= 1) {
        if (row) row.hidden = true;
        el.innerHTML = '';
        return;
    }
    if (row) row.hidden = false;
    const page  = txState.page;
    const start = (page - 1) * TX_PAGE_SIZE + 1;
    const end   = Math.min(page * TX_PAGE_SIZE, totalVisible);

    const nums = txPageNumbers(page, pages).map(p =>
        p === '…'
            ? '<span class="tx-page-gap" aria-hidden="true">…</span>'
            : `<button type="button" class="tx-page-num${p === page ? ' tx-page-current' : ''}" data-page="${p}"${p === page ? ' aria-current="page"' : ''}>${p}</button>`
    ).join('');

    el.innerHTML = `
        <span class="tx-page-info">Showing ${start}–${end} of ${totalVisible}</span>
        <div class="tx-page-controls">
            <button type="button" class="tx-page-btn tx-page-prev" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="Previous page">‹</button>
            ${nums}
            <button type="button" class="tx-page-btn tx-page-next" data-page="${page + 1}"${page >= pages ? ' disabled' : ''} aria-label="Next page">›</button>
        </div>
    `;
}

function txOnPaginationClick(e) {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    txGoToPage(parseInt(btn.dataset.page, 10));
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

// ─── Filter chips ────────────────────────────────────────────────────────────
// Each chip owns one search filter. Inactive chips show a dotted outline with
// just the field name; clicking one opens a popover of options, and once a value
// is set the chip fills with the primary accent and reads "Field : value" with a
// leading × to clear it. Every chip writes the same txState.filters object that
// powers txRowMatchesFilters / txExportFilters, so the table, Export and the
// Cash Flow deep-link pre-fill all stay in sync. The chip nodes are static in
// the page; only their active class + value text are mutated (txSyncChips), so
// an open popover and its focused input survive a live keystroke.

// Display labels for the field name and the Type values.
const TX_FILTER_LABELS = { date: 'Date', name: 'Name', amount: 'Amount', type: 'Type', category: 'Category' };
const TX_TYPE_LABELS   = { income: 'Income', expense: 'Expense', savings: 'Savings', investing: 'Investing' };

// Which txState.filters keys each chip owns (cleared together by its ×).
const TX_FILTER_FIELDS = {
    date:     ['dateFrom', 'dateTo'],
    name:     ['name'],
    amount:   ['amountMin', 'amountMax'],
    type:     ['type'],
    category: ['category'],
};

// Short date for the Date chip; a clean full-calendar-year range (what the Cash
// Flow deep-link sets) collapses to just the year.
function txFilterDateText() {
    const { dateFrom, dateTo } = txState.filters;
    if (!dateFrom && !dateTo) return null;
    if (dateFrom && dateTo) {
        const m = /^(\d{4})-01-01$/.exec(dateFrom);
        if (m && dateTo === `${m[1]}-12-31`) return m[1];
        return `${txFmtDate(dateFrom)} – ${txFmtDate(dateTo)}`;
    }
    return dateFrom ? `From ${txFmtDate(dateFrom)}` : `Until ${txFmtDate(dateTo)}`;
}

// Amount chip text: format each bound as currency when it parses, else echo the
// raw (still-being-typed) input so the chip never blanks mid-keystroke.
function txFilterAmountText() {
    const minRaw = String(txState.filters.amountMin).trim();
    const maxRaw = String(txState.filters.amountMax).trim();
    if (!minRaw && !maxRaw) return null;
    const fmt = (raw) => {
        const v = txParseAmountFilter(raw);
        return Number.isFinite(v) ? formatCurrency(Math.abs(v)) : raw;
    };
    if (minRaw && maxRaw) return `${fmt(minRaw)} – ${fmt(maxRaw)}`;
    return minRaw ? `≥ ${fmt(minRaw)}` : `≤ ${fmt(maxRaw)}`;
}

// The active-chip value text for a filter, or null when that filter is off.
function txFilterValueText(key) {
    const f = txState.filters;
    switch (key) {
        case 'date':   return txFilterDateText();
        case 'name':   return f.name.trim() || null;
        case 'amount': return txFilterAmountText();
        case 'type':   return f.type ? TX_TYPE_LABELS[f.type] : null;
        case 'category':
            if (f.category === '' || f.category == null) return null;
            if (f.category === 'none') return 'Uncategorized';
            return txCategoryName(parseInt(f.category, 10)) || 'Category';
        default: return null;
    }
}

// Reflect txState.filters onto the chips in place: toggle the active styling,
// fill the value text, and show/hide the Clear all button. Never rebuilds the
// chip nodes, so an open popover is untouched.
function txSyncChips() {
    let anyActive = false;
    document.querySelectorAll('.tx-filter-chip').forEach(chip => {
        const key  = chip.dataset.filter;
        const text = txFilterValueText(key);
        const on   = text != null;
        anyActive = anyActive || on;
        chip.classList.toggle('is-active', on);
        const valEl = chip.querySelector('.tx-filter-value');
        if (valEl) valEl.textContent = on ? text : '';
        chip.querySelector('.tx-filter-main')?.setAttribute('aria-label',
            on ? `${TX_FILTER_LABELS[key]}: ${text}, edit filter` : `Filter by ${TX_FILTER_LABELS[key]}`);
    });
    const clearAll = document.getElementById('tx-clear-all');
    if (clearAll) clearAll.hidden = !anyActive;
}

// Merge a filter change into state, snap to page 1, then refresh chips + table.
// txRender() also prunes the selection to the rows that remain visible, so a
// tightened filter never leaves an off-screen row selected.
function txSetFilter(patch) {
    Object.assign(txState.filters, patch);
    txState.page = 1;
    txSyncChips();
    txRender();
}

// Drop the category filter if it points at a category that no longer exists
// (after an import or a category delete). Called on every (re)load.
function txReconcileCategoryFilter() {
    const c = txState.filters.category;
    if (c === '' || c === 'none' || c == null) return;
    if (!txCategoryById(parseInt(c, 10))) txState.filters.category = '';
}

// Clear one chip's filter (its leading ×).
function txClearFilter(key) {
    txCloseFilterPopover();
    const patch = {};
    for (const field of TX_FILTER_FIELDS[key]) patch[field] = '';
    txSetFilter(patch);
}

// Reset every filter. Shared by the Clear all chip and the "Clear filters"
// action in the filtered-empty state.
function txClearFilters() {
    txCloseFilterPopover();
    for (const fields of Object.values(TX_FILTER_FIELDS)) {
        for (const field of fields) txState.filters[field] = '';
    }
    txState.page = 1;
    txSyncChips();
    txRender();
}

// ─── Filter popovers ─────────────────────────────────────────────────────────
// One popover open at a time, built on demand under the clicked chip and removed
// on close. Date/Name/Amount popovers carry live inputs; Type/Category popovers
// are single-select option lists that apply and close on pick.

// The currently-open popover, or null: { el, chip, key, onOutside, onKey }.
let txOpenPopover = null;

function txCloseFilterPopover() {
    if (!txOpenPopover) return;
    const { el, chip, onOutside, onKey } = txOpenPopover;
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey);
    chip.querySelector('.tx-filter-main')?.setAttribute('aria-expanded', 'false');
    el.remove();
    txOpenPopover = null;
}

// Live-filter as the user types in a Date/Name/Amount popover.
function txWirePopoverInputs(wrap) {
    wrap.querySelectorAll('[data-k]').forEach(input => {
        input.addEventListener('input', () => txSetFilter({ [input.dataset.k]: input.value }));
    });
}

// A single-select option list for the Type/Category popovers. Picking an option
// writes the filter and closes the popover; the current value is checked.
function txBuildOptionList(key, options, current) {
    const list = document.createElement('div');
    list.className = 'tx-pop-options';
    list.setAttribute('role', 'listbox');
    list.innerHTML = options.map(([value, label]) => {
        const sel = value === current;
        return `<button type="button" class="tx-pop-option${sel ? ' is-selected' : ''}" role="option" aria-selected="${sel}" data-value="${txEsc(value)}">
                    <span class="tx-pop-option-label">${txEsc(label)}</span>
                    <svg class="tx-pop-check" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>`;
    }).join('');
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('.tx-pop-option');
        if (!btn) return;
        txCloseFilterPopover();
        txSetFilter({ [key]: btn.dataset.value });
    });
    return list;
}

// Build the popover body for one filter. Category options are read live from the
// current vocabulary, so the list is always up to date without pre-populating.
function txBuildPopover(key) {
    const wrap = document.createElement('div');
    wrap.className = 'tx-filter-popover';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', `${TX_FILTER_LABELS[key]} filter`);
    const f = txState.filters;

    if (key === 'date') {
        wrap.innerHTML = `
            <label class="tx-pop-field">
                <span class="tx-pop-label">From</span>
                <input type="date" class="tx-input tx-input-date" data-k="dateFrom" value="${txEsc(f.dateFrom)}">
            </label>
            <label class="tx-pop-field">
                <span class="tx-pop-label">To</span>
                <input type="date" class="tx-input tx-input-date" data-k="dateTo" value="${txEsc(f.dateTo)}">
            </label>`;
        txWirePopoverInputs(wrap);
    } else if (key === 'name') {
        wrap.innerHTML = `
            <label class="tx-pop-field">
                <span class="tx-pop-label">Description contains</span>
                <input type="text" class="tx-input" data-k="name" value="${txEsc(f.name)}" placeholder="Search descriptions" spellcheck="false" autocomplete="off">
            </label>`;
        txWirePopoverInputs(wrap);
    } else if (key === 'amount') {
        wrap.innerHTML = `
            <div class="tx-pop-row">
                <label class="tx-pop-field">
                    <span class="tx-pop-label">Min</span>
                    <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-k="amountMin" value="${txEsc(f.amountMin)}" placeholder="0.00" autocomplete="off">
                </label>
                <label class="tx-pop-field">
                    <span class="tx-pop-label">Max</span>
                    <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-k="amountMax" value="${txEsc(f.amountMax)}" placeholder="0.00" autocomplete="off">
                </label>
            </div>`;
        txWirePopoverInputs(wrap);
    } else if (key === 'type') {
        wrap.appendChild(txBuildOptionList('type', [
            ['', 'All'], ['income', 'Income'], ['expense', 'Expense'], ['savings', 'Savings'], ['investing', 'Investing'],
        ], f.type || ''));
    } else if (key === 'category') {
        const opts = [['', 'All'], ['none', 'Uncategorized']]
            .concat(txState.categories.map(c => [String(c.id), c.name]));
        wrap.appendChild(txBuildOptionList('category', opts, f.category || ''));
    }
    return wrap;
}

// Open (or, if already open for this chip, toggle closed) a filter's popover.
function txOpenFilterPopover(key, chip) {
    if (txOpenPopover && txOpenPopover.key === key) { txCloseFilterPopover(); return; }
    txCloseFilterPopover();

    const main = chip.querySelector('.tx-filter-main');
    const el   = txBuildPopover(key);
    chip.appendChild(el);
    main?.setAttribute('aria-expanded', 'true');

    // Anything clicked outside this chip closes it; Escape closes and returns
    // focus to the chip. Registered now, so they fire only on the next event —
    // the opening click already passed the document capture phase.
    const onOutside = (e) => { if (!chip.contains(e.target)) txCloseFilterPopover(); };
    const onKey     = (e) => { if (e.key === 'Escape') { txCloseFilterPopover(); main?.focus(); } };
    txOpenPopover = { el, chip, key, onOutside, onKey };
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onKey);

    (el.querySelector('input') || el.querySelector('.tx-pop-option.is-selected') || el.querySelector('.tx-pop-option'))?.focus();
}

// Wire the chip row: the leading × clears its filter; the label opens/toggles
// its option popover. Delegated so the static chip nodes need no per-chip setup.
function txChipsInit() {
    const row = document.getElementById('tx-filter-chips');
    if (row) {
        row.addEventListener('click', (e) => {
            const clearBtn = e.target.closest('.tx-filter-clear');
            if (clearBtn) { txClearFilter(clearBtn.closest('.tx-filter-chip').dataset.filter); return; }
            const main = e.target.closest('.tx-filter-main');
            if (main) { txOpenFilterPopover(main.closest('.tx-filter-chip').dataset.filter, main.closest('.tx-filter-chip')); }
        });
    }
    document.getElementById('tx-clear-all')?.addEventListener('click', txClearFilters);
    txSyncChips();
}

// ─── Deep-link filters ───────────────────────────────────────────────────────
// The Cash Flow report links each category to
// /transactions?year=<year>&cat=<categoryKey>. On arrival with those params,
// pre-fill the filters — that year's Jan–Dec range plus the matching category —
// so the chips light up to reveal the active search. Must run after the category
// vocabulary and chips are in place (i.e. after txChipsInit).
function txApplyUrlFilters() {
    let params;
    try { params = new URLSearchParams(location.search); }
    catch { return; }
    const yearRaw = params.get('year');
    const catKey  = params.get('cat');
    if (yearRaw == null && catKey == null) return;

    const year = parseInt(yearRaw, 10);
    if (Number.isInteger(year) && year > 0) {
        txState.filters.dateFrom = `${year}-01-01`;
        txState.filters.dateTo   = `${year}-12-31`;
    }
    if (catKey) {
        // Match on the stable category key the link carries; map it to the id the
        // filter state holds. An unknown key just leaves the category filter off.
        const cat = txState.categories.find(c => c.key === catKey);
        if (cat) txState.filters.category = String(cat.id);
    }

    txState.page = 1;
    txSyncChips();
    txRender();

    // Consume the deep-link: keep the applied filters but strip the query string
    // so a manual refresh or bookmark doesn't silently re-prefill.
    try { history.replaceState(null, '', location.pathname); } catch { /* non-fatal */ }
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

    // Clamp first, then window: a filter change or bulk delete may have left
    // txState.page pointing past the now-shorter list.
    txClampPage(visible.length);

    if (visible.length === 0 && txState.editingId !== 'new') {
        out.push(txEmptyRow(txState.rows.length > 0));
    } else {
        for (const t of txPagedRows(visible)) out.push(txRenderDisplayRow(t));
    }

    tbody.innerHTML = out.join('');
    txRenderPagination(visible.length);
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
    // Icon-only chips: the live count rides in the accessible name + tooltip.
    if (editBtn) {
        editBtn.disabled = n === 0;
        const label = n ? `Edit (${n})` : 'Edit';
        editBtn.setAttribute('aria-label', label);
        editBtn.title = label;
    }
    if (deleteBtn) {
        deleteBtn.disabled = n === 0;
        const label = n ? `Delete (${n})` : 'Delete';
        deleteBtn.setAttribute('aria-label', label);
        deleteBtn.title = label;
    }

    // The header checkbox reflects the current page only — selection can span
    // pages, but "select all" the user sees acts on the rows in front of them.
    const all = document.getElementById('tx-select-all');
    if (all) {
        const paged = txPagedRows(txVisibleRows());
        const onPage = paged.filter(t => txState.selectedIds.has(t.id)).length;
        all.checked       = paged.length > 0 && onPage === paged.length;
        all.indeterminate = onPage > 0 && onPage < paged.length;
    }
}

function txToggleSelect(id, on) {
    if (on) txState.selectedIds.add(id);
    else    txState.selectedIds.delete(id);
    document.querySelector(`tr.tx-row[data-id="${id}"]`)?.classList.toggle('tx-selected', on);
    txUpdateSelectionUI();
}

function txToggleSelectAll(on) {
    // Acts on the current page only; selections on other pages are untouched.
    const paged = txPagedRows(txVisibleRows());
    for (const t of paged) {
        if (on) txState.selectedIds.add(t.id);
        else    txState.selectedIds.delete(t.id);
    }
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

    // Categories before this edit, so we can tell which rows were actually
    // (re)categorized and only run the detector for those.
    const prevCat = new Map(txs.map(t => [t.id, t.category_id]));

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
        const savedRows = [];
        for (const { id, payload } of edits) {
            try {
                const saved = await txApiUpdate(id, payload);
                savedRows.push(saved);
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

        // Same as the inline add row: once rows are categorized, offer to apply
        // each new category to other uncategorized transactions that match.
        await txRunSimilarDetector(savedRows, prevCat);
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
    // The new row sorts to the top after saving, so edit it from page 1.
    txState.page = 1;
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
    txReconcileCategoryFilter();
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
    document.getElementById('tx-pagination')?.addEventListener('click', txOnPaginationClick);
    txChipsInit();
    // Import/export handlers are owned by txfileimport.js / txexport.js so
    // this file doesn't have to know about file dialects, preview UIs, or
    // rules engines. Export sits beside Import in the page header and saves the
    // rows the active filters leave visible.
    document.querySelector('.tx-import-btn')?.addEventListener('click', () => TxFileImport.run());
    document.querySelector('.tx-export-btn')?.addEventListener('click', () =>
        TxFileExport.run({ filters: txExportFilters(), count: txVisibleRows().length }));

    // Apply any deep-link filters last, once the category vocabulary, popover
    // controls and live listeners are all in place (e.g. arriving from a Cash
    // Flow category click).
    txApplyUrlFilters();
}

document.addEventListener('DOMContentLoaded', txInit);

// Re-fetch and re-render after a successful file import.
window.addEventListener('transactions:reload', async () => {
    txState.editingId = null;
    txState.selectedIds.clear();
    txState.page = 1;
    await txLoad();
    txReconcileCategoryFilter();
    txSyncChips();
    txRender();
});

// ─── Categorize-similar feature ──────────────────────────────────────────────
// After categorizing transactions (the inline add row or a bulk edit), find
// other uncategorized rows whose description matches and offer, in one combined
// dialog grouped by category, to apply the same categories to them.

// Gather, for each category the user just applied, the still-uncategorized rows
// that match its description. Returns groups keyed by category; each matching
// row is claimed by the first category that hits it, so no row is ever offered
// for two categories at once. `queries` is a list of
// {description, category_id, exclude_id}.
async function txGatherSimilarGroups(queries) {
    const claimed = new Set();   // row ids already placed in a group
    const byCat   = new Map();   // category_id -> group
    const groups  = [];
    for (const q of queries) {
        let matches;
        try {
            const params = new URLSearchParams({
                description: q.description,
                exclude_id:  q.exclude_id,
            });
            const r = await apiFetch(`/api/transactions/similar?${params}`);
            if (!r.ok) continue;
            const data = await r.json();
            matches = data.transactions || [];
        } catch (_) {
            continue;   // non-critical path, skip this query
        }
        for (const m of matches) {
            if (claimed.has(m.id)) continue;
            claimed.add(m.id);
            let g = byCat.get(q.category_id);
            if (!g) {
                g = {
                    categoryId: q.category_id,
                    catName:    txCategoryName(q.category_id) ?? 'the selected category',
                    matches:    [],
                };
                byCat.set(q.category_id, g);
                groups.push(g);
            }
            g.matches.push(m);
        }
    }
    return groups;
}

// Inline add row: one saved row -> one category group.
async function txCheckSimilar(saved) {
    if (saved.category_id == null || !saved.description) return;
    const groups = await txGatherSimilarGroups([
        { description: saved.description, category_id: saved.category_id, exclude_id: saved.id },
    ]);
    if (groups.length) await txShowSimilarModal(groups);
}

// After a bulk edit, offer a single combined dialog: every row whose category
// actually changed contributes a query (deduped by description+category), and
// the matches are grouped by category in one prompt rather than a chain.
async function txRunSimilarDetector(savedRows, prevCat) {
    const seen = new Set();
    const queries = [];
    for (const t of savedRows) {
        if (t.category_id == null || !t.description) continue;
        if (prevCat.get(t.id) === t.category_id) continue;   // category unchanged
        const key = `${t.description.toLowerCase()} ${t.category_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queries.push({ description: t.description, category_id: t.category_id, exclude_id: t.id });
    }
    if (!queries.length) return;
    const groups = await txGatherSimilarGroups(queries);
    if (groups.length) await txShowSimilarModal(groups);
}

// One combined dialog listing the uncategorized matches grouped by the category
// that would be applied. Each group and the whole dialog have select-all
// affordances; Apply runs one categorize-similar call per category, then
// reloads. Returns a Promise that resolves when the dialog is dismissed.
function txShowSimilarModal(groups) {
  return new Promise(resolve => {
    const totalMatches = groups.reduce((n, g) => n + g.matches.length, 0);

    const rowHtml = (g) => g.matches.map(t => {
        const isIncome = t.tx_type === 'income';
        const amtClass = isIncome ? 'tx-amount-income' : 'tx-amount-expense';
        const sign     = isIncome ? '+ ' : '− ';
        return `
            <tr>
                <td class="tx-similar-col-check">
                    <input type="checkbox" class="tx-similar-cb" data-id="${t.id}" data-cat="${g.categoryId}" checked>
                </td>
                <td class="tx-similar-col-date">${txEsc(txFmtDate(t.date))}</td>
                <td>${txEsc(t.description)}</td>
                <td class="tx-similar-col-amount ${amtClass}">${sign}${txFmtAmount(t.amount)}</td>
            </tr>
        `;
    }).join('');

    const groupsHtml = groups.map(g => `
        <div class="tx-similar-group" data-cat="${g.categoryId}">
            <label class="tx-similar-group-head">
                <input type="checkbox" class="tx-similar-group-all" data-cat="${g.categoryId}" checked>
                <span class="tx-similar-group-name">${txEsc(g.catName)}</span>
                <span class="tx-similar-group-count">${g.matches.length}</span>
            </label>
            <div class="tx-similar-table-wrap">
                <table class="tx-similar-table"><tbody>${rowHtml(g)}</tbody></table>
            </div>
        </div>
    `).join('');

    const html = `
        <div class="tx-similar-overlay" id="tx-similar-overlay">
            <div class="tx-similar-dialog">
                <div class="tx-similar-header">
                    <span class="tx-similar-title">Categorize similar transactions</span>
                    <button class="tx-import-close" id="tx-similar-close" aria-label="Close">&times;</button>
                </div>
                <div class="tx-similar-hint">
                    Found <strong>${totalMatches}</strong> uncategorized transaction${totalMatches === 1 ? '' : 's'}
                    matching what you just categorized. Apply the categories below?
                </div>
                <div class="tx-similar-body">${groupsHtml}</div>
                <div class="tx-similar-footer">
                    <button class="tx-similar-skip" id="tx-similar-skip">Skip</button>
                    <button class="button-primary tx-similar-apply" id="tx-similar-apply">
                        Apply to ${totalMatches} selected
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    const overlay  = document.getElementById('tx-similar-overlay');
    const applyBtn = document.getElementById('tx-similar-apply');

    const checkedCount = () => overlay.querySelectorAll('.tx-similar-cb:checked').length;

    function updateApplyBtn() {
        const n = checkedCount();
        applyBtn.textContent = `Apply to ${n} selected`;
        applyBtn.disabled    = n === 0;
    }

    // A group's header checkbox mirrors its rows: toggling it sets them all,
    // toggling a row leaves the header checked while any of its rows are.
    function syncGroupAll(cat) {
        const all = overlay.querySelector(`.tx-similar-group-all[data-cat="${cat}"]`);
        const cbs = overlay.querySelectorAll(`.tx-similar-cb[data-cat="${cat}"]`);
        if (all) all.checked = [...cbs].some(cb => cb.checked);
    }

    overlay.querySelectorAll('.tx-similar-cb').forEach(cb =>
        cb.addEventListener('change', () => { syncGroupAll(cb.dataset.cat); updateApplyBtn(); })
    );
    overlay.querySelectorAll('.tx-similar-group-all').forEach(all =>
        all.addEventListener('change', () => {
            overlay.querySelectorAll(`.tx-similar-cb[data-cat="${all.dataset.cat}"]`)
                .forEach(cb => { cb.checked = all.checked; });
            updateApplyBtn();
        })
    );

    function close() { overlay.remove(); resolve(); }
    document.getElementById('tx-similar-close').addEventListener('click', close);
    document.getElementById('tx-similar-skip').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    applyBtn.addEventListener('click', async () => {
        // Collect checked ids per category, one categorize-similar call each.
        const byCat = new Map();
        for (const cb of overlay.querySelectorAll('.tx-similar-cb:checked')) {
            const cat = parseInt(cb.dataset.cat, 10);
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(parseInt(cb.dataset.id, 10));
        }
        if (!byCat.size) return;
        applyBtn.disabled    = true;
        applyBtn.textContent = 'Applying…';
        try {
            for (const [categoryId, ids] of byCat) {
                const r = await apiFetch('/api/transactions/categorize-similar', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // No tx_type, the backend derives it from the category.
                    body:    JSON.stringify({ ids, category_id: categoryId }),
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || 'failed');
            }
            close();
            window.dispatchEvent(new Event('transactions:reload'));
        } catch (err) {
            applyBtn.disabled = false;
            updateApplyBtn();
            alert('Failed to apply: ' + err.message);
        }
    });
  });
}
