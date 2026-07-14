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
    // The handle (not the whole row) is the draggable element, so click-to-rename
    // and the × delete button keep working without the drag interaction stealing
    // their pointer events.
    const _GRIP = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>`;

    /**
     * Given a drop-target list and the pointer's Y, return the row the dragged
     * element should be inserted BEFORE (or null to append at the end). Standard
     * native-DnD pattern: pick the not-being-dragged row whose vertical midpoint is
     * just below the cursor. Used to live-reorder the DOM during dragover.
     */
    function _dragAfterRow(listEl, y) {
        const rows = [...listEl.querySelectorAll('.col-row:not(.col-row-dragging)')];
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
    //     defaultAddType      → which type the "Add column" toggle starts on
    //     addLayout           → 'flat' | 'inline-toggle' | 'stacked'
    //     addInputPlaceholder → placeholder text for the "Add column" name input
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
            setSync:       (year, body)              => wrapWrite(sendJson(`${prefix}/year/${year}/sync`, 'POST', body)),
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
        // Per-year synced-category map { yearStr: [catKey,…] }. Only the Cash Flow
        // page ships it; other year-table pages leave ctx.sync undefined (all cells
        // editable).
        ctx.sync      = data.sync || {};
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

        // Which categories are sync-computed for THIS year (per-table sync). Empty
        // on pages that don't ship a sync map (everything stays editable).
        const syncedKeys = new Set(ctx.sync?.[String(year)] || []);

        const wrapper = document.createElement('div');
        wrapper.className = 'db-wrapper';

        const table = document.createElement('table');
        table.className = 'db-table';

        // ── thead: column headers ───────────────────────────────────────────────
        const thead = document.createElement('thead');
        // Sync state is per-table now and managed from the ⋮ → Sync Settings modal,
        // so headers carry no sync affordance — the read-only body cells are the cue.
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
        // Editable inputs for normal columns, read-only spans for synced ones —
        // see _buildDataCell.
        const tbody = document.createElement('tbody');
        MONTHS.forEach(month => {
            const tr = document.createElement('tr');
            const monthTd = document.createElement('td');
            monthTd.className = 'month-label';
            monthTd.textContent = month;
            tr.appendChild(monthTd);
            ctx.columns.forEach(col => {
                tr.appendChild(_buildDataCell(month, col, syncedKeys.has(col.key)));
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
                totalRow.appendChild(_buildTotalCell(col, syncedKeys.has(col.key)));
            });
            tfoot.appendChild(totalRow);
            table.appendChild(tfoot);
        }

        wrapper.appendChild(table);
        outer.appendChild(wrapper);
        return outer;
    }

    /**
     * Build one body cell. Two shapes:
     *   • Editable column      — editable <input>. The input carries the currency
     *                            symbol as a prefix once content is present (e.g.
     *                            "$1,234"); see currency.js for the editing model.
     *   • Synced cell (isSynced) — read-only <span>. Its text is the computed sum of
     *                            matching transactions for the month, populated by
     *                            initYearTable from the entries payload. No event
     *                            wiring on these cells. Sync is per-table, so the
     *                            same column may be synced in one year and editable
     *                            in another.
     */
    function _buildDataCell(month, col, isSynced) {
        const td = document.createElement('td');
        td.className = 'data-cell';

        if (isSynced) {
            td.classList.add('db-col-synced');
            const span = document.createElement('span');
            span.className     = 'db-input db-synced-value';
            span.dataset.month = month;
            span.dataset.col   = col.key;
            span.textContent   = '—';
            td.appendChild(span);
            return td;
        }

        const input = document.createElement('input');
        input.type          = 'text';        // not number, so symbol + commas can show
        input.inputMode     = 'decimal';     // numeric keypad on mobile
        input.className     = 'db-input';
        input.dataset.month = month;
        input.dataset.col   = col.key;
        input.placeholder   = '—';
        td.appendChild(input);
        return td;
    }

    /**
     * Build one read-only total cell (used when includeTotals is true). The
     * span starts at "—" and updateYearTotals() rewrites it to "$<sum>" (with
     * the user's chosen symbol baked in via formatCurrency) once the column
     * has a non-zero sum. `isSynced` extends the synced-cell highlight into the
     * totals row for this year.
     */
    function _buildTotalCell(col, isSynced) {
        const td = document.createElement('td');
        td.className = 'data-cell';
        if (isSynced) td.classList.add('db-col-synced');
        td.dataset.totalCol = col.key;
        const valSpan = document.createElement('span');
        valSpan.className = 'total-value';
        valSpan.textContent = '—';
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

        const fireSaveFor = (input, month, col) => {
            _pendingCellSaves.delete(input);
            const val = parseFloat(stripCurrencyValue(input.value));
            // Write through to ctx.entries so the in-memory model always matches
            // the cells. renderYearTables rebuilds the DOM from ctx.entries, so
            // without this a local re-render (e.g. after a column rename) blanks
            // every value entered since the last full reload.
            const months = ctx.entries[String(currentYear)] ??= {};
            if (input.value === '' || isNaN(val)) {
                if (months[month]) delete months[month][col];
                ctx.api.deleteEntry(currentYear, month, col);
            } else {
                (months[month] ??= {})[col] = val;
                ctx.api.upsertEntry(currentYear, month, col, val);
            }
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

        // Synced columns (I&E) render their values into spans, not inputs.
        // They get no event listeners — values come from the backend each time
        // the page reloads (computed from the Transactions ledger).
        outerEl.querySelectorAll('span.db-synced-value').forEach(span => {
            const month = span.dataset.month;
            const col   = span.dataset.col;
            const saved = yearEntries?.[month]?.[col];
            span.textContent = (saved !== undefined) ? formatCurrency(saved) : '—';
        });

        outerEl.querySelectorAll('input[data-month][data-col]').forEach(input => {
            const month = input.dataset.month;
            const col   = input.dataset.col;
            const saved = yearEntries?.[month]?.[col];
            // Pre-fill with the symbol-prefixed display value so the cell
            // matches what the user would see after typing. {editable} keeps the
            // cents even when "hide cents" is on — they'd otherwise be truncated
            // on the next save.
            if (saved !== undefined) input.value = formatCurrency(saved, false, { editable: true });

            input.addEventListener('input', () => {
                applyCurrencyFormat(input);
                scheduleSave(input, month, col);
                if (ctx.includeTotals) updateYearTotals(outerEl, ctx);
            });

            // Leaving the cell commits any pending edit immediately. Users expect
            // tab/click-away to mean "I'm done with this cell" — waiting out a
            // debounce window first feels like the app is hesitating.
            input.addEventListener('blur', () => flushSave(input));

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
     * any cell edit, paste, or column add. Empty columns render as "—" so the
     * cell isn't a confusing "$0".
     *
     * The cell holds just a .total-value span; formatCurrency() handles the
     * symbol prefix (with the user's chosen currency) and comma formatting.
     */
    function updateYearTotals(outerEl, ctx) {
        ctx.columns.forEach(col => {
            let sum = 0, hasValue = false;
            // Sum across both editable inputs and synced read-only spans so the
            // totals row stays accurate on I&E tables where some columns may be
            // sync-computed and others manually entered.
            const addValue = (raw) => {
                const val = parseFloat(stripCurrencyValue(raw));
                if (!isNaN(val)) { sum += val; hasValue = true; }
            };
            outerEl.querySelectorAll(`input[data-col="${col.key}"]`).forEach(el => addValue(el.value));
            outerEl.querySelectorAll(`span.db-synced-value[data-col="${col.key}"]`).forEach(el => addValue(el.textContent));

            const cell    = outerEl.querySelector(`[data-total-col="${col.key}"]`);
            if (!cell) return;
            const valSpan = cell.querySelector('.total-value');
            valSpan.textContent = hasValue ? formatCurrency(sum) : '—';
        });
    }

    // ─── Column Manager modal ───────────────────────────────────────────────────

    /**
     * Open (or close, if already open) the "Manage Columns" modal. The modal
     * lists every column with reorder arrows, an inline rename input, a
     * per-column type chip (when ctx.types is set), and a delete button. The
     * footer holds an "Add column" row whose layout depends on ctx.addLayout.
     *
     * The whole modal is rebuilt from scratch (`buildManager()`) on every
     * change — adds, deletes, renames, reorderings, type cycles — so we don't
     * have to surgically update individual rows after each backend call. This
     * costs us very little (the modal is small and rare to interact with) and
     * eliminates a lot of bookkeeping bugs.
     *
     * SECURITY: every user-controlled value (col.key, col.label, type labels)
     * is escapeHtml'd before being interpolated into the innerHTML template.
     */
    function showColumnManager(ctx) {
        const existing = document.querySelector('.col-manager-overlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay col-manager-overlay';
        document.body.appendChild(overlay);

        // The currently-selected type for the "Add column" widget. For typed
        // pages (I&E, Balance Sheet) this comes from ctx.defaultAddType; for
        // the type-less Savings page it stays null and the add request omits
        // the type field entirely.
        let addType = ctx.defaultAddType;

        const buildManager = () => {
            // ── Render one column row (grip handle + rename input + ×) ─────────
            // Only the grip is draggable; the row itself stays a normal flow
            // element so the rename input and × button keep their pointer events.
            const renderRow = (col) => `
                <div class="col-row" data-key="${escapeHtml(col.key)}">
                    <span class="col-row-grip" draggable="true" aria-label="Drag ${escapeHtml(col.label)} to reorder">${_GRIP}</span>
                    <span class="col-row-label">${escapeHtml(col.label)}</span>
                    <input class="col-row-input" value="${escapeHtml(col.label)}" style="display:none" aria-label="Rename ${escapeHtml(col.label)}">
                    <button class="col-row-delete" aria-label="Delete ${escapeHtml(col.label)}">×</button>
                </div>`;
            const renderRows = (items) => items.map(renderRow).join('');

            // ── Render the list section(s): per-type when typed, flat when not ─
            // Each list carries data-type so a drop into it can reassign the
            // dragged column's type; the empty placeholder is data-placeholder so
            // the dragover handler can yank it out before inserting a row.
            let sectionsHtml;
            if (ctx.types) {
                sectionsHtml = ctx.types.map(t => {
                    const cols = ctx.columns.filter(c => c.type === t.key);
                    const heading = t.label + (ctx.typeSectionSuffix || '');
                    return `
                    <div class="col-manager-section">
                        <div class="col-type-label">${escapeHtml(heading)}</div>
                        <div class="col-manager-list" data-type="${escapeHtml(t.key)}">
                            ${cols.length ? renderRows(cols) : '<div class="col-empty" data-placeholder>None</div>'}
                        </div>
                    </div>`;
                }).join('');
            } else {
                sectionsHtml = `
                <div class="col-manager-section">
                    <div class="col-manager-list">
                        ${ctx.columns.length ? renderRows(ctx.columns) : '<div class="col-empty" data-placeholder>No columns yet</div>'}
                    </div>
                </div>`;
            }

            // ── Render the "Add column" widget. Shape depends on addLayout. ────
            let addHtml;
            const placeholder = escapeHtml(ctx.addInputPlaceholder || 'Column name');
            const typeToggleBtns = ctx.types
                ? ctx.types.map(t =>
                    `<button class="type-toggle-btn${addType === t.key ? ' active' : ''}" data-type="${escapeHtml(t.key)}">${escapeHtml(t.label)}</button>`
                  ).join('')
                : '';

            if (ctx.addLayout === 'stacked') {
                // Balance Sheet — input + add ABOVE, four type-toggle buttons BELOW.
                // Used when there are too many types to fit comfortably inline.
                addHtml = `
                <div class="col-manager-add-stacked">
                    <div class="col-manager-add">
                        <input type="text" class="col-name-input" placeholder="${placeholder}" maxlength="50">
                        <button class="col-add-btn">Add</button>
                    </div>
                    <div class="col-type-toggle">${typeToggleBtns}</div>
                </div>`;
            } else if (ctx.addLayout === 'inline-toggle') {
                // I&E — [Expense | Income] [input] [Add]. Compact layout because
                // there are only two types so the toggle fits inline.
                addHtml = `
                <div class="col-manager-add">
                    <div class="col-type-toggle">${typeToggleBtns}</div>
                    <input type="text" class="col-name-input" placeholder="${placeholder}" maxlength="50">
                    <button class="col-add-btn">Add</button>
                </div>`;
            } else {
                // Savings — [input] [Add]. No type system at all.
                addHtml = `
                <div class="col-manager-add">
                    <input type="text" class="col-name-input" placeholder="${placeholder}" maxlength="50">
                    <button class="col-add-btn">Add</button>
                </div>`;
            }

            overlay.innerHTML = `
            <div class="col-manager">
                <div class="col-manager-header">
                    <span>Manage Columns</span>
                    <button class="col-manager-close">×</button>
                </div>
                <div class="col-manager-body">
                    ${sectionsHtml}
                </div>
                <div class="col-manager-footer">
                    ${addHtml}
                </div>
            </div>`;

            // ── Wire up modal close (× button or backdrop click) ───────────────
            overlay.querySelector('.col-manager-close').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

            // ── Inline rename: click label → swap in input → save on blur/Enter ─
            overlay.querySelectorAll('.col-row').forEach(row => {
                const key       = row.dataset.key;
                const labelSpan = row.querySelector('.col-row-label');
                const input     = row.querySelector('.col-row-input');

                labelSpan.addEventListener('click', () => {
                    labelSpan.style.display = 'none';
                    input.style.display = '';
                    input.focus();
                    input.select();
                });

                const saveRename = async () => {
                    const newLabel = input.value.trim();
                    if (!newLabel || newLabel === labelSpan.textContent) {
                        // Either blank or unchanged — revert without an API call.
                        labelSpan.style.display = '';
                        input.style.display = 'none';
                        return;
                    }
                    await ctx.api.updateColumn(key, { label: newLabel });
                    const col = ctx.columns.find(c => c.key === key);
                    if (col) col.label = newLabel;
                    renderYearTables(ctx);
                    buildManager();
                };

                input.addEventListener('blur', saveRename);
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') input.blur();          // commits via blur handler
                    if (e.key === 'Escape') {                      // cancels — restore label
                        input.value = labelSpan.textContent;
                        labelSpan.style.display = '';
                        input.style.display = 'none';
                    }
                });
            });

            // ── Drag-and-drop reorder + retype ─────────────────────────────────
            // The grip handle is the draggable element. The source row stays put
            // (dimmed) during the drag; an accent drop-indicator line shows where
            // the column will land instead of live-shuffling the rows. On dragend
            // we move the row to the indicator's slot, then read the final DOM
            // order across every section — for typed pages a row's section dictates
            // its new type — and push the whole ordering to the backend in one call.
            const manager   = overlay.querySelector('.col-manager');
            let draggingRow = null;
            let indicator   = null;   // the accent line element, reparented as it moves

            const placeIndicator = (list, before) => {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.className = 'col-drop-indicator';
                }
                if (before) list.insertBefore(indicator, before);
                else list.appendChild(indicator);
            };

            const commitOrder = async () => {
                const order = [];
                overlay.querySelectorAll('.col-manager-list').forEach(list => {
                    const type = list.dataset.type;   // undefined on type-less pages
                    list.querySelectorAll('.col-row').forEach(row => {
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

            overlay.querySelectorAll('.col-row-grip').forEach(grip => {
                const row = grip.closest('.col-row');
                grip.addEventListener('dragstart', e => {
                    draggingRow = row;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', row.dataset.key); // Firefox needs payload
                    e.dataTransfer.setDragImage(row, 12, 12);
                    // Defer the dimming + drag mode so the drag image isn't the
                    // faded row. `dragging` on the manager hides the empty-section
                    // placeholders (CSS) so the accent line is the only cue.
                    requestAnimationFrame(() => {
                        row.classList.add('col-row-dragging');
                        manager.classList.add('dragging');
                    });
                });
                grip.addEventListener('dragend', () => {
                    // Land the row where the indicator was sitting, then clean up.
                    if (indicator?.parentElement) {
                        indicator.parentElement.insertBefore(draggingRow, indicator);
                    }
                    indicator?.remove();
                    indicator = null;
                    row.classList.remove('col-row-dragging');
                    manager.classList.remove('dragging');
                    draggingRow = null;
                    commitOrder();
                });
            });

            overlay.querySelectorAll('.col-manager-list').forEach(list => {
                list.addEventListener('dragover', e => {
                    if (!draggingRow) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    // Show the accent line at the insertion point. _dragAfterRow
                    // ignores the dimmed source row, so hovering near it resolves
                    // cleanly. The indicator has pointer-events:none so it never
                    // steals this dragover from the list.
                    placeIndicator(list, _dragAfterRow(list, e.clientY));
                });
                list.addEventListener('drop', e => e.preventDefault());
            });

            // ── Delete column. If the column has saved data the backend refuses
            // and we re-confirm with confirmColumnDelete before forcing. ───────
            overlay.querySelectorAll('.col-row-delete').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const key    = btn.closest('.col-row').dataset.key;
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

            // ── Type toggle for the NEW column being added (typed pages only) ──
            if (ctx.types) {
                overlay.querySelectorAll('.type-toggle-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        addType = btn.dataset.type;
                        overlay.querySelectorAll('.type-toggle-btn').forEach(b =>
                            b.classList.toggle('active', b.dataset.type === addType));
                    });
                });
            }

            // ── Add column. Body shape varies by typed/typeless. ───────────────
            const nameInput = overlay.querySelector('.col-name-input');
            const addBtn    = overlay.querySelector('.col-add-btn');

            const tryAdd = async () => {
                const label = nameInput.value.trim();
                if (!label) { nameInput.classList.add('invalid'); return; }
                const body   = ctx.types ? { label, type: addType } : { label };
                const result = await ctx.api.addColumn(body);
                if (result.ok) {
                    await reloadYearTables(ctx);
                    nameInput.value = '';
                    buildManager();
                }
            };

            nameInput.addEventListener('input', () => nameInput.classList.remove('invalid'));
            nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryAdd(); });
            addBtn.addEventListener('click', tryAdd);
        };

        buildManager();
    }

    // ─── Cash Flow Sync modal ────────────────────────────────────────────────────

    // A small switch toggle reused for every category row. Shape mirrors the
    // Settings categories switch so the affordance reads consistently.
    const _SYNC_SWITCH = (key, on) =>
        `<label class="sync-switch">
        <input type="checkbox" data-key="${escapeHtml(key)}" ${on ? 'checked' : ''}>
        <span class="sync-switch-track"><span class="sync-switch-knob"></span></span>
    </label>`;

    /**
     * Open (or toggle closed) the per-year category sync modal for one dataset.
     * Reached via the Statements sheet ⋮ → "Cash Flow Sync" (the syncSettings
     * handle bootstrapYearTablePage returns). Lists every category grouped by
     * type with a switch that controls whether that category's monthly value for
     * THIS year is computed from transactions (synced) or hand-entered. A toolbar
     * offers Sync all / Unsync all.
     *
     * Every change round-trips through ctx.api.setSync, then reloadYearTables()
     * re-fetches so synced cells pick up their computed values, then the modal
     * body is rebuilt from the fresh ctx.sync — same rebuild-from-scratch approach
     * as showColumnManager.
     *
     * SECURITY: category keys and labels are user-controlled and escapeHtml'd
     * before being interpolated into the innerHTML template.
     */
    function showSyncSettings(year, ctx) {
        const existing = document.querySelector('.sync-manager-overlay');
        if (existing) { existing.remove(); return; }

        // Reuse the column-manager overlay framing (backdrop blur + modal frame);
        // sync-manager-overlay only adds the per-row toggle styling.
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay col-manager-overlay sync-manager-overlay';
        document.body.appendChild(overlay);

        const types = ctx.types || [{ key: null, label: '' }];

        const render = () => {
            const syncedKeys = new Set(ctx.sync?.[String(year)] || []);

            const sectionsHtml = types.map(t => {
                const cols = ctx.types
                    ? ctx.columns.filter(c => c.type === t.key)
                    : ctx.columns;
                if (!cols.length) return '';
                const rows = cols.map(c => `
                <div class="sync-row" data-key="${escapeHtml(c.key)}">
                    <span class="sync-row-label">${escapeHtml(c.label)}</span>
                    ${_SYNC_SWITCH(c.key, syncedKeys.has(c.key))}
                </div>`).join('');
                const heading = ctx.types
                    ? `<div class="col-type-label">${escapeHtml(t.label)}</div>` : '';
                return `<div class="col-manager-section">${heading}<div class="sync-list">${rows}</div></div>`;
            }).join('');

            overlay.innerHTML = `
            <div class="col-manager sync-manager">
                <div class="col-manager-header">
                    <span>Cash Flow Sync — ${year}</span>
                    <button class="col-manager-close" aria-label="Close">×</button>
                </div>
                <div class="sync-manager-toolbar">
                    <button class="sync-bulk-btn" data-sync="true">Sync all</button>
                    <button class="sync-bulk-btn" data-sync="false">Unsync all</button>
                </div>
                <div class="col-manager-body">
                    ${sectionsHtml || '<div class="col-empty">No categories yet.</div>'}
                </div>
            </div>`;

            overlay.querySelector('.col-manager-close').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

            // Per-category toggle.
            overlay.querySelectorAll('.sync-switch input[data-key]').forEach(input => {
                input.addEventListener('change', async () => {
                    await ctx.api.setSync(year, { category: input.dataset.key, sync: input.checked });
                    await reloadYearTables(ctx);
                    render();
                });
            });

            // Sync all / Unsync all.
            overlay.querySelectorAll('.sync-bulk-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await ctx.api.setSync(year, { all: true, sync: btn.dataset.sync === 'true' });
                    await reloadYearTables(ctx);
                    render();
                });
            });
        };

        render();
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
     *   defaultAddType      string? — default selection for "Add column" type
     *   addLayout           string  — 'flat' | 'inline-toggle' | 'stacked'
     *   addInputPlaceholder string? — placeholder for the "Add column" name input
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
     *                                   '.db-actions .button-secondary')
     *
     * Returns a small handle the page controller can drive year-level operations
     * through (the Statements ⋮ menu acts on a year across BOTH datasets):
     *   api          — the makeYearTableApi wrapper for this dataset
     *   reload       — re-fetch /data and re-render every table
     *   hasYear      — whether this dataset currently has the given year
     *   addYear      — create a year in this dataset and render its table
     *   syncSettings — open the per-year category sync modal for this dataset
     *                  (Statements ⋮ → "Cash Flow Sync")
     */
    function bootstrapYearTablePage(opts) {
        const ctx = {
            api:                 makeYearTableApi(opts.apiPrefix),
            types:               opts.types || null,
            typeSectionSuffix:   opts.typeSectionSuffix || '',
            includeTotals:       !!opts.includeTotals,
            defaultAddType:      opts.defaultAddType ?? opts.types?.[0]?.key ?? null,
            addLayout:           opts.addLayout || 'flat',
            addInputPlaceholder: opts.addInputPlaceholder || 'Column name',
            hideColumnManager:   !!opts.hideColumnManager,
            // Mutable state — populated by reloadYearTables() in init below.
            columns:   [],
            years:     [],
            entries:   {},
            sync:      {},
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
            // Settings). querySelector returns null when the button isn't in the
            // template, so the guard covers that case without any explicit flag.
            const manageBtn = document.querySelector(opts.manageColsBtnSelector || '.db-actions .button-secondary');
            if (manageBtn && !ctx.hideColumnManager) {
                manageBtn.addEventListener('click', () => showColumnManager(ctx));
            }
        };

        // Script tags live at the end of <body>, so the DOM is already parsed
        // when this runs. No DOMContentLoaded wait needed.
        init();

        return {
            api:          ctx.api,
            reload:       () => reloadYearTables(ctx),
            hasYear:      (year) => ctx.years.includes(year),
            addYear,
            syncSettings: (year) => showSyncSettings(year, ctx),
        };
    }

    // ─── Cross-file surface ─────────────────────────────────────────────────────
    // Consumed by statements.js (the year-table pages); the matching readonly
    // entries live in eslint.config.mjs.
    window.confirmDelete = confirmDelete;
    window.promptAddYear = promptAddYear;
    window.bootstrapYearTablePage = bootstrapYearTablePage;
}());
