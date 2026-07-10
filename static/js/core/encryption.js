'use strict';

// ─── encryption.js ──────────────────────────────────────────────────────────
// Database Encryption modal. Opened from Settings → Security → Manage… via
// window.securityActions.showEncryption(). Drives POST /api/db/encryption with
// one of three actions, chosen from the live DB state:
//   encrypt — plaintext DB gains a password.
//   change  — re-encrypt an encrypted DB under a new password.
//   decrypt — remove encryption from an encrypted DB.
// The backend (conn.rekey) does the keying with a file-backup rollback; this is
// just the form. On success we reload so every status reader (auto-lock arming,
// the Security status line) re-reads cleanly — same pattern as a DB switch.

(function () {
    // Modal markup lives in the page HTML; this IIFE no-ops (and exposes no
    // securityActions) on any page that doesn't render it. Only
    // static/js/shell/settings.js calls window.securityActions.showEncryption().
    const overlay = document.querySelector('[data-modal="encryption"]');
    if (!overlay) return;

    // Grab every interactive element up front by data-attribute (not id/class),
    // so this script only binds to the encryption modal's own markup.
    const q = (sel) => overlay.querySelector(sel);
    const statusEl  = q('[data-enc-status]');
    const actionsEl = q('[data-enc-actions]');
    const curField  = q('[data-enc-current]');
    const newField  = q('[data-enc-new]');
    const confField = q('[data-enc-confirm]');
    const curInput  = q('[data-enc-current-input]');
    const newInput  = q('[data-enc-new-input]');
    const confInput = q('[data-enc-confirm-input]');
    const warnEl    = q('[data-enc-warning]');
    const errorEl   = q('[data-enc-error]');
    const submitBtn = q('[data-enc-submit]');
    const cancelBtn = q('[data-enc-cancel]');
    const closeBtn  = q('[data-enc-close]');

    // encrypted is the live DB state fetched in open(); it — not a form
    // field — is what decides whether "encrypt" is even a choice, since an
    // already-encrypted DB can only "change" or "decrypt". busy guards
    // against double-submit while the request is in flight.
    let encrypted = false;
    let busy = false;

    function setError(msg) { errorEl.textContent = msg || ''; errorEl.hidden = !msg; }

    // Resolves which of the three backend actions (encrypt/change/decrypt)
    // the current form state maps to. Forced to 'encrypt' when the DB isn't
    // encrypted, regardless of radio state, since those radios are hidden
    // in that case (see actionsEl.hidden in render()).
    function chosenAction() {
        if (!encrypted) return 'encrypt';
        const checked = overlay.querySelector('.enc-action-radio:checked');
        return checked ? checked.value : 'change';
    }

    // Pure view function: given { encrypted, chosenAction() }, show/hide the
    // right fields and relabel the submit button. Called after every state
    // change (radio toggle, DB-status fetch) so the form is always
    // consistent with `encrypted` + the selected action.
    function render() {
        const action = chosenAction();
        statusEl.textContent = encrypted
            ? 'This database is encrypted.'
            : 'This database is not encrypted.';
        actionsEl.hidden = !encrypted;
        curField.hidden  = !(action === 'change' || action === 'decrypt');
        newField.hidden  = !(action === 'encrypt' || action === 'change');
        confField.hidden = newField.hidden;
        warnEl.hidden    = action !== 'decrypt';
        submitBtn.textContent =
            action === 'encrypt' ? 'Encrypt Database' :
            action === 'decrypt' ? 'Remove Encryption' : 'Change Password';
        setError('');
    }

    // Entry point wired to window.securityActions.showEncryption(). Shows
    // the modal immediately with a blank/optimistic ('change') state, then
    // fetches the real encryption status async and re-renders once it
    // resolves — avoids a blocking spinner for what's normally an instant
    // check. If the status fetch fails, the modal is left in its default
    // (not-encrypted) render rather than erroring out.
    function open() {
        curInput.value = newInput.value = confInput.value = '';
        encrypted = false;
        const changeRadio = overlay.querySelector('.enc-action-radio[value="change"]');
        if (changeRadio) changeRadio.checked = true;
        render();
        overlay.hidden = false;
        apiFetch('/api/db/status')
            .then(r => r.json())
            .then(s => { encrypted = !!s.encrypted; render(); (encrypted ? curInput : newInput).focus(); })
            .catch(() => { render(); });
    }

    // Cancel/close are blocked while `busy` so a click can't dismiss the
    // modal mid-request and leave the caller unsure whether keying happened.
    function close() { if (!busy) overlay.hidden = true; }

    // Validates the relevant fields for the chosen action, then POSTs to
    // /api/db/encryption (handled by electron/backend/handlers/database.js,
    // which calls conn.rekey with a file-backup/rollback — see this file's
    // header comment). A password mismatch is only checked client-side;
    // the server is the source of truth for "is currentPassword correct".
    async function submit() {
        if (busy) return;
        const action = chosenAction();
        const currentPassword = curInput.value;
        const newPassword = newInput.value;
        setError('');

        if ((action === 'change' || action === 'decrypt') && !currentPassword) {
            setError('Enter the current password.'); curInput.focus(); return;
        }
        if (action === 'encrypt' || action === 'change') {
            if (!newPassword) { setError('Enter a new password.'); newInput.focus(); return; }
            if (newPassword !== confInput.value) { setError('Passwords do not match.'); confInput.focus(); return; }
        }

        busy = true; submitBtn.disabled = true;
        try {
            const res = await apiFetch('/api/db/encryption', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ action, currentPassword, newPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (data.ok) {
                // Full reload on success (not just closing the modal) — see
                // this file's header comment: every other status reader
                // (auto-lock arming, the Security status line in Settings)
                // needs to re-read the now-changed encryption state, and a
                // reload is the simplest way to guarantee that.
                try { sessionStorage.clear(); } catch { /* disabled — ignore */ }
                window.location.reload();
                return;
            }
            if (data.error === 'invalid_password') setError('Incorrect current password.');
            else setError(data.error || ('Request failed (' + res.status + ')'));
        } catch {
            setError('Could not reach the database. Is the app still running?');
        } finally {
            busy = false; submitBtn.disabled = false;
        }
    }

    // ── Event wiring ─────────────────────────────────────────────────────
    // Radios re-render (action may have changed); submit/cancel/close map to
    // the handlers above; clicking the overlay backdrop or pressing Escape
    // closes, and Enter inside any input submits the form.
    overlay.querySelectorAll('.enc-action-radio').forEach(r => r.addEventListener('change', render));
    submitBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') close();
    });

    // Public surface: just `open`, aliased as showEncryption for the caller
    // in static/js/shell/settings.js. Everything else in this file is
    // private to the closure.
    window.securityActions = { showEncryption: open };
}());
