'use strict';

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
//                          (Existing rows are edited via the edit modal, not
//                          in place.)
//   txState.selectedIds  — Set of checked transaction ids; drives the header
//                          Edit/Delete buttons and the two action modals, and
//                          selects the edit modal's form: one row is edited
//                          field by field, two or more become a single
//                          en-masse update applied to all of them
//   txState.revealedIds  — ids whose original (raw bank) description is
//                          expanded under the clean display name
//   txState.filters      — Transactions Search controls, raw input values; a
//                          blank value (or, for the Type/Category/Account
//                          multi-selects, an empty array) means that filter
//                          is off

(function () {
    // Rows per page. The ledger is loaded and filtered entirely client-side, so
    // pagination just windows the filtered list — it never re-queries the backend.
    const TX_PAGE_SIZE = 100;

    // Columns sized to their rendered content (see txSyncColumnWidths).
    // account/notes are also clamped — account names run up to 50 chars and
    // notes are unbounded, both longer than a ledger row should show.
    const TX_FIT_COLS = ['date', 'account', 'category', 'amount', 'notes'];
    const TX_FIT_MAX  = { account: 220, notes: 240 };

    const txState = {
        rows:        [],
        categories:  [],
        accountsByKey: {},   // balance_columns key -> label, for the Account column
        editingId:   null,
        selectedIds: new Set(),
        revealedIds: new Set(),
        page:        1,   // 1-based; clamped to the visible-row count on every render
        // Ordered the same as the filter chips render. Type no longer has a
        // column (it is merged into the Category pill's colour) but remains a
        // filter, since narrowing by direction is still useful.
        // Type/Category/Account are multi-select: an ARRAY of picked values that
        // matches as OR (empty = filter off, i.e. "All"). The other fields are
        // scalars, where a blank string means off.
        filters: {
            dateFrom:  '',
            dateTo:    '',
            name:      '',
            type:      [],   // [] all | 'income' | 'expense' | 'transfer'
            category:  [],   // [] all | 'none' uncategorized | category id
            account:   [],   // [] all | 'none' unassigned | account_key
            amountMin: '',
            amountMax: '',
        },
    };

    // ─── HTML safety ─────────────────────────────────────────────────────────────
    // User-controlled strings (description, notes, category name) all pass
    // through this before being placed in innerHTML. Alias of the shared global
    // in escape.js (loaded by pages/partials/scripts.html).
    const txEsc = escapeHtml;

    // ─── Formatters ──────────────────────────────────────────────────────────────
    // formatCurrency / formatDate are from currency.js, loaded globally. Amounts
    // are shown as a magnitude (the row's income/expense colour carries direction),
    // so we pass the absolute value — no negative styling here.
    function txFmtAmount(n) {
        if (n === null || n === undefined || Number.isNaN(n)) return '—';
        return formatCurrency(Math.abs(n));
    }

    // The Amount *input's* value: cents always shown, no symbol and no
    // separators, so it reads like a ledger figure and still parses back
    // through txReadFields unchanged. txFmtAmount is for display cells only —
    // its currency symbol would come back as NaN on save.
    function txAmountValue(n) {
        if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
        return Number(n).toFixed(2);
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

    // Every transaction write changes the computed Cash Flow cells that Dashboard
    // renders from the shared Store cache (store.js), so drop the 'ie' dataset
    // after each one — the next dashboard visit refetches instead of showing a
    // stale sessionStorage snapshot. Same pattern as tables.js makeYearTableApi.
    function txInvalidateDerived() {
        if (window.Store) window.Store.invalidate('ie');
    }

    async function txApiList() {
        const r = await apiFetch('/api/transactions');
        if (!r.ok) throw new Error('failed to list transactions');
        return r.json();
    }

    // The accounts a transaction can belong to are the Balance Sheet columns
    // (accounts and Balance Sheet columns are one list — see the account_key
    // schema). Fetched alongside the ledger to resolve each row's account_key to
    // a name for the Account column. On failure the column is left blank.
    async function txApiBalanceColumns() {
        try {
            const r = await apiFetch('/api/balance/columns');
            if (!r.ok) return [];
            return await r.json().catch(() => []);
        } catch {
            return [];
        }
    }

    async function txApiCreate(payload) {
        const r = await apiFetch('/api/transactions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'failed to create');
        txInvalidateDerived();
        return data.transaction;
    }

    async function txApiUpdate(id, payload) {
        const r = await apiFetch(`/api/transactions/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'failed to update');
        txInvalidateDerived();
        return data.transaction;
    }

    async function txApiDelete(id) {
        const r = await apiFetch(`/api/transactions/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('failed to delete');
        txInvalidateDerived();
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

    // The account (Balance Sheet column) label a row belongs to, or null when the
    // row is unassigned or its account was since deleted.
    function txAccountName(key) {
        if (!key) return null;
        return txState.accountsByKey[key] ?? null;
    }

    // ─── Row rendering ───────────────────────────────────────────────────────────

    // How a direction paints a row: income green, expense red, transfer blue —
    // the same three colours on the Category pill and on the amount, so the two
    // always match. Module scope because the edit modal's review step draws rows
    // the same way, and a second copy could diverge.
    const TX_TYPE_META = {
        income:   { catCls: 'tx-category-income',   amtCls: 'tx-amount-income',   sign: '+ ' },
        expense:  { catCls: 'tx-category-expense',  amtCls: 'tx-amount-expense',  sign: '- ' },
        transfer: { catCls: 'tx-category-transfer', amtCls: 'tx-amount-transfer', sign: '- ' },
    };

    // The direction a row carries: its category's when it has one (the direction
    // rule — cat_type sets tx_type), else its own tx_type.
    function txEffectiveType(t) {
        if (t.category_id == null) return t.tx_type;
        return txCategoryById(t.category_id)?.cat_type || t.tx_type;
    }

    // A transaction as it will be once a PARTIAL update payload is applied — the
    // payload's keys over the row's existing values, plus the two derivations the
    // backend performs on save: a user-set description clears the curated display
    // name (the clean-display-name rule), and Category re-derives direction. One
    // copy, so the edit modal's live preview and its review table always show the
    // same result.
    function txApplyPayload(t, payload) {
        const next = { ...t, ...payload };
        if ('description' in payload) next.display_name = null;
        next.tx_type = txEffectiveType(next);
        return next;
    }

    function txRenderDisplayRow(t) {
        // The Type column is merged into Category: a categorized row's pill is
        // tinted by its category's direction — see TX_TYPE_META — so the colour
        // carries the direction the Type pill used to show as text. An
        // uncategorized row is always amber ("needs review"), regardless of its
        // stored tx_type.
        const catName = txCategoryName(t.category_id);
        const meta        = TX_TYPE_META[t.tx_type] || TX_TYPE_META.expense;
        const amountClass = meta.amtCls;
        const sign        = meta.sign;
        const catCell = catName
            ? `<span class="tx-category-pill ${meta.catCls}">${txEsc(catName)}</span>`
            : `<span class="tx-category-pill tx-category-empty">Uncategorized</span>`;

        // Same resolved label the description cell shows (clean display_name when
        // the lexicon recognized the merchant, else the raw description) — the
        // avatar's initials/colour always match what's printed right next to them.
        const merchantLabel = t.display_name || t.description || '';

        // Imported rows the merchant lexicon recognizes carry a canonical
        // display_name with the raw bank string one click away; manual entries
        // and unrecognized imports have none and render the description
        // directly, with no affordance.
        // Description is a percentage-width column that narrows with the window
        // (transactions.css §2), so both branches below need to truncate with an
        // ellipsis rather than wrap or overflow — a title attribute keeps the
        // full text one hover away either way.
        let descCell = `<span class="tx-desc-plain" title="${txEsc(t.description || '')}">${txEsc(t.description)}</span>`;
        if (t.display_name) {
            const revealed = txState.revealedIds.has(t.id);
            descCell = `
            <button type="button" class="tx-desc-toggle" data-tx-desc="${t.id}"
                    aria-expanded="${revealed}" title="${revealed ? 'Hide' : 'Show'} original description">
                <span class="tx-desc-name" title="${txEsc(t.display_name)}">${txEsc(t.display_name)}</span>
                <svg class="tx-desc-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 8.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>${revealed ? `
            <div class="tx-desc-original">${txEsc(t.description)}</div>` : ''}`;
        }

        const acctName = txAccountName(t.account_key);
        const acctCell = acctName
            ? `<span class="tx-account-tag">${txEsc(acctName)}</span>`
            : `<span class="tx-account-tag tx-account-empty">—</span>`;

        const selected = txState.selectedIds.has(t.id);
        return `
        <tr class="tx-row${selected ? ' tx-selected' : ''}" data-id="${t.id}">
            <td class="tx-col-select"><input type="checkbox" class="tx-checkbox tx-row-cb" data-id="${t.id}" ${selected ? 'checked' : ''} aria-label="Select transaction"></td>
            <td class="tx-col-date">${txEsc(txFmtDate(t.date))}</td>
            <td class="tx-col-avatar">${merchantAvatarHtml(merchantLabel)}</td>
            <td class="tx-col-description">${descCell}</td>
            <td class="tx-col-account">${acctCell}</td>
            <td class="tx-col-category">${catCell}</td>
            <td class="tx-col-amount ${amountClass}">${sign}${txFmtAmount(t.amount)}</td>
            <td class="tx-col-notes" title="${txEsc(t.notes || '')}">${txEsc(t.notes)}</td>
        </tr>
    `;
    }

    // Category <option>/<optgroup> markup for an edit control, grouped by type and
    // led by an "Uncategorized" sentinel (backend treats null category_id as
    // Uncategorized). Shared by the inline add row and the edit modal.
    function txCategoryOptions(selectedId) {
        const TYPE_ORDER = ['income', 'expense', 'transfer'];
        const TYPE_LABELS = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
        const groups = {};
        TYPE_ORDER.forEach(k => { groups[k] = []; });
        txState.categories.forEach(c => {
            // The locked uncat_* system buckets aren't assignable — the blank
            // sentinel above is Uncategorized. Kept only if a legacy row
            // already points at one, so its current value still shows.
            if (c.locked && c.id !== selectedId) return;
            (groups[c.cat_type] || (groups[c.cat_type] = [])).push(c);
        });
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

    // <option> markup for the Account edit control: a "No account" sentinel
    // (the backend treats a null account_key as unassigned) followed by every
    // Balance Sheet account, in column order. Mirrors txCategoryOptions. An
    // account_key that names no current account (its column was deleted) simply
    // isn't in the list and falls back to "No account" — the same way a deleted
    // category falls back to Uncategorized.
    function txAccountOptions(selectedKey) {
        const opts = ['<option value="">No account</option>'];
        for (const [key, label] of Object.entries(txState.accountsByKey)) {
            const sel = key === selectedKey ? 'selected' : '';
            opts.push(`<option value="${txEsc(key)}" ${sel}>${txEsc(label)}</option>`);
        }
        return opts.join('');
    }

    // The editable field cells (date / description / account / category /
    // amount / notes) for one transaction, as <td>s for the inline add row.
    // Each input carries a data-field so txReadFields() can read it back.
    //
    // No Type <select>: the main ledger merged Type into the Category column, and
    // this row lives in that table and must stay column-aligned — a new row's
    // direction follows the category it's given. The edit modal drops it for the
    // same reason, so direction is now stated in exactly one place app-wide: a
    // row left uncategorized keeps whichever direction it arrived with.
    function txEditFieldsCells(t) {
        // Account sits between Description and Category, matching the ledger's
        // column order; both the inline add row and the edit modal carry it, so a
        // transaction's account can be set on creation and changed on edit.
        return `
        <td class="tx-col-date">
            <input type="date" class="tx-input tx-input-date" data-field="date"
                   value="${txEsc(t.date || '')}">
        </td>
        <td class="tx-col-description">
            <input type="text" class="tx-input tx-input-description" data-field="description"
                   value="${txEsc(t.description || '')}" placeholder="Description">
        </td>
        <td class="tx-col-account">
            <select class="tx-select tx-input-account" data-field="account_key">${txAccountOptions(t.account_key)}</select>
        </td>
        <td class="tx-col-category">
            <select class="tx-select tx-input-category" data-field="category_id">${txCategoryOptions(t.category_id)}</select>
        </td>
        <td class="tx-col-amount">
            <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-field="amount"
                   value="${txAmountValue(t.amount)}" placeholder="0.00">
        </td>
        <td class="tx-col-notes">
            <input type="text" class="tx-input tx-input-notes" data-field="notes"
                   value="${txEsc(t.notes || '')}" placeholder="Optional">
        </td>
    `;
    }

    // ─── En-masse edit controls ──────────────────────────────────────────────────
    // Selecting two or more rows turns the edit modal into a single "apply to
    // all" control row over a read-only list of the rows it will rewrite. Every
    // control starts on a "Keep" sentinel: a field is added to the batch only
    // once it is set, so an untouched column leaves each row's existing value
    // unchanged. Blank is not a value here — clearing a text field returns it to
    // Keep. The label is one word so it fits the narrowest column (Type) without
    // truncating, and it is the only indicator of what an untouched column does;
    // the paragraph that used to state that above the row is gone, along with the
    // rest of the modal's prose. The sentinel in every control, the accent border
    // on the ones that are set, and the rows below redrawing with those values
    // show the same thing live.
    const TX_KEEP = '__keep__';
    const TX_KEEP_LABEL = 'Keep';

    // The six edit columns — the same set the ledger uses — shared by the control
    // row and the preview list, so a struck-through preview cell always sits
    // under the control that replaces it. table-layout is fixed
    // (transactions.css §11), and these widths keep the two tables aligned.
    //
    // No Type column: the direction rule gives a categorized row its direction
    // from its category, so the control was locked almost always, repeating what
    // the Category select beside it already showed. This matches the ledger's
    // arrangement (Type merged into the Category column) and the inline add
    // row's. A payload without tx_type leaves an uncategorized row's direction
    // unchanged, and a categorized one takes its category's.
    const TX_BULK_COLGROUP = `
        <colgroup>
            <col style="width:15%"><col style="width:25%"><col style="width:16%">
            <col style="width:18%"><col style="width:11%"><col style="width:15%">
        </colgroup>`;

    const TX_EDIT_HEAD_CELLS = `
        <th class="tx-col-date">Date</th>
        <th class="tx-col-description">Description</th>
        <th class="tx-col-account">Account</th>
        <th class="tx-col-category">Category</th>
        <th class="tx-col-amount">Amount</th>
        <th class="tx-col-notes">Notes</th>`;

    // The control row's cells. Same data-field names as txEditFieldsCells, so
    // txReadBulkFields reads them the same way — only the sentinels differ.
    function txBulkFieldsCells() {
        const keep = `<option value="${TX_KEEP}" selected>${TX_KEEP_LABEL}</option>`;
        return `
        <td class="tx-col-date">
            <input type="date" class="tx-input tx-input-date" data-field="date"
                   aria-label="Set the date on every selected transaction">
        </td>
        <td class="tx-col-description">
            <input type="text" class="tx-input tx-input-description" data-field="description"
                   placeholder="${TX_KEEP_LABEL}" aria-label="Set the description on every selected transaction">
        </td>
        <td class="tx-col-account">
            <select class="tx-select tx-input-account" data-field="account_key"
                    aria-label="Set the account on every selected transaction">${keep}${txAccountOptions(undefined)}</select>
        </td>
        <td class="tx-col-category">
            <select class="tx-select tx-input-category" data-field="category_id"
                    aria-label="Set the category on every selected transaction">${keep}${txCategoryOptions(undefined)}</select>
        </td>
        <td class="tx-col-amount">
            <input type="text" inputmode="decimal" class="tx-input tx-input-amount" data-field="amount"
                   placeholder="${TX_KEEP_LABEL}" aria-label="Set the amount on every selected transaction">
        </td>
        <td class="tx-col-notes">
            <input type="text" class="tx-input tx-input-notes" data-field="notes"
                   placeholder="${TX_KEEP_LABEL}" aria-label="Set the notes on every selected transaction">
        </td>
    `;
    }

    // Read the control row into a *partial* update payload — only the fields that
    // were set. PUT /api/transactions/<id> applies exactly the keys it is given
    // (applyTxFields with requireAll:false), so an absent key leaves that column
    // unchanged on every row; a present category_id is also what makes the backend
    // record or update the match rule for those descriptions.
    function txReadBulkFields(scope) {
        const out = {};
        if (!scope) return out;
        const get = (field) => scope.querySelector(`[data-field="${field}"]`)?.value;

        const date = (get('date') || '').trim();
        if (date) out.date = date;

        const description = (get('description') || '').trim();
        if (description) out.description = description;

        const category = get('category_id');
        if (category != null && category !== TX_KEEP) {
            out.category_id = category === '' ? null : parseInt(category, 10);
        }

        const account = get('account_key');
        if (account != null && account !== TX_KEEP) {
            out.account_key = account === '' ? null : account;
        }

        // No tx_type: the control row has no Type column, so direction comes from
        // the category, or from the row's own tx_type when left uncategorized.
        const amount = (get('amount') || '').toString().replace(/,/g, '').trim();
        if (amount) out.amount = parseFloat(amount);

        const notes = (get('notes') || '').trim();
        if (notes) out.notes = notes;

        return out;
    }

    // The six preview columns in the ledger's order: the cell's class, and the
    // ONE renderer that draws a value into it. Shared by the first render and by
    // syncBulkPreview's live swap — the swap redraws a claimed cell as the value
    // it is BECOMING, so a second copy of this would let the new value be
    // formatted differently from the old one it stands in for.
    const TX_BULK_COLS = [
        { col: 'date', cls: 'tx-col-date',
          html: (t) => txEsc(txFmtDate(t.date)) },
        { col: 'description', cls: 'tx-col-description',
          html:  (t) => txEsc(t.display_name || t.description || ''),
          title: (t) => t.description || '' },
        { col: 'account_key', cls: 'tx-col-account',
          html: (t) => {
              const name = txAccountName(t.account_key);
              return name ? txEsc(name) : '<span class="tx-bulk-none">No account</span>';
          } },
        { col: 'category_id', cls: 'tx-col-category',
          html: (t) => {
              const name = txCategoryName(t.category_id);
              return name
                  ? `<span class="tx-category-pill">${txEsc(name)}</span>`
                  : '<span class="tx-category-pill tx-category-empty">Uncategorized</span>';
          } },
        { col: 'amount', cls: 'tx-col-amount',
          html: (t) => txFmtAmount(t.amount) },
        { col: 'notes', cls: 'tx-col-notes',
          html:  (t) => t.notes ? txEsc(t.notes) : '<span class="tx-bulk-none">—</span>',
          title: (t) => t.notes || '' },
    ];

    // ─── Review-step rows ────────────────────────────────────────────────────
    // Step 3 shows every affected transaction as the ledger will show it once
    // saved, so it uses the ledger's columns and colours: the merchant avatar,
    // the direction-tinted Category pill, the signed and coloured amount. NOT the
    // step-1 preview's rendering — that table shows what is about to change and
    // marks the changed cells in the accent colour; this screen shows the result,
    // where an accent would highlight decisions already made.
    //
    // The ledger's interactive parts are dropped: no select checkbox, and the
    // description renders flat rather than as the show-original toggle (nothing
    // on this screen is clickable, and the raw string is in the title
    // attribute).
    const TX_REVIEW_COLGROUP = `
        <colgroup>
            <col style="width:13%"><col style="width:44px"><col style="width:24%">
            <col style="width:15%"><col style="width:17%"><col style="width:11%"><col style="width:13%">
        </colgroup>`;

    const TX_REVIEW_HEAD_CELLS = `
        <th class="tx-col-date">Date</th>
        <th class="tx-col-avatar"></th>
        <th class="tx-col-description">Description</th>
        <th class="tx-col-account">Account</th>
        <th class="tx-col-category">Category</th>
        <th class="tx-col-amount">Amount</th>
        <th class="tx-col-notes">Notes</th>`;

    function txReviewRow(t) {
        const meta    = TX_TYPE_META[t.tx_type] || TX_TYPE_META.expense;
        const catName = txCategoryName(t.category_id);
        const catCell = catName
            ? `<span class="tx-category-pill ${meta.catCls}">${txEsc(catName)}</span>`
            : '<span class="tx-category-pill tx-category-empty">Uncategorized</span>';
        const acctName = txAccountName(t.account_key);
        const acctCell = acctName
            ? `<span class="tx-account-tag">${txEsc(acctName)}</span>`
            : '<span class="tx-account-tag tx-account-empty">—</span>';
        const label = t.display_name || t.description || '';
        return `
        <tr>
            <td class="tx-col-date">${txEsc(txFmtDate(t.date))}</td>
            <td class="tx-col-avatar">${merchantAvatarHtml(label)}</td>
            <td class="tx-col-description" title="${txEsc(t.description || '')}">${txEsc(label)}</td>
            <td class="tx-col-account">${acctCell}</td>
            <td class="tx-col-category">${catCell}</td>
            <td class="tx-col-amount ${meta.amtCls}">${meta.sign}${txFmtAmount(t.amount)}</td>
            <td class="tx-col-notes" title="${txEsc(t.notes || '')}">${txEsc(t.notes)}</td>
        </tr>`;
    }

    // One read-only line under the control row: the transaction as it stands
    // today and, once a control is set, as it will stand after saving —
    // syncBulkPreview swaps the claimed cells to their new values in place.
    // Each cell names the field it holds so the swap can find it again.
    function txBulkPreviewRow(t) {
        const cells = TX_BULK_COLS.map((c) => {
            const title = c.title ? ` title="${txEsc(c.title(t))}"` : '';
            return `<td class="${c.cls}" data-col="${c.col}"${title}>${c.html(t)}</td>`;
        }).join('');
        return `<tr class="tx-bulk-row" data-id="${t.id}">${cells}</tr>`;
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
            <td class="tx-col-avatar"></td>
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
                desc: 'Import a statement from your bank, or add a transaction by hand to get started.',
                action: { label: 'Import transactions', name: 'tx-import', icon: 'import', primary: true },
            });
        return `<tr class="tx-empty-row"><td colspan="8">${inner}</td></tr>`;
    }

    // Skeleton placeholder rows shown while the ledger loads (cold fetch only).
    // Reuses .tx-row so each placeholder is exactly one real row tall.
    function txSkeletonRows(n) {
        const cell = (w) => `<td><div class="skeleton skeleton-line sk-w-${w}"></div></td>`;
        const row = '<tr class="tx-row tx-skeleton-row">'
            + '<td class="tx-col-select"></td>'
            + '<td class="tx-col-avatar"><div class="skeleton skeleton-circle"></div></td>'
            + cell('75') + cell('90') + cell('60') + cell('50') + cell('50') + cell('40')
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
        if (name
            && !(t.description  || '').toLowerCase().includes(name)
            && !(t.display_name || '').toLowerCase().includes(name)) return false;
        // The three multi-selects match as OR within a field (and AND across
        // fields, like every other filter): a row passes if its value is one of
        // the picked ones. An empty pick list is the filter being off.
        if (f.type.length && !f.type.includes(t.tx_type)) return false;
        if (f.category.length) {
            const picked = t.category_id == null ? 'none' : String(t.category_id);
            if (!f.category.includes(picked)) return false;
        }
        if (f.account.length) {
            const picked = t.account_key == null ? 'none' : t.account_key;
            if (!f.account.includes(picked)) return false;
        }
        const min = txParseAmountFilter(f.amountMin);
        const max = txParseAmountFilter(f.amountMax);
        if (min !== null && t.amount < min) return false;
        if (max !== null && t.amount > max) return false;
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

    // Jump to a page and redraw, scrolling the rows back to the top so the user
    // isn't left staring at the old scroll position after the rows swap out.
    // <tbody> is the scroller (transactions.css §1); the horizontal position is
    // left alone, since which columns you're looking at is a viewing preference
    // that shouldn't reset under you on every page turn.
    function txGoToPage(p) {
        if (!Number.isFinite(p)) return;
        txState.page = p;
        txRender();
        const tbody = document.getElementById('tx-tbody');
        if (tbody) tbody.scrollTop = 0;
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
        const band = document.getElementById('tx-footer');
        const pages = txPageCount(totalVisible);
        if (totalVisible === 0 || pages <= 1) {
            if (band) band.hidden = true;
            el.innerHTML = '';
            return;
        }
        if (band) band.hidden = false;
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
        // The multi-selects ship as lists the backend ORs together; the 'none'
        // sentinel becomes a literal null in the list (= uncategorized /
        // unassigned), which is how a single pick was already expressed.
        if (f.type.length)     out.tx_type = [...f.type];
        if (f.category.length) out.category_id = f.category.map(v => (v === 'none' ? null : parseInt(v, 10)));
        if (f.account.length)  out.account_key = f.account.map(v => (v === 'none' ? null : v));
        const min = txParseAmountFilter(f.amountMin);
        const max = txParseAmountFilter(f.amountMax);
        if (min !== null)   out.amount_min = min;
        if (max !== null)   out.amount_max = max;
        return Object.keys(out).length ? out : null;
    }

    // ─── Filter chips ────────────────────────────────────────────────────────────
    // Each chip controls one search filter. Inactive chips show a dotted outline
    // with the field name; clicking one opens a popover of options, and once a
    // value is set the chip fills with the primary accent and reads
    // "Field : value" with a leading × to clear it. Every chip writes the same
    // txState.filters object that drives txRowMatchesFilters / txExportFilters, so
    // the table, Export and the Cash Flow deep-link pre-fill stay in sync. The
    // chip nodes are static in the page; only their active class and value text
    // are updated (txSyncChips), so an open popover and its focused input survive
    // a keystroke.

    // Display labels for the field name and the Type values. Ordered to match
    // the table columns (see the chip row in transactions.html).
    const TX_FILTER_LABELS = { date: 'Date', name: 'Name', type: 'Type', category: 'Category', account: 'Account', amount: 'Amount' };
    const TX_TYPE_LABELS   = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };

    // Which txState.filters keys each chip controls (cleared together by its ×).
    const TX_FILTER_FIELDS = {
        date:     ['dateFrom', 'dateTo'],
        name:     ['name'],
        type:     ['type'],
        category: ['category'],
        account:  ['account'],
        amount:   ['amountMin', 'amountMax'],
    };

    // The fields holding a list of picked values rather than a scalar (see
    // txState.filters). Their "off" value is an empty array, not a blank string.
    const TX_MULTI_FIELDS = new Set(['type', 'category', 'account']);

    // The empty (filter-off) value for one txState.filters key.
    function txBlankFilter(field) {
        return TX_MULTI_FIELDS.has(field) ? [] : '';
    }

    // Toggle one value in or out of a multi-select field, preserving option order
    // so the chip shows the same value regardless of tick order.
    function txToggleMulti(key, value, order) {
        const current = txState.filters[key];
        const next = current.includes(value)
            ? current.filter(v => v !== value)
            : [...current, value];
        next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        txSetFilter({ [key]: next });
    }

    // Quick ranges offered in the Date popover. Each resolves to the full calendar
    // period containing today, so "This year" produces the same Jan 1 – Dec 31 range
    // the Cash Flow deep-link sets (and the chip collapses it to just the year).
    const TX_DATE_PRESETS = [['week', 'This week'], ['month', 'This month'], ['year', 'This year']];

    // Quick thresholds offered in the Amount popover, mirroring the Date presets.
    // '<' fills only Max (amount ≤ n); '>' fills only Min (amount ≥ n). Labels are
    // rendered with formatCurrency so they honour the user's currency/format.
    const TX_AMOUNT_PRESETS = [['<', 50], ['<', 100], ['>', 100]];

    // The { amountMin, amountMax } a preset sets. Also used to mark it selected.
    function txAmountPresetRange(cmp, n) {
        return cmp === '>'
            ? { amountMin: String(n), amountMax: '' }
            : { amountMin: '', amountMax: String(n) };
    }

    // [dateFrom, dateTo] for a preset key. The week's first day follows the
    // Preferences → Format "Week Starts On" setting (Sunday by default).
    function txDatePresetRange(preset) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (preset === 'week') {
            const daysBack = localStorage.getItem('week_start') === 'monday'
                ? (now.getDay() + 6) % 7
                : now.getDay();
            const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
            const to   = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
            return [iso(from), iso(to)];
        }
        if (preset === 'month') {
            return [iso(new Date(now.getFullYear(), now.getMonth(), 1)),
                    iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
        }
        return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
    }

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

    // Chip text for a multi-select: the first pick alone, or the first pick plus
    // a "+N" suffix. Showing one value keeps the chip readable without opening
    // the popover, which a bare "3 selected" would require.
    function txFilterMultiText(values, labelFor) {
        if (!values.length) return null;
        const first = labelFor(values[0]);
        return values.length === 1 ? first : `${first} +${values.length - 1}`;
    }

    // The active-chip value text for a filter, or null when that filter is off.
    function txFilterValueText(key) {
        const f = txState.filters;
        switch (key) {
            case 'date':   return txFilterDateText();
            case 'name':   return f.name.trim() || null;
            case 'amount': return txFilterAmountText();
            case 'type':   return txFilterMultiText(f.type, v => TX_TYPE_LABELS[v] || 'Type');
            case 'category':
                return txFilterMultiText(f.category, v =>
                    (v === 'none' ? 'Uncategorized' : txCategoryName(parseInt(v, 10)) || 'Category'));
            case 'account':
                return txFilterMultiText(f.account, v =>
                    (v === 'none' ? 'No account' : txAccountName(v) || 'Account'));
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

    // Drop any picked category that no longer exists (after an import or a
    // category delete), keeping the rest. Called on every (re)load.
    function txReconcileCategoryFilter() {
        txState.filters.category = txState.filters.category
            .filter(c => c === 'none' || txCategoryById(parseInt(c, 10)));
    }

    // Same for the account filter: a Balance Sheet column deleted since it was
    // chosen leaves a key that names no account, so drop it. Called on (re)load.
    function txReconcileAccountFilter() {
        txState.filters.account = txState.filters.account
            .filter(a => a === 'none' || a in txState.accountsByKey);
    }

    // Clear one chip's filter (its leading ×).
    function txClearFilter(key) {
        txCloseFilterPopover();
        const patch = {};
        for (const field of TX_FILTER_FIELDS[key]) patch[field] = txBlankFilter(field);
        txSetFilter(patch);
    }

    // Reset every filter. Shared by the Clear all chip and the "Clear filters"
    // action in the filtered-empty state.
    function txClearFilters() {
        txCloseFilterPopover();
        for (const fields of Object.values(TX_FILTER_FIELDS)) {
            for (const field of fields) txState.filters[field] = txBlankFilter(field);
        }
        txState.page = 1;
        txSyncChips();
        txRender();
    }

    // ─── Filter popovers ─────────────────────────────────────────────────────────
    // One popover open at a time, built on demand under the clicked chip and removed
    // on close. Date/Name/Amount popovers carry live inputs; Type/Category/Account
    // popovers are multi-select checkbox lists that stay open across picks (the
    // whole point of ticking several), applying each one live to the table.

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

    // Reflect a pick list back onto an open option list. The popover stays open
    // after a click (see txBuildOptionList), so its boxes update in place. The
    // leading "All" row (value '') shows as ticked when nothing else is.
    function txSyncOptionList(list, values) {
        list.querySelectorAll('.tx-pop-option').forEach(btn => {
            const v   = btn.dataset.value;
            const sel = v === '' ? values.length === 0 : values.includes(v);
            btn.classList.toggle('is-selected', sel);
            btn.setAttribute('aria-selected', String(sel));
        });
    }

    // A multi-select checkbox list for the Type/Category/Account popovers.
    // Clicking an option toggles it and the popover STAYS open, so several can be
    // ticked in one visit; the leading "All" row is the way back to no filter.
    // `current` is the field's array of picked values. An entry of { header }
    // renders as a non-interactive group label instead of an option (the Category
    // list groups by cat_type).
    function txBuildOptionList(key, options, current) {
        const list = document.createElement('div');
        list.className = 'tx-pop-options';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-multiselectable', 'true');
        // Render order of the real options; picks are kept in it, so the chip
        // names the same value however the boxes were ticked (txToggleMulti).
        const order = options.filter(e => !e.header).map(([value]) => value);
        list.innerHTML = options.map((entry) => {
            if (entry.header) {
                return `<div class="tx-pop-group-label" role="presentation">${txEsc(entry.header)}</div>`;
            }
            const [value, label] = entry;
            // No indent under a group header: the eyebrow already marks the
            // group, and one straight column of tick boxes is easier to scan
            // (and to hit) than one that steps in halfway down the list.
            return `<button type="button" class="tx-pop-option" role="option" aria-selected="false" data-value="${txEsc(value)}">
                    <span class="tx-pop-box" aria-hidden="true">
                        <svg class="tx-pop-check" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                    <span class="tx-pop-option-label">${txEsc(label)}</span>
                </button>`;
        }).join('');
        txSyncOptionList(list, current);
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('.tx-pop-option');
            if (!btn) return;
            const value = btn.dataset.value;
            if (value === '') txSetFilter({ [key]: [] });   // "All" drops every pick
            else txToggleMulti(key, value, order);
            txSyncOptionList(list, txState.filters[key]);
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
            // Quick-range pills first (the common case), the free From/To inputs
            // below. A pill whose range is the active filter reads as selected;
            // picking one applies and closes, like the Type/Category options.
            const presets = TX_DATE_PRESETS.map(([preset, label]) => {
                const [from, to] = txDatePresetRange(preset);
                const sel = f.dateFrom === from && f.dateTo === to;
                return `<button type="button" class="tx-pop-preset${sel ? ' is-selected' : ''}" aria-pressed="${sel}" data-preset="${preset}">${label}</button>`;
            }).join('');
            wrap.innerHTML = `
            <div class="tx-pop-presets" role="group" aria-label="Quick date ranges">${presets}</div>
            <label class="tx-pop-field">
                <span class="tx-pop-label">From</span>
                <input type="date" class="tx-input tx-input-date" data-k="dateFrom" value="${txEsc(f.dateFrom)}">
            </label>
            <label class="tx-pop-field">
                <span class="tx-pop-label">To</span>
                <input type="date" class="tx-input tx-input-date" data-k="dateTo" value="${txEsc(f.dateTo)}">
            </label>`;
            txWirePopoverInputs(wrap);
            wrap.querySelectorAll('.tx-pop-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const [dateFrom, dateTo] = txDatePresetRange(btn.dataset.preset);
                    txCloseFilterPopover();
                    txSetFilter({ dateFrom, dateTo });
                });
            });
        } else if (key === 'name') {
            wrap.innerHTML = `
            <label class="tx-pop-field">
                <span class="tx-pop-label">Description contains</span>
                <input type="text" class="tx-input" data-k="name" value="${txEsc(f.name)}" placeholder="Search descriptions" spellcheck="false" autocomplete="off">
            </label>`;
            txWirePopoverInputs(wrap);
        } else if (key === 'amount') {
            // Quick-threshold pills first (the common case), the free Min/Max inputs
            // below — same shape as the Date popover. A pill whose bounds are the
            // active filter reads as selected; picking one applies and closes.
            const presets = TX_AMOUNT_PRESETS.map(([cmp, n], i) => {
                const { amountMin, amountMax } = txAmountPresetRange(cmp, n);
                const sel = String(f.amountMin) === amountMin && String(f.amountMax) === amountMax;
                return `<button type="button" class="tx-pop-preset${sel ? ' is-selected' : ''}" aria-pressed="${sel}" data-preset="${i}">${cmp} ${formatCurrency(n, true)}</button>`;
            }).join('');
            wrap.innerHTML = `
            <div class="tx-pop-presets" role="group" aria-label="Quick amount ranges">${presets}</div>
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
            wrap.querySelectorAll('.tx-pop-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const [cmp, n] = TX_AMOUNT_PRESETS[Number(btn.dataset.preset)];
                    txCloseFilterPopover();
                    txSetFilter(txAmountPresetRange(cmp, n));
                });
            });
        } else if (key === 'type') {
            wrap.appendChild(txBuildOptionList('type', [
                ['', 'All'], ['income', 'Income'], ['expense', 'Expense'], ['transfer', 'Transfer'],
            ], f.type));
        } else if (key === 'category') {
            // Grouped by cat_type under eyebrow headers. The locked uncat_*
            // system buckets are skipped: no transaction is ever assigned to
            // them (they're NULL-category sums), and the 'none' sentinel
            // already covers Uncategorized.
            const opts = [['', 'All'], ['none', 'Uncategorized']];
            Object.entries(TX_TYPE_LABELS).forEach(([type, label]) => {
                const cats = txState.categories
                    .filter(c => c.cat_type === type && !c.locked)
                    .sort((a, b) => a.position - b.position);
                if (!cats.length) return;
                opts.push({ header: label });
                cats.forEach(c => opts.push([String(c.id), c.name]));
            });
            wrap.appendChild(txBuildOptionList('category', opts, f.category));
        } else if (key === 'account') {
            // Accounts are the Balance Sheet columns (txState.accountsByKey),
            // listed in their column order. A row with no account renders as "—"
            // in the table; the 'none' sentinel filters to exactly those.
            const opts = [['', 'All'], ['none', 'No account']];
            Object.entries(txState.accountsByKey).forEach(([acctKey, label]) => opts.push([acctKey, label]));
            wrap.appendChild(txBuildOptionList('account', opts, f.account));
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
    // Other pages link into the ledger pre-filtered:
    //   • Cash Flow  → /transactions?year=<year>&cat=<categoryKey>
    //   • Recurring  → /transactions?name=<merchant search term>
    // On arrival with those params, pre-fill the filters — that year's Jan–Dec
    // range, the matching category, the name search — so the chips light up to
    // reveal the active search. Every param maps onto an ordinary chip the user can
    // edit or clear, so a deep link is a starting point, not a mode. Must run after
    // the category vocabulary and chips are in place (i.e. after txChipsInit).
    function txApplyUrlFilters() {
        let params;
        try { params = new URLSearchParams(location.search); }
        catch { return; }
        const yearRaw = params.get('year');
        const monthRaw = params.get('month');
        const catKey  = params.get('cat');
        const nameRaw = params.get('name');
        if (yearRaw == null && catKey == null && nameRaw == null) return;

        // The Recurring calendar's merchant link. Substring-matched against both
        // the description and the display name (txRowMatchesFilters), which is why
        // the term it sends comes from the raw descriptions of the schedule's
        // transactions — see searchTermByKey in handlers/recurring.js.
        if (nameRaw && nameRaw.trim()) txState.filters.name = nameRaw.trim();

        const year = parseInt(yearRaw, 10);
        if (Number.isInteger(year) && year > 0) {
            // `month` (1-12) narrows the same link to one month — the Cash Flow
            // Sankey sends it when a single month is on screen, so the band
            // clicked and the rows listed cover the same span. Day 0 of the next
            // month is the last day of this one, which covers February.
            const month = parseInt(monthRaw, 10);
            const scoped = Number.isInteger(month) && month >= 1 && month <= 12;
            const pad = (n) => String(n).padStart(2, '0');
            txState.filters.dateFrom = scoped ? `${year}-${pad(month)}-01` : `${year}-01-01`;
            txState.filters.dateTo   = scoped
                ? `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`
                : `${year}-12-31`;
        }
        if (catKey) {
            // Match on the stable category key the link carries; map it to the id the
            // filter state holds. An unknown key just leaves the category filter off.
            // The locked uncat_* system buckets are NULL-category sums, not real
            // assignments — filtering by their id matches nothing, so the Cash
            // Flow "Uncategorized" band maps to the 'none' filter instead.
            const cat = txState.categories.find(c => c.key === catKey);
            if (cat) txState.filters.category = [cat.locked ? 'none' : String(cat.id)];
        }

        txState.page = 1;
        txSyncChips();
        txRender();

        // Consume the deep-link: keep the applied filters but strip the query string
        // so a manual refresh or bookmark doesn't silently re-prefill.
        try { history.replaceState(null, '', location.pathname); } catch { /* non-fatal */ }
    }

    // ─── Render orchestration ────────────────────────────────────────────────────

    // The header band cannot scroll itself (transactions.css §1: <tbody> holds
    // both scrollbars so they stay attached to the rows), so JS moves the header
    // sideways in step with the body. Set synchronously in the scroll event — a
    // rAF hop here makes a frozen header lag a frame behind its columns.
    function txSyncHeaderScroll() {
        const tbody = document.getElementById('tx-tbody');
        const thead = document.querySelector('.tx-table > thead');
        if (!tbody || !thead) return;
        thead.scrollLeft = tbody.scrollLeft;
    }

    // Every ledger row is an independent one-row table (transactions.css §1 — the
    // header and body bands scroll separately), so column widths are not kept in
    // sync across rows automatically. This measures the content width of each fit
    // column across the header and every mounted display row, then writes the max
    // back as a --tx-w-* custom property shared by every band. The temporary
    // inline add-row (.tx-new) is excluded — its <input>/<select> controls have no
    // content width comparable to a text cell, and would distort the measurement
    // during entry.
    function txSyncColumnWidths() {
        const table = document.querySelector('.tx-table');
        if (!table) return;
        table.classList.add('tx-measuring');
        const widths = {};
        for (const col of TX_FIT_COLS) {
            let max = 0;
            table.querySelectorAll(`tr:not(.tx-new) > .tx-col-${col}`).forEach(cell => {
                // getBoundingClientRect(), not offsetWidth: offsetWidth is
                // ROUNDED to a whole pixel, so a cell whose real content is
                // 118.4px wide measures 118 and gets written back 0.4px too
                // narrow — enough to wrap the one date whose glyphs land on
                // the wrong side of the rounding ("Aug 20, 2026" did). Ceil so
                // the width is never short.
                const w = Math.ceil(cell.getBoundingClientRect().width);
                if (w > max) max = w;
            });
            if (TX_FIT_MAX[col]) max = Math.min(max, TX_FIT_MAX[col]);
            widths[col] = max;
        }
        table.classList.remove('tx-measuring');
        for (const col of TX_FIT_COLS) {
            table.style.setProperty(`--tx-w-${col}`, `${widths[col]}px`);
        }
    }

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
                account_key: null,
                amount:      '',
                notes:       '',
            }, { isNew: true }));
        }

        const visible = txVisibleRows();

        // Selection covers only visible rows: drop any ids the current filters
        // hide, so a bulk action never applies to a filtered-out row.
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
        txSyncColumnWidths();
        // Column widths just changed, which can change how far the rows overflow —
        // realign the header with wherever the body's scroll position landed.
        txSyncHeaderScroll();
        txFocusFirstInput();
        txUpdateSelectionUI();
    }

    // (The per-row direction lock that used to be here — copy the category's
    // cat_type into a Type select and disable it — was removed with the last Type
    // control in the single-row editors. The en-masse control row has its own
    // version of the rule, with one addition: a "Keep" sentinel to fall back to.
    // Direction still comes from the category, and the backend is now the only
    // place that rule is applied.)

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
        // pages, but "select all" applies to the rows currently displayed.
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

    // Read one edit-control group (the inline add row or the edit modal's form)
    // into an update/create payload. `scope` is any element containing the
    // data-field inputs.
    //
    // Neither group carries a Type control any more — direction is the category's
    // to give — so tx_type is sent only if one is actually there. Defaulting it to
    // 'expense' in its absence would have flipped an uncategorized income row
    // every time the user saved an unrelated field. Absent, the backend leaves an
    // existing row's direction alone and gives a new one the same 'expense'
    // default (applyTxFields), so the create path loses nothing either.
    function txReadFields(scope) {
        if (!scope) return null;
        const get = (field) => scope.querySelector(`[data-field="${field}"]`)?.value;
        const rawAmount   = (get('amount') || '').toString().replace(/,/g, '').trim();
        const amount      = parseFloat(rawAmount);
        const categoryRaw = get('category_id');
        const accountRaw  = get('account_key');
        const txType      = get('tx_type');
        return {
            date:        get('date'),
            description: (get('description') || '').trim(),
            ...(txType ? { tx_type: txType } : {}),
            category_id: categoryRaw === '' ? null : parseInt(categoryRaw, 10),
            account_key: accountRaw == null || accountRaw === '' ? null : accountRaw,
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
    // .confirm-overlay pattern (see tables.js confirmDelete). Deletes loop over
    // the single-row endpoint; failed rows stay selected so they can be retried.
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

    // Editing wizard → three steps inside one overlay:
    //      1. Edit — the **en-masse** layout, whatever the selection size: one
    //      control row on top holds the edit, and the rows it will rewrite are
    //      listed read-only beneath it, each set column redrawn in place with the
    //      value it will receive. A single row used to get a separate form, but
    //      the two layouts shared the same wizard, payloads and save loop, so the
    //      fork was a second layout to maintain with no behavioural difference.
    //      It also changed the modal's shape with the selection count, which read
    //      as two dialogs for one action. The table layout is kept because it
    //      scales: it uses the ledger's column order, and a selection of one is
    //      its shortest case.
    //      A footer checkbox offers to cascade the chosen categories onto other
    //      transactions with similar descriptions.
    //   2. Find similar (only when the checkbox is on) — a match-strength slider
    //      (always starting at 80%) over a live-updating list of candidate rows,
    //      grouped by the category each would receive.
    //   3. Review — a summary of the field changes (and the cascade) behind one
    //      "Save all changes" button.
    // Saves loop over the single-row update endpoint (which applies the direction
    // rule and records match rules), so a row that fails stays selected for a
    // retry; the cascade runs categorize-similar with overwrite, since the user
    // confirmed each row in the match list.
    function txOpenEditModal() {
        const txs = txSelectedRows();
        if (!txs.length) return;
        const plural = txs.length === 1 ? '' : 's';
        const byId   = new Map(txs.map(t => [t.id, t]));

        const editStepHtml = `
                <div class="tx-bulk-head">
                    <div class="tx-bulk-panel">
                        <table class="tx-edit-table tx-bulk-table">
                            ${TX_BULK_COLGROUP}
                            <thead><tr>${TX_EDIT_HEAD_CELLS}</tr></thead>
                            <tbody><tr class="tx-bulk-apply-row" id="tx-bulk-apply">${txBulkFieldsCells()}</tr></tbody>
                        </table>
                    </div>
                    <div class="tx-bulk-count">Selected</div>
                </div>
                <div class="tx-bulk-panel tx-bulk-preview-panel">
                    <table class="tx-edit-table tx-bulk-table tx-bulk-preview-table">
                        ${TX_BULK_COLGROUP}
                        <tbody>${txs.map(txBulkPreviewRow).join('')}</tbody>
                    </table>
                </div>`;

        const overlay = document.createElement('div');
        overlay.className = 'tx-edit-overlay';
        overlay.id = 'tx-edit-overlay';
        overlay.innerHTML = `
        <div class="tx-edit-dialog is-edit-step is-bulk-edit">
            <div class="tx-edit-header">
                <span class="tx-edit-title" id="tx-edit-title">Edit ${txs.length} transaction${plural}</span>
                <button class="tx-import-close" id="tx-edit-close" aria-label="Close">&times;</button>
            </div>
            <div class="tx-edit-body tx-bulk-body" data-step="edit">${editStepHtml}
            </div>
            <div class="tx-edit-body" data-step="match" hidden>
                <div class="tx-match-slider-row">
                    <label class="tx-match-slider-label" for="tx-match-slider">Match strength</label>
                    <span class="tx-match-end">Loose</span>
                    <input type="range" id="tx-match-slider" class="tx-match-slider"
                           min="0.5" max="1" step="0.05" value="0.8">
                    <span class="tx-match-end">Exact</span>
                    <span class="tx-match-value" id="tx-match-value">80%</span>
                </div>
                <div class="tx-match-results" id="tx-match-results"></div>
            </div>
            <div class="tx-edit-body" data-step="review" hidden>
                <div id="tx-review-body"></div>
            </div>
            <div class="tx-edit-footer">
                <label class="tx-cascade-toggle" id="tx-cascade-toggle">
                    <input type="checkbox" class="tx-checkbox" id="tx-cascade-cb">
                    <span>Apply to similar transactions</span>
                </label>
                <button class="tx-similar-skip" id="tx-edit-back" hidden>Back</button>
                <button class="tx-similar-skip" id="tx-edit-cancel">Cancel</button>
                <button class="button-primary" id="tx-edit-next">Next</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        const $ = (sel) => overlay.querySelector(sel);
        const applyRow = $('#tx-bulk-apply');
        const steps = {
            edit:   $('[data-step="edit"]'),
            match:  $('[data-step="match"]'),
            review: $('[data-step="review"]'),
        };
        const titleEl   = $('#tx-edit-title');
        const backBtn   = $('#tx-edit-back');
        const nextBtn   = $('#tx-edit-next');
        const cascadeCb = $('#tx-cascade-cb');
        const slider    = $('#tx-match-slider');
        const sliderVal = $('#tx-match-value');
        const results   = $('#tx-match-results');

        let step   = 'edit';
        let edits  = [];      // [{id, payload, orig}] collected on leaving step 1
        let saving = false;
        // Every candidate the similar-search has returned this session, by id.
        // checkedMatches() yields ids only, and the review table needs the whole
        // row to draw it the way the ledger will.
        const matchById = new Map();

        // No backdrop-click dismissal: a mid-wizard misclick would silently
        // discard edits. Leaving is explicit — the × or the Cancel button.
        const close = () => overlay.remove();
        $('#tx-edit-close').addEventListener('click', close);
        const cancelBtn = $('#tx-edit-cancel');
        cancelBtn.addEventListener('click', close);

        function showStep(next) {
            step = next;
            for (const [k, el] of Object.entries(steps)) el.hidden = k !== step;
            // Steps 1 and 3 have fixed content the dialog can size to; only the
            // match step, whose list resizes with the slider, keeps the fixed
            // height (transactions.css §11).
            $('.tx-edit-dialog').classList.toggle('is-edit-step', step !== 'match');
            $('#tx-cascade-toggle').hidden = step !== 'edit';
            backBtn.hidden = step === 'edit';
            // Review is the last step, where Back returns through the wizard and
            // the × closes the dialog — a third exit beside the single Save button
            // would add nothing at the point of committing.
            cancelBtn.hidden = step === 'review';
            titleEl.textContent =
                step === 'edit'  ? `Edit ${txs.length} transaction${plural}` :
                step === 'match' ? 'Find similar transactions' :
                                   'Review changes';
            nextBtn.textContent = step === 'review' ? 'Save all changes' : 'Next';
            // Step 1 gates Next on having something set; the later steps don't.
            if (step === 'edit') syncBulkPreview(); else nextBtn.disabled = false;
        }

        // ── En-masse control row ───────────────────────────────────────────────
        // Keeps the list below in sync while the control row is filled in: every
        // column that is set is REDRAWN in the rows below with the value it will
        // receive, so the list matches what the ledger will show after saving. It
        // used to strike the old value through instead, which required reading the
        // new value from the control above; clearing a control restores the row's
        // existing value.
        function syncBulkPreview() {
            const overrides = txReadBulkFields(applyRow);

            // A typed amount that is not a number sets nothing: it marks its own
            // control and blocks the wizard there, rather than striking a column
            // through with an unsaveable value or showing an alert when leaving
            // the step.
            const badAmount = 'amount' in overrides && !Number.isFinite(overrides.amount);
            if (badAmount) delete overrides.amount;
            applyRow.querySelector('.tx-input-amount').classList.toggle('is-invalid', badAmount);

            const claimed = new Set(Object.keys(overrides));

            for (const cell of applyRow.children) {
                const field = cell.querySelector('[data-field]')?.dataset.field;
                cell.classList.toggle('is-set', !!field && field in overrides);
            }
            for (const row of overlay.querySelectorAll('.tx-bulk-row')) {
                const t = byId.get(parseInt(row.dataset.id, 10));
                if (!t) continue;
                const next = txApplyPayload(t, overrides);

                for (const c of TX_BULK_COLS) {
                    const cell = row.querySelector(`td[data-col="${c.col}"]`);
                    if (!cell) continue;
                    const replaced = claimed.has(c.col);
                    const src      = replaced ? next : t;
                    const html     = c.html(src);
                    if (cell.innerHTML !== html) cell.innerHTML = html;
                    if (c.title) cell.title = c.title(src);
                    cell.classList.toggle('is-replaced', replaced);
                }
            }

            // With nothing set there is nothing to apply, so the primary action
            // stays disabled rather than showing a validation alert on click. The
            // tinted control row, the accent borders, the struck-through columns
            // and the Next button enabling all indicate the state without extra
            // text.
            nextBtn.disabled = !claimed.size || badAmount;
        }

        // The direction lock that kept the Type select in sync with the Category
        // one was removed with the Type column: nothing displays direction
        // separately any more.
        applyRow.addEventListener('input',  syncBulkPreview);
        applyRow.addEventListener('change', syncBulkPreview);
        syncBulkPreview();

        // Validate up front so a bad field doesn't leave a half-saved batch.
        function collectEdits() {
            // Both of these are already blocked by the disabled Next button; kept
            // as a guard, with no message, since the controls already show the
            // state.
            const overrides = txReadBulkFields(applyRow);
            if (!Object.keys(overrides).length) return null;
            if ('amount' in overrides && !Number.isFinite(overrides.amount)) return null;
            // One partial payload per row: the update endpoint writes only the
            // keys it is given, so every other column is left unchanged.
            return txs.map(t => ({ id: t.id, payload: { ...overrides }, orig: t }));
        }

        // The fields a payload may carry — the set rowChanges compares over.
        const EDITABLE_FIELDS = ['date', 'description', 'category_id',
                                 'account_key', 'amount', 'notes'];

        function rowChanges(orig, payload) {
            const out = [];
            for (const field of EDITABLE_FIELDS) {
                // The en-masse control row sends a partial payload — a field it
                // never set isn't a change, it's an absence.
                if (!(field in payload)) continue;
                const before = orig?.[field];
                const after  = payload[field];
                const same = field === 'amount'
                    ? Number(before) === Number(after)
                    : (before ?? '') === (after ?? '');
                if (!same) out.push({ field, before, after });
            }
            return out;
        }

        // ── Step 2: live similar-transaction search ──────────────────────────
        // One query per distinct (description, category) among the edited rows
        // that end up categorized — those categories are what cascades. Each
        // matched row is claimed by the first group that hits it, and rows
        // already in the target category are skipped (a no-op there). The token
        // drops stale responses when the slider moves mid-flight.
        let fetchToken = 0;

        async function fetchMatches() {
            const token = ++fetchToken;
            const seen = new Set();
            const queries = [];
            // A field the payload does not carry keeps the row's existing value,
            // which is the common case here, since one category typically cascades
            // across many different descriptions.
            for (const { payload, orig } of edits) {
                const category_id = 'category_id' in payload ? payload.category_id : orig?.category_id;
                const description = 'description' in payload ? payload.description : orig?.description;
                if (category_id == null || !description) continue;
                const key = `${description.toLowerCase()} ${category_id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                queries.push({ description, category_id });
            }
            if (!queries.length) {
                results.classList.remove('tx-match-loading');
                results.innerHTML = '<div class="tx-match-empty">No category set</div>';
                return;
            }
            // Only the results swap: a re-query keeps the current list in
            // place (dimmed) until the new one lands, so the step never
            // flashes or jumps while the slider is dragged. The placeholder
            // shows only when there is no list yet.
            if (results.querySelector('.tx-similar-group')) {
                results.classList.add('tx-match-loading');
            } else {
                results.innerHTML = '<div class="tx-match-empty">Searching…</div>';
            }

            const excludeIds = edits.map(e => e.id).join(',');
            const claimed = new Set();
            const byCat   = new Map();
            const groups  = [];
            for (const q of queries) {
                let matches = [];
                try {
                    const params = new URLSearchParams({
                        description:         q.description,
                        threshold:           slider.value,
                        include_categorized: '1',
                        exclude_ids:         excludeIds,
                    });
                    const r = await apiFetch(`/api/transactions/similar?${params}`);
                    if (r.ok) matches = (await r.json()).transactions || [];
                } catch (_) { /* non-critical path, skip this query */ }
                if (token !== fetchToken) return;
                for (const m of matches) {
                    if (claimed.has(m.id) || m.category_id === q.category_id) continue;
                    claimed.add(m.id);
                    matchById.set(m.id, m);
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
            renderMatches(groups);
        }

        function renderMatches(groups) {
            results.classList.remove('tx-match-loading');
            if (!groups.length) {
                results.innerHTML = '<div class="tx-match-empty">No matches at this strength</div>';
                return;
            }
            const rowHtml = (g) => g.matches.map(t => {
                const isIncome = t.tx_type === 'income';
                const amtClass = isIncome ? 'tx-amount-income' : 'tx-amount-expense';
                const sign     = isIncome ? '+ ' : '− ';
                const curCat   = txCategoryName(t.category_id);
                const catCell  = curCat
                    ? `<span class="tx-category-pill">${txEsc(curCat)}</span>`
                    : '<span class="tx-category-pill tx-category-empty">Uncategorized</span>';
                return `
                    <tr>
                        <td class="tx-similar-col-check">
                            <input type="checkbox" class="tx-similar-cb" data-id="${t.id}" data-cat="${g.categoryId}" checked>
                        </td>
                        <td class="tx-similar-col-date">${txEsc(txFmtDate(t.date))}</td>
                        <td title="${txEsc(t.description)}">${txEsc(t.display_name || t.description)}</td>
                        <td class="tx-similar-col-cat">${catCell}</td>
                        <td class="tx-similar-col-amount ${amtClass}">${sign}${txFmtAmount(t.amount)}</td>
                    </tr>
                `;
            }).join('');

            results.innerHTML = groups.map(g => `
                <div class="tx-similar-group" data-cat="${g.categoryId}">
                    <label class="tx-similar-group-head">
                        <input type="checkbox" class="tx-similar-group-all" data-cat="${g.categoryId}" checked>
                        <span class="tx-similar-group-name">Will become ${txEsc(g.catName)}</span>
                        <span class="tx-similar-group-count">${g.matches.length}</span>
                    </label>
                    <div class="tx-similar-table-wrap">
                        <table class="tx-similar-table"><tbody>${rowHtml(g)}</tbody></table>
                    </div>
                </div>
            `).join('');

            // A group's header checkbox mirrors its rows, same as the similar modal.
            results.querySelectorAll('.tx-similar-group-all').forEach(all =>
                all.addEventListener('change', () => {
                    results.querySelectorAll(`.tx-similar-cb[data-cat="${all.dataset.cat}"]`)
                        .forEach(cb => { cb.checked = all.checked; });
                })
            );
            results.querySelectorAll('.tx-similar-cb').forEach(cb =>
                cb.addEventListener('change', () => {
                    const cbs = results.querySelectorAll(`.tx-similar-cb[data-cat="${cb.dataset.cat}"]`);
                    const all = results.querySelector(`.tx-similar-group-all[data-cat="${cb.dataset.cat}"]`);
                    if (all) all.checked = [...cbs].some(x => x.checked);
                })
            );
        }

        // Live label + debounced re-query while the slider moves.
        let sliderDebounce = null;
        slider.addEventListener('input', () => {
            sliderVal.textContent = Math.round(slider.value * 100) + '%';
            clearTimeout(sliderDebounce);
            sliderDebounce = setTimeout(fetchMatches, 250);
        });

        // Checked matches per target category — the cascade payloads.
        function checkedMatches() {
            const byCat = new Map();
            for (const cb of results.querySelectorAll('.tx-similar-cb:checked')) {
                const cat = parseInt(cb.dataset.cat, 10);
                if (!byCat.has(cat)) byCat.set(cat, []);
                byCat.get(cat).push(parseInt(cb.dataset.id, 10));
            }
            return byCat;
        }

        // ── Step 3: the result ─────────────────────────────────────────────────
        // Every affected transaction as the ledger will show it once saved, not
        // a summary of the fields that moved. The step-1 table already answered
        // what is changing and marked the changed cells in the accent colour;
        // this one shows the result, so it drops the marking and renders in the
        // ledger's normal colours — a row here matches the row that will appear
        // afterwards.
        //
        // Rows an edit would not change are still listed: they are part of the
        // resulting selection, and omitting them would make the table's row count
        // differ from the count in the title.
        function renderSummary() {
            const table = (rows) => `
                <div class="tx-bulk-panel tx-review-panel">
                    <table class="tx-review-table">
                        ${TX_REVIEW_COLGROUP}
                        <thead><tr>${TX_REVIEW_HEAD_CELLS}</tr></thead>
                        <tbody>${rows.map(txReviewRow).join('')}</tbody>
                    </table>
                </div>`;

            const finals = edits.map(({ orig, payload }) => txApplyPayload(orig, payload));
            const editHtml = finals.length
                ? table(finals)
                : '<div class="tx-match-empty">Nothing to change</div>';

            // The cascade rewrites transactions too, so they get the same table
            // rather than a count, so every row the save will change can be read
            // beforehand. They are in a separate section because they were not
            // part of the selection; they were found by the cascade.
            let cascadeHtml = '';
            if (cascadeCb.checked) {
                const cascaded = [];
                for (const [cat, ids] of checkedMatches()) {
                    for (const id of ids) {
                        const m = matchById.get(id);
                        if (m) cascaded.push(txApplyPayload(m, { category_id: cat }));
                    }
                }
                cascaded.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
                cascadeHtml = `
                    <div class="tx-review-section-title">Similar transactions</div>
                    ${cascaded.length ? table(cascaded)
                                      : '<div class="tx-match-empty">None selected</div>'}`;
            }

            $('#tx-review-body').innerHTML = `
                <div class="tx-review-section-title">Selected transactions</div>
                ${editHtml}
                ${cascadeHtml}`;
        }

        // ── Save ───────────────────────────────────────────────────────────────
        async function saveAll() {
            if (saving) return;
            saving = true;
            nextBtn.disabled = true;
            nextBtn.textContent = 'Saving…';

            const changed = edits.filter(({ orig, payload }) => rowChanges(orig, payload).length);
            const failed = [];
            for (const { id, payload } of changed) {
                try {
                    const saved = await txApiUpdate(id, payload);
                    const idx = txState.rows.findIndex(r => r.id === saved.id);
                    if (idx !== -1) txState.rows[idx] = saved;
                } catch (_) {
                    failed.push(id);
                }
            }

            let cascadeFailed = false;
            const cascading = cascadeCb.checked ? checkedMatches() : new Map();
            for (const [categoryId, ids] of cascading) {
                try {
                    const r = await apiFetch('/api/transactions/categorize-similar', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // overwrite: the user confirmed each row in the match
                        // list, so already-categorized ones are recategorized
                        // too. No tx_type — the backend derives it from the
                        // category.
                        body:    JSON.stringify({ ids, category_id: categoryId, overwrite: true }),
                    });
                    if (!r.ok) throw new Error('failed');
                    txInvalidateDerived();
                } catch (_) {
                    cascadeFailed = true;
                }
            }

            close();
            txState.selectedIds = new Set(failed);
            if (cascading.size) {
                // Cascaded rows changed outside txState — refetch the ledger.
                window.dispatchEvent(new Event('transactions:reload'));
            } else {
                txSortRows();
                txRender();
            }
            if (failed.length) alert(`${failed.length} transaction${failed.length === 1 ? '' : 's'} could not be saved.`);
            if (cascadeFailed) alert('Some similar transactions could not be updated.');
        }

        // ── Wizard navigation ──────────────────────────────────────────────────
        backBtn.addEventListener('click', () => {
            if (saving) return;
            showStep(step === 'review' && cascadeCb.checked ? 'match' : 'edit');
        });

        nextBtn.addEventListener('click', () => {
            if (step === 'edit') {
                const collected = collectEdits();
                if (!collected) return;
                edits = collected;
                if (cascadeCb.checked) {
                    // Fresh search each time the edits may have changed; the
                    // slider always starts back at its 80% default.
                    slider.value = '0.8';
                    sliderVal.textContent = '80%';
                    showStep('match');
                    fetchMatches();
                } else {
                    renderSummary();
                    showStep('review');
                }
            } else if (step === 'match') {
                renderSummary();
                showStep('review');
            } else {
                saveAll();
            }
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
        // CTAs rendered inside the empty state (Import transactions / Clear filters).
        const emptyBtn = e.target.closest('button[data-empty-action]');
        if (emptyBtn) {
            if (emptyBtn.dataset.emptyAction === 'tx-import')            TxFileImport.run();
            else if (emptyBtn.dataset.emptyAction === 'tx-clear-filters') txClearFilters();
            return;
        }
        // Clean-name cell: toggle the original bank description under it.
        const descBtn = e.target.closest('.tx-desc-toggle');
        if (descBtn) {
            const id = parseInt(descBtn.dataset.txDesc, 10);
            if (txState.revealedIds.has(id)) txState.revealedIds.delete(id);
            else txState.revealedIds.add(id);
            txRender();
            return;
        }
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'save')   txSaveEdit();
        if (action === 'cancel') txCancelEdit();
    }

    // Delegated checkbox handling for the row checkboxes, which are re-rendered
    // often, so the listener is on the tbody rather than each box.
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
            const [data, cols] = await Promise.all([txApiList(), txApiBalanceColumns()]);
            txState.rows          = data.transactions || [];
            txState.categories    = data.categories   || [];
            txState.accountsByKey = Object.fromEntries((cols || []).map(c => [c.key, c.label]));
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
        txReconcileAccountFilter();
        txRender();

        const tbody = document.getElementById('tx-tbody');
        tbody?.addEventListener('click',   txOnTableClick);
        tbody?.addEventListener('keydown', txOnTableKey);
        tbody?.addEventListener('change',  txOnTableChange);
        tbody?.addEventListener('scroll',  txSyncHeaderScroll, { passive: true });
        // Widening the window (or zooming out) clamps the body's scrollLeft as a
        // layout side effect, which doesn't reliably fire a scroll event — resync
        // explicitly so the header can't be left offset from its columns.
        window.addEventListener('resize', txSyncHeaderScroll);
        document.querySelector('.tx-add-btn')?.addEventListener('click', txOnAddClick);

        // Selection-driven header actions + the select-all header checkbox.
        document.querySelector('.tx-edit-btn')?.addEventListener('click', txOpenEditModal);
        document.querySelector('.tx-delete-btn')?.addEventListener('click', txConfirmBulkDelete);
        document.getElementById('tx-select-all')?.addEventListener('change', (e) => txToggleSelectAll(e.target.checked));
        document.getElementById('tx-pagination')?.addEventListener('click', txOnPaginationClick);
        txChipsInit();
        // Import and export are implemented in txfileimport.js / txexport.js, so
        // this file contains no file-format, preview-UI or rules code. Export sits
        // beside Import in the page header and saves the rows the active filters
        // leave visible.
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
        txReconcileAccountFilter();
        txSyncChips();
        txRender();
    });

    // ─── Categorize-similar feature ──────────────────────────────────────────────
    // After categorizing a transaction in the inline add row, find other
    // uncategorized rows whose description matches (exactly, case-insensitive)
    // and offer, in one dialog grouped by category, to apply the same category.
    // (Bulk edits run their cascade inside the edit wizard instead.)

    // Gather, for each category the user just applied, the still-uncategorized rows
    // that match its description. Returns groups keyed by category; each matching
    // row is assigned to the first category that matches it, so no row is offered
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
                <td title="${txEsc(t.description)}">${txEsc(t.display_name || t.description)}</td>
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
                    txInvalidateDerived();
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
}());
