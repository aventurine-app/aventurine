'use strict';

(function () {
    // ─── Budgets ────────────────────────────────────────────────────────────
    // One circle per budgeted category, floating in a field that pulls them all
    // toward the middle. The circle's AREA is the target the user set; the
    // level it is filled to is how much of that target the shown month has
    // already reached. An empty ring means nothing has moved in that category
    // yet.
    //
    // TWO KINDS OF CIRCLE, and the difference is the direction of the category
    // behind it (schema.js categories.cat_type):
    //   expense  — a ceiling. Green while the spend is inside the target, red
    //              once it is past it.
    //   transfer — Savings, Investing, and any other category the user files
    //              under the transfer direction. Money put away rather than
    //              money gone. Drawn in the app's blue at EVERY level in every
    //              month, and never graded.
    //
    // WHY A PUT-AWAY CIRCLE CARRIES NO VERDICT. A red spending circle names a
    // limit that was passed, which is a fact whatever else happened that month.
    // Coming up short on a savings target is not the same kind of fact: the
    // month may still be running, and a transfer the import has not categorized
    // yet is money that moved but reads here as money that did not. Colouring
    // that amber would state a shortfall the data cannot support. The figures
    // are printed inside every circle, so a short month is legible without one.
    // Grading how much a user saves is the Metrics tab's job, against the
    // savings-rate and invested-share goals (services/reportCard.js).
    //
    // WHERE THE TWO NUMBERS COME FROM
    //   target — GET /api/budgets (handlers/budgets.js). ONE figure per
    //            category, applied to every month, so stepping to another month
    //            never changes a circle's size. That is the point: the circles
    //            are the shape of the plan, and only the fill moves.
    //   spent  — the Cash Flow statement (Store 'ie' → GET /api/data), read one
    //            cell at a time. The statement is the blend point — a cell is
    //            computed from transactions unless the user typed over it — so a
    //            month the user has corrected by hand reads here exactly as it
    //            reads on Statements and on Spending Trends. Aggregating the
    //            ledger separately would let this page and those two disagree
    //            about what a month cost.
    //
    // ONLY BUDGETED CATEGORIES GET A CIRCLE. A category with no target, or one
    // set to zero, is left off the field entirely. There is no size for it (the
    // circle is the target) and no fraction for it to be part of, so it drew as
    // a minimum-size dashed ring that said only "not this one" — a row of them
    // priced the same as the real answer. Spending in an unbudgeted category is
    // still on Statements and Spending Trends, which is where a page about
    // spending belongs; this page is about the plan.
    //
    // WHAT A TRANSFER CELL DOES NOT SAY. The schema records a transfer as an
    // amount with a direction, not as a pair of accounts (the v7 accounts work
    // was reverted), so money coming back OUT of savings adds to the same cell
    // as money going in. Saved & Invested (handlers/transfers.js) and the
    // Metrics tab both accept this and say so; a third definition of saving
    // would put this page at odds with both, which costs more than the
    // imprecision does.
    //
    // Clicking any circle opens Set Budget with that category's field focused,
    // so the circle is where its own target is edited, and Set Budget still
    // lists EVERY budgetable category — that is how a category gets its first
    // target and its first circle.
    //
    // COLOUR SAYS TWO THINGS, AND ONLY TWO. Blue or green is the KIND of
    // promise (put away / spend), and the green-to-red shift is the verdict.
    // Only spending circles ever shift. Circles carried a colour each at first,
    // off the app's categorical ramp; it made eleven hues to learn before the
    // page said anything, and the category name is already printed inside every
    // circle, so the hue was decoration standing where a verdict could be.
    // All of that lives in budgets.css — this file sets no colours, it only
    // picks the class.
    //
    // Globals (loaded before this script): apiFetch (api.js), escapeHtml
    // (escape.js), formatCurrency / applyCurrencyFormat / stripCurrencyValue
    // (currency.js), Store (store.js), UI (ui.js), BubbleField
    // (bubblefield.js), MonthStepper (monthstepper.js).

    const MONTHS = MonthStepper.MONTHS;

    const state = {
        statement: null,      // GET /api/data
        budgets: new Map(),   // category key -> target amount
        field: null,          // BubbleField controller
        stepper: null,
    };

    const els = {};

    // ─── Data ───────────────────────────────────────────────────────────────

    /** Statement columns of one direction, in the user's own order — the same
     *  order and the same source the Cash Flow statement's columns come from. */
    function columnsOfType(type) {
        return (state.statement?.columns || []).filter((col) => col.type === type);
    }

    /** Every category that may hold a target, spending first. The backend takes
     *  the same two directions (BUDGETABLE_CAT_TYPES in handlers/budgets.js). */
    function budgetableColumns() {
        return [...columnsOfType('expense'), ...columnsOfType('transfer')];
    }

    /** One month's statement cells, keyed by category. */
    function cellsForMonth({ year, monthIdx }) {
        const months = (state.statement?.entries || {})[String(year)] || {};
        return months[MONTHS[monthIdx]] || {};
    }

    // ─── Expected income ────────────────────────────────────────────────────
    // What the Set Budget dialog measures the targets against. It is COMPUTED,
    // never asked for: the statement already holds every month of income the
    // user has, so a form field for it would ask for a figure the app can read.
    //
    // The median of the trailing complete months, not the mean and not the last
    // one: a bonus month or a short month moves a mean and replaces a "last
    // month" outright, and neither is what the user earns in a normal month.

    const INCOME_MONTHS = 6;

    /** Total income recorded against one month's cells. */
    function incomeForMonth(cells) {
        let total = 0;
        for (const col of columnsOfType('income')) total += cells[col.key] || 0;
        return total;
    }

    /** Months as a single comparable ordinal, so recency needs no date parsing. */
    function monthOrdinal(year, monthIdx) {
        return year * 12 + monthIdx;
    }

    /**
     * Income for each of the last INCOME_MONTHS COMPLETE months that recorded
     * any, most recent first.
     *
     * The month in progress is excluded: it is a part-month, and counting it
     * would read as a pay cut every time the page is opened before payday. A
     * month with no income at all is skipped rather than counted as zero — it
     * is a month that was never imported, the same clamp the Forecast and
     * Spending Trends apply at the near end of coverage.
     */
    function incomeHistory() {
        const entries = state.statement?.entries || {};
        const now = new Date();
        const thisMonth = monthOrdinal(now.getFullYear(), now.getMonth());
        const months = [];

        for (const [yearStr, cellsByMonth] of Object.entries(entries)) {
            const year = Number(yearStr);
            if (!Number.isFinite(year)) continue;
            for (let monthIdx = 0; monthIdx < MONTHS.length; monthIdx++) {
                const ordinal = monthOrdinal(year, monthIdx);
                if (ordinal >= thisMonth) continue;
                const total = incomeForMonth(cellsByMonth[MONTHS[monthIdx]] || {});
                if (total > 0) months.push({ ordinal, total });
            }
        }

        months.sort((a, b) => b.ordinal - a.ordinal);
        return months.slice(0, INCOME_MONTHS).map((m) => m.total);
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /** Expected income for a normal month, or 0 when no complete month has any.
     *  Zero is the "nothing to measure against" case, and the dialog drops its
     *  income row and its total rather than showing every target as an
     *  overspend of an income of nothing. */
    function expectedMonthlyIncome() {
        return median(incomeHistory());
    }

    async function loadBudgets() {
        const response = await apiFetch('/api/budgets');
        if (!response.ok) throw new Error(`budgets: ${response.status}`);
        const body = await response.json();
        state.budgets = new Map((body.budgets || []).map((b) => [b.category, b.amount]));
    }

    // ─── Circles ────────────────────────────────────────────────────────────

    /**
     * The circles for the month on the stepper: one per BUDGETED category, in
     * the user's own category order.
     *
     * `value` is what BubbleField sizes by, and it is the TARGET, never the
     * amount reached: a category the user overspent must not grow a circle for
     * it.
     */
    function buildNodes() {
        const cells = cellsForMonth(state.stepper.value());
        const nodes = [];
        for (const col of budgetableColumns()) {
            const target = state.budgets.get(col.key) || 0;
            if (target <= 0) continue;
            const away = col.type === 'transfer';
            // The statement can hold a negative cell (a refund the user typed
            // in, or a month whose transfers net out backwards). Below zero is
            // not progress toward a target, so it floors at nothing rather than
            // reading as credit.
            const actual = Math.max(cells[col.key] || 0, 0);
            nodes.push({
                key: col.key,
                label: col.label,
                value: target,
                target,
                actual,
                away,
                share: Math.min(actual / target, 1),
                // Put away is never over: passing a savings target is not a
                // thing to report, so only spending carries the verdict.
                over: !away && actual > target,
            });
        }
        return nodes;
    }

    /** What a screen reader says for one circle. Every circle has a target, so
     *  there is always a figure to be out of. */
    function describe(node) {
        const of = `${formatCurrency(node.actual)} of ${formatCurrency(node.target)}`;
        if (node.away) return `${node.label}: ${of} put away`;
        return node.over ? `${node.label}: ${of}, over budget` : `${node.label}: ${of}`;
    }

    /** Fill one circle in. Called on data changes only, never per frame. */
    function paintBubble(el, node) {
        el.className = 'bud-bubble'
            // Blue rather than green, and no verdict class will follow.
            + (node.away ? ' bud-bubble-away' : '')
            + (node.over ? ' bud-bubble-over' : '')
            // Nothing moved yet: the "empty" state, a bare ring with no
            // waterline drawn across its bottom.
            + (node.actual > 0 ? '' : ' bud-bubble-empty');
        // How far up the circle the fill reaches. The colour it is drawn in is
        // the stylesheet's, keyed off the classes above.
        el.style.setProperty('--bud-fill', `${node.share * 100}%`);

        const label = describe(node);
        el.title = label;
        el.setAttribute('aria-label', label);

        el.innerHTML = `
            <span class="bud-bubble-fill" aria-hidden="true"></span>
            <span class="bud-bubble-text" aria-hidden="true">
                <span class="bud-bubble-name">${escapeHtml(node.label)}</span>
                <span class="bud-bubble-spent">${escapeHtml(formatCurrency(node.actual))}</span>
                <span class="bud-bubble-target">/ ${escapeHtml(formatCurrency(node.target))}</span>
            </span>`;
    }

    // ─── Render ─────────────────────────────────────────────────────────────

    function render() {
        const columns = budgetableColumns();
        const nodes = buildNodes();
        // Read off the nodes, not off the stored targets: a target left behind
        // by a deleted category would otherwise count as something to draw and
        // leave an empty field on screen.
        const empty = nodes.length === 0;

        els.empty.hidden = !empty;
        els.field.hidden = empty;
        els.empty.innerHTML = empty
            ? UI.emptyState({
                icon: 'target',
                title: columns.length ? 'No budgets set' : 'No expense categories yet',
                action: columns.length
                    ? { label: 'Set Budget', name: 'set-budget', icon: 'target', primary: true }
                    : { label: 'Open Statements', href: '/statements', primary: true },
            })
            : '';
        if (empty) return;

        // setData measures the field, so it runs only once the element is
        // visible — hiding it above would measure zero.
        state.field.setData(nodes);
    }

    // ─── Set Budget ─────────────────────────────────────────────────────────
    // Every budgetable category and its target in one dialog, saved in one
    // write. Clearing a field (or typing 0) removes that category's target —
    // the backend treats a zero as "no target", which is the same thing the
    // circles draw.
    //
    // THREE SECTIONS, in the order the plan is made: the income the month has
    // to work with, what is put away out of it, then what is spent. Income is a
    // read-only figure (see expectedMonthlyIncome) rather than a field, so the
    // dialog stays a list of decisions with one fact at the top of it.
    //
    // The unallocated figure in the footer is what makes the sections worth
    // having: it is income minus every target in the dialog, live on each
    // keystroke, so the leftover is visible while the decision is being made
    // rather than after the save. It goes negative when the targets outrun the
    // income, which is a real state and is shown as one.

    let modalOpen = false;

    /** One category's row. `key` is the payload's category and is what the
     *  circles are keyed by, so a click on a circle can focus its own row. */
    function rowHtml(col) {
        const target = state.budgets.get(col.key) || 0;
        const value = target > 0 ? formatCurrency(target, false, { editable: true }) : '';
        return `<label class="bud-row">
            <span class="bud-row-name">${escapeHtml(col.label)}</span>
            <input type="text" class="bud-row-input" inputmode="decimal"
                data-category="${escapeHtml(col.key)}"
                value="${escapeHtml(value)}"
                placeholder="${escapeHtml(CURRENCY_SYMBOL)}"
                spellcheck="false" autocomplete="off">
        </label>`;
    }

    function sectionHtml(title, columns) {
        if (!columns.length) return '';
        return `<p class="bud-section">${escapeHtml(title)}</p>`
            + columns.map(rowHtml).join('');
    }

    function modalRowsHtml(income) {
        const incomeRow = income > 0
            ? `<p class="bud-section">Expected income</p>
               <div class="bud-row">
                   <span class="bud-row-name">Monthly</span>
                   <span class="bud-row-figure">${escapeHtml(formatCurrency(income))}</span>
               </div>`
            : '';
        return incomeRow
            + sectionHtml('Savings & Investing', columnsOfType('transfer'))
            + sectionHtml('Spending', columnsOfType('expense'));
    }

    // The income the open dialog is measuring against. Held for the lifetime of
    // the dialog so every keystroke does not re-scan the statement.
    let modalIncome = 0;

    /** Income minus every target currently typed into the dialog. Reads the
     *  inputs rather than the saved set, so it tracks edits before they land. */
    function paintUnallocated() {
        if (els.modalTotal.hidden) return;
        let allocated = 0;
        for (const input of els.modalBody.querySelectorAll('.bud-row-input')) {
            const amount = parseFloat(stripCurrencyValue(input.value));
            if (Number.isFinite(amount)) allocated += amount;
        }
        const left = modalIncome - allocated;
        els.modalTotalValue.textContent = formatCurrency(left);
        els.modalTotalValue.classList.toggle('bud-modal-total-over', left < 0);
    }

    function openModal(focusKey) {
        modalIncome = expectedMonthlyIncome();
        els.modalBody.innerHTML = modalRowsHtml(modalIncome);
        els.modalTotal.hidden = modalIncome <= 0;
        paintUnallocated();
        els.modalError.hidden = true;
        els.modalSave.disabled = false;
        els.modal.hidden = false;
        modalOpen = true;

        const focused = focusKey
            ? els.modalBody.querySelector(`[data-category="${CSS.escape(focusKey)}"]`)
            : els.modalBody.querySelector('.bud-row-input');
        if (focused) { focused.focus(); focused.select(); }
    }

    function closeModal() {
        els.modal.hidden = true;
        modalOpen = false;
    }

    /** Read the dialog into the payload the backend takes. Every row is sent,
     *  including the blank ones, so clearing a field really does clear the
     *  target rather than silently leaving the old one in place. */
    function collectBudgets() {
        const rows = [];
        for (const input of els.modalBody.querySelectorAll('.bud-row-input')) {
            const raw = stripCurrencyValue(input.value);
            const amount = raw === '' ? 0 : parseFloat(raw);
            if (!Number.isFinite(amount) || amount < 0) {
                input.classList.add('invalid');
                return null;
            }
            input.classList.remove('invalid');
            rows.push({ category: input.dataset.category, amount });
        }
        return rows;
    }

    async function saveModal() {
        const budgets = collectBudgets();
        if (!budgets) {
            els.modalError.textContent = 'Enter an amount of 0 or more.';
            els.modalError.hidden = false;
            return;
        }

        els.modalSave.disabled = true;
        els.modalError.hidden = true;
        try {
            const response = await apiFetch('/api/budgets', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ budgets }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `save failed (${response.status})`);
            // The response carries the stored set, so the page never has to
            // guess what landed.
            state.budgets = new Map((body.budgets || []).map((b) => [b.category, b.amount]));
            closeModal();
            render();
        } catch (err) {
            els.modalError.textContent = err.message;
            els.modalError.hidden = false;
            els.modalSave.disabled = false;
        }
    }

    // ─── Wiring ─────────────────────────────────────────────────────────────

    function wire() {
        els.stepper = document.getElementById('bud-month');
        els.field = document.getElementById('bud-field');
        els.empty = document.getElementById('bud-empty');
        els.setBtn = document.getElementById('bud-set-btn');
        els.modal = document.getElementById('bud-modal');
        els.modalBody = document.getElementById('bud-modal-body');
        els.modalTotal = document.getElementById('bud-modal-total');
        els.modalTotalValue = document.getElementById('bud-modal-total-value');
        els.modalError = document.getElementById('bud-modal-error');
        els.modalSave = document.getElementById('bud-modal-save');

        state.stepper = MonthStepper.create(els.stepper, {
            label: 'Budget month',
            yearOptions: () => state.statement?.years || [],
            // Only the fill moves: the targets are the same in every month, so
            // the circles keep their sizes and their places as the months step.
            onChange: render,
        });

        state.field = BubbleField.create(els.field, {
            paint: paintBubble,
            onActivate: (node) => openModal(node.key),
        });

        els.setBtn.addEventListener('click', () => openModal(null));
        els.empty.addEventListener('click', (e) => {
            if (e.target.closest('[data-empty-action="set-budget"]')) openModal(null);
        });

        els.modalSave.addEventListener('click', saveModal);
        document.getElementById('bud-modal-cancel').addEventListener('click', closeModal);
        document.getElementById('bud-modal-close').addEventListener('click', closeModal);
        // Click on the scrim, not on the dialog it frames.
        els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
        els.modalBody.addEventListener('input', (e) => {
            if (!e.target.classList.contains('bud-row-input')) return;
            applyCurrencyFormat(e.target);
            e.target.classList.remove('invalid');
            paintUnallocated();
        });
        document.addEventListener('keydown', (e) => {
            if (!modalOpen) return;
            if (e.key === 'Escape') closeModal();
            // Enter anywhere in the field list saves, the way a form would.
            else if (e.key === 'Enter' && e.target.classList.contains('bud-row-input')) saveModal();
        });

        // The figures are formatted at render time, so a currency change
        // repaints in place rather than needing a reload. A THEME change needs
        // no listener: the circles take their colour from CSS tokens, which the
        // swap re-points on its own.
        window.addEventListener('currencychange', render);

        // An import or an edit made on another page invalidates 'ie'; redraw
        // when the fresh statement lands.
        Store.subscribe('ie', (data) => {
            state.statement = data;
            state.stepper.refresh();
            render();
        });
    }

    async function init() {
        wire();

        const cancelSkeleton = UI.skeletonGuard(() => {
            els.empty.hidden = false;
            els.empty.innerHTML = UI.skRows(4);
        });
        try {
            // Independent reads — the statement is cached and shared with the
            // other pages, the targets are this page's own.
            const [statement] = await Promise.all([Store.ensure('ie'), loadBudgets()]);
            state.statement = statement;
        } catch (err) {
            // A locked database (423) or a refused route (402) lands here; the
            // shell puts its own prompt over the page, so this only has to leave
            // something coherent underneath.
            console.error('[budgets] could not load', err);
            state.statement = { years: [], entries: {}, columns: [] };
        }
        cancelSkeleton();
        els.empty.innerHTML = '';
        state.stepper.refresh();
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
}());
