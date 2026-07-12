'use strict';

// ─── settingsCategories.js ──────────────────────────────────────────────────
// Categories editor for the Categories page (pages/categories.html).
//
// Layout: a search field above a stack of collapsible group cards — one per
// category type (Income · Expense · Savings · Investing). Each card header
// carries the type's colour dot, a count summary and a chevron; expanding it
// reveals the category rows and a quiet "Add category" row at the bottom.
// Typing in the search filters rows by name across every group: groups with no
// matches disappear, matching groups are forced open, and adding/dragging pause
// until the query is cleared (a filtered list has no meaningful insertion order).
//
// Rows keep the established interactions: inline rename (borderless input),
// an always-visible quiet delete ×, and the grip-handle drag-and-drop from the
// Cash Flow column manager (tables.js) — drag within a group to reorder (the
// order sets Cash Flow row order), drag into another open group to recategorize.
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
    // layout. Each group's list is a drop target; a row's group dictates its
    // type.

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

    const ICON_X       = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const ICON_PLUS    = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const ICON_SEARCH  = '<svg class="cat-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const ICON_CHEVRON = '<svg class="cat-group-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Default name for a freshly added category. The create endpoint rejects
    // duplicate names (409), so if "New Category" is already taken — e.g. the
    // user clicks Add twice before renaming — fall back to "New Category 2",
    // "New Category 3", … so the button always succeeds.
    const DEFAULT_NAME = 'New Category';
    function uniqueDefaultName(rows) {
        const names = new Set(rows.map(c => c.name));
        if (!names.has(DEFAULT_NAME)) return DEFAULT_NAME;
        let n = 2;
        while (names.has(`${DEFAULT_NAME} ${n}`)) n++;
        return `${DEFAULT_NAME} ${n}`;
    }

    function rowHtml(c) {
        // The two seeded "Uncategorized" buckets are read-only: their key is
        // hardcoded elsewhere (Cash Flow/Report Card/credit-card stats) to
        // bucket NULL-category transactions, so renaming/deleting them would
        // silently break those totals (backend enforces this too). Their name
        // is a static label — no input at all, so there's nothing to edit — but
        // they stay draggable so the user can still reorder them.
        if (c.locked) {
            return `
                <div class="cat-row cat-locked" data-id="${c.id}">
                    <span class="cat-grip" draggable="true" aria-label="Drag ${esc(c.name)} to reorder or recategorize">${ICON_GRIP}</span>
                    <span class="cat-name cat-name-static">${esc(c.name)}</span>
                </div>
            `;
        }
        return `
            <div class="cat-row" data-id="${c.id}">
                <span class="cat-grip" draggable="true" aria-label="Drag ${esc(c.name)} to reorder or recategorize">${ICON_GRIP}</span>
                <input type="text" class="cat-name" value="${esc(c.name)}" maxlength="100"
                       data-action="rename" aria-label="Category name">
                <button class="cat-icon-btn cat-delete" data-action="delete" title="Delete category" aria-label="Delete ${esc(c.name)}">${ICON_X}</button>
            </div>
        `;
    }

    function metaText(rows) {
        const n = rows.length;
        return `${n} ${n === 1 ? 'category' : 'categories'}`;
    }

    function groupHtml(type, rows, isOpen) {
        const items = rows.map(rowHtml).join('') ||
            '<div class="cat-empty" data-placeholder>No categories yet</div>';
        const bodyId = `cat-group-body-${type}`;
        return `
            <section class="cat-group" data-type="${type}">
                <button type="button" class="cat-group-head" data-action="toggle"
                        aria-expanded="${isOpen}" aria-controls="${bodyId}">
                    <span class="cat-group-dot" aria-hidden="true"></span>
                    <span class="cat-group-title">${TYPE_LABEL[type]}</span>
                    <span class="cat-group-meta">${metaText(rows)}</span>
                    ${ICON_CHEVRON}
                </button>
                <div class="cat-group-body" id="${bodyId}"${isOpen ? '' : ' hidden'}>
                    <div class="cat-list" data-type="${type}">${items}</div>
                    <button type="button" class="cat-add-row" data-type="${type}"
                            aria-label="Add ${TYPE_LABEL[type]} category">${ICON_PLUS} Add category</button>
                </div>
            </section>
        `;
    }

    // Last server state, kept so a drop can diff the new DOM order against it
    // and PUT only the rows whose position or type actually changed.
    const stateByRoot = new WeakMap();
    // Per-root view state — search query + which groups are expanded. Survives
    // re-renders (session-only, like the old active tab).
    const uiByRoot = new WeakMap();

    function ui(rootEl) {
        let u = uiByRoot.get(rootEl);
        if (!u) {
            u = { query: '', open: { income: false, expense: true, savings: false, investing: false } };
            uiByRoot.set(rootEl, u);
        }
        return u;
    }

    function render(rootEl, rows) {
        stateByRoot.set(rootEl, rows);
        const groups = groupByType(rows);
        const u = ui(rootEl);

        const sections = TYPE_ORDER.map(t => groupHtml(t, groups[t], u.open[t])).join('');

        rootEl.innerHTML =
            `<div class="cat-search">
                ${ICON_SEARCH}
                <input type="text" class="cat-search-input" placeholder="Search categories"
                       aria-label="Search categories" value="${esc(u.query)}">
            </div>
            <div class="cat-groups">${sections}</div>
            <p class="cat-no-match" hidden>No categories match your search.</p>`;

        applyFilter(rootEl);
    }

    // Re-evaluate the search query against the rendered rows. Pure view logic —
    // no server round-trip — so it runs on every keystroke and after every
    // re-render. A live query hides non-matching rows, drops groups with no
    // hits entirely, forces matching groups open, and pauses add/drag (both
    // depend on the full, unfiltered order being visible).
    function applyFilter(rootEl) {
        const u = ui(rootEl);
        const q = u.query.trim().toLowerCase();
        const searching = q.length > 0;
        rootEl.classList.toggle('cat-searching', searching);

        let anyVisible = false;
        rootEl.querySelectorAll('.cat-group').forEach(section => {
            const type = section.dataset.type;
            let matches = 0;
            section.querySelectorAll('.cat-row').forEach(row => {
                const name = (row.querySelector('.cat-name')?.value || '').toLowerCase();
                const hit = !searching || name.includes(q);
                row.hidden = !hit;
                if (hit) matches++;
            });

            section.hidden = searching && matches === 0;
            if (!section.hidden) anyVisible = true;

            const open = searching ? true : u.open[type];
            section.querySelector('.cat-group-head').setAttribute('aria-expanded', String(open));
            const body = section.querySelector('.cat-group-body');
            if (open) body.removeAttribute('hidden');
            else      body.setAttribute('hidden', '');

            const addBtn = section.querySelector('.cat-add-row');
            if (addBtn) addBtn.hidden = searching;
        });

        rootEl.querySelector('.cat-no-match').hidden = anyVisible;
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
        // ── Click: group toggle, flex-type segment, delete ×, add row ────────
        rootEl.addEventListener('click', async (e) => {
            const action = e.target.closest('[data-action]')?.dataset?.action;
            const addBtn = e.target.closest('.cat-add-row');

            // Group header — expand/collapse. A live search forces matching
            // groups open (applyFilter wins), so the stored preference only
            // takes effect once the query is cleared.
            if (action === 'toggle') {
                const section = e.target.closest('.cat-group');
                const type = section?.dataset?.type;
                if (!type) return;
                const u = ui(rootEl);
                u.open[type] = !u.open[type];
                applyFilter(rootEl);
                return;
            }

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

            // Quiet "Add category" row at the bottom of each open group. Only
            // rendered reachable while the group is expanded and no search is
            // active, so the fresh row is always visible for the rename focus.
            if (addBtn) {
                const type = addBtn.dataset.type;
                if (!type) return;
                const name = uniqueDefaultName(stateByRoot.get(rootEl) || []);
                try {
                    const created = await apiCreate({ name, cat_type: type });
                    await refresh(rootEl);
                    const input = created &&
                        rootEl.querySelector(`.cat-row[data-id="${created.id}"] .cat-name`);
                    if (input) { input.focus(); input.select(); }
                } catch (err) {
                    alert(err.message);
                }
            }
        });

        // ── Search — filter on every keystroke, no round-trip ────────────────
        rootEl.addEventListener('input', (e) => {
            if (!e.target.matches('.cat-search-input')) return;
            ui(rootEl).query = e.target.value;
            applyFilter(rootEl);
        });

        // ── Rename on Enter ─────────────────────────────────────────────────
        rootEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (!e.target.matches('.cat-name[data-action="rename"]')) return;
            e.target.blur();
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
                // Keep the snapshot's name in step (search + uniqueDefaultName
                // both read it).
                const snap = (stateByRoot.get(rootEl) || []).find(c => c.id === id);
                if (snap) snap.name = newName;
            } catch (err) {
                alert(err.message);
                await refresh(rootEl);
            }
        }, true);   // capture phase so blur reaches the root

        // ── Drag-and-drop reorder + recategorize ─────────────────────────────
        // The grip is the draggable element; the source row stays put (dimmed)
        // during the drag while an accent line marks the drop slot. On dragend
        // we land the row at the indicator, then read the final DOM order across
        // every group — a row's group dictates its new type — and PUT just the
        // rows whose position or type changed. Collapsed groups aren't drop
        // targets (their lists are hidden); expand a group to drag into it.
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
            // Walk the groups in DOM order (= TYPE_ORDER) and assign contiguous
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
            // A filtered list shows a partial order — reordering it would
            // commit positions the user can't see. Clear the search first.
            if (ui(rootEl).query.trim()) { e.preventDefault(); return; }
            draggingRow = grip.closest('.cat-row');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggingRow.dataset.id); // Firefox needs a payload
            e.dataTransfer.setDragImage(draggingRow, 12, 12);
            // Defer dimming + drag mode so the drag image isn't the faded row.
            // `dragging` on the editor hides empty-group placeholders (CSS) so
            // the accent line is the only placement cue.
            requestAnimationFrame(() => {
                draggingRow.classList.add('cat-dragging');
                rootEl.classList.add('dragging');
            });
        });

        rootEl.addEventListener('dragover', (e) => {
            if (!draggingRow) return;
            const list = e.target.closest?.('.cat-list');
            if (!list) return;
            // A locked row (the Uncategorized buckets) can be reordered but not
            // recategorized — its type is hardcoded — so it only drops within
            // its own group. Other groups aren't valid targets for it.
            if (draggingRow.classList.contains('cat-locked') &&
                list.dataset.type !== draggingRow.closest('.cat-list')?.dataset.type) {
                return;
            }
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
