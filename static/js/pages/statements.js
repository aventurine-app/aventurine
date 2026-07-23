'use strict';

// ─── Statements page ────────────────────────────────────────────────────────
// Cash Flow and Balance Sheet merged behind two tabs, with everything on ONE
// toolbar row: tabs left; ‹ year › stepper dead-center; the ⋮ menu right.
//
// The tables are still owned end-to-end by tables.js — this file boots one
// year-table controller per tab (each scoped to its own container via the
// *Selector opts) and layers the page chrome on top:
//
//   • an ARIA tablist that swaps the visible panel;
//   • the year stepper: prev/next walk the union of years across both
//     datasets (oldest → newest); the selected year is applied to BOTH
//     containers by toggling [hidden] on the .db-outer[data-year] cards;
//   • the ⋮ menu, the single home for every action (all of them are
//     rare-use, so progressive disclosure keeps the toolbar to three
//     elements): Add New Year always; Manage Categories on the Cash Flow
//     tab (the shared categories editor in a modal); Manage Columns on the
//     Balance Sheet tab; Edit Year / Delete Year when a year is selected —
//     the year operations apply across BOTH datasets, driven through the
//     handles bootstrapYearTablePage returns.
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
    addYearBtnSelector: null,   // page-owned: Add New Year fills BOTH datasets
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
    addYearBtnSelector:    null,   // page-owned: Add New Year fills BOTH datasets
    manageColsBtnSelector: null,   // page-owned: lives in the ⋮ menu
});

// ── Page controller: toolbar tabs, year stepper, ⋮ menu ─────────────────────

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
    const prevBtn   = document.getElementById('stmt-year-prev');
    const nextBtn   = document.getElementById('stmt-year-next');
    const yearLabel = document.getElementById('stmt-year-label');
    const menuBtn   = document.getElementById('stmt-menu-btn');

    let years     = [];       // union across both containers, oldest first
    let current   = -1;       // index into years (-1 = no years yet)
    let activeTab = TABS[0];  // the ⋮ menu's contents depend on the tab

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
    // (Home's "Add balances" CTA uses it).
    selectTab(location.hash === '#balance-sheet' ? TABS[1] : TABS[0]);

    // ── "Add New Year" — one statement year spans BOTH datasets ─────────────
    // A statement year is a Cash Flow table AND a Balance Sheet table, so the
    // ⋮ menu item creates the year in every dataset that lacks it. Validating
    // against years present in *both* lets the same prompt backfill a year
    // that only one dataset has.
    function promptAddYearEverywhere() {
        const existing = years.filter(y => CONTROLLERS.every(c => c.hasYear(y)));
        promptAddYear(existing, async newYear => {
            for (const c of CONTROLLERS) {
                if (!c.hasYear(newYear)) await c.addYear(newYear);
            }
        });
    }

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
        yearLabel.textContent = (year === undefined) ? '—' : String(year);
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
                    ? 'No years yet — use "Add New Year" in the ⋮ menu to start.'
                    : `No ${t.label} table for ${year} yet — use "Add New Year" in the ⋮ menu to create it.`;
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

    // ── "Manage Categories" modal (Cash Flow tab) ────────────────────────────
    // The Cash Flow columns ARE the categories, but they're managed by the
    // shared categories editor (settingsCategories.js) — not the year-table
    // column manager — because category edits also drive the Transactions
    // ledger dropdown. The Balance Sheet's showColumnManager (tables.js)
    // builds this same .cat-manager shell + .cat-* editor markup, so the two
    // ⋮-menu managers look identical. Same shell behavior too: toggle if
    // already open, close on × or backdrop; the editor mounts into a
    // [data-categories-editor] root. Closing reloads the Cash Flow tables so
    // renames/reorders/deletes land in the columns immediately.
    function showCategoriesManager() {
        const existing = document.querySelector('.cat-manager-overlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay cat-manager-overlay';
        const tip = 'Categories group your transactions and appear as rows in your '
            + 'Cash Flow statement. Drag a category by its handle to reorder it — the '
            + 'order here sets the Cash Flow row order.\n\nDeletion is blocked when '
            + 'transactions or stored values still reference a category — reassign first.';
        overlay.innerHTML = `
            <div class="cat-manager">
                <div class="cat-manager-header">
                    <span>Manage Categories<span class="fc-info" tabindex="0" role="note"
                        aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">i</span></span>
                    <button class="cat-manager-close" aria-label="Close">×</button>
                </div>
                <div class="cat-manager-body">
                    <div data-categories-editor></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const close = () => {
            overlay.remove();
            cashflowTable.reload();
        };
        overlay.querySelector('.cat-manager-close').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        mountCategoriesEditor(overlay.querySelector('[data-categories-editor]'));
    }

    // ── ⋮ menu: Add New Year + per-tab manager + year ops ───────────────────
    // The year operations act on the year across BOTH datasets.
    const withYear = (year, fn) => CONTROLLERS
        .filter(c => c.hasYear(year))
        .reduce((p, c) => p.then(() => fn(c)), Promise.resolve());
    const reloadAll = () => Promise.all(CONTROLLERS.map(c => c.reload()));

    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        const year = years[current];
        const items = [{
            label: 'Add New Year',
            action: promptAddYearEverywhere,
        }];
        if (activeTab.id === 'cashflow') {
            items.push({
                label: 'Manage Categories',
                action: showCategoriesManager,
            });
        }
        if (activeTab.id === 'balance') {
            items.push({
                label: 'Manage Columns',
                action: () => balanceTable.manageColumns(),
            });
        }
        if (year !== undefined) {
            items.push(
                {
                    // There is no rename endpoint; renumbering is duplicate-
                    // into-the-new-year + delete-the-old, per dataset that
                    // has it.
                    label: 'Edit Year',
                    action: () => promptAddYear(years, async newYear => {
                        await withYear(year, async c => {
                            await c.api.duplicateYear(year, newYear);
                            await c.api.deleteYear(year);
                        });
                        await reloadAll();
                    }, {
                        message: `Change <strong>${year}</strong> to:`,
                        confirmLabel: 'Save',
                    }),
                },
                {
                    label: 'Delete Year',
                    action: () => confirmDelete(year, async () => {
                        await withYear(year, c => c.api.deleteYear(year));
                        await reloadAll();
                    }),
                    danger: true,
                }
            );
        }
        UI.openMenu(menuBtn, items);
    });

    // Recompute the year list from the DOM after tables.js (re)renders.
    // Selection policy: first data → newest year; a year that just appeared
    // (Add New Year / Edit Year) → jump to it; otherwise keep the current
    // year, falling back to the nearest slot if it was deleted everywhere.
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
