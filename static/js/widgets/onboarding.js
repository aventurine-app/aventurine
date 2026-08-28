'use strict';

// ─── onboarding.js ────────────────────────────────────────────────────────────
// First-run setup, launched from the Dashboard's hero CTA on a database with no
// user data (GET /api/onboarding computes that from data, not a flag — see
// handlers/onboarding.js).
//
// This flow is the inverse of the usual finance-app setup wizard. Those require
// the user to define a data model — name your accounts, build your category list
// — before they have used the app. Here the user answers ONE question and
// supplies one file; everything else is derived from it and shown back for
// confirmation:
//
//   1. "Which account is this coming from?"  — pre-named starter accounts
//      (seeded hidden; see seed.js DEFAULT_BALANCE_COLUMNS) plus "Something
//      else". Account names are user-specific, so this is the one thing asked and
//      the one thing never inferred from the file: a bank's name in a filename
//      does not identify which account the user means, and someone who changes
//      banks mid-year still has one logical "Checking".
//   2. The file goes through the ordinary import (widgets/txfileimport.js) —
//      same parser, same mapping step, same row preview. Committing it is what
//      ADOPTS the account, so backing out here leaves nothing behind.
//   3. "Here's what we found. Does this look right?" — the import summary, with
//      the user's merchants in their categories.
//   4. Offer the next account, or finish.
//
// The category taxonomy is NOT part of this. It ships as a fixed set the
// on-device categorizer targets, so a user-invented taxonomy would leave the
// lexicon and classifier with no matching keys and drop cold-start
// categorization to zero. Personalization there is subtractive (unused
// categories are ignored) and happens through use rather than up-front
// questions.
//
// Skipping is always available and leads to a fully working app: the ordinary
// Dashboard with its per-card empty-state CTAs into each page.

(function () {
    const Onboarding = (() => {

        const esc = escapeHtml;

        // The account question — tiles, the "Something else" fields, and the
        // create-on-resolve behaviour — comes from TxFileImport, so first-run and an
        // ordinary import use identical wording and layout. This file provides only
        // the surrounding first-run chrome.
        async function fetchAccounts() {
            try {
                const r = await apiFetch('/api/balance/columns?include_hidden=true');
                if (!r.ok) return [];
                return await r.json().catch(() => []);
            } catch {
                return [];
            }
        }

        async function dismiss() {
            try {
                await apiFetch('/api/app-settings/onboarding_dismissed', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: 'on' }),
                });
            } catch {
                // A failed dismissal is harmless: the invitation reappears, and
                // the dashboard underneath works either way.
            }
        }

        // ── Modal shell ───────────────────────────────────────────────────────────
        // A separate shell from txfileimport's: this one is never busy-gated, and
        // it must stay mounted while the import modals open on top of it, since the
        // flow returns here afterwards.
        function buildModal() {
            const overlay = document.createElement('div');
            overlay.className = 'onb-overlay';
            const dialog = document.createElement('div');
            dialog.className = 'onb-dialog';
            overlay.append(dialog);
            document.body.append(overlay);
            return {
                overlay, dialog,
                hide: () => { overlay.style.display = 'none'; },
                show: () => { overlay.style.display = ''; },
                close: () => overlay.remove(),
            };
        }

        // ── Step 1: which account? ────────────────────────────────────────────────
        // Radio tiles, nothing pre-selected. A pre-selected "Checking" would be
        // accepted by clicking through, and importing a card statement into
        // Checking is a wrong result that has to be undone manually.
        //
        // The only way to skip is the × in the corner (matching the import modals'
        // close button) — first-run has no "enter things myself" link, so skipping
        // must stay reachable some other way, per PRODUCT.md's "skipping is always
        // available" guarantee.
        function renderPicker(dialog, { accounts, imported, onChosen, onSkip, onDone }) {
            const again = imported.length > 0;

            dialog.innerHTML = `
                <button type="button" class="onb-close" title="Close" aria-label="Close">&times;</button>

                <div class="onb-head">
                    <h2 class="onb-title">${again ? 'Add another account' : 'Let’s start with one account'}</h2>
                    <p class="onb-sub">${again
                        ? 'Which account is this one from? Pick it, then drop in its export.'
                        : 'Download a transaction export from your bank — CSV, Excel, OFX/QFX, or QIF — and Aventurine will read it, sort it, and build your statements. Nothing leaves this computer.'}</p>
                </div>

                ${imported.length ? `<div class="onb-done-list">
                    ${imported.map(a => `<span class="onb-done-chip">${esc(a.label)}</span>`).join('')}
                </div>` : ''}

                ${TxFileImport.accountChoicesHtml(accounts, { name: 'onb-account' })}

                <div class="onb-foot">
                    ${again ? '<button type="button" class="onb-skip">Finish</button>' : ''}
                    <button type="button" class="button-primary onb-next" disabled>Choose file…</button>
                </div>
            `;

            const nextBtn = dialog.querySelector('.onb-next');
            const choices = TxFileImport.wireAccountChoices(dialog, accounts, {
                onValidityChange: (ok) => { nextBtn.disabled = !ok; },
            });

            dialog.querySelector('.onb-close').addEventListener('click', () => {
                if (again) onDone();
                else onSkip();
            });
            dialog.querySelector('.onb-skip')?.addEventListener('click', onDone);

            nextBtn.addEventListener('click', async () => {
                nextBtn.disabled = true;
                try {
                    onChosen(await choices.resolve());
                } catch (err) {
                    UI.toast(err.message, { type: 'error' });
                    nextBtn.disabled = false;
                }
            });
        }

        // ── Flow ──────────────────────────────────────────────────────────────────
        async function start({ onFinished = null } = {}) {
            const modal = buildModal();
            const imported = [];

            const finish = async ({ skipped = false } = {}) => {
                // Skipping is remembered so relaunching doesn't nag; completing
                // needs no flag, because a database with data is never fresh.
                if (skipped) await dismiss();
                modal.close();
                if (onFinished) onFinished({ imported: imported.length, skipped });
            };

            const showPicker = async () => {
                const accounts = await fetchAccounts();
                modal.show();
                renderPicker(modal.dialog, {
                    accounts,
                    imported,
                    onSkip: () => finish({ skipped: true }),
                    onDone: () => finish(),
                    onChosen: (account) => {
                        // Hand off to the ordinary import with the account already
                        // resolved, so the preview displays it instead of asking
                        // again. The import's Step 4 ("Success!") offers the same
                        // two choices onboarding needs next: add another account
                        // (back to the picker, with this one added to the imported
                        // chips) or finish.
                        modal.hide();
                        TxFileImport.run({
                            account,
                            onCancel: () => modal.show(),
                            onUploadMore: () => {
                                imported.push(account);
                                modal.show();
                                showPicker();
                            },
                            onFinish: () => {
                                imported.push(account);
                                finish();
                            },
                        });
                    },
                });
            };

            showPicker();
        }

        return { start };
    })();

    window.Onboarding = Onboarding;
}());
