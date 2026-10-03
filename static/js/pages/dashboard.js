'use strict';

// ─── Dashboard ───────────────────────────────────────────────────────────────
// A page of cards the user arranges. Each tab along the top is a LAYOUT: a name
// and a set of cards on a 12-column grid, each card a widget from
// pages/dashcards.js with its own size, its own settings and its own period.
// This file runs the page around those cards: the tabs, Customize (moving,
// resizing, adding and removing cards), each card's period picker, and saving.
// What a card draws is dashcards.js's business, where a card may go is
// widgets/dashgrid.js's, and what a period means is widgets/dashperiod.js's.
//
// SAVING. Layouts live in the database (GET/PUT /api/dashboard, handlers/
// dashboard.js), and one PUT carries every layout. Outside Customize a change
// (a card's period, a chip, the open tab) saves itself a moment later. Inside
// Customize nothing is saved until Save, and every step in between can be
// undone. A database
// that never saved a layout gets the Overview layout, the Dashboard as it
// was before layouts existed. If the saved layouts cannot be read, the default
// is shown and nothing is saved, so a failed read can never overwrite them.
//
// EVERY CARD OWNS ITS PERIOD. The picker in the card's header row sets it; there
// is no page-wide date. A card may also wear a colour (the square beside its
// period, chosen from COLORS). Cards on one layout that wear the same colour are
// LINKED: they share a period, so changing it on one changes it on the rest
// (those that offer the chosen preset). Joining a colour takes on the period of
// the cards already wearing it.
//
// DRAWING. A card is drawn for the box the grid gives it. A ResizeObserver on
// each card body redraws it when that box changes, without the entrance; the
// first paint after its data arrives animates. Cards load through a small hub:
// the Store datasets (balance, ie) and a cache of the other GETs, so two cards
// over the same period share one request.
//
// SECURITY: layout names and every label a card draws are
// user-controlled. All of it passes through escapeHtml before innerHTML, and the
// chart reading is built with textContent.

(function () {
    const { TYPES, GROUPS, OVERVIEW, thumbHtml } = DashCards;

    const COLS = DashGrid.COLS;
    const ROW = 48;                 // one grid row, px
    const GAP = 16;                 // between cards, both ways, px
    const PITCH = ROW + GAP;
    const MAX_H = 12;               // tallest card in rows (handlers/dashboard.js)
    // The link colours: id → name. Each id's swatch is --dash-link-<id> (dashboard.css).
    const COLORS = {
        red: 'Red', orange: 'Orange', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink',
    };
    const MAX_LAYOUTS = 8;
    const MAX_CARDS = 40;
    const NAME_MAX = 32;
    const STACK_BELOW = 640;        // canvas width under which cards stack in one column
    const SAVE_DELAY = 600;
    const UNDO_DEPTH = 60;
    const VIEW_KEY = 'dashboard';   // ViewState slot: which widget groups are collapsed
    const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

    // Phosphor glyphs (static/icons/Phosphor), inlined like every icon in the app.
    const ph = (d) => `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${d}"></path></svg>`;
    const stroke = (inner) => `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    const ICONS = {
        plus: ph('M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z'),
        trash: ph('M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z'),
        dots: ph('M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z'),
        gear: ph('M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z'),
        sliders: stroke('<path d="M40 80h40M136 80h80M40 176h104M200 176h16"/><circle cx="108" cy="80" r="24"/><circle cx="172" cy="176" r="24"/>'),
        check: stroke('<path d="M56 136l44 44 100-104"/>'),
        // The six-dot drag handle of the Categories editor (settingsCategories.js).
        grip: '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>',
        chevron: '<svg class="cat-group-chevron" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path></svg>',
        tick: '<svg class="tx-pop-check" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };

    // ─── State ───────────────────────────────────────────────────────────────
    let state = { active: null, layouts: [] };
    const ui = {
        loaded: false,
        canSave: true,       // false once the saved layouts could not be read
        editing: false,
        undo: [],
        redo: [],
        drawerOpen: false,
        stacked: false,
    };
    const dom = {};
    const live = new Map();  // card id → { el, body, key, data, loading, error, size, sig }

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    const activeLayout = () => state.layouts.find((l) => l.id === state.active) || state.layouts[0];
    const cards = () => activeLayout().cards;
    const findCard = (id) => cards().find((c) => c.id === id);
    const cardTitle = (card) => TYPES[card.type].name;
    const resolvePeriod = (card) => DashPeriod.resolve(card.period);
    const samePeriod = (a, b) => a.preset === b.preset && a.month === b.month;
    const defaultSize = (def) => def.sizes.M || Object.values(def.sizes)[0];

    /** A card as this build draws it: a known type, settings over the type's
     *  defaults, a period the type offers, and a box inside the grid at no less
     *  than the type's minimum. null for a type this build does not know. */
    function normaliseCard(raw) {
        const def = isObject(raw) ? TYPES[raw.type] : null;
        if (!def) return null;
        const [minW, minH] = def.min;
        const [w0, h0] = defaultSize(def);
        const w = clamp(Number.isInteger(raw.w) ? raw.w : w0, minW, COLS);
        const h = clamp(Number.isInteger(raw.h) ? raw.h : h0, minH, MAX_H);
        const settings = { ...clone(def.defaults), ...(isObject(raw.settings) ? raw.settings : {}) };
        delete settings.title;  // cards are not renamed; drop a title an earlier build saved
        return {
            id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : uid('c'),
            type: raw.type,
            x: clamp(Number.isInteger(raw.x) ? raw.x : 0, 0, COLS - w),
            y: Math.max(0, Number.isInteger(raw.y) ? raw.y : 0),
            w,
            h,
            settings,
            period: DashPeriod.clean(raw.period, def.periods, def.period),
            color: !def.noLink && Object.hasOwn(COLORS, raw.color) ? raw.color : null,
        };
    }

    function normaliseLayout(raw) {
        const seen = new Set();
        const list = (Array.isArray(raw.cards) ? raw.cards : []).map(normaliseCard).filter((c) => {
            if (!c || seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
        });
        return {
            id: raw.id,
            name: String(raw.name || '').trim().slice(0, NAME_MAX) || 'Dashboard',
            cards: DashGrid.pack(list.slice(0, MAX_CARDS)),
        };
    }

    /** The default layout, for a database that has not saved one. */
    function overviewLayout() {
        return {
            id: uid('l'),
            name: OVERVIEW.name,
            cards: DashGrid.pack(OVERVIEW.cards.map((c) => normaliseCard({ ...c, id: uid('c') }))),
        };
    }

    function uniqueName(base) {
        const names = new Set(state.layouts.map((l) => l.name));
        const stem = base.slice(0, NAME_MAX);
        if (!names.has(stem)) return stem;
        for (let n = 2; ; n++) {
            const suffix = ` ${n}`;
            const candidate = `${stem.slice(0, NAME_MAX - suffix.length)}${suffix}`;
            if (!names.has(candidate)) return candidate;
        }
    }

    function announce(message) {
        if (!dom.live) return;
        dom.live.textContent = '';
        requestAnimationFrame(() => { dom.live.textContent = message; });
    }

    // ─── Data ────────────────────────────────────────────────────────────────
    // Cards load through this hub. The Store datasets are shared app-wide and
    // revalidate themselves. Every other GET is kept for the life of the page
    // (each page load is a fresh document, so nothing here outlives the data it
    // was read from), capped with the oldest out, so paging through periods
    // cannot grow it without bound. A failed request is dropped, not kept.
    const JSON_CACHE_MAX = 48;
    const jsonCache = new Map();
    const hub = {
        store: (name) => Store.ensure(name),
        json(url) {
            const hit = jsonCache.get(url);
            if (hit) {
                jsonCache.delete(url);
                jsonCache.set(url, hit);
                return hit;
            }
            const request = apiFetch(url).then((r) => {
                if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
                return r.json();
            });
            request.catch(() => { if (jsonCache.get(url) === request) jsonCache.delete(url); });
            jsonCache.set(url, request);
            if (jsonCache.size > JSON_CACHE_MAX) jsonCache.delete(jsonCache.keys().next().value);
            return request;
        },
    };

    // ─── Saving ──────────────────────────────────────────────────────────────
    let saveTimer = 0;
    let saveChain = Promise.resolve();

    /** Every layout, in the shape handlers/dashboard.js stores. */
    const payload = () => ({
        active: state.active,
        layouts: state.layouts.map((l) => ({
            id: l.id,
            name: l.name,
            cards: l.cards.map(({ id, type, x, y, w, h, settings, period, color }) => ({ id, type, x, y, w, h, settings, period, color })),
        })),
    });

    /** Save now. Writes go out one at a time, in order, so a slow save can never
     *  land after a newer one. A failure says so and keeps what is on screen;
     *  the next change saves everything again. */
    function saveNow() {
        clearTimeout(saveTimer);
        saveTimer = 0;
        if (!ui.canSave) return saveChain;
        const body = JSON.stringify(payload());
        saveChain = saveChain.then(async () => {
            try {
                const r = await apiFetch('/api/dashboard', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!r.ok) throw new Error(`PUT /api/dashboard answered ${r.status}`);
            } catch (err) {
                console.error('[dashboard] could not save the layouts', err);
                UI.toast('Could not save the dashboard', { type: 'error' });
            }
        });
        return saveChain;
    }

    /** Save shortly, outside Customize. Inside it, Save saves. */
    function saveSoon() {
        if (ui.editing || !ui.loaded || !ui.canSave) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, SAVE_DELAY);
    }

    async function loadLayouts() {
        try {
            const r = await apiFetch('/api/dashboard');
            if (!r.ok) throw new Error(`GET /api/dashboard answered ${r.status}`);
            const body = await r.json();
            const layouts = (Array.isArray(body.layouts) ? body.layouts : [])
                .filter((l) => isObject(l) && typeof l.id === 'string' && ID_RE.test(l.id))
                .slice(0, MAX_LAYOUTS)
                .map(normaliseLayout);
            if (layouts.length) {
                const active = layouts.some((l) => l.id === body.active) ? body.active : layouts[0].id;
                return { active, layouts };
            }
        } catch (err) {
            console.error('[dashboard] could not read the saved layouts; showing the default', err);
            ui.canSave = false;
            UI.toast('Could not load your saved dashboard', { type: 'error' });
        }
        const overview = overviewLayout();
        return { active: overview.id, layouts: [overview] };
    }

    // ─── Customize ───────────────────────────────────────────────────────────
    function enterEdit() {
        if (ui.editing || !ui.loaded) return;
        if (saveTimer) saveNow();
        closePopover();
        hideChartTip();
        ui.editing = true;
        ui.undo = [];
        ui.redo = [];
        dom.root.classList.add('is-editing');
        openDrawer();
        renderAll();
        announce('Customizing. Drag a card to move it, drag its corner to resize it, or focus it and use the arrow keys.');
    }

    function exitEdit() {
        if (!ui.editing) return;
        endGesture(false);
        endLibraryDrag(false);
        closePopover();
        const changed = ui.undo.length > 0;
        ui.editing = false;
        ui.undo = [];
        ui.redo = [];
        dom.root.classList.remove('is-editing');
        const refocus = dom.drawer.contains(document.activeElement);
        closeDrawer();
        renderAll();
        if (refocus) dom.customize.focus();
        if (changed) {
            saveNow();
            UI.toast('Layout saved');
        }
    }

    /** Record the layouts before a change, so it can be undone. */
    function checkpoint() {
        if (!ui.editing) return;
        ui.undo.push(clone(state));
        if (ui.undo.length > UNDO_DEPTH) ui.undo.shift();
        ui.redo = [];
    }

    function travel(from, to, message) {
        if (!from.length) return;
        to.push(clone(state));
        state = from.pop();
        renderAll();
        announce(message);
    }
    const undo = () => travel(ui.undo, ui.redo, 'Undone');
    const redo = () => travel(ui.redo, ui.undo, 'Redone');

    /** An Undo for a toast: undoes the change that pushed `mark`, and nothing if
     *  another change has been made since or Customize has ended. */
    const undoTo = (mark) => () => {
        if (ui.editing && ui.undo[ui.undo.length - 1] === mark) undo();
    };

    // ─── Geometry ────────────────────────────────────────────────────────────
    const geo = { width: 0, colW: 0 };

    function measure() {
        geo.width = dom.canvas.clientWidth;
        ui.stacked = geo.width < STACK_BELOW;
        dom.root.classList.toggle('is-stacked', ui.stacked);
        geo.colW = Math.max(0, (geo.width - GAP * (COLS - 1)) / COLS);
    }

    const spanPx = (cols) => cols * geo.colW + (cols - 1) * GAP;
    const rowsPx = (rows) => rows * ROW + (rows - 1) * GAP;
    const cellRect = (c) => ({ left: c.x * (geo.colW + GAP), top: c.y * PITCH, width: spanPx(c.w), height: rowsPx(c.h) });

    /** Pixel boxes for a layout: the grid, or one column in reading order when
     *  the canvas is too narrow for twelve. */
    function rectsFor(list) {
        const rects = new Map();
        if (!ui.stacked) {
            for (const c of list) rects.set(c.id, cellRect(c));
            return rects;
        }
        let top = 0;
        for (const c of [...list].sort(DashGrid.byPosition)) {
            const height = rowsPx(c.h);
            rects.set(c.id, { left: 0, top, width: geo.width, height });
            top += height + GAP;
        }
        return rects;
    }

    function place(el, r) {
        el.style.transform = `translate(${r.left}px, ${r.top}px)`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    }

    /** While customizing, the least height that fills the visible page below the
     *  canvas's top, in whole grid rows, so the grid cells cover the whole area. */
    function gridFillHeight() {
        if (!ui.editing || ui.stacked) return 0;
        const view = dom.scroller.getBoundingClientRect();
        const top = dom.canvas.getBoundingClientRect().top - view.top;
        const rows = Math.ceil((dom.scroller.clientHeight - top) / PITCH);
        return Math.max(0, rows * PITCH - GAP);
    }

    /** Position every card but `skipId` (the one under the pointer) and size the
     *  canvas to hold them, with room underneath while customizing. */
    function applyLayout(list, skipId = null, minBottom = 0) {
        const rects = rectsFor(list);
        let bottom = 0;
        for (const c of list) {
            const r = rects.get(c.id);
            bottom = Math.max(bottom, r.top + r.height);
            if (c.id === skipId) continue;
            const rt = live.get(c.id);
            if (rt) place(rt.el, r);
        }
        const room = ui.editing && !ui.stacked ? PITCH * 3 : 0;
        dom.canvas.style.height = `${Math.max(list.length ? bottom + room : room, minBottom, gridFillHeight())}px`;
        return rects;
    }

    function showPlaceholder(r) {
        dom.placeholder.hidden = false;
        place(dom.placeholder, r);
    }
    const hidePlaceholder = () => { dom.placeholder.hidden = true; };

    // ─── Cards ───────────────────────────────────────────────────────────────
    function createCardEl(card) {
        const el = document.createElement('article');
        el.className = 'dashboard-card dash-card';
        el.dataset.id = card.id;
        el.dataset.type = card.type;
        el.innerHTML = `
            <header class="dashboard-card-header dash-card-head">
                <span class="dash-grip" aria-hidden="true">${ICONS.grip}</span>
                <h2 class="dashboard-card-title dash-card-title"></h2>
                <div class="dash-card-controls">
                    <button type="button" class="card-gear-btn" data-act="gear" aria-haspopup="dialog" aria-expanded="false" hidden>${ICONS.gear}</button>
                    <div class="range-selector dash-period">
                        <button type="button" class="range-selector-btn dash-period-btn" data-act="period" aria-haspopup="dialog" aria-expanded="false"></button>
                    </div>
                </div>
            </header>
            <div class="dash-card-body"></div>
            <div class="dash-card-tools" role="toolbar" aria-label="Card tools">
                <button type="button" class="dash-tool" data-act="remove" title="Remove" aria-label="Remove card">${ICONS.trash}</button>
            </div>
            <span class="dash-resize" aria-hidden="true"></span>`;
        return el;
    }

    /** The header: title and info tip, the period button, and the gear when the
     *  card has one. Rewritten only when what it shows has changed. */
    function syncChrome(rt, card) {
        const def = TYPES[card.type];
        const title = cardTitle(card);
        const period = resolvePeriod(card);
        const sig = `${title}\u0000${period.short}\u0000${period.label}\u0000${card.color || ''}`;
        if (rt.chrome === sig) return;
        rt.chrome = sig;
        const info = def.info
            ? `<span class="fc-info" tabindex="0" role="note" aria-label="${escapeHtml(def.info)}" data-tip="${escapeHtml(def.info)}">i</span>`
            : '';
        rt.el.querySelector('.dash-card-title').innerHTML = `<span class="dash-card-name">${escapeHtml(title)}</span>${info}`;
        // The dates, and for a range or a look-ahead its short name as well,
        // which narrow cards show instead (dashboard.css §3).
        const compact = period.kind === 'month' ? period.short : DashPeriod.PRESETS[period.preset].short;
        const btn = rt.el.querySelector('[data-act="period"]');
        btn.closest('.dash-period').hidden = !!def.noPeriod;
        if (def.noPeriod) {
            rt.el.setAttribute('aria-label', title);
            return;
        }
        btn.classList.toggle('has-short', compact !== period.short);
        btn.innerHTML = `<span class="dash-period-long">${escapeHtml(period.short)}</span>`
            + (compact !== period.short ? `<span class="dash-period-short">${escapeHtml(compact)}</span>` : '')
            + UI.PICKER_CARET;
        btn.title = period.label;
        btn.setAttribute('aria-label', `${title} period: ${period.label}${card.color ? `, ${COLORS[card.color]} link` : ''}`);
        rt.el.setAttribute('aria-label', `${title}, ${period.label}`);
        if (card.color) btn.dataset.color = card.color; else delete btn.dataset.color;
    }

    /** The card's own checkbox list, once its data gives it one; else null. */
    function gearList(card, rt) {
        const gear = TYPES[card.type].gear;
        return gear && rt && rt.data !== undefined && !rt.error && gear.available({ card, data: rt.data }) ? gear : null;
    }

    /** The gear shows when the card has settings fields or a list to offer. */
    function syncGear(rt, card) {
        const def = TYPES[card.type];
        const list = gearList(card, rt);
        const btn = rt.el.querySelector('[data-act="gear"]');
        btn.hidden = !list && def.fields.length === 0;
        if (btn.hidden) return;
        btn.title = list ? list.title : 'Settings';
        btn.setAttribute('aria-label', list ? list.label : `${def.name} settings`);
    }

    /** What a card's data depends on: its type and its period. Settings change
     *  how a card is drawn, never what it loads. */
    const dataKey = (card) => `${card.type}|${card.period.preset}|${card.period.month || ''}`;

    function skeletonFor(card, rt) {
        const def = TYPES[card.type];
        const h = Math.max(48, rt.body.clientHeight - 8);
        return def.skeleton === 'rows' ? UI.skRows(Math.max(1, Math.min(6, Math.floor(h / 44)))) : UI.skChart(h);
    }

    /** Load a card's data for its period, unless it already has it. The paint
     *  that follows animates, unless `quiet` (a background refresh). */
    function loadCard(card, { force = false, quiet = false } = {}) {
        const rt = live.get(card.id);
        const key = dataKey(card);
        if (!force && rt.key === key) return;
        rt.key = key;
        const token = {};
        rt.loading = token;
        const def = TYPES[card.type];
        const period = resolvePeriod(card);
        const cancelSkeleton = quiet ? () => {} : UI.skeletonGuard(() => {
            if (rt.loading === token) rt.body.innerHTML = skeletonFor(card, rt);
        });
        Promise.resolve()
            .then(() => def.load({ card, period, hub }))
            .then((data) => {
                if (rt.loading !== token) return;
                rt.data = data;
                rt.error = null;
            }, (err) => {
                if (rt.loading !== token) return;
                console.error(`[dashboard] ${card.type} could not load`, err);
                rt.data = undefined;
                rt.error = err;
            })
            .finally(() => {
                if (rt.loading !== token) return;
                cancelSkeleton();
                rt.loading = null;
                paint(card.id, !quiet);
            });
    }

    function holdEntrance(el) {
        el.classList.add('chart-anim-hold');
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('chart-anim-hold')));
    }

    /** Draw one card's body for the box it has now. */
    function paint(id, animate = false) {
        const rt = live.get(id);
        const card = findCard(id);
        if (!rt || !card || rt.loading) return;
        if (rt.data === undefined && !rt.error) return;
        const w = rt.body.clientWidth;
        const h = rt.body.clientHeight;
        rt.size = `${w}x${h}`;
        rt.sig = JSON.stringify(card.settings);
        if (w < 24 || h < 24) return;
        if (hover.body === rt.body) hideChartTip();
        if (rt.error) {
            rt.body.innerHTML = UI.emptyState({ icon: null, compact: true, title: 'Could not load this card' });
        } else {
            const def = TYPES[card.type];
            try {
                def.render(rt.body, { card, period: resolvePeriod(card), data: rt.data, w, h, animate, hub });
                if (animate) holdEntrance(rt.body);
            } catch (err) {
                console.error(`[dashboard] ${card.type} could not draw`, err);
                rt.body.innerHTML = UI.emptyState({ icon: null, compact: true, title: 'Could not draw this card' });
            }
        }
        syncGear(rt, card);
    }

    // Redraws after a resize are batched into the next frame, without the
    // entrance, so dragging a card's corner or the window edge never strobes.
    const pendingPaints = new Set();
    let paintFrame = 0;
    function schedulePaint(id) {
        pendingPaints.add(id);
        if (!paintFrame) {
            paintFrame = requestAnimationFrame(() => {
                paintFrame = 0;
                const ids = [...pendingPaints];
                pendingPaints.clear();
                for (const pid of ids) paint(pid, false);
            });
        }
    }

    const bodyObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const id = entry.target.closest('.dash-card')?.dataset.id;
            const rt = id && live.get(id);
            if (rt && rt.size !== `${entry.target.clientWidth}x${entry.target.clientHeight}`) schedulePaint(id);
        }
    });

    function dropCard(id) {
        const rt = live.get(id);
        if (!rt) return;
        bodyObserver.unobserve(rt.body);
        if (hover.body === rt.body) hideChartTip();
        rt.el.remove();
        live.delete(id);
    }

    /** Bring the canvas in line with the active layout: drop the cards that
     *  left it, build the ones that joined, refresh the rest, and lay it out. */
    function renderCanvas({ enter = false } = {}) {
        const list = cards();
        const ids = new Set(list.map((c) => c.id));
        for (const id of [...live.keys()]) if (!ids.has(id)) dropCard(id);

        const rects = rectsFor(list);
        const ordered = [...list].sort(DashGrid.byPosition);
        let stagger = 0;
        for (const card of ordered) {
            let rt = live.get(card.id);
            if (!rt) {
                const el = createCardEl(card);
                place(el, rects.get(card.id));
                if (enter && !reduceMotion()) {
                    el.classList.add('is-entering');
                    el.style.animationDelay = `${Math.min(stagger++, 8) * 40}ms`;
                    el.addEventListener('animationend', () => {
                        el.classList.remove('is-entering');
                        el.style.animationDelay = '';
                    }, { once: true });
                }
                dom.canvas.appendChild(el);
                rt = { el, body: el.querySelector('.dash-card-body'), key: null, data: undefined, loading: null, error: null, size: '', sig: '', chrome: '' };
                live.set(card.id, rt);
                bodyObserver.observe(rt.body);
            }
            syncChrome(rt, card);
            syncGear(rt, card);
            rt.el.tabIndex = ui.editing ? 0 : -1;
            rt.el.setAttribute('aria-roledescription', ui.editing ? 'movable card' : 'card');
            if (rt.key !== dataKey(card)) loadCard(card);
            else if (rt.sig !== JSON.stringify(card.settings)) paint(card.id, true);
        }

        // Keep the document order the reading order, so Tab walks the cards the
        // way they are laid out. Only moved when it differs: moving a node
        // restarts its animations.
        const inDom = [...dom.canvas.querySelectorAll(':scope > .dash-card')];
        if (inDom.some((el, i) => el.dataset.id !== ordered[i]?.id)) {
            for (const card of ordered) dom.canvas.appendChild(live.get(card.id).el);
        }

        applyLayout(list);
        dom.canvas.setAttribute('aria-label', activeLayout().name);
        // While customizing, the empty grid is the prompt.
        dom.empty.hidden = list.length > 0 || ui.editing;
    }

    /** Redraw every card from the data in hand: a theme or palette change,
     *  whose colours the charts baked into their SVG. */
    function repaintAll() {
        if (!ui.loaded) return;
        for (const card of cards()) paint(card.id, false);
    }

    /** A Store dataset was refreshed in the background: reload, quietly, the
     *  cards that read it. */
    function refreshUsers(name) {
        for (const card of cards()) {
            if (TYPES[card.type].uses.includes(name) && live.has(card.id)) loadCard(card, { force: true, quiet: true });
        }
    }

    // ─── Toolbar ─────────────────────────────────────────────────────────────
    function renderTabs() {
        const tabs = state.layouts.map((l) => {
            const on = l.id === state.active;
            return `<button type="button" class="dash-tab" role="tab" data-layout="${escapeHtml(l.id)}"
                aria-selected="${on}" tabindex="${on ? 0 : -1}">${escapeHtml(l.name)}</button>`;
        }).join('');
        const full = state.layouts.length >= MAX_LAYOUTS;
        // New layout and Layout options are Customize tools, so they only show
        // while customizing.
        dom.tabs.innerHTML = `<div class="dash-tabs" role="tablist" aria-label="Layouts">${tabs}</div>
            ${ui.editing ? `<button type="button" class="p-menu-btn" data-act="new-layout" title="New layout" aria-label="New layout"${full ? ' disabled' : ''}>${ICONS.plus}</button>
            <button type="button" class="p-menu-btn" data-act="layout-menu" title="Layout options"
                aria-label="Layout options" aria-haspopup="menu" aria-expanded="false">${ICONS.dots}</button>` : ''}`;
    }

    /** The Customize button, built once and then kept in step by syncControls,
     *  so a click never replaces the button it landed on. */
    function buildControls() {
        dom.actions.innerHTML = `<button type="button" class="button-secondary dash-customize" data-act="customize"
            aria-label="Customize" title="Customize" aria-pressed="false" disabled>${ICONS.sliders}</button>`;
        dom.customize = dom.actions.firstElementChild;
    }

    function syncControls() {
        dom.customize.disabled = !ui.loaded;
        dom.customize.setAttribute('aria-pressed', String(ui.editing));
    }

    function renderAll(opts) {
        renderTabs();
        syncControls();
        renderCanvas(opts);
        if (ui.drawerOpen) renderWidgets();
    }

    // ─── Popovers ────────────────────────────────────────────────────────────
    // One at a time: a dropdown menu, a card's period picker or its gear. Each
    // is mounted on <body> and fixed to the viewport, because the cards and the
    // .page scroll box would clip it, and is placed under its opener, flipping
    // above it when there is no room below.
    let pop = null;   // { el, anchor, align }

    function positionPopover() {
        if (!pop) return;
        const { el, anchor, align } = pop;
        const r = anchor.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const left = clamp(align === 'end' ? r.right - w : r.left, 8, window.innerWidth - w - 8);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
    }

    function mountPopover(el, anchor, align = 'start') {
        closePopover();
        document.body.appendChild(el);
        pop = { el, anchor, align };
        positionPopover();
        anchor.setAttribute('aria-expanded', 'true');
        // Focus starts on the current choice when there is one.
        requestAnimationFrame(() => {
            if (!pop || pop.el !== el) return;
            (el.querySelector('[aria-pressed="true"]:not(:disabled)') || el.querySelector('button:not(:disabled)'))?.focus();
        });
    }

    function closePopover(restoreFocus = false) {
        if (!pop) return;
        const { el, anchor } = pop;
        pop = null;
        el.remove();
        if (anchor.isConnected) {
            anchor.setAttribute('aria-expanded', 'false');
            if (restoreFocus) anchor.focus();
        }
    }

    /**
     * A dropdown in the app's menu chrome (.p-table-dropdown, ui.css), in
     * titled sections: [{ label?, items: [{ label, run, danger?, disabled? }] }].
     * UI.openMenu mounts its menu inside the opener's parent, where the page's
     * scroll box clips it; this one is fixed to the viewport instead.
     */
    function openMenu(anchor, sections, align = 'start') {
        const el = document.createElement('div');
        el.className = 'p-table-dropdown dash-menu';
        el.setAttribute('role', 'menu');
        const scroll = document.createElement('div');
        scroll.className = 'p-dropdown-scroll';
        for (const section of sections) {
            if (section.label) {
                const head = document.createElement('div');
                head.className = 'tx-pop-group-label';
                head.textContent = section.label;
                scroll.appendChild(head);
            }
            for (const item of section.items) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `p-dropdown-item${item.danger ? ' p-dropdown-item-danger' : ''}`;
                btn.setAttribute('role', 'menuitem');
                btn.textContent = item.label;
                btn.disabled = !!item.disabled;
                btn.addEventListener('click', () => {
                    closePopover();
                    item.run();
                });
                scroll.appendChild(btn);
            }
        }
        el.appendChild(scroll);
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...el.querySelectorAll('.p-dropdown-item:not(:disabled)')];
            const i = items.indexOf(document.activeElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        });
        mountPopover(el, anchor, align);
    }

    // ─── Layout commands ─────────────────────────────────────────────────────
    function switchLayout(id) {
        if (id === state.active || !state.layouts.some((l) => l.id === id)) return;
        closePopover();
        state.active = id;
        dom.scroller.scrollTop = 0;
        renderAll({ enter: true });
        saveSoon();
        announce(`${activeLayout().name} layout`);
    }

    /** A new tab: 'blank', or a 'copy' of the open one. */
    function createLayout(kind) {
        if (state.layouts.length >= MAX_LAYOUTS) return;
        if (!ui.editing) enterEdit();
        checkpoint();
        let layout;
        if (kind === 'blank') {
            layout = { id: uid('l'), name: uniqueName('New layout'), cards: [] };
        } else {
            const from = activeLayout();
            layout = {
                id: uid('l'),
                name: uniqueName(`${from.name} copy`),
                cards: from.cards.map((c) => ({ ...clone(c), id: uid('c') })),
            };
        }
        state.layouts.push(layout);
        state.active = layout.id;
        dom.scroller.scrollTop = 0;
        renderAll({ enter: true });
        if (kind === 'blank') openDrawer();
        announce(`${layout.name} layout created`);
    }

    function renameLayout() {
        const layout = activeLayout();
        const { overlay, close } = UI.dialog(`
            <p><strong>Rename layout</strong></p>
            <input type="text" class="tx-input dash-rename-input" maxlength="${NAME_MAX}" aria-label="Layout name">
            <div class="confirm-actions">
                <button type="button" class="db-btn confirm-cancel">Cancel</button>
                <button type="button" class="db-btn db-btn-primary confirm-add">Rename</button>
            </div>`, { className: 'dash-rename-dialog' });
        const input = overlay.querySelector('.dash-rename-input');
        input.value = layout.name;
        input.focus();
        input.select();
        const apply = () => {
            const name = input.value.trim().slice(0, NAME_MAX);
            close();
            if (!name || name === layout.name) return;
            checkpoint();
            layout.name = name;
            renderTabs();
            dom.canvas.setAttribute('aria-label', name);
            announce(`Renamed to ${name}`);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
        overlay.querySelector('.confirm-add').addEventListener('click', apply);
    }

    async function deleteLayout() {
        if (state.layouts.length < 2) return;
        const layout = activeLayout();
        const ok = await UI.confirm({ message: `<p>Delete <strong>${escapeHtml(layout.name)}</strong>?</p>` });
        if (!ok || !ui.editing || activeLayout() !== layout) return;
        checkpoint();
        const mark = ui.undo[ui.undo.length - 1];
        const i = state.layouts.indexOf(layout);
        state.layouts.splice(i, 1);
        state.active = state.layouts[Math.max(0, i - 1)].id;
        renderAll({ enter: true });
        UI.toast(`Deleted ${layout.name}`, { action: { label: 'Undo', run: undoTo(mark) } });
    }

    function openLayoutMenu(anchor) {
        openMenu(anchor, [{ items: [
            { label: 'Rename', run: renameLayout },
            { label: 'Duplicate', run: () => createLayout('copy'), disabled: state.layouts.length >= MAX_LAYOUTS },
            { label: 'Delete layout', run: deleteLayout, danger: true, disabled: state.layouts.length < 2 },
        ] }]);
    }

    // ─── Card commands ───────────────────────────────────────────────────────
    function flashCard(id) {
        const rt = live.get(id);
        if (!rt) return;
        rt.el.classList.remove('is-flash');
        void rt.el.offsetWidth;   // restart the animation
        rt.el.classList.add('is-flash');
        const r = rectsFor(cards()).get(id);
        if (!r) return;
        const view = dom.scroller;
        const top = r.top + dom.canvas.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
        if (top < view.scrollTop || top + r.height > view.scrollTop + view.clientHeight) {
            view.scrollTo({ top: Math.max(0, top - 24), behavior: reduceMotion() ? 'auto' : 'smooth' });
        }
    }

    /** Add a widget: at `at` when it was dropped on the grid, else in the
     *  highest free spot. Returns the new card's id. */
    function addWidget(type, at = null) {
        const def = TYPES[type];
        if (!def || cards().length >= MAX_CARDS) return null;
        if (!ui.editing) enterEdit();
        const layout = activeLayout();
        checkpoint();
        const [w, h] = defaultSize(def);
        const card = normaliseCard({ type, w, h, id: uid('c') });
        if (at) {
            layout.cards = DashGrid.arrangeMove(layout.cards, { ...card, x: at.x, y: at.y });
        } else {
            const spot = DashGrid.firstFit(layout.cards, card.w);
            layout.cards = DashGrid.stack([...DashGrid.pack(layout.cards), { ...card, ...spot }]);
        }
        renderCanvas();
        if (ui.drawerOpen) renderWidgets();
        flashCard(card.id);
        announce(`${def.name} added`);
        return card.id;
    }

    function removeCard(id) {
        const card = findCard(id);
        if (!card) return;
        const title = cardTitle(card);
        checkpoint();
        const mark = ui.undo[ui.undo.length - 1];
        const layout = activeLayout();
        layout.cards = DashGrid.pack(layout.cards.filter((c) => c.id !== id));
        renderCanvas();
        if (ui.drawerOpen) renderWidgets();
        UI.toast(`Removed ${title}`, { action: { label: 'Undo', run: undoTo(mark) } });
        announce(`${title} removed`);
    }

    /** Merge `patch` into a card's settings and redraw it. */
    function updateSettings(id, patch) {
        const card = findCard(id);
        if (!card) return;
        checkpoint();
        card.settings = { ...card.settings, ...patch };
        const rt = live.get(id);
        if (rt) {
            syncChrome(rt, card);
            paint(id, true);
        }
        saveSoon();
    }

    /** Give `card` the period `spec` if it offers that preset. True when it changed. */
    function adoptPeriod(card, spec) {
        const def = TYPES[card.type];
        if (!def.periods.includes(spec.preset)) return false;
        const next = DashPeriod.clean(spec, def.periods, def.period);
        if (samePeriod(next, card.period)) return false;
        card.period = next;
        return true;
    }

    /** Redraw a card's header and fetch its data after its period changed. */
    function refreshCard(card) {
        const rt = live.get(card.id);
        if (!rt) return;
        syncChrome(rt, card);
        loadCard(card);
    }

    /** Set a card's period, and the period of every card linked to it by colour.
     *  Outside Customize it saves like any other choice. */
    function setPeriod(id, spec) {
        const card = findCard(id);
        if (!card) return;
        const def = TYPES[card.type];
        const next = DashPeriod.clean(spec, def.periods, def.period);
        if (samePeriod(next, card.period)) return;
        checkpoint();
        card.period = next;
        const changed = [card];
        if (card.color) {
            for (const other of cards()) {
                if (other !== card && other.color === card.color && adoptPeriod(other, card.period)) changed.push(other);
            }
        }
        changed.forEach(refreshCard);
        saveSoon();
        announce(`${cardTitle(card)}: ${resolvePeriod(card).label}`);
    }

    /** Set (or clear, with null) a card's link colour. Joining a colour takes on
     *  the period of the cards already wearing it. */
    function setColor(id, color) {
        const card = findCard(id);
        const next = Object.hasOwn(COLORS, color) ? color : null;
        if (!card || TYPES[card.type].noLink || card.color === next) return;
        checkpoint();
        card.color = next;
        const mate = next && cards().find((c) => c !== card && c.color === next);
        if (mate) adoptPeriod(card, mate.period);
        const rt = live.get(id);
        if (rt) syncChrome(rt, card);
        if (mate) refreshCard(card);
        saveSoon();
        announce(next ? `${cardTitle(card)}: ${COLORS[next]} link` : `${cardTitle(card)}: no link`);
    }

    // ─── Period picker ───────────────────────────────────────────────────────
    // Opened from the button in a card's header row. Built from the Transactions
    // filter popover's parts (.tx-filter-popover, its eyebrow labels and preset
    // pills), so it reads as the app's own picker rather than a new one. Picking
    // a month or a range closes it; stepping the year keeps it open.
        /** The years the month stepper offers: the card's own data when it carries
     *  statement years, else a decade back. */
    function pickerYears(card) {
        const years = live.get(card.id)?.data?.years;
        const now = new Date().getFullYear();
        const known = Array.isArray(years) ? years.filter(Number.isInteger) : [];
        const first = known.length ? Math.min(now, ...known) : now - 10;
        return Array.from({ length: now - first + 1 }, (_, i) => now - i);
    }

    /** Put the month stepper into the picker's Month field, if the card has one. */
    function mountMonthStepper(el, card) {
        const host = el.querySelector('.dash-pop-stepper');
        if (!host) return;
        const chosen = card.period.preset === 'month' ? resolvePeriod(card).first : null;
        MonthStepper.create(host, {
            label: `${cardTitle(card)} month`,
            yearOptions: () => pickerYears(card),
            initial: chosen,
            onChange: ({ year, monthIdx }) => {
                setPeriod(card.id, { ...card.period, preset: 'month', month: DashPeriod.formatMonth({ year, monthIdx }) });
                renderPicker(el, card.id, '[data-pick="month"]');
            },
        });
    }

    /** Redraw the open picker for the card's current period, then refocus. */
    function renderPicker(el, id, focusSelector) {
        const card = findCard(id);
        if (!card) { closePopover(true); return; }
        el.innerHTML = periodPickerHtml(card);
        mountMonthStepper(el, card);
        positionPopover();
        el.querySelector(`${focusSelector}:not(:disabled)`)?.focus();
    }

    function periodPickerHtml(card) {
        const def = TYPES[card.type];
        const spec = card.period;
        const now = new Date();
        const current = { year: now.getFullYear(), monthIdx: now.getMonth() };
        const pill = (action, label, on, { title = '', disabled = false, cls = '' } = {}) =>
            `<button type="button" class="tx-pop-preset${on ? ' is-selected' : ''}${cls ? ` ${cls}` : ''}" data-pp="${action}"
                aria-pressed="${on}"${title ? ` title="${escapeHtml(title)}"` : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
        // The joined segmented control (.range-group, ui.css): one shape with
        // rounded ends and an accent fill on the chosen segment.
        const rangeButtons = (items) => items.map(({ action, text, on, title }) =>
            `<button type="button" class="range-group-btn" data-pp="${action}" aria-pressed="${on}" title="${escapeHtml(title)}">${escapeHtml(text)}</button>`).join('');
        const group = (label, items) => `<div class="tx-pop-field"><span class="tx-pop-label">${label}</span>
            <div class="range-group" role="group" aria-label="${label}">${rangeButtons(items)}</div></div>`;
        let html = '';

        if (def.periods.includes('month')) {
            const following = spec.preset === 'month' && !spec.month;
            html += `<div class="tx-pop-field">
                <span class="tx-pop-label">Month</span>
                <div class="dash-pop-stepper"></div>
                ${pill('latest', 'This month', following, { cls: 'dash-pop-wide', title: DashPeriod.longLabel([current]) })}
            </div>`;
        }

        const segments = (kind) => def.periods.filter((p) => DashPeriod.PRESETS[p].kind === kind).map((p) => ({
            action: `preset:${p}`,
            text: DashPeriod.PRESETS[p].short,
            on: spec.preset === p,
            title: kind === 'range' ? `${DashPeriod.PRESETS[p].name}: ${DashPeriod.resolve({ preset: p }).label}` : DashPeriod.resolve({ preset: p }).label,
        }));
        const ranges = segments('range');
        if (ranges.length) html += `<div class="tx-pop-field"><div class="range-group" role="group" aria-label="Range">${rangeButtons(ranges)}</div></div>`;
        const ahead = segments('ahead');
        if (ahead.length) html += group('Ahead', ahead);

        if (def.noLink) return html;

        const swatch = (key, name) => {
            const on = (card.color || '') === key;
            return `<button type="button" class="dash-swatch${on ? ' is-selected' : ''}" data-pp="color:${key}" data-color="${key}"
                role="radio" aria-checked="${on}" aria-label="${name}" title="${name}"></button>`;
        };
        html += `<div class="tx-pop-field"><span class="tx-pop-label">Link</span>
            <div class="dash-swatches" role="radiogroup" aria-label="Link color">${
                Object.entries(COLORS).map(([key, name]) => swatch(key, name)).join('')}${swatch('', 'No link')}</div></div>`;
        return html;
    }

    /** Run one picker action. Returns true when the picker stays open. */
    function periodAction(id, action) {
        const card = findCard(id);
        if (!card) return false;
        const [verb, arg] = action.split(':');
        switch (verb) {
            case 'latest': setPeriod(id, { ...card.period, preset: 'month', month: null }); return false;
            case 'month': setPeriod(id, { ...card.period, preset: 'month', month: arg }); return false;
            case 'preset': setPeriod(id, { ...card.period, preset: arg, month: null }); return false;
            case 'color': setColor(id, arg || null); return true;
            default: return false;
        }
    }

    function openPeriodPicker(anchor, id) {
        const card = findCard(id);
        if (!card) return;
        if (pop && pop.anchor === anchor) { closePopover(true); return; }
        const el = document.createElement('div');
        el.className = 'tx-filter-popover dash-pop dash-period-pop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', `${cardTitle(card)} period`);
        el.innerHTML = periodPickerHtml(card);
        mountMonthStepper(el, card);
        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-pp]');
            if (!btn || btn.disabled) return;
            const action = btn.dataset.pp;
            if (!periodAction(id, action)) { closePopover(true); return; }
            renderPicker(el, id, `[data-pp="${action}"]`);
        });
        mountPopover(el, anchor, 'end');
    }

    // ─── Gear ────────────────────────────────────────────────────────────────
    // A card's header menu: its settings fields as segmented choices (Recent
    // Transactions: which rows it lists), then its own
    // checkbox list when it has one (Account Balances: which accounts its chips
    // offer), in the Transactions filter popover's style.
    function gearHtml(card) {
        const rt = live.get(card.id);
        const fields = TYPES[card.type].fields.map((f) => `<div class="tx-pop-field">
                <span class="tx-pop-label">${escapeHtml(f.label)}</span>
                <div class="seg-switch" role="group" aria-label="${escapeHtml(f.label)}">${f.options.map(([value, label]) => {
                    const on = String(card.settings[f.key]) === value;
                    return `<button type="button" class="seg-switch-btn${on ? ' active' : ''}" aria-pressed="${on}"
                        data-field="${escapeHtml(f.key)}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
                }).join('')}</div>
            </div>`).join('');
        const list = gearList(card, rt);
        if (!list) return fields;
        const options = list.options({ card, data: rt.data });
        return `${fields}<div class="tx-pop-label">${escapeHtml(list.heading)}</div>
            <div class="tx-pop-options" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(list.heading)}">${options.map((o) =>
                `<button type="button" class="tx-pop-option${o.on ? ' is-selected' : ''}" role="option" aria-selected="${o.on}" data-key="${escapeHtml(o.key)}">
                    <span class="tx-pop-box">${ICONS.tick}</span><span class="tx-pop-option-label">${escapeHtml(o.label)}</span></button>`).join('')}</div>`;
    }

    function openGear(anchor, id) {
        const card = findCard(id);
        if (!card || !live.has(id) || anchor.hidden) return;
        if (pop && pop.anchor === anchor) { closePopover(true); return; }
        const el = document.createElement('div');
        el.className = 'tx-filter-popover dash-pop dash-gear-pop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', anchor.title);
        el.innerHTML = gearHtml(card);
        el.addEventListener('click', (e) => {
            const now = findCard(id);
            if (!now) return;
            const field = e.target.closest('[data-field]');
            const option = e.target.closest('.tx-pop-option');
            let refocus;
            if (field) {
                const { field: key, value } = field.dataset;
                if (String(now.settings[key]) === value) return;
                updateSettings(id, { [key]: value });
                refocus = `[data-field="${CSS.escape(key)}"][data-value="${CSS.escape(value)}"]`;
            } else if (option) {
                const list = gearList(now, live.get(id));
                if (!list) return;
                updateSettings(id, list.toggle({ card: now, data: live.get(id).data }, option.dataset.key));
                refocus = `.tx-pop-option[data-key="${CSS.escape(option.dataset.key)}"]`;
            } else {
                return;
            }
            el.innerHTML = gearHtml(findCard(id));
            el.querySelector(refocus)?.focus();
        });
        mountPopover(el, anchor, 'end');
    }

    /** A chip in a card body switched a series or an account on or off. */
    function toggleChip(id, key) {
        const card = findCard(id);
        const rt = live.get(id);
        const def = card && TYPES[card.type];
        if (!def || !def.chip || !rt || rt.data === undefined) return;
        updateSettings(id, def.chip({ card, data: rt.data }, key));
    }

    // ─── Customize panel ─────────────────────────────────────────────────────
    // A panel on the right, hanging from the Customize button, that pushes the
    // grid over rather than covering it. It is open exactly while customizing:
    // every widget in collapsible groups, then Save in the header. Undo and redo
    // are Ctrl+Z and Ctrl+Y, and the layout tools sit beside the layout tabs.
    // A card's period and settings are not in here: both are set from the card
    // itself, the period picker and the gear in its header.
    function openDrawer() {
        ui.drawerOpen = true;
        dom.drawer.classList.add('is-open');
        dom.drawer.inert = false;
        renderWidgets();
    }

    function closeDrawer() {
        ui.drawerOpen = false;
        dom.drawer.classList.remove('is-open');
        dom.drawer.inert = true;
    }

    /** The groups folded away, kept for the window's session. Until the user
     *  folds or opens one, every group but the first starts collapsed. */
    function collapsedGroups() {
        const saved = ViewState.get(VIEW_KEY);
        if (saved && Array.isArray(saved.collapsed)) return new Set(saved.collapsed);
        return new Set(GROUPS.slice(1).map((group) => group.name));
    }

    function setGroupCollapsed(name, collapsed) {
        const set = collapsedGroups();
        if (collapsed) set.add(name);
        else set.delete(name);
        ViewState.set(VIEW_KEY, { collapsed: [...set] });
    }

    const groupDomId = (name) => `dash-group-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    /** The widget groups, each folded or open as the user left it. */
    function renderWidgets() {
        const collapsed = collapsedGroups();
        const onLayout = new Set(cards().map((c) => c.type));
        const groups = GROUPS.map((group) => {
            const open = !collapsed.has(group.name);
            const id = groupDomId(group.name);
            const items = group.types.map((t) => {
                const def = TYPES[t];
                return `<li class="dash-widget" data-type="${t}">
                    <span class="dash-widget-thumb">${thumbHtml(t)}</span>
                    <span class="dash-widget-text">
                        <span class="dash-widget-name">${escapeHtml(def.name)}</span>
                        ${onLayout.has(t) ? '<span class="dash-widget-meta">On this layout</span>' : ''}
                    </span>
                </li>`;
            }).join('');
            return `<section class="cat-group dash-group">
                <button type="button" class="cat-group-head" data-group="${escapeHtml(group.name)}" aria-expanded="${open}"
                    aria-controls="${id}">
                    <span class="cat-group-title">${escapeHtml(group.name)}</span>
                    <span class="cat-group-meta">${group.types.length} widget${group.types.length === 1 ? '' : 's'}</span>
                    ${ICONS.chevron}
                </button>
                <ul class="dash-widget-list" id="${id}"${open ? '' : ' hidden'}>${items}</ul>
            </section>`;
        }).join('');
        dom.drawerBody.innerHTML = `<div class="cat-groups dash-groups">${groups}</div>`;
    }

    function toggleGroup(head) {
        const open = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', String(open));
        document.getElementById(head.getAttribute('aria-controls')).hidden = !open;
        setGroupCollapsed(head.dataset.group, !open);
    }

    // ─── Dragging a widget onto the grid ─────────────────────────────────────
    // Press a widget in the panel and drag it over the grid: a placeholder shows
    // where it would land and the cards make room, as they do for a moved card.
    // A press without a drag adds it in the highest free spot.
    let libDrag = null;

    function onLibraryPointerDown(e) {
        const item = e.target.closest('.dash-widget');
        if (!item || e.button !== 0 || gesture || libDrag) return;
        if (cards().length >= MAX_CARDS) return;
        e.preventDefault();
        libDrag = { type: item.dataset.type, item, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false };
        capturePointer(item, e.pointerId);
        item.addEventListener('pointermove', onLibraryMove);
        item.addEventListener('pointerup', onLibraryUp);
        item.addEventListener('pointercancel', onLibraryCancel);
    }

    function onLibraryMove(e) {
        const d = libDrag;
        if (!d || e.pointerId !== d.pointerId) return;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        if (!d.started) {
            if (ui.stacked || Math.hypot(d.lastX - d.startX, d.lastY - d.startY) < 5) return;
            d.started = true;
            const def = TYPES[d.type];
            const [w, h] = defaultSize(def);
            d.card = { id: '__new', type: d.type, x: 0, y: 0, w, h };
            d.base = cards().map((c) => ({ ...c }));
            d.ghost = document.createElement('div');
            d.ghost.className = 'dash-drag-ghost';
            d.ghost.innerHTML = `<span class="dash-widget-thumb">${thumbHtml(d.type)}</span><span class="dash-widget-name">${escapeHtml(def.name)}</span>`;
            document.body.appendChild(d.ghost);
            hideChartTip();
            startAutoScroll();
        }
        updateLibraryDrag();
    }

    function updateLibraryDrag() {
        const d = libDrag;
        d.ghost.style.transform = `translate(${d.lastX + 12}px, ${d.lastY + 12}px)`;
        const cr = dom.canvas.getBoundingClientRect();
        const sr = dom.scroller.getBoundingClientRect();
        const over = d.lastX >= cr.left && d.lastX <= cr.right && d.lastY >= sr.top && d.lastY <= sr.bottom
            && !dom.drawer.contains(document.elementFromPoint(d.lastX, d.lastY));
        d.ghost.classList.toggle('is-over', over);
        if (!over) {
            if (d.preview) {
                d.preview = null;
                applyLayout(d.base);
                hidePlaceholder();
            }
            return;
        }
        const left = d.lastX - cr.left - spanPx(d.card.w) / 2;
        const top = Math.min(d.lastY - cr.top - 24, DashGrid.bottom(d.base) * PITCH + PITCH);
        const x = clamp(Math.round(left / (geo.colW + GAP)), 0, COLS - d.card.w);
        const y = Math.max(0, Math.round(top / PITCH));
        if (d.preview && d.at.x === x && d.at.y === y) return;
        d.at = { x, y };
        d.preview = DashGrid.arrangeMove(d.base, { ...d.card, x, y });
        const rects = applyLayout(d.preview, '__new', top + rowsPx(d.card.h) + PITCH);
        showPlaceholder(rects.get('__new'));
    }

    function endLibraryDrag(commit) {
        const d = libDrag;
        if (!d) return;
        libDrag = null;
        d.item.removeEventListener('pointermove', onLibraryMove);
        d.item.removeEventListener('pointerup', onLibraryUp);
        d.item.removeEventListener('pointercancel', onLibraryCancel);
        if (d.item.hasPointerCapture?.(d.pointerId)) d.item.releasePointerCapture(d.pointerId);
        stopAutoScroll();
        if (!d.started) {
            if (commit) addWidget(d.type);
            return;
        }
        d.ghost.remove();
        hidePlaceholder();
        if (commit && d.preview) {
            const placed = d.preview.find((c) => c.id === '__new');
            addWidget(d.type, { x: placed.x, y: placed.y });
        } else {
            applyLayout(cards());
        }
    }

    const onLibraryUp = (e) => { if (libDrag && e.pointerId === libDrag.pointerId) endLibraryDrag(true); };
    const onLibraryCancel = () => endLibraryDrag(false);

    // ─── Moving and resizing ─────────────────────────────────────────────────
    // The card under the pointer follows it exactly; a dashed placeholder and
    // the other cards show where everything will land, recomputed only when the
    // snapped cell changes. Letting go settles the card into the placeholder.
    let gesture = null;

    /** Capture keeps a drag alive when the pointer outruns the card. It can be
     *  refused (the button already lifted), and the drag still works without. */
    function capturePointer(el, pointerId) {
        try {
            el.setPointerCapture(pointerId);
        } catch (err) {
            console.warn('[dashboard] pointer capture refused; continuing without it', err);
        }
    }

    function onCardPointerDown(e) {
        if (!ui.editing || e.button !== 0 || gesture || libDrag) return;
        const el = e.target.closest('.dash-card');
        if (!el) return;
        if (e.target.closest('.dash-card-tools, .dash-card-controls, .fc-info')) return;
        const mode = e.target.closest('.dash-resize') ? 'resize' : 'move';
        e.preventDefault();
        el.focus({ preventScroll: true });
        gesture = { mode, id: el.dataset.id, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false };
        capturePointer(el, e.pointerId);
        el.addEventListener('pointermove', onGestureMove);
        el.addEventListener('pointerup', onGestureUp);
        el.addEventListener('pointercancel', onGestureCancel);
        el.addEventListener('lostpointercapture', onGestureCancel);
        if (mode === 'resize' && !ui.stacked) beginGesture();
    }

    function onGestureMove(e) {
        const g = gesture;
        if (!g || e.pointerId !== g.pointerId) return;
        g.lastX = e.clientX;
        g.lastY = e.clientY;
        if (!g.started) {
            if (ui.stacked || Math.hypot(g.lastX - g.startX, g.lastY - g.startY) < 5) return;
            beginGesture();
        }
        updateGesture();
    }

    function beginGesture() {
        const g = gesture;
        g.started = true;
        g.before = clone(state);
        g.base = cards().map((c) => ({ ...c }));
        g.card = g.base.find((c) => c.id === g.id);
        g.def = TYPES[g.card.type];
        g.rect = cellRect(g.card);
        // Never more than a row below the lowest card, so a drag cannot lengthen
        // the page under the pointer and keep auto-scroll running for ever.
        g.maxTop = DashGrid.bottom(g.base) * PITCH + PITCH;
        const cr = dom.canvas.getBoundingClientRect();
        g.grabX = g.startX - cr.left - g.rect.left;
        g.grabY = g.startY - cr.top - g.rect.top;
        g.target = { x: g.card.x, y: g.card.y, w: g.card.w, h: g.card.h };
        g.preview = g.base;
        g.el.classList.add(g.mode === 'move' ? 'is-dragging' : 'is-resizing');
        if (g.mode === 'resize') {
            g.badge = document.createElement('span');
            g.badge.className = 'dash-size-badge';
            g.badge.textContent = `${g.card.w} × ${g.card.h}`;
            g.el.appendChild(g.badge);
        }
        hideChartTip();
        closePopover();
        showPlaceholder(g.rect);
        startAutoScroll();
    }

    function updateGesture() {
        const g = gesture;
        const cr = dom.canvas.getBoundingClientRect();
        if (g.mode === 'move') {
            const left = g.lastX - cr.left - g.grabX;
            const top = Math.min(g.lastY - cr.top - g.grabY, g.maxTop);
            g.el.style.transform = `translate(${left}px, ${top}px)`;
            const x = clamp(Math.round(left / (geo.colW + GAP)), 0, COLS - g.card.w);
            const y = Math.max(0, Math.round(top / PITCH));
            if (x !== g.target.x || y !== g.target.y) {
                g.target = { ...g.target, x, y };
                g.preview = DashGrid.arrangeMove(g.base, { ...g.card, x, y });
                showPreview(g, top + g.rect.height);
            }
        } else {
            const [minW, minH] = g.def.min;
            const pxW = clamp(g.rect.width + (g.lastX - g.startX), spanPx(minW), spanPx(COLS - g.card.x));
            const pxH = clamp(g.rect.height + (g.lastY - g.startY), rowsPx(minH), rowsPx(MAX_H));
            g.el.style.width = `${pxW}px`;
            g.el.style.height = `${pxH}px`;
            const w = clamp(Math.round((pxW + GAP) / (geo.colW + GAP)), minW, COLS - g.card.x);
            const h = clamp(Math.round((pxH + GAP) / PITCH), minH, MAX_H);
            if (w !== g.target.w || h !== g.target.h) {
                g.target = { ...g.target, w, h };
                g.badge.textContent = `${w} × ${h}`;
                g.preview = DashGrid.arrangeInPlace(g.base, { ...g.card, w, h });
                showPreview(g, g.rect.top + pxH);
            }
        }
    }

    function showPreview(g, pointerBottom) {
        const rects = applyLayout(g.preview, g.id, pointerBottom + PITCH);
        showPlaceholder(rects.get(g.id));
    }

    function endGesture(commit) {
        const g = gesture;
        if (!g) return;
        gesture = null;
        g.el.removeEventListener('pointermove', onGestureMove);
        g.el.removeEventListener('pointerup', onGestureUp);
        g.el.removeEventListener('pointercancel', onGestureCancel);
        g.el.removeEventListener('lostpointercapture', onGestureCancel);
        if (g.el.hasPointerCapture?.(g.pointerId)) g.el.releasePointerCapture(g.pointerId);
        stopAutoScroll();
        if (!g.started) return;
        g.el.classList.remove('is-dragging', 'is-resizing');
        g.badge?.remove();
        hidePlaceholder();
        const sig = (list) => list.map((c) => `${c.id}:${c.x},${c.y},${c.w},${c.h}`).sort().join('|');
        if (commit && sig(g.preview) !== sig(g.base)) {
            ui.undo.push(g.before);
            if (ui.undo.length > UNDO_DEPTH) ui.undo.shift();
            ui.redo = [];
            activeLayout().cards = g.preview;
            const card = findCard(g.id);
            announce(g.mode === 'move'
                ? `${cardTitle(card)} moved to column ${card.x + 1}, row ${card.y + 1}`
                : `${cardTitle(card)} resized to ${card.w} columns by ${card.h} rows`);
        }
        renderCanvas();
    }

    const onGestureUp = (e) => { if (gesture && e.pointerId === gesture.pointerId) endGesture(true); };
    const onGestureCancel = () => endGesture(false);

    // Scroll the page while a drag holds the pointer near its top or bottom.
    let scrollFrame = 0;
    function startAutoScroll() {
        if (scrollFrame) return;
        const tick = () => {
            const p = gesture || libDrag;
            if (!p || !p.started) { scrollFrame = 0; return; }
            const r = dom.scroller.getBoundingClientRect();
            // The toolbar stays pinned while customizing, so the top edge is
            // measured from under it.
            const topEdge = r.top + dom.toolbar.offsetHeight + 32;
            const bottomEdge = r.bottom - 48;
            let dy = 0;
            if (p.lastY < topEdge) dy = -Math.min(18, (topEdge - p.lastY) / 3 + 2);
            else if (p.lastY > bottomEdge) dy = Math.min(18, (p.lastY - bottomEdge) / 3 + 2);
            if (dy) {
                const before = dom.scroller.scrollTop;
                dom.scroller.scrollTop += dy;
                if (dom.scroller.scrollTop !== before) {
                    if (gesture) updateGesture();
                    else updateLibraryDrag();
                }
            }
            scrollFrame = requestAnimationFrame(tick);
        };
        scrollFrame = requestAnimationFrame(tick);
    }

    function stopAutoScroll() {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
    }

    /** Arrow keys move a focused card, Shift+arrows resize it and Delete
     *  removes it. */
    function onCardKeydown(e) {
        if (!ui.editing) return;
        const el = e.target.closest('.dash-card');
        if (!el || e.target !== el) return;
        const card = findCard(el.dataset.id);
        if (!card) return;
        const layout = activeLayout();
        const title = cardTitle(card);
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[e.key]) {
            e.preventDefault();
            const [dx, dy] = arrows[e.key];
            let next = null;
            if (e.shiftKey) {
                const [minW, minH] = TYPES[card.type].min;
                const w = clamp(card.w + dx, minW, COLS - card.x);
                const h = clamp(card.h + dy, minH, MAX_H);
                if (w !== card.w || h !== card.h) next = DashGrid.arrangeInPlace(layout.cards, { ...card, w, h });
            } else if (dx) {
                const x = clamp(card.x + dx, 0, COLS - card.w);
                if (x !== card.x) next = DashGrid.arrangeMove(layout.cards, { ...card, x });
            } else {
                next = DashGrid.moveVertical(layout.cards, card.id, dy);
            }
            if (!next) { announce(`${title} cannot go further that way`); return; }
            checkpoint();
            layout.cards = next;
            renderCanvas();
            live.get(card.id)?.el.focus({ preventScroll: true });
            flashCard(card.id);
            const moved = findCard(card.id);
            announce(e.shiftKey ? `${title}: ${moved.w} columns by ${moved.h} rows` : `${title}: column ${moved.x + 1}, row ${moved.y + 1}`);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            const order = [...layout.cards].sort(DashGrid.byPosition);
            const i = order.findIndex((c) => c.id === card.id);
            const nextId = (order[i + 1] || order[i - 1] || {}).id;
            removeCard(card.id);
            if (nextId) live.get(nextId)?.el.focus();
        }
    }

    // ─── Reading a line chart ────────────────────────────────────────────────
    // Moving across a line chart names the month under the pointer and prints
    // what every plotted series was worth in it. The month columns, the guide
    // and the dots come out of FinanceChart.buildLine; this half moves the
    // guide, raises the hovered month's dots and fills the one floating reading
    // every card shares. Everything it prints is read back off the dots
    // (data-name, data-amount, fill), so there is no second copy of a series
    // here to fall out of step with the chart. One delegated listener on the
    // canvas covers every card, including cards added later.
    const hover = { tip: null, hit: null, dots: [], body: null };

    function chartTipEl() {
        if (!hover.tip) {
            hover.tip = document.createElement('div');
            hover.tip.className = 'chart-tip';
            hover.tip.setAttribute('role', 'tooltip');
            document.body.appendChild(hover.tip);
        }
        return hover.tip;
    }

    /** The month, then a row per series: its colour, its name, its amount.
     *  Built with textContent: the names are user-controlled labels. */
    function fillChartTip(tip, when, dots) {
        const head = document.createElement('div');
        head.className = 'chart-tip-when';
        head.textContent = when;
        const rows = document.createElement('ul');
        rows.className = 'chart-tip-rows';
        for (const dot of dots) {
            const row = document.createElement('li');
            row.className = 'chart-tip-row';
            const swatch = document.createElement('span');
            swatch.className = 'chart-tip-swatch';
            swatch.style.background = dot.getAttribute('fill');
            const name = document.createElement('span');
            name.className = 'chart-tip-name';
            name.textContent = dot.dataset.name;
            const amount = document.createElement('span');
            amount.className = 'chart-tip-amount';
            amount.textContent = dot.dataset.amount;
            row.append(swatch, name, amount);
            rows.appendChild(row);
        }
        tip.replaceChildren(head, rows);
    }

    /** Over the hovered month, centred on the guide, sliding sideways only: its
     *  height comes from the chart's frame, so it holds one line across a sweep. */
    function positionChartTip() {
        const tip = chartTipEl();
        const frame = hover.hit.ownerSVGElement.getBoundingClientRect();
        const anchor = (hover.dots[0] || hover.hit).getBoundingClientRect();
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const x = anchor.left + anchor.width / 2 - w / 2;
        const above = frame.top - h - 12;
        tip.style.left = `${Math.round(clamp(x, 8, window.innerWidth - w - 8))}px`;
        tip.style.top = `${Math.round(above < 8 ? frame.top + 12 : above)}px`;
    }

    function clearChartMarks(svg) {
        if (!svg) return;
        for (const dot of svg.querySelectorAll('.chart-dot-active')) dot.classList.remove('chart-dot-active');
        svg.querySelector('.chart-guide')?.classList.remove('chart-guide-on');
    }

    function showChartTip(hit) {
        const svg = hit.ownerSVGElement;
        if (!svg) return;
        if (hover.hit) clearChartMarks(hover.hit.ownerSVGElement);
        hover.hit = hit;
        hover.body = hit.closest('.dash-card-body');
        hover.dots = [...svg.querySelectorAll(`.chart-dot[data-slot="${hit.dataset.slot}"]`)]
            .sort((a, b) => Number(a.getAttribute('cy')) - Number(b.getAttribute('cy')));
        for (const dot of hover.dots) dot.classList.add('chart-dot-active');
        const guide = svg.querySelector('.chart-guide');
        if (guide) {
            guide.setAttribute('x1', hit.dataset.x);
            guide.setAttribute('x2', hit.dataset.x);
            guide.classList.add('chart-guide-on');
        }
        const tip = chartTipEl();
        fillChartTip(tip, hit.dataset.when, hover.dots);
        positionChartTip();
        tip.classList.add('chart-tip-on');
    }

    function hideChartTip() {
        if (hover.hit) clearChartMarks(hover.hit.ownerSVGElement);
        hover.hit = null;
        hover.dots = [];
        hover.body = null;
        hover.tip?.classList.remove('chart-tip-on');
    }

    // ─── First run ───────────────────────────────────────────────────────────
    // On a database with no user data the dashboard has nothing to draw, so it
    // gives way to one invitation to import. The check is computed from data
    // (GET /api/onboarding), so it never appears for someone with real history,
    // and it stops appearing once any data exists or the user skips it. While it
    // shows, the toolbar and the grid are marked .is-preempted rather than
    // removed, so skipping brings them back without a reload.
    async function maybeOfferOnboarding() {
        const hero = document.getElementById('dashboard-firstrun');
        if (!hero || !window.Onboarding) return;
        let onboarding;
        try {
            const r = await apiFetch('/api/onboarding');
            if (!r.ok) return;
            onboarding = await r.json();
        } catch {
            return;   // a failed check must not hide a working dashboard
        }
        if (!onboarding.fresh || onboarding.dismissed) return;

        const setHero = (on) => {
            hero.hidden = !on;
            for (const el of dom.preemptable) el.classList.toggle('is-preempted', on);
        };
        setHero(true);

        // The grid was laid out while hidden, at no width: lay it out again once
        // it shows (the layouts may still be loading, and then they lay it out).
        const reveal = () => {
            measure();
            if (ui.loaded) renderCanvas();
        };

        document.getElementById('dashboard-firstrun-skip').addEventListener('click', async () => {
            setHero(false);
            reveal();
            try {
                await apiFetch('/api/app-settings/onboarding_dismissed', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: 'on' }),
                });
            } catch {
                // Worst case the invitation returns next launch; nothing breaks.
            }
        });

        document.getElementById('dashboard-firstrun-start').addEventListener('click', () => {
            Onboarding.start({
                onFinished: ({ imported }) => {
                    setHero(false);
                    if (!imported) {
                        reveal();
                        return;
                    }
                    // An import changes every dataset this page holds. Reload
                    // rather than redraw: the page's wiring is bound once per load.
                    Store.invalidate('balance');
                    Store.invalidate('ie');
                    location.reload();
                },
            });
        });
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────
    const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const dialogOpen = () => !!document.querySelector('.confirm-overlay, .onb-overlay, .settings-modal-overlay, .db-modal-overlay');

    function onCanvasClick(e) {
        const act = e.target.closest('[data-act]');
        const el = e.target.closest('.dash-card');
        const id = el && el.dataset.id;
        if (act && id) {
            switch (act.dataset.act) {
                case 'period': openPeriodPicker(act, id); return;
                case 'gear': openGear(act, id); return;
                case 'remove': removeCard(id); return;
                default: break;
            }
        }
        const chip = !ui.editing && e.target.closest('[data-chip]');
        if (chip && id) toggleChip(id, chip.dataset.chip);
    }

    function onToolbarClick(e) {
        const tab = e.target.closest('.dash-tab[data-layout]');
        if (tab) { switchLayout(tab.dataset.layout); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        switch (btn.dataset.act) {
            case 'new-layout': createLayout('blank'); break;
            case 'layout-menu': if (pop?.anchor === btn) closePopover(true); else openLayoutMenu(btn); break;
            // Pressed, the button ends Customize the way Save does.
            case 'customize': if (ui.editing) exitEdit(); else enterEdit(); break;
            default: break;
        }
    }

    function onTabsKeydown(e) {
        if (!e.target.classList.contains('dash-tab') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const i = state.layouts.findIndex((l) => l.id === state.active);
        const next = state.layouts[(i + (e.key === 'ArrowRight' ? 1 : -1) + state.layouts.length) % state.layouts.length];
        switchLayout(next.id);
        dom.tabs.querySelector(`.dash-tab[data-layout="${CSS.escape(next.id)}"]`)?.focus();
    }

    function onDrawerClick(e) {
        const act = e.target.closest('[data-act]');
        if (act) {
            if (act.dataset.act === 'done') exitEdit();
            return;
        }
        const head = e.target.closest('.cat-group-head');
        if (head) { toggleGroup(head); return; }
    }

    function onKeydown(e) {
        if (dialogOpen()) return;
        if (e.key === 'Escape') {
            if (pop) { closePopover(true); return; }
            if (gesture) { endGesture(false); return; }
            if (libDrag) endLibraryDrag(false);
            return;
        }
        if (ui.editing && (e.ctrlKey || e.metaKey) && !isTyping(e.target)) {
            const key = e.key.toLowerCase();
            if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
            else if (key === 'y') { e.preventDefault(); redo(); }
        }
    }

    // The grid follows the canvas width (the window, the panel opening) without
    // animating every card into place.
    let resizeFrame = 0;
    let settleTimer = 0;
    function onCanvasResize() {
        resizeFrame = 0;
        const before = `${geo.width}|${ui.stacked}`;
        measure();
        if (!ui.loaded || `${geo.width}|${ui.stacked}` === before) return;
        dom.canvas.classList.add('no-anim');
        if (gesture && gesture.started) {
            gesture.rect = cellRect(gesture.card);
            updateGesture();
        } else {
            applyLayout(cards());
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => dom.canvas.classList.remove('no-anim'), 120);
    }

    function wire() {
        dom.canvas.addEventListener('pointerdown', onCardPointerDown);
        dom.canvas.addEventListener('keydown', onCardKeydown);
        dom.canvas.addEventListener('click', onCanvasClick);
        dom.canvas.addEventListener('pointerover', (e) => {
            if (ui.editing || gesture || libDrag) return;
            const hit = e.target.closest('.chart-hit');
            if (!hit) { if (hover.hit) hideChartTip(); return; }
            if (hit !== hover.hit) showChartTip(hit);
        });
        dom.canvas.addEventListener('pointerleave', hideChartTip);
        dom.empty.addEventListener('click', (e) => {
            if (!e.target.closest('[data-empty-action="add-widgets"]')) return;
            if (!ui.editing) enterEdit();
            else openDrawer();
        });

        dom.toolbar.addEventListener('click', onToolbarClick);
        dom.tabs.addEventListener('keydown', onTabsKeydown);

        dom.drawer.addEventListener('click', onDrawerClick);
        dom.drawerBody.addEventListener('pointerdown', onLibraryPointerDown);

        document.addEventListener('pointerdown', (e) => {
            if (pop && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePopover();
        }, true);
        document.addEventListener('keydown', onKeydown);
        // .page scrolls, not the window; capture, because that scroll does not bubble.
        document.addEventListener('scroll', () => {
            if (pop) positionPopover();
            if (hover.hit) positionChartTip();
        }, { capture: true, passive: true });
        window.addEventListener('resize', () => {
            closePopover();
            hideChartTip();
        });
        window.addEventListener('themechange', repaintAll);
        window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

        new ResizeObserver(() => {
            if (!resizeFrame) resizeFrame = requestAnimationFrame(onCanvasResize);
        }).observe(dom.canvas);
    }

    // ─── Boot ────────────────────────────────────────────────────────────────
    async function init() {
        dom.root = document.querySelector('.dashboard-page');
        dom.scroller = dom.root.closest('.page') || document.scrollingElement;
        dom.toolbar = document.getElementById('dash-toolbar');
        dom.tabs = document.getElementById('dash-layouts');
        dom.actions = document.getElementById('dash-actions');
        dom.canvas = document.getElementById('dash-canvas');
        dom.placeholder = document.getElementById('dash-placeholder');
        dom.empty = document.getElementById('dash-empty');
        dom.drawer = document.getElementById('dash-drawer');
        dom.drawerBody = document.getElementById('dash-drawer-body');
        dom.live = document.getElementById('dash-live');
        dom.preemptable = document.querySelectorAll('.dash-shell');
        if (!dom.canvas) return;

        dom.drawer.inert = true;
        dom.empty.innerHTML = UI.emptyState({
            icon: null,
            title: 'This layout is empty',
            action: { label: 'Add widgets', name: 'add-widgets', primary: true },
        });
        buildControls();
        wire();
        measure();
        renderTabs();
        syncControls();
        // Runs alongside the layout load: the hero appears once the check
        // resolves, and a database with data never waits on it.
        maybeOfferOnboarding();

        state = await loadLayouts();
        ui.loaded = true;
        renderAll({ enter: true });

        // A background revalidation (store.js serves its snapshot first, then
        // refetches) redraws the cards that read that dataset, quietly.
        Store.subscribe('balance', () => refreshUsers('balance'));
        Store.subscribe('ie', () => refreshUsers('ie'));
    }

    document.addEventListener('DOMContentLoaded', init);
}());
