'use strict';
// ============================================================================
// ui.js — Shared UI primitives: rich empty states + loading skeletons.
// ============================================================================
// Loaded globally before the per-page scripts (pages/partials/scripts.html),
// so every page builds these the same way. Styling lives in static/css/ui.css.
//
//   UI.emptyState({ icon, title, desc, action, compact })  → HTML string
//       icon   : key into UI.ICONS (a 24px stroke glyph). Defaults to 'info';
//                pass null for no glyph tile at all.
//       title  : short headline (required).
//       desc   : one supporting sentence (optional).
//       action : { label, href }            → in-app navigation (<a>)
//              | { label, name }            → on-page action (<button
//                                             data-empty-action="name">);
//                                             the page wires the click.
//              add `primary: true` for the accent treatment, `icon: '<key>'`
//              for a leading glyph. Navigation CTAs carry no glyph: a "+" in
//              front of "Add balances" implies an inline add, but the button
//              navigates to the page that has one.
//       compact: tighter padding for small/aside cards.
//
//   UI.skRows(n) / UI.skChart(h)
//       Skeleton markup builders (strings) — a list-shaped placeholder and a
//       block-shaped one. The line/block primitives they compose stay private:
//       no other file draws a skeleton, and exporting them would allow two
//       files to define different placeholder rhythms.
//
//   UI.skeletonGuard(showFn, delay=160) → cancel()
//       Show a skeleton only if the load takes longer than `delay`, so fast
//       (warm) loads do not flash one. Call the returned cancel() when data
//       arrives.
//
//   UI.openMenu(anchorBtn, items)
//       Dropdown menu anchored to a button (the ⋮ table menus, the stepper
//       month/year pickers). items: [{ label, action, danger?, selected? }].
//       Styling: .p-table-dropdown / .p-dropdown-item in ui.css.
//
//   UI.wirePicker(btnId, menuId, onPick?) → { close } | null
//       The app's one dropdown-picker shape, shared by every report header's
//       range / year control (Spending, Top Merchants, Saved & Invested,
//       Forecast, Metrics, Cash Flow). Six copies of this had diverged — one
//       was missing its "element missing" guard, two were missing the
//       btn.disabled check that stops an empty picker from opening. onPick is
//       DELEGATED off the menu, so the year pickers whose menus are rebuilt per
//       load no longer re-bind a listener to each option on every rebuild.
//       Callers read their own data-* attribute off the button passed to them
//       and validate it themselves; this helper handles only open and close.
//
//   UI.lockPickerWidth(btn, captions)
//       Pin a picker button (.stepper-label) to the width of the widest caption
//       it can show, and pass that width to the menu below it as a minimum.
//       Used by the month steppers, whose caption length otherwise changes with
//       the month.
//
//   UI.toast(message, { type = 'info', duration = 5000 })
//       Small transient notice, bottom-center. type: 'info' | 'error'.
//       One toast at a time: a repeat call replaces the text and restarts the
//       timer, so a burst of identical failures (e.g. the backend unreachable
//       while several cells are edited) shows once instead of stacking.
//       Click dismisses early. Styling: .ui-toast in ui.css.
//
// SECURITY: title/desc/label run through escapeHtml (global, from escape.js).
// ============================================================================

(function () {
    const UI = (() => {

        // 24×24 stroke icons matching the sidebar's style (1.5 stroke,
        // currentColor, round joins).
        const ICONS = {
            info:     '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M12 11.5v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg>',
            chart:    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 4v15a1 1 0 0 0 1 1h15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 14l3.5-4 3 2.5L20 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            donut:    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/></svg>',
            wallet:   '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7a2 2 0 0 1 2-2h11v3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="3.5" y="7" width="17" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M16 13h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            receipt:  '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3.5h12v16.5l-2.5-1.4-2.5 1.4-2.5-1.4-2.5 1.4-2-1.2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            calendar: '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            search:   '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M20 20l-3.6-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            target:   '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
            forecast: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 16l5-5 3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 7h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            plus:     '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
            import:   '<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4M7 9l5-5 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        };

        function _actionHtml(action) {
            if (!action) return '';
            const cls = 'empty-state-action' + (action.primary ? ' empty-state-action-primary' : '');
            const glyph = action.icon && ICONS[action.icon] ? ICONS[action.icon] : '';
            const inner = `${glyph}<span>${escapeHtml(action.label)}</span>`;
            if (action.href) {
                return `<a class="${cls}" href="${escapeHtml(action.href)}">${inner}</a>`;
            }
            return `<button type="button" class="${cls}" data-empty-action="${escapeHtml(action.name || '')}">${inner}</button>`;
        }

        function emptyState({ icon = 'info', title = '', desc = '', action = null, compact = false } = {}) {
            // icon: null renders the block with no glyph tile at all — the
            // Dashboard's card empties, where six icons across a grid read as
            // clutter rather than illustration.
            const glyph = icon === null ? '' : (ICONS[icon] || ICONS.info);
            return `<div class="empty-state${compact ? ' empty-state-compact' : ''}">
            ${glyph ? `<div class="empty-state-icon">${glyph}</div>` : ''}
            <div class="empty-state-text">
                <div class="empty-state-title">${escapeHtml(title)}</div>
                ${desc ? `<div class="empty-state-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            ${_actionHtml(action)}
        </div>`;
        }

        // ── Skeletons ──────────────────────────────────────────────────────────
        const skLine  = (w) => `<div class="skeleton skeleton-line${w ? ' sk-w-' + w : ''}"></div>`;
        const skBlock = (h) => `<div class="skeleton skeleton-block" style="height:${h}px"></div>`;
        const skChart = (h = 220) => skBlock(h);

        // n list-style rows: stacked label/value lines on the left, a value on the
        // right — mirrors the legend / upcoming / table row shape while loading.
        function skRows(n = 4, { right = true } = {}) {
            const row = `<div class="sk-row">
            <div class="sk-row-text">${skLine('60')}${skLine('40')}</div>
            ${right ? skLine('25') : ''}
        </div>`;
            return row.repeat(n);
        }

        function skeletonGuard(showFn, delay = 160) {
            const t = setTimeout(showFn, delay);
            return () => clearTimeout(t);
        }

        // ── Dropdown menu ──────────────────────────────────────────────────────
        // Anchored to `anchorBtn`: absolute-positioned into its parent, which is
        // forced to position: relative only when otherwise unpositioned (an
        // inline `relative` on a sticky/absolute parent would override it — see
        // .p-forehead-btns in tables.css). Closes on outside click. `selected`
        // marks the current choice in picker-style menus (stepper month/year).
        function openMenu(anchorBtn, items) {
            document.querySelector('.p-table-dropdown')?.remove();
            const menu = document.createElement('div');
            menu.className = 'p-table-dropdown';
            // Items go in an inner scroller (same structure as the Transactions
            // filter popover) so the scrollbar sits inset from the menu's
            // padded edge instead of hugging the rounded border.
            const scroller = document.createElement('div');
            menu.appendChild(scroller);
            scroller.className = 'p-dropdown-scroll';
            items.forEach(({ label, action, danger, selected }) => {
                const item = document.createElement('button');
                item.className = 'p-dropdown-item'
                    + (danger ? ' p-dropdown-item-danger' : '')
                    + (selected ? ' p-dropdown-item-selected' : '');
                item.textContent = label;
                if (selected) item.setAttribute('aria-current', 'true');
                item.addEventListener('click', () => { menu.remove(); action(); });
                scroller.appendChild(item);
            });
            const anchor = anchorBtn.parentElement;
            if (getComputedStyle(anchor).position === 'static') {
                anchor.style.position = 'relative';
            }
            anchor.appendChild(menu);
            // Defer attaching the outside-click handler so the click that opened
            // the menu doesn't immediately close it.
            const close = e => {
                if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); }
            };
            setTimeout(() => document.addEventListener('click', close, true), 0);
        }

        // ── Static picker width ────────────────────────────────────────────────
        // A month stepper's caption changes length as you step ("MAY 2026" ↔
        // "SEPTEMBER 2026"), which shuffles the ‹ › arrows either side of it and
        // resizes the menu that drops from it. Measure every caption the picker
        // can ever show and pin the button to the widest one, so the control is
        // a fixed block whatever month is on it.
        //
        // Measured with a hidden clone of the button — same classes, same parent
        // — rather than from a font string, so text-transform, letter-spacing,
        // tabular numerals and the padding around the caret are all included.
        // Re-measured once document.fonts resolves, since the app's @font-face
        // files load after first paint and the fallback face
        // measures narrower. The lock is CSS pixels, which Chromium's zoom
        // scales with everything else, so Ctrl +/- needs no re-measure.
        function lockPickerWidth(btn, captions) {
            if (!btn || !btn.parentElement || !captions || !captions.length) return;
            const measure = () => {
                const probe = btn.cloneNode(false);
                probe.removeAttribute('id');
                probe.removeAttribute('aria-live');
                probe.setAttribute('aria-hidden', 'true');
                probe.style.cssText = 'position:absolute;left:-9999px;top:0;'
                    + 'visibility:hidden;pointer-events:none;'
                    + 'width:auto;min-width:0;max-width:none;white-space:nowrap';
                btn.parentElement.appendChild(probe);
                let widest = 0;
                for (const caption of captions) {
                    probe.textContent = caption;
                    widest = Math.max(widest, probe.getBoundingClientRect().width);
                }
                probe.remove();
                if (!widest) return;   // stepper not laid out (hidden tab) — leave it alone
                const width = Math.ceil(widest) + 'px';
                btn.style.width = width;
                // The menu opens inside the stepper, so pass the same figure
                // down as its minimum (.stepper .p-table-dropdown in ui.css): the
                // list is never narrower than its button, and its width no longer
                // depends on which months are in range. A .stepper-picker slot
                // takes precedence over the stepper when present, because a
                // stepper holding two pickers (the Dashboard's year + month)
                // would otherwise have the second call overwrite the first and
                // widen the year menu to a month name's width.
                (btn.closest('.stepper-picker') || btn.closest('.stepper') || btn.parentElement)
                    .style.setProperty('--picker-menu-min', width);
            };
            measure();
            document.fonts?.ready?.then(measure);
        }

        // ── Dropdown picker ────────────────────────────────────────────────────
        // Toggle a [hidden] menu off its button; any click elsewhere closes it.
        // Returns { close } so a caller can dismiss the menu from its own code
        // (the Forecast picker closes its hover card at the same time), or null
        // when the page does not contain this picker — the Reports tabs share one
        // document, so every picker script runs on every tab.
        function wirePicker(btnId, menuId, onPick) {
            const btn = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            if (!btn || !menu) return null;

            const close = () => { menu.hidden = true; };
            btn.addEventListener('click', (e) => {
                // Stop the document listener below from seeing this same click
                // and closing the menu we are opening.
                e.stopPropagation();
                // A picker with nothing to pick (no years in the ledger) is
                // disabled rather than empty, so it must not open.
                if (!btn.disabled) menu.hidden = !menu.hidden;
            });
            document.addEventListener('click', close);

            if (onPick) {
                menu.addEventListener('click', (e) => {
                    const item = e.target.closest('button');
                    if (!item || !menu.contains(item)) return;
                    close();
                    onPick(item);
                });
            }
            return { close };
        }

        // ── Toast ──────────────────────────────────────────────────────────────
        // A single persistent element, shown and hidden by class so repeated
        // calls reuse it (see the header comment). textContent, never innerHTML,
        // so arbitrary error strings cannot inject markup.
        let _toastEl = null;
        let _toastTimer = null;

        function _hideToast() {
            if (_toastEl) _toastEl.classList.remove('ui-toast-show');
            clearTimeout(_toastTimer);
            _toastTimer = null;
        }

        function toast(message, { type = 'info', duration = 5000 } = {}) {
            if (!_toastEl) {
                _toastEl = document.createElement('div');
                _toastEl.className = 'ui-toast';
                _toastEl.addEventListener('click', _hideToast);
                document.body.appendChild(_toastEl);
            }
            _toastEl.textContent = message;
            _toastEl.classList.toggle('ui-toast-error', type === 'error');
            // 'alert' announces errors assertively to screen readers; 'status'
            // queues politely. Set per call since the element is reused.
            _toastEl.setAttribute('role', type === 'error' ? 'alert' : 'status');
            _toastEl.classList.add('ui-toast-show');
            clearTimeout(_toastTimer);
            _toastTimer = setTimeout(_hideToast, duration);
        }

        return { emptyState, ICONS, skChart, skRows, skeletonGuard, openMenu, wirePicker, lockPickerWidth, toast };
    })();

    window.UI = UI;
}());
