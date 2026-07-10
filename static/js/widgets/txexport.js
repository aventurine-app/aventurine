'use strict';

// ─── txexport.js ──────────────────────────────────────────────────────────────
// Export-all-transactions modal for the Transactions page — the counterpart
// of txfileimport.js, kept in its own file for the same reason.
//
// The renderer never touches the filesystem: serialisation and writes live in
// the backend (electron/backend/services/txExport.js behind
// POST /api/transactions/export). This file owns the modal UI and drives the
// chunked export loop — one POST per chunk of rows, each appending to
// <path>.part until the final call renames it into place — so the progress
// bar tracks rows actually written, not an animation.
//
// Flow:
//   1. Pick a format (CSV / OFX / QFX / QIF) and a destination. Browse…
//      opens the native save dialog under Electron; in a plain browser
//      (fixture mode) the button is hidden and the path is typed.
//   2. Export — the chunk loop, with a determinate progress bar.
//   3. Done — row count + where the file landed.

(function () {
    const TxFileExport = (() => {

        // Alias of the shared global in escape.js (loaded by base.html).
        const esc = escapeHtml;

        const FORMATS = [
            { id: 'csv', label: 'CSV', desc: 'Comma-separated values — opens in Excel, Sheets, and most tools.' },
            { id: 'ofx', label: 'OFX', desc: 'Open Financial Exchange — accepted by most finance apps.' },
            { id: 'qfx', label: 'QFX', desc: 'Quicken Web Connect — OFX flavoured for Quicken.' },
            { id: 'qif', label: 'QIF', desc: 'Quicken Interchange Format — for older finance software.' },
        ];
        const EXT_RX = /\.(csv|ofx|qfx|qif)$/i;

        function todayIso() {
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }

        // ── Modal shell ───────────────────────────────────────────────────────────
        // Same structure and CSS classes as txfileimport.js's buildModal, plus a
        // guard so the dialog can't be dismissed while a file write is in flight.
        function buildModal(title) {
            const overlay = document.createElement('div');
            overlay.className = 'tx-import-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'tx-import-dialog tx-export-dialog';

            const header = document.createElement('div');
            header.className = 'tx-import-dialog-header';
            header.innerHTML = `
            <span class="tx-import-dialog-title">${esc(title)}</span>
            <button class="tx-import-close" title="Close">&times;</button>
        `;

            const body = document.createElement('div');
            body.className = 'tx-import-dialog-body';

            const footer = document.createElement('div');
            footer.className = 'tx-import-footer';

            dialog.append(header, body, footer);
            overlay.append(dialog);
            document.body.append(overlay);

            let closable = true;
            const close = () => { if (closable) overlay.remove(); };
            header.querySelector('.tx-import-close').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

            return {
                overlay, body, footer, close,
                setClosable(v) {
                    closable = v;
                    header.querySelector('.tx-import-close').disabled = !v;
                },
            };
        }

        // ── Export modal ──────────────────────────────────────────────────────────
        // `filters` is the export endpoint's `filters` body field (built by
        // transactions.js from the search bar), or null/absent to export the
        // whole ledger; `count` is how many rows those filters leave visible —
        // display only, the backend re-applies the criteria itself.
        function run({ filters = null, count = null } = {}) {
            const modal = buildModal('Export Transactions');
            const fileApi = window.electronFile || null;

            const formatCards = FORMATS.map((f, i) => `
            <label class="tx-export-format">
                <input type="radio" name="tx-export-format" value="${f.id}"${i === 0 ? ' checked' : ''}>
                <span class="tx-export-format-text">
                    <span class="tx-export-format-name">${esc(f.label)}</span>
                    <span class="tx-export-format-desc">${esc(f.desc)}</span>
                </span>
            </label>
        `).join('');

            const hint = filters
                ? (typeof count === 'number'
                    ? `Save the ${count.toLocaleString()} transaction${count === 1 ? '' : 's'} matching your search to a file.`
                    : 'Save the transactions matching your search to a file.')
                : 'Save every transaction in the current database to a file.';

            modal.body.innerHTML = `
            <p class="tx-import-hint">${esc(hint)}</p>
            <div class="tx-import-section-label">Format</div>
            <div class="tx-export-formats" role="radiogroup">${formatCards}</div>
            <div class="tx-import-section-label">Save to</div>
            <div class="tx-export-path-row">
                <input type="text" class="tx-input tx-export-path"
                       placeholder="e.g. ~/Documents/transactions-${esc(todayIso())}.csv"
                       spellcheck="false" autocomplete="off">
                <button type="button" class="db-btn tx-export-browse">Browse…</button>
            </div>
            <p class="tx-export-error" hidden></p>
        `;
            modal.footer.innerHTML = `
            <span class="tx-import-row-count"></span>
            <button class="button-primary tx-export-do-btn">Export</button>
        `;

            const pathInput = modal.body.querySelector('.tx-export-path');
            const browseBtn = modal.body.querySelector('.tx-export-browse');
            const errorEl   = modal.body.querySelector('.tx-export-error');
            const exportBtn = modal.footer.querySelector('.tx-export-do-btn');

            const format = () =>
                modal.body.querySelector('input[name="tx-export-format"]:checked')?.value || 'csv';

            // The native save dialog already confirms replacing an existing file;
            // a hand-typed path has not been confirmed, so the backend's 409 will
            // be surfaced as a confirm() instead.
            let overwriteConfirmed = false;

            function showError(msg) {
                errorEl.textContent = msg;
                errorEl.hidden = false;
            }

            // Keep the path's extension in step with the chosen format.
            modal.body.querySelectorAll('input[name="tx-export-format"]').forEach((radio) => {
                radio.addEventListener('change', () => {
                    pathInput.placeholder = `e.g. ~/Documents/transactions-${todayIso()}.${format()}`;
                    const p = pathInput.value.trim();
                    if (p && EXT_RX.test(p)) pathInput.value = p.replace(EXT_RX, '.' + format());
                });
            });

            pathInput.addEventListener('input', () => { overwriteConfirmed = false; });

            if (fileApi) {
                browseBtn.addEventListener('click', async () => {
                    const p = await fileApi.chooseExportPath(format());
                    if (p) {
                        pathInput.value = p;
                        overwriteConfirmed = true;
                        errorEl.hidden = true;
                    }
                });
            } else {
                // Plain browser: no native dialog and no real filesystem to pick
                // from — the path is typed (legacy/dev HTTP mode writes it
                // server-side; fixture mode accepts-and-ignores).
                browseBtn.hidden = true;
            }

            exportBtn.addEventListener('click', () => {
                let p = pathInput.value.trim();
                if (!p) { showError('Choose where to save the export.'); return; }
                // Bare folder-and-name paths get the format's extension appended.
                if (!EXT_RX.test(p)) p += '.' + format();
                errorEl.hidden = true;
                startExport(modal, p, format(), overwriteConfirmed, filters)
                    .catch((err) => {
                        modal.setClosable(true);
                        showError('Export failed: ' + err.message);
                    });
            });
        }

        // ── Chunk loop + progress bar ─────────────────────────────────────────────
        async function startExport(modal, path, format, overwrite, filters) {
            const formView = [...modal.body.children];   // restored on overwrite-decline
            const progress = document.createElement('div');
            progress.className = 'tx-export-progress';
            progress.innerHTML = `
            <div class="tx-export-progress-label">Exporting transactions…</div>
            <div class="tx-export-progress-track"><div class="tx-export-progress-fill"></div></div>
            <div class="tx-export-progress-count">Starting…</div>
        `;
            const fill  = progress.querySelector('.tx-export-progress-fill');
            const count = progress.querySelector('.tx-export-progress-count');
            const label = progress.querySelector('.tx-export-progress-label');

            const showForm = () => {
                progress.remove();
                modal.body.append(...formView);
                modal.footer.querySelector('.tx-export-do-btn').hidden = false;
                modal.setClosable(true);
            };

            modal.body.replaceChildren(progress);
            modal.footer.querySelector('.tx-export-do-btn').hidden = true;
            modal.setClosable(false);

            let offset = 0;
            let result = {};
            try {
                for (;;) {
                    const r = await apiFetch('/api/transactions/export', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // The chunk protocol is stateless, so the filters ride
                        // along on every call, same as the offset.
                        body:    JSON.stringify(
                            filters ? { path, format, offset, overwrite, filters }
                                    : { path, format, offset, overwrite }
                        ),
                    });
                    const data = await r.json().catch(() => ({}));

                    if (r.status === 409 && offset === 0 && !overwrite) {
                        modal.setClosable(true);
                        if (confirm('A file already exists at that location.\nReplace it?')) {
                            modal.setClosable(false);
                            overwrite = true;
                            continue;
                        }
                        showForm();
                        return;
                    }
                    if (!r.ok) throw new Error(data.error || 'export failed');

                    if (typeof data.exported === 'number' && typeof data.total === 'number') {
                        const pct = data.total > 0 ? Math.round((data.exported / data.total) * 100) : 100;
                        fill.style.width = pct + '%';
                        count.textContent = `${data.exported.toLocaleString()} of ${data.total.toLocaleString()} transactions`;
                    }
                    result = data;
                    // `done === false` (not merely falsy) keeps going — fixture
                    // mode's bare {ok:true} must terminate the loop.
                    if (data.done === false) { offset = data.exported; continue; }
                    break;
                }
            } catch (err) {
                // Put the form back so the caller's error message has somewhere
                // visible to land, then let run()'s catch render it.
                showForm();
                throw err;
            }

            modal.setClosable(true);
            fill.style.width = '100%';
            label.textContent = 'Export complete';
            const n = typeof result.exported === 'number' ? result.exported.toLocaleString() : '';
            count.innerHTML = `
            ${n ? esc(n) + ` transaction${result.exported !== 1 ? 's' : ''} saved to` : 'Saved to'}
            <span class="tx-export-progress-path">${esc(result.path || path)}</span>
        `;
            // Swap in a fresh button: the original still carries the "start
            // export" click handler, which must not fire again from "Done".
            const oldBtn = modal.footer.querySelector('.tx-export-do-btn');
            const doneBtn = oldBtn.cloneNode(true);
            oldBtn.replaceWith(doneBtn);
            doneBtn.textContent = 'Done';
            doneBtn.hidden = false;
            doneBtn.addEventListener('click', modal.close, { once: true });
        }

        return { run };
    })();

    window.TxFileExport = TxFileExport;
}());
