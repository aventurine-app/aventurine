'use strict';

// ─── license.js ─────────────────────────────────────────────────────────────
// The activation screen, and the license read-out in About.
//
// Under the soft gate (electron/backend/router.js) an unactivated install is a
// working transaction manager, so this file drives two separate things: the
// FEATURE TIER, a flag on <html> that the stylesheet reads, and the ACTIVATION
// SCREEN, an upsell the user opens and closes rather than the app's only screen.
//
// The screen is raised from three places: the sidebar's Unlock button, a click
// on ANY link into a paid page, and a 402 from a paid route. The first two are
// user-initiated; the third means the page cannot be drawn.
//
// The locked NAV links are the one exception, and they raise nothing: they are
// inert and already carry a lock icon. An in-page link like the dashboard's
// "Open Statements" carries no such marker, so a click with no response would
// look like a broken control.
//
// Nothing here makes a network request. An unlock key is a signed token the
// backend verifies locally (electron/backend/license.js); the user obtains it
// from the activation page in their own browser, so the app stays offline even
// during activation. "Open Activation Page" passes a URL to the OS browser
// through the preload bridge rather than loading anything in-app.

(function () {
    const gate = document.querySelector('[data-activation-screen]');
    if (!gate) return;

    const q = (sel) => gate.querySelector(sel);
    const inputEl   = q('[data-license-input]');
    const previewEl = q('[data-license-preview]');
    const errorEl   = q('[data-license-error]');
    const leadEl    = q('[data-gate-lead]');
    const submitBtn = q('[data-license-submit]');
    const openBtn   = q('[data-license-open]');
    const closeBtn  = q('[data-license-close]');

    // Lives in the sidebar, not the gate, so it is reached from the document.
    const unlockBtn = document.querySelector('[data-license-unlock]');

    // About's license section. The registered address is displayed, since that
    // is what the email watermark is for: a shared key shows who bought it.
    const aboutSection = document.querySelector('[data-about-license-section]');
    const aboutEmail   = document.querySelector('[data-about-license]');
    const aboutIssued  = document.querySelector('[data-about-issued]');
    const removeBtn    = document.querySelector('[data-license-remove]');

    // Its confirmation. Deactivating is reversible, so this confirms rather than
    // requiring a typed phrase — see the note in chrome.html.
    const confirmEl      = document.querySelector('[data-modal="license-deactivate"]');
    const confirmBtn     = document.querySelector('[data-license-remove-confirm]');
    const confirmCancel  = document.querySelector('[data-license-remove-cancel]');
    const confirmError   = document.querySelector('[data-license-remove-error]');

    // The .html suffix is required: the site is plain static files and all its
    // internal links carry the extension, so the extensionless path returns 404.
    // main.js's open-external allowlist is host-based, so the path can change
    // without updating it.
    const ACTIVATION_URL = 'https://aventurine-app.com/activate.html';

    // The gate's lead line, read from the markup rather than duplicated here.
    // render() replaces this line when the gate is up for a specific reason (an
    // expired entitlement, or a key that stopped verifying), and must be able to
    // restore the original. Keeping a second copy in this file made chrome.html's
    // version unused text that lost every edit.
    const DEFAULT_LEAD = leadEl.textContent.trim();

    let busy = false;

    // null until the backend has answered once; then 'full' | 'free'.
    let verifiedTier = null;

    function setError(msg) {
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    }

    function render(st) {
        const licensed = st.state === 'licensed' && !!st.license;

        // The <html> flag is what the stylesheet reads to hide Year to Year and
        // mark the locked nav links (see license.css), and the localStorage hint
        // is what lets theme-init.js set the tier on the next launch before the
        // backend responds. Neither is a security boundary: the backend re-checks
        // on every request, and every locked destination's routes are on the paid
        // side of the allowlist.
        document.documentElement.dataset.licenseTier = licensed ? 'full' : 'free';
        try {
            localStorage.setItem('license-activated', licensed ? '1' : '0');
        } catch {
            // Private-mode or quota failures only cause a pre-paint flash.
        }
        // The <html> flag above may have been set pre-paint from the hint, which
        // can be stale. This is the VERIFIED tier — what the backend just said —
        // for a page that has to decide whether to request a paid route at all
        // (the Dashboard's Financial Freedom card): asking on the hint alone
        // would raise the gate on the Dashboard the one time the hint is wrong.
        verifiedTier = licensed ? 'full' : 'free';
        window.dispatchEvent(new CustomEvent('aventurine:license-tier', { detail: { tier: verifiedTier } }));

        // A user who HAS activated and is being asked again is owed the reason.
        leadEl.textContent = licensed ? DEFAULT_LEAD : (st.message || DEFAULT_LEAD);

        if (aboutSection) {
            aboutSection.hidden = !licensed;
            if (licensed) {
                aboutEmail.textContent = st.license.email;
                aboutIssued.textContent = st.license.issued;
            }
        }

        applyNavLocks(licensed);

        // Reached a paid page some other way: a typed address, a link written
        // before this existed, or a license that stopped verifying while the
        // user was sitting on one. The page underneath has already drawn
        // whatever it can, so this is a curtain rather than a lock, and the
        // note in router.js explains why that is as far as the renderer can go.
        if (!licensed && isPaidPath(location.pathname)) openGate('blocked');

        // Merely lacking a license is no longer a reason to show the screen:
        // there is an app to get on with, and shoving the upsell in front of it
        // on every launch is how a free tier stops feeling like one. Gaining a
        // license IS a reason to take the screen away.
        if (licensed) closeGate();
    }

    /** Every paid page. Listed here as PATHS rather than derived from the nav,
     *  because the links that were missed were not in the nav: the dashboard's
     *  empty-state cards render their own "Open Statements" and "Add balances"
     *  buttons, and the Forecast card links to the Balance Sheet. A list of
     *  marked link sites goes out of date whenever a card is added, so the
     *  destination is what is checked. */
    const PAID_PATHS = new Set([
        '/statements', '/portfolio', '/reports', '/recurring',
    ]);

    /** Trailing slashes only; '/' is the Dashboard and is free. */
    function isPaidPath(pathname) {
        return PAID_PATHS.has(pathname.replace(/\/+$/, '') || '/');
    }

    /** A locked nav link is INERT, not intercepted. license.css blocks the hover
     *  and the click with pointer-events, which does not cover the keyboard or
     *  screen readers: without this a locked destination is still tabbable and
     *  still announced as a link to a page that will not open. Removing it from
     *  the tab order conveys the same state the dimming does, for users who
     *  cannot see the dimming.
     *
     *  Not a security boundary, like everything else in this file. It runs from
     *  render(), so activating in this window unlocks the links without a
     *  reload. */
    function applyNavLocks(licensed) {
        document.querySelectorAll('.nav a[data-paid]').forEach((a) => {
            if (licensed) {
                a.removeAttribute('tabindex');
                a.removeAttribute('aria-disabled');
            } else {
                a.setAttribute('tabindex', '-1');
                a.setAttribute('aria-disabled', 'true');
            }
        });
    }

    // Why the screen was raised, which determines where closing it navigates.
    let gateReason = null;

    /** reason: 'asked'   the user opened it (Unlock, or a locked nav link)
     *          'blocked' a paid route answered 402 */
    function openGate(reason) {
        gateReason = reason;

        // Nothing may sit above it while it is up. Deactivate is the case that
        // requires this: the button is in About, so without it that modal stays
        // open over the activation screen.
        closeChromeModals();
        document.documentElement.dataset.licenseGate = 'on';

        // Guarded: re-rendering while the user is pasting must not move the
        // caret back to the start.
        if (document.activeElement !== inputEl) inputEl.focus();
    }

    function closeGate() {
        const reason = gateReason;
        gateReason = null;
        document.documentElement.dataset.licenseGate = 'off';

        // A page that raised the screen by failing is still behind it, rendered
        // with no data. Closing onto that would look like a failure, so navigate
        // to a page the free tier can load.
        if (reason === 'blocked' && location.pathname !== '/transactions') {
            location.href = '/transactions';
        }
    }

    /** Every overlay in the shared chrome: the Preferences / About / encryption
     *  modals (titlebar.js) and the database dialog (dbactions.js). Both manage
     *  their own lifecycle and both close by setting `hidden`, the same way they
     *  do internally, so this closes them without calling into either. */
    function closeChromeModals() {
        document
            .querySelectorAll('.settings-modal-overlay, .db-modal-overlay')
            .forEach((m) => { m.hidden = true; });
    }

    async function refresh() {
        try {
            const res = await window.apiFetch('/api/license');
            render(await res.json());
        } catch {
            // A failed status read is not a licensing verdict; leave the screen
            // as it was rather than throwing a paying user back to the gate.
        }
    }

    async function activate() {
        if (busy) return;
        const key = inputEl.value.trim();
        if (!key) return;
        busy = true;
        submitBtn.disabled = true;
        setError('');
        try {
            const res = await window.apiFetch('/api/license/activate', {
                method: 'POST',
                body: JSON.stringify({ key }),
            });
            const body = await res.json();
            if (!res.ok) {
                setError(body.error || 'That key could not be verified.');
                return;
            }
            inputEl.value = '';
            setPreview(null);
            render(body);
            // Every page behind the gate loaded against a backend returning 402,
            // so its data is absent rather than stale. A reload is the simplest
            // way to repopulate it, and no renderer state is worth keeping at
            // this point.
            location.reload();
        } catch {
            setError('Activation could not be completed. Please try again.');
        } finally {
            busy = false;
            submitBtn.disabled = !inputEl.value.trim();
        }
    }

    async function remove() {
        if (busy) return;
        busy = true;
        if (confirmBtn) confirmBtn.disabled = true;
        try {
            const res = await window.apiFetch('/api/license', { method: 'DELETE' });
            const body = await res.json();
            if (!res.ok) {
                // Left on screen with the reason rather than closed: closing with
                // no message would look like a successful deactivation, and the
                // activation screen would never appear.
                setRemoveError(body.error || 'This copy could not be deactivated.');
                return;
            }
            render(body);
            // Under the lockout, render() raising the gate was enough. Now there
            // is a live app behind this modal that may be showing paid data on a
            // page the free tier cannot load, so this does what activation does:
            // reload, and let the tier determine what renders.
            location.reload();
        } catch {
            setRemoveError('This copy could not be deactivated. Please try again.');
        } finally {
            busy = false;
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    function setRemoveError(msg) {
        if (!confirmError) return;
        confirmError.textContent = msg || '';
        confirmError.hidden = !msg;
    }

    function setPreview(email) {
        if (!email) {
            previewEl.hidden = true;
            previewEl.textContent = '';
            return;
        }
        previewEl.innerHTML = `This key was issued to <strong>${escapeHtml(email)}</strong>.`;
        previewEl.hidden = false;
    }

    // Read the pasted key back before it is committed. The address is the whole
    // anti-sharing mechanism, so the moment to show it is while the user still
    // has the key in front of them, not after they have put it away.
    const previewKey = window.debounce(async () => {
        const key = inputEl.value.trim();
        // Too short to be a key yet: stay quiet rather than reporting an error
        // at every keystroke of a paste-in-progress.
        if (key.length < 100) { setPreview(null); setError(''); return; }
        try {
            const res = await window.apiFetch('/api/license/preview', {
                method: 'POST',
                body: JSON.stringify({ key }),
            });
            const body = await res.json();
            if (res.ok && body.license) { setPreview(body.license.email); setError(''); }
            else { setPreview(null); setError(body.error || ''); }
        } catch {
            setPreview(null);
        }
    }, 250);

    inputEl.addEventListener('input', () => {
        submitBtn.disabled = !inputEl.value.trim();
        setError('');
        setPreview(null);
        previewKey();
    });

    // A key is one long token, so Enter should submit; Shift+Enter still gives
    // a newline for anyone pasting a hard-wrapped copy.
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            activate();
        }
    });

    submitBtn.addEventListener('click', activate);
    closeBtn?.addEventListener('click', closeGate);
    unlockBtn?.addEventListener('click', () => openGate('asked'));

    // Any link into a paid page, wherever it was rendered. Delegated and in the
    // CAPTURE phase so it covers markup that did not exist at load (the reason
    // the nav-only version missed links) and runs before a page's own handler.
    // The tier is read per click, so activating in this window unlocks all of
    // these without a reload.
    document.addEventListener('click', (e) => {
        if (document.documentElement.dataset.licenseTier !== 'free') return;
        const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
        // The nav links are handled below, silently. Letting this handler also
        // run would raise the upsell on the one link that must not raise it.
        if (!a || a.hasAttribute('data-paid')) return;

        let dest;
        try { dest = new URL(a.getAttribute('href'), location.href); } catch { return; }
        // Compared as a PATH: these links carry fragments ('/statements#cash-flow'),
        // and an external link is none of this handler's business.
        if (dest.origin !== location.origin || !isPaidPath(dest.pathname)) return;

        e.preventDefault();
        openGate('asked');
    }, true);

    // pointer-events keeps a real pointer off a locked link, but that is a paint
    // rule: a synthetic click, or Enter on a focus reached another way, still
    // navigates. So the navigation is also blocked here, and blocked SILENTLY.
    // Raising the upsell here would replace a page request with a sales screen
    // the user did not open. The tier is read per click rather than captured, so
    // activating in this window unlocks the links without a reload.
    document.querySelectorAll('.nav a[data-paid]').forEach((a) => {
        a.addEventListener('click', (e) => {
            if (document.documentElement.dataset.licenseTier === 'free') e.preventDefault();
        });
    });

    // Escape closes it, like every other overlay in the chrome.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.documentElement.dataset.licenseGate === 'on') closeGate();
    });

    // Deactivate confirms first. The ×, backdrop-click and Escape closes are
    // already wired for every .settings-modal-overlay by shell/titlebar.js, so
    // only the two footer buttons are handled here.
    removeBtn?.addEventListener('click', () => {
        setRemoveError('');
        if (confirmEl) confirmEl.hidden = false;
        confirmCancel?.focus();   // focus Cancel, not the destructive button
    });
    confirmCancel?.addEventListener('click', () => { confirmEl.hidden = true; });
    confirmBtn?.addEventListener('click', remove);

    // The activation page URL. Passed to the OS browser: window.open is denied
    // and will-navigate is locked to the app origin, so this is the only exit,
    // and main.js checks the URL against an allowlist before opening it. With no
    // shell bridge (a plain browser) nothing happens — the button's label is the
    // address, so it can be typed manually.
    openBtn?.addEventListener('click', () => {
        window.electronShell?.openExternal(ACTIVATION_URL);
    });

    // A 402 from the backend gate, dispatched by core/api.js. Under the soft
    // gate this is a normal path rather than a fallback: any paid page reached by
    // URL rather than by the nav arrives here, as does a license that stops
    // verifying mid-session.
    window.addEventListener('aventurine:license-required', () => {
        openGate('blocked');
        refresh();
    });

    refresh();
    window.licenseActions = { refresh, tier: () => verifiedTier };
}());
