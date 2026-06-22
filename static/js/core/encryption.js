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
    const overlay = document.querySelector('[data-modal="encryption"]');
    if (!overlay) return;

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

    let encrypted = false;
    let busy = false;

    function setError(msg) { errorEl.textContent = msg || ''; errorEl.hidden = !msg; }

    function chosenAction() {
        if (!encrypted) return 'encrypt';
        const checked = overlay.querySelector('.enc-action-radio:checked');
        return checked ? checked.value : 'change';
    }

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

    function close() { if (!busy) overlay.hidden = true; }

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

    overlay.querySelectorAll('.enc-action-radio').forEach(r => r.addEventListener('change', render));
    submitBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') close();
    });

    window.securityActions = { showEncryption: open };
}());
