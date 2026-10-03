'use strict';

// ─── Portfolio page ─────────────────────────────────────────────────────────
// Unlike Income & Expenses / Balance Sheet / Savings (which use the year-table
// controller in tables.js), Portfolio operates on a fundamentally different
// shape: ACCOUNTS, each holding a list of asset ENTRIES, each entry having
// editable fields (asset name, ticker, amount, avg price, market price) plus
// two computed read-only fields (Total = amount × market_price, ROI).
//
// What this file contains:
//   - Page-wide state (ACCOUNTS)
//   - The portfolio API client (portfolioApi)
//   - Per-account table DOM (forehead with Add/Remove/⋮ buttons, 7-column
//     thead, entry rows, totals tfoot)
//   - Per-row arrow-key navigation (by row + column index, since portfolio rows
//     are not keyed by month like year tables are)
//   - The "Rename Table" / "Delete Table" ⋮ menu and the "Remove Row" modal
//
// What it borrows from tables.js / currency.js (both already loaded):
//   - escapeHtml (core/escape.js); debounce, formatDisplay, applyCommaFormat
//     (core/format.js); UI.openMenu (shell/ui.js)
//   - CURRENCY_SYMBOL, formatCurrency, applyCurrencyFormat, stripCurrencyValue
//     (currency.js — used wherever a value carries the user's currency)
//   - openTableMenu (the ⋮ dropdown)
//   - The shared .db-outer / .db-wrapper / .db-table / .db-title-* /
//     .confirm-* / .p-table-dropdown / .p-menu-btn classes

(function () {
    // Number of editable columns in the asset table.
    // Columns: Asset Name | Ticker | Amount | Avg Price | Market Price | Total | ROI
    const COL_COUNT = 7;

    // Decimal places the Amount column keeps. Amount is a share/unit count, not
    // money: fractional-share brokers sell to 4 places and crypto is quoted
    // finer still, so the 2 places the money columns use would misstate a
    // holding. The backend stores the number unrounded either way.
    const AMOUNT_DP = 4;

    // ─── State ──────────────────────────────────────────────────────────────────
    let ACCOUNTS = [];

    // ─── API client ─────────────────────────────────────────────────────────────
    // Thin wrapper around fetch — identical style to makeYearTableApi in
    // tables.js, just shaped for portfolio's account/entry endpoints. The writes
    // whose results no call site inspects (the debounced cell saves, the
    // deletes) go through guardWrite so a failure surfaces instead of vanishing.
    const portfolioApi = (() => {
        const jsonHeaders = { 'Content-Type': 'application/json' };
        const sendJson = (url, method, body) =>
            apiFetch(url, { method, headers: jsonHeaders, body: JSON.stringify(body) });
        // Toast on failure and resolve { ok: false } instead of rejecting: these
        // calls are fired from debounce() without an await, so a rejection would
        // become an unhandled promise rejection and the failed save would go
        // unreported.
        const guardWrite = (promise) => promise.then(
            (res) => {
                if (res && res.ok === false) {
                    window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
                }
                return res;
            },
            (err) => {
                window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
                return { ok: false, error: String(err?.message || err) };
            },
        );
        return {
            getAll:           ()                  => apiFetch('/api/portfolio/data').then(r => r.json()),
            renameAccount:    (id, name)          => sendJson(`/api/portfolio/account/${id}`, 'PUT', { name }).then(r => r.json()),
            deleteAccount:    (id)                => guardWrite(apiFetch(`/api/portfolio/account/${id}`, { method: 'DELETE' })),
            createAccount:    (name)              => sendJson('/api/portfolio/account', 'POST', { name }).then(r => r.json()),
            createEntry:      (accountId)         => sendJson('/api/portfolio/entry', 'POST', { account_id: accountId }).then(r => r.json()),
            updateEntry:      (id, patch)         => guardWrite(sendJson(`/api/portfolio/entry/${id}`, 'PUT', patch)),
            deleteEntry:      (id)                => guardWrite(apiFetch(`/api/portfolio/entry/${id}`, { method: 'DELETE' })),
        };
    })();

    // ─── Bootstrap ──────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', async () => {
        await loadAndRender();
        document.querySelector('.db-actions .button-primary').addEventListener('click', addAccount);
    });

    /** Fetch every account + entry from the backend and render the page. */
    async function loadAndRender() {
        const data = await portfolioApi.getAll();
        ACCOUNTS   = data.accounts;
        renderTables();
        renderSummary({ animate: true });
    }

    // ─── Allocation donut ───────────────────────────────────────────────────────
    // One slice per account, sized by its market value (sum of amount × market
    // price). Colours walk the grey balance ramp in account order: an account is
    // an identity rather than a magnitude, and holdings are money held still, the
    // same reading the Dashboard's Balances donut gives that ramp. Colour follows
    // the account's place in the page, not its size, so a slice keeps its colour
    // while the figures change under it.
    const BALANCE_RAMP_SIZE = 8;
    const BALANCE_FALLBACK = [
        '#4e5153', '#5c5f61', '#6a6d70', '#787b7e',
        '#878a8d', '#989b9e', '#a9acaf', '#bcbfc2',
    ];

    function readBalanceRamp() {
        const cs = getComputedStyle(document.documentElement);
        return BALANCE_FALLBACK.map((fallback, i) =>
            cs.getPropertyValue(`--chart-balance-${i + 1}`).trim() || fallback);
    }

    const accountMarketValue = (account) =>
        account.entries.reduce((sum, e) => sum + (e.amount || 0) * (e.market_price || 0), 0);

    /** Redraw the donut and its legend from ACCOUNTS. `animate` is true for the
     *  first paint and false for edits, so typing never replays the sweep. */
    function renderSummary({ animate }) {
        const pieEl    = document.getElementById('portfolio-pie');
        const legendEl = document.getElementById('portfolio-legend');
        const ramp     = readBalanceRamp();

        const slices = ACCOUNTS
            .map((account, i) => ({
                label:  account.name,
                color:  ramp[i % BALANCE_RAMP_SIZE],
                value:  accountMarketValue(account),
            }))
            .filter(s => s.value > 0)
            .map(s => ({ ...s, valueText: formatCurrency(s.value, true) }));

        const total = slices.reduce((sum, s) => sum + s.value, 0);
        if (total === 0) {
            pieEl.style.display = 'none';
            pieEl.innerHTML = '';
            legendEl.innerHTML = UI.emptyState({
                icon: null, compact: true,
                title: 'No holdings to chart yet',
            });
            return;
        }

        pieEl.style.display = '';
        DonutChart.render(pieEl, {
            slices,
            centerLabel: 'Total',
            centerValue: formatCurrency(total, true),
            animate,
        });

        legendEl.innerHTML = slices.map(s => `
            <div class="accounts-legend-item">
                <span class="accounts-legend-dot" style="background:${escapeHtml(s.color)}"></span>
                <div class="accounts-legend-text">
                    <div class="accounts-legend-head">
                        <div class="accounts-legend-label">${escapeHtml(s.label)}</div>
                        <div class="accounts-legend-pct">${((s.value / total) * 100).toFixed(1)}%</div>
                    </div>
                    <div class="accounts-legend-value">${escapeHtml(s.valueText)}</div>
                </div>
            </div>`).join('');
    }

    // Typing in a price or amount changes a slice on every keystroke; coalesce
    // the redraws the same way the saves are.
    const refreshSummaryAfterEdit = debounce(() => renderSummary({ animate: false }), 250);

    /** Rebuild the tables container from ACCOUNTS. Order matches the API response. */
    function renderTables() {
        const container = document.querySelector('.db-tables-container');
        container.innerHTML = '';
        // Only the first account opens expanded; the rest start collapsed so a
        // long list of accounts doesn't push the first one's assets off screen.
        ACCOUNTS.forEach((account, i) => {
            container.appendChild(buildTable(account, { collapsed: i > 0 }));
        });
    }

    // ─── Table builder ──────────────────────────────────────────────────────────
    /**
     * Build the DOM for one account's table. Mirrors the year-table shell from
     * tables.js (db-outer > db-wrapper > db-table > thead+tbody+tfoot) but with
     * a portfolio-specific 7-column header and forehead button bar:
     *
     *   forehead: [account name] ………………… [+ Add Row] [− Remove Row] [⋮]
     *
     * Selecting the ⋮ menu opens Rename Table / Duplicate Table / Delete Table.
     */
    function buildTable(account, { collapsed = false } = {}) {
        const outer = document.createElement('div');
        outer.className = 'db-outer';
        outer.dataset.accountId = account.id;

        const wrapper = document.createElement('div');
        wrapper.className = 'db-wrapper';
        outer.appendChild(wrapper);

        const table = document.createElement('table');
        table.className = 'db-table portfolio-table';
        wrapper.appendChild(table);

        // ── thead row 1: forehead — account name + button group ────────────────
        const thead = document.createElement('thead');

        const titleRow = document.createElement('tr');
        titleRow.className = 'db-title-row';
        const titleTh = document.createElement('th');
        titleTh.colSpan = COL_COUNT;
        const titleInner = document.createElement('div');
        titleInner.className = 'db-title-inner';

        // The account name is a static span — editing happens via the ⋮ menu's
        // "Rename Table" option (which opens a dedicated dialog), not inline.
        // This keeps the forehead UI consistent across all spreadsheet pages.
        const nameSpan = document.createElement('span');
        nameSpan.className = 'db-title-label';
        nameSpan.textContent = account.name;

        // The chevron is the keyboard-reachable toggle; a click anywhere on the
        // forehead (outside the button group) does the same, handled below.
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'p-collapse-btn';
        collapseBtn.title = 'Collapse or expand';
        collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        outer.classList.toggle('is-collapsed', collapsed);
        collapseBtn.setAttribute('aria-label', 'Collapse or expand account');
        collapseBtn.innerHTML = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path></svg>';

        const titleLeft = document.createElement('div');
        titleLeft.className = 'p-title-left';
        titleLeft.append(collapseBtn, nameSpan);
        titleInner.appendChild(titleLeft);

        // ── Right-aligned button group: [+ Add] [− Remove] [⋮] ─────────────────
        const btnGroup = document.createElement('div');
        btnGroup.className = 'p-forehead-btns';

        const addBtn = document.createElement('button');
        addBtn.className   = 'button-secondary';
        addBtn.textContent = '+ Add Row';
        addBtn.addEventListener('click', () => addEntry(account.id, wrapper));
        btnGroup.appendChild(addBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'button-secondary';
        removeBtn.textContent = '− Remove Row';
        removeBtn.addEventListener('click', () => showRemoveEntryModal(account, wrapper));
        btnGroup.appendChild(removeBtn);

        const menuBtn = document.createElement('button');
        menuBtn.className   = 'button-icon p-menu-btn';
        menuBtn.textContent = '⋮';
        menuBtn.title       = 'Table options';
        menuBtn.addEventListener('click', e => {
            e.stopPropagation();
            openAccountMenu(account, menuBtn, nameSpan);
        });
        btnGroup.appendChild(menuBtn);

        titleInner.appendChild(btnGroup);
        titleTh.appendChild(titleInner);
        titleRow.appendChild(titleTh);
        titleRow.addEventListener('click', e => {
            if (e.target.closest('.p-forehead-btns')) return;
            const collapsed = outer.classList.toggle('is-collapsed');
            collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        });
        thead.appendChild(titleRow);

        // ── thead row 2: column headers ────────────────────────────────────────
        const headerRow = document.createElement('tr');
        headerRow.className = 'db-header-row';
        [
            ['Asset Name', 'col-asset-name'],
            ['Ticker',     'col-ticker'],
            ['Amount',     'col-number'],
            ['Avg Price',  'col-number'],
            ['Mkt Price',  'col-number'],
            ['Total',      'col-number'],
            ['ROI',        'col-roi'],
        ].forEach(([label, cls]) => {
            const th = document.createElement('th');
            th.textContent = label;
            th.className   = cls;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // ── tbody: one row per asset entry ─────────────────────────────────────
        const tbody = document.createElement('tbody');
        for (const entry of account.entries) {
            tbody.appendChild(buildEntryRow(entry, account.id, wrapper));
        }
        table.appendChild(tbody);

        // ── tfoot: per-account totals (amount, market value, portfolio ROI) ────
        table.appendChild(buildTfootEl(account.entries));

        // Spreadsheet-style multi-cell selection (drag / Shift+arrow → copy,
        // paste, delete), layered on by cellselect.js. All seven columns are
        // selectable/copyable; the two computed cells (Total, ROI) have no input
        // so they're skipped on paste/delete. Writes go through synthetic `input`
        // events that re-run each field's save + computed-field refresh, so the
        // existing per-row persistence path is reused unchanged. Only tbody rows
        // are scanned, so the totals tfoot is never part of a selection.
        if (window.enableCellSelection) {
            enableCellSelection(table, { cellSelector: 'td' });
        }

        return outer;
    }

    // ─── ⋮ account options menu ─────────────────────────────────────────────────

    /**
     * Open the ⋮ dropdown for an account. Rename Table is meaningful here because
     * the account name is user-controlled (year tables can't be renamed because
     * the year IS the identifier).
     */
    function openAccountMenu(account, menuBtn, nameSpan) {
        UI.openMenu(menuBtn, [
            { label: 'Rename Table', action: () => renameAccountDialog(account, nameSpan) },
            { label: 'Delete Table', action: () => confirmDeleteAccount(account), danger: true },
        ]);
    }

    /**
     * Modal asking for a new account name. Pre-fills the current name, commits on
     * Enter or the Rename button, cancels on Escape or the Cancel button.
     *
     * nameSpan.textContent is updated directly on success so the visible header
     * label changes without a full page re-render.
     */
    function renameAccountDialog(account, nameSpan) {
        const { overlay, close } = UI.dialog(`
            <p>Rename account:</p>
            <input class="p-rename-input" type="text" value="${escapeHtml(account.name)}" />
            <div class="confirm-actions">
                <button class="button-secondary confirm-cancel">Cancel</button>
                <button class="button-primary confirm-add">Rename</button>
            </div>`);

        const input = overlay.querySelector('.p-rename-input');
        input.focus();
        input.select();

        const commit = async () => {
            const name = input.value.trim();
            if (name && name !== account.name) {
                const result = await portfolioApi.renameAccount(account.id, name);
                if (result.ok) {
                    account.name = name;
                    nameSpan.textContent = name;
                    renderSummary({ animate: false });
                }
            }
            close();
        };

        overlay.querySelector('.confirm-add').addEventListener('click', commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        });
    }

    // ─── Arrow-key navigation ───────────────────────────────────────────────────
    //
    // Portfolio rows aren't keyed by month like year tables, so we navigate by
    // (row index, column index) instead. colIdx 0–4 covers the five editable
    // inputs (asset name through market price). Total and ROI cells are computed
    // read-only spans and are skipped.

    function wireNav(input, tr, wrapper, colIdx) {
        input.dataset.colIdx = String(colIdx);
        input.addEventListener('keydown', e => {
            const rows   = Array.from(wrapper.querySelectorAll('tbody tr'));
            const rowIdx = rows.indexOf(tr);
            let tRow = tr, tCol = colIdx;

            if (e.key === 'Enter' || e.key === 'ArrowDown') {
                tRow = rows[rowIdx + 1];
            } else if (e.key === 'ArrowUp') {
                tRow = rows[rowIdx - 1];
            } else if (e.key === 'ArrowRight') {
                tCol = colIdx + 1;
            } else if (e.key === 'ArrowLeft') {
                tCol = colIdx - 1;
            } else {
                return;
            }

            if (!tRow) return;
            const next = tRow.querySelector(`[data-col-idx="${tCol}"]`);
            if (!next) return;
            e.preventDefault();
            next.focus();
            next.select();
        });
    }

    // ─── Entry row ──────────────────────────────────────────────────────────────

    /**
     * Build one asset row. Each editable field has a debounced save, so there is
     * not one PUT per keystroke. The numeric fields share a single debouncedSave
     * that batches amount + price + market_price into one PUT.
     *
     * Two computed read-only cells (Total, ROI) update synchronously inside
     * updateComputed(): they are derived from the three numeric fields and refresh
     * on every keystroke rather than on the debounced save.
     *
     * After any numeric change, refreshFooter() also updates the table's tfoot so
     * the per-account totals stay in sync.
     */
    function buildEntryRow(entry, accountId, wrapper) {
        const tr = document.createElement('tr');
        tr.dataset.entryId = entry.id;

        // — Asset Name (colIdx 0) —
        const nameTd = document.createElement('td');
        nameTd.className = 'col-asset-name';
        const nameInput = document.createElement('input');
        nameInput.type        = 'text';
        nameInput.className   = 'p-input p-text-input';
        nameInput.value       = entry.asset_name;
        nameInput.placeholder = 'Asset name';
        const saveAssetName = debounce(async val => {
            entry.asset_name = val;
            await portfolioApi.updateEntry(entry.id, { asset_name: val });
        }, 600);
        nameInput.addEventListener('input', () => saveAssetName(nameInput.value));
        wireNav(nameInput, tr, wrapper, 0);
        nameTd.appendChild(nameInput);
        tr.appendChild(nameTd);

        // — Ticker (colIdx 1) —
        // Always uppercased on save; the input's value is rewritten to the
        // uppercase form so the field shows the stored text.
        const tickerTd = document.createElement('td');
        tickerTd.className = 'col-ticker';
        const tickerInput = document.createElement('input');
        tickerInput.type        = 'text';
        tickerInput.className   = 'p-input p-ticker-input';
        tickerInput.value       = entry.ticker;
        tickerInput.placeholder = 'TICK';
        const saveTicker = debounce(async val => {
            const upper = val.toUpperCase();
            tickerInput.value = upper;
            entry.ticker = upper;
            await portfolioApi.updateEntry(entry.id, { ticker: upper });
        }, 600);
        tickerInput.addEventListener('input', () => saveTicker(tickerInput.value));
        wireNav(tickerInput, tr, wrapper, 1);
        tickerTd.appendChild(tickerInput);
        tr.appendChild(tickerTd);

        // — Amount / Avg Price / Mkt Price (colIdx 2, 3, 4) —
        // Amount is a *count of shares/units*, not a currency value, so it gets
        // plain comma formatting (makeNumberWrap(.., .., false)) and AMOUNT_DP
        // decimals instead of the money default of 2 — fractional shares and
        // crypto are held to more places than cents. The price columns are
        // currency and carry the user's chosen symbol as part of their input
        // value (makeNumberWrap(.., .., true)).
        const amountTd = document.createElement('td');
        amountTd.className = 'col-number';
        const amountWrap = makeNumberWrap(entry.amount, '0', false, AMOUNT_DP);
        const amountInp  = amountWrap.querySelector('input');
        wireNav(amountInp, tr, wrapper, 2);
        amountTd.appendChild(amountWrap);
        tr.appendChild(amountTd);

        const avgTd = document.createElement('td');
        avgTd.className = 'col-number';
        const avgWrap = makeNumberWrap(entry.price, '0.00', true);
        const avgInp  = avgWrap.querySelector('input');
        wireNav(avgInp, tr, wrapper, 3);
        avgTd.appendChild(avgWrap);
        tr.appendChild(avgTd);

        const mktTd = document.createElement('td');
        mktTd.className = 'col-number';
        const mktWrap = makeNumberWrap(entry.market_price, '0.00', true);
        const mktInp  = mktWrap.querySelector('input');
        wireNav(mktInp, tr, wrapper, 4);
        mktTd.appendChild(mktWrap);
        tr.appendChild(mktTd);

        // — Total (computed, read-only) —
        const totalTd = document.createElement('td');
        totalTd.className = 'col-number';
        const totalSpan = document.createElement('span');
        totalSpan.className = 'p-computed';
        totalTd.appendChild(totalSpan);
        tr.appendChild(totalTd);

        // — ROI (computed, read-only) —
        const roiTd = document.createElement('td');
        roiTd.className = 'col-roi';
        const roiSpan = document.createElement('span');
        roiSpan.className = 'p-computed';
        roiTd.appendChild(roiSpan);
        tr.appendChild(roiTd);

        /**
         * Recompute Total (= amount × market_price) and ROI (= % change from
         * avg price). Also writes the parsed numbers back into `entry` so the
         * debouncedSave below picks up the latest values.
         *
         * Inputs are read via stripCurrencyValue() because the price inputs
         * carry the currency symbol in their value (e.g. "$1,234"). For the
         * Amount input (no symbol) stripCurrencyValue is still safe — it just
         * strips commas.
         */
        const updateComputed = () => {
            const amount = parseFloat(stripCurrencyValue(amountInp.value)) || 0;
            const avg    = parseFloat(stripCurrencyValue(avgInp.value))    || 0;
            const mkt    = parseFloat(stripCurrencyValue(mktInp.value))    || 0;
            entry.amount       = amount;
            entry.price        = avg;
            entry.market_price = mkt;

            const total = amount * mkt;
            // Total is currency — formatCurrency() bakes in the user's symbol.
            totalSpan.textContent = total ? formatCurrency(total) : '';

            if (avg && mkt) {
                const roi = ((mkt - avg) / avg) * 100;
                roiSpan.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                roiSpan.className   = 'p-computed ' + (roi >= 0 ? 'roi-positive' : 'roi-negative');
            } else {
                roiSpan.textContent = '';
                roiSpan.className   = 'p-computed';
            }

            // Refresh the account's tfoot totals — they depend on this row.
            const account = ACCOUNTS.find(a => a.id === accountId);
            if (account) refreshFooter(wrapper, account.entries);
        };

        updateComputed();

        // Single debounced PUT that batches all three numeric fields. We don't
        // need separate save handlers because the backend accepts partial PUTs.
        const debouncedSave = debounce(async () => {
            await portfolioApi.updateEntry(entry.id, {
                amount:       entry.amount,
                price:        entry.price,
                market_price: entry.market_price,
            });
        }, 600);

        // The Amount input is unit-count, no symbol → applyCommaFormat.
        // The two price inputs carry the symbol → applyCurrencyFormat.
        amountInp.addEventListener('input', () => {
            clampDecimals(amountInp, AMOUNT_DP);
            applyCommaFormat(amountInp);
            updateComputed();
            refreshSummaryAfterEdit();
            debouncedSave();
        });
        [avgInp, mktInp].forEach(inp => {
            inp.addEventListener('input', () => {
                applyCurrencyFormat(inp);
                updateComputed();
                refreshSummaryAfterEdit();
                debouncedSave();
            });
        });

        return tr;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Build a number-input wrapper for a portfolio cell.
     *
     *   value       — initial numeric value (or null/0 for blank)
     *   placeholder — placeholder text shown when the input is empty
     *   isCurrency  — true for the price inputs (the cell shows the user's
     *                 currency symbol prefix); false for the Amount column
     *                 (unit count, no symbol)
     *   decimals    — decimal places for a non-currency value (formatDisplay's
     *                 default of 2 when omitted); ignored when isCurrency,
     *                 where the currency setting decides
     *
     * The wrapper used to contain a separate .p-currency-sym span next to the
     * input. That has been removed — when isCurrency is true, the symbol is
     * baked directly into input.value via formatCurrency() at render time and
     * maintained by applyCurrencyFormat() on every keystroke.
     */
    /**
     * Drop anything typed past `max` decimal places, keeping the caret where it
     * was. Runs before applyCommaFormat so the formatter (and the value that
     * gets saved) never sees more precision than the cell displays — otherwise
     * a 6-decimal entry would be stored in full and then re-render rounded on
     * the next load.
     */
    function clampDecimals(input, max) {
        const dot = input.value.indexOf('.');
        if (dot === -1 || input.value.length - dot - 1 <= max) return;
        const pos = input.selectionStart;
        input.value = input.value.slice(0, dot + 1 + max);
        const clamped = Math.min(pos, input.value.length);
        input.setSelectionRange(clamped, clamped);
    }

    function makeNumberWrap(value, placeholder, isCurrency, decimals) {
        const wrap = document.createElement('div');
        wrap.className = 'p-number-wrap';
        const input = document.createElement('input');
        input.type        = 'text';
        input.inputMode   = 'decimal';
        input.className   = 'p-input';
        // Currency inputs render as "$1,234.56"; non-currency (Amount) renders
        // as a plain comma-formatted number. formatDisplay strips trailing
        // ".00" for whole numbers in both cases.
        if (value) {
            input.value = isCurrency ? formatCurrency(value, true, { editable: true }) : formatDisplay(value, decimals);
        } else {
            input.value = '';
        }
        input.placeholder = placeholder;
        wrap.appendChild(input);
        return wrap;
    }

    // ─── Footer (per-account totals) ────────────────────────────────────────────

    /**
     * Build the totals tfoot row. The structure mirrors a normal entry row so
     * the columns align: "Total" label, blank ticker, summed amount, blank
     * avg/mkt cells, summed market value, and a portfolio-level ROI.
     *
     * Portfolio ROI = (sum(market value) − sum(cost basis)) / sum(cost basis)
     *               × 100, where cost basis = amount × avg_price.
     */
    function buildFooterRow(entries) {
        const tr = document.createElement('tr');
        tr.className = 'portfolio-total-row';

        // "Total" label — first column.
        const labelTd = document.createElement('td');
        labelTd.className = 'col-asset-name portfolio-footer-label';
        labelTd.textContent = 'Total';
        tr.appendChild(labelTd);

        // Ticker column intentionally blank in the total row.
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'col-ticker' }));

        // Amount — straight sum of all entry amounts.
        const totalAmt = entries.reduce((s, e) => s + (e.amount || 0), 0);
        const amtTd = document.createElement('td');
        amtTd.className = 'col-number';
        amtTd.innerHTML = `<span class="p-computed">${totalAmt ? formatDisplay(totalAmt, AMOUNT_DP) : ''}</span>`;
        tr.appendChild(amtTd);

        // Avg / Mkt price columns are blank: a single figure here would require
        // weighting by amount, which the column header does not describe.
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'col-number' }));
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'col-number' }));

        // Total market value = sum(amount × market_price) across entries.
        // formatCurrency() prefixes the user's chosen symbol; escapeHtml() is
        // belt-and-suspenders here because the symbol came from localStorage
        // and a hostile user could in theory set it to something like '<img>'.
        const totalVal = entries.reduce((s, e) => s + (e.amount || 0) * (e.market_price || 0), 0);
        const totalTd  = document.createElement('td');
        totalTd.className = 'col-number';
        totalTd.innerHTML = `<span class="p-computed">${totalVal ? escapeHtml(formatCurrency(totalVal, true)) : ''}</span>`;
        tr.appendChild(totalTd);

        // Portfolio ROI = (market value − cost basis) / cost basis × 100.
        // Cost basis is sum(amount × avg_price) — what we paid for everything.
        const totalCost = entries.reduce((s, e) => s + (e.amount || 0) * (e.price || 0), 0);
        const roiTd = document.createElement('td');
        roiTd.className = 'col-roi';
        if (totalCost && totalVal) {
            const roi = ((totalVal - totalCost) / totalCost) * 100;
            roiTd.innerHTML = `<span class="p-computed ${roi >= 0 ? 'roi-positive' : 'roi-negative'}">${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%</span>`;
        }
        tr.appendChild(roiTd);

        return tr;
    }

    function buildTfootEl(entries) {
        const tfoot = document.createElement('tfoot');
        tfoot.appendChild(buildFooterRow(entries));
        return tfoot;
    }

    /** Replace the table's existing tfoot in-place with a freshly-computed one. */
    function refreshFooter(wrapper, entries) {
        const old = wrapper.querySelector('tfoot');
        if (old) old.replaceWith(buildTfootEl(entries));
    }

    // ─── Add / remove operations ────────────────────────────────────────────────

    /**
     * Append a new (blank) asset row to an account. The backend creates the
     * entry with default values and returns the full entry shape; we just
     * append a fresh row to the DOM rather than re-rendering.
     */
    async function addEntry(accountId, wrapper) {
        const data = await portfolioApi.createEntry(accountId);
        if (!data.ok) return;
        const account = ACCOUNTS.find(a => a.id === accountId);
        if (account) account.entries.push(data.entry);
        wrapper.querySelector('tbody').appendChild(buildEntryRow(data.entry, accountId, wrapper));
        refreshFooter(wrapper, account ? account.entries : []);
        renderSummary({ animate: false });
    }

    /** Create a new account on the backend and append its empty table. */
    async function addAccount() {
        const data = await portfolioApi.createAccount('New Account');
        if (!data.ok) return;
        ACCOUNTS.push(data.account);
        document.querySelector('.db-tables-container').appendChild(buildTable(data.account));
        renderSummary({ animate: false });
    }

    /**
     * Modal showing the account's entries as a selectable list. Selecting one
     * enables the Remove button; clicking Remove issues a DELETE and surgically
     * removes the row + refreshes the totals.
     *
     * This is one of two ways to delete an entry — the other is the per-row
     * delete inside the column manager, which doesn't apply to portfolio. The
     * modal form is preferred here because there are no inline × buttons in
     * the row UI (would clutter an already-busy 7-column row).
     */
    function showRemoveEntryModal(account, wrapper) {
        const entries = account.entries;

        // Nothing to pick from: the shared picker's empty form, one Close button.
        if (!entries.length) {
            UI.dialog(`
                <p><strong>No assets to remove</strong></p>
                <div class="confirm-actions">
                    <button class="button-secondary confirm-cancel">Close</button>
                </div>`, { className: 'pick-dialog' });
            return;
        }

        const rowsHtml = entries.map(e => {
            const value = (e.amount || 0) * (e.market_price || 0);
            return `<label class="pick-row">
                <input type="checkbox" class="pick-cb" data-id="${e.id}">
                <span class="pick-text">
                    <span class="pick-name">${escapeHtml(e.asset_name || 'Unnamed')}</span>
                    <span class="pick-detail">${escapeHtml(e.ticker || '—')}</span>
                </span>
                <span class="pick-amount">${value ? escapeHtml(formatCurrency(value, true)) : ''}</span>
            </label>`;
        }).join('');

        // The multi-select dialog shared with Detect Schedules (picker.css). It
        // has no Cancel button: the dialog's × and Escape already close it.
        const { overlay, close } = UI.dialog(`
            <p><strong>Select assets to remove</strong></p>
            <label class="pick-all">
                <input type="checkbox" id="p-remove-all">
                <span>Select all (${entries.length})</span>
            </label>
            <div class="pick-list">${rowsHtml}</div>
            <div class="confirm-actions">
                <button class="db-btn db-btn-danger confirm-delete" disabled>Remove selected</button>
            </div>`, { className: 'pick-dialog' });

        const allBox    = overlay.querySelector('#p-remove-all');
        const boxes     = [...overlay.querySelectorAll('.pick-cb')];
        const removeBtn = overlay.querySelector('.confirm-delete');
        const checked   = () => boxes.filter(b => b.checked);

        // Remove with nothing ticked has nothing to do, so the button is disabled
        // rather than left to do nothing on click.
        const syncState = () => {
            const n = checked().length;
            allBox.checked       = n === boxes.length;
            allBox.indeterminate = n > 0 && n < boxes.length;
            removeBtn.disabled   = n === 0;
            removeBtn.textContent = n ? `Remove ${n} row${n === 1 ? '' : 's'}` : 'Remove selected';
        };

        allBox.addEventListener('change', () => {
            boxes.forEach(b => { b.checked = allBox.checked; });
            syncState();
        });
        overlay.querySelector('.pick-list').addEventListener('change', syncState);

        removeBtn.addEventListener('click', async () => {
            const ids = checked().map(b => parseInt(b.dataset.id, 10));
            if (ids.length === 0) return;
            const selectedIds = new Set(ids);
            close();
            await Promise.all(ids.map(id => portfolioApi.deleteEntry(id)));
            account.entries = account.entries.filter(e => !selectedIds.has(e.id));
            for (const id of ids) {
                wrapper.querySelector(`tr[data-entry-id="${id}"]`)?.remove();
            }
            refreshFooter(wrapper, account.entries);
            renderSummary({ animate: false });
        });
    }

    /**
     * Modal confirming deletion of an entire account. The portfolio equivalent of
     * confirmDelete() in tables.js, with the account name in the message (the name
     * is user-controlled, so it is escapeHtml'd).
     */
    async function confirmDeleteAccount(account) {
        const ok = await UI.confirm({
            message: `<p>Remove account <strong>${escapeHtml(account.name)}</strong> and all its assets?<br>This cannot be undone.</p>`,
            confirmLabel: 'Remove',
        });
        if (!ok) return;
        await portfolioApi.deleteAccount(account.id);
        ACCOUNTS = ACCOUNTS.filter(a => a.id !== account.id);
        document.querySelector(`.db-outer[data-account-id="${account.id}"]`)?.remove();
        renderSummary({ animate: false });
    }
}());
