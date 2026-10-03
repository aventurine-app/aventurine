'use strict';

// ─── dashgrid.js ──────────────────────────────────────────────────────────────
// The Dashboard's layout engine: where every card sits on its 12-column grid.
// Pure functions over plain card lists ({ id, x, y, w, h, ... }; x and w in
// columns, y and h in rows), so drag, resize, the keyboard and the widget list
// all place cards through one set of rules, and the rules are pinned under
// `node --test` (electron/backend/__tests__/dashGrid.test.js) with no DOM.
//
// THE RULE. Cards are taken in reading order (top to bottom, then left to right)
// and each drops onto the highest point it can reach in the columns it spans,
// a "skyline". Nothing can float above a card it sits under, so a layout never
// has holes for the user to tidy, and a card never jumps past one the user did
// not move it past. Every function returns new card objects and leaves its
// input untouched, which is what lets a drag preview a layout and throw it away.
//
// Dual-environment, like txparse.js: window.DashGrid in the browser
// (pages/dashboard.html loads it before dashboard.js), module.exports under Node.

(function () {
    const COLS = 12;

    const overlapX = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
    const byPosition = (a, b) => a.y - b.y || a.x - b.x;

    /** Drop each card, in the order given, onto the skyline of its columns.
     *  A card wider than the grid is narrowed to it, and one hanging past the
     *  right edge is pulled back in. */
    function stack(order) {
        const sky = new Array(COLS).fill(0);
        return order.map((card) => {
            const w = Math.min(Math.max(card.w, 1), COLS);
            const x = Math.min(Math.max(card.x, 0), COLS - w);
            let y = 0;
            for (let c = x; c < x + w; c++) y = Math.max(y, sky[c]);
            for (let c = x; c < x + w; c++) sky[c] = y + card.h;
            return { ...card, x, y, w };
        });
    }

    /** Tidy a layout: restack it in its own reading order. A layout that is
     *  already packed comes back unchanged. */
    const pack = (cards) => stack([...cards].sort(byPosition));

    /**
     * The layout with `active` moved to (active.x, active.y). The moved card
     * takes its turn just before the first card in its columns whose middle sits
     * at or below its own: passing a neighbour's midpoint is what swaps two
     * cards, the way a list reorders under a drag. `active` need not be in
     * `cards` yet, which is how a card dragged in from the widget list is placed.
     */
    function arrangeMove(cards, active) {
        const others = cards.filter((c) => c.id !== active.id).sort(byPosition);
        const mid = (c) => c.y + c.h / 2;
        let at = others.length;
        for (let k = 0; k < others.length; k++) {
            if (overlapX(others[k], active) && mid(active) <= mid(others[k])) { at = k; break; }
        }
        return stack([...others.slice(0, at), active, ...others.slice(at)]);
    }

    /** A card resized or re-shaped where it stands: it keeps its turn in the
     *  reading order, and everything after it restacks around its new size. */
    const arrangeInPlace = (cards, active) =>
        stack([...cards].sort(byPosition).map((c) => (c.id === active.id ? active : c)));

    /** Swap turns with the nearest card above (dir -1) or below (dir 1) that
     *  shares a column — the keyboard's up and down. null when there is none,
     *  i.e. the card is already at that edge of the layout. */
    function moveVertical(cards, id, dir) {
        const order = [...cards].sort(byPosition);
        const i = order.findIndex((c) => c.id === id);
        if (i === -1) return null;
        const card = order[i];
        let j = i + dir;
        while (j >= 0 && j < order.length && !overlapX(order[j], card)) j += dir;
        if (j < 0 || j >= order.length) return null;
        order.splice(i, 1);
        order.splice(j, 0, card);
        return stack(order);
    }

    /** The highest cell a new card `w` columns wide can take, leftmost on a
     *  tie: where a card added from the widget list lands. */
    function firstFit(cards, w) {
        const width = Math.min(Math.max(w, 1), COLS);
        const sky = new Array(COLS).fill(0);
        for (const c of pack(cards)) {
            for (let col = c.x; col < c.x + c.w; col++) sky[col] = Math.max(sky[col], c.y + c.h);
        }
        let best = { x: 0, y: Infinity };
        for (let x = 0; x <= COLS - width; x++) {
            let y = 0;
            for (let col = x; col < x + width; col++) y = Math.max(y, sky[col]);
            if (y < best.y) best = { x, y };
        }
        return best;
    }

    /** The row just below the lowest card; 0 for an empty layout. */
    const bottom = (cards) => cards.reduce((m, c) => Math.max(m, c.y + c.h), 0);

    const DashGrid = { COLS, stack, pack, arrangeMove, arrangeInPlace, moveVertical, firstFit, bottom, byPosition };

    if (typeof module !== 'undefined' && module.exports) module.exports = DashGrid;
    else window.DashGrid = DashGrid;
}());
