'use strict';

// ============================================================================
// tables.js — Shared table behavior for aventurine spreadsheet pages.
// ============================================================================
//
// Loaded BEFORE every spreadsheet page's own JS. Provides two layers:
//
//   (1) Low-level helpers used by every spreadsheet-like page (Income &
//       Expenses, Balance Sheet, Savings & Investing, Portfolio):
//         - generic modal builders (confirmDelete, promptAddYear,
//           confirmColumnDelete)
//         - sortTables for DOM-level newest-first sort
//       (escapeHtml lives in core/escape.js; debounce + the plain-number
//       formatters applyCommaFormat/formatDisplay in core/format.js; the ⋮
//       dropdown is UI.openMenu in shell/ui.js)
//
//   (2) A full "year-table" controller used by the Statements page (Cash Flow
//       + Balance Sheet tabs). Each tab reduces to a single
//       bootstrapYearTablePage(opts) call with a config object describing its
//       API prefix, column types, and minor UI variations — the Statements
//       page runs two controllers side by side, scoped apart via the
//       *Selector options. See bootstrapYearTablePage() at the bottom for the
//       full option list.
//
// Portfolio uses layer (1) but has its own controller (portfolio.js) because
// it operates on accounts rather than calendar years and has no column manager.

// ─── Constants ──────────────────────────────────────────────────────────────

(function () {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // Six-dot "grip" glyph shown as the drag handle on each column-manager row.
    // The handle (not the whole row) is the draggable element, so the rename
    // input and the × delete button keep working without the drag interaction
    // stealing their pointer events.
    const _GRIP = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>`;

    /**
     * Given a drop-target list and the pointer's Y, return the row the dragged
     * element should be inserted BEFORE (or null to append at the end). Standard
     * native-DnD pattern: pick the not-being-dragged row whose vertical midpoint is
     * just below the cursor. Used to live-reorder the DOM during dragover.
     */
    function _dragAfterRow(listEl, y) {
        const rows = [...listEl.querySelectorAll('.cat-row:not(.cat-dragging)')];
        let closest = { offset: -Infinity, el: null };
        for (const row of rows) {
            const box = row.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) closest = { offset, el: row };
        }
        return closest.el;
    }

    // escapeHtml is a global from escape.js (loaded by base.html before this
    // file). ALL column labels, year strings, account names, and other user-
    // controlled values MUST pass through it when building HTML via template
    // literals.

    // ─── UI helpers ─────────────────────────────────────────────────────────────
    // (debounce + the plain-number input formatters moved to core/format.js.)

    /**
     * Announce a write that didn't reach the database. A silently dropped save
     * is data loss — the user saw their value on screen but it was never stored
     * — so every failed year-table write funnels here (wrapWrite below, plus the
     * column-delete flow that inspects its own result).
     */
    function reportSaveFailure() {
        window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
    }

    /**
     * Modal dialog confirming a destructive delete of a year table. `year` is a
     * parsed integer (safe to interpolate without escaping); no user-controlled
     * text is injected here, so this stays simple.
     */
    function confirmDelete(year, onConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p>Remove <strong>${year}</strong> and all its data?<br>This cannot be undone.</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-delete">Remove</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.dialog-close-btn').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.confirm-delete').addEventListener('click', () => {
            overlay.remove();
            onConfirm();
        });
    }

    /**
     * Modal prompt for a year. Validates client-side (4-digit number in
     * [1000, 9999], not already present in `existingYears`). The backend
     * re-validates with _validate_year so a tampered request still gets rejected.
     *
     * `opts` customizes the copy for reuse beyond "add": { message?, confirmLabel? }.
     * `message` is trusted HTML — pass literals only, never user input.
     */
    function promptAddYear(existingYears, onConfirm, opts = {}) {
        const message      = opts.message || 'Enter a <strong>4-digit year</strong> to add:';
        const confirmLabel = opts.confirmLabel || 'Add';
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p>${message}</p>
            <input type="number" class="year-prompt-input" min="1000" max="9999" placeholder="e.g. 2024">
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-add">${escapeHtml(confirmLabel)}</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        const input     = overlay.querySelector('.year-prompt-input');
        const addBtn    = overlay.querySelector('.confirm-add');
        const cancelBtn = overlay.querySelector('.confirm-cancel');
        overlay.querySelector('.dialog-close-btn').addEventListener('click', () => overlay.remove());
        input.focus();

        const tryAdd = () => {
            const year = parseInt(input.value);
            if (isNaN(year) || year < 1000 || year > 9999 || existingYears.includes(year)) {
                input.classList.add('invalid');
                return;
            }
            overlay.remove();
            onConfirm(year);
        };

        input.addEventListener('input', () => {
            // Some browsers ignore maxlength on type="number". Enforce 4-digit cap.
            if (input.value.length > 4) input.value = input.value.slice(0, 4);
            input.classList.remove('invalid');
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') tryAdd();
            if (e.key === 'Escape') overlay.remove();
        });
        cancelBtn.addEventListener('click', () => overlay.remove());
        addBtn.addEventListener('click', tryAdd);
    }

    /**
     * Secondary confirmation shown when the user tries to delete a column that
     * still has saved data. Stacks ABOVE the column manager modal (z-index 1100
     * vs the manager's 1000). `label` is user-controlled so it is escapeHtml'd.
     */
    function confirmColumnDelete(label, onConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.style.zIndex = '1100';
        overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p><strong>${escapeHtml(label)}</strong> has saved data.<br>Deleting it will permanently erase all values for this column. This cannot be undone.</p>
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-delete">Delete Anyway</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.dialog-close-btn').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.confirm-delete').addEventListener('click', () => {
            overlay.remove();
            onConfirm();
        });
    }

    /**
     * Reorder year-tables newest-first in the DOM without re-rendering. Used
     * after adding a new year so it slots into the correct visual position
     * without paying the cost of rebuilding every other table.
     */
    function sortTables(container) {
        const tables = Array.from(container.querySelectorAll('.db-outer[data-year]'));
        tables.sort((a, b) => parseInt(b.dataset.year) - parseInt(a.dataset.year));
        tables.forEach(t => container.appendChild(t));
    }

    // ============================================================================
    // Year-table controller — shared by the Statements tabs (Cash Flow, Balance
    // Sheet)
    // ============================================================================
    //
    // Each year-table config calls bootstrapYearTablePage(opts) once at the top
    // of the page's script (statements.js). Everything below this point implements that
    // controller and is parameterized by a `ctx` object passed around between
    // functions. `ctx` holds:
    //
    //   Immutable config (set once in bootstrap):
    //     api                 → object from makeYearTableApi(apiPrefix)
    //     types               → null OR [{key, label}, ...] of column types
    //     typeSectionSuffix   → string appended to type labels in section headers
    //     includeTotals       → bool — render a totals tfoot?
    //     itemNoun            → what one column is called in the Manage Columns
    //                           modal's copy ('column' | 'account')
    //
    //   Mutable state (rewritten by reloadYearTables):
    //     columns             → [{key, label, type?}, ...]
    //     years               → [int, ...]
    //     entries             → { [yearStr]: { [month]: { [colKey]: number }}}
    //     container           → the .db-tables-container DOM element

    // ─── API helpers factory ────────────────────────────────────────────────────

    /**
     * Build a thin object wrapping every year-table API call. `prefix` is the
     * mount point on the backend (e.g. '/api', '/api/balance').
     * Call sites stay try/catch-free: every write settles through wrapWrite,
     * which surfaces failures as an error toast (a silently dropped save is
     * data loss — the user saw their number in the cell but the DB never got
     * it) and resolves to { ok: false } instead of rejecting, so awaiting
     * callers can keep checking `.ok` without exception handling.
     *
     * The shapes mirror the backend endpoints (electron/backend/routes.js) exactly.
     */
    // Map each API prefix to its Store dataset name. Writes through the API
    // invalidate the matching cached dataset so that aggregator pages (Home,
    // Insights, Yearly Review) never read stale data after the user edits a
    // tracker. Tracker pages themselves don't read through the Store yet — a
    // background revalidation arriving mid-edit would clobber focus/scroll.
    const _STORE_NAME_BY_PREFIX = {
        '/api':         'ie',
        '/api/balance': 'balance',
    };

    function makeYearTableApi(prefix) {
        const jsonHeaders = { 'Content-Type': 'application/json' };
        const storeName   = _STORE_NAME_BY_PREFIX[prefix];
        const invalidate  = () => {
            if (storeName && window.Store) window.Store.invalidate(storeName);
        };
        const sendJson = (url, method, body, extra = {}) =>
            apiFetch(url, { method, headers: jsonHeaders, body: JSON.stringify(body), ...extra });
        // Wrap a write so (a) the Store cache for this feature is dropped once
        // the request settles and (b) a failure surfaces a toast instead of
        // vanishing. Failure is either a rejected fetch (backend unreachable) or
        // an ok:false result — both the raw response-likes (upsertEntry et al.)
        // and the .json()-ed bodies (column ops) carry `ok`. A rejection resolves
        // to { ok: false } so callers need no try/catch (see the doc above).
        // `report: false` is for writes whose caller presents the failure itself
        // (deleteColumn's expected 'has_data' refusal → confirmColumnDelete).
        const wrapWrite = (promise, { report = true } = {}) => promise
            .then(
                (res) => {
                    if (report && res && res.ok === false) reportSaveFailure();
                    return res;
                },
                (err) => {
                    if (report) reportSaveFailure();
                    return { ok: false, error: String(err?.message || err) };
                },
            )
            .finally(invalidate);
        // `keepalive: true` lets a cell save survive the page navigation that
        // would otherwise abort an in-flight fetch — critical for flushing
        // pending writes from a pagehide handler. ~64KB body cap doesn't matter
        // for our few-byte JSON payloads.
        const KEEPALIVE = { keepalive: true };

        return {
            get:           ()                        => apiFetch(`${prefix}/data`).then(r => r.json()),
            upsertEntry:   (year, month, cat, value) => wrapWrite(sendJson(`${prefix}/entry`,  'POST',   { year, month, category: cat, value }, KEEPALIVE)),
            deleteEntry:   (year, month, cat)        => wrapWrite(sendJson(`${prefix}/entry`,  'DELETE', { year, month, category: cat },         KEEPALIVE)),
            addYear:       (year)                    => wrapWrite(sendJson(`${prefix}/year`,   'POST',   { year })),
            deleteYear:    (year)                    => wrapWrite(apiFetch(`${prefix}/year/${year}`, { method: 'DELETE' })),
            duplicateYear: (src, tgt)                => wrapWrite(sendJson(`${prefix}/year/${src}/duplicate`, 'POST', { target_year: tgt })),
            addColumn:     (body)                    => wrapWrite(sendJson(`${prefix}/columns`, 'POST', body).then(r => r.json())),
            updateColumn:  (key, updates)            => wrapWrite(sendJson(`${prefix}/columns/${key}`, 'PUT', updates).then(r => r.json())),
            moveColumn:    (key, direction)          => wrapWrite(sendJson(`${prefix}/columns/${key}/move`, 'POST', { direction }).then(r => r.json())),
            reorderColumns:(order)                    => wrapWrite(sendJson(`${prefix}/columns/reorder`, 'POST', { order }).then(r => r.json())),
            deleteColumn:  (key, force = false) => {
                const url = force ? `${prefix}/columns/${key}?force=true` : `${prefix}/columns/${key}`;
                // report:false — the caller inspects the body: a 'has_data'
                // refusal is the normal path into confirmColumnDelete, not a
                // failure to announce.
                return wrapWrite(apiFetch(url, { method: 'DELETE' }).then(r => r.json()), { report: false });
            },
        };
    }

    // ─── Render / reload ────────────────────────────────────────────────────────

    /**
     * Rebuild every year-table from scratch from ctx.years/ctx.entries/ctx.columns.
     * Tables render newest-first; which year is visible is decided by the page
     * (the Statements year stepper toggles [hidden] on the .db-outer cards).
     */
    function renderYearTables(ctx) {
        // Commit any edits still inside their debounce window BEFORE tearing the
        // inputs down. fire() writes through to ctx.entries synchronously (see
        // fireSaveFor), so the rebuild below picks the values up even when the
        // API call is still in flight.
        flushAllPendingCellSaves();
        ctx.container.innerHTML = '';
        [...ctx.years].sort((a, b) => b - a).forEach(year => {
            const outerEl = createYearTable(year, ctx);
            ctx.container.appendChild(outerEl);
            initYearTable(outerEl, ctx.entries[String(year)] || {}, ctx);
        });
    }

    /**
     * Pull fresh data from the API, write it into ctx, and re-render. Called
     * after any change that touches multiple tables at once — column add/edit/
     * delete/reorder/type-change, year duplicate, etc.
     */
    async function reloadYearTables(ctx) {
        const data    = await ctx.api.get();
        ctx.columns   = data.columns;
        ctx.years     = data.years;
        ctx.entries   = data.entries;
        // Provenance layers — only the Cash Flow page ships them. `computed` is
        // the per-cell transaction sums, `manual` the stored per-cell overrides;
        // entries is the blend (manual ?? computed). Pages without the layers
        // (Balance Sheet) render every cell as a plain hand-entered value.
        ctx.computed  = data.computed || null;
        ctx.manual    = data.manual   || null;
        renderYearTables(ctx);
    }

    // ─── Table builder ──────────────────────────────────────────────────────────

    /**
     * Build the DOM for one year's table:
     *   - thead:        column labels (Month | col1 | col2 | …)
     *   - tbody:        twelve month rows of editable currency inputs
     *   - tfoot:        optional totals row (when ctx.includeTotals is true)
     *
     * No per-table chrome: the year caption and the ⋮ menu live on the Statements
     * sheet (statements.js), which shows one year at a time and acts on the year
     * across BOTH datasets. The card's visual top is the page's tab bar, styled
     * to join the .db-wrapper below it (see statements.css).
     *
     * Uses createElement + textContent rather than innerHTML for any
     * user-controlled label (column names, year), avoiding any HTML-injection
     * risk without needing escapeHtml.
     */
    function createYearTable(year, ctx) {
        const outer = document.createElement('div');
        outer.className = 'db-outer';
        outer.dataset.year = year;

        const wrapper = document.createElement('div');
        wrapper.className = 'db-wrapper';

        const table = document.createElement('table');
        table.className = 'db-table';

        // ── thead: column headers ───────────────────────────────────────────────
        const thead = document.createElement('thead');
        // Cell provenance (computed vs hand-entered) is per cell and signalled by
        // the value's own styling, so headers carry no affordance for it.
        const headerRow = document.createElement('tr');
        headerRow.className = 'db-header-row';
        const monthTh = document.createElement('th');
        monthTh.className = 'col-month';
        monthTh.textContent = 'Month';
        headerRow.appendChild(monthTh);
        ctx.columns.forEach(col => {
            const th = document.createElement('th');
            th.textContent = col.label;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // ── tbody: one row per month, one cell per column ──────────────────────
        const tbody = document.createElement('tbody');
        MONTHS.forEach(month => {
            const tr = document.createElement('tr');
            const monthTd = document.createElement('td');
            monthTd.className = 'month-label';
            monthTd.textContent = month;
            tr.appendChild(monthTd);
            ctx.columns.forEach(col => {
                tr.appendChild(_buildDataCell(month, col));
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        // ── tfoot: optional totals row (only when includeTotals is true) ───────
        if (ctx.includeTotals) {
            const tfoot = document.createElement('tfoot');
            const totalRow = document.createElement('tr');
            totalRow.className = 'total-row';
            // First cell is a "Total" label, styled like the month labels above
            // so it visually anchors the same column.
            const totalLabelTd = document.createElement('td');
            totalLabelTd.className = 'month-label';
            totalLabelTd.textContent = 'Total';
            totalRow.appendChild(totalLabelTd);
            ctx.columns.forEach(col => {
                totalRow.appendChild(_buildTotalCell(col));
            });
            tfoot.appendChild(totalRow);
            table.appendChild(tfoot);
        }

        wrapper.appendChild(table);
        outer.appendChild(wrapper);
        return outer;
    }

    /**
     * Build one body cell: an editable <input>. The input carries the currency
     * symbol as a prefix once content is present (e.g. "$1,234"); see
     * currency.js for the editing model. On the Cash Flow page a cell whose
     * value is computed from transactions gets the .cell-computed treatment
     * (accent-info italics) from applyCellPresentation — an empty cell is
     * simply blank, so the accent colour is the only signal that a computation
     * is present.
     */
    function _buildDataCell(month, col) {
        const td = document.createElement('td');
        td.className = 'data-cell';

        const input = document.createElement('input');
        input.type          = 'text';        // not number, so symbol + commas can show
        input.inputMode     = 'decimal';     // numeric keypad on mobile
        input.className     = 'db-input';
        input.dataset.month = month;
        input.dataset.col   = col.key;
        td.appendChild(input);
        return td;
    }

    /**
     * Build one read-only total cell (used when includeTotals is true). The
     * span starts blank and updateYearTotals() rewrites it to "$<sum>" (with
     * the user's chosen symbol baked in via formatCurrency) once the column
     * has a value.
     */
    function _buildTotalCell(col) {
        const td = document.createElement('td');
        td.className = 'data-cell';
        td.dataset.totalCol = col.key;
        const valSpan = document.createElement('span');
        valSpan.className = 'total-value';
        td.appendChild(valSpan);
        return td;
    }

    // ─── Cell-save scheduler ────────────────────────────────────────────────────
    // One debounce timer per input. A previous version shared one timer across
    // every input in a table, which meant typing in cell B would CANCEL cell A's
    // pending save — rapid bulk edits silently lost all but the last keystroke.
    //
    // The map is module-level (shared by every table on the page) so ONE
    // pagehide listener flushes everything; registering a listener inside
    // initYearTable leaked a new window listener on every re-render.

    const SAVE_DEBOUNCE_MS = 600;
    const _pendingCellSaves = new Map();   // input -> { timer, fire }

    function flushAllPendingCellSaves() {
        for (const { timer, fire } of _pendingCellSaves.values()) {
            clearTimeout(timer);
            fire();
        }
        _pendingCellSaves.clear();
    }

    // The save fetches carry `keepalive: true` (see makeYearTableApi) so the
    // browser holds them open long enough to reach the server even as the
    // page unloads.
    window.addEventListener('pagehide', flushAllPendingCellSaves);

    // ─── Cell provenance presentation (Cash Flow) ───────────────────────────────
    // On pages that ship the provenance layers (ctx.computed / ctx.manual), a
    // cell is in one of two states:
    //   computed — no stored entry: the value is the month's transaction sum,
    //              rendered in accent-info italics (.cell-computed). An empty
    //              computed cell is simply blank — the accent colour is the
    //              ONLY signal that a computation is present.
    //   yours    — a stored entry overrides the cell: plain text like any other
    //              input. When a computed value exists underneath, the cell
    //              also grows a hover-revealed ↺ button that clears the entry.
    // Tooltips carry the education (including the shadowed computed value), so
    // the resting grid gains no extra chrome.

    const cellLayerValue = (layer, year, month, col) =>
        layer?.[String(year)]?.[month]?.[col];

    // Shown once ever, the first time the user overrides a computed cell —
    // teaches both halves of the model at the exact moment it changes.
    const OVERRIDE_HINT_KEY = 'cf-override-hint-shown';
    function maybeShowOverrideHint(ctx, year, month, col) {
        if (cellLayerValue(ctx.computed, year, month, col) === undefined) return;
        if (localStorage.getItem(OVERRIDE_HINT_KEY)) return;
        localStorage.setItem(OVERRIDE_HINT_KEY, '1');
        UI.toast(
            'This cell now holds your value and won’t update from transactions. '
            + 'Clear it anytime to return to the computed figure.',
            { type: 'info', duration: 8000 }
        );
    }

    /**
     * Sync one cell's value, styling, tooltip, and revert affordance to the
     * provenance layers. No-op on pages without them. `flash` replays the
     * fade-in on a value returning to its computed state (tables.css §computed);
     * `onRevert` wires the ↺ button through the same save path as typing.
     */
    function applyCellPresentation(input, year, month, col, ctx, { flash = false, onRevert } = {}) {
        if (!ctx.computed) return;
        const td       = input.closest('td');
        const manual   = cellLayerValue(ctx.manual, year, month, col);
        const computed = cellLayerValue(ctx.computed, year, month, col);
        let revertBtn  = td.querySelector('.cell-revert');

        input.classList.remove('cell-flash');

        if (manual !== undefined) {
            // Overridden: the user's value, plain chrome.
            input.value = formatCurrency(manual, false, { editable: true });
            input.classList.remove('cell-computed');
            if (computed !== undefined) {
                input.title = 'Entered by hand — clear the cell to return to the '
                    + `computed value (${formatCurrency(computed)})`;
                if (!revertBtn && onRevert) {
                    revertBtn = document.createElement('button');
                    revertBtn.type = 'button';
                    revertBtn.className = 'cell-revert';
                    revertBtn.textContent = '↺';
                    revertBtn.title = `Restore the computed value (${formatCurrency(computed)})`;
                    revertBtn.setAttribute('aria-label', 'Restore the computed value');
                    revertBtn.addEventListener('click', () => onRevert(input, month, col));
                    td.appendChild(revertBtn);
                } else if (revertBtn) {
                    revertBtn.title = `Restore the computed value (${formatCurrency(computed)})`;
                }
            } else {
                input.title = '';
                revertBtn?.remove();
            }
            return;
        }

        revertBtn?.remove();
        if (computed !== undefined) {
            input.value = formatCurrency(computed, false, { editable: true });
            input.classList.add('cell-computed');
            input.title = 'Computed from your transactions — type to set your own value';
            if (flash) {
                // Force a reflow so re-adding the class replays the animation.
                void input.offsetWidth;
                input.classList.add('cell-flash');
            }
        } else {
            input.value = '';
            input.classList.remove('cell-computed');
            input.title = '';
        }
    }

    // ─── Table init: populate cells + wire input events ─────────────────────────

    /**
     * Populate the inputs for one already-built year table and attach all event
     * handlers:
     *   - input:    live comma formatting + debounced save + (if includeTotals) totals refresh
     *   - keydown:  spreadsheet-style arrow-key navigation (Enter == ArrowDown)
     *
     * Multi-cell selection (drag / Shift+arrow → copy / paste / delete) is layered
     * on by cellselect.js once the table is built — see the enableCellSelection
     * call below.
     *
     * Saves are debounced so we don't fire one API call per keystroke. Deletes
     * are issued when a value is cleared so blank cells aren't persisted as 0.
     */
    function initYearTable(outerEl, yearEntries, ctx) {
        const table       = outerEl.querySelector('.db-table');
        const currentYear = parseInt(outerEl.dataset.year);

        // Saves are debounced per input via the module-level _pendingCellSaves
        // map (see "Cell-save scheduler" above) — one API call per
        // SAVE_DEBOUNCE_MS of typing instead of one per keystroke. The map
        // doubles as the registry that blur and pagehide flush against, so
        // moving focus or navigating away never drops an in-progress edit.

        // Re-apply a cell's provenance presentation (value/styling/tooltip/↺).
        // No-op on pages without the layers. Defined up front so fireSaveFor
        // and the revert button share it.
        const present = (input, month, col, opts = {}) =>
            applyCellPresentation(input, currentYear, month, col, ctx, { onRevert, ...opts });

        const fireSaveFor = (input, month, col) => {
            _pendingCellSaves.delete(input);
            const val = parseFloat(stripCurrencyValue(input.value));
            // Write through to ctx.entries (and the manual layer, where the page
            // has one) so the in-memory model always matches the cells.
            // renderYearTables rebuilds the DOM from ctx.entries, so without
            // this a local re-render (e.g. after a column rename) blanks every
            // value entered since the last full reload.
            const yearStr = String(currentYear);
            const months = ctx.entries[yearStr] ??= {};
            const computed = cellLayerValue(ctx.computed, currentYear, month, col);
            if (input.value === '' || isNaN(val)) {
                // Clearing a cell deletes the entry. On provenance pages that
                // RELEASES the cell back to its computed value (blank when the
                // month has no matching transactions) — a blank is never a
                // meaningful override; to force zero, type 0.
                if (ctx.manual?.[yearStr]?.[month]) delete ctx.manual[yearStr][month][col];
                if (computed !== undefined) (months[month] ??= {})[col] = computed;
                else if (months[month]) delete months[month][col];
                ctx.api.deleteEntry(currentYear, month, col);
            } else {
                (months[month] ??= {})[col] = val;
                if (ctx.computed) {
                    (((ctx.manual ??= {})[yearStr] ??= {})[month] ??= {})[col] = val;
                    maybeShowOverrideHint(ctx, currentYear, month, col);
                }
                ctx.api.upsertEntry(currentYear, month, col, val);
            }
            // Re-present unless the user is mid-edit in this cell (blur presents
            // then; this covers cellselect's synthetic edits, the ↺ button, and
            // debounced saves that land after focus moved on). Totals follow so
            // a restored computed value is counted again.
            if (document.activeElement !== input) {
                present(input, month, col, { flash: input.value === '' && computed !== undefined });
                if (ctx.includeTotals) updateYearTotals(outerEl, ctx);
            }
        };

        // ↺ on an overridden cell: clear the entry through the same save path
        // as typing, so ctx write-through, totals, and presentation all follow.
        const onRevert = (input, month, col) => {
            const pending = _pendingCellSaves.get(input);
            if (pending) { clearTimeout(pending.timer); _pendingCellSaves.delete(input); }
            input.value = '';
            fireSaveFor(input, month, col);
        };

        const scheduleSave = (input, month, col) => {
            const existing = _pendingCellSaves.get(input);
            if (existing) clearTimeout(existing.timer);
            const fire = () => fireSaveFor(input, month, col);
            _pendingCellSaves.set(input, {
                timer: setTimeout(fire, SAVE_DEBOUNCE_MS),
                fire,
            });
        };

        const flushSave = (input) => {
            const pending = _pendingCellSaves.get(input);
            if (!pending) return;
            clearTimeout(pending.timer);
            pending.fire();
        };

        outerEl.querySelectorAll('input[data-month][data-col]').forEach(input => {
            const month = input.dataset.month;
            const col   = input.dataset.col;
            // Pre-fill with the symbol-prefixed display value so the cell
            // matches what the user would see after typing. {editable} keeps the
            // cents even when "hide cents" is on — they'd otherwise be truncated
            // on the next save. Provenance pages route through present(), which
            // also applies the computed styling/tooltips/↺.
            if (ctx.computed) {
                present(input, month, col);
            } else {
                const saved = yearEntries?.[month]?.[col];
                if (saved !== undefined) input.value = formatCurrency(saved, false, { editable: true });
            }

            input.addEventListener('input', () => {
                // The user is typing: whatever the cell held, it now reads as
                // theirs — the computed styling drops immediately, the save
                // (debounced below) records the override.
                input.classList.remove('cell-computed', 'cell-flash');
                input.title = '';
                applyCurrencyFormat(input);
                scheduleSave(input, month, col);
                if (ctx.includeTotals) updateYearTotals(outerEl, ctx);
            });

            // Leaving the cell commits any pending edit immediately. Users expect
            // tab/click-away to mean "I'm done with this cell" — waiting out a
            // debounce window first feels like the app is hesitating. The flush's
            // fireSaveFor re-presents the cell (focus has already moved on); when
            // nothing was pending (no edit, or the debounce already fired while
            // the cell was still focused) present here instead, so a cleared cell
            // fades its computed value back in on the way out.
            input.addEventListener('blur', () => {
                if (_pendingCellSaves.has(input)) {
                    flushSave(input);
                } else {
                    present(input, month, col, {
                        flash: input.value === ''
                            && cellLayerValue(ctx.computed, currentYear, month, col) !== undefined,
                    });
                    if (ctx.includeTotals) updateYearTotals(outerEl, ctx);
                }
            });

            // ── Spreadsheet-style arrow-key navigation ─────────────────────────
            // Stops at the table edges (does not wrap). Enter is treated as
            // ArrowDown so quick numeric entry moves down a column without
            // needing the arrow keys.
            input.addEventListener('keydown', e => {
                const monthIdx = MONTHS.indexOf(month);
                const colIdx   = ctx.columns.findIndex(c => c.key === col);
                let targetMonth, targetCol;
                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                    targetMonth = MONTHS[monthIdx + 1];
                    targetCol   = col;
                } else if (e.key === 'ArrowUp') {
                    targetMonth = MONTHS[monthIdx - 1];
                    targetCol   = col;
                } else if (e.key === 'ArrowRight') {
                    targetMonth = month;
                    targetCol   = ctx.columns[colIdx + 1]?.key;
                } else if (e.key === 'ArrowLeft') {
                    targetMonth = month;
                    targetCol   = ctx.columns[colIdx - 1]?.key;
                } else {
                    return;
                }
                if (!targetMonth || !targetCol) return;
                const next = outerEl.querySelector(`input[data-month="${targetMonth}"][data-col="${targetCol}"]`);
                if (!next) return;
                e.preventDefault();
                next.focus();
                next.select();
            });
        });

        // ── Spreadsheet-style multi-cell selection (drag / Shift+arrow → copy,
        //    paste, delete). Owned by cellselect.js, which writes cells by
        //    dispatching synthetic `input` events that re-run the per-input save
        //    handlers wired just above — so paste/delete persist through the same
        //    path as typing. Guarded so Credit Cards (loads tables.js but never
        //    builds a year table, and doesn't ship cellselect.js) is unaffected.
        if (window.enableCellSelection) {
            enableCellSelection(table, { cellSelector: 'td.data-cell' });
        }

        if (ctx.includeTotals) updateYearTotals(outerEl, ctx);
    }

    /**
     * Recompute the per-column totals shown in the table footer. Called after
     * any cell edit, paste, or column add. Empty columns render blank so the
     * cell isn't a confusing "$0".
     *
     * The cell holds just a .total-value span; formatCurrency() handles the
     * symbol prefix (with the user's chosen currency) and comma formatting.
     */
    function updateYearTotals(outerEl, ctx) {
        ctx.columns.forEach(col => {
            let sum = 0, hasValue = false;
            outerEl.querySelectorAll(`input[data-col="${col.key}"]`).forEach(el => {
                const val = parseFloat(stripCurrencyValue(el.value));
                if (!isNaN(val)) { sum += val; hasValue = true; }
            });

            const cell    = outerEl.querySelector(`[data-total-col="${col.key}"]`);
            if (!cell) return;
            const valSpan = cell.querySelector('.total-value');
            valSpan.textContent = hasValue ? formatCurrency(sum) : '';
        });
    }

    // ─── Column Manager modal ───────────────────────────────────────────────────

    // Icons for the manager's search / cards / rows — same glyphs as the
    // categories editor (settingsCategories.js) so the two Statements managers
    // read identically.
    const _ICON_X       = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const _ICON_PLUS    = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const _ICON_SEARCH  = '<svg class="cat-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const _ICON_CHEVRON = '<svg class="cat-group-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    /**
     * Open (or close, if already open) the "Manage Columns" modal — the Balance
     * Sheet's column editor. It deliberately wears the SAME design as the Cash
     * Flow tab's "Manage Categories" modal: the shell and every control reuse
     * the .cat-* styles (categories.css + the shared modal primitives in
     * style.css §7), so the two Statements managers look identical and the
     * modal styles live in one place. Only the data layer differs — rows here
     * are ctx.columns, driven through the /columns endpoints.
     *
     * Layout: a search field above one collapsible card per column type
     * ("Cash Accounts" … "Debt Accounts"). The cards are an accordion — all
     * collapsed on open, expanding one collapses the rest; during a drag a
     * collapsed card springs open so cross-type moves keep a drop target.
     * Rows keep the established interactions: borderless inline rename, an
     * always-visible quiet delete ×, and grip-handle drag-and-drop to reorder
     * (or retype, by dropping into another card). A quiet "Add …" row closes
     * each open card: it creates the column immediately with a placeholder
     * name — the card fixes the type — and focuses the rename input, so there
     * is no separate name/type form.
     *
     * The whole modal is rebuilt from scratch (`buildManager()`) after every
     * data change — adds, deletes, reorderings — so we don't have to surgically
     * update individual rows after each backend call. This costs us very little
     * (the modal is small and rare to interact with) and eliminates a lot of
     * bookkeeping bugs. Renames skip the rebuild: nothing else in the modal
     * shows the label, so the input the user just typed in is already correct.
     *
     * SECURITY: every user-controlled value (col.key, col.label, type labels)
     * is escapeHtml'd before being interpolated into the innerHTML template.
     */
    function showColumnManager(ctx) {
        const existing = document.querySelector('.col-manager-overlay');
        if (existing) { existing.remove(); return; }

        // What one column is called in the modal's copy — "column" for a
        // generic dataset; the Balance Sheet passes "account" (opts.itemNoun)
        // so every string here talks about accounts.
        const noun    = ctx.itemNoun;
        const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);

        const tip = `${nounCap}s are the columns of this statement, grouped by `
            + 'type. Drag one by its handle to reorder it — the order here sets '
            + 'the column order — or drop it under another type to move it.'
            + '\n\nDeleting one that still holds saved values asks for '
            + 'confirmation first.';

        const overlay = document.createElement('div');
        // .cat-manager-overlay carries the shared visual treatment;
        // .col-manager-overlay is purely the query hook for the open/close
        // toggle above (and keeps this overlay distinct from the categories
        // editor's own, which statements.js queries the same way).
        overlay.className = 'confirm-overlay cat-manager-overlay col-manager-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        // View state for this open of the modal: the search query plus which
        // type card is expanded (accordion — at most one true at a time). Both
        // survive the full rebuilds below.
        const openState = {};
        (ctx.types || []).forEach(t => { openState[t.key] = false; });
        let query = '';
        let root  = null;   // the .cat-editor element, recreated by buildManager

        const metaText = (n) => `${n} ${n === 1 ? noun : `${noun}s`}`;

        // Placeholder name for a freshly added column, uniquified so clicking
        // "Add" twice before renaming still reads unambiguously.
        const uniqueDefaultLabel = () => {
            const base   = `New ${nounCap}`;
            const labels = new Set(ctx.columns.map(c => c.label));
            if (!labels.has(base)) return base;
            let n = 2;
            while (labels.has(`${base} ${n}`)) n++;
            return `${base} ${n}`;
        };

        // Re-evaluate the search query against the rendered rows. Pure view
        // logic — no server round-trip — so it runs on every keystroke and at
        // the end of every rebuild. A live query hides non-matching rows, drops
        // cards with no hits entirely, forces matching cards open, and pauses
        // add/drag (both depend on the full, unfiltered order being visible).
        const applyFilter = () => {
            const q = query.trim().toLowerCase();
            const searching = q.length > 0;
            root.classList.toggle('cat-searching', searching);

            let anyVisible = false;
            root.querySelectorAll('.cat-group').forEach(section => {
                let matches = 0;
                section.querySelectorAll('.cat-row').forEach(row => {
                    const name = (row.querySelector('.cat-name')?.value || '').toLowerCase();
                    const hit = !searching || name.includes(q);
                    row.hidden = !hit;
                    if (hit) matches++;
                });

                section.hidden = searching && matches === 0;
                if (!section.hidden) anyVisible = true;

                // The type-less variant has no head — its single card is always
                // open and the accordion state doesn't apply.
                const head = section.querySelector('.cat-group-head');
                if (head) {
                    const open = searching ? true : !!openState[section.dataset.type];
                    head.setAttribute('aria-expanded', String(open));
                    const body = section.querySelector('.cat-group-body');
                    if (open) body.removeAttribute('hidden');
                    else      body.setAttribute('hidden', '');
                }

                const addBtn = section.querySelector('.cat-add-row');
                if (addBtn) addBtn.hidden = searching;
            });

            root.querySelector('.cat-no-match').hidden = anyVisible;
        };

        const buildManager = () => {
            // ── One row per column: grip handle + rename input + quiet × ───────
            // Only the grip is draggable; the row itself stays a normal flow
            // element so the rename input and × button keep their pointer events.
            const renderRow = (col) => `
                <div class="cat-row" data-key="${escapeHtml(col.key)}">
                    <span class="cat-grip" draggable="true" aria-label="Drag ${escapeHtml(col.label)} to reorder">${_GRIP}</span>
                    <input type="text" class="cat-name" value="${escapeHtml(col.label)}" maxlength="50"
                           aria-label="Rename ${escapeHtml(col.label)}">
                    <button class="cat-icon-btn cat-delete" title="Delete ${escapeHtml(noun)}" aria-label="Delete ${escapeHtml(col.label)}">${_ICON_X}</button>
                </div>`;
            const renderRows = (items) => items.map(renderRow).join('')
                || `<div class="cat-empty" data-placeholder>No ${escapeHtml(noun)}s yet</div>`;

            // ── One collapsible card per type (flat, always-open card when the
            //    dataset is type-less). Each list carries data-type so a drop
            //    into it retypes the dragged column. ─────────────────────────────
            let sectionsHtml;
            if (ctx.types) {
                sectionsHtml = ctx.types.map(t => {
                    const cols    = ctx.columns.filter(c => c.type === t.key);
                    const heading = t.label + (ctx.typeSectionSuffix || '');
                    const open    = !!openState[t.key];
                    const bodyId  = `col-group-body-${escapeHtml(t.key)}`;
                    return `
                    <section class="cat-group" data-type="${escapeHtml(t.key)}">
                        <button type="button" class="cat-group-head"
                                aria-expanded="${open}" aria-controls="${bodyId}">
                            <span class="cat-group-dot" aria-hidden="true"></span>
                            <span class="cat-group-title">${escapeHtml(heading)}</span>
                            <span class="cat-group-meta">${metaText(cols.length)}</span>
                            ${_ICON_CHEVRON}
                        </button>
                        <div class="cat-group-body" id="${bodyId}"${open ? '' : ' hidden'}>
                            <div class="cat-list" data-type="${escapeHtml(t.key)}">${renderRows(cols)}</div>
                            <button type="button" class="cat-add-row" data-type="${escapeHtml(t.key)}"
                                    aria-label="Add ${escapeHtml(heading)} ${escapeHtml(noun)}">${_ICON_PLUS} Add ${escapeHtml(noun)}</button>
                        </div>
                    </section>`;
                }).join('');
            } else {
                sectionsHtml = `
                <section class="cat-group">
                    <div class="cat-group-body">
                        <div class="cat-list">${renderRows(ctx.columns)}</div>
                        <button type="button" class="cat-add-row"
                                aria-label="Add ${escapeHtml(noun)}">${_ICON_PLUS} Add ${escapeHtml(noun)}</button>
                    </div>
                </section>`;
            }

            overlay.innerHTML = `
            <div class="cat-manager">
                <div class="cat-manager-header">
                    <span>Manage Columns<span class="fc-info" tabindex="0" role="note"
                        aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">i</span></span>
                    <button class="cat-manager-close" aria-label="Close">×</button>
                </div>
                <div class="cat-manager-body">
                    <div class="cat-editor">
                        <div class="cat-search">
                            ${_ICON_SEARCH}
                            <input type="text" class="cat-search-input" placeholder="Search ${escapeHtml(noun)}s"
                                   aria-label="Search ${escapeHtml(noun)}s" value="${escapeHtml(query)}">
                        </div>
                        <div class="cat-groups">${sectionsHtml}</div>
                        <p class="cat-no-match" hidden>No ${escapeHtml(noun)}s match your search.</p>
                    </div>
                </div>
            </div>`;

            root = overlay.querySelector('.cat-editor');
            overlay.querySelector('.cat-manager-close').addEventListener('click', () => overlay.remove());

            // ── Search — filter on every keystroke, no round-trip ──────────────
            const searchInput = overlay.querySelector('.cat-search-input');
            searchInput.addEventListener('input', () => {
                query = searchInput.value;
                applyFilter();
            });

            // ── Card headers — accordion expand/collapse: opening a card
            // collapses the others. A live search forces matching cards open
            // (applyFilter wins), so the stored state only takes effect once
            // the query is cleared. ────────────────────────────────────────────
            overlay.querySelectorAll('.cat-group-head').forEach(head => {
                head.addEventListener('click', () => {
                    const type     = head.closest('.cat-group').dataset.type;
                    const willOpen = !openState[type];
                    Object.keys(openState).forEach(k => { openState[k] = false; });
                    if (willOpen) openState[type] = true;
                    applyFilter();
                });
            });

            // ── Inline rename — commits on blur/Enter; Escape cancels. Blank or
            // unchanged values revert without an API call. No rebuild on
            // success, so focus stays where the user left it. ───────────────────
            overlay.querySelectorAll('.cat-row .cat-name').forEach(input => {
                const key = input.closest('.cat-row').dataset.key;
                input.addEventListener('blur', async () => {
                    const newLabel = input.value.trim();
                    if (!newLabel || newLabel === input.defaultValue) {
                        input.value = input.defaultValue;
                        return;
                    }
                    const result = await ctx.api.updateColumn(key, { label: newLabel });
                    if (!result.ok) {          // wrapWrite already announced the failure
                        input.value = input.defaultValue;
                        return;
                    }
                    input.defaultValue = newLabel;
                    const col = ctx.columns.find(c => c.key === key);
                    if (col) col.label = newLabel;
                    renderYearTables(ctx);
                });
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') input.blur();     // commits via blur handler
                    if (e.key === 'Escape') {                 // cancels — restore label
                        input.value = input.defaultValue;
                        input.blur();
                    }
                });
            });

            // ── Drag-and-drop reorder + retype ─────────────────────────────────
            // The grip handle is the draggable element. The source row stays put
            // (dimmed) during the drag; an accent drop-indicator line shows where
            // the column will land instead of live-shuffling the rows. On dragend
            // we move the row to the indicator's slot, then read the final DOM
            // order across every card — a row's card dictates its new type — and
            // push the whole ordering to the backend in one call.
            let draggingRow = null;
            let indicator   = null;   // the accent line element, reparented as it moves

            const placeIndicator = (list, before) => {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.className = 'cat-drop-indicator';
                }
                if (before) list.insertBefore(indicator, before);
                else list.appendChild(indicator);
            };

            const commitOrder = async () => {
                const order = [];
                overlay.querySelectorAll('.cat-list').forEach(list => {
                    const type = list.dataset.type;   // undefined on type-less datasets
                    list.querySelectorAll('.cat-row').forEach(row => {
                        order.push(ctx.types ? { key: row.dataset.key, type } : { key: row.dataset.key });
                    });
                });
                // No-op if the order + type assignment is unchanged from ctx.columns,
                // so an accidental click-drag that lands back home costs no round-trip.
                const same = order.length === ctx.columns.length && order.every((o, i) =>
                    o.key === ctx.columns[i].key && (!ctx.types || o.type === ctx.columns[i].type));
                if (same) return;
                await ctx.api.reorderColumns(order);
                await reloadYearTables(ctx);
                buildManager();
            };

            overlay.querySelectorAll('.cat-grip').forEach(grip => {
                const row = grip.closest('.cat-row');
                grip.addEventListener('dragstart', e => {
                    // A filtered list shows a partial order — reordering it would
                    // commit positions the user can't see. Clear the search first.
                    if (query.trim()) { e.preventDefault(); return; }
                    draggingRow = row;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', row.dataset.key); // Firefox needs payload
                    e.dataTransfer.setDragImage(row, 12, 12);
                    // Defer the dimming + drag mode so the drag image isn't the
                    // faded row. `dragging` on the editor root hides the empty-
                    // card placeholders (CSS) so the accent line is the only cue.
                    requestAnimationFrame(() => {
                        row.classList.add('cat-dragging');
                        root.classList.add('dragging');
                    });
                });
                grip.addEventListener('dragend', () => {
                    // Land the row where the indicator was sitting, then clean up.
                    if (indicator?.parentElement) {
                        indicator.parentElement.insertBefore(draggingRow, indicator);
                    }
                    indicator?.remove();
                    indicator = null;
                    row.classList.remove('cat-dragging');
                    root.classList.remove('dragging');
                    // Reconcile the accordion after any spring-loaded expansions:
                    // the card the row landed in becomes the open one.
                    const landedType = row.closest('.cat-list')?.dataset.type;
                    if (landedType !== undefined) {
                        Object.keys(openState).forEach(k => { openState[k] = false; });
                        openState[landedType] = true;
                    }
                    applyFilter();
                    draggingRow = null;
                    commitOrder();
                });
            });

            // Delegated dragover: spring a collapsed card open when the drag
            // hovers it (the accordion never has two cards open at once, so a
            // cross-type move would otherwise have no drop target), then place
            // the accent line at the insertion point. Spring-opening is view-
            // only — dragend reconciles the accordion. The indicator has
            // pointer-events:none so it never steals this dragover.
            root.addEventListener('dragover', e => {
                if (!draggingRow) return;
                const group = e.target.closest?.('.cat-group');
                if (group) {
                    const body = group.querySelector('.cat-group-body');
                    if (body?.hasAttribute('hidden')) {
                        body.removeAttribute('hidden');
                        group.querySelector('.cat-group-head')?.setAttribute('aria-expanded', 'true');
                    }
                }
                const list = e.target.closest?.('.cat-list');
                if (!list) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // _dragAfterRow ignores the dimmed source row, so hovering near
                // it resolves cleanly.
                placeIndicator(list, _dragAfterRow(list, e.clientY));
            });
            root.addEventListener('drop', e => { if (draggingRow) e.preventDefault(); });

            // ── Delete column. If the column has saved data the backend refuses
            // and we re-confirm with confirmColumnDelete before forcing. ───────
            overlay.querySelectorAll('.cat-delete').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const key    = btn.closest('.cat-row').dataset.key;
                    const col    = ctx.columns.find(c => c.key === key);
                    const result = await ctx.api.deleteColumn(key);
                    if (!result.ok) {
                        // 'has_data' is the expected refusal — re-confirm and
                        // force. Anything else is a real failure: report it and
                        // keep the column, rather than dropping it locally while
                        // the backend still has it.
                        if (result.error === 'has_data') {
                            confirmColumnDelete(col.label, async () => {
                                const forced = await ctx.api.deleteColumn(key, true);
                                if (!forced.ok) reportSaveFailure();
                                await reloadYearTables(ctx);
                                buildManager();
                            });
                        } else {
                            reportSaveFailure();
                        }
                        return;
                    }
                    ctx.columns = ctx.columns.filter(c => c.key !== key);
                    renderYearTables(ctx);
                    buildManager();
                });
            });

            // ── Add — the quiet row closing each open card. Creates the column
            // immediately with a unique placeholder name (the card fixes the
            // type), then focuses the fresh row's rename input. ────────────────
            overlay.querySelectorAll('.cat-add-row').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const label  = uniqueDefaultLabel();
                    const body   = ctx.types ? { label, type: btn.dataset.type } : { label };
                    const result = await ctx.api.addColumn(body);
                    if (!result.ok) return;   // wrapWrite already announced the failure
                    await reloadYearTables(ctx);
                    buildManager();
                    const input = result.column && overlay.querySelector(
                        `.cat-row[data-key="${result.column.key}"] .cat-name`);
                    if (input) { input.focus(); input.select(); }
                });
            });

            applyFilter();
        };

        buildManager();
    }

    // ─── Bootstrap ──────────────────────────────────────────────────────────────

    /**
     * Wire up a full year-table page from a single config object. Each page's
     * own JS file is now just a one-shot call to this function with the page's
     * specific shape.
     *
     * opts:
     *   apiPrefix           string  — API mount point (e.g. '/api/balance')
     *   types               array?  — [{key, label}, ...]. Omit for type-less pages.
     *   typeSectionSuffix   string? — appended to type labels in section headers
     *                                 (e.g. ' Accounts' → "Cash Accounts")
     *   includeTotals       bool    — render a totals tfoot per table
     *   itemNoun            string? — what one column is called in the Manage
     *                                 Columns modal's copy (default 'column';
     *                                 the Balance Sheet passes 'account')
     *   hideColumnManager   bool    — when true, the per-page Manage Columns
     *                                 button + its modal are skipped entirely.
     *                                 Used by Income & Expenses, whose columns
     *                                 live in the unified Settings → Categories
     *                                 editor and aren't editable per-page.
     *   containerSelector     string? — where tables render (default
     *                                   '.db-tables-container'). The Statements
     *                                   page runs TWO controllers side by side, so
     *                                   each needs its own container + buttons.
     *   addYearBtnSelector    string? — the "Add New Year" button (default
     *                                   '.db-actions .button-primary'); pass null
     *                                   when the page wires add-year itself via
     *                                   the handle's addYear
     *   manageColsBtnSelector string? — the "Manage Columns" button (default
     *                                   '.db-actions .button-secondary'); pass
     *                                   null when the page opens the manager
     *                                   itself via the handle's manageColumns
     *                                   (Statements puts it in the ⋮ menu)
     *
     * Returns a small handle the page controller can drive year-level operations
     * through (the Statements ⋮ menu acts on a year across BOTH datasets):
     *   api           — the makeYearTableApi wrapper for this dataset
     *   reload        — re-fetch /data and re-render every table
     *   hasYear       — whether this dataset currently has the given year
     *   addYear       — create a year in this dataset and render its table
     *   manageColumns — open this dataset's column manager modal
     */
    function bootstrapYearTablePage(opts) {
        const ctx = {
            api:                 makeYearTableApi(opts.apiPrefix),
            types:               opts.types || null,
            typeSectionSuffix:   opts.typeSectionSuffix || '',
            includeTotals:       !!opts.includeTotals,
            itemNoun:            opts.itemNoun || 'column',
            hideColumnManager:   !!opts.hideColumnManager,
            // Mutable state — populated by reloadYearTables() in init below.
            columns:   [],
            years:     [],
            entries:   {},
            computed:  null,
            manual:    null,
            container: null,
        };

        // Create the year on the backend, append a fresh table, then re-sort so
        // it slots into the correct visual position. Used by the button handler
        // below and exposed on the handle for page controllers that create a
        // year across several datasets at once (Statements).
        const addYear = async (newYear) => {
            await ctx.api.addYear(newYear);
            ctx.years.push(newYear);
            ctx.entries[String(newYear)] = {};
            const outer = createYearTable(newYear, ctx);
            ctx.container.appendChild(outer);
            initYearTable(outer, {}, ctx);
            sortTables(ctx.container);
        };

        const init = async () => {
            ctx.container = document.querySelector(opts.containerSelector || '.db-tables-container');
            await reloadYearTables(ctx);

            // "Add New Year" button — opens the year-prompt modal; on confirm
            // creates the year in this dataset. Pages that own the button
            // themselves (Statements adds the year to BOTH datasets) pass
            // addYearBtnSelector: null and call the handle's addYear instead.
            if (opts.addYearBtnSelector !== null) {
                const addYearBtn = document.querySelector(opts.addYearBtnSelector || '.db-actions .button-primary');
                addYearBtn.addEventListener('click', () => {
                    const existing = Array.from(ctx.container.querySelectorAll('.db-outer[data-year]'))
                        .map(el => parseInt(el.dataset.year))
                        .filter(y => !isNaN(y));
                    promptAddYear(existing, addYear);
                });
            }

            // "Manage Columns" button — opens the (toggleable) column manager.
            // Skipped when the page opts out (Cash Flow manages categories in
            // Settings) or owns the entry point itself (manageColsBtnSelector:
            // null + the handle's manageColumns). querySelector returns null
            // when the button isn't in the template, so the guard covers that
            // case without any explicit flag.
            if (opts.manageColsBtnSelector !== null) {
                const manageBtn = document.querySelector(opts.manageColsBtnSelector || '.db-actions .button-secondary');
                if (manageBtn && !ctx.hideColumnManager) {
                    manageBtn.addEventListener('click', () => showColumnManager(ctx));
                }
            }
        };

        // Script tags live at the end of <body>, so the DOM is already parsed
        // when this runs. No DOMContentLoaded wait needed.
        init();

        return {
            api:           ctx.api,
            reload:        () => reloadYearTables(ctx),
            hasYear:       (year) => ctx.years.includes(year),
            addYear,
            manageColumns: () => showColumnManager(ctx),
        };
    }

    // ─── Cross-file surface ─────────────────────────────────────────────────────
    // Consumed by statements.js (the year-table pages); the matching readonly
    // entries live in eslint.config.mjs.
    window.confirmDelete = confirmDelete;
    window.promptAddYear = promptAddYear;
    window.bootstrapYearTablePage = bootstrapYearTablePage;
}());
