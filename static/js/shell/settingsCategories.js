'use strict';

// ─── settingsCategories.js ──────────────────────────────────────────────────
// Categories editor for the Categories page (pages/categories.html).
//
// Layout: a "create" card pinned at the top, then a 2×2 grid of quadrants —
// one per category type (Income · Expense · Savings · Investing). Each quadrant
// lists its categories as clean, container-less lines.
//
// Reordering and recategorizing are both **drag-and-drop** — the same grip-
// handle interaction as the Cash Flow column manager (tables.js). Drag a
// category to a new spot within its box to reorder it; drag it into a different
// type box to recategorize it. The only per-row chrome left is the grip (always
// visible) and a delete × that fades in on hover, so a full screen of
// categories reads calmly. (Sync is configured per table on the Cash Flow page,
// not here.)
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
    // layout. Each box is a drop target; a row's box dictates its type.

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

    // Six-dot "grip" glyph for the drag handle — same shape as the column
    // manager's handle (tables.js _GRIP) so the affordance reads consistently
    // across the app.
    const ICON_GRIP = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
    const ICON_X    = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    function typeSelectHtml(currentType, idAttrs = '') {
        // Two-option <select> for the create card's "Add" form. Per-row type is
        // no longer a dropdown — it's the box the row lives in.
        const opt = (val) => {
            const sel = val === currentType ? 'selected' : '';
            return `<option value="${val}" ${sel}>${TYPE_LABEL[val]}</option>`;
        };
        return `<select class="cat-type-select" ${idAttrs}>
                    ${TYPE_ORDER.map(opt).join('')}
                </select>`;
    }

    function rowHtml(c) {
        // A clean, container-less line: [grip] [name] [delete]. Only the grip is
        // draggable, so the rename input keeps its pointer events. The delete ×
        // is revealed by CSS on row hover / focus-within so a full box stays
        // calm at rest; the grip stays faintly visible to advertise the drag.
        return `
            <div class="cat-row" data-id="${c.id}">
                <span class="cat-grip" draggable="true" aria-label="Drag ${esc(c.name)} to reorder or recategorize">${ICON_GRIP}</span>
                <input type="text" class="cat-name" value="${esc(c.name)}" maxlength="100"
                       data-action="rename" aria-label="Category name">
                <div class="cat-row-actions">
                    <button class="cat-icon-btn cat-delete" data-action="delete" title="Delete category" aria-label="Delete category">${ICON_X}</button>
                </div>
            </div>
        `;
    }

    function quadrantHtml(type, rows) {
        const items = rows.map(rowHtml).join('') ||
            '<div class="cat-empty" data-placeholder>No categories yet</div>';
        // Each type gets its own card and acts as a drop target (data-type on
        // the list). The title renders as a coloured pill (colour-on-tinted-box)
        // reusing the Transactions ledger type-pill look; the colour comes from
        // the [data-type] hook in categories.css.
        return `
            <section class="cat-quadrant" data-type="${type}">
                <header class="cat-quadrant-head">
                    <h2 class="cat-quadrant-title">${TYPE_LABEL[type]}</h2>
                    <span class="cat-quadrant-count">${rows.length}</span>
                </header>
                <div class="cat-list" data-type="${type}">${items}</div>
            </section>
        `;
    }

    function createCardHtml() {
        // The single primary action of the page. Defaults to "expense" — still
        // the most common type users add.
        return `
            <div class="cat-create-card">
                <div class="cat-create-title">Add a category</div>
                <div class="cat-add">
                    <input type="text" class="cat-add-name" placeholder="New category name"
                           maxlength="100" aria-label="New category name">
                    ${typeSelectHtml('expense', 'data-add-type-select')}
                    <button class="cat-add-btn">+ Add</button>
                </div>
            </div>
        `;
    }

    // Last server state, kept so a drop can diff the new DOM order against it
    // and PUT only the rows whose position or type actually changed.
    const stateByRoot = new WeakMap();

    function render(rootEl, rows) {
        stateByRoot.set(rootEl, rows);
        const groups = groupByType(rows);
        // Create card leads; the 2×2 type grid follows below it. The grid's DOM
        // order is TYPE_ORDER, which is also the global-position order we write
        // back on a drop.
        rootEl.innerHTML =
            createCardHtml() +
            `<div class="cat-grid">
                ${quadrantHtml('income',    groups.income)}
                ${quadrantHtml('expense',   groups.expense)}
                ${quadrantHtml('savings',   groups.savings)}
                ${quadrantHtml('investing', groups.investing)}
            </div>`;
    }

    // ── Event wiring ────────────────────────────────────────────────────────
    // Everything is delegated on the editor root so it survives the full
    // re-render after each mutating action — no per-row listeners to churn.

    async function refresh(rootEl) {
        try {
            const rows = await apiList();
            render(rootEl, rows);
        } catch (err) {
            rootEl.innerHTML = `<div class="cat-error">${esc(err.message)}</div>`;
        }
    }

    // Given a list and the pointer Y, return the row the dragged element should
    // be inserted BEFORE (or null to append). Standard native-DnD pattern,
    // mirroring tables.js _dragAfterRow.
    function dragAfterRow(listEl, y) {
        const rows = [...listEl.querySelectorAll('.cat-row:not(.cat-dragging)')];
        let closest = { offset: -Infinity, el: null };
        for (const row of rows) {
            const box = row.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) closest = { offset, el: row };
        }
        return closest.el;
    }

    function attach(rootEl) {
        // ── Click: delete X, add button ──────────────────────────────────────
        rootEl.addEventListener('click', async (e) => {
            const action = e.target.closest('[data-action]')?.dataset?.action;
            const addBtn = e.target.closest('.cat-add-btn');

            if (action === 'delete') {
                const row = e.target.closest('.cat-row');
                const id  = row && parseInt(row.dataset.id, 10);
                if (!id) return;
                const name = row.querySelector('.cat-name')?.value || 'this category';
                if (!confirm(`Delete "${name}"?`)) return;
                try {
                    await apiDelete(id);
                    await refresh(rootEl);
                } catch (err) {
                    alert(err.message);
                }
                return;
            }

            // Add-row submit. Reads the input + dropdown values straight from the
            // DOM so the form has no separate state to track.
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

        // ── Rename on blur ───────────────────────────────────────────────────
        // Commits whatever's in the input. Empty / unchanged values are ignored.
        // Failures revert by re-rendering from server state.
        rootEl.addEventListener('blur', async (e) => {
            const target = e.target;
            if (!target.matches('.cat-name[data-action="rename"]')) return;
            const row = target.closest('.cat-row');
            const id  = parseInt(row.dataset.id, 10);
            const newName = target.value.trim();
            if (!id || !newName) return;
            if (newName === target.defaultValue) return;   // unchanged
            try {
                await apiUpdate(id, { name: newName });
                target.defaultValue = newName;
            } catch (err) {
                alert(err.message);
                await refresh(rootEl);
            }
        }, true);   // capture phase so blur reaches the root

        // ── Drag-and-drop reorder + recategorize ─────────────────────────────
        // The grip is the draggable element; the source row stays put (dimmed)
        // during the drag while an accent line marks the drop slot. On dragend
        // we land the row at the indicator, then read the final DOM order across
        // every box — a row's box dictates its new type — and PUT just the rows
        // whose position or type changed.
        let draggingRow = null;
        let indicator   = null;

        const placeIndicator = (list, before) => {
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'cat-drop-indicator';
            }
            if (before) list.insertBefore(indicator, before);
            else list.appendChild(indicator);
        };

        const commitOrder = async () => {
            // Walk the boxes in DOM order (= TYPE_ORDER) and assign contiguous
            // global positions 0..N-1, matching the backend's position model.
            const desired = [];
            let pos = 0;
            rootEl.querySelectorAll('.cat-list').forEach(list => {
                const type = list.dataset.type;
                list.querySelectorAll('.cat-row').forEach(row => {
                    desired.push({ id: parseInt(row.dataset.id, 10), type, position: pos++ });
                });
            });

            const prev = new Map((stateByRoot.get(rootEl) || []).map(c => [c.id, c]));
            const changed = desired.filter(d => {
                const p = prev.get(d.id);
                return !p || p.position !== d.position || p.cat_type !== d.type;
            });
            if (!changed.length) return;   // dropped back home — no round-trip

            try {
                for (const d of changed) {
                    const patch = { position: d.position };
                    const p = prev.get(d.id);
                    if (p && p.cat_type !== d.type) patch.cat_type = d.type;
                    await apiUpdate(d.id, patch);
                }
            } catch (err) {
                alert(err.message);
            }
            await refresh(rootEl);
        };

        rootEl.addEventListener('dragstart', (e) => {
            const grip = e.target.closest?.('.cat-grip');
            if (!grip) return;
            draggingRow = grip.closest('.cat-row');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggingRow.dataset.id); // Firefox needs a payload
            e.dataTransfer.setDragImage(draggingRow, 12, 12);
            // Defer dimming + drag mode so the drag image isn't the faded row.
            // `dragging` on the editor hides empty-box placeholders (CSS) so the
            // accent line is the only placement cue.
            requestAnimationFrame(() => {
                draggingRow.classList.add('cat-dragging');
                rootEl.classList.add('dragging');
            });
        });

        rootEl.addEventListener('dragover', (e) => {
            if (!draggingRow) return;
            const list = e.target.closest?.('.cat-list');
            if (!list) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            placeIndicator(list, dragAfterRow(list, e.clientY));
        });

        rootEl.addEventListener('drop', (e) => {
            if (draggingRow) e.preventDefault();
        });

        rootEl.addEventListener('dragend', () => {
            if (!draggingRow) return;
            if (indicator?.parentElement) {
                indicator.parentElement.insertBefore(draggingRow, indicator);
            }
            indicator?.remove();
            indicator = null;
            draggingRow.classList.remove('cat-dragging');
            rootEl.classList.remove('dragging');
            draggingRow = null;
            commitOrder();
        });
    }

    // ── Bootstrap ───────────────────────────────────────────────────────────
    // Wire every editor root on the page. One refresh per root.

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
