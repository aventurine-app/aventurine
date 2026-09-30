'use strict';
// Recurring editor verification: boots the REAL app against an isolated data
// dir and walks the schedule editor's NAMING band from inside the renderer --
// the merchant suggestions on the Name field and the avatar they draw.
//
// The backend half is pinned by backend/__tests__/recurring.test.js; the
// dialog's own wiring is not testable anywhere else, which is what this is for.
// The couplings it guards are the ones that break silently -- a suggestion fills
// in the name and claims nothing else, and a schedule carries no category at
// all, on the wire as well as in the editor.
//
// Same isolation contract as verify-e2e.js: close `npm start` first, or the
// single-instance lock makes this exit without asserting anything.
//   npm run verify:naming
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-naming-'));
const { app, BrowserWindow } = require('electron');
require('../main.js');
app.setPath('userData', tmp);
if (!app.hasSingleInstanceLock()) { console.error('FAIL — close npm start first'); process.exit(1); }

async function waitForWindow() {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows();
    if (w.length && !w[0].webContents.isLoading()) return w[0];
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('window never loaded');
}

app.whenReady().then(async () => {
  let failed = false;
  const check = (label, cond, extra) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || extra === undefined ? '' : '  <- ' + JSON.stringify(extra)}`);
    if (!cond) failed = true;
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    const win = await waitForWindow();
    const js = (s) => win.webContents.executeJavaScript(s, true);

    await win.loadURL('app://aventurine/recurring');
    await wait(1800);
    check('recurring page loaded', await js(`!!document.getElementById('rec-calendar')`));

    // Open the create dialog from the rail's foot.
    await js(`[...document.querySelectorAll('.rec-rail-foot button')].find(b=>/Create Schedule/i.test(b.textContent||'')).click()`);
    await wait(700);
    check('editor opened', await js(`!!document.getElementById('rec-name-input')`),
      await js(`document.querySelector('.rec-edit-dialog')?.textContent?.slice(0,80) || 'no dialog'`));

    // A schedule has no category, so the editor must not offer one -- neither a
    // control to set it nor the word anywhere in the form.
    check('the editor offers no Category control',
      await js(`!document.querySelector('[data-form="category_id"]')`));
    check('and does not say the word',
      await js(`!/categor/i.test(document.querySelector('.rec-edit-dialog').textContent || '')`),
      await js(`document.querySelector('.rec-edit-dialog').textContent.slice(0, 200)`));

    check('the name carries an avatar', await js(`!!document.querySelector('#rec-name-avatar .avatar-circle')`));

    // Type a merchant the lexicon knows.
    await js(`(function(){ const i=document.getElementById('rec-name-input'); i.value='netfl'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(900);
    const names = await js(`[...document.querySelectorAll('.rec-suggest-row .rec-suggest-name')].map(n=>n.textContent)`);
    check('typing offers matching merchants', names.includes('Netflix'), names);
    check('the list is visible', await js(`!document.getElementById('rec-name-suggest').hidden`));
    check('and it says so to a screen reader',
      await js(`document.getElementById('rec-name-input').getAttribute('aria-expanded') === 'true'`));

    // Arrow to the Netflix row and take it with Enter.
    await js(`(function(){
      const input = document.getElementById('rec-name-input');
      const rows = [...document.querySelectorAll('.rec-suggest-row')];
      const want = rows.findIndex(r => r.querySelector('.rec-suggest-name').textContent === 'Netflix');
      for (let i = 0; i <= want; i++) input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    })()`);
    await wait(400);
    check('picking writes the merchant name', await js(`document.getElementById('rec-name-input').value`) === 'Netflix');
    check('and leaves Type on the form\'s own answer',
      await js(`document.querySelector('[data-form="direction"]').value`) === 'expense',
      await js(`document.querySelector('[data-form="direction"]').value`));
    check('and draws the brand avatar',
      await js(`!!document.querySelector('#rec-name-avatar .avatar-circle-icon img')`),
      await js(`document.getElementById('rec-name-avatar').innerHTML.slice(0,140)`));
    check('the list closed behind it', await js(`document.getElementById('rec-name-suggest').hidden`));

    // Escape dismisses the list, not the dialog.
    await js(`(function(){ const i=document.getElementById('rec-name-input'); i.value='chipot'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(900);
    check('a second query re-opens the list', await js(`!document.getElementById('rec-name-suggest').hidden`));
    await js(`document.getElementById('rec-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await wait(200);
    check('Escape closes the list', await js(`document.getElementById('rec-name-suggest').hidden`));
    check('and leaves the dialog open', await js(`!!document.querySelector('.rec-edit-dialog')`));

    // Save, and read the schedule back off the calendar.
    await js(`(function(){
      const i=document.getElementById('rec-name-input'); i.value='Netflix'; i.dispatchEvent(new Event('input',{bubbles:true}));
      const a=document.querySelector('[data-form="amount"]'); a.value='15.49'; a.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await wait(400);
    await js(`document.getElementById('rec-edit-save').click()`);
    await wait(1400);
    check('the dialog closed after creating', await js(`!document.querySelector('.rec-edit-dialog')`));
    const saved = await js(`window.financeApi.request('GET','/api/recurring').then(r => r.body.series.map(s => ({n:s.display_name, d:s.direction, keys:Object.keys(s)})))`);
    check('the schedule saved with its name and direction',
      saved.length === 1 && saved[0].n === 'Netflix' && saved[0].d === 'expense', saved);
    // No category ANYWHERE in the payload: the editor offers no field for one, so
    // a schedule that came back carrying one would be an answer nobody gave.
    check('and the payload carries no category at all',
      saved.length === 1 && !saved[0].keys.some((k) => k.startsWith('category')), saved);

    // Re-open it: the fields must come back on the stored answers. The rail row
    // IS the edit control -- it is the row's only button now.
    await js(`document.querySelector('.rec-rail-row').click()`);
    await wait(900);
    check('re-opening shows the stored name',
      await js(`document.getElementById('rec-name-input').value`) === 'Netflix',
      await js(`document.getElementById('rec-name-input').value`));

    const readout = await js(`(function(){ const r=getComputedStyle(document.getElementById('rec-edit-readout'));
      return { border: r.borderLeftWidth + ' ' + r.borderLeftColor, bg: r.backgroundColor }; })()`);
    check('the cadence readout has a 4px blue stripe and a blue wash',
      readout.border.startsWith('4px'), readout);
    console.log('   readout:', JSON.stringify(readout));
  } catch (err) {
    console.error('FAIL —', err && err.message);
    failed = true;
  }
  console.log(failed ? 'NAMING: FAIL' : 'NAMING: PASS');
  app.exit(failed ? 1 : 0);
});
