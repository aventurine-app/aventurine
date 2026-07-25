'use strict';

// ─── onboarding.js ────────────────────────────────────────────────────────────
// First-run setup, launched from the Home dashboard's hero CTA on a database
// that holds nothing the user put there (GET /api/onboarding decides that from
// data, not a flag — see handlers/onboarding.js).
//
// The shape of this flow is a deliberate inversion of the usual finance-app
// setup wizard. Those ask the user to design a data model — name your accounts,
// build your category list — at the exact moment they know least about what they
// want, which is why setup is the biggest churn driver in the category. Here the
// user answers ONE question and hands over one file; everything else is derived
// and then shown back to them for confirmation:
//
//   1. "Which account is this coming from?"  — pre-named starter accounts
//      (seeded hidden; see seed.js DEFAULT_BALANCE_COLUMNS) plus "Something
//      else". Naming an account is pure user identity, so it is the one thing
//      that must be asked and the one thing never inferred from the file: a
//      bank's name in a filename says nothing about which bucket the user meant,
//      and someone who changes banks mid-year still has one logical "Checking".
//   2. The file goes through the ordinary import (widgets/txfileimport.js) —
//      same parser, same mapping step, same row preview. Committing it is what
//      ADOPTS the account, so backing out here leaves nothing behind.
//   3. "Here's what we found. Does this look right?" — the import digest, with
//      the user's own merchants in their own categories.
//   4. Offer the next account, or finish.
//
// The category taxonomy is deliberately NOT part of this. It ships as a canonical
// set the on-device categorizer targets, so asking the user to invent one would
// leave the lexicon and classifier with nowhere to land — the cold-start
// categorization that makes the first import feel like anything would drop to
// zero. Personalization there is subtractive (unused categories stay out of the
// way) and happens by using the app, not by answering questions up front.
//
// Skipping is always available and always leads to a fully working app: the
// ordinary Home dashboard with its own empty-state CTAs into each surface.

(function () {
    const Onboarding = (() => {

        const esc = escapeHtml;

        // The account question itself — tiles, the "Something else" fields, and the
        // create-on-resolve behaviour — comes from TxFileImport, so first-run and an
        // ordinary import ask it in exactly the same words and the same shape. This
        // file owns only the surrounding first-run chrome.
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
        // Its own shell rather than txfileimport's: this one is never busy-gated,
        // and it must survive the import modals opening on top of it (the flow
        // returns here afterwards).
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
        // Radio tiles, nothing pre-selected. An unselected list is honest about
        // not knowing; a pre-selected "Checking" would get accepted by accident,
        // and landing a card statement in Checking is exactly the confidently
        // wrong answer that costs trust.
        function renderPicker(dialog, { accounts, imported, onChosen, onSkip, onDone }) {
            const again = imported.length > 0;

            dialog.innerHTML = `
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
                    <button type="button" class="onb-skip">${again ? 'Finish' : 'I’ll enter things myself'}</button>
                    <button type="button" class="button-primary onb-next" disabled>Choose file…</button>
                </div>
            `;

            const nextBtn = dialog.querySelector('.onb-next');
            const choices = TxFileImport.wireAccountChoices(dialog, accounts, {
                onValidityChange: (ok) => { nextBtn.disabled = !ok; },
            });

            dialog.querySelector('.onb-skip').addEventListener('click', () => {
                if (again) onDone();
                else onSkip();
            });

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

        // ── Step 3: here's what we found ──────────────────────────────────────────
        function renderFound(dialog, { account, result, onAnother, onDone }) {
            const n = result.inserted;
            dialog.innerHTML = `
                <div class="onb-head">
                    <h2 class="onb-title">Here’s what we found</h2>
                    <p class="onb-sub">${n} transaction${n !== 1 ? 's' : ''} from
                        ${esc(account.label)}, sorted into your categories. Does this look right?</p>
                </div>
                ${TxFileImport.renderFound(result.found, account.label)}
                <div class="onb-foot">
                    <button type="button" class="onb-another">Add another account</button>
                    <button type="button" class="button-primary onb-finish">Looks right</button>
                </div>
            `;
            dialog.querySelector('.onb-another').addEventListener('click', onAnother);
            dialog.querySelector('.onb-finish').addEventListener('click', onDone);
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
                        // Hand off to the ordinary import, with the account
                        // settled so the preview states it instead of re-asking.
                        modal.hide();
                        TxFileImport.run({
                            account,
                            onCancel: () => modal.show(),
                            onImported: (result) => {
                                imported.push(account);
                                modal.show();
                                renderFound(modal.dialog, {
                                    account, result,
                                    onAnother: showPicker,
                                    onDone: () => finish(),
                                });
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
