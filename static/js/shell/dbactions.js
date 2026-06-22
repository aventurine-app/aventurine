'use strict';

// ─── dbactions.js ───────────────────────────────────────────────────────────
// New Database / Open Database wiring. Exposes window.dbActions
// {showNew, showOpen} for the title-bar File menu (titlebar.js) — the only
// UI entry points — so the modal and the API calls live in exactly one place.
//
// One modal (#db-modal in pages/partials/sidebar.html), four modes:
//   new    — choose a destination path, optionally encrypt with a password.
//   saveas — choose a destination path; the active database is copied there
//            (encryption + key preserved) and that copy becomes the working
//            file. No password prompt: it inherits the current DB's.
//   open   — choose an existing file; if the server reports it's encrypted,
//            the password field is revealed and the request retried.
//   unlock — the app restarted while an encrypted DB was active. The path
//            is known (server keeps it in active-db.json); only the
//            password is needed. Not dismissable — every data API answers
//            423 until unlocked — but "Open a different database…" offers
//            the way out if the password is lost.
//
// Under Electron, the Browse… button opens native save/open dialogs
// (window.electronFile from preload.js). In a plain browser — which cannot
// reveal real filesystem paths — it opens an in-modal directory browser
// fed by GET /api/db/browse (the backend runs on the user's machine, so
// it can walk the disk on the page's behalf). Manual entry always works.

(function () {
    const modal      = document.getElementById('db-modal');
    if (!modal) return;

    const titleEl    = document.getElementById('db-modal-title');
    const hintEl     = document.getElementById('db-modal-hint');
    const errorEl    = document.getElementById('db-modal-error');
    const closeBtn   = document.getElementById('db-modal-close');
    const pathRow    = document.getElementById('db-path-row');
    const pathInput  = document.getElementById('db-path-input');
    const browseBtn  = document.getElementById('db-browse-btn');
    const encRow     = document.getElementById('db-encrypt-row');
    const encCheck   = document.getElementById('db-encrypt-check');
    const passRow    = document.getElementById('db-password-row');
    const passLabel  = document.getElementById('db-password-label');
    const passInput  = document.getElementById('db-password-input');
    const confRow    = document.getElementById('db-confirm-row');
    const confInput  = document.getElementById('db-confirm-input');
    const switchBtn  = document.getElementById('db-switch-open-btn');
    const cancelBtn  = document.getElementById('db-cancel-btn');
    const submitBtn  = document.getElementById('db-submit-btn');
    const browserPanel = document.getElementById('db-browser');
    const browserPath  = document.getElementById('db-browser-path');
    const browserList  = document.getElementById('db-browser-list');

    const fileApi = window.electronFile || null;

    let mode = 'new';           // 'new' | 'saveas' | 'open' | 'unlock'
    let busy = false;

    function setError(msg) {
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    }

    function setHint(msg) {
        hintEl.textContent = msg || '';
        hintEl.hidden = !msg;
    }

    function showModal(newMode, opts = {}) {
        mode = newMode;
        setError('');
        pathInput.value = '';
        passInput.value = '';
        confInput.value = '';
        encCheck.checked = false;

        const dismissable = mode !== 'unlock';
        closeBtn.hidden   = !dismissable;
        cancelBtn.hidden  = !dismissable;
        switchBtn.hidden  = mode !== 'unlock';
        pathRow.hidden    = mode === 'unlock';
        browserPanel.hidden = true;
        encRow.hidden     = mode !== 'new' || opts.encryptionUnavailable;
        passRow.hidden    = mode === 'new' || mode === 'saveas' ||
                            (mode === 'open' && !opts.needPassword);
        confRow.hidden    = true;
        passLabel.textContent = 'Password';

        if (mode === 'new') {
            titleEl.textContent  = 'New Database';
            submitBtn.textContent = 'Create';
            setHint('Choose where to store the new database file.');
        } else if (mode === 'saveas') {
            titleEl.textContent  = 'Save Database As';
            submitBtn.textContent = 'Save';
            setHint('Choose where to save a copy of the current database. '
                  + 'The copy becomes the active database.');
        } else if (mode === 'open') {
            titleEl.textContent  = 'Open Database';
            submitBtn.textContent = 'Open';
            setHint(opts.needPassword
                ? 'This database is encrypted — enter its password.'
                : 'Choose an existing Oliv database file.');
            if (opts.path) pathInput.value = opts.path;
        } else {
            titleEl.textContent  = 'Unlock Database';
            submitBtn.textContent = 'Unlock';
            setHint('The database' + (opts.path ? ' at ' + opts.path : '') +
                    ' is encrypted. Enter its password to continue.');
        }

        modal.hidden = false;
        (pathRow.hidden ? passInput : pathInput).focus();
    }

    function hideModal() {
        if (mode === 'unlock') return;   // locked app stays prompting
        modal.hidden = true;
    }

    // Encrypt checkbox (new mode) reveals password + confirm.
    encCheck.addEventListener('change', () => {
        const on = encCheck.checked;
        passRow.hidden = !on;
        confRow.hidden = !on;
        if (on) passInput.focus();
    });

    browseBtn.addEventListener('click', async () => {
        if (fileApi) {
            const picker = (mode === 'new' || mode === 'saveas')
                ? fileApi.chooseNewDbPath
                : fileApi.chooseExistingDbPath;
            try {
                const picked = await picker();
                if (picked) pathInput.value = picked;
            } catch { /* dialog unavailable — manual entry still works */ }
            return;
        }
        // Plain browser: toggle the in-modal directory browser. Seed it
        // from the typed path's directory when there is one.
        if (!browserPanel.hidden) {
            browserPanel.hidden = true;
            return;
        }
        browserPanel.hidden = false;
        loadBrowser(dirName(pathInput.value.trim()));
    });

    // ── In-modal filesystem browser (non-Electron) ────────────────────────
    let browserSep = '/';

    function dirName(p) {
        const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i > 0 ? p.slice(0, i) : '';
    }

    function baseName(p) {
        const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i >= 0 ? p.slice(i + 1) : p;
    }

    function joinPath(dir, name) {
        return dir + (dir.endsWith(browserSep) ? '' : browserSep) + name;
    }

    async function loadBrowser(path) {
        try {
            const res  = await apiFetch('/api/db/browse?path=' + encodeURIComponent(path || ''));
            const data = await res.json();
            if (!data.ok) { setError(data.error || 'Cannot read that folder'); return; }
            setError('');
            browserSep = data.sep;
            renderBrowser(data);
            // In new/save-as mode the folder choice IS the answer — keep the
            // path input pointing at <current folder>/<file name> as they browse.
            if ((mode === 'new' || mode === 'saveas') && data.path !== 'drives') {
                const fname = baseName(pathInput.value.trim()) || 'finance.db';
                pathInput.value = joinPath(data.path, fname);
            }
        } catch {
            setError('Network error — is the app still running?');
        }
    }

    function renderBrowser(data) {
        browserPath.textContent = data.path === 'drives' ? 'Drives' : data.path;
        // Built with createElement/textContent — file names are
        // user-controlled strings and must never hit innerHTML.
        browserList.replaceChildren();
        const addItem = (label, cls, onPick) => {
            const li = document.createElement('li');
            li.textContent = label;
            li.className   = cls;
            li.addEventListener('click', onPick);
            browserList.appendChild(li);
        };
        if (data.parent !== null && data.parent !== undefined) {
            addItem('.. (up one level)', 'db-browser-up',
                    () => loadBrowser(data.parent));
        }
        data.dirs.forEach(name => {
            const target = data.path === 'drives' ? name : joinPath(data.path, name);
            addItem(name, 'db-browser-dir', () => loadBrowser(target));
        });
        data.files.forEach(name => {
            addItem(name, 'db-browser-file', () => {
                pathInput.value = joinPath(data.path, name);
            });
        });
        if (!browserList.children.length) {
            const li = document.createElement('li');
            li.textContent = 'Empty folder';
            li.className   = 'db-browser-empty';
            browserList.appendChild(li);
        }
    }

    async function postJson(url, body) {
        const res  = await apiFetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    }

    function succeed() {
        // The sessionStorage dataset cache (store.js) belongs to the
        // previous database — drop it before anything re-renders.
        try { sessionStorage.clear(); } catch { /* disabled — ignore */ }
        window.location.reload();
    }

    async function submit() {
        if (busy) return;
        setError('');

        const path     = pathInput.value.trim();
        const password = passInput.value;

        if (mode !== 'unlock' && !path) {
            setError('Enter a file location.');
            return;
        }
        if (mode === 'new' && encCheck.checked) {
            if (!password)                    { setError('Enter a password.'); return; }
            if (password !== confInput.value) { setError('Passwords do not match.'); return; }
        }

        busy = true;
        submitBtn.disabled = true;
        try {
            let result;
            if (mode === 'new') {
                result = await postJson('/api/db/create', {
                    path, encrypt: encCheck.checked,
                    password: encCheck.checked ? password : null,
                });
            } else if (mode === 'saveas') {
                result = await postJson('/api/db/save-as', { path });
            } else if (mode === 'open') {
                result = await postJson('/api/db/open', { path, password: password || null });
            } else {
                result = await postJson('/api/db/unlock', { password });
            }

            const { status, data } = result;
            if (data.ok) { succeed(); return; }

            if (data.error === 'password_required') {
                passRow.hidden = false;
                setHint('This database is encrypted — enter its password.');
                setError('');
                passInput.focus();
            } else if (data.error === 'invalid_password') {
                passRow.hidden = false;
                setError('Incorrect password.');
                passInput.select();
                passInput.focus();
            } else {
                setError(data.error || ('Request failed (' + status + ')'));
            }
        } catch {
            setError('Network error — is the app still running?');
        } finally {
            busy = false;
            submitBtn.disabled = false;
        }
    }

    submitBtn.addEventListener('click', submit);
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            hideModal();
        }
    });

    closeBtn.addEventListener('click', hideModal);
    cancelBtn.addEventListener('click', hideModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal();
    });

    // Escape hatch from the unlock prompt (lost password / wrong DB):
    // switch to open mode, which IS dismissable back to unlock via Cancel.
    switchBtn.addEventListener('click', () => {
        showModal('open', { encryptionUnavailable: !_encryptionAvailable });
        cancelBtn.hidden = false;
        closeBtn.hidden  = false;
    });

    let _encryptionAvailable = true;

    // Public entry points (title-bar File menu in titlebar.js; auto-lock uses
    // showUnlock to surface the prompt after an idle lock).
    window.dbActions = {
        showNew:    () => showModal('new', { encryptionUnavailable: !_encryptionAvailable }),
        showSaveAs: () => showModal('saveas', {}),
        showOpen:   () => showModal('open', {}),
        showUnlock: (path) => showModal('unlock', { path }),
    };

    // On every page load, ask the server whether the active DB is locked
    // (encrypted DB restored from the previous session, key not yet given).
    apiFetch('/api/db/status')
        .then(r => r.json())
        .then(s => {
            _encryptionAvailable = !!s.encryption_available;
            if (s.locked) showModal('unlock', { path: s.path });
        })
        .catch(() => { /* server unreachable — nothing to do */ });
}());
