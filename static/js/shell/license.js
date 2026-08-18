'use strict';

// ─── license.js ─────────────────────────────────────────────────────────────
// Settings → License. Reads GET /api/license and drives activation.
//
// Nothing here touches the network. An unlock key is a signed token the backend
// verifies locally (electron/backend/license.js); the user obtains it from the
// activation page in their own browser, so the app's offline guarantee holds
// even during activation. "Open Activation Page" hands a URL to the OS browser
// through the preload bridge rather than loading anything in-app.

(function () {
    const panel = document.querySelector('[data-tabpanel="license"]');
    if (!panel) return;

    const q = (sel) => panel.querySelector(sel);
    const badgeEl    = q('[data-license-badge]');
    const descEl     = q('[data-license-desc]');
    const activateEl = q('[data-license-activate]');
    const manageEl   = q('[data-license-manage]');
    const inputEl    = q('[data-license-input]');
    const errorEl    = q('[data-license-error]');
    const submitBtn  = q('[data-license-submit]');
    const openBtn    = q('[data-license-open]');
    const removeBtn  = q('[data-license-remove]');

    const ACTIVATION_URL = 'https://aventurine-app.com/activate';

    // The About modal shows the registered address; it is the watermark's whole
    // point that it is visible, so a shared key advertises whose it is.
    const aboutRow  = document.querySelector('[data-about-license-row]');
    const aboutText = document.querySelector('[data-about-license]');

    let busy = false;

    function setError(msg) {
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    }

    function render(st) {
        const licensed = st.state === 'licensed' && !!st.license;
        badgeEl.dataset.state = st.state;
        badgeEl.textContent =
            licensed ? 'Activated' : st.state === 'invalid' ? 'Not valid' : 'Not activated';

        descEl.textContent = licensed
            ? `Registered to ${st.license.email}. Issued ${st.license.issued}.`
            : st.message || 'This copy has not been activated yet.';

        activateEl.hidden = licensed;
        manageEl.hidden = !licensed;

        if (aboutRow) {
            aboutRow.hidden = !licensed;
            if (licensed) aboutText.textContent = st.license.email;
        }
    }

    async function refresh() {
        try {
            const res = await window.apiFetch('/api/license');
            render(await res.json());
        } catch {
            // A failed status read is not a licensing verdict; leave the panel
            // as it was rather than telling a paying user they are unlicensed.
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
            render(body);
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
        try {
            const res = await window.apiFetch('/api/license', { method: 'DELETE' });
            render(await res.json());
        } finally {
            busy = false;
        }
    }

    inputEl.addEventListener('input', () => {
        submitBtn.disabled = !inputEl.value.trim();
        setError('');
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
    removeBtn.addEventListener('click', remove);

    openBtn.addEventListener('click', () => {
        // Handed to the OS browser. window.open is denied and will-navigate is
        // locked to the app origin, so this is the only way out, and main.js
        // checks the URL against its own allowlist before opening anything.
        if (window.electronShell?.openExternal) {
            window.electronShell.openExternal(ACTIVATION_URL);
        } else {
            // Plain-browser fallback (no shell bridge): show it to copy.
            openBtn.textContent = ACTIVATION_URL;
        }
    });

    refresh();
    window.licenseActions = { refresh };
})();
