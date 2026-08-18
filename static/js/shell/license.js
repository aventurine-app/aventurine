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
    const previewEl  = q('[data-license-preview]');
    const errorEl    = q('[data-license-error]');
    const submitBtn  = q('[data-license-submit]');
    const openBtn    = q('[data-license-open]');
    const removeBtn  = q('[data-license-remove]');

    const ACTIVATION_URL = 'https://aventurine-app.com/activate';

    // The About modal shows the registered address; it is the watermark's whole
    // point that it is visible, so a shared key advertises whose it is.
    // Chrome-level bits: the read-only badge, and the About row. Both live
    // outside this panel, so they are queried from the document.
    const pillEl = document.querySelector('[data-license-pill]');
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
            ? `Activated by ${st.license.email}. Key issued ${st.license.issued}.`
            : st.message || 'This copy has not been activated yet.';

        activateEl.hidden = licensed;
        manageEl.hidden = !licensed;

        // An unlicensed install is read-only, so say so once, in the chrome,
        // rather than interrupting anyone.
        if (pillEl) pillEl.hidden = licensed;

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
            setPreview(null);
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

    /** Bring the user to this panel from anywhere in the app. Reuses the
     *  existing modal + tab wiring rather than duplicating it: opening the
     *  overlay and clicking the tab is exactly what a user would do. */
    function openPanel() {
        const overlay = document.querySelector('[data-modal="preferences"]');
        const tab = document.getElementById('settings-tab-license');
        if (!overlay || !tab) return;
        overlay.hidden = false;
        tab.click();
        inputEl.focus();
    }

    if (pillEl) pillEl.addEventListener('click', openPanel);

    // A refused write (402 from the router's read-only gate, announced by
    // core/api.js). The page that attempted it does not need to know why, so
    // the explanation happens here, once, and lands the user where they can act.
    let lastPrompt = 0;
    window.addEventListener('aventurine:license-required', () => {
        // Grid pages can fire several writes at once; one explanation is enough.
        const now = Date.now();
        if (now - lastPrompt < 1500) return;
        lastPrompt = now;

        window.UI?.toast?.(
            'This copy is read-only until it is activated. Your data is safe and can still be exported.',
            { duration: 7000 }
        );
        refresh();
        openPanel();
    });

    refresh();
    window.licenseActions = { refresh };
})();
