'use strict';

// ─── settingsCategories.js ──────────────────────────────────────────────────
// Categories editor for the Categories page (pages/categories.html).
//
// Renders the per-user category list with inline rename, reorder arrows, a
// type pill (Income ↔ Expense), and a delete button. An "add category" row at
// the bottom appends new entries. (Sync is configured per table on the Cash
// Flow page, not here.)
//
// One source of truth for the category vocabulary used across:
//   • Transactions ledger dropdown
//   • Cash Flow table columns
//
// All state changes round-trip through the /api/categories endpoints, then
// re-render from scratch on success — same approach as the year-table
// column manager. Cheaper to rebuild than to surgically patch individual
// rows, and avoids bookkeeping drift between the DOM and the data.

(function () {

    // ── HTML safety ──────────────────────────────────────────────────────────
    // Alias of the shared global in escape.js (loaded by base.html).
    const esc = escapeHtml;

    // ── API ─────────────────────────────────────────────────────────────────
    async function apiList() {
        const r = await apiFetch('/api/categories');
        if (!r.ok) throw new Error('failed to load categories');
        return (await r.json()).categories || [];
    }

    async function apiCreate(payload) {
        const r = await apiFetch('/api/categories', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'create failed');
        return data.category;
    }

    async function apiUpdate(id, payload) {
        const r = await apiFetch(`/api/categories/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'update failed');
        return data.category;
    }

    async function apiMove(id, direction) {
        const r = await apiFetch(`/api/categories/${id}/move`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction }),
        });
        if (!r.ok) throw new Error('move failed');
    }

    async function apiDelete(id) {
        const r = await apiFetch(`/api/categories/${id}`, { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (r.status === 409 && data.error === 'has_data') {
            const parts = [];
            if (data.transactions) parts.push(`${data.transactions} transaction(s)`);
            if (data.entries)      parts.push(`${data.entries} stored I&E value(s)`);
            throw new Error(
                `Can't delete: ${parts.join(' + ')} still reference this category. ` +
                `Reassign or delete those rows first.`
            );
        }
        if (!r.ok) throw new Error(data.error || 'delete failed');
    }

    // ── Render ──────────────────────────────────────────────────────────────
    // Categories are grouped by type so the editor mirrors the Cash Flow table
    // layout. Within each section, reorder arrows only swap with same-type
    // neighbours — the API enforces the same rule.

    const TYPE_ORDER = ['income', 'expense', 'savings', 'investing'];
    const TYPE_LABEL = {
        income:    'Income',
        expense:   'Expense',
        savings:   'Savings',
        investing: 'Investing',
    };

    function groupByType(rows) {
        const groups = { income: [], expense: [], savings: [], investing: [] };
        for (const c of rows) {
            (groups[c.cat_type] ||= []).push(c);
        }
        TYPE_ORDER.forEach(t => groups[t].sort((a, b) => a.position - b.position));
        return groups;
    }

    // Chevron icons used by the reorder + delete buttons. Same shape as the
    // tables.js _CHEVRON_UP / _DOWN so the affordance reads consistently
    // across the app.
    const ICON_UP   = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const ICON_DOWN = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4"  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const ICON_X    = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2"   stroke-linecap="round"/></svg>';

    function typeSelectHtml(currentType, idAttrs = '') {
        // Two-option <select> for direction. Building the markup in one
        // place keeps the row helper and the add-row helper in sync.
        const opt = (val) => {
            const sel = val === currentType ? 'selected' : '';
            return `<option value="${val}" ${sel}>${TYPE_LABEL[val]}</option>`;
        };
        return `<select class="cat-type-select" data-action="change-type" ${idAttrs}>
                    ${TYPE_ORDER.map(opt).join('')}
                </select>`;
    }

    function rowHtml(c, isFirst, isLast) {
        const upDisabled   = isFirst ? 'cat-disabled' : '';
        const downDisabled = isLast  ? 'cat-disabled' : '';
        // Every control sits on one line. The name input flex-grows; the
        // dropdown and three trailing icon-buttons hold their intrinsic widths
        // so the row reads cleanly even on narrow viewports. (Sync is no longer
        // a per-category flag here — it's set per table on the Cash Flow page.)
        return `
            <div class="cat-row" data-id="${c.id}">
                <input type="text" class="cat-name" value="${esc(c.name)}" maxlength="100"
                       data-action="rename" aria-label="Category name">
                ${typeSelectHtml(c.cat_type)}
                <button class="cat-icon-btn cat-arrow-up   ${upDisabled}"   data-action="move" data-direction="up"   title="Move up">${ICON_UP}</button>
                <button class="cat-icon-btn cat-arrow-down ${downDisabled}" data-action="move" data-direction="down" title="Move down">${ICON_DOWN}</button>
                <button class="cat-icon-btn cat-delete"                    data-action="delete"                     title="Delete category">${ICON_X}</button>
            </div>
        `;
    }

    function sectionHtml(type, rows) {
        const items = rows.map((c, i) =>
            rowHtml(c, i === 0, i === rows.length - 1)
        ).join('') || '<div class="cat-empty">No categories yet.</div>';
        return `
            <div class="cat-section" data-type="${type}">
                <div class="cat-section-title">${TYPE_LABEL[type]}</div>
                <div class="cat-list">${items}</div>
            </div>
        `;
    }

    function addRowHtml() {
        // Defaults to "expense" — still the most common type users add.
        return `
            <div class="cat-add">
                <input type="text" class="cat-name cat-add-name" placeholder="New category name"
                       maxlength="100" aria-label="New category name">
                ${typeSelectHtml('expense', 'data-add-type-select')}
                <button class="cat-add-btn">+ Add</button>
            </div>
        `;
    }

    function render(rootEl, rows) {
        const groups = groupByType(rows);
        const sections =
            sectionHtml('income',    groups.income)    +
            sectionHtml('expense',   groups.expense)   +
            sectionHtml('savings',   groups.savings)   +
            sectionHtml('investing', groups.investing);
        // The Categories page (data-add-top) leads with the add row, above the
        // grouped list; the Settings modal kept it at the bottom. CSS flips the
        // divider side to match (see categories.css).
        rootEl.innerHTML = rootEl.hasAttribute('data-add-top')
            ? addRowHtml() + sections
            : sections + addRowHtml();
    }

    // ── Event wiring ────────────────────────────────────────────────────────
    // Wired once on the editor root via delegation. The whole editor re-
    // renders after any mutating action, so per-row listeners would just
    // create churn.

    async function refresh(rootEl) {
        try {
            const rows = await apiList();
            render(rootEl, rows);
        } catch (err) {
            rootEl.innerHTML = `<div class="cat-error">${esc(err.message)}</div>`;
        }
    }

    function attach(rootEl) {
        // Click delegation: reorder arrows, delete X, add button.
        rootEl.addEventListener('click', async (e) => {
            const action = e.target.closest('[data-action]')?.dataset?.action;
            const addBtn = e.target.closest('.cat-add-btn');

            if (action === 'move' || action === 'delete') {
                const row = e.target.closest('.cat-row');
                const id  = row && parseInt(row.dataset.id, 10);
                if (!id) return;

                try {
                    if (action === 'move') {
                        const btn = e.target.closest('.cat-icon-btn');
                        if (btn.classList.contains('cat-disabled')) return;
                        await apiMove(id, btn.dataset.direction);
                    } else if (action === 'delete') {
                        const name = row.querySelector('.cat-name')?.value || 'this category';
                        if (!confirm(`Delete "${name}"?`)) return;
                        await apiDelete(id);
                    }
                    await refresh(rootEl);
                } catch (err) {
                    alert(err.message);
                }
                return;
            }

            // Add-row submit. Reads the input + dropdown values straight
            // from the DOM so the form has no separate state to track.
            if (addBtn) {
                const nameInput = rootEl.querySelector('.cat-add-name');
                const typeSel   = rootEl.querySelector('[data-add-type-select]');
                const name      = (nameInput?.value || '').trim();
                const cat_type  = typeSel?.value || 'expense';
                if (!name) return;
                try {
                    await apiCreate({ name, cat_type });
                    await refresh(rootEl);
                } catch (err) {
                    alert(err.message);
                }
            }
        });

        // Change delegation: the per-row type dropdown surfaces its value
        // through the standard `change` event.
        rootEl.addEventListener('change', async (e) => {
            const target = e.target;
            const action = target.dataset.action;
            const row    = target.closest('.cat-row');
            if (!row || !action) return;
            const id = parseInt(row.dataset.id, 10);
            if (!id) return;

            try {
                if (action === 'change-type') {
                    await apiUpdate(id, { cat_type: target.value });
                } else {
                    return;
                }
                await refresh(rootEl);
            } catch (err) {
                alert(err.message);
                await refresh(rootEl);
            }
        });

        // Rename on blur — commits whatever's in the input. Empty / unchanged
        // values are ignored. Failures revert to the row's previous value
        // by re-rendering from server state.
        rootEl.addEventListener('blur', async (e) => {
            const target = e.target;
            if (!target.matches('.cat-name[data-action="rename"]')) return;
            const row = target.closest('.cat-row');
            const id  = parseInt(row.dataset.id, 10);
            const newName = target.value.trim();
            if (!id || !newName) return;
            // Only fire when the name actually changed — `defaultValue` was
            // set by render() and reflects the last server-known value.
            if (newName === target.defaultValue) return;
            try {
                await apiUpdate(id, { name: newName });
                target.defaultValue = newName;
            } catch (err) {
                alert(err.message);
                await refresh(rootEl);
            }
        }, true);   // `true` = capture phase so blur bubbles to root
    }

    // ── Bootstrap ───────────────────────────────────────────────────────────
    // Wire every editor root on the page (the Categories page,
    // pages/categories.html). One refresh per root.

    function init() {
        document.querySelectorAll('[data-categories-editor]').forEach(root => {
            attach(root);
            refresh(root);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
