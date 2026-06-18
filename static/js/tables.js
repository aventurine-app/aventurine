'use strict';

// ============================================================================
// tables.js — Shared table behavior for oliv spreadsheet pages.
// ============================================================================
//
// Loaded BEFORE every spreadsheet page's own JS. Provides two layers:
//
//   (1) Low-level helpers used by every spreadsheet-like page (Income &
//       Expenses, Balance Sheet, Savings & Investing, Portfolio):
//         - escapeHtml, debounce
//         - currency input formatters (formatWithCommas, applyCommaFormat,
//           formatDisplay)
//         - generic modal builders (confirmDelete, promptAddYear,
//           confirmColumnDelete)
//         - the ⋮ table-options dropdown (openTableMenu)
//         - sortTables for DOM-level newest-first sort
//
//   (2) A full "year-table" controller used by Income & Expenses, Balance
//       Sheet, and Savings & Investing. Those three pages now each reduce to
//       a single bootstrapYearTablePage(opts) call with a config object
//       describing the page's API prefix, column types, and minor UI
//       variations. See bootstrapYearTablePage() at the bottom for the full
//       option list.
//
// Portfolio uses layer (1) but has its own controller (portfolio.js) because
// it operates on accounts rather than calendar years and has no column manager.

// ─── Constants ──────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Precompiled regexes — recreating these on every keystroke would be wasteful
// since formatWithCommas / applyCommaFormat run inside an input event listener.
const _RE_NON_DECIMAL  = /[^0-9.]/g;
const _RE_NON_DIGIT    = /[^0-9]/g;
const _RE_THOUSANDS    = /\B(?=(\d{3})+(?!\d))/g;
const _RE_SINGLE_DIGIT = /[0-9]/;

// Chevron icons used by the column manager's reorder arrows. Defined here so
// both the year-table column manager and any future column-manager-like UI
// can reuse the same glyphs.
const _CHEVRON_UP   = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const _CHEVRON_DOWN = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// escapeHtml is a global from escape.js (loaded by base.html before this
// file). ALL column labels, year strings, account names, and other user-
// controlled values MUST pass through it when building HTML via template
// literals.

// ─── Number formatting helpers ──────────────────────────────────────────────
// All currency inputs use type="text" (not type="number") so commas can be
// displayed while typing. Commas are stripped (value.replace(/,/g, ''))
// before parseFloat / save.

/** Strip non-numeric chars, then insert thousand separators into the integer part. */
function formatWithCommas(raw) {
    const clean  = String(raw).replace(_RE_NON_DECIMAL, '');
    const dotIdx = clean.indexOf('.');
    const intPart = dotIdx === -1 ? clean : clean.slice(0, dotIdx);
    const decPart = dotIdx === -1 ? '' : clean.slice(dotIdx);
    return intPart.replace(_RE_THOUSANDS, ',') + decPart;
}

/**
 * Reformat an input's value with commas in-place while preserving the caret
 * position relative to the underlying DIGITS — without this, the cursor
 * would jump to the end of the field every time a comma was inserted.
 *
 * We compute (a) how many digits sit to the left of the caret before
 * formatting and (b) whether the caret was already past the decimal point,
 * then walk the formatted string until we hit the same digit count on the
 * same side of the decimal.
 */
function applyCommaFormat(input) {
    const raw = input.value;
    const pos = input.selectionStart;
    const beforeCursor = raw.slice(0, pos);
    const digitsBeforeCursor = beforeCursor.replace(_RE_NON_DIGIT, '').length;
    const afterDecimal = beforeCursor.includes('.');

    const formatted = formatWithCommas(raw);
    input.value = formatted;

    let digitCount  = 0;
    let pastDecimal = false;
    let newPos      = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
        if (digitCount === digitsBeforeCursor && pastDecimal === afterDecimal) {
            newPos = i;
            break;
        }
        if (formatted[i] === '.') {
            pastDecimal = true;
        } else if (_RE_SINGLE_DIGIT.test(formatted[i])) {
            digitCount++;
        }
    }
    input.setSelectionRange(newPos, newPos);
}

/**
 * Format a number for read-only display (totals, footer cells, computed
 * spans). Hides ".00" so whole-dollar values look clean. Decimals like .50
 * are preserved as ".50".
 */
function formatDisplay(num) {
    const fixed = num.toFixed(2);
    const [intStr, decStr] = fixed.split('.');
    const intFormatted = intStr.replace(_RE_THOUSANDS, ',');
    return decStr === '00' ? intFormatted : intFormatted + '.' + decStr;
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

/**
 * Standard trailing-edge debounce. Used by every cell save handler so we get
 * one API call per ~600 ms of typing instead of one per keystroke. Returns
 * a function whose arguments are forwarded to fn on each fire.
 */
function debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

/**
 * Open a ⋮ dropdown menu anchored to `menuBtn`. `items` is an array of
 * { label, action, danger? } objects — danger styles the entry red (used
 * for "Delete Table"). Closes automatically when the user clicks outside.
 *
 * The dropdown is positioned absolute and inserted into menuBtn.parentElement,
 * which is forced to position: relative so the dropdown anchors correctly.
 */
function openTableMenu(menuBtn, items) {
    document.querySelector('.p-table-dropdown')?.remove();
    const menu = document.createElement('div');
    menu.className = 'p-table-dropdown';
    items.forEach(({ label, action, danger }) => {
        const item = document.createElement('button');
        item.className = 'p-dropdown-item' + (danger ? ' p-dropdown-item-danger' : '');
        item.textContent = label;
        item.addEventListener('click', () => { menu.remove(); action(); });
        menu.appendChild(item);
    });
    const anchor = menuBtn.parentElement;
    // We need a positioned ancestor so the .p-table-dropdown (position:
    // absolute) anchors correctly. .p-forehead-btns already has position:
    // sticky in tables.css — overriding that here with inline `relative`
    // would permanently clobber the sticky (inline styles win over class
    // rules, and we don't unset this on close). So only set position when
    // the anchor is otherwise unpositioned.
    if (getComputedStyle(anchor).position === 'static') {
        anchor.style.position = 'relative';
    }
    anchor.appendChild(menu);
    // Defer attaching the outside-click handler so the current click event
    // (which opened the menu) doesn't immediately close it.
    const close = e => {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
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
 * Modal prompt for adding a new year. Validates client-side (4-digit number
 * in [1000, 9999], not already present in `existingYears`). The backend
 * re-validates with _validate_year so a tampered request still gets rejected.
 */
function promptAddYear(existingYears, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <button class="dialog-close-btn" aria-label="Close">×</button>
            <p>Enter a <strong>4-digit year</strong> to add:</p>
            <input type="number" class="year-prompt-input" min="1000" max="9999" placeholder="e.g. 2024">
            <div class="confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-add">Add</button>
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
// Year-table controller — shared by Income & Expenses, Balance Sheet, Savings
// ============================================================================
//
// Each year-table page calls bootstrapYearTablePage(opts) once at the bottom
// of its tiny config script. Everything below this point implements that
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
 * Errors are intentionally swallowed at call sites — failed saves leave the
 * UI in an inconsistent state but don't throw, which is acceptable for a
 * single-user local app.
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
    // Wrap a write so the Store cache for this feature is dropped once the
    // request resolves. The actual response shape is preserved unchanged.
    const wrapWrite = (promise) => promise.finally(invalidate);
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
        deleteColumn:  (key, force = false) => {
            const url = force ? `${prefix}/columns/${key}?force=true` : `${prefix}/columns/${key}`;
            return wrapWrite(apiFetch(url, { method: 'DELETE' }).then(r => r.json()));
        },
    };
}

// ─── Render / reload ────────────────────────────────────────────────────────

/**
 * Rebuild every year-table from scratch from ctx.years/ctx.entries/ctx.columns.
 *
 * Preserves which years are collapsed across re-renders by snapshotting their
 * collapsed state into a Set before clearing the container, then re-applying
 * it after rebuild. On the very first render (when no tables exist yet),
 * everything except the newest year starts collapsed so the page isn't a wall
 * of tables on first load.
 */
function renderYearTables(ctx) {
    const tableEls       = ctx.container.querySelectorAll('.db-outer[data-year]');
    const isFirstRender  = tableEls.length === 0;
    const collapsedYears = new Set(
        Array.from(tableEls)
            .filter(el => el.querySelector('.db-table')?.classList.contains('collapsed'))
            .map(el => parseInt(el.dataset.year))
    );

    ctx.container.innerHTML = '';
    [...ctx.years].sort((a, b) => b - a).forEach((year, i) => {
        const outerEl = createYearTable(year, ctx);
        ctx.container.appendChild(outerEl);
        initYearTable(outerEl, ctx.entries[String(year)] || {}, ctx);
        const shouldCollapse = isFirstRender ? i > 0 : collapsedYears.has(year);
        if (shouldCollapse) outerEl.querySelector('.db-table').classList.add('collapsed');
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
 *   - thead row 1: forehead — year title + ⋮ menu button
 *   - thead row 2: column labels (Month | col1 | col2 | …)
 *   - tbody:        twelve month rows of editable currency inputs
 *   - tfoot:        optional totals row (when ctx.includeTotals is true)
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

    // ── thead row 1: forehead (year + ⋮ menu) ───────────────────────────────
    const thead = document.createElement('thead');

    const titleRow = document.createElement('tr');
    titleRow.className = 'db-title-row';
    const titleTh = document.createElement('th');
    // Span all columns so the forehead stretches the full width of the table.
    titleTh.colSpan = ctx.columns.length + 1;
    const titleInner = document.createElement('div');
    titleInner.className = 'db-title-inner';
    const titleLabel = document.createElement('span');
    titleLabel.className = 'db-title-label';
    titleLabel.textContent = year;
    const menuBtn = document.createElement('button');
    menuBtn.className = 'p-menu-btn';
    menuBtn.textContent = '⋮';
    menuBtn.title = 'Table options';
    // Wrap the menu button in a .p-forehead-btns group — same wrapper used
    // by portfolio.js. The CSS rule on .p-forehead-btns (tables.css) makes
    // it position: sticky so the ⋮ stays anchored to the visible right edge
    // of the scroll viewport when the table is wider than its container.
    // Without the wrapper the button sat at the far right of the th and
    // got pushed off-screen as soon as the user scrolled horizontally.
    const actions = document.createElement('div');
    actions.className = 'p-forehead-btns';
    actions.appendChild(menuBtn);
    titleInner.appendChild(titleLabel);
    titleInner.appendChild(actions);
    titleTh.appendChild(titleInner);
    titleRow.appendChild(titleTh);
    thead.appendChild(titleRow);

    // ── thead row 2: column headers ─────────────────────────────────────────
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

window.addEventListener('pagehide', () => {
    // The save fetches carry `keepalive: true` (see makeYearTableApi) so the
    // browser holds them open long enough to reach the server even as the
    // page unloads.
    for (const { timer, fire } of _pendingCellSaves.values()) {
        clearTimeout(timer);
        fire();
    }
    _pendingCellSaves.clear();
});

// ─── Table init: populate cells + wire input events ─────────────────────────

/**
 * Populate the inputs for one already-built year table and attach all event
 * handlers:
 *   - input:    live comma formatting + debounced save + (if includeTotals) totals refresh
 *   - keydown:  spreadsheet-style arrow-key navigation (Enter == ArrowDown)
 *   - title click: toggle collapsed state
 *
 * Multi-cell selection (drag / Shift+arrow → copy / paste / delete) is layered
 * on by cellselect.js once the table is built — see the enableCellSelection
 * call below.
 *   - ⋮ click:  open the per-table options dropdown (Duplicate / Delete)
 *
 * Saves are debounced so we don't fire one API call per keystroke. Deletes
 * are issued when a value is cleared so blank cells aren't persisted as 0.
 */
function initYearTable(outerEl, yearEntries, ctx) {
    const table       = outerEl.querySelector('.db-table');
    const titleRow    = outerEl.querySelector('.db-title-row');
    const menuBtn     = outerEl.querySelector('.p-menu-btn');
    const currentYear = parseInt(outerEl.dataset.year);

    // Saves are debounced per input via the module-level _pendingCellSaves
    // map (see "Cell-save scheduler" above) — one API call per
    // SAVE_DEBOUNCE_MS of typing instead of one per keystroke. The map
    // doubles as the registry that blur and pagehide flush against, so
    // moving focus or navigating away never drops an in-progress edit.

    const fireSaveFor = (input, month, col) => {
        _pendingCellSaves.delete(input);
        const val = parseFloat(stripCurrencyValue(input.value));
        if (input.value === '' || isNaN(val)) {
            ctx.api.deleteEntry(currentYear, month, col);
        } else {
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
        // matches what the user would see after typing.
        if (saved !== undefined) input.value = formatCurrency(saved);

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

    // Click anywhere on the forehead (except the ⋮ button) to toggle collapse.
    titleRow.addEventListener('click', e => {
        if (e.target.closest('.p-menu-btn')) return;
        table.classList.toggle('collapsed');
    });

    // ⋮ menu: Duplicate / Delete. Year tables don't support Rename because
    // the year IS the identifier; to "rename" a year, the user duplicates
    // into the new year and deletes the old one.
    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        const items = [];
        // Sync Settings — Cash Flow only (ctx.syncEnabled). Lets the user pick,
        // per table, which categories are computed from transactions.
        if (ctx.syncEnabled) {
            items.push({
                label: 'Sync Settings',
                action: () => showSyncSettings(currentYear, ctx),
            });
        }
        items.push(
            {
                label: 'Duplicate Table',
                action: () => _duplicateYearTable(currentYear, ctx),
            },
            {
                label: 'Delete Table',
                action: () => confirmDelete(currentYear, async () => {
                    await ctx.api.deleteYear(currentYear);
                    ctx.years = ctx.years.filter(y => y !== currentYear);
                    delete ctx.entries[String(currentYear)];
                    outerEl.remove();
                }),
                danger: true,
            }
        );
        openTableMenu(menuBtn, items);
    });
}

/**
 * Duplicate one year's data into a new year. Prompts the user for the
 * target year (must be 4-digit and not already present), POSTs to the
 * backend, then reloads the whole page state so the new table appears
 * sorted correctly with its data populated.
 */
function _duplicateYearTable(sourceYear, ctx) {
    promptAddYear(ctx.years, async targetYear => {
        await ctx.api.duplicateYear(sourceYear, targetYear);
        await reloadYearTables(ctx);
    });
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
        // ── Render one column row (rename input + arrows + type chip + ×) ──
        const renderRow = (col, idx, listLen) => {
            const typeChipHtml = ctx.types
                ? `<button class="col-row-type" data-key="${escapeHtml(col.key)}">${escapeHtml(ctx.types.find(t => t.key === col.type)?.label ?? col.type)}</button>`
                : '';
            return `
                <div class="col-row" data-key="${escapeHtml(col.key)}">
                    <div class="col-row-arrows">
                        <button class="col-arrow-btn ${idx === 0          ? 'col-arrow-disabled' : ''}" data-dir="up">${_CHEVRON_UP}</button>
                        <button class="col-arrow-btn ${idx === listLen-1  ? 'col-arrow-disabled' : ''}" data-dir="down">${_CHEVRON_DOWN}</button>
                    </div>
                    <span class="col-row-label">${escapeHtml(col.label)}</span>
                    <input class="col-row-input" value="${escapeHtml(col.label)}" style="display:none" aria-label="Rename ${escapeHtml(col.label)}">
                    ${typeChipHtml}
                    <button class="col-row-delete" aria-label="Delete ${escapeHtml(col.label)}">×</button>
                </div>`;
        };
        const renderRows = (items) => items.map((c, i) => renderRow(c, i, items.length)).join('');

        // ── Render the list section(s): per-type when typed, flat when not ─
        let sectionsHtml;
        if (ctx.types) {
            sectionsHtml = ctx.types.map(t => {
                const cols = ctx.columns.filter(c => c.type === t.key);
                const heading = t.label + (ctx.typeSectionSuffix || '');
                return `
                    <div class="col-manager-section">
                        <div class="col-type-label">${escapeHtml(heading)}</div>
                        <div class="col-manager-list">
                            ${cols.length ? renderRows(cols) : '<div class="col-empty">None</div>'}
                        </div>
                    </div>`;
            }).join('');
        } else {
            sectionsHtml = `
                <div class="col-manager-section">
                    <div class="col-manager-list">
                        ${ctx.columns.length ? renderRows(ctx.columns) : '<div class="col-empty">No columns yet</div>'}
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

        // ── Reorder (↑ / ↓ arrows). Backend handles type-locking. ──────────
        overlay.querySelectorAll('.col-arrow-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('col-arrow-disabled')) return;
                const key = btn.closest('.col-row').dataset.key;
                await ctx.api.moveColumn(key, btn.dataset.dir);
                await reloadYearTables(ctx);
                buildManager();
            });
        });

        // ── Type chip click → cycle to next type in ctx.types ──────────────
        // For 2-type pages (I&E) this is a simple toggle; for 4-type pages
        // (Balance Sheet) it walks through cash → investment → retirement →
        // debt → cash. Skipped entirely when ctx.types is null (Savings).
        if (ctx.types) {
            overlay.querySelectorAll('.col-row-type').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const key = btn.dataset.key;
                    const col = ctx.columns.find(c => c.key === key);
                    if (!col) return;
                    const idx     = ctx.types.findIndex(t => t.key === col.type);
                    const newType = ctx.types[(idx + 1) % ctx.types.length].key;
                    await ctx.api.updateColumn(key, { type: newType });
                    await reloadYearTables(ctx);
                    buildManager();
                });
            });
        }

        // ── Delete column. If the column has saved data the backend refuses
        // and we re-confirm with confirmColumnDelete before forcing. ───────
        overlay.querySelectorAll('.col-row-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key    = btn.closest('.col-row').dataset.key;
                const col    = ctx.columns.find(c => c.key === key);
                const result = await ctx.api.deleteColumn(key);
                if (!result.ok && result.error === 'has_data') {
                    confirmColumnDelete(col.label, async () => {
                        await ctx.api.deleteColumn(key, true);
                        await reloadYearTables(ctx);
                        buildManager();
                    });
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

// ─── Sync Settings modal (Cash Flow) ─────────────────────────────────────────

// A small switch toggle reused for every category row. Shape mirrors the
// Settings categories switch so the affordance reads consistently.
const _SYNC_SWITCH = (key, on) =>
    `<label class="sync-switch">
        <input type="checkbox" data-key="${escapeHtml(key)}" ${on ? 'checked' : ''}>
        <span class="sync-switch-track"><span class="sync-switch-knob"></span></span>
    </label>`;

/**
 * Open (or toggle closed) the per-table "Sync Settings" modal for one year.
 * Lists every category grouped by type with a switch that controls whether that
 * category's monthly value for THIS year is computed from transactions
 * (synced) or hand-entered. A toolbar offers Sync all / Unsync all.
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
                    <span>Sync — ${year}</span>
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
 *   syncEnabled         bool    — when true, each table's ⋮ menu gets a "Sync
 *                                 Settings" item (per-table category sync) and
 *                                 the backend ships a per-year sync map in
 *                                 /data. Cash Flow only.
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
        // When true, each table's ⋮ menu gets a "Sync Settings" item and the
        // backend ships a per-year sync map. Cash Flow only.
        syncEnabled:         !!opts.syncEnabled,
        // Mutable state — populated by reloadYearTables() in init below.
        columns:   [],
        years:     [],
        entries:   {},
        sync:      {},
        container: null,
    };

    const init = async () => {
        ctx.container = document.querySelector('.db-tables-container');
        await reloadYearTables(ctx);

        // "Add New Year" button — opens the year-prompt modal; on confirm
        // creates the year on the backend, appends a fresh table, then
        // re-sorts so it slots into the correct visual position.
        document.querySelector('.db-actions .button-primary').addEventListener('click', () => {
            const existing = Array.from(ctx.container.querySelectorAll('.db-outer[data-year]'))
                .map(el => parseInt(el.dataset.year))
                .filter(y => !isNaN(y));
            promptAddYear(existing, async newYear => {
                await ctx.api.addYear(newYear);
                ctx.years.push(newYear);
                ctx.entries[String(newYear)] = {};
                const outer = createYearTable(newYear, ctx);
                ctx.container.appendChild(outer);
                initYearTable(outer, {}, ctx);
                sortTables(ctx.container);
            });
        });

        // "Manage Columns" button — opens the (toggleable) column manager.
        // Skipped when the page opts out (I&E manages categories in Settings).
        // querySelector returns null when the button isn't in the template,
        // so an early return covers the I&E case without any explicit flag.
        const manageBtn = document.querySelector('.db-actions .button-secondary');
        if (manageBtn && !ctx.hideColumnManager) {
            manageBtn.addEventListener('click', () => showColumnManager(ctx));
        }
    };

    // Script tags live at the end of <body>, so the DOM is already parsed
    // when this runs. No DOMContentLoaded wait needed.
    init();
}
