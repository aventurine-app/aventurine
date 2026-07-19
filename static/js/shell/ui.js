'use strict';
// ============================================================================
// ui.js — Shared UI primitives: rich empty states + loading skeletons.
// ============================================================================
// Loaded globally before the per-page scripts (pages/partials/scripts.html),
// so every page builds these the same way. Styling lives in static/css/ui.css.
//
//   UI.emptyState({ icon, title, desc, action, compact })  → HTML string
//       icon   : key into UI.ICONS (a 24px stroke glyph). Defaults to 'info'.
//       title  : short headline (required).
//       desc   : one supporting sentence (optional).
//       action : { label, href }            → in-app navigation (<a>)
//              | { label, name }            → on-page action (<button
//                                             data-empty-action="name">);
//                                             the page wires the click.
//              add `primary: true` for the accent treatment, `icon: 'plus'`
//              for a leading glyph.
//       compact: tighter padding for small/aside cards.
//
//   UI.skLine(w) / UI.skLines([w…]) / UI.skBlock(h) / UI.skRows(n) / UI.skChart(h)
//       Skeleton markup builders (strings). Widths are the sk-w-* steps.
//
//   UI.skeletonGuard(showFn, delay=160) → cancel()
//       Show a skeleton only if the load outlasts `delay`, so fast (warm)
//       loads never flash one. Call the returned cancel() once data lands.
//
//   UI.openMenu(anchorBtn, items)
//       Dropdown menu anchored to a button (the ⋮ table menus, the stepper
//       month/year pickers). items: [{ label, action, danger?, selected? }].
//       Styling: .p-table-dropdown / .p-dropdown-item in ui.css.
//
//   UI.toast(message, { type = 'info', duration = 5000 })
//       Small transient notice, bottom-center. type: 'info' | 'error'.
//       One toast at a time: a repeat call replaces the text and restarts
//       the timer, so a burst of identical failures (e.g. server gone while
//       the user edits several cells) coalesces instead of stacking.
//       Click dismisses early. Styling: .ui-toast in ui.css.
//
// SECURITY: title/desc/label run through escapeHtml (global, from escape.js).
// ============================================================================

(function () {
    const UI = (() => {

        // 24×24 stroke icons in the sidebar's visual language (1.5 stroke,
        // currentColor, round joins) so empties feel native to the app.
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
            const glyph = ICONS[icon] || ICONS.info;
            return `<div class="empty-state${compact ? ' empty-state-compact' : ''}">
            <div class="empty-state-icon">${glyph}</div>
            <div class="empty-state-text">
                <div class="empty-state-title">${escapeHtml(title)}</div>
                ${desc ? `<div class="empty-state-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            ${_actionHtml(action)}
        </div>`;
        }

        // ── Skeletons ──────────────────────────────────────────────────────────
        const skLine  = (w) => `<div class="skeleton skeleton-line${w ? ' sk-w-' + w : ''}"></div>`;
        const skLines = (widths) => widths.map(skLine).join('');
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
        // inline `relative` on a sticky/absolute parent would clobber it — see
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

        // ── Toast ──────────────────────────────────────────────────────────────
        // A single persistent element, shown/hidden by class so repeated calls
        // coalesce (see the header comment). textContent (never innerHTML) keeps
        // arbitrary error strings inert.
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

        return { emptyState, ICONS, skLine, skLines, skBlock, skChart, skRows, skeletonGuard, openMenu, toast };
    })();

    window.UI = UI;
}());
