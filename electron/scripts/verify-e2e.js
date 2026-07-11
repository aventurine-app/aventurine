'use strict';

// End-to-end verification: boots the REAL app entry (main.js) against an
// isolated data dir, waits for the window, then asserts from INSIDE the
// renderer that the page rendered, the preload bridge answers, and a write
// round-trips through IPC to SQLite and back. Exits 0 on PASS.
//
//   AVENTURINE_E2E=1 electron . is NOT used — this drives main.js directly:
//   npm run verify  (alias: electron scripts/verify-e2e.js)

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir — set AFTER requiring main.js, not before: main.js
// re-points userData at the shared 'aventurine-dev' profile at require time (dev
// isolation from the packaged build), which silently clobbers any earlier
// setPath and sends every write from this script into the REAL dev database.
// startBackend derives AVENTURINE_DATA_DIR from userData only at app.whenReady, so
// overriding here (post-require, pre-ready) is what actually isolates us.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-e2e-'));
const { app, BrowserWindow } = require('electron');

require('../main.js'); // the real entry: backend, protocol, window
app.setPath('userData', tmp);

const DEADLINE_MS = 20000;

async function waitForWindow() {
  const t0 = Date.now();
  for (;;) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    if (Date.now() - t0 > DEADLINE_MS) throw new Error('window never finished loading');
    await new Promise((r) => setTimeout(r, 200));
  }
}

app.whenReady().then(async () => {
  let failed = false;
  const check = (label, cond) => {
    console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
    if (!cond) failed = true;
  };

  try {
    const win = await waitForWindow();
    const evalJs = (js) => win.webContents.executeJavaScript(js, true);

    check('renderer URL is app origin', win.webContents.getURL() === 'app://aventurine/');
    check('page title', (await evalJs('document.title')).includes('Aventurine'));
    check('navbar rendered', await evalJs('!!document.querySelector(".menu .nav a[href=\'/transactions\']")'));
    // The sidebar is a shared partial; nav.js derives .active from the URL.
    check('home link marked active', await evalJs('document.querySelector(".menu .nav a[href=\'/\']").classList.contains("active")'));
    check('escapeHtml global present', await evalJs('typeof escapeHtml === "function"'));
    check('apiFetch present', await evalJs('typeof apiFetch === "function"'));
    check('financeApi bridge present', await evalJs('!!window.financeApi'));

    const status = await evalJs('apiFetch("/api/db/status").then(r => r.json())');
    check('IPC db status ok+unlocked', status.ok === true && status.locked === false);

    const created = await evalJs(`apiFetch("/api/transactions", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({date: "2026-06-11", description: "e2e probe",
                              tx_type: "expense", amount: 9.99})
      }).then(r => r.json())`);
    check('IPC tx create round-trips', created.ok === true && created.transaction.amount === 9.99);

    const listed = await evalJs('apiFetch("/api/transactions").then(r => r.json())');
    check('IPC tx visible in list', listed.transactions.some((t) => t.description === 'e2e probe'));

    // The page must be parsed as UTF-8 (no Flask header declares it anymore;
    // a windows-1252 fallback renders every em-dash as mojibake).
    check('document parsed as UTF-8', (await evalJs('document.characterSet')) === 'UTF-8');

    // Navigate like a USER: click the navbar link. Renderer-initiated
    // navigation fires will-navigate (loadURL does not), so this catches a
    // miswritten navigation guard that silently blocks every link.
    await evalJs('document.querySelector(".menu .nav a[href=\'/transactions\']").click()');
    const t0 = Date.now();
    while (
      (win.webContents.isLoading() || !win.webContents.getURL().endsWith('/transactions')) &&
      Date.now() - t0 < 8000
    ) {
      await new Promise((r) => setTimeout(r, 150));
    }
    check('link click navigates', win.webContents.getURL() === 'app://aventurine/transactions');
    check('transactions page loads', (await evalJs('document.title')).includes('Transactions'));
    check('active link follows navigation', await evalJs('document.querySelector(".menu .nav a[href=\'/transactions\']").classList.contains("active")'));
    check('tx table boots with data', await evalJs(
      'new Promise(res => setTimeout(() => res(!!document.querySelector(".tx-row, .tx-table tbody tr")), 800))'
    ));
    // Import stack load-order contract: txparse.js (pure parser) must attach
    // TxParse before txfileimport.js destructures it — a broken order leaves
    // TxFileImport undefined and the Import button dead.
    check('import parser + widget globals present', await evalJs(
      '!!(window.TxParse && window.TxParse.parseFile && window.TxFileImport && window.TxFileImport.run)'
    ));

    // Every page is assembled from pages/partials/ at serve time — walk all
    // routes and prove the shared chrome landed on each one.
    const routes = {
      '/':                'Home',
      '/categories':      'Categories',
      '/transactions':    'Transactions',
      '/statements':      'Statements',
      '/portfolio':       'Portfolio',
      '/credit-cards':    'Credit Cards',
      '/cash-flow':       'Cash Flow Reports',
      '/spending-trends': 'Spending Trends',
      '/report-card':     'Report Card',
    };
    for (const [route, name] of Object.entries(routes)) {
      const activeHref = route;
      await win.loadURL(`app://aventurine${route}`);
      const ok = await evalJs(`document.title.includes(${JSON.stringify(name)})
        && !!document.querySelector(".titlebar")
        && !!document.querySelector(".menu .nav")
        && !!document.querySelector("#db-modal")
        && !!document.querySelector("[data-modal='preferences']")
        && (document.querySelector(".menu .nav a.active")?.getAttribute("href") ?? null) === ${JSON.stringify(activeHref)}
        && document.querySelectorAll(".menu .nav a.active").length === ${activeHref ? 1 : 0}`);
      check(`page ${route} assembles with chrome`, ok);
    }

    // The title-bar File menu is now the only way to reach the DB modal —
    // prove the dropdown → window.dbActions → modal chain works.
    await win.loadURL('app://aventurine/');
    await evalJs('document.querySelector("[data-menu=\'file\']").click()');
    await evalJs('document.querySelector("[data-menu-panel=\'file\'] [data-action=\'new-db\']").click()');
    check('File menu opens New Database modal', await evalJs(
      '!document.getElementById("db-modal").hidden && document.getElementById("db-modal-title").textContent === "New Database"'
    ));

    // The Settings menu is a dropdown → Preferences / About.
    await evalJs('document.querySelector("[data-menu=\'settings\']").click()');
    await evalJs('document.querySelector("[data-menu-panel=\'settings\'] [data-action=\'open-preferences\']").click()');
    check('Settings menu opens Preferences modal', await evalJs(
      '!document.querySelector("[data-modal=\'preferences\']").hidden'
    ));

    // Category management now lives on its own page — prove the editor renders
    // the search field, the four collapsible type groups, each group's "Add
    // category" row, and the seeded category rows. The editor fills
    // asynchronously after load, so poll briefly like the tx table.
    await win.loadURL('app://aventurine/categories');
    check('Categories page renders the editor', await evalJs(
      'new Promise(res => setTimeout(() => res('
        + 'document.querySelectorAll("[data-categories-editor] .cat-group").length === 4'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-add-row").length === 4'
        + ' && !!document.querySelector("[data-categories-editor] .cat-search-input")'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-row").length > 0'
        + '), 800))'
    ));
  } catch (e) {
    console.error('FAIL  exception:', e.message);
    failed = true;
  }

  console.log(failed ? 'E2E: FAIL' : 'E2E: PASS');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
  app.exit(failed ? 1 : 0);
});
