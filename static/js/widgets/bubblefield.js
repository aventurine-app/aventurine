'use strict';

// ─── bubblefield.js ─────────────────────────────────────────────────────────
// A field of circles that size themselves to a value, drift toward the middle,
// and push each other out of the way. Written for the Budgets page, where one
// circle is one category.
//
// It knows nothing about money. The caller hands over [{ key, value }] and a
// paint() callback; this file owns radii, positions, the animation loop and the
// resize behaviour, and never touches the contents of a circle. That split is
// what keeps the physics testable by eye on its own and lets the page's own
// script read as budget logic rather than as a simulation.
//
//   const field = BubbleField.create(el, { paint, onActivate });
//   field.setData([{ key: 'food', value: 500 }, …]);   // value = the radius input
//   field.destroy();
//
// Each circle is a real <button>, so hover, keyboard focus and activation come
// from the platform rather than from mouse handlers. Positioning is a
// `transform`, which the compositor can move without re-laying-out the page.
//
// AREA, NOT RADIUS, carries the value. A budget twice the size gets twice the
// ink: r = k·√value. Scaling the radius directly would draw double as
// quadruple, which is the classic way a bubble chart lies.
//
// Depends on nothing but the DOM.

(function () {
    // ─── Tuning ─────────────────────────────────────────────────────────────
    // A circle small enough to lose its readout is not worth drawing, and 64px
    // across also clears the 44px pointer-target floor.
    const MIN_RADIUS = 32;
    // Ceiling as a share of the field's SHORTER edge, so one huge value cannot
    // fill the container and leave nothing for the rest.
    const MAX_RADIUS_SHARE = 0.28;
    // Share of the field the circles' combined area takes, enforced (not just
    // aimed at) by the second pass in assignRadii.
    //
    // There is a ceiling and then there is the choice. The CEILING is measured:
    // circles pack to at most ~90% of an unbounded plane, but this cluster is
    // pulled into a round blob inside a rectangle whose corners go unused, and
    // at 0.42 a ten-category field settled with ~32px of overlap between its two
    // largest circles, because gravity and the walls together left the collision
    // pass nowhere to push them. 0.32 was the first value that packed cleanly.
    // The CHOICE is to sit a fifth below that: the cluster reads as a shape on
    // the page rather than as a field pressed against its own edges, and the
    // slack also keeps the MAX_RADIUS_SHARE ceiling off the largest circle in a
    // typical taxonomy, so area stays proportional to the budget instead of
    // being clipped at the top end.
    const PACK_DENSITY = 0.256;
    // The share of the field's SHORTER edge the settled cluster may span, and
    // the share of the ground it covers that is actually circle.
    //
    // Area alone is not enough to know whether a field has room. The cluster
    // settles into a round blob, so a wide, short window runs out of HEIGHT
    // long before it runs out of area, and the walls then hold circles inside
    // each other however many times they are pushed apart. Capping the total by
    // what a blob spanning the short edge can hold is what keeps a squashed
    // window a smaller cluster rather than an overlapping one. Circles of mixed
    // sizes pack to roughly 80% of the ground they cover, so a blob of diameter
    // d holds about π·0.8·(d/2)² of circle. In a normally proportioned window
    // this cap is nowhere near binding and PACK_DENSITY is what decides.
    const BLOB_SPAN = 0.92;
    const BLOB_EFFICIENCY = 0.8;
    // Clearance held between two circles, in px. Zero, so a settled field packs
    // to CONTACT: every circle comes to rest against its neighbours rather than
    // near them. Nothing may overlap either, and the simulation on its own only
    // converges on contact without quite arriving — see finishContacts, which
    // is what makes the frame that stays on screen exact.
    const GAP = 0;
    // Times the pairwise separation is re-run per tick. One pass fixes each pair
    // in isolation, which can shove a circle straight into a third; repeating it
    // lets a crowded cluster settle in one tick instead of over several, and at
    // this n it is a few hundred extra distance checks.
    const COLLISION_PASSES = 4;
    // Pull toward the middle, as a share of the distance, per tick. A spring
    // rather than a constant tug: it settles instead of orbiting. Kept well
    // under the separation the collision passes apply, or a crowded field
    // compresses faster than it can spread.
    const CENTER_PULL = 0.010;
    // Share of the previous tick's motion carried into this one. Low enough
    // that the field comes to rest in well under a second.
    const DAMPING = 0.86;
    // Below this much movement in a tick (px, largest single circle) the field
    // counts as still; after REST_TICKS consecutive still ticks the loop stops,
    // so an idle page runs no animation frames at all.
    const REST_MOVEMENT = 0.08;
    const REST_TICKS = 3;
    // Ceiling on the settle-without-drawing pass (reduced motion, and the very
    // first layout). Reached only if the field never comes to rest.
    const MAX_SETTLE_TICKS = 400;
    // The gravity-free pass that finishes a settled field: how many separations
    // it may run, and the overlap (px) it stops at.
    //
    // Each pass fixes one pair at a time, which can put a circle into a third,
    // so a blob gravity has compressed unwinds a little per pass rather than
    // all at once. Measured over 400 random fields: 12 passes left 43 of them
    // with up to 0.9px of overlap, 24 left 8, and 48 cleared every one. 64 is
    // that with room to spare, and it runs once when the field stops rather
    // than per frame — a few thousand distance checks, once.
    const CONTACT_PASSES = 64;
    const CONTACT_TOLERANCE = 0.08;

    // Seed positions on a phyllotaxis spiral: deterministic, so a reload lands
    // the same way, and already roughly packed, so the simulation has little
    // left to do. A ring or a grid would start the field in a symmetry the
    // collision pass cannot break out of.
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

    const prefersReducedMotion = () =>
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /**
     * Give every circle a radius, sharing targetArea out by value.
     *
     * Callers are expected to hand over things worth drawing: a value at or
     * below zero is not a state this models, it just falls to MIN_RADIUS on the
     * clamp so it stays visible and clickable rather than collapsing to a point.
     * (The Budgets page leaves unbudgeted categories out of the list entirely,
     * which is why there is no second size tier here.)
     */
    function assignRadii(nodes, width, height) {
        const maxRadius = Math.max(MIN_RADIUS, Math.min(width, height) * MAX_RADIUS_SHARE);
        const blobRadius = Math.min(width, height) * BLOB_SPAN / 2;
        const targetArea = Math.min(
            width * height * PACK_DENSITY,
            Math.PI * BLOB_EFFICIENCY * blobRadius * blobRadius,
        );

        let totalValue = 0;
        for (const node of nodes) totalValue += Math.max(node.value, 0);

        const scale = totalValue > 0 ? Math.sqrt(targetArea / (Math.PI * totalValue)) : 0;

        let used = 0;
        for (const node of nodes) {
            const value = Math.max(node.value, 0);
            node.r = Math.min(maxRadius, Math.max(MIN_RADIUS, scale * Math.sqrt(value)));
            used += Math.PI * node.r * node.r;
        }

        // The two clamps above can push the total past what was budgeted for —
        // several circles sitting on the floor, or one value pinned at the
        // ceiling. Scale the whole field back down so the density PACK_DENSITY
        // names is the density actually drawn, which is what keeps the collision
        // pass able to separate everything. The floor is re-applied: a field too
        // small to hold even its minimum circles stays legible and lets the
        // walls hold them instead.
        if (used > targetArea) {
            const shrink = Math.sqrt(targetArea / used);
            for (const node of nodes) node.r = Math.max(MIN_RADIUS, node.r * shrink);
        }
    }

    /** Keep a circle whole inside the field. An edge STOPS the circle rather
     *  than bouncing it: a rebound off a boundary the user cannot see reads as
     *  a glitch. A field too small to hold the circle centres it instead. */
    function clampToField(node, width, height) {
        const minX = node.r;
        const maxX = width - node.r;
        const minY = node.r;
        const maxY = height - node.r;

        if (maxX < minX) node.x = width / 2;
        else if (node.x < minX) node.x = minX;
        else if (node.x > maxX) node.x = maxX;

        if (maxY < minY) node.y = height / 2;
        else if (node.y < minY) node.y = minY;
        else if (node.y > maxY) node.y = maxY;
    }

    /**
     * Push every overlapping pair apart, once. Returns the deepest overlap it
     * found, so a caller can tell whether the field still needs work.
     *
     * Collisions are resolved as a POSITION correction weighted by area, not as
     * an impulse: separating the pair outright cannot overshoot, so the field
     * never develops the jitter a spring-based separation does at rest.
     *
     * The pairwise pass is O(n²) over one circle per expense category — a few
     * hundred checks a frame at any taxonomy this app allows — so a spatial
     * index would be complexity bought with nothing.
     */
    function separate(nodes) {
        let deepest = 0;
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let distance = Math.hypot(dx, dy);
                const wanted = a.r + b.r + GAP;
                if (distance >= wanted) continue;
                // Exactly concentric: pick an axis instead of dividing by zero.
                if (distance === 0) { dx = 1; dy = 0; distance = 1; }

                const overlap = wanted - distance;
                if (overlap > deepest) deepest = overlap;
                const unitX = dx / distance;
                const unitY = dy / distance;
                const massA = a.r * a.r;
                const massB = b.r * b.r;
                const total = massA + massB;
                // Each moves in proportion to the OTHER's mass, so a large
                // circle shoves a small one aside rather than sharing the trip.
                const shareA = massB / total;
                const shareB = massA / total;

                a.x -= unitX * overlap * shareA;
                a.y -= unitY * overlap * shareA;
                b.x += unitX * overlap * shareB;
                b.y += unitY * overlap * shareB;
            }
        }
        return deepest;
    }

    /**
     * One step of the simulation. Returns the largest distance any single
     * circle moved, which is what decides whether the field has come to rest.
     */
    function step(nodes, centerX, centerY, width, height) {
        // VERLET: a circle's velocity is implied by how far it sits from where
        // it was last tick, and is never stored. That is what lets the field
        // settle — a position correction (a collision below, a wall in
        // clampToField) takes the motion that caused it away with it, instead
        // of leaving a stored velocity to push into the same neighbour again on
        // the next tick. With stored velocities a crowded field came to rest
        // still overlapping, because gravity kept re-applying the squeeze the
        // separation had just undone.
        for (const node of nodes) {
            const carriedX = (node.x - node.px) * DAMPING;
            const carriedY = (node.y - node.py) * DAMPING;
            node.px = node.x;
            node.py = node.y;
            node.x += carriedX + (centerX - node.x) * CENTER_PULL;
            node.y += carriedY + (centerY - node.y) * CENTER_PULL;
        }

        // Separate every overlapping pair, repeatedly: see COLLISION_PASSES.
        for (let pass = 0; pass < COLLISION_PASSES; pass++) separate(nodes);

        let moved = 0;
        for (const node of nodes) {
            const beforeX = node.x;
            const beforeY = node.y;
            clampToField(node, width, height);
            // A wall that held this circle holds its previous position too, so
            // the next tick carries no motion back into the wall.
            if (node.x !== beforeX) node.px = node.x;
            if (node.y !== beforeY) node.py = node.y;
            moved = Math.max(moved, Math.hypot(node.x - node.px, node.y - node.py));
        }
        return moved;
    }

    /**
     * Take the last of the overlap out of a field that has come to rest.
     *
     * The simulation converges ON contact without quite arriving. Gravity puts
     * a fraction of the squeeze back every tick and the separation pass takes
     * it out again, so the two balance a whisker inside each other; and the
     * wall clamp runs after the last separation of a tick, so a circle held by
     * an edge can be pressed into its neighbour with nothing left to undo it.
     * At the old 6px clearance that slack hid inside the gap. With the circles
     * packing to contact it would be visible overlap, which is why this runs.
     *
     * Alternating separation with the wall clamp and NO gravity is what
     * converges: with nothing pushing the pair back together, each pass only
     * has the previous pass's leftovers to fix.
     */
    function finishContacts(nodes, width, height) {
        for (let pass = 0; pass < CONTACT_PASSES; pass++) {
            const deepest = separate(nodes);
            // A wall pushing a circle back in is exactly what puts it inside a
            // neighbour again, so a pass only counts as clean if it separated
            // nothing AND no edge had to hold anything.
            let held = false;
            for (const node of nodes) {
                const beforeX = node.x;
                const beforeY = node.y;
                clampToField(node, width, height);
                if (node.x !== beforeX || node.y !== beforeY) held = true;
            }
            if (deepest <= CONTACT_TOLERANCE && !held) break;
        }
        // These corrections are fractions of a pixel. Leaving the old previous
        // positions behind them would turn every one into motion the next time
        // the field wakes, and the field would drift when it should sit still.
        for (const node of nodes) {
            node.px = node.x;
            node.py = node.y;
        }
    }

    /**
     * Create a field inside `container`, which must be a positioned element
     * with a size of its own (the page's CSS gives it one).
     *
     *   paint(element, node)  fill a circle in — contents, classes, custom
     *                         properties. Called whenever the data changes,
     *                         never per animation frame.
     *   onActivate(node)      a circle was clicked or activated by keyboard.
     */
    function create(container, { paint, onActivate } = {}) {
        // key -> { key, value, r, x, y, px, py, el, data }
        const nodes = new Map();
        let width = 0;
        let height = 0;
        let frame = null;
        let restTicks = 0;
        let destroyed = false;

        function measure() {
            width = container.clientWidth;
            height = container.clientHeight;
        }

        /** Write every circle's size and position. The only place this file
         *  touches the DOM per frame, and it writes without reading, so no
         *  layout is forced inside the loop. */
        function paintPositions() {
            for (const node of nodes.values()) {
                const size = node.r * 2;
                node.el.style.width = `${size}px`;
                node.el.style.height = `${size}px`;
                node.el.style.transform =
                    `translate3d(${node.x - node.r}px, ${node.y - node.r}px, 0)`;
            }
        }

        function tick() {
            frame = null;
            if (destroyed) return;
            const list = [...nodes.values()];
            const moved = step(list, width / 2, height / 2, width, height);
            restTicks = moved < REST_MOVEMENT ? restTicks + 1 : 0;
            // The frame that stops the loop is the one left on screen, so it is
            // the one that has to be exact.
            const resting = restTicks >= REST_TICKS;
            if (resting) finishContacts(list, width, height);
            paintPositions();
            // Nothing schedules a frame again until the data, the size or the
            // motion preference changes.
            if (!resting) frame = requestAnimationFrame(tick);
        }

        /** Run the field to rest without drawing the journey, then paint once.
         *  Used for the first layout and for reduced motion. */
        function settleSilently() {
            const list = [...nodes.values()];
            for (let i = 0; i < MAX_SETTLE_TICKS; i++) {
                if (step(list, width / 2, height / 2, width, height) < REST_MOVEMENT) break;
            }
            finishContacts(list, width, height);
            paintPositions();
        }

        function wake({ animate }) {
            if (destroyed || !nodes.size || width <= 0 || height <= 0) return;
            if (!animate || prefersReducedMotion()) {
                if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
                settleSilently();
                return;
            }
            restTicks = 0;
            if (frame === null) frame = requestAnimationFrame(tick);
        }

        function createElement(node, seedIndex) {
            const el = document.createElement('button');
            el.type = 'button';
            // The layout contract, set here rather than left to the caller's
            // stylesheet: this file writes `transform`, `width` and `height`
            // every time the field moves, and all three are meaningless unless
            // the circle is taken out of flow. Everything else about how a
            // circle LOOKS is the caller's, via paint().
            el.style.position = 'absolute';
            el.style.top = '0';
            el.style.left = '0';
            el.addEventListener('click', () => onActivate && onActivate(node.data, node.key));
            container.appendChild(el);

            // Seed on the spiral, scaled to the field so a large container does
            // not start every circle stacked at the centre.
            const spread = Math.min(width, height) * 0.22;
            const angle = seedIndex * GOLDEN_ANGLE;
            const radius = spread * Math.sqrt(seedIndex);
            node.x = width / 2 + Math.cos(angle) * radius;
            node.y = height / 2 + Math.sin(angle) * radius;
            // Previous position == current position: seeded at rest.
            node.px = node.x;
            node.py = node.y;
            return el;
        }

        /**
         * Replace the field's contents.
         *
         * A circle whose key was already on screen KEEPS its position, so
         * stepping to another month re-sizes and re-fills the circles in place
         * instead of scattering and re-packing them. Only genuinely new keys
         * are seeded.
         */
        function setData(items) {
            if (destroyed) return;
            measure();

            const incoming = new Map(items.map((item) => [item.key, item]));
            for (const [key, node] of nodes) {
                if (incoming.has(key)) continue;
                node.el.remove();
                nodes.delete(key);
            }

            let seedIndex = nodes.size;
            for (const item of items) {
                let node = nodes.get(item.key);
                if (!node) {
                    node = { key: item.key, x: 0, y: 0, px: 0, py: 0, r: MIN_RADIUS };
                    node.el = createElement(node, seedIndex++);
                    nodes.set(item.key, node);
                }
                node.value = item.value > 0 ? item.value : 0;
                node.data = item;
                if (paint) paint(node.el, item);
            }

            const list = [...nodes.values()];
            assignRadii(list, width, height);
            // A resize can leave a circle hanging outside the new bounds; put
            // every one back inside before the first frame is drawn.
            for (const node of list) clampToField(node, width, height);
            paintPositions();
            wake({ animate: true });
        }

        // The field's size is CSS-driven (it fills what the page gives it), so
        // the container is watched rather than the window: a sidebar or zoom
        // change resizes it without a window resize event.
        const observer = new ResizeObserver(() => {
            if (destroyed) return;
            const previousWidth = width;
            const previousHeight = height;
            measure();
            if (width === previousWidth && height === previousHeight) return;
            const list = [...nodes.values()];
            assignRadii(list, width, height);
            for (const node of list) clampToField(node, width, height);
            // Re-settle without animating: a drag of the window edge would
            // otherwise start a new spring on every observed frame.
            wake({ animate: false });
        });
        observer.observe(container);

        measure();

        return {
            setData,
            destroy() {
                destroyed = true;
                if (frame !== null) cancelAnimationFrame(frame);
                observer.disconnect();
                for (const node of nodes.values()) node.el.remove();
                nodes.clear();
            },
        };
    }

    window.BubbleField = { create, MIN_RADIUS };
}());
