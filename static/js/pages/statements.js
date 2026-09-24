'use strict';

// ─── Statements page ────────────────────────────────────────────────────────
// Cash Flow and Balance Sheet merged behind two tabs, with everything on ONE
// toolbar row: tabs left; ‹ year › stepper dead-center; the two actions right.
//
// The tables are implemented entirely in tables.js; this file starts one
// year-table controller per tab (each scoped to its container via the *Selector
// opts) and adds the page chrome on top:
//
//   • an ARIA tablist that swaps the visible panel;
//   • the year stepper: prev/next walk the union of years across both
//     datasets (oldest → newest); the selected year is applied to BOTH
//     containers by toggling [hidden] on the .db-outer[data-year] cards;
//   • the two toolbar actions, on the row on both tabs: Manage Years (add /
//     renumber / remove) and Manage Columns (the categories editor and the
//     balance-sheet column editor as two panels of one modal, one per sheet,
//     opened on the panel for the current tab). Both act across BOTH datasets,
//     driven through the handles bootstrapYearTablePage returns.
//
// tables.js re-renders a container wholesale after column edits / year
// operations, so year visibility is re-applied via a MutationObserver on the
// two containers rather than by threading callbacks through tables.js.

// ── Boot the two year-table controllers ─────────────────────────────────────

// Cash Flow tab (formerly the /income-expenses page).
const cashflowTable = bootstrapYearTablePage({
    apiPrefix: '/api',
    types: [
        { key: 'income',    label: 'Income' },
        { key: 'expense',   label: 'Expense' },
        { key: 'transfer',  label: 'Transfer' },
    ],
    includeTotals:      true,
    hideColumnManager:  true,
    containerSelector:  '#stmt-tables-cashflow',
    addYearBtnSelector: null,   // page-owned: Manage Years fills BOTH datasets
});

// Balance Sheet tab (formerly the /balance-sheet page).
const balanceTable = bootstrapYearTablePage({
    apiPrefix: '/api/balance',
    types: [
        { key: 'cash',       label: 'Cash' },
        { key: 'investment', label: 'Investment' },
        { key: 'retirement', label: 'Retirement' },
        { key: 'debt',       label: 'Debt' },
    ],
    typeSectionSuffix:     ' Accounts',
    includeTotals:         false,
    itemNoun:              'account',   // "Add account", "3 accounts", …
    containerSelector:     '#stmt-tables-balance',
    addYearBtnSelector:    null,   // page-owned: Manage Years fills BOTH datasets
    manageColsBtnSelector: null,   // page-owned: a panel of the Manage Columns modal
});

// ── Page controller: toolbar tabs, year stepper, actions ───────────────────

(function () {
    const CONTROLLERS = [cashflowTable, balanceTable];

    const TABS = [
        {
            id:        'cashflow',
            label:     'Cash Flow',
            tab:       document.getElementById('stmt-tab-cashflow'),
            panel:     document.getElementById('stmt-panel-cashflow'),
            container: document.getElementById('stmt-tables-cashflow'),
            empty:     document.getElementById('stmt-empty-cashflow'),
        },
        {
            id:        'balance',
            label:     'Balance Sheet',
            tab:       document.getElementById('stmt-tab-balance'),
            panel:     document.getElementById('stmt-panel-balance'),
            container: document.getElementById('stmt-tables-balance'),
            empty:     document.getElementById('stmt-empty-balance'),
        },
    ];

    // ── Toolbar elements + year state ────────────────────────────────────────
    const prevBtn    = document.getElementById('stmt-year-prev');
    const nextBtn    = document.getElementById('stmt-year-next');
    const yearLabel  = document.getElementById('stmt-year-label');
    const yearsBtn   = document.getElementById('stmt-years-btn');
    const columnsBtn = document.getElementById('stmt-columns-btn');

    let years     = [];       // union across both containers, oldest first
    let current   = -1;       // index into years (-1 = no years yet)
    let activeTab = TABS[0];  // decides which panel Manage Columns opens on

    // ── Tabs (standard ARIA tablist with roving tabindex) ───────────────────
    function selectTab(active, focus) {
        activeTab = active;
        TABS.forEach(t => {
            const on = t === active;
            t.tab.classList.toggle('active', on);
            t.tab.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tab.tabIndex = on ? 0 : -1;
            t.panel.hidden = !on;
        });
        if (focus) active.tab.focus();
    }

    const tablist = document.querySelector('.stmt-tabs');
    tablist.addEventListener('click', e => {
        const t = TABS.find(x => x.tab === e.target.closest('.stmt-tab'));
        if (t) selectTab(t);
    });
    tablist.addEventListener('keydown', e => {
        const i = TABS.findIndex(t => t.tab === document.activeElement);
        if (i < 0) return;
        let j = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = TABS.length - 1;
        if (j >= 0) { e.preventDefault(); selectTab(TABS[j], true); }
    });

    // Deep link: /statements#balance-sheet lands on the Balance Sheet tab
    // (Dashboard's "Add balances" CTA uses it).
    selectTab(location.hash === '#balance-sheet' ? TABS[1] : TABS[0]);

    // ── Year stepper ─────────────────────────────────────────────────────────
    const unionYears = () => {
        const set = new Set();
        TABS.forEach(t => t.container.querySelectorAll('.db-outer[data-year]')
            .forEach(el => set.add(parseInt(el.dataset.year))));
        return [...set].sort((a, b) => a - b);
    };

    // Show only the current year's card in each container, surface the
    // per-tab empty hint when that year has no table there, and sync the
    // stepper label + arrow affordances.
    function applyYear() {
        const year = years[current];
        prevBtn.disabled  = (current <= 0);
        nextBtn.disabled  = (current < 0 || current >= years.length - 1);
        UI.setPickerLabel(yearLabel, (year === undefined) ? '—' : String(year));
        TABS.forEach(t => {
            let has = false;
            t.container.querySelectorAll('.db-outer[data-year]').forEach(el => {
                const on = parseInt(el.dataset.year) === year;
                el.hidden = !on;
                if (on) has = true;
            });
            t.empty.hidden = has;
            if (!has) {
                t.empty.textContent = (year === undefined)
                    ? 'No years yet — use "Manage Years" to start.'
                    : `No ${t.label} table for ${year} yet — use "Manage Years" to create it.`;
            }
        });
    }

    function go(i) {
        if (i < 0 || i >= years.length || i === current) return;
        current = i;
        applyYear();
    }

    prevBtn.addEventListener('click', () => go(current - 1));
    nextBtn.addEventListener('click', () => go(current + 1));

    // The label opens a picker of every statement year, newest first, with
    // the visible one marked as current.
    yearLabel.addEventListener('click', e => {
        e.stopPropagation();
        if (!years.length) return;
        UI.openMenu(yearLabel, [...years].reverse().map(y => ({
            label: String(y),
            selected: y === years[current],
            action: () => go(years.indexOf(y)),
        })));
    });

    // ── "Manage Columns" modal ──────────────────────────────────────────────
    // ONE modal for both statements' columns, because they are one editor over
    // two datasets: identical .cat-* markup, cards, search, inline rename,
    // quiet delete and grip drag-and-drop. A segmented switch under the header
    // swaps the panel, so moving from one sheet's columns to the other's costs
    // a click rather than closing one modal and opening another.
    //
    // A panel is named and keyed after the statement sheet it edits, so the
    // switch says which sheet a change lands on and `active` is simply the tab
    // the button was pressed on:
    //
    //   Cash Flow — its columns ARE the categories, but they are edited by the
    //     SHARED categories editor (settingsCategories.js), not the year-table
    //     column editor, because category edits also drive the Transactions
    //     ledger dropdown. Its root carries [data-categories-editor], which is
    //     both what the editor mounts into and what categories.css styles.
    //   Balance Sheet — the year-table column editor, handed over by the
    //     controller as a ready-made panel (tables.js columnEditor).
    //
    // Panels mount on first view, so opening on one side never fetches the
    // other. Closing reloads the Cash Flow tables when that panel was opened:
    // renames, reorders and deletes there change the Cash Flow columns, while
    // the column editor already re-renders its own tables as it goes.
    const CATEGORIES_TIP = 'Categories group your transactions and appear as rows in your '
        + 'Cash Flow statement. Drag a category by its handle to reorder it — the '
        + 'order here sets the Cash Flow row order.\n\nDeletion is blocked when '
        + 'transactions or stored values still reference a category — reassign first.';

    function showColumnsManager() {
        let cashflowTouched = false;

        openManagerModal({
            title:     'Manage Columns',
            className: 'col-manager-overlay',
            active:    activeTab.id,
            panels: [
                {
                    id:    'cashflow',
                    label: 'Cash Flow',
                    tip:   CATEGORIES_TIP,
                    mount: (panel) => {
                        cashflowTouched = true;
                        const root = document.createElement('div');
                        root.setAttribute('data-categories-editor', '');
                        panel.appendChild(root);
                        mountCategoriesEditor(root);
                    },
                },
                {
                    id:    'balance',
                    label: 'Balance Sheet',
                    tip:   balanceTable.columnEditor.tip,
                    mount: balanceTable.columnEditor.mount,
                },
            ],
            onClose: () => { if (cashflowTouched) cashflowTable.reload(); },
        });
    }

    // ── Year operations — a statement year spans BOTH datasets ──────────────
    // Every action applies to the year in each dataset that holds it, so a
    // year only one tab has is still renumbered or removed in full.
    const withYear = (year, fn) => CONTROLLERS
        .filter(c => c.hasYear(year))
        .reduce((p, c) => p.then(() => fn(c)), Promise.resolve());
    const reloadAll = () => Promise.all(CONTROLLERS.map(c => c.reload()));

    // ── "Manage Years" modal ────────────────────────────────────────────────
    // The one place years are added, renumbered and removed. It is a
    // single-panel openManagerModal wearing the same shell and the same .cat-*
    // rows as the Manage Columns editors, so the two modals read alike.
    //
    // A year is LOCKED when the ledger holds transactions dated in it. Those
    // cells are computed from the transactions (the per-cell data-source rule
    // in handlers/incomeExpenses.js), so renumbering the table would move the
    // label and nothing else: both years would refill from the rows, which
    // stay where they are. Removing one would drop a table the ledger fills
    // again the moment the year is re-added. Locked rows therefore show the
    // year, its ledger count and a lock glyph in the slot the delete × takes
    // on the others — the same treatment settingsCategories.js gives the
    // built-in categories.
    //
    // A year with no transactions holds nothing but typed-in values, so it
    // takes an inline renumber and a delete.
    //
    // The list is rebuilt from scratch after every change (it is small and
    // rarely touched), which keeps the row wiring in one place.

    // Same glyphs as the two column editors (tables.js / settingsCategories.js),
    // so the affordances read identically across all three.
    const ICON_X    = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const ICON_PLUS = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const ICON_LOCK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.25" y="7" width="9.5" height="6.25" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.5"/></svg>';

    // Stacks the delete confirmation above the manager, which stays open
    // behind it (.confirm-overlay is z-index 1000).
    const CONFIRM_Z = 1100;

    const LOCK_TIP  = 'Has transactions, so it can’t be renumbered or removed';
    const countText = (n) => `${n} ${n === 1 ? 'transaction' : 'transactions'}`;

    /** Ledger rows per calendar year: { '2024': 132 }. Years with none are absent. */
    const loadTxYears = () => apiFetch('/api/transactions/years').then(res => {
        if (!res.ok) throw new Error(`transaction years: ${res.status}`);
        return res.json();
    }).then(body => body.years || {});

    /** The year a fresh row should take: the one after the newest, or this
     *  calendar year when there are none, walking up past any year already
     *  taken. Null when there is no free year left below the 9999 cap. */
    function nextFreeYear(taken) {
        let year = taken.length ? Math.max(...taken) + 1 : new Date().getFullYear();
        while (year <= 9999 && taken.includes(year)) year++;
        return year <= 9999 ? year : null;
    }

    const YEARS_TIP = 'Years listed here are the statement’s own: each one is a Cash '
        + 'Flow table and a Balance Sheet table.\n\nA year with transactions in '
        + 'the ledger is locked, because its cells are computed from those '
        + 'transactions rather than typed in. Removing a year erases the values '
        + 'typed into its two tables; transactions are never touched.';

    const showYearManager = () => openManagerModal({
        title:     'Manage Years',
        className: 'year-manager-overlay',
        panels:    [{ id: 'years', label: 'Years', tip: YEARS_TIP, mount: mountYearEditor }],
    });

    function mountYearEditor(panel, modal) {
        panel.innerHTML = `
            <div class="cat-editor">
                <section class="cat-group">
                    <div class="cat-group-body">
                        <div class="cat-list"><div class="cat-empty">Loading…</div></div>
                        <button type="button" class="cat-add-row" aria-label="Add year" disabled>${ICON_PLUS} Add year</button>
                    </div>
                </section>
            </div>`;

        const list   = panel.querySelector('.cat-list');
        const addBtn = panel.querySelector('.cat-add-row');
        let txYears  = {};   // { '2024': 132 } — ledger rows per year

        // Every value below is a year parsed from the DOM (an integer) or a
        // count from the backend, so none of it needs escaping.
        const renderRow = (year) => {
            const count = txYears[String(year)] || 0;
            if (count) {
                return `
                <div class="cat-row year-row year-row-locked" data-year="${year}">
                    <span class="cat-name cat-name-static year-value">${year}</span>
                    <span class="year-count">${countText(count)}</span>
                    <span class="cat-lock" role="img" title="${LOCK_TIP}" aria-label="${year}: ${LOCK_TIP}">${ICON_LOCK}</span>
                </div>`;
            }
            return `
                <div class="cat-row year-row" data-year="${year}">
                    <input type="number" class="cat-name year-value" value="${year}"
                           min="1000" max="9999" aria-label="Year ${year}">
                    <button class="cat-icon-btn cat-delete" title="Remove year"
                            aria-label="Remove ${year}">${ICON_X}</button>
                </div>`;
        };

        // Brief red border on a rejected year (outside 1000-9999, or one the
        // statement already has). The input has already snapped back, so this
        // is what shows the edit did not take.
        const flashInvalid = (input) => {
            input.classList.add('invalid');
            setTimeout(() => input.classList.remove('invalid'), 1200);
        };

        // There is no rename endpoint: renumbering is duplicate-into-the-new-
        // year + delete-the-old, in each dataset that holds the year.
        const renumber = async (input, from) => {
            const to = parseInt(input.value, 10);
            if (to === from) return;
            if (!(to >= 1000 && to <= 9999) || unionYears().includes(to)) {
                input.value = String(from);
                flashInvalid(input);
                return;
            }
            await withYear(from, async c => {
                await c.api.duplicateYear(from, to);
                await c.api.deleteYear(from);
            });
            await reloadAll();
            await refresh();
        };

        const remove = (year) => confirmDelete(year, async () => {
            await withYear(year, c => c.api.deleteYear(year));
            await reloadAll();
            await refresh();
        }, { zIndex: CONFIRM_Z });

        // Rows come from the rendered tables, so a caller that changed them
        // reloads those first.
        const build = () => {
            const rows = unionYears().sort((a, b) => b - a);
            list.innerHTML = rows.map(renderRow).join('')
                || '<div class="cat-empty">No years yet</div>';

            list.querySelectorAll('.year-row:not(.year-row-locked)').forEach(row => {
                const year  = parseInt(row.dataset.year, 10);
                const input = row.querySelector('.year-value');
                // Commit on blur; Enter commits through it, Escape restores.
                input.addEventListener('blur', () => renumber(input, year));
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter')  input.blur();
                    if (e.key === 'Escape') { input.value = String(year); input.blur(); }
                });
                row.querySelector('.cat-delete').addEventListener('click', () => remove(year));
            });
        };

        // Re-read the ledger counts and rebuild. A failure closes the modal:
        // without the counts the list cannot say which years are locked, and
        // offering a renumber that the data forbids is worse than no list.
        const refresh = () => loadTxYears().then(counts => {
            txYears = counts;
            addBtn.disabled = false;
            build();
        }, () => {
            window.UI?.toast?.("Couldn't read your years. Nothing has changed.", { type: 'error' });
            modal.close();
        });

        // Adding mirrors the column manager's "Add column": the year is
        // created straight away with a sensible value and its input focused,
        // so renumbering it is the same edit as renumbering any other row.
        // The tables already carry the new year, so only the counts are
        // re-read.
        addBtn.addEventListener('click', async () => {
            const year = nextFreeYear(unionYears());
            if (year === null) return;
            addBtn.disabled = true;
            for (const c of CONTROLLERS) {
                if (!c.hasYear(year)) await c.addYear(year);
            }
            await refresh();
            const input = list.querySelector(`.year-row[data-year="${year}"] .year-value`);
            if (input) { input.focus(); input.select(); }
        });

        refresh();
    }

    // ── Toolbar actions ─────────────────────────────────────────────────────
    // Both are on the row on both tabs: the tab decides which panel Manage
    // Columns opens on, not whether the button is there. Each opens a modal
    // that toggles, so a second click on the same button closes it.
    yearsBtn.addEventListener('click', showYearManager);
    columnsBtn.addEventListener('click', showColumnsManager);

    // Recompute the year list from the DOM after tables.js (re)renders.
    // Selection policy: first data → newest year; a year that just appeared
    // (added or renumbered in Manage Years) → jump to it; otherwise keep the
    // current year, falling back to the nearest slot if it was removed.
    function rebuild() {
        const prevSet  = new Set(years);
        const prevYear = years[current];
        years = unionYears();

        const added = years.filter(y => !prevSet.has(y));
        if (!years.length)                 current = -1;
        else if (!prevSet.size)            current = years.length - 1;
        else if (added.length)             current = years.indexOf(Math.max(...added));
        else if (years.includes(prevYear)) current = years.indexOf(prevYear);
        else current = Math.min(Math.max(current, 0), years.length - 1);

        applyYear();
    }

    // Coalesce the burst of mutations a full re-render produces into one
    // rebuild, timed before paint so hidden years never flash.
    let queued = false;
    function scheduleRebuild() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; rebuild(); });
    }

    const observer = new MutationObserver(scheduleRebuild);
    TABS.forEach(t => observer.observe(t.container, { childList: true }));

    // Fresh database: no table ever lands, the observer never fires — this
    // delayed pass still surfaces the "No years yet" hint. Harmlessly
    // idempotent when data already arrived.
    setTimeout(scheduleRebuild, 800);
}());
