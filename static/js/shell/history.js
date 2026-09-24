'use strict';

// ─── Session-history navigation ─────────────────────────────────────────────
//
// Each page is its own document under app:// (PAGE_ROUTES in electron/main.js),
// so a sidebar click already leaves a Chromium session-history entry and
// history.back()/forward() already walk them. Nothing here creates that trail;
// this file adds the three ways to ask for a walk — the title-bar buttons, the
// keyboard, the mouse's side buttons — and the single gate all three pass.
//
// Which directions exist is the one thing the page cannot see for itself: a
// document has no read on its own position in session history. The main process
// answers that (electronWindow.navState). It is pulled once per load rather than
// pushed, because every move replaces the document, so the next reader is
// always a fresh page asking again.
//
// Page state is NOT carried across a move. A history navigation is a full
// document load, so the arriving page runs its own init and starts at its
// defaults. Restoring filters, tabs and scroll is a separate piece of work.

(function () {
    const buttons = document.querySelectorAll('.titlebar-nav-btn[data-nav]');
    if (!buttons.length) return;   // chrome not served (plain-browser page file)

    const bridge = window.electronWindow || null;

    /** A locked database answers 423 on every data route, and the locked
     *  presentation deliberately keeps the blurred page visible behind the
     *  unlock prompt (see enterLocked in shell/dbactions.js). Walking the
     *  history there would swap that for another page's empty shell without
     *  getting the user any closer to unlocking, so hold still instead. */
    function isLocked() {
        return document.documentElement.dataset.dbLocked === '1';
    }

    /** The one way anything here moves. Every input path funnels through it so
     *  the lock gate cannot be reached around. */
    function go(direction) {
        if (isLocked()) return;
        if (direction === 'back')         history.back();
        else if (direction === 'forward') history.forward();
    }

    // ── The two buttons ──────────────────────────────────────────────────────
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => go(btn.dataset.nav));
    });

    /** Enable each direction the session history actually holds.
     *
     *  Without the bridge — a page opened straight from pages/ in a plain
     *  browser — there is no one to ask, so both stay enabled; history.back()
     *  at the start of the trail is already a no-op, which is the same outcome
     *  a disabled button would give. */
    function syncButtons() {
        if (!bridge || !bridge.navState) {
            buttons.forEach((b) => { b.disabled = false; });
            return;
        }
        bridge.navState()
            .then((s) => {
                buttons.forEach((b) => {
                    b.disabled = !(b.dataset.nav === 'back' ? s.canGoBack : s.canGoForward);
                });
            })
            .catch(() => { /* no answer — both stay disabled, as they start */ });
    }
    syncButtons();

    // ── Keyboard ─────────────────────────────────────────────────────────────
    // Alt+Left / Alt+Right off macOS, Cmd+[ / Cmd+] on it. The split is not
    // cosmetic: macOS binds Option+Arrow and Cmd+Arrow to word- and line-wise
    // caret movement inside text fields, so binding either there would fight
    // every input on the page.
    //
    // Wired here rather than in the main process (where Ctrl+R lives) so that
    // the keyboard passes the same lock gate the buttons do.
    const isMac = document.documentElement.dataset.platform === 'mac';

    document.addEventListener('keydown', (e) => {
        let direction = null;
        if (isMac) {
            if (e.metaKey && !e.ctrlKey && !e.altKey) {
                if (e.key === '[') direction = 'back';
                if (e.key === ']') direction = 'forward';
            }
        } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
            if (e.key === 'ArrowLeft')  direction = 'back';
            if (e.key === 'ArrowRight') direction = 'forward';
        }
        if (!direction) return;
        e.preventDefault();
        go(direction);
    });

    // ── The mouse's side buttons ─────────────────────────────────────────────
    // Electron reports these to the main process as window 'app-command's and
    // takes no action of its own (Windows and Linux; macOS mice have no such
    // buttons). The main process forwards the direction here so this path lands
    // on the same gate as the other two.
    if (bridge && bridge.onNavCommand) bridge.onNavCommand(go);
}());
