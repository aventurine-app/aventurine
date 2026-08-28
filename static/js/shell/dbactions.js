'use strict';

// ─── dbactions.js ───────────────────────────────────────────────────────────
// New Database / Open Database wiring. Exposes window.dbActions
// {showNew, showOpen} for the title-bar File menu (titlebar.js) — the only
// UI entry points — so the modal and the API calls live in exactly one place.
//
// One modal (#db-modal in pages/partials/sidebar.html), four modes:
//   new    — NAME the database; it lands in the folder the backend proposes
//            (GET /api/db/status → default_dir), which the modal states and
//            "Change…" overrides. Type a name, press Create — browsing is the
//            exception, not a toll on every new database. Optionally encrypt
//            with a password. If no folder was proposed (status unreachable)
//            the mode falls back to the whole-path field the others use.
//   saveas — choose a destination path; the active database is copied there
//            (encryption + key preserved) and that copy becomes the working
//            file. No password prompt: it reuses the current DB's.
//   open   — choose an existing file; if the backend reports it is encrypted,
//            the password field is revealed and the request retried.
//   unlock — the app restarted while an encrypted DB was active. The path is
//            known (the backend keeps it in active-db.json); only the password
//            is needed. Not dismissable — every data API returns 423 until
//            unlocked — but "Open a different database…" is available if the
//            password is lost.
//
// Under Electron, Browse… / Change… open native save/open dialogs
// (window.electronFile from preload.js). In a plain browser — which cannot
// reveal real filesystem paths — they open an in-modal directory browser
// fed by GET /api/db/browse (the backend runs on the user's machine, so
// it can walk the disk on the page's behalf). Manual entry always works.

(function () {
    const modal      = document.getElementById('db-modal');
    if (!modal) return;

    const titleEl    = document.getElementById('db-modal-title');
    const hintEl     = document.getElementById('db-modal-hint');
    const errorEl    = document.getElementById('db-modal-error');
    const closeBtn   = document.getElementById('db-modal-close');
    const nameRow    = document.getElementById('db-name-row');
    const nameInput  = document.getElementById('db-name-input');
    const locRow     = document.getElementById('db-location-row');
    const locPath    = document.getElementById('db-location-path');
    const locChange  = document.getElementById('db-location-change');
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

    // ── New Database: a name, in a folder we propose ──────────────────────
    // newDir is that folder for the open modal — seeded from the backend's
    // default_dir, replaced the moment the user changes it. Empty means we
    // have no folder to offer and 'new' runs in the path-field fallback,
    // which is exactly what `nameRow.hidden` reports; `named()` is that test.
    let newDir = '';

    const DB_EXT_RE = /\.(db|sqlite|sqlite3)$/i;
    // Name → file name: everything outside letters, digits and a little plain
    // punctuation becomes a space. A whitelist rather than a blacklist because
    // it settles path separators, dot-segments, Windows' reserved characters
    // and control characters in one pass — the user is naming a database, not
    // writing a path, so nothing here should ever steer the write elsewhere.
    const NAME_SAFE_RE = /[^\p{L}\p{N} ._'()&+-]/gu;

    const named = () => mode === 'new' && !nameRow.hidden;

    /** File name for a typed database name; '' when nothing usable survives. */
    function fileNameFor(raw) {
        const cleaned = String(raw)
            .replace(NAME_SAFE_RE, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^[. ]+/, '')     // no dotfiles, no '..'
            .slice(0, 64)
            .replace(/[. ]+$/, '');    // Windows drops trailing dots/spaces
        if (!cleaned) return '';
        return DB_EXT_RE.test(cleaned) ? cleaned : cleaned + '.db';
    }

    /** The path Create would write, or '' if the name isn't usable yet. */
    function newPath() {
        const file = fileNameFor(nameInput.value);
        return file ? joinPath(newDir, file) : '';
    }

    /** Restate the destination. Without a usable name yet, the folder alone —
     *  never a file name the user didn't type. */
    function renderLocation() {
        locPath.textContent = newPath() || (newDir + browserSep);
    }

    /** Split a whole path (from a dialog) back into folder + name. The '.db'
     *  suffix added back is hidden; any other extension the user typed stays
     *  visible, and fileNameFor keeps it. */
    function adoptNewPath(p) {
        newDir = dirName(p) || newDir;
        const base = baseName(p);
        nameInput.value = /\.db$/i.test(base) ? base.slice(0, -3) : base;
        renderLocation();
    }

    function showModal(newMode, opts = {}) {
        mode = newMode;
        setError('');
        pathInput.value = '';
        passInput.value = '';
        confInput.value = '';
        encCheck.checked = false;
        // Every open re-proposes the current default: the folder can change
        // under us (a Save As, an Open) between one New Database and the next.
        newDir = mode === 'new' ? _defaultDir : '';

        const dismissable = mode !== 'unlock';
        closeBtn.hidden   = !dismissable;
        cancelBtn.hidden  = !dismissable;
        switchBtn.hidden  = mode !== 'unlock';
        nameRow.hidden    = mode !== 'new' || !newDir;
        locRow.hidden     = nameRow.hidden;
        pathRow.hidden    = mode === 'unlock' || named();
        browserPanel.hidden = true;
        encRow.hidden     = mode !== 'new' || opts.encryptionUnavailable;
        passRow.hidden    = mode === 'new' || mode === 'saveas' ||
                            (mode === 'open' && !opts.needPassword);
        confRow.hidden    = true;
        passLabel.textContent = 'Password';

        if (mode === 'new') {
            titleEl.textContent  = 'New Database';
            submitBtn.textContent = 'Create';
            setHint(named()
                ? 'Name your new database. It is stored on this computer, nowhere else.'
                : 'Choose where to store the new database file.');
            // A default name, pre-selected so typing replaces it.
            nameInput.value = 'Finances';
            renderLocation();
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
                : 'Choose an existing Aventurine database file.');
            if (opts.path) pathInput.value = opts.path;
        } else {
            titleEl.textContent  = 'Unlock Database';
            submitBtn.textContent = 'Unlock';
            setHint('The database' + (opts.path ? ' at ' + opts.path : '') +
                    ' is encrypted. Enter its password to continue.');
        }

        modal.hidden = false;
        if (named()) {
            nameInput.focus();
            nameInput.select();
        } else {
            (pathRow.hidden ? passInput : pathInput).focus();
            // No proposed folder yet — the status call is slow or failed and this
            // modal opened in its path-field fallback. Retry, and if a response
            // arrives before anything is typed, reopen in the name flow.
            if (mode === 'new') {
                fetchStatus().then(() => {
                    if (!modal.hidden && mode === 'new' && !named() &&
                        _defaultDir && !pathInput.value.trim()) showModal('new', opts);
                }).catch(() => { /* still unreachable — the fallback stands */ });
            }
        }
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

    // Both entry points to picking a location — "Browse…" beside the path
    // field, "Change…" beside the proposed destination — are the same act.
    async function chooseLocation() {
        if (fileApi) {
            const picker = (mode === 'new' || mode === 'saveas')
                ? fileApi.chooseNewDbPath
                : fileApi.chooseExistingDbPath;
            try {
                // Open the save dialog on the destination already shown, so
                // "Change…" starts where the user is.
                const picked = await picker(named() ? newPath() || newDir : undefined);
                if (!picked) return;
                if (named()) adoptNewPath(picked);
                else pathInput.value = picked;
            } catch { /* dialog unavailable — manual entry still works */ }
            return;
        }
        // Plain browser: toggle the in-modal directory browser. Seed it from
        // the proposed folder, or the typed path's directory.
        if (!browserPanel.hidden) {
            browserPanel.hidden = true;
            return;
        }
        browserPanel.hidden = false;
        loadBrowser(named() ? newDir : dirName(pathInput.value.trim()));
    }

    browseBtn.addEventListener('click', chooseLocation);
    locChange.addEventListener('click', chooseLocation);
    nameInput.addEventListener('input', renderLocation);

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
            // In the write modes the folder shown is the selected destination
            // while browsing: the name flow takes only the folder (the name field
            // supplies the file name), save-as keeps its whole path in sync.
            if (data.path === 'drives') return;
            if (named()) {
                newDir = data.path;
                renderLocation();
            } else if (mode === 'new' || mode === 'saveas') {
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
            if (onPick) li.addEventListener('click', onPick);
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
            // In the name flow the file name comes from the Name field, so the
            // databases already here are context only — shown (a collision is
            // worth seeing coming) but not selectable.
            addItem(name, named() ? 'db-browser-file db-browser-inert' : 'db-browser-file',
                    named() ? null : () => { pathInput.value = joinPath(data.path, name); });
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

        const password = passInput.value;
        let path;
        if (named()) {
            path = newPath();
            if (!path) {
                setError('Give this database a name.');
                nameInput.focus();
                return;
            }
        } else {
            path = pathInput.value.trim();
            if (mode !== 'unlock' && !path) {
                setError('Enter a file location.');
                return;
            }
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
            } else if (named() && status === 409) {
                // The generic "a file already exists at that location" is about
                // a path the user never typed — name the collision instead.
                setError('There is already a database called ' + baseName(path) +
                         ' in that folder.');
                nameInput.focus();
                nameInput.select();
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
    let _defaultDir = '';

    /** Read the backend's state for the active database: whether it is locked,
     *  whether encryption is available, and the folder to propose for a new one.
     *  Called on every page load, and again if a New Database modal opens before
     *  the response arrives. */
    function fetchStatus() {
        return apiFetch('/api/db/status')
            .then(r => r.json())
            .then(s => {
                _encryptionAvailable = !!s.encryption_available;
                if (typeof s.sep === 'string' && s.sep) browserSep = s.sep;
                if (typeof s.default_dir === 'string') _defaultDir = s.default_dir;
                return s;
            });
    }

    // Public entry points (title-bar File menu in titlebar.js; auto-lock uses
    // showUnlock to surface the prompt after an idle lock).
    window.dbActions = {
        showNew:    () => showModal('new', { encryptionUnavailable: !_encryptionAvailable }),
        showSaveAs: () => showModal('saveas', {}),
        showOpen:   () => showModal('open', {}),
        showUnlock: (path) => showModal('unlock', { path }),
    };

    // On every page load, read whether the active DB is locked (an encrypted DB
    // restored from the previous session with no key supplied yet).
    fetchStatus()
        .then(s => { if (s.locked) showModal('unlock', { path: s.path }); })
        .catch(() => { /* backend unreachable — nothing to do */ });
}());
