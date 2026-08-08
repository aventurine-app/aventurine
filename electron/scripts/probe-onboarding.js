'use strict';

// UI probe for the first-run onboarding flow. Boots the real app entry against
// an isolated (fresh) userData dir, then drives Dashboard → hero → account picker →
// import → "Here Is Your Import", capturing a screenshot at each step.
//
//   electron scratchpad/probe-onboarding.js
//
// userData is overridden AFTER requiring main.js (main.js re-points it at the
// shared dev profile at require time) — otherwise this writes to the dev DB.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-onb-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
app.setPath('userData', tmp);

const OUT = process.env.PROBE_OUT || tmp;
const DEADLINE_MS = 25000;

async function waitForWindow() {
  const t0 = Date.now();
  for (;;) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    if (Date.now() - t0 > DEADLINE_MS) throw new Error('window never finished loading');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A deliberately messy export: mixed date format, a signed amount column, a
// trailing balance column, merchants the lexicon knows plus one it must abstain
// on. Synthetic — no real strings (see the repo's no-real-strings rule).
const CSV = [
  'Posting Date,Description,Amount,Balance',
  '03/02/2026,SQ *ZZQX COFFEE ROASTERS 4471,-6.75,2413.19',
  '03/03/2026,TRADER JOES #221 SEATTLE WA,-84.12,2329.07',
  '03/05/2026,SHELL OIL 57432119 SEATTLE,-41.80,2287.27',
  '03/06/2026,NETFLIX.COM,-15.49,2271.78',
  '03/07/2026,ZZQX 88421 MEMO 0033,-22.00,2249.78',
  '03/10/2026,DIRECT DEP ZZQX PAYROLL,3120.44,5370.22',
  '03/12/2026,SAFEWAY #1188,-63.20,5307.02',
  '03/15/2026,CHIPOTLE 2244,-14.85,5292.17',
  '03/18/2026,DELTA AIR LINES 0062119,-318.40,4973.77',
  '03/20/2026,ZZQX MUTUAL INS PREM,-142.00,4831.77',
].join('\n');

app.whenReady().then(async () => {
  const results = [];
  const check = (label, cond, extra = '') => {
    results.push({ label, ok: !!cond, extra });
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  };

  try {
    const win = await waitForWindow();
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') {
        console.log(`      [renderer ${e.level}] ${e.message}`);
      }
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      const p = path.join(OUT, `${name}.png`);
      fs.writeFileSync(p, img.toPNG());
      console.log(`      shot → ${p}`);
    };

    // ── Step 0: a fresh DB should have no visible accounts and be "fresh" ──
    const state = await js('apiFetch("/api/onboarding").then(r => r.json())');
    check('fresh DB reports fresh', state.fresh === true && state.dismissed === false,
      JSON.stringify(state));
    const cols = await js('apiFetch("/api/balance/columns").then(r => r.json())');
    check('no visible accounts on a fresh DB', Array.isArray(cols) && cols.length === 0,
      `got ${JSON.stringify(cols)}`);
    const all = await js('apiFetch("/api/balance/columns?include_hidden=true").then(r => r.json())');
    check('six starter accounts offered', all.length === 6, all.map((c) => c.key).join(','));

    // ── Step 1: the hero preempts the dashboard ──
    await sleep(600);
    check('hero visible', await js('!document.getElementById("dashboard-firstrun").hidden'));
    check('dashboard preempted',
      await js('document.querySelectorAll(".dashboard-section.is-preempted").length === 2'));
    check('hero is actually laid out (the [hidden] trap)',
      await js('document.getElementById("dashboard-firstrun").getBoundingClientRect().height > 100'));
    await shot('01-hero');

    // ── Step 2: the account picker ──
    await js('document.getElementById("dashboard-firstrun-start").click()');
    await sleep(500);
    check('picker modal open', await js('!!document.querySelector(".onb-dialog .acct-tiles")'));
    const tiles = await js(`[...document.querySelectorAll('.acct-tile-name')].map(e => e.textContent)`);
    check('kind tiles rendered, Credit Card second', tiles[1] === 'Credit Card', tiles.join(' | '));
    check('no "your accounts" section on a fresh DB',
      await js(`[...document.querySelectorAll('.acct-section-label')].map(e => e.textContent).join('|')`) === 'Add your first account');
    check('the name field is hidden until a kind is picked',
      await js('document.querySelector(".acct-custom").hidden === true'));
    check('nothing pre-selected',
      await js('!document.querySelector(".onb-dialog input[name=\'onb-account\']:checked")'));
    check('primary action blocked until a choice is made',
      await js('document.querySelector(".onb-next").disabled === true'));
    await shot('02-picker');

    // Choose Checking.
    await js(`(() => {
      const r = document.querySelector('.onb-dialog input[value="new:checking"]');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    check('picking a kind reveals the name field',
      await js('document.querySelector(".acct-custom").hidden === false'));
    check('placeholder teaches that the name is theirs',
      await js(`document.querySelector('.acct-custom-name').placeholder`) === 'e.g. Joint Checking');
    check('an unnamed new account cannot proceed',
      await js('document.querySelector(".onb-next").disabled === true'));

    // Name it — this is what makes the ledger the user's rather than generic.
    await js(`(() => {
      const n = document.querySelector('.acct-custom-name');
      n.value = 'Everyday Checking';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    check('naming the new account enables the action',
      await js('document.querySelector(".onb-next").disabled === false'));
    await shot('02b-naming');

    // ── Step 3: intercept the native file dialog and inject the CSV ──
    await js(`(() => {
      window.__probeCsv = ${JSON.stringify(CSV)};
      const realClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return realClick.apply(this, arguments);
        const dt = new DataTransfer();
        dt.items.add(new File([window.__probeCsv], 'zzqx-export.csv', { type: 'text/csv' }));
        this.files = dt.files;
        setTimeout(() => this.dispatchEvent(new Event('change')), 30);
      };
    })()`);

    await js('document.querySelector(".onb-next").click()');
    await sleep(1200);
    check('column-mapping step reached',
      await js('!!document.querySelector(".tx-import-map-form")'));
    const detected = await js(`(() => {
      const g = (f) => { const s = document.querySelector('.tx-import-map-select[data-field="'+f+'"]'); return s ? s.selectedOptions[0].textContent : null; };
      return { date: g('date'), description: g('description'), amount: g('amount'), balance: g('balance') };
    })()`);
    check('columns auto-detected, including the balance column',
      detected.date === 'Posting Date' && detected.description === 'Description'
        && detected.amount === 'Amount' && detected.balance === 'Balance',
      JSON.stringify(detected));

    // ── The live preview reflects the MAPPING, not a raw file dump ──
    const firstCell = await js(`document.querySelector('.tx-import-preview-wrap table tbody tr td')?.textContent.trim()`);
    check('live preview shows the parsed date (mapped), not the raw file string',
      firstCell === '2026-03-02', firstCell);
    await shot('03-mapping');

    // Re-map Notes to the Balance column and confirm the preview updates
    // immediately, with no Continue click involved.
    await js(`(() => {
      const sel = document.querySelector('.tx-import-map-select[data-field="notes"]');
      const opt = [...sel.options].find(o => o.textContent === 'Balance');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    const notesCell = await js(`document.querySelector('.tx-import-preview-wrap table tbody tr td:nth-child(4)')?.textContent.trim()`);
    check('changing a column selection live-updates the preview', notesCell === '2413.19', notesCell);
    await shot('03b-mapping-live-update');

    // Put it back to skip before continuing, so the rest of the run matches
    // the file's real shape (no Notes column).
    await js(`(() => {
      const sel = document.querySelector('.tx-import-map-select[data-field="notes"]');
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);

    await js('document.querySelector(".tx-import-continue-btn").click()');
    await sleep(1200);
    check('combined import screen reached', await js('!!document.querySelector(".tx-import-preview-full")'));
    check('titled "Here Is Your Import" — the merged preview + results screen',
      await js(`document.querySelector('.tx-import-dialog-title')?.textContent`) === 'Here Is Your Import');
    check('account is not re-asked here',
      await js(`!document.querySelector('.tx-import-dialog .acct-tiles')`));
    check('no balance opt-in question anywhere in the flow',
      await js(`!document.querySelector('.tx-import-balance-prompt, .tx-import-balance-choice')`));
    // ── Step 3's uncategorized digest — computed by a dry run BEFORE anything
    // commits — now lives in the STATIC bar (replacing the old "Importing
    // into: <account>" line), and exactly two footer actions ──
    const digest = await js(`(() => ({
      headline: document.querySelector('.tx-found-headline')?.textContent.trim() || '',
      note: document.querySelector('.tx-import-balance-bar .tx-found-note')?.textContent.replace(/\\s+/g,' ').trim() || '',
      noteIsStatic: !!document.querySelector('.tx-import-balance-bar .tx-found-note'),
      hasBars: !!document.querySelector('.tx-found-cat'),
      hasTotals: !!document.querySelector('.tx-found-totals'),
      buttons: [...document.querySelectorAll('.tx-import-footer--preview button')].map(b => b.textContent.trim()),
    }))()`);
    check('headline states how many rows will be added', /will be added/.test(digest.headline), digest.headline);
    check('the callout lives in the static bar (outside the scrolling table)', digest.noteIsStatic);
    check('uncategorized callout present, phrased as a future ("will be")',
      /uncategorized/i.test(digest.note) && /will be/i.test(digest.note), digest.note);
    check('no bar chart in the merged screen (removed per spec)', !digest.hasBars);
    check('no income/expense totals in the merged screen (removed per spec)', !digest.hasTotals);
    check('exactly two footer actions: Go Back, Looks Right',
      digest.buttons.length === 2 && digest.buttons[0] === 'Go Back' && digest.buttons[1] === 'Looks Right',
      digest.buttons.join(' | '));
    console.log('\n      ' + digest.headline);
    console.log('      ' + digest.note);
    await shot('04-here-is-your-import');

    await js('document.querySelector(".tx-import-do-btn").click()');
    await sleep(2000);

    const after = await js('apiFetch("/api/balance/columns").then(r => r.json())');
    check('exactly one account adopted, under the user\'s own name',
      after.length === 1 && after[0].key === 'checking' && after[0].label === 'Everyday Checking',
      JSON.stringify(after));
    const bal = await js('apiFetch("/api/balance/data").then(r => r.json())');
    check('balance reading seeded into the sheet',
      JSON.stringify(bal.entries).includes('checking'), JSON.stringify(bal.entries));
    const onb = await js('apiFetch("/api/onboarding").then(r => r.json())');
    check('no longer fresh', onb.fresh === false);

    // ── Step 4: "Success!" — deliberately minimal, exactly two actions ──
    check('Success modal reached', await js(`document.querySelector('.tx-import-dialog--success .tx-import-dialog-title')?.textContent`) === 'Success!');
    check('no header/footer rules on this screen (per spec)',
      await js(`getComputedStyle(document.querySelector('.tx-import-dialog--success .tx-import-dialog-header')).borderBottomWidth`) === '0px'
      && await js(`getComputedStyle(document.querySelector('.tx-import-dialog--success .tx-import-footer')).borderTopWidth`) === '0px');
    check('exactly two actions: Start Another Upload, Go to Dashboard',
      await js(`[...document.querySelectorAll('.tx-import-dialog--success .tx-import-footer button')].map(b => b.textContent.trim()).join('|')`)
        === 'Start Another Upload|Go to Dashboard');
    await shot('05-success');

    // "Start Another Upload" is onboarding's path back to the picker
    // (the account just imported shows up as a chip there).
    await js('document.querySelector(".tx-import-more-btn").click()');
    await sleep(600);
    check('back at the picker — no separate "here\'s what we found" screen anymore',
      await js('!!document.querySelector(".onb-dialog .acct-tiles")'));
    check('the adopted account appears under "your accounts", by its name',
      (await js(`[...document.querySelectorAll('.acct-tile-name')].map(e => e.textContent)`))[0] === 'Everyday Checking');
    check('both sections present on the second pass',
      await js(`[...document.querySelectorAll('.acct-section-label')].map(e => e.textContent).join('|')`) === 'Your accounts|Or add a new one');
    check('progress chip for the finished account',
      await js(`document.querySelector('.onb-done-chip')?.textContent`) === 'Everyday Checking');
    check('"Finish" is offered as the deliberate way out on a second pass',
      await js(`document.querySelector('.onb-skip')?.textContent`) === 'Finish');
    check('the × close button is still present (skip is never taken away)',
      await js('!!document.querySelector(".onb-close")'));
    await shot('06-second-pass');

    // Finish and confirm the dashboard comes back populated.
    await js('document.querySelector(".onb-skip").click()');
    await sleep(2500);
    check('dashboard restored after finishing',
      await js('document.querySelectorAll(".dashboard-section.is-preempted").length === 0'));
    check('hero gone', await js('document.getElementById("dashboard-firstrun") === null || document.getElementById("dashboard-firstrun").hidden'));
    await shot('07-dashboard');

    // ── Step 7: the ORDINARY import now asks the same question, up front ──
    // Same machinery, no onboarding involved: the account step must come before
    // the file dialog, pre-filled from the account used last.
    await js('window.location.href = "app://aventurine/transactions"');
    await sleep(2500);
    await js(`(() => {
      const realClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return realClick.apply(this, arguments);
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(CSV)}], 'zzqx-april.csv', { type: 'text/csv' }));
        this.files = dt.files;
        setTimeout(() => this.dispatchEvent(new Event('change')), 30);
      };
    })()`);

    // Fire-and-forget: executeJavaScript resolves a returned promise, and run()
    // does not settle until the whole flow finishes — awaiting it here would sit
    // through the very step this is trying to observe.
    await js('window.__runP = TxFileImport.run(); "started"');
    await sleep(900);
    check('normal import asks the account FIRST, before any file dialog',
      await js(`!!document.querySelector('.tx-import-dialog .acct-tiles')`));
    check('pre-filled from the account used last (an EXISTING account)',
      await js(`document.querySelector('.tx-import-dialog input[type="radio"]:checked')?.value`) === 'checking',
      'checked=' + await js(`document.querySelector('.tx-import-dialog input[type="radio"]:checked')?.value`));
    check('primary action is ready (routine path is one click)',
      await js(`document.querySelector('.tx-import-acct-next').disabled === false`));
    await shot('08-normal-import-account');

    await js('document.querySelector(".tx-import-acct-next").click()');
    await sleep(1400);
    check('proceeds to mapping after the account step',
      await js('!!document.querySelector(".tx-import-map-form")'));
    check('no row counter in Map Columns (removed per spec)',
      await js('!document.querySelector(".tx-import-dialog-body .tx-import-row-count")'));
    check('no manual split toggle — this file has one Amount column, so only that field shows',
      await js(`!document.querySelector('.tx-import-switch-row, .tx-import-map-mode')
                 && !!document.querySelector('.tx-import-map-select[data-field="amount"]')
                 && !document.querySelector('.tx-import-map-select[data-field="debit"]')`));
    await js('document.querySelector(".tx-import-continue-btn").click()');
    await sleep(1400);
    check('combined screen reached again on the normal path',
      await js('!!document.querySelector(".tx-import-preview-full")'));
    check('still no balance question on the normal path',
      await js(`!document.querySelector('.tx-import-balance-choice')`));
    await shot('09-normal-import-preview');

    // "Go Back" returns to Map Columns with the previous selections intact,
    // and commits nothing — verified by re-continuing and landing back on the
    // combined screen with the same row count as before.
    await js('document.querySelector(".tx-import-back-btn").click()');
    await sleep(800);
    check('Go Back returns to Map Columns',
      await js('!!document.querySelector(".tx-import-map-form")'));
    check('previous column selections are retained',
      await js(`document.querySelector('.tx-import-map-select[data-field="date"]')?.selectedOptions[0]?.textContent`) === 'Posting Date');
    await js('document.querySelector(".tx-import-continue-btn").click()');
    await sleep(1400);
    check('re-continuing after Go Back lands back on the combined screen',
      await js('!!document.querySelector(".tx-import-preview-full")'));
    await shot('10-normal-import-goback');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('FAILED: ' + failed.map((f) => f.label).join('; '));
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
