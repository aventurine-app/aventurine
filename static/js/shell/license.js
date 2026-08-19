'use strict';

// ─── license.js ─────────────────────────────────────────────────────────────
// The activation screen, and the license read-out in About.
//
// An unactivated install answers nothing but /api/license (the gate in
// electron/backend/router.js), so this file drives the only screen such an
// install has. It is not an overlay bolted over a working app: everything
// behind it would return 402 anyway, and the gate is what makes that legible
// instead of looking like a hundred broken pages.
//
// Nothing here touches the network. An unlock key is a signed token the backend
// verifies locally (electron/backend/license.js); the user obtains it from the
// activation page in their own browser, so the app's offline guarantee holds
// even during activation. "Open Activation Page" hands a URL to the OS browser
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

    // About's license section. The address is the watermark's whole point, so
    // it is on display: a shared key advertises whose it is.
    const aboutSection = document.querySelector('[data-about-license-section]');
    const aboutEmail   = document.querySelector('[data-about-license]');
    const aboutIssued  = document.querySelector('[data-about-issued]');
    const removeBtn    = document.querySelector('[data-license-remove]');

    // Its confirmation. Deactivating is reversible, so this asks rather than
    // demanding a typed phrase — see the modal's own note in chrome.html.
    const confirmEl      = document.querySelector('[data-modal="license-deactivate"]');
    const confirmBtn     = document.querySelector('[data-license-remove-confirm]');
    const confirmCancel  = document.querySelector('[data-license-remove-cancel]');
    const confirmError   = document.querySelector('[data-license-remove-error]');

    const ACTIVATION_URL = 'https://aventurine-app.com/activate';

    // The copy the gate leads with, read OFF the markup rather than repeated
    // here. render() replaces this line when the gate is up for a reason other
    // than "this copy is brand new" — an expired entitlement or a key that
    // stopped verifying reads as a bug unless the screen says otherwise — and
    // has to be able to put the original back. Holding a second copy in this
    // file made chrome.html's version dead text that silently lost every edit.
    const DEFAULT_LEAD = leadEl.textContent.trim();

    let busy = false;

    function setError(msg) {
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    }

    function render(st) {
        const licensed = st.state === 'licensed' && !!st.license;

        // The <html> flag is what actually shows or hides the screen (see
        // license.css), and the localStorage hint is what lets theme-init.js
        // get the next launch right before the backend has answered. Neither
        // is a security boundary — the backend re-decides on every request.
        document.documentElement.dataset.licenseGate = licensed ? 'off' : 'on';
        try {
            localStorage.setItem('license-activated', licensed ? '1' : '0');
        } catch {
            // Private-mode / quota failures cost a pre-paint flash, nothing more.
        }

        // A user who HAS activated and is being asked again is owed the reason.
        leadEl.textContent = licensed ? DEFAULT_LEAD : (st.message || DEFAULT_LEAD);

        if (aboutSection) {
            aboutSection.hidden = !licensed;
            if (licensed) {
                aboutEmail.textContent = st.license.email;
                aboutIssued.textContent = st.license.issued;
            }
        }

        if (!licensed) {
            // The gate is the app now, so nothing may float above it. Deactivate
            // is the case that proves it: the button lives in About, so without
            // this the modal it was clicked in stays open over the activation
            // screen — and every control still in it addresses an app that has
            // stopped answering. Same for a session that loses its license with
            // Preferences or a database dialog open.
            closeChromeModals();

            // Then the field the screen exists for takes focus. Guarded:
            // re-rendering while the user is mid-paste must not yank the caret
            // back to the start.
            if (document.activeElement !== inputEl) inputEl.focus();
        }
    }

    /** Every overlay in the shared chrome: the Preferences / About / encryption
     *  modals (titlebar.js) and the database dialog (dbactions.js). Both own
     *  their own lifecycle and both close by the same one-line means they use
     *  internally, so this dismisses them without reaching into either. */
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
            // Every page behind the gate loaded against a backend that was
            // answering 402, so its data is not stale, it is absent. A reload
            // is the honest way back — and it is the one moment in the app's
            // life where throwing away renderer state costs nothing.
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
                // Left on screen with the reason rather than closed: a silent
                // no-op would read as a successful deactivation, and the user
                // would go looking for an activation screen that never came.
                setRemoveError(body.error || 'This copy could not be deactivated.');
                return;
            }
            // render() raises the gate, and raising the gate closes this modal
            // along with the About modal it was opened from.
            render(body);
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
    // Deactivate asks first. The × and backdrop-click and Escape closes are
    // already wired for every .settings-modal-overlay by shell/titlebar.js, so
    // only the two footer buttons belong here.
    removeBtn?.addEventListener('click', () => {
        setRemoveError('');
        if (confirmEl) confirmEl.hidden = false;
        confirmCancel?.focus();   // the safe option, not the destructive one
    });
    confirmCancel?.addEventListener('click', () => { confirmEl.hidden = true; });
    confirmBtn?.addEventListener('click', remove);

    // Step one's URL. Handed to the OS browser: window.open is denied and
    // will-navigate is locked to the app origin, so this is the only way out,
    // and main.js checks the URL against its own allowlist before opening
    // anything. With no shell bridge (a plain browser) there is nothing to do
    // and nothing to say — the button's own label is the address, so a reader
    // who cannot click it can still type it.
    openBtn?.addEventListener('click', () => {
        window.electronShell?.openExternal(ACTIVATION_URL);
    });

    // A 402 from the backend gate, announced by core/api.js. Under a total
    // lockout this should never reach a user who is looking at the app — the
    // gate is already up — but it is the backup that matters: a license that
    // stops verifying mid-session (a deactivation from another window, a clock
    // the entitlement check disagrees with) has to put the screen back rather
    // than leave a live app quietly failing every request.
    window.addEventListener('aventurine:license-required', () => {
        document.documentElement.dataset.licenseGate = 'on';
        refresh();
    });

    refresh();
    window.licenseActions = { refresh };
}());
