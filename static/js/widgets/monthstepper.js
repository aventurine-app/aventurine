'use strict';

// ─── monthstepper.js ────────────────────────────────────────────────────────
// The app's month control: ‹ arrow, a year picker, a month picker, › arrow.
// The arrows walk one month at a time and roll over the year boundary; the two
// pickers reach any month the ledger holds in two clicks, however far back it
// goes. The future is never a month to look at, so forward stops at the current
// calendar month and the years offered stop at this one.
//
//   const stepper = MonthStepper.create(container, {
//       label: 'Budget month',
//       yearOptions: () => [2026, 2025],   // newest first; today's is added
//       onChange: ({ year, monthIdx }) => …,
//   });
//   stepper.value();   // { year, monthIdx }
//   stepper.refresh(); // re-read yearOptions() and repaint the labels
//
// The markup is built here rather than in each page's HTML so the stepper has
// one definition. It draws with the shared .stepper chrome (ui.css) and opens
// its menus through UI.openMenu (shell/ui.js), the same as every other picker
// in the app.
//
// LIFTED FROM the Dashboard's "Month to Month" stepper, which still carries its
// own copy inline (static/js/pages/dashboard.js), as does the Recurring page's
// simpler single-label variant. This file is where those two should eventually
// fold in; it was written as a widget rather than a third page-local copy so
// there is somewhere for them to go.
//
// Globals it needs (loaded before it): UI (shell/ui.js), escapeHtml is not
// required — every string it writes is a number or a month name from the list
// below.

(function () {
    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];

    /** The month the app opens on: the current one, month-to-date. */
    function currentMonth() {
        const now = new Date();
        return { year: now.getFullYear(), monthIdx: now.getMonth() };
    }

    /** The last month a year can offer. The current year stops at today's
     *  month; every earlier year runs to December. */
    function lastMonthIdxOfYear(year) {
        const now = new Date();
        return year === now.getFullYear() ? now.getMonth() : 11;
    }

    function isFuture({ year, monthIdx }) {
        const now = new Date();
        return year * 12 + monthIdx >= now.getFullYear() * 12 + now.getMonth();
    }

    function create(container, { label = 'Month', yearOptions = () => [], onChange } = {}) {
        let month = currentMonth();

        container.classList.add('stepper', 'stepper-joined');
        container.setAttribute('aria-label', label);
        container.innerHTML = `
            <button type="button" class="stepper-btn button-primary" data-step="-1"
                aria-label="Previous month">&#8249;</button>
            <span class="stepper-picker">
                <button type="button" class="stepper-label" data-pick="year" aria-live="polite"
                    aria-haspopup="menu" title="Choose year">&nbsp;</button>
            </span>
            <span class="stepper-picker">
                <button type="button" class="stepper-label" data-pick="month" aria-live="polite"
                    aria-haspopup="menu" title="Choose month">&nbsp;</button>
            </span>
            <button type="button" class="stepper-btn button-primary" data-step="1"
                aria-label="Next month">&#8250;</button>`;

        const prevBtn = container.querySelector('[data-step="-1"]');
        const nextBtn = container.querySelector('[data-step="1"]');
        const yearBtn = container.querySelector('[data-pick="year"]');
        const monthBtn = container.querySelector('[data-pick="month"]');

        // Size both labels for every caption they can ever show, once. Without
        // it, stepping May → September would resize the label and shift the
        // arrows under the pointer. Any 4-digit year measures the same (the
        // labels are tabular-nums), so today's stands in for all of them.
        UI.lockPickerWidth(monthBtn, MONTHS);
        UI.lockPickerWidth(yearBtn, [String(new Date().getFullYear())]);

        function paint() {
            monthBtn.textContent = MONTHS[month.monthIdx];
            yearBtn.textContent = String(month.year);
            nextBtn.disabled = isFuture(month);
        }

        function moveTo(next) {
            month = next;
            paint();
            if (onChange) onChange({ ...month });
        }

        /** Years to offer, newest first: whatever the caller knows about, plus
         *  today's so a fresh database still has something to pick, plus the
         *  year the arrows have walked into so the picker can show where it
         *  actually is. Future years are dropped for the same reason future
         *  months are. */
        function years() {
            const thisYear = new Date().getFullYear();
            const set = new Set([thisYear, month.year]);
            for (const year of yearOptions() || []) set.add(year);
            return [...set].filter((year) => year <= thisYear).sort((a, b) => b - a);
        }

        // Forward stops at the current month — the belt to the disabled next
        // button's braces.
        function shift(delta) {
            const target = month.year * 12 + month.monthIdx + delta;
            const now = new Date();
            if (target > now.getFullYear() * 12 + now.getMonth()) return;
            moveTo({ year: Math.floor(target / 12), monthIdx: ((target % 12) + 12) % 12 });
        }

        prevBtn.addEventListener('click', () => shift(-1));
        nextBtn.addEventListener('click', () => shift(1));

        yearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            UI.openMenu(yearBtn, years().map((year) => ({
                label: String(year),
                selected: year === month.year,
                // Carrying the month across can land past today (December, then
                // this year) — clamp it to where the arrows would have stopped.
                action: () => moveTo({
                    year,
                    monthIdx: Math.min(month.monthIdx, lastMonthIdxOfYear(year)),
                }),
            })));
        });

        monthBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const last = lastMonthIdxOfYear(month.year);
            const items = [];
            for (let monthIdx = 0; monthIdx <= last; monthIdx++) {
                items.push({
                    label: MONTHS[monthIdx],
                    selected: monthIdx === month.monthIdx,
                    action: () => moveTo({ year: month.year, monthIdx }),
                });
            }
            UI.openMenu(monthBtn, items);
        });

        paint();

        return {
            value: () => ({ ...month }),
            refresh: paint,
        };
    }

    window.MonthStepper = { create, MONTHS };
}());
