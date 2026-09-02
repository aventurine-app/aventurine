'use strict';

// ─── Title bar wiring ───────────────────────────────────────────────────
// Three responsibilities, kept in one file because they all live in the
// same chrome:
//   • Window controls (min / max / close) → ipc bridge in preload.js
//   • File dropdown toggle (New / Open / Save Database As)
//   • Settings button → the Settings modal
//
// The File items call window.dbActions (dbactions.js, which loads before this
// file). That keeps the modal wiring and API calls in one place.

(function () {
    const bar = document.querySelector('.titlebar');
    if (!bar) return;

    // ── Window controls ───────────────────────────────────────────────
    bar.addEventListener('click', e => {
        const btn = e.target.closest('.titlebar-btn[data-action]');
        if (!btn) return;
        const w = window.electronWindow;
        if (!w) return;
        switch (btn.dataset.action) {
            case 'min':   w.minimize();       break;
            case 'max':   w.toggleMaximize(); break;
            case 'close': w.close();          break;
        }
    });

    // ── Title-bar dropdown menus (File) ───────────────────────────────
    // Each menu button carries data-menu="<name>"; its panel carries
    // data-menu-panel="<name>". The panels float over page content with
    // their left edge aligned to the button. Only one is open at a time.
    // Settings is not one of them: it has a single destination, so it opens
    // the modal on the click rather than a menu of one item.
    const menuButtons = bar.querySelectorAll('.titlebar-menu-item[data-menu]');

    const panelFor = name => document.querySelector(`[data-menu-panel="${name}"]`);

    function closeMenus() {
        document.querySelectorAll('.titlebar-dropdown').forEach(p => { p.hidden = true; });
        menuButtons.forEach(b => b.setAttribute('aria-expanded', 'false'));
    }
    function openMenu(btn) {
        const panel = panelFor(btn.dataset.menu);
        if (!panel) return;
        closeMenus();
        // Position the panel at the button's bottom-left corner rather than the
        // bottom of the bar, so it appears attached to the button.
        const r = btn.getBoundingClientRect();
        panel.style.left = `${r.left}px`;
        panel.style.top = `${r.bottom}px`;
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    }

    menuButtons.forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const panel = panelFor(btn.dataset.menu);
            if (panel && panel.hidden) openMenu(btn);
            else                       closeMenus();
        });
    });

    // Click outside or Escape closes any open dropdown.
    document.addEventListener('click', e => {
        if (e.target.closest('.titlebar-dropdown') ||
            e.target.closest('.titlebar-menu-item[data-menu]')) return;
        closeMenus();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeMenus();
    });

    // File dropdown actions — the DB modal logic lives in dbactions.js.
    panelFor('file')?.addEventListener('click', e => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        closeMenus();
        if (item.dataset.action === 'new-db') {
            window.dbActions?.showNew();
        } else if (item.dataset.action === 'open-db') {
            window.dbActions?.showOpen();
        } else if (item.dataset.action === 'save-db-as') {
            window.dbActions?.showSaveAs();
        }
    });

    // ── Settings modal ────────────────────────────────────────────────
    // One modal holds every setting, with About as its last tab, so the title
    // bar's Settings button opens it directly. The tab it opens on is whichever
    // was last active, which is also where the user left it.
    function openModal(name) {
        const modal = document.querySelector(`[data-modal="${name}"]`);
        if (modal) modal.hidden = false;
    }

    bar.querySelector('[data-action="open-settings"]')?.addEventListener('click', e => {
        e.stopPropagation();
        closeMenus();       // the File dropdown, if it is open
        openModal('preferences');
    });

    // Wire close (× button + backdrop click) for every settings modal.
    document.querySelectorAll('.settings-modal-overlay').forEach(modal => {
        const close = () => { modal.hidden = true; };
        modal.querySelector('.settings-modal-close')?.addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.settings-modal-overlay:not([hidden])')
            .forEach(m => { m.hidden = true; });
    });

    // ── Active database name (center of the bar) ──────────────────────
    // Show the file name of the open database. Every DB switch (New / Open /
    // Save As / Unlock) reloads the page, so reading status once on load is
    // enough — no live updates to maintain. A locked DB still reports its
    // path, so the name shows behind the unlock prompt too.
    const titleEl = bar.querySelector('.titlebar-title');
    if (titleEl) {
        apiFetch('/api/db/status')
            .then(r => r.json())
            .then(s => {
                const p = s && typeof s.path === 'string' ? s.path : '';
                titleEl.textContent = dbDisplayName(p);
                if (p) titleEl.title = p; // full path on hover
            })
            .catch(() => { /* status unreachable — leave the title blank */ });
    }

    // Basename of a DB path, minus a trailing SQLite extension — a clean
    // "name" to display, not the full filesystem path.
    function dbDisplayName(p) {
        if (!p) return '';
        const base = p.split(/[\\/]/).pop() || p;
        return base.replace(/\.(db|sqlite|sqlite3)$/i, '');
    }
}());
