'use strict';

// End-to-end verification: boots the REAL app entry (main.js) against an
// isolated data dir, waits for the window, then asserts from INSIDE the renderer
// that the page rendered, the preload bridge responds, and a write round-trips
// through IPC to SQLite and back. Exits 0 on PASS.
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

// main.js requests the single-instance lock at REQUIRE time, and in dev it has
// already re-pointed userData at the shared 'aventurine-dev' profile — before
// the setPath above can isolate us. So a running `npm start` makes this process
// the losing second instance: main.js calls app.quit(), whenReady never fires,
// and this script would exit 0 having asserted nothing at all. A verification
// that passes vacuously is worse than one that fails, so say so and fail.
if (!app.hasSingleInstanceLock()) {
  console.error('FAIL — another Aventurine instance holds the single-instance '
    + 'lock. Close `npm start` (or the installed app) and run this again.');
  process.exit(1);
}

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

    // The page must be parsed as UTF-8 (no server header declares it;
    // a windows-1252 fallback renders every em-dash as mojibake).
    check('document parsed as UTF-8', (await evalJs('document.characterSet')) === 'UTF-8');

    // Navigate the way a user does: click the navbar link. Renderer-initiated
    // navigation fires will-navigate (loadURL does not), so this catches a
    // navigation guard that blocks every link with no error.
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

    // Merchant brand icons fail with no error: drop the generated manifest's
    // <script> tag, or the asset dir from the package, and every avatar falls back
    // to initials, which is indistinguishable from a build that never had icons.
    // So assert all three links of the chain from inside the real renderer: the
    // manifest loaded, avatar.js emits an <img> for a merchant with a shipped
    // icon, and that file resolves over app://.
    check('merchant icon manifest loaded', await evalJs(
      '!!(window.MERCHANT_ICONS && Object.keys(window.MERCHANT_ICONS).length > 0'
      + ' && Array.isArray(window.MERCHANT_ICONS_BLEED))'
    ));
    check('merchant avatar renders a brand icon', await evalJs(`(() => {
      const slug = Object.keys(window.MERCHANT_ICONS)[0];
      const file = window.MERCHANT_ICONS[slug];
      const html = merchantAvatarHtml(slug);
      return html.includes('avatar-circle-icon')
          && html.includes('/static/merchant-icons/' + file + '.png');
    })()`));
    check('merchant icon asset resolves', await evalJs(`new Promise(res => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth > 0);
      img.onerror = () => res(false);
      img.src = '/static/merchant-icons/'
        + window.MERCHANT_ICONS[Object.keys(window.MERCHANT_ICONS)[0]] + '.png';
    })`));

    // Every page is assembled from pages/partials/ at serve time — walk all
    // routes and prove the shared chrome landed on each one.
    const routes = {
      '/':                'Dashboard',
      '/transactions':    'Transactions',
      '/statements':      'Statements',
      '/budgets':         'Budgets',
      '/portfolio':       'Portfolio',
      '/reports':         'Reports',
      '/recurring':       'Recurring',
    };
    for (const [route, name] of Object.entries(routes)) {
      await win.loadURL(`app://aventurine${route}`);
      // A route whose sidebar link is commented out is still reachable by URL
      // but has no nav link to highlight. Check the rendered sidebar rather than
      // assuming every route is linked; otherwise disabling a nav link makes
      // this check fail permanently.
      const linked = await evalJs(
        `!!document.querySelector(".menu .nav a[href=" + ${JSON.stringify(JSON.stringify(route))} + "]")`);
      const activeHref = linked ? route : null;
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

    // Settings is a single button, not a dropdown: one click, one modal.
    await evalJs('document.querySelector("[data-action=\'open-settings\']").click()');
    check('Settings button opens the settings modal', await evalJs(
      '!document.querySelector("[data-modal=\'preferences\']").hidden'
      + ' && !document.querySelector("[data-menu-panel=\'settings\']")'
    ));

    // About's version row is filled from the preload bridge on load. It read a
    // hardcoded placeholder in every shipped build after the updater was
    // removed, so assert a real version string reached it.
    check('About shows the installed version', await evalJs(
      '/^\\d+\\.\\d+\\.\\d+/.test(document.querySelector("[data-about-version]").textContent.trim())'
    ));

    // Picking a theme paints in place and fires 'themechange' for the charts —
    // it must NOT reload the page, which used to shut the modal the user was
    // standing in. Assert the swap landed AND the modal survived it.
    check('theme swap paints without closing Preferences', await evalJs(`(() => {
      document.querySelector(".settings-theme-btn[data-theme='dark']").click();
      return document.documentElement.dataset.theme === 'dark'
        && !document.querySelector("[data-modal='preferences']").hidden
        && document.querySelector(".settings-theme-btn[data-theme='dark']").classList.contains('active');
    })()`));
    // Reset to the default so later checks run against the default theme.
    await evalJs('document.querySelector(".settings-theme-btn[data-theme=\'\']").click()');

    // The graph palette is the second appearance axis and swaps the same way:
    // an attribute on <html> that re-points --chart-*, no reload. Assert the
    // attribute landed AND that the tokens the charts read actually moved —
    // the picker being wired is not the same as the palette being applied.
    check('graph palette swap re-points the chart tokens', await evalJs(`(() => {
      const chart1 = () => getComputedStyle(document.documentElement)
        .getPropertyValue('--chart-1').trim();
      const before = chart1();
      document.querySelector(".settings-graph-btn[data-graph-theme='gemstone']").click();
      const after = chart1();
      return document.documentElement.dataset.graphTheme === 'gemstone'
        && after !== before
        && !document.querySelector("[data-modal='preferences']").hidden
        && document.querySelector(".settings-graph-btn[data-graph-theme='gemstone']").classList.contains('active');
    })()`));
    // Back to the accent ramp, same as the theme above.
    await evalJs('document.querySelector(".settings-graph-btn[data-graph-theme=\'\']").click()');

    // Both column editors live behind ONE toolbar button now: "Manage Columns"
    // opens the shared manager modal on the panel matching the current tab.
    // From the Cash Flow tab that is the categories editor — prove it renders
    // the search field, the three collapsible type groups (Income / Expense /
    // Transfer), each group's "Add category" row and the seeded rows. The
    // editor fills asynchronously after mount, so poll briefly like the tx table.
    await win.loadURL('app://aventurine/statements');
    await evalJs('new Promise(res => setTimeout(res, 400))');
    await evalJs('document.getElementById("stmt-columns-btn").click()');
    check('Statements → Manage Columns opens the Cash Flow panel', await evalJs(
      'new Promise(res => setTimeout(() => res('
        + '!!document.querySelector(".col-manager-overlay .cat-manager")'
        + ' && document.querySelectorAll(".col-manager-overlay .mgr-tab").length === 2'
        + ' && document.querySelector(".mgr-tab[data-panel=\'cashflow\']").getAttribute("aria-selected") === "true"'
        + ' && !document.querySelector(".mgr-panel[data-panel=\'cashflow\']").hidden'
        + ' && document.querySelector(".mgr-panel[data-panel=\'balance\']").hidden'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-group").length === 3'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-add-row").length === 3'
        + ' && !!document.querySelector("[data-categories-editor] .cat-search-input")'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-row").length > 0'
        + '), 800))'
    ));

    // The other half of the same modal: the switch swaps to the Balance Sheet's
    // column editor, which mounts only on first view — four type cards (Cash /
    // Investment / Retirement / Debt) of the identical .cat-* markup, in the
    // same frame, with the Cash Flow panel still mounted behind it.
    await evalJs(`document.querySelector(".mgr-tab[data-panel='balance']").click()`);
    check('the panel switch swaps to the Balance Sheet editor in the same modal', await evalJs(
      'new Promise(res => setTimeout(() => res('
        + 'document.querySelectorAll(".col-manager-overlay .cat-manager").length === 1'
        + ' && !document.querySelector(".mgr-panel[data-panel=\'balance\']").hidden'
        + ' && document.querySelector(".mgr-panel[data-panel=\'cashflow\']").hidden'
        + ' && document.querySelectorAll(".mgr-panel[data-panel=\'balance\'] .cat-group").length === 4'
        + ' && !!document.querySelector(".mgr-panel[data-panel=\'balance\'] .cat-search-input")'
        + ' && document.querySelectorAll("[data-categories-editor] .cat-group").length === 3'
        + '), 800))'
    ));

    // Year management is the other toolbar button. The probe transaction above
    // is dated 2026, and creating it opened the 2026 statement year, so that row
    // must come back LOCKED: a static label plus the lock glyph and the ledger
    // count, with no rename input and no delete ×. This is the whole rule the
    // modal exists to enforce, end to end — the /api/transactions/years read,
    // the row split, and the markup.
    await evalJs('document.querySelector(".col-manager-overlay .cat-manager-close").click()');
    await evalJs('new Promise(res => setTimeout(res, 400))');
    await evalJs('document.getElementById("stmt-years-btn").click()');
    check('Statements → Manage Years locks the year holding transactions', await evalJs(
      'new Promise(res => setTimeout(() => {'
        + 'const row = document.querySelector(".year-manager-overlay .year-row[data-year=\'2026\']");'
        + 'res(!!document.querySelector(".year-manager-overlay .cat-manager")'
        + ' && !document.querySelector(".year-manager-overlay .mgr-tabs")'
        + ' && !!document.querySelector(".year-manager-overlay .cat-add-row")'
        + ' && !!row && row.classList.contains("year-row-locked")'
        + ' && !!row.querySelector(".cat-lock")'
        + ' && !row.querySelector("input, .cat-delete")'
        + ' && /transaction/.test(row.querySelector(".year-count").textContent));'
      + '}, 800))'
    ));

  } catch (e) {
    console.error('FAIL  exception:', e.message);
    failed = true;
  }

  console.log(failed ? 'E2E: FAIL' : 'E2E: PASS');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
  app.exit(failed ? 1 : 0);
});
