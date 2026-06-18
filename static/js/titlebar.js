'use strict';

// ─── Title bar wiring ───────────────────────────────────────────────────
// Three responsibilities, kept in one file because they all live in the
// same chrome:
//   • Window controls (min / max / close) → ipc bridge in preload.js
//   • File dropdown toggle (New / Open / Save Database As)
//   • Settings modal open / close
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

    // ── Title-bar dropdown menus (File / Settings) ────────────────────
    // Each menu button carries data-menu="<name>"; its panel carries
    // data-menu-panel="<name>". The panels float over page content with
    // their left edge aligned to the button. Only one is open at a time.
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
        const r = btn.getBoundingClientRect();
        panel.style.left = `${r.left}px`;
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

    // ── Settings modals (Preferences / About) ─────────────────────────
    function openModal(name) {
        const modal = document.querySelector(`[data-modal="${name}"]`);
        if (modal) modal.hidden = false;
    }

    // Settings dropdown actions open the matching modal.
    panelFor('settings')?.addEventListener('click', e => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        closeMenus();
        if (item.dataset.action === 'open-preferences') {
            openModal('preferences');
        } else if (item.dataset.action === 'open-about') {
            openModal('about');
        }
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
}());
