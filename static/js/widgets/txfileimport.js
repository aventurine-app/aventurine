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
//   1. File picker  — format identified by magic bytes + content sniffing,
//                     so a misnamed file (OFX saved as .txt) still imports
//   2. Parse        — TxParse.parseFile → uniform {headers, rows, fixed}
//   3. Map columns  — auto-detect then confirm in a modal; skipped when the
//                     format's schema is fixed (OFX/QIF define their fields)
//   4. Preview      — show all parsed rows; flag likely duplicates; user
//                     checks/unchecks before committing
//   5. Commit       — POST confirmed rows to /api/transactions/import
//   6. Reload       — fire 'transactions:reload' so the ledger refreshes
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
        const { parseFile, detectColumns, applyMapping, fingerprint } = TxParse;

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

        async function commitRows(rows) {
            const r = await apiFetch('/api/transactions/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'import failed');
            return data; // { ok, inserted, skipped }
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
                            notes: current.notes,
                        };
                    } else {
                        if (current.amount === null) { alert('Please select the Amount column.'); return; }
                        mapping = {
                            date: current.date, description: current.description,
                            amount: current.amount, debit: null, credit: null,
                            notes: current.notes,
                        };
                    }
                    close();
                    onContinue(mapping);
                });
            }

            render();
        }

        // ── Step 2: Preview modal ─────────────────────────────────────────────────
        function showPreviewModal(parsed, errors, dupeSet) {
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

            body.closest('.tx-import-dialog').append(footer);

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
                                    <td>${esc(r.description)}${r._dup ? ' <span class="tx-import-dup-badge">duplicate</span>' : ''}</td>
                                    <td class="tx-import-col-amount">${esc(fmtAmt(r.amount))}</td>
                                    <td>${esc(r.notes)}</td>
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

                // Swap the table for an indeterminate bar while the commit POST
                // writes to the database — the wait reads as work, not a hang.
                const tableView = [...body.children];
                body.replaceChildren(progressBar(`Importing ${toSend.length} transaction${toSend.length !== 1 ? 's' : ''}…`));
                footer.style.display = 'none';
                setClosable(false);

                try {
                    const result = await commitRows(toSend);
                    setClosable(true);
                    close();
                    const msg = `Imported ${result.inserted} transaction${result.inserted !== 1 ? 's' : ''}.`
                        + (result.auto_categorized ? ` ${result.auto_categorized} categorized automatically.` : '')
                        + (result.skipped?.length ? ` ${result.skipped.length} skipped.` : '');
                    alert(msg);
                    // Imported rows change the computed Cash Flow cells the
                    // dashboards render from the shared Store cache — drop it
                    // so they refetch instead of showing stale data.
                    if (window.Store) window.Store.invalidate('ie');
                    window.dispatchEvent(new Event('transactions:reload'));
                } catch (err) {
                    // Put the preview back so the user can retry or deselect rows.
                    body.replaceChildren(...tableView);
                    footer.style.display = '';
                    setClosable(true);
                    alert('Import failed: ' + err.message);
                }
            });
        }

        // ── Entry point ───────────────────────────────────────────────────────────
        async function run() {
            const input   = document.createElement('input');
            input.type    = 'file';
            // Every format the dispatcher understands; sniffing still rescues
            // files whose extension doesn't match their content.
            input.accept  = '.csv,.tsv,.txt,.ofx,.qfx,.qif,.json,.xlsx,text/csv,application/json';
            input.style.display = 'none';
            document.body.append(input);

            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) return;

                // Parsing a big file (xlsx inflate, format sniffing) runs right
                // here in the renderer and can block for a second-plus, so the
                // busy bar goes up first and gets a frame to paint.
                const busy = showBusyModal('Reading file…');
                await nextPaint();

                const buf = await file.arrayBuffer().catch(() => null);
                if (!buf || !buf.byteLength) { busy.close(); alert('Could not read the file.'); return; }

                let table;
                try {
                    table = await parseFile(file.name, buf);
                } catch (err) {
                    busy.close();
                    alert('Could not import this file: ' + err.message);
                    return;
                }
                busy.close();
                if (!table.headers.length || !table.rows.length) {
                    alert('The file appears to be empty or has no data rows.');
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
                        const sample = errors.slice(0, 3).map(e => `  Row ${e.row}: ${e.reason}`).join('\n');
                        alert(`No valid rows could be parsed (${errors.length} error${errors.length > 1 ? 's' : ''}).\n\nFirst errors:\n${sample}`);
                        return;
                    }

                    // Fetch existing fingerprints for dup detection, bounded to the
                    // date range in the file so we don't scan the full history.
                    const minDate = parsed.reduce((min, r) => (r.date < min ? r.date : min), parsed[0].date);
                    const dupeSet = await fetchHashes(minDate);

                    busy.close();
                    showPreviewModal(parsed, errors, dupeSet);
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

        return { run };
    })();

    window.TxFileImport = TxFileImport;
}());
