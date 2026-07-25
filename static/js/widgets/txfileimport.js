'use strict';

// ─── txfileimport.js ──────────────────────────────────────────────────────────
// Multi-format transaction import for the Transactions page — the UI half.
// All parsing (format sniffing, CSV/OFX/QIF/JSON/XLSX, date/amount
// normalisation, column detection, dup fingerprints) lives in txparse.js
// (window.TxParse, loaded before this file), which is pure and covered by
// the fixture-corpus regression suite in electron/backend/__tests__/
// txParse.test.js. This file owns everything with a DOM or network
// dependency: the file picker, the mapping/preview modals, the dup-hash
// fetch, and the commit POST.
//
// Flow:
//   1. Account      — "which account is this import for?", asked ONCE, up front,
//                     pre-filled from the account used last. Everything after
//                     this point knows the answer, so nothing asks again — not
//                     the preview, and not the month-end balances in the file,
//                     which follow the same account unasked
//   2. File picker  — format identified by magic bytes + content sniffing,
//                     so a misnamed file (OFX saved as .txt) still imports
//   3. Parse        — TxParse.parseFile → uniform {headers, rows, fixed}
//   4. Map columns  — auto-detect then confirm in a modal; skipped when the
//                     format's schema is fixed (OFX/QIF define their fields)
//   5. Preview      — show all parsed rows; flag likely duplicates; user
//                     checks/unchecks before committing
//   6. Commit       — POST confirmed rows to /api/transactions/import
//   7. Results      — "here's what we found": the digest of what landed where
//   8. Reload       — fire 'transactions:reload' so the ledger refreshes
//
// First-run onboarding (widgets/onboarding.js) runs this same machinery, asking
// step 1 as part of its own opening screen and taking over step 7.
//
// Steps 2 and 5 can block for a second-plus on large files, so each wait
// shows an indeterminate progress bar (export's progress styles); the
// standalone busy modals reveal only after ~150ms so small files never
// flash one.
//
// All parsing is client-side. The server only receives clean row objects.
// On import the server auto-categorizes confident rows on-device (learned
// per-user rules first, then the built-in merchant lexicon); the count comes
// back as `auto_categorized`. Anything left blank the user categorises inline.

(function () {
    const TxFileImport = (() => {

        // ── HTML safety ──────────────────────────────────────────────────────────
        // Alias of the shared global in escape.js (loaded by base.html).
        const esc = escapeHtml;

        // The pure parsing core (txparse.js) — see the header comment.
        const { parseFile, detectColumns, applyMapping, deriveBalances, fingerprint } = TxParse;

        // ── API ───────────────────────────────────────────────────────────────────
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

        // The accounts this import can land in. `include_hidden` is what makes
        // the pre-named starter accounts ("Checking", "Credit Card") offerable
        // before the user has adopted any — they are choices here and nowhere
        // else, and the one that receives the import becomes real (the server
        // adopts it; see services/accounts.js).
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

        // The account used by the last import, which is what pre-fills the account
        // question next time. It is the only account memory kept, and deliberately
        // so: the question is now asked BEFORE the file dialog, so nothing about the
        // file — its header shape, its name, an embedded account number — is known
        // yet, and none of it would be evidence anyway. An account is a bucket the
        // USER defines; someone who changes banks mid-year still has one logical
        // "Checking", so recent behaviour predicts their answer and the file cannot.
        //
        // For the routine case (importing the same account each month) this makes
        // the step a single Continue. When it's wrong, the choice is one click, and
        // it's a visible question rather than a silent assumption.
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

            // Same closable guard as txexport.js's buildModal: the dialog can't
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
        // row-level progress to report, so they show the export modal's progress
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

        // Standalone busy modal for the parse phase. The overlay holds invisible
        // for ~150ms before fading in (.tx-import-overlay--busy), so small files
        // that parse instantly never flash a modal.
        function showBusyModal(label) {
            const modal = buildModal('Import Transactions');
            modal.overlay.classList.add('tx-import-overlay--busy');
            modal.dialog.classList.add('tx-import-dialog--busy');
            modal.setClosable(false);
            modal.body.append(progressBar(label));
            return { close: () => { modal.setClosable(true); modal.close(); } };
        }

        // Two frames: the busy bar must be painted (and compositor-animated)
        // before synchronous parse work blocks the renderer.
        const nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // ── Step 1: Mapping modal ─────────────────────────────────────────────────
        function showMappingModal(headers, rows, detected, onContinue) {
            const { body, close } = buildModal('Map Columns');

            // Live selection state, seeded from detectColumns' guesses and
            // harvested from the selects before every re-render, so switching
            // amount modes never loses what the user already picked.
            const current = { ...detected };
            // Split mode: money out / money in as two separate columns
            // (Debit/Credit, Withdrawal/Deposit) instead of one signed Amount
            // — direction then comes from the column, not the sign (banks list
            // positive magnitudes in both). Auto-detected from the headers; the
            // link under the form switches either way when the guess is wrong.
            let split = detected.debit !== null && detected.credit !== null;

            // Preview of first 3 raw rows so the user can visually verify the mapping.
            const previewHtml = `
            <p class="tx-import-hint">Match the columns in your file to the transaction fields below.</p>
            <div class="tx-import-section-label">File preview (first 3 rows)</div>
            <div class="tx-import-preview-wrap">
                <table class="tx-import-preview-table">
                    <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
                    <tbody>
                        ${rows.slice(0, 3).map(r =>
                            `<tr>${headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`
                        ).join('')}
                    </tbody>
                </table>
            </div>
        `;

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

            function render() {
                const amountRows = split
                    ? mapSelect('Money out (Debit)',  'debit',  false)
                      + mapSelect('Money in (Credit)', 'credit', false)
                    : mapSelect('Amount *', 'amount', true);
                const modeLabel = split
                    ? 'My file has one signed Amount column'
                    : 'My file has separate Debit / Credit columns';

                body.innerHTML = previewHtml + `
                <div class="tx-import-section-label">Column mapping</div>
                <div class="tx-import-map-form">
                    ${mapSelect('Date *',        'date',        true)}
                    ${mapSelect('Description *', 'description', true)}
                    ${amountRows}
                    ${mapSelect('Notes',         'notes',       false)}
                    ${mapSelect('Balance',       'balance',     false)}
                </div>
                <button type="button" class="tx-import-map-mode">${modeLabel}</button>
                <div class="tx-import-footer">
                    <span class="tx-import-row-count">${rows.length} row${rows.length !== 1 ? 's' : ''} in file</span>
                    <button class="button-primary tx-import-continue-btn">Continue →</button>
                </div>
            `;

                body.querySelector('.tx-import-map-mode').addEventListener('click', () => {
                    harvest();
                    split = !split;
                    render();
                });

                body.querySelector('.tx-import-continue-btn').addEventListener('click', () => {
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
            }

            render();
        }

        // The kinds of account a user can add, in presentation order — most-imported
        // first, independent of Balance Sheet position (which groups by col_type). A
        // card export is the messiest, most commonly imported statement there is.
        //
        // `kind` matches the key of the seeded starter row this takes over for the
        // first account of its kind (seed.js DEFAULT_BALANCE_COLUMNS); `type` is the
        // col_type a fresh column gets otherwise. These labels/hints are STATIC and
        // never read from the database, so a starter row renamed to the user's own
        // name ("Chase Checking") doesn't turn this list of kinds into a list of
        // their accounts. Between them the six kinds cover all four col_types, so
        // there is no need to make the user pick a type by hand.
        //
        // The placeholders teach the point of the question — that these are THEIR
        // names for THEIR accounts — with generic examples rather than real brands.
        const ACCOUNT_KINDS = [
            { kind: 'checking',    label: 'Checking',    type: 'cash',       group: 'Cash',       hint: 'Everyday spending account',      placeholder: 'e.g. Joint Checking' },
            { kind: 'credit_card', label: 'Credit Card', type: 'debt',       group: 'Debt',       hint: 'A card you pay off',             placeholder: 'e.g. Everyday Card' },
            { kind: 'savings',     label: 'Savings',     type: 'cash',       group: 'Cash',       hint: 'Money set aside',                placeholder: 'e.g. Emergency Fund' },
            { kind: 'investments', label: 'Investments', type: 'investment', group: 'Investment', hint: 'Brokerage or taxable investing', placeholder: 'e.g. Brokerage' },
            { kind: 'retirement',  label: 'Retirement',  type: 'retirement', group: 'Retirement', hint: '401(k), IRA, pension',           placeholder: 'e.g. Work 401(k)' },
            { kind: 'debt',        label: 'Loan',        type: 'debt',       group: 'Debt',       hint: 'Loan, mortgage, line of credit', placeholder: 'e.g. Car Loan' },
        ];

        // ── The account question ──────────────────────────────────────────────────
        // Asked ONCE, up front, and never again: every import is tagged with the
        // account it came from (that association scopes dedup, powers per-account
        // spend, and tells a month-end balance in the file which column it belongs
        // to). Because the answer is settled before any rows are on screen, nothing
        // downstream has to ask a second time.
        //
        // Shared by first-run onboarding and ordinary imports, so the question looks
        // and behaves identically in both. Two sections:
        //
        //   Your accounts  — the accounts the user already has, under THEIR OWN
        //                    names. Absent entirely until there is one.
        //   Add a new one  — the KINDS of account (below), each of which the user
        //                    names on the spot.
        //
        // Naming is part of creating, never skipped: an account is the one piece of
        // this app that is pure user identity, and a ledger of "Checking" and
        // "Savings" is the generic, someone-else's-spreadsheet feeling this whole
        // flow exists to avoid. "Chase Checking" and "Amex Gold" are what the user
        // actually calls them, and only they can say it.
        //
        // `preselect` is the caller's best guess from the user's own HISTORY (never
        // from the file — an account is a bucket the user defines, and a bank's name
        // says nothing about which bucket they meant). It only ever preselects an
        // EXISTING account; a new one always needs the name typed, so it can never
        // be created by an accidental click-through.
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

        // Wire the markup above. `onValidityChange(ok)` fires whenever the answer
        // becomes usable or stops being usable, so the caller can enable/disable its
        // own primary button — a new account is not usable until it has a name.
        //
        // resolve() yields { key, label }. For a new account it prefers to take over
        // the matching unadopted STARTER row (renaming it to what the user typed):
        // that keeps the stable seeded key for the common "first account of this
        // kind" case and stops unused starter rows accumulating. A second account of
        // the same kind — two checking accounts is perfectly normal — gets a fresh
        // column. Either way the row only becomes VISIBLE when the import lands in
        // it (the server adopts it), so backing out here still leaves nothing behind.
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
        // The default comes from the user's own history — the account this file
        // shape went to last, else the one they used last, else their only account.
        // For the routine monthly statement that makes this step a single Continue;
        // for a first import, or a shape that has never been seen, it is a real
        // question with no pre-filled answer.
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
                    <p class="tx-import-hint">Which account is this import for? Transactions are filed
                        under the account they came from, so Aventurine can tell your accounts apart
                        and keep your Balance Sheet in step.</p>
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

        // The preview's account line. By this point the account is always settled,
        // so this states where the rows are going — it never asks again.
        function buildAccountLine(account) {
            const el = document.createElement('div');
            el.className = 'tx-import-balance-bar';
            el.innerHTML = `
                <div class="tx-import-account-row">
                    <span class="tx-import-account-label">Importing into</span>
                    <span class="tx-import-account-fixed">${esc(account.label || account.key)}</span>
                </div>`;
            return el;
        }

        // ── The import-results moment ─────────────────────────────────────────────
        // "Here's what we found. Does this look right?" — the payoff screen of an
        // import, and the only place the categorizer's work is visible. It reads
        // back the user's OWN merchants sorted into their OWN categories, because
        // a row count proves nothing about whether the import was understood.
        //
        // `result.found` is the digest the server returns (handlers/transactions
        // summariseImport): period, totals by direction, categories hit, and the
        // count it deliberately left blank. Uncategorized rows are stated plainly
        // rather than hidden — abstention is the designed behaviour, and naming it
        // sets the expectation that the ledger is where those get filled in.
        //
        // `actions` lets a caller own what happens next (onboarding offers "add
        // another account"); the default is a single dismissal.
        function renderFound(found, accountLabel) {
            const CURRENCY = (typeof CURRENCY_SYMBOL !== 'undefined') ? CURRENCY_SYMBOL : '$';
            const money = (n) => CURRENCY + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            if (!found) return '';

            const period = (found.date_from && found.date_to)
                ? (found.date_from === found.date_to
                    ? found.date_from
                    : `${found.date_from} → ${found.date_to}`)
                : '';

            const totals = [
                found.income ? { label: 'Income', value: found.income, cls: 'is-income' } : null,
                found.expense ? { label: 'Spending', value: found.expense, cls: 'is-expense' } : null,
                found.transfer ? { label: 'Transfers', value: found.transfer, cls: 'is-transfer' } : null,
            ].filter(Boolean);

            // Bars are scaled WITHIN each direction, not across all of them: one
            // paycheck usually dwarfs every expense, and a shared scale would
            // flatten the whole spending breakdown into stubs — precisely the
            // comparison the user is here to check. Per-direction, "where did my
            // spending go" stays legible and income still reads as the largest
            // thing on the screen.
            const maxOf = {};
            for (const c of found.categories) {
                maxOf[c.cat_type] = Math.max(maxOf[c.cat_type] || 0, c.total);
            }
            const rows = found.categories.map(c => {
                const pct = Math.max(2, Math.round((c.total / (maxOf[c.cat_type] || 1)) * 100));
                return `
                <div class="tx-found-cat is-${esc(c.cat_type)}">
                    <span class="tx-found-cat-name">${esc(c.name)}</span>
                    <span class="tx-found-cat-bar"><i style="width:${pct}%"></i></span>
                    <span class="tx-found-cat-count">${c.count}</span>
                    <span class="tx-found-cat-total">${esc(money(c.total))}</span>
                </div>`;
            }).join('');

            return `
                <div class="tx-found">
                    <div class="tx-found-head">
                        ${accountLabel ? `<span class="tx-found-account">${esc(accountLabel)}</span>` : ''}
                        ${period ? `<span class="tx-found-period">${esc(period)}</span>` : ''}
                    </div>
                    ${totals.length ? `<div class="tx-found-totals">${totals.map(tt => `
                        <div class="tx-found-total ${tt.cls}">
                            <span class="tx-found-total-label">${tt.label}</span>
                            <span class="tx-found-total-value">${esc(money(tt.value))}</span>
                        </div>`).join('')}</div>` : ''}
                    ${rows ? `<div class="tx-found-cats">
                        <div class="tx-import-section-label">Where it landed</div>
                        ${rows}
                    </div>` : ''}
                    ${found.uncategorized ? `<div class="tx-found-note">
                        ${found.uncategorized} transaction${found.uncategorized !== 1 ? 's' : ''}
                        ${found.uncategorized !== 1 ? 'were' : 'was'} left uncategorized — Aventurine
                        only fills in what it's sure of. Set ${found.uncategorized !== 1 ? 'them' : 'it'}
                        once in your ledger and it'll remember next time.
                    </div>` : ''}
                </div>`;
        }

        // Show the results screen. `actions` is [{ label, primary, onClick }];
        // onClick receives a close() it can call to dismiss. Returns nothing —
        // the modal owns its own lifetime from here.
        function showResultsModal(result, { accountLabel = '', title = 'Import complete', actions = null } = {}) {
            const { body, dialog, close } = buildModal(title);
            dialog.classList.add('tx-import-dialog--results');

            const n = result.inserted;
            const headline = `${n} transaction${n !== 1 ? 's' : ''} imported`;
            const asides = [
                result.balances_applied
                    ? `${result.balances_applied} month-end balance${result.balances_applied !== 1 ? 's' : ''} added to your Balance Sheet`
                    : '',
                result.skipped?.length ? `${result.skipped.length} row${result.skipped.length !== 1 ? 's' : ''} skipped` : '',
            ].filter(Boolean);

            body.innerHTML = `
                <div class="tx-found-headline">${esc(headline)}</div>
                ${asides.length ? `<div class="tx-found-asides">${esc(asides.join(' · '))}</div>` : ''}
                ${renderFound(result.found, accountLabel)}
            `;

            const footer = document.createElement('div');
            footer.className = 'tx-import-footer';
            const list = actions && actions.length ? actions : [{ label: 'Done', primary: true }];
            footer.innerHTML = `<span class="tx-import-row-count"></span>`;
            for (const a of list) {
                const btn = document.createElement('button');
                btn.className = a.primary ? 'button-primary' : 'button-secondary';
                btn.type = 'button';
                btn.textContent = a.label;
                btn.addEventListener('click', () => {
                    if (a.onClick) a.onClick(close);
                    else close();
                });
                footer.append(btn);
            }
            dialog.append(footer);
        }

        // ── Step 2: Preview modal ─────────────────────────────────────────────────
        // `opts.account` — { key, label }, always set: every path settles the
        // account before the file dialog opens (askAccount, or onboarding's own
        // picker). `opts.onImported` takes over the results moment.
        function showPreviewModal(parsed, errors, dupeSet, balanceReadings = [], opts = {}) {
            const { body, close, setClosable } = buildModal('Review Import');

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

            // Footer lives outside body so it stays visible while the table scrolls.
            const footer = document.createElement('div');
            footer.className = 'tx-import-footer tx-import-footer--preview';
            footer.innerHTML = `
            <span class="tx-import-row-count"></span>
            <button class="button-primary tx-import-do-btn" disabled>Import</button>
        `;

            const dialog = body.closest('.tx-import-dialog');
            // Widen the shell for the full row table so every column fits without
            // a horizontal scroll; the column-mapping step keeps the narrow width.
            dialog.classList.add('tx-import-dialog--preview');
            dialog.append(footer);

            // Where the rows are going, stated plainly. Lives outside the
            // scrolling body, above the footer, so it survives renderTable's
            // innerHTML rewrites and stays visible while the list scrolls.
            const account = opts.account;
            const accountLine = buildAccountLine(account);
            dialog.insertBefore(accountLine, footer);

            function updateFooter() {
                const n = checked.size;
                footer.querySelector('.tx-import-row-count').textContent = `${n} of ${rows.length} selected`;
                const btn = footer.querySelector('.tx-import-do-btn');
                btn.textContent = `Import ${n} row${n !== 1 ? 's' : ''}`;
                btn.disabled    = n === 0;
            }

            function renderTable() {
                const allChecked = rows.length > 0 && rows.every(r => checked.has(r._idx));
                body.innerHTML = errBanner + `
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
                    updateFooter();
                });

                body.querySelectorAll('.tx-import-row-check').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const idx = parseInt(e.target.dataset.idx, 10);
                        e.target.checked ? checked.add(idx) : checked.delete(idx);
                        // Update check-all state without re-rendering the whole table.
                        body.querySelector('.tx-import-check-all').checked =
                            rows.every(r => checked.has(r._idx));
                        updateFooter();
                    });
                });
            }

            renderTable();
            updateFooter();

            footer.querySelector('.tx-import-do-btn').addEventListener('click', async () => {
                const toSend = rows
                    .filter(r => checked.has(r._idx))
                    .map(({ date, description, tx_type, amount, notes }) => ({ date, description, tx_type, amount, notes }));

                rememberAccount(account.key);

                // Month-end balances the file carried go to the same account,
                // unasked. Once the account is settled there is nothing left to
                // decide — "should this balance go in Checking?" has one answer —
                // and the readings land as ordinary, hand-editable Balance Sheet
                // cells, so the user can change or clear any of them afterwards.
                const balances = balanceReadings.map(b => ({
                    account_key: account.key, date: b.date, value: b.value, source: b.source,
                }));

                // Swap the table for an indeterminate bar while the commit POST
                // writes to the database — the wait reads as work, not a hang.
                const tableView = [...body.children];
                body.replaceChildren(progressBar(`Importing ${toSend.length} transaction${toSend.length !== 1 ? 's' : ''}…`));
                footer.style.display = 'none';
                accountLine.style.display = 'none';
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
                    // The caller owns the results moment when it has more to say
                    // (onboarding offers the next account); otherwise show the
                    // shared "here's what we found" screen.
                    if (opts.onImported) opts.onImported(result);
                    else showResultsModal(result, { accountLabel: account.label });
                } catch (err) {
                    // Put the preview back so the user can retry or deselect rows.
                    body.replaceChildren(...tableView);
                    footer.style.display = '';
                    accountLine.style.display = '';
                    setClosable(true);
                    UI.toast('Import failed: ' + err.message, { type: 'error' });
                }
            });
        }

        // ── Entry point ───────────────────────────────────────────────────────────
        // The account question comes FIRST, before the file dialog — one question,
        // asked once, never repeated later in the flow.
        //
        // opts.account   — { key, label }: already settled by the caller
        //                  (onboarding asks it as part of its own first step), so
        //                  this skips straight to the file dialog.
        // opts.onImported — takes over the results moment; receives the server's
        //                  result object (including the `found` digest).
        // opts.onCancel  — called if the user backs out at the account step or the
        //                  file dialog, so a wizard can stay on its own step.
        async function run(opts = {}) {
            if (!opts.account) {
                const account = await askAccount();
                if (!account) { if (opts.onCancel) opts.onCancel(); return; }
                opts = { ...opts, account };
            }
            const input   = document.createElement('input');
            input.type    = 'file';
            // Every format the dispatcher understands; sniffing still rescues
            // files whose extension doesn't match their content.
            input.accept  = '.csv,.tsv,.txt,.ofx,.qfx,.qif,.json,.xlsx,text/csv,application/json';
            input.style.display = 'none';
            document.body.append(input);

            // A cancelled file picker fires no 'change', so the cancel signal
            // rides on the window regaining focus with nothing chosen. Wizards
            // need it to know the user backed out rather than left them hanging.
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
                if (!buf || !buf.byteLength) { busy.close(); bail('Could not read the file.'); return; }

                let table;
                try {
                    table = await parseFile(file.name, buf);
                } catch (err) {
                    busy.close();
                    bail('Could not import this file: ' + err.message);
                    return;
                }
                busy.close();
                if (!table.headers.length || !table.rows.length) {
                    bail('The file appears to be empty or has no data rows.');
                    return;
                }

                // Shared continuation for both paths: validate rows, fetch
                // duplicate fingerprints, open the preview.
                const proceed = async (mapping, firstRowNum) => {
                    // Row validation + the dup-hash fetch scale with file size;
                    // same delayed-reveal bar as the parse phase.
                    const busy = showBusyModal('Preparing preview…');
                    await nextPaint();

                    const { parsed, errors } = applyMapping(table.rows, mapping, firstRowNum);
                    if (!parsed.length) {
                        busy.close();
                        const first = errors[0];
                        bail(`No rows could be read (${errors.length} error${errors.length > 1 ? 's' : ''})`
                            + (first ? ` — row ${first.row}: ${first.reason}` : '') + '.');
                        return;
                    }

                    // Reduce any per-row balances (+ an OFX ledger balance) to
                    // one month-end reading per month — the Balance Sheet's
                    // computed layer. Empty for files that carry no balance.
                    const balanceReadings = deriveBalances(parsed, table.ledgerBalance);

                    // Fetch existing fingerprints for dup detection, bounded to the
                    // date range in the file so we don't scan the full history.
                    const minDate = parsed.reduce((min, r) => (r.date < min ? r.date : min), parsed[0].date);
                    const dupeSet = await fetchHashes(minDate);

                    busy.close();
                    showPreviewModal(parsed, errors, dupeSet, balanceReadings, opts);
                };

                if (table.fixed) {
                    // Known-schema formats (OFX/QIF): the parser already emitted
                    // [Date, Description, Amount, Notes], so mapping is identity
                    // and the modal would be a pointless extra click.
                    proceed({ date: 0, description: 1, amount: 2, notes: 3 }, 1);
                } else {
                    const detected = detectColumns(table.headers, table.rows);
                    showMappingModal(table.headers, table.rows, detected,
                        (mapping) => proceed(mapping, 2));
                }
            });

            input.click();
        }

        // Shared with the onboarding flow: it renders the same "here's what we
        // found" digest with its own next-step buttons, and asks the account
        // question with the same markup and wiring so both read identically.
        return { run, showResultsModal, renderFound, accountChoicesHtml, wireAccountChoices };
    })();

    window.TxFileImport = TxFileImport;
}());
