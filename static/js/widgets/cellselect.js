'use strict';

// ============================================================================
// cellselect.js — Spreadsheet-style multi-cell selection for grid tables.
// ============================================================================
//
// Loaded BEFORE tables.js / portfolio.js on the grid pages (Cash Flow,
// Balance Sheet, Portfolio). Exposes one entry point:
//
//     enableCellSelection(tableEl, config)
//
// which turns a single <table> into a spreadsheet-like selection surface:
//
//   • Mouse: click a cell to select it; click-drag, or Shift+click, to select
//     a rectangle of cells.
//   • Keyboard: from one focused cell, hold Shift + arrow keys to grow/shrink
//     the selection rectangle. Plain arrow keys keep their existing per-cell
//     navigation (owned by the page) — we just collapse the selection to
//     wherever focus lands.
//   • Copy  (Ctrl/Cmd+C): the selected rectangle is written to the clipboard
//     as TSV (tabs between columns, newlines between rows) — pasteable into
//     Excel/Sheets or back into the app.
//   • Paste (Ctrl/Cmd+V): a clipboard rectangle is written starting at the
//     selection's top-left, spilling down/right, clamped to the table edges.
//   • Delete/Backspace: every editable cell in the selection is cleared.
//
// DESIGN: this module is a pure UI/clipboard layer. It never calls an API. To
// write or clear a cell it sets the cell <input>'s value and dispatches a
// synthetic `input` event, which re-triggers the page's own per-input handler
// (debounced save / delete / totals refresh in tables.js, computed-field +
// footer refresh in portfolio.js). All persistence, rounding, and sync rules
// therefore stay in exactly one place — the page that owns the cell.
//
// The grid is derived from the live DOM on every interaction (rows = tbody
// <tr>, columns = position among the configured cell selector). That keeps it
// correct even when a page adds/removes rows without a full re-render (e.g.
// Portfolio's "Add Asset"), and rectangular because every row in these tables
// has the same column count.

// ─── Shared drag state ───────────────────────────────────────────────────────
// Only one drag can be in flight at a time across the whole app, so the active
// drag target lives at module scope with single document-level mousemove +
// mouseup listeners that drive/end it. This avoids each table instance leaking
// its own document listeners (instances are rebuilt on every table re-render).
//
// Drag extension is tracked via document `mousemove` + elementFromPoint rather
// than the table's own `mouseover`: each cell is filled by an <input>, and once
// a press lands in an input the browser does implicit pointer capture for text
// selection, so `mouseover` never fires on the neighbouring cells. Hit-testing
// the point ourselves sidesteps that capture entirely.

(function () {
    let _dragInst = null;

    document.addEventListener('mousemove', (e) => {
        if (_dragInst) _dragInst._onDragMove(e.clientX, e.clientY);
    });

    document.addEventListener('mouseup', () => {
        if (_dragInst) { _dragInst._endDrag(); _dragInst = null; }
    });

    const _ARROWS = {
        ArrowUp:    [-1,  0],
        ArrowDown:  [ 1,  0],
        ArrowLeft:  [ 0, -1],
        ArrowRight: [ 0,  1],
    };

    const _clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    /**
     * Attach multi-cell selection to one table.
     *
     * config:
     *   cellSelector  string  — selector matching the selectable <td> in each
     *                           tbody row (e.g. 'td.data-cell', 'td').
     *   isEditable?   (td) => bool      — can this cell be written/cleared?
     *                                     Default: has a non-readonly/disabled <input>.
     *   readValue?    (td) => string    — value used for copy. Default: input.value,
     *                                     else the cell's trimmed textContent.
     *   writeValue?   (td, str) => void — set the cell's value. Default: write the
     *                                     <input> and dispatch a bubbling 'input'.
     *   clearValue?   (td) => void      — clear the cell. Default: writeValue(td, '').
     */
    function enableCellSelection(tableEl, config) {
        const cellSelector = config.cellSelector;

        const findInput  = (td) => td && td.querySelector('input');
        const isEditable = config.isEditable || ((td) => {
            const i = findInput(td);
            return !!i && !i.readOnly && !i.disabled;
        });
        const readValue  = config.readValue || ((td) => {
            const i = findInput(td);
            return i ? i.value : (td?.textContent ?? '').trim();
        });
        const writeValue = config.writeValue || ((td, str) => {
            const i = findInput(td);
            if (!i) return;
            i.value = str;
            // Re-run the page's own input handler (save / format / totals). This is
            // the seam that keeps all persistence logic on the owning page.
            i.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const clearValue = config.clearValue || ((td) => writeValue(td, ''));

        // Selection state. `anchor` is the origin (the active, input-focused cell);
        // `focus` is the moving corner. Both are {r, c} or null when nothing is
        // selected. The selection is the rectangle bounded by the two.
        let anchor = null;
        let focus  = null;

        // ── Grid + coordinate helpers (re-derived from the DOM each call) ────────
        const getGrid = () => {
            const grid = [];
            tableEl.querySelectorAll('tbody tr').forEach(tr => {
                const cells = Array.from(tr.querySelectorAll(cellSelector));
                if (cells.length) grid.push(cells);
            });
            return grid;
        };

        const locate = (grid, td) => {
            for (let r = 0; r < grid.length; r++) {
                const c = grid[r].indexOf(td);
                if (c !== -1) return { r, c };
            }
            return null;
        };

        const rect = () => ({
            r0: Math.min(anchor.r, focus.r), r1: Math.max(anchor.r, focus.r),
            c0: Math.min(anchor.c, focus.c), c1: Math.max(anchor.c, focus.c),
        });

        const selectionSize = () => {
            if (!anchor || !focus) return 0;
            const { r0, r1, c0, c1 } = rect();
            return (r1 - r0 + 1) * (c1 - c0 + 1);
        };

        // ── Highlight ────────────────────────────────────────────────────────────
        // The fill comes from the .cell-selected / .cell-active CSS classes; the
        // bold outline around the *whole* selection is drawn per-cell with an inline
        // inset box-shadow on whichever sides of a cell sit on the selection's
        // perimeter. Doing it per-cell (rather than one overlay div) means the
        // outline tracks horizontal scroll and the sticky Month column for free,
        // with no positioning math to get wrong.
        const clearHighlight = () => {
            tableEl.querySelectorAll('td.cell-selected, td.cell-active').forEach(td => {
                td.classList.remove('cell-selected', 'cell-active');
                td.style.boxShadow = '';
            });
        };

        const applyHighlight = (grid) => {
            clearHighlight();
            if (!anchor || !focus) return;
            const { r0, r1, c0, c1 } = rect();
            const B = '2px';
            const COLOR = 'var(--cell-select-border)';
            const isRange = selectionSize() > 1;

            if (isRange) {
                // Fill every selected cell and draw the accent outline along the
                // perimeter sides of the rectangle.
                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const td = grid[r]?.[c];
                        if (!td) continue;
                        td.classList.add('cell-selected');
                        const edges = [];
                        if (r === r0) edges.push(`inset 0 ${B} 0 0 ${COLOR}`);
                        if (r === r1) edges.push(`inset 0 -${B} 0 0 ${COLOR}`);
                        if (c === c0) edges.push(`inset ${B} 0 0 0 ${COLOR}`);
                        if (c === c1) edges.push(`inset -${B} 0 0 0 ${COLOR}`);
                        td.style.boxShadow = edges.join(', ');
                    }
                }
            }

            // The active cell always gets the accent box. For a range it's the
            // anchor inside the fill; for a single cell it's the full four-sided
            // outline on its own — so clicking one cell shows the same green box,
            // with no fill and the caret preserved so it stays immediately editable.
            const activeTd = grid[anchor.r]?.[anchor.c];
            if (activeTd) {
                activeTd.classList.add('cell-active');
                if (!isRange) {
                    activeTd.style.boxShadow =
                        `inset 0 ${B} 0 0 ${COLOR}, inset 0 -${B} 0 0 ${COLOR}, ` +
                        `inset ${B} 0 0 0 ${COLOR}, inset -${B} 0 0 0 ${COLOR}`;
                }
            }
        };

        const collapseTo = (grid, pos) => {
            anchor = { ...pos };
            focus  = { ...pos };
            applyHighlight(grid);
        };

        // ── Mouse: click / drag / shift-click ────────────────────────────────────
        // `dragMoved` flips true on the first mousemove of a press, marking the
        // gesture as a range-drag (vs. a plain click that just focuses a cell for
        // editing). While dragging we also suppress focus-collapse — see focusin.
        let dragMoved = false;

        tableEl.addEventListener('mousedown', (e) => {
            const td = e.target.closest(cellSelector);
            if (!td || !tableEl.contains(td)) return;
            const grid = getGrid();
            const pos  = locate(grid, td);
            if (!pos) return;

            if (e.shiftKey && anchor) {
                // Extend the existing selection without moving focus/caret.
                focus = pos;
                e.preventDefault();
                applyHighlight(grid);
            } else {
                // Fresh single-cell selection. Don't preventDefault — let the
                // browser focus the input so the caret lands normally for editing.
                collapseTo(grid, pos);
            }

            // Arm a potential drag. We don't suppress text selection yet (a plain
            // click should still place the caret); _onDragMove does that once the
            // pointer actually moves.
            _dragInst  = inst;
            dragMoved  = false;
        });

        // Driven by the document-level mousemove (see top of file). `x`/`y` are
        // viewport coordinates; we hit-test the cell under the pointer so the drag
        // extends even while the pressed input holds pointer capture.
        const onDragMove = (x, y) => {
            const el = document.elementFromPoint(x, y);
            const td = el?.closest?.(cellSelector);
            if (!td || !tableEl.contains(td)) return;
            const grid = getGrid();
            const pos  = locate(grid, td);
            if (!pos) return;
            if (!dragMoved) {
                // First movement → this is a range-drag, not a click. Stop the
                // input from text-selecting under us for the rest of the gesture.
                dragMoved = true;
                tableEl.style.userSelect = 'none';
            }
            // The pressed input keeps focus during the drag; collapse any text it
            // selected (input selection is separate from window.getSelection()) so
            // the gesture reads as a cell range, not highlighted text.
            const ae = document.activeElement;
            if (ae && typeof ae.setSelectionRange === 'function') {
                try { ae.setSelectionRange(ae.value.length, ae.value.length); } catch (_) {}
            }
            window.getSelection()?.removeAllRanges();
            if (pos.r === focus.r && pos.c === focus.c) return;
            focus = pos;
            applyHighlight(grid);
        };

        // ── Plain navigation / clicks collapse the selection ─────────────────────
        // The page keeps its own plain-arrow navigation (it calls input.focus() on
        // the target cell). We react to wherever focus lands and collapse the
        // selection to that single cell. Shift+arrow never moves focus (we keep the
        // anchor input focused), so it doesn't trip this.
        tableEl.addEventListener('focusin', (e) => {
            // Mid-drag the anchor input keeps focus; ignore stray focus churn so a
            // range-drag isn't collapsed back to a single cell.
            if (_dragInst === inst && dragMoved) return;
            const td = e.target.closest(cellSelector);
            if (!td) return;
            const grid = getGrid();
            const pos  = locate(grid, td);
            if (pos) collapseTo(grid, pos);
        });

        // Dropping focus out of the table clears the selection so a stale
        // highlight doesn't linger on another page region.
        tableEl.addEventListener('focusout', (e) => {
            if (tableEl.contains(e.relatedTarget)) return;
            anchor = focus = null;
            clearHighlight();
        });

        // ── Keyboard: Shift+Arrow extend, Delete clear, Escape collapse ──────────
        // Capture phase so we intercept before the focused <input> turns Shift+
        // Arrow into in-field text selection.
        tableEl.addEventListener('keydown', (e) => {
            // Shift + arrow → grow/shrink the rectangle.
            if (e.shiftKey && _ARROWS[e.key]) {
                const grid = getGrid();
                if (grid.length === 0) return;
                if (!anchor || !focus) {
                    // Seed from whatever cell currently holds focus.
                    const td  = document.activeElement?.closest?.(cellSelector);
                    const pos = td ? locate(grid, td) : null;
                    if (!pos) return;
                    anchor = { ...pos };
                    focus  = { ...pos };
                }
                // Stop the page's own per-input arrow-nav (tables.js / portfolio.js)
                // from also handling this keypress — it doesn't check shiftKey, so
                // without this it would move focus and collapse the selection.
                e.stopPropagation();
                const [dr, dc] = _ARROWS[e.key];
                const nr = _clamp(focus.r + dr, 0, grid.length - 1);
                const nc = _clamp(focus.c + dc, 0, (grid[nr]?.length ?? 1) - 1);
                focus = { r: nr, c: nc };
                e.preventDefault();
                applyHighlight(grid);
                return;
            }

            // Delete / Backspace on a multi-cell selection clears the range. A
            // single cell keeps normal in-field editing (so Backspace deletes a
            // character as usual).
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectionSize() > 1) {
                e.preventDefault();
                const grid = getGrid();
                const { r0, r1, c0, c1 } = rect();
                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const td = grid[r]?.[c];
                        if (td && isEditable(td)) clearValue(td);
                    }
                }
                return;
            }

            // Escape collapses a multi-cell selection back to the active cell.
            if (e.key === 'Escape' && selectionSize() > 1) {
                const grid = getGrid();
                collapseTo(grid, anchor);
                return;
            }

            // A printable keystroke over a range means the user is editing the
            // active cell — collapse the selection so they type into a clean cell
            // (not a lingering highlight). We don't preventDefault, so the
            // character flows into the focused active input as normal.
            if (selectionSize() > 1 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                collapseTo(getGrid(), anchor);
            }
        }, true);

        // ── Clipboard ────────────────────────────────────────────────────────────
        // Both events bubble from the focused input up to the table.
        tableEl.addEventListener('copy', (e) => {
            if (selectionSize() <= 1) return;   // let the browser copy the input text
            const grid = getGrid();
            const { r0, r1, c0, c1 } = rect();
            const lines = [];
            for (let r = r0; r <= r1; r++) {
                const cols = [];
                for (let c = c0; c <= c1; c++) cols.push(readValue(grid[r]?.[c]));
                lines.push(cols.join('\t'));
            }
            e.clipboardData.setData('text/plain', lines.join('\n'));
            e.preventDefault();
        });

        tableEl.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain');
            if (text == null) return;

            // A single-cell selection pasting a single value keeps the browser's
            // normal caret-insert behavior. Anything with tabs/newlines (a grid),
            // or a multi-cell selection, spills across cells from the top-left.
            const isGrid = /\t|\r?\n/.test(text.replace(/\r?\n$/, ''));
            if (selectionSize() <= 1 && !isGrid) return;

            e.preventDefault();
            const grid = getGrid();

            // Anchor the paste at the selection's top-left, or — if nothing is
            // selected — at the focused cell.
            let startR, startC;
            if (anchor && focus) {
                const { r0, c0 } = rect();
                startR = r0; startC = c0;
            } else {
                const td  = document.activeElement?.closest?.(cellSelector);
                const pos = td ? locate(grid, td) : null;
                if (!pos) return;
                startR = pos.r; startC = pos.c;
            }

            const rows = text.split(/\r?\n/);
            if (rows.length && rows[rows.length - 1] === '') rows.pop();   // trailing newline
            rows.forEach((row, dr) => {
                const r = startR + dr;
                if (r >= grid.length) return;
                row.split('\t').forEach((cellText, dc) => {
                    const c  = startC + dc;
                    const td = grid[r]?.[c];
                    if (!td || !isEditable(td)) return;
                    writeValue(td, cellText);
                });
            });
            applyHighlight(grid);
        });

        // The instance handle — exposes just what the shared drag plumbing (the
        // document-level mousemove/mouseup at the top of the file) needs.
        const inst = {
            _onDragMove: onDragMove,
            _endDrag() {
                tableEl.style.userSelect = '';
                dragMoved = false;
            },
        };

        return inst;
    }

    // Expose globally; tables.js calls it through a `window.enableCellSelection`
    // guard so pages that load tables.js but aren't grids (Credit Cards) are
    // unaffected even if this script isn't present.
    window.enableCellSelection = enableCellSelection;
}());
