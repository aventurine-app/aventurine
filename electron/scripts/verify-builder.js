'use strict';
// Schedule-builder verification: boots the REAL app against an isolated data
// dir, seeds a payroll the bank renamed twice, and walks the builder dialog
// from inside the renderer -- search, pick, tick, preview, create.
//
// It exists because the builder's whole premise is a ledger shape detection
// cannot read, so the interesting assertions are the negative one (detection
// finds nothing whole) followed by the positive one (the dialog assembles the
// series anyway). Backend coverage is in backend/__tests__/recurringBuild.test.js;
// this is the only coverage the dialog itself has.
//
// Same isolation contract as verify-e2e.js: close `npm start` first, or the
// single-instance lock makes this exit without asserting anything.
//   npm run verify:builder
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-build-'));
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
  try {
    const win = await waitForWindow();
    const js = (s) => win.webContents.executeJavaScript(s, true);

    // Seed a renamed biweekly payroll through the real IPC bridge.
    await js(`(async () => {
      const names = ['DIRECT DEP NORTHWIND LABS','PAYROLL NORTHWIND LABS','NORTHWIND LABS'];
      const iso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); const p = x => String(x).padStart(2,'0');
        return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
      for (let i = 23; i >= 0; i--) {
        await window.financeApi.request('POST','/api/transactions',
          { date: iso(i*14), description: names[Math.min(2,Math.floor((23-i)/8))],
            amount: 1400 + (i%5)*10, tx_type: 'income', category_id: null, notes: '' });
      }
      return 'seeded';
    })()`);

    await win.loadURL('app://aventurine/recurring');
    await new Promise(r => setTimeout(r, 1800));
    check('recurring page loaded', await js(`!!document.getElementById('rec-calendar')`));

    // Detection alone should NOT surface the payroll: that is the premise.
    const cands = await js(`window.financeApi.request('GET','/api/recurring/candidates').then(r => r.body.candidates.map(c=>c.key))`);
    check('detection does not find the renamed payroll whole', !cands.includes('direct dep northwind labs') && !cands.includes('payroll northwind labs'), cands);

    // Open the picker, then the builder from its footer.
    // The picker lives behind the page's kebab menu.
    await js(`document.getElementById('rec-kebab-btn').click()`);
    await new Promise(r => setTimeout(r, 400));
    await js(`(function(){ const m=[...document.querySelectorAll('button,[role=menuitem],li,a')].find(x=>/Find recurring schedules/i.test(x.textContent||'')); if(!m) throw new Error('menu item not found'); m.click(); })()`);
    await new Promise(r => setTimeout(r, 1200));
    const hasBuildBtn = await js(`!!document.getElementById('rec-build-open')`);
    check('picker offers the builder button', hasBuildBtn, await js(`document.querySelector('.rec-detect-dialog')?.textContent?.slice(0,120) || 'no dialog'`));

    await js(`document.getElementById('rec-build-open').click()`);
    await new Promise(r => setTimeout(r, 500));
    check('step 1 opens with a search field', await js(`!!document.getElementById('rec-build-q')`));

    await js(`(function(){ const i=document.getElementById('rec-build-q'); i.value='northwind'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await new Promise(r => setTimeout(r, 900));
    const picks = await js(`document.querySelectorAll('.rec-build-pick').length`);
    check('step 1 lists the three spellings', picks === 3, picks);

    await js(`[...document.querySelectorAll('.rec-build-pick')].find(b=>b.dataset.key==='northwind labs').click()`);
    await new Promise(r => setTimeout(r, 1200));
    const rows = await js(`document.querySelectorAll('.rec-build-row').length`);
    const ticked = await js(`document.querySelectorAll('.rec-build-cb:checked').length`);
    check('step 2 offers all three, ticking only the exact one', rows === 3 && ticked === 1, { rows, ticked });

    let summary = await js(`document.getElementById('rec-build-summary').textContent`);
    check('summary reads the exact-only selection', /charge/.test(summary), summary);

    // Tick the other two: the preview must become the whole biweekly series.
    await js(`(function(){ document.querySelectorAll('.rec-build-cb').forEach(cb => { if(!cb.checked){ cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); } }); })()`);
    await new Promise(r => setTimeout(r, 1200));
    summary = await js(`document.getElementById('rec-build-summary').textContent`);
    check('summary shows the assembled biweekly series', /Biweekly/.test(summary) && /24 charges/.test(summary), summary);
    check('cadence picker stays hidden when a cadence was measured', await js(`document.getElementById('rec-build-cycle-field').hidden`));

    await js(`document.getElementById('rec-build-ok').click()`);
    await new Promise(r => setTimeout(r, 1800));
    check('dialog closed after creating', !(await js(`!!document.getElementById('rec-build-ok')`)));
    const series = await js(`window.financeApi.request('GET','/api/recurring').then(r => r.body.series.map(s=>({k:s.key,c:s.cycle,n:s.occurrences})))`);
    check('one biweekly schedule with the full history', series.length === 1 && series[0].c === 'biweekly' && series[0].n === 24, series);
  } catch (e) {
    console.error('FAIL — ' + (e && e.stack || e));
    failed = true;
  }
  console.log(failed ? 'BUILDER: FAIL' : 'BUILDER: PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
