'use strict';

// ─── txfileimport.js ──────────────────────────────────────────────────────────
// Multi-format transaction import for the Transactions page — the UI half.
// All parsing (format sniffing, CSV/OFX/QIF/JSON/XLSX, date/amount
// normalisation, column detection, dup fingerprints) lives in txparse.js
// (window.TxParse, loaded before this file), which is pure and covered by
// the fixture-corpus regression suite in electron/backend/__tests__/
// txParse.test.js. This file holds everything with a DOM or network
// dependency: the file picker, the mapping and preview modals, the dup-hash
// fetch, and the commit POST.
//
// Flow:
//   1. Account      — "which account is this import for?", asked ONCE, up front,
//                     pre-filled from the account used last. Every later step
//                     reads that value, so the question is not repeated — not by
//                     the preview, and not by the month-end balances in the file,
//                     which use the same account
//   2. File picker  — format identified by magic bytes + content sniffing,
//                     so a misnamed file (OFX saved as .txt) still imports
//   3. Parse        — TxParse.parseFile → uniform {headers, rows, fixed}
//   4. Map columns  — auto-detect, then the user confirms or changes it in a
//                     modal. Shown for EVERY format: a fixed schema (OFX/QIF)
//                     only means the selectors arrive already correct
//   5. Preview      — show all parsed rows; flag likely duplicates; user
//                     checks/unchecks before committing
//   6. Commit       — POST confirmed rows to /api/transactions/import
//   7. Results      — "here's what we found": the digest of what landed where
//   8. Reload       — fire 'transactions:reload' so the ledger refreshes
//
// First-run onboarding (widgets/onboarding.js) runs the same code, asking step 1
// as part of its opening screen and replacing step 7.
//
// Steps 2 and 5 can block for over a second on large files, so each wait shows
// an indeterminate progress bar (export's progress styles). Those bars are
// raised before the pause becomes noticeable and stay up until it ends (see
// showBusyModal).
//
// All parsing is client-side. The backend receives only clean row objects. On
// import the backend auto-categorizes confident rows on-device (learned per-user
// rules first, then the built-in merchant lexicon); the count comes back as
// `auto_categorized`. Rows left blank are categorized by the user inline.

(function () {
    const TxFileImport = (() => {

        // ── HTML safety ──────────────────────────────────────────────────────────
        // Alias of the shared global in escape.js (loaded by pages/partials/scripts.html).
        const esc = escapeHtml;

        // The pure parsing core (txparse.js) — see the header comment.
        const { parseFile, detectColumns, applyMapping, deriveBalances, fingerprint, parseIsoDate, parseAmount } = TxParse;

        // ── API ───────────────────────────────────────────────────────────────────
        // The row shape the import endpoint accepts — shared by the dry-run
        // preview and the real commit so both send identical data for identical
        // rows (a parsed row carries extra bookkeeping fields, e.g. `_idx`).
        const toApiRow = ({ date, description, tx_type, amount, notes }) => ({ date, description, tx_type, amount, notes });

        async function fetchHashes(since) {
            const url = since ? `/api/transactions/hashes?since=${encodeURIComponent(since)}` : '/api/transactions/hashes';
            try {
                const r    = await apiFetch(url);
                const data = await r.json().catch(() => ({}));
                return new Set(data.hashes || []);
            } catch {
                return new Set();  // dup detection is best-effort; don't block import
            }
        }

        async function commitRows(rows, accountKey, balances) {
            // Every import is tagged with the account it came from (`accountKey`,
            // a balance_columns key). `balances` carries any month-end balances
            // read from the statement, seeded into that same account's Balance
            // Sheet cells; empty when the file carried none.
            const body = { rows };
            if (accountKey) body.account_key = accountKey;
            if (balances && balances.length) body.balances = balances;
            const r = await apiFetch('/api/transactions/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'import failed');
            return data; // { ok, inserted, skipped, balances_applied }
        }

        // Same endpoint, `dry_run: true` — runs the identical row-building and
        // categorization passes server-side (both read-only) but writes nothing,
        // so the combined "Here Is Your Import" screen can show the real
        // uncategorized count BEFORE the user commits to anything. Best-effort:
        // a failure just means the callout doesn't show, same spirit as the
        // dup-hash fetch above.
        async function dryRunImport(rows, accountKey) {
            try {
                const body = { rows, dry_run: true };
                if (accountKey) body.account_key = accountKey;
                const r = await apiFetch('/api/transactions/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const data = await r.json().catch(() => ({}));
                return r.ok ? data : null; // { found, would_insert, auto_categorized }
            } catch {
                return null;
            }
        }

        // The accounts this import can land in. `include_hidden` is what makes the
        // pre-named starter accounts ("Checking", "Credit Card") selectable before
        // any have been adopted — they appear here and nowhere else, and the one
        // that receives the import becomes visible (the backend adopts it; see
        // services/accounts.js).
        async function fetchBalanceColumns() {
            try {
                const r = await apiFetch('/api/balance/columns?include_hidden=true');
                if (!r.ok) return [];
                return await r.json().catch(() => []);
            } catch {
                return [];
            }
        }

        // Rename a starter account to what the user calls it. Safe on a still-hidden
        // row: it stays hidden (invisible everywhere) until an import adopts it.
        async function renameBalanceColumn(key, label) {
            const r = await apiFetch(`/api/balance/columns/${encodeURIComponent(key)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'could not name the account');
        }

        async function createBalanceColumn(label, type) {
            const r = await apiFetch('/api/balance/columns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label, type }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'could not create the account');
            return data.column; // { key, label, type }
        }

        // The account used by the last import, which pre-fills the account question
        // next time. It is the only account state stored: the question is asked
        // BEFORE the file dialog, so nothing about the file — its header shape, its
        // name, an embedded account number — is available yet, and none of it would
        // identify the account reliably. An account is a bucket the USER defines;
        // someone who changes banks mid-year still has one logical "Checking", so
        // the last choice is a better predictor than the file.
        //
        // For the common case (importing the same account each month) this reduces
        // the step to one Continue. When it is wrong, changing it is one click, and
        // it is a visible question rather than an assumption.
        const LAST_ACCT_KEY = 'balance-import-last-account';
        function lastUsedAccount() {
            try {
                return localStorage.getItem(LAST_ACCT_KEY) || null;
            } catch {
                return null;
            }
        }
        function rememberAccount(key) {
            try {
                localStorage.setItem(LAST_ACCT_KEY, key);
            } catch {
                // best-effort — memory is a nicety, not required for import
            }
        }

        // ── Modal shell ───────────────────────────────────────────────────────────
        // Returns { dialog, body, close } where body is the scrollable content div.
        function buildModal(title) {
            const overlay = document.createElement('div');
            overlay.className = 'tx-import-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'tx-import-dialog';

            const header = document.createElement('div');
            header.className = 'tx-import-dialog-header';
            header.innerHTML = `
            <span class="tx-import-dialog-title">${esc(title)}</span>
            <button class="tx-import-close" title="Close">&times;</button>
        `;

            const body = document.createElement('div');
            body.className = 'tx-import-dialog-body';

            dialog.append(header, body);
            overlay.append(dialog);
            document.body.append(overlay);

            // Same closable guard as txexport.js's buildModal: the dialog cannot
            // be dismissed while a parse or the commit POST is in flight.
            let closable = true;
            const close = () => { if (closable) overlay.remove(); };
            header.querySelector('.tx-import-close').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

            return {
                overlay, dialog, body, close,
                setClosable(v) {
                    closable = v;
                    header.querySelector('.tx-import-close').disabled = !v;
                },
            };
        }

        // ── Busy states ───────────────────────────────────────────────────────────
        // The import flow's waits (file parse, the single commit POST) have no
        // row-level progress to report, so they use the export modal's progress
        // styles with an indeterminate fill instead of a percentage.
        function progressBar(label) {
            const el = document.createElement('div');
            el.className = 'tx-export-progress';
            el.innerHTML = `
            <div class="tx-export-progress-label">${esc(label)}</div>
            <div class="tx-export-progress-track"><div class="tx-export-progress-fill tx-export-progress-fill--indeterminate"></div></div>
        `;
            return el;
        }

        // Mirrors the .tx-import-overlay--busy keyframes: the overlay holds
        // invisible for BUSY_REVEAL_MS, then fades in. Work that finishes inside
        // the hold never showed a modal at all, so nothing flashes.
        const BUSY_REVEAL_MS = 90;
        // Once the bar is on screen it stays this long. A loader that disappears
        // mid-wait leaves the rest of the wait on an unchanged screen with no
        // indication that work is still running.
        const BUSY_MIN_VISIBLE_MS = 320;

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // Standalone busy modal for the parse / preview-prep waits.
        //
        // `instant` skips the anti-flash hold, for a wait that starts as another
        // modal closes (Map Columns → "Preparing your import…"): with the hold,
        // those ~90ms show the bare page where the dialog was, which is the flash
        // the hold is meant to prevent. Opened from NO
        // modal (the file picker), the hold is right.
        function showBusyModal(label, { instant = false } = {}) {
            const modal = buildModal('Import Transactions');
            if (!instant) modal.overlay.classList.add('tx-import-overlay--busy');
            modal.dialog.classList.add('tx-import-dialog--busy');
            modal.setClosable(false);
            modal.body.append(progressBar(label));

            const revealAt = performance.now() + (instant ? 0 : BUSY_REVEAL_MS);
            // Async: callers `await` it, so a bar that has been shown completes its
            // minimum duration before the flow continues. Awaiting adds no blank
            // frame — the caller's continuation runs as a microtask, so its next
            // work (building the preview table, the other half of the wait) still
            // happens while the bar is painted.
            return {
                async close() {
                    const now = performance.now();
                    if (now >= revealAt) {
                        const held = revealAt + BUSY_MIN_VISIBLE_MS - now;
                        if (held > 0) await sleep(held);
                    }
                    modal.setClosable(true);
                    modal.close();
                },
            };
        }

        // Two frames: the busy bar must be painted (and compositor-animated)
        // before synchronous parse work blocks the renderer.
        const nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // ── Step 1: Mapping modal ─────────────────────────────────────────────────
        function showMappingModal(headers, rows, detected, onContinue) {
            const { body, dialog, close } = buildModal('Map Columns');

            // Live selection state, initialised from detectColumns and re-read from
            // the selects before every re-render, so changing one field's column
            // does not reset another.
            const current = { ...detected };
            // Split mode: money out / money in as two separate columns
            // (Debit/Credit, Withdrawal/Deposit) instead of one signed Amount
            // — direction then comes from the column, not the sign (banks list
            // positive magnitudes in both). This is a FACT about the file, not a
            // preference, so it is detected once from the headers (detectColumns,
            // with a data-shape fallback for anonymous headers — see
            // txparse.js findSplitPair) and is not user-toggleable: the file
            // already determines it. If a specific column guess is wrong, its
            // dropdown can still be changed — only the overall SHAPE is fixed.
            const split = detected.debit !== null && detected.credit !== null;

            const CURRENCY = (typeof CURRENCY_SYMBOL !== 'undefined') ? CURRENCY_SYMBOL : '$';
            const fmtAmt   = (n) => CURRENCY + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

            // Renders the shared preview shell around a set of columns + rows;
            // `rowsHtml` is already-escaped/formatted <td> cell markup per row.
            function previewTableHtml(columnLabels, rowsHtml) {
                return `
                <p class="tx-import-hint">Match the columns in your file to the transaction fields below.</p>
                <div class="tx-import-section-label">Preview (first 3 rows)</div>
                <div class="tx-import-preview-wrap">
                    <table class="tx-import-preview-table">
                        <thead><tr>${columnLabels.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                        <tbody>
                            ${rowsHtml.length ? rowsHtml.map(cells => `<tr>${cells.join('')}</tr>`).join('')
                                : `<tr><td colspan="${columnLabels.length}" class="tx-import-preview-empty">Select the columns below to preview your data</td></tr>`}
                        </tbody>
                    </table>
                </div>
            `;
            }

            // A live preview of the first 3 rows, run through the SAME mapping
            // currently selected, so the dates and amounts appear in their mapped
            // fields before Map Columns is confirmed, rather than as a raw dump of
            // file columns that ignores the mapping. Re-run from render() on every
            // selection change; shows "select columns to preview" until the required
            // fields are chosen.
            //
            // Split mode shows Debit and Credit as separate columns (the raw cell
            // text, formatted as currency when it parses) instead of combining them
            // into one Amount, so it is visible that "Money out" and "Money in"
            // each read from the intended column.
            function livePreviewHtml() {
                const sampleRaw = rows.slice(0, 3);

                if (split) {
                    const ready = current.debit != null || current.credit != null;
                    const cellAmt = (raw) => {
                        const s = (raw ?? '').trim();
                        if (!s) return '';
                        const v = parseAmount(s);
                        return esc(Number.isNaN(v) ? s : fmtAmt(v));
                    };
                    const previewRows = ready ? sampleRaw
                        .map(r => ({
                            date: parseIsoDate(r[current.date]),
                            description: (r[current.description] ?? '').trim(),
                            debit: current.debit  != null ? r[current.debit]  : '',
                            credit: current.credit != null ? r[current.credit] : '',
                            notes: current.notes   != null ? (r[current.notes] ?? '').trim() : '',
                        }))
                        .filter(r => r.date && r.description)
                        .map(r => [
                            `<td>${esc(r.date)}</td>`,
                            `<td>${esc(r.description)}</td>`,
                            `<td class="tx-import-col-amount">${cellAmt(r.debit)}</td>`,
                            `<td class="tx-import-col-amount">${cellAmt(r.credit)}</td>`,
                            `<td>${r.notes ? esc(r.notes) : ''}</td>`,
                        ]) : [];
                    return previewTableHtml(['Date', 'Description', 'Debit', 'Credit', 'Notes'], previewRows);
                }

                const mapping = { date: current.date, description: current.description, amount: current.amount, debit: null, credit: null, notes: current.notes, balance: current.balance };
                let sample = [];
                if (mapping.amount != null) {
                    try {
                        sample = applyMapping(sampleRaw, mapping, 2).parsed;
                    } catch {
                        sample = []; // a mid-selection mapping can be transiently invalid
                    }
                }
                const previewRows = sample.map(r => [
                    `<td>${esc(r.date)}</td>`,
                    `<td>${esc(r.description)}</td>`,
                    `<td class="tx-import-col-amount">${esc(fmtAmt(r.amount))}</td>`,
                    `<td>${r.notes ? esc(r.notes) : ''}</td>`,
                ]);
                return previewTableHtml(['Date', 'Description', 'Amount', 'Notes'], previewRows);
            }

            // Build one <select> row per required/optional field.
            function mapSelect(label, field, required) {
                const selectedIdx = current[field];
                const opts = (required ? '' : '<option value="">— skip —</option>') +
                    headers.map((h, i) =>
                        `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${esc(h)}</option>`
                    ).join('');
                return `
                <div class="tx-import-map-row">
                    <span class="tx-import-map-label">${esc(label)}</span>
                    <select class="tx-select tx-import-map-select" data-field="${field}">${opts}</select>
                </div>
            `;
            }

            // Read the rendered selects back into `current` (only the fields
            // of the active mode exist in the DOM at any given time).
            function harvest() {
                body.querySelectorAll('.tx-import-map-select').forEach(sel => {
                    current[sel.dataset.field] = sel.value === '' ? null : parseInt(sel.value, 10);
                });
            }

            // Footer lives outside body (appended to the dialog directly), so its
            // top border spans the full modal width like every other modal's,
            // instead of only the body's padded content width.
            const footer = document.createElement('div');
            footer.className = 'tx-import-footer tx-import-footer--mapping';
            footer.innerHTML = `<button class="button-primary tx-import-continue-btn">Continue →</button>`;
            dialog.append(footer);

            footer.querySelector('.tx-import-continue-btn').addEventListener('click', () => {
                harvest();
                if (current.date        === null) { alert('Please select the Date column.');        return; }
                if (current.description === null) { alert('Please select the Description column.'); return; }
                let mapping;
                if (split) {
                    // At least one side must be mapped (a debit-only export
                    // is legitimate); both on the same column would leave
                    // every row's direction ambiguous.
                    if (current.debit === null && current.credit === null) {
                        alert('Please select the Money out and/or Money in columns.');
                        return;
                    }
                    if (current.debit !== null && current.debit === current.credit) {
                        alert('Money out and Money in must be different columns.');
                        return;
                    }
                    mapping = {
                        date: current.date, description: current.description,
                        amount: null, debit: current.debit, credit: current.credit,
                        notes: current.notes, balance: current.balance,
                    };
                } else {
                    if (current.amount === null) { alert('Please select the Amount column.'); return; }
                    mapping = {
                        date: current.date, description: current.description,
                        amount: current.amount, debit: null, credit: null,
                        notes: current.notes, balance: current.balance,
                    };
                }
                close();
                onContinue(mapping);
            });

            function render() {
                // A required select has no "— skip —" option, so once rendered the
                // browser always displays some column as picked — if none is marked
                // `selected` (current[field] still null), it defaults to the first
                // one. Left as is, `current` holds null while the dropdown shows a
                // column, and the live preview (which reads `current`) does not
                // match the screen. Sync before building anything so the select,
                // the preview and `current` stay consistent — this also makes a
                // wrong detection visible in the preview instead of only taking
                // effect at Continue.
                if (current.date        == null) current.date = 0;
                if (current.description == null) current.description = 0;
                if (!split && current.amount == null) current.amount = 0;

                const amountRows = split
                    ? mapSelect('Money out (Debit)',  'debit',  false)
                      + mapSelect('Money in (Credit)', 'credit', false)
                    : mapSelect('Amount *', 'amount', true);

                body.innerHTML = livePreviewHtml() + `
                <div class="tx-import-section-label">Column mapping</div>
                <div class="tx-import-map-form">
                    ${mapSelect('Date *',        'date',        true)}
                    ${mapSelect('Description *', 'description', true)}
                    ${amountRows}
                    ${mapSelect('Notes',         'notes',       false)}
                    ${mapSelect('Balance',       'balance',     false)}
                </div>
            `;

                // Any field change re-runs the live preview above with the new
                // selections — harvest() first so `current` (which the preview
                // reads) reflects what's on screen right now.
                body.querySelectorAll('.tx-import-map-select').forEach(sel => {
                    sel.addEventListener('change', () => {
                        harvest();
                        render();
                    });
                });
            }

            render();
        }

        // The kinds of account a user can add, in presentation order — most-imported
        // first, independent of Balance Sheet position (which groups by col_type). A
        // card export is the messiest, most commonly imported statement there is.
        //
        // `kind` matches the key of the seeded starter row this replaces for the
        // first account of its kind (seed.js DEFAULT_BALANCE_COLUMNS); `type` is the
        // col_type a new column gets otherwise. These labels and hints are STATIC
        // and never read from the database, so a starter row renamed ("Chase
        // Checking") does not turn this list of kinds into a list of existing
        // accounts. The six kinds cover all four col_types, so the user never picks
        // a type directly.
        //
        // The placeholders show that these are the user's own account names, using
        // generic examples rather than real brands.
        const ACCOUNT_KINDS = [
            { kind: 'checking',    label: 'Checking',    type: 'cash',       group: 'Cash',       hint: 'Everyday spending account',      placeholder: 'e.g. Joint Checking' },
            { kind: 'credit_card', label: 'Credit Card', type: 'debt',       group: 'Debt',       hint: 'A card you pay off',             placeholder: 'e.g. Everyday Card' },
            { kind: 'savings',     label: 'Savings',     type: 'cash',       group: 'Cash',       hint: 'Money set aside',                placeholder: 'e.g. Emergency Fund' },
            { kind: 'investments', label: 'Investments', type: 'investment', group: 'Investment', hint: 'Brokerage or taxable investing', placeholder: 'e.g. Brokerage' },
            { kind: 'retirement',  label: 'Retirement',  type: 'retirement', group: 'Retirement', hint: '401(k), IRA, pension',           placeholder: 'e.g. Work 401(k)' },
            { kind: 'debt',        label: 'Loan',        type: 'debt',       group: 'Debt',       hint: 'Loan, mortgage, line of credit', placeholder: 'e.g. Car Loan' },
        ];

        // ── The account question ──────────────────────────────────────────────────
        // Asked ONCE, up front: every import is tagged with the account it came
        // from, which scopes dedup, drives per-account spend, and assigns a
        // month-end balance in the file to a column. Because the value is set before
        // any rows are shown, no later step asks again.
        //
        // Shared by first-run onboarding and ordinary imports, so the question is
        // identical in both. Two sections:
        //
        //   Your accounts  — the accounts that already exist, under the names the
        //                    user gave them. Omitted entirely until there is one.
        //   Add a new one  — the KINDS of account (below), each named by the user
        //                    at creation.
        //
        // Naming is part of creating and is never skipped: account names are
        // user-specific, and a ledger of "Checking" and "Savings" is the generic
        // result this flow avoids. "Chase Checking" and "Amex Gold" are names only
        // the user can supply.
        //
        // `preselect` comes from the user's import HISTORY, never from the file — an
        // account is a bucket the user defines, and a bank's name does not identify
        // it. It only preselects an EXISTING account; a new one requires a typed
        // name, so it cannot be created by clicking through.
        function accountChoicesHtml(accounts, { name = 'acct-choice', preselect = null } = {}) {
            const adopted = accounts.filter(a => !a.hidden);

            const tile = (value, label, hint, checked) => `
                <label class="acct-tile">
                    <input type="radio" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}>
                    <span class="acct-tile-body">
                        <span class="acct-tile-name">${esc(label)}</span>
                        ${hint ? `<span class="acct-tile-hint">${esc(hint)}</span>` : ''}
                    </span>
                </label>`;

            return `
                ${adopted.length ? `
                <div class="acct-section-label">Your accounts</div>
                <div class="acct-tiles">
                    ${adopted.map(a => tile(a.key, a.label, ACCOUNT_KINDS.find(k => k.type === a.type)?.group || '', a.key === preselect)).join('')}
                </div>` : ''}

                <div class="acct-section-label">${adopted.length ? 'Or add a new one' : 'Add your first account'}</div>
                <div class="acct-tiles">
                    ${ACCOUNT_KINDS.map(k => tile(`new:${k.kind}`, k.label, k.hint, false)).join('')}
                </div>
                <div class="acct-custom" hidden>
                    <label class="acct-custom-label" for="${esc(name)}-new-name">What do you call it?</label>
                    <input type="text" id="${esc(name)}-new-name" class="tx-input acct-custom-name" maxlength="100"
                        placeholder="Account name" aria-label="Name for the new account">
                </div>`;
        }

        // Wire the markup above. `onValidityChange(ok)` fires whenever the
        // selection becomes valid or invalid, so the caller can enable or disable
        // its primary button — a new account is invalid until it has a name.
        //
        // resolve() yields { key, label }. For a new account it first tries to reuse
        // the matching unadopted STARTER row, renaming it to the typed name: that
        // keeps the stable seeded key for the common "first account of this kind"
        // case and avoids leaving unused starter rows. A second account of the same
        // kind (two checking accounts) gets a new column. Either way the row becomes
        // VISIBLE only when the import lands in it (the backend adopts it), so
        // backing out here leaves nothing behind.
        function wireAccountChoices(root, accounts, { onValidityChange = () => {} } = {}) {
            const custom = root.querySelector('.acct-custom');
            const nameInput = root.querySelector('.acct-custom-name');
            const chosen = () => root.querySelector('input[type="radio"]:checked');
            const kindOf = (sel) => (sel && sel.value.startsWith('new:'))
                ? ACCOUNT_KINDS.find(k => k.kind === sel.value.slice(4))
                : null;

            const refresh = () => {
                const sel = chosen();
                const kind = kindOf(sel);
                custom.hidden = !kind;
                if (kind) nameInput.placeholder = kind.placeholder;
                onValidityChange(!!sel && (!kind || !!nameInput.value.trim()));
            };

            root.querySelectorAll('input[type="radio"]').forEach(r => {
                r.addEventListener('change', () => {
                    refresh();
                    if (kindOf(chosen())) nameInput.focus();
                });
            });
            nameInput.addEventListener('input', refresh);
            refresh();

            return {
                async resolve() {
                    const sel = chosen();
                    if (!sel) throw new Error('Please choose the account this import is for.');
                    const kind = kindOf(sel);
                    if (!kind) {
                        const a = accounts.find(x => x.key === sel.value);
                        return { key: a.key, label: a.label };
                    }
                    const label = nameInput.value.trim();
                    if (!label) {
                        nameInput.focus();
                        throw new Error('Please give the new account a name.');
                    }
                    const starter = accounts.find(a => a.key === kind.kind && a.hidden);
                    if (starter) {
                        await renameBalanceColumn(starter.key, label);
                        return { key: starter.key, label };
                    }
                    const col = await createBalanceColumn(label, kind.type);
                    return { key: col.key, label: col.label };
                },
            };
        }

        // Step 0 of an ordinary import: settle the account before opening the file
        // dialog. Resolves to { key, label }, or null if the user backs out.
        //
        // The default comes from import history — the account this file shape went
        // to last, else the account used last, else the only existing account. For a
        // routine monthly statement that reduces this step to one Continue; for a
        // first import, or an unseen file shape, no value is pre-filled.
        async function askAccount() {
            const accounts = await fetchBalanceColumns();
            const adopted = accounts.filter(a => !a.hidden);
            const known = (key) => key && accounts.some(a => a.key === key);
            const last = lastUsedAccount();
            const preselect = known(last) ? last
                : adopted.length === 1 ? adopted[0].key
                    : null;

            return new Promise((resolveStep) => {
                const modal = buildModal('Import Transactions');
                let done = false;
                const finish = (value) => { if (!done) { done = true; modal.close(); resolveStep(value); } };

                modal.body.innerHTML = `
                    ${accountChoicesHtml(accounts, { name: 'tx-import-account', preselect })}
                `;

                const footer = document.createElement('div');
                footer.className = 'tx-import-footer';
                footer.innerHTML = `
                    <span class="tx-import-row-count"></span>
                    <button type="button" class="button-primary tx-import-acct-next">Choose file…</button>
                `;
                modal.dialog.append(footer);

                const nextBtn = footer.querySelector('.tx-import-acct-next');
                const choices = wireAccountChoices(modal.body, accounts, {
                    onValidityChange: (ok) => { nextBtn.disabled = !ok; },
                });

                // Dismissing the dialog is backing out of the import, not an error.
                modal.overlay.addEventListener('click', (e) => { if (e.target === modal.overlay) finish(null); });
                modal.dialog.querySelector('.tx-import-close').addEventListener('click', () => finish(null));

                nextBtn.addEventListener('click', async () => {
                    nextBtn.disabled = true;
                    try {
                        finish(await choices.resolve());
                    } catch (err) {
                        UI.toast(err.message, { type: 'error' });
                        nextBtn.disabled = false;
                    }
                });
            });
        }

        // ── The uncategorized callout ─────────────────────────────────────────────
        // The gray callout on the combined "Here Is Your Import" screen — the only
        // place the categorizer's result is shown. Leaving a row blank is the
        // intended behaviour when confidence is low, so this states the count
        // rather than omitting it: `found` comes from a dry-run categorization pass
        // (see dryRunImport above), run BEFORE the commit, so the count is accurate
        // and costs nothing if the user backs out.
        function uncategorizedNoteHtml(found) {
            if (!found || !found.uncategorized) return '';
            const n = found.uncategorized;
            return `
                <div class="tx-found-note">
                    ${n} transaction${n !== 1 ? 's' : ''} will be left uncategorized —
                    Aventurine only fills in what it's sure of. Set ${n !== 1 ? 'them' : 'it'}
                    once in your ledger and it'll remember next time.
                </div>`;
        }

        // ── Step 2: "Here Is Your Import" ─────────────────────────────────────────
        // The combined preview and results screen: the table the old "Review
        // Import" step showed, plus the uncategorized callout the old post-commit
        // "Here's what we found" showed — computed here via a dry run (see
        // dryRunImport above) so it is accurate BEFORE anything is written. Two
        // actions: "Go Back" re-opens Map Columns with the same selections and
        // commits nothing; "Looks Right" performs the commit.
        //
        // `opts.account` — { key, label }, always set: every path resolves the
        // account before the file dialog opens (askAccount, or onboarding's
        // picker). A successful commit continues to Step 4 (showSuccessModal).
        function showImportModal(parsed, errors, dupeSet, balanceReadings, dryRun, opts, goBack) {
            const { body, close, setClosable } = buildModal('Here Is Your Import');

            // Augment each row with a stable index, fingerprint, and dup flag.
            const rows     = parsed.map((r, i) => ({ ...r, _idx: i, _fp: fingerprint(r), _dup: dupeSet.has(fingerprint(r)) }));
            const checked  = new Set(rows.filter(r => !r._dup).map(r => r._idx));

            const CURRENCY = (typeof CURRENCY_SYMBOL !== 'undefined') ? CURRENCY_SYMBOL : '$';
            const fmtAmt   = (n) => CURRENCY + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

            // Error banner (parse failures from applyMapping).
            const errBanner = errors.length ? `
            <div class="tx-import-errors-banner">
                ${errors.length} row${errors.length !== 1 ? 's' : ''} could not be parsed and will be skipped:
                ${errors.slice(0, 3).map(e => `row ${e.row} — ${esc(e.reason)}`).join('; ')}${errors.length > 3 ? '…' : ''}
            </div>` : '';

            // A snapshot from the dry run above — it does not recompute as rows
            // are checked/unchecked below (unchecking is mainly for duplicates, a
            // small minority), so this stays one cheap server round trip.
            const noteHtml = uncategorizedNoteHtml(dryRun && dryRun.found);

            // Footer lives outside body so it stays visible while the table
            // scrolls, and holds exactly the two actions the spec calls for.
            const footer = document.createElement('div');
            footer.className = 'tx-import-footer tx-import-footer--preview';
            footer.innerHTML = `
            <button type="button" class="button-secondary tx-import-back-btn">Go Back</button>
            <button type="button" class="button-primary tx-import-do-btn" disabled>Looks Right</button>
        `;

            const dialog = body.closest('.tx-import-dialog');
            // Widen the shell for the full row table so every column fits without
            // a horizontal scroll; the column-mapping step keeps the narrow width.
            dialog.classList.add('tx-import-dialog--preview');
            dialog.append(footer);

            // The uncategorized callout, pinned in the static bar above the
            // footer — it replaces what used to be an "Importing into: <account>"
            // statement here. Lives outside the scrolling body, so it survives
            // renderTable's innerHTML rewrites and stays visible while the list
            // scrolls. Absent entirely when there's nothing uncategorized.
            const account = opts.account;
            const staticNote = noteHtml ? document.createElement('div') : null;
            if (staticNote) {
                staticNote.className = 'tx-import-balance-bar';
                staticNote.innerHTML = noteHtml;
                dialog.insertBefore(staticNote, footer);
            }

            function updateCount() {
                const n = checked.size;
                const headline = body.querySelector('.tx-found-headline');
                if (headline) headline.textContent = `${n} transaction${n !== 1 ? 's' : ''} will be added`;
                footer.querySelector('.tx-import-do-btn').disabled = n === 0;
            }

            function renderTable() {
                const allChecked = rows.length > 0 && rows.every(r => checked.has(r._idx));
                body.innerHTML = errBanner + `
                <div class="tx-found-headline"></div>
                <div class="tx-import-preview-wrap">
                    <table class="tx-import-preview-table tx-import-preview-full">
                        <thead>
                            <tr>
                                <th><input type="checkbox" class="tx-import-check-all"${allChecked ? ' checked' : ''}></th>
                                <th>Date</th>
                                <th>Description</th>
                                <th>Amount</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr class="${r._dup ? 'tx-import-row-dup' : ''}">
                                    <td><input type="checkbox" class="tx-import-row-check" data-idx="${r._idx}"${checked.has(r._idx) ? ' checked' : ''}></td>
                                    <td>${esc(r.date)}</td>
                                    <td class="tx-import-col-desc"><div class="tx-import-desc-inner"><span class="tx-import-desc-text" title="${esc(r.description)}">${esc(r.description)}</span>${r._dup ? '<span class="tx-import-dup-badge">duplicate</span>' : ''}</div></td>
                                    <td class="tx-import-col-amount">${esc(fmtAmt(r.amount))}</td>
                                    <td>${r.notes ? `<span class="tx-import-note-text" title="${esc(r.notes)}">${esc(r.notes)}</span>` : ''}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

                body.querySelector('.tx-import-check-all')?.addEventListener('change', (e) => {
                    if (e.target.checked) rows.forEach(r => checked.add(r._idx));
                    else checked.clear();
                    renderTable();
                });

                body.querySelectorAll('.tx-import-row-check').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const idx = parseInt(e.target.dataset.idx, 10);
                        e.target.checked ? checked.add(idx) : checked.delete(idx);
                        // Update check-all state without re-rendering the whole table.
                        body.querySelector('.tx-import-check-all').checked =
                            rows.every(r => checked.has(r._idx));
                        updateCount();
                    });
                });

                updateCount();
            }

            renderTable();

            footer.querySelector('.tx-import-back-btn').addEventListener('click', () => {
                close();
                goBack();
            });

            footer.querySelector('.tx-import-do-btn').addEventListener('click', async () => {
                const toSend = rows.filter(r => checked.has(r._idx)).map(toApiRow);

                rememberAccount(account.key);

                // Month-end balances from the file go to the same account, with
                // no second prompt: the account is already chosen, and the
                // readings are written as ordinary, hand-editable Balance Sheet
                // cells that can be changed or cleared afterwards.
                const balances = balanceReadings.map(b => ({
                    account_key: account.key, date: b.date, value: b.value, source: b.source,
                }));

                // Swap the table for an indeterminate bar while the commit POST
                // writes to the database, so the wait shows visible progress.
                const tableView = [...body.children];
                body.replaceChildren(progressBar(`Importing ${toSend.length} transaction${toSend.length !== 1 ? 's' : ''}…`));
                footer.style.display = 'none';
                if (staticNote) staticNote.style.display = 'none';
                setClosable(false);

                try {
                    const result = await commitRows(toSend, account.key, balances);
                    setClosable(true);
                    close();
                    // Imported rows change the computed Cash Flow cells the
                    // dashboards render from the shared Store cache — drop it
                    // so they refetch instead of showing stale data. Applied
                    // balances feed the Balance Sheet's computed layer, so drop
                    // that dataset too. An adopted account is a brand-new
                    // Balance Sheet column, so that dataset is stale as well.
                    if (window.Store) {
                        window.Store.invalidate('ie');
                        if (result.balances_applied || result.account_adopted) {
                            window.Store.invalidate('balance');
                        }
                    }
                    window.dispatchEvent(new Event('transactions:reload'));
                    // The preview was already confirmed by "Looks Right" above,
                    // so Step 4 is only a confirmation plus the two next
                    // actions.
                    showSuccessModal(opts, result);
                } catch (err) {
                    // Restore the preview so the user can retry or deselect rows.
                    body.replaceChildren(...tableView);
                    footer.style.display = '';
                    if (staticNote) staticNote.style.display = '';
                    setClosable(true);
                    UI.toast('Import failed: ' + err.message, { type: 'error' });
                }
            });
        }

        // ── Step 4: success ───────────────────────────────────────────────────────
        // The commit has already succeeded — Step 3's "Looks Right" was the last
        // step that could fail. Minimal by design: no summary, no bars (those are
        // shown in "Here Is Your Import"), only a confirmation and two next
        // actions.
        //
        // `opts.onUploadMore()` / `opts.onFinish()` let a caller (onboarding)
        // define what "more" and "done" do in its flow; the defaults below
        // (restart the import, or close) cover the ordinary import — an import
        // launched from Transactions ends on Transactions, with the new rows
        // already reloaded behind the modal.
        function showSuccessModal(opts, result) {
            // "Success!" goes in the standard header slot (styled large, no rule
            // beneath it), not the body — the body holds only the one-line
            // confirmation.
            const { body, dialog, close } = buildModal('Success!');
            dialog.classList.add('tx-import-dialog--success');
            body.innerHTML = `<p class="tx-import-success-sub">Your transactions have been added.</p>`;

            const footer = document.createElement('div');
            footer.className = 'tx-import-footer';
            footer.innerHTML = `
            <button type="button" class="button-secondary tx-import-more-btn">Start Another</button>
            <button type="button" class="button-primary tx-import-finish-btn">Finish</button>
        `;
            dialog.append(footer);

            footer.querySelector('.tx-import-more-btn').addEventListener('click', () => {
                close();
                if (opts.onUploadMore) opts.onUploadMore(result);
                // No account carried over: a second file may be for a different
                // account, so the question is repeated, pre-filled from the one
                // just used via the same last-used value as any other import.
                else run({ onCancel: opts.onCancel, onFinish: opts.onFinish });
            });
            footer.querySelector('.tx-import-finish-btn').addEventListener('click', () => {
                close();
                if (opts.onFinish) opts.onFinish(result);
            });
        }

        // ── Entry point ───────────────────────────────────────────────────────────
        // The account question comes FIRST, before the file dialog — asked once,
        // and not repeated later in the flow.
        //
        // opts.account     — { key, label }: already resolved by the caller
        //                    (onboarding asks it in its first step), so this goes
        //                    straight to the file dialog.
        // opts.onUploadMore — Step 4's "Start Another" button; receives the
        //                    backend's result object. Default: restart the import
        //                    flow (re-ask the account, then a new file).
        // opts.onFinish    — Step 4's "Finish" button; receives the result object.
        //                    Default: close the modal and nothing else.
        // opts.onCancel    — called if the user backs out at the account step or
        //                    the file dialog, so a wizard can stay on its step.
        async function run(opts = {}) {
            if (!opts.account) {
                const account = await askAccount();
                if (!account) { if (opts.onCancel) opts.onCancel(); return; }
                opts = { ...opts, account };
            }
            pickFile(opts);
        }

        // Opens the file dialog.
        function pickFile(opts) {
            const input   = document.createElement('input');
            input.type    = 'file';
            // Every format the dispatcher parses; content sniffing still handles
            // files whose extension does not match their content.
            input.accept  = '.csv,.tsv,.txt,.ofx,.qfx,.qif,.json,.xlsx,text/csv,application/json';
            input.style.display = 'none';
            document.body.append(input);

            // A cancelled file picker fires no 'change', so cancellation is
            // detected by the window regaining focus with no file chosen. Wizards
            // use this to distinguish a cancel from a pending dialog.
            const bail = (msg) => {
                if (msg) UI.toast(msg, { type: 'error' });
                if (opts.onCancel) opts.onCancel();
            };
            if (opts.onCancel) {
                window.addEventListener('focus', () => {
                    // One frame after focus returns, `files` is populated if the
                    // user picked something.
                    setTimeout(() => { if (input.isConnected && !input.files?.length) { input.remove(); opts.onCancel(); } }, 300);
                }, { once: true });
            }

            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) { bail(); return; }

                // Parsing a big file (xlsx inflate, format sniffing) runs right
                // here in the renderer and can block for a second-plus, so the
                // busy bar goes up first and gets a frame to paint.
                const busy = showBusyModal('Reading file…');
                await nextPaint();

                const buf = await file.arrayBuffer().catch(() => null);
                if (!buf || !buf.byteLength) { await busy.close(); bail('Could not read the file.'); return; }

                let table;
                try {
                    table = await parseFile(file.name, buf);
                } catch (err) {
                    await busy.close();
                    bail('Could not import this file: ' + err.message);
                    return;
                }
                await busy.close();
                if (!table.headers.length || !table.rows.length) {
                    bail('The file appears to be empty or has no data rows.');
                    return;
                }

                // Map Columns is shown for EVERY file — every format, every
                // detection outcome. The user confirms or changes which column
                // feeds which field; the mapping is never applied without being
                // shown. Known-schema formats (OFX/QIF) arrive pre-mapped, since
                // the parser defines those columns, so the step is a confirmation.
                // Their rows also start at 1, not 2, since they have no header row
                // to skip.
                const detected = table.fixed
                    ? { date: 0, description: 1, amount: 2, debit: null, credit: null, notes: 3, balance: null }
                    : detectColumns(table.headers, table.rows);
                openMapping(table, detected, table.fixed ? 1 : 2, opts);
            });

            input.click();
        }

        // Opens Map Columns; re-openable from "Go Back" with the mapping the
        // user had already chosen (`detected` doubles as "current selections"
        // whether it came from auto-detection, a fixed schema, or a previous
        // pass through here).
        function openMapping(table, detected, firstRowNum, opts) {
            showMappingModal(table.headers, table.rows, detected,
                (mapping) => proceed(table, mapping, firstRowNum, opts,
                    () => openMapping(table, mapping, firstRowNum, opts)));
        }

        // What Map Columns continues into: validate rows under the chosen
        // mapping, then run the dup-hash fetch and the dry-run categorization
        // preview together before opening the combined screen.
        async function proceed(table, mapping, firstRowNum, opts, goBack) {
            // Row validation + the dup-hash/dry-run fetches scale with file size.
            // Map Columns has just closed, so this bar appears immediately rather
            // than waiting out the anti-flash hold (see showBusyModal).
            const busy = showBusyModal('Preparing your import…', { instant: true });
            await nextPaint();

            const { parsed, errors } = applyMapping(table.rows, mapping, firstRowNum);
            if (!parsed.length) {
                await busy.close();
                const first = errors[0];
                const msg = `No rows could be read (${errors.length} error${errors.length > 1 ? 's' : ''})`
                    + (first ? ` — row ${first.row}: ${first.reason}` : '') + '.';
                UI.toast(msg, { type: 'error' });
                if (opts.onCancel) opts.onCancel();
                return;
            }

            // Reduce any per-row balances (+ an OFX ledger balance) to one
            // month-end reading per month — the Balance Sheet's computed layer.
            // Empty for files that carry no balance.
            const balanceReadings = deriveBalances(parsed, table.ledgerBalance);

            // Fetch existing fingerprints for dup detection, bounded to the date
            // range in the file, and the categorization preview, in parallel —
            // both are read-only and independent of each other.
            const minDate = parsed.reduce((min, r) => (r.date < min ? r.date : min), parsed[0].date);
            const [dupeSet, dryRun] = await Promise.all([
                fetchHashes(minDate),
                dryRunImport(parsed.map(toApiRow), opts.account.key),
            ]);

            // Removal and the preview build share one task, so the browser
            // paints the swap in a single frame — the row table (thousands of
            // rows of fingerprinting and markup) is built while the bar is still
            // the thing on screen, not during a gap after it.
            await busy.close();
            showImportModal(parsed, errors, dupeSet, balanceReadings, dryRun, opts, goBack);
        }

        // Shared with the onboarding flow, which asks the account question with the
        // same markup and wiring so both render identically.
        return { run, accountChoicesHtml, wireAccountChoices };
    })();

    window.TxFileImport = TxFileImport;
}());
