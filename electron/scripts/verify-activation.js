'use strict';

// Boots the REAL app entry with NO license against an isolated profile, and
// asserts from inside the renderer that the SOFT gate behaves as specified: the
// ledger works, the paid destinations do not, the activation screen opens and
// closes on request, and pasting a valid key unlocks the rest.
//
// The renderer half matters more here than under the total lockout, where one
// state covered everything. The free tier is now a layout the stylesheet
// produces, so whether a paid section stayed hidden can only be checked in a
// running window.
//
// The counterpart to verify-e2e.js, which installs a throwaway license and so
// never exercises this path.
//
//   npx electron scripts/verify-activation.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-act-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
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
    let win = await waitForWindow();
    const evalJs = (js) => win.webContents.executeJavaScript(js, true);
    const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

    // Let shell/license.js finish its first status read.
    await settle(600);

    const lic = await evalJs('apiFetch("/api/license").then(r => r.json())');
    check('install reports unactivated', lic.licensed === false);

    // ── The free tier is an app, not a wall ───────────────────────────────
    check('the tier is free', await evalJs(
      'document.documentElement.dataset.licenseTier === "free"'
    ));
    check('the activation screen is NOT in the way', await evalJs(
      'getComputedStyle(document.querySelector("[data-activation-screen]")).display === "none"'
    ));
    check('title bar menus are usable', await evalJs(
      'getComputedStyle(document.querySelector(".titlebar-menu")).display !== "none"'
    ));
    check('About names no licensee', await evalJs(
      'document.querySelector("[data-about-license-section]").hidden === true'
    ));

    // A fresh profile opens on the first-run hero, which preempts BOTH
    // dashboard sections until it is answered. Skip it, so everything below is
    // an assertion about licensing rather than about an empty database.
    await evalJs('(() => { const h = document.getElementById("dashboard-firstrun");'
      + ' if (h && !h.hidden) document.getElementById("dashboard-firstrun-skip").click(); })()');
    await settle(400);

    // The one section the backend cannot gate, so the stylesheet is the only
    // control. If this check fails, the free tier is showing paid content.
    check('Year to Year is hidden', await evalJs(
      'getComputedStyle(document.querySelector("#dashboard-section-overtime")).display === "none"'
    ));
    check('Month to Month is not', await evalJs(
      'getComputedStyle(document.querySelector("#dashboard-section-month")).display !== "none"'
    ));

    check('locked nav links are marked, not removed', await evalJs(
      '(() => { const a = [...document.querySelectorAll(".nav a[data-paid]")];'
      + ' return a.length === 4 && a.every(l => l.offsetParent !== null'
      + ' && getComputedStyle(l.querySelector(".nav-lock")).display !== "none"); })()'
    ));
    check('the free destinations carry no lock', await evalJs(
      '[...document.querySelectorAll(".nav a")].filter(l => !l.hasAttribute("data-paid"))'
      + '.map(l => l.getAttribute("href")).join(",") === "/,/transactions"'
    ));
    check('the Unlock button is offered', await evalJs(
      'getComputedStyle(document.querySelector("[data-license-unlock]")).display !== "none"'
    ));

    // ── The backend half: the allowlist, from the renderer's side ─────────
    const free = await evalJs(`Promise.all([
        apiFetch("/api/transactions"),
        apiFetch("/api/categories"),
        apiFetch("/api/data"),
        apiFetch("/api/balance/data"),
        apiFetch("/api/balance/columns"),
        apiFetch("/api/app-settings"),
        apiFetch("/api/onboarding"),
        apiFetch("/api/db/status"),
      ].map(p => p.then(r => r.status)))`);
    check('every free route answers', free.every((s) => s === 200));

    const paid = await evalJs(`Promise.all([
        apiFetch("/api/forecast"),
        apiFetch("/api/trends"),
        apiFetch("/api/top-merchants"),
        apiFetch("/api/transfers"),
        apiFetch("/api/recurring"),
        apiFetch("/api/report-card"),
        apiFetch("/api/portfolio/data"),
        apiFetch("/api/predictions/upcoming"),
      ].map(p => p.then(r => r.status)))`);
    check('every paid route answers 402', paid.every((s) => s === 402));

    // Those probes were real 402s, so core/api.js raised the screen exactly as
    // it would for a paid page reached by URL rather than by the nav. That is
    // the 'blocked' path, and it is worth pinning here rather than staging
    // separately, since nothing else in this script produces one.
    check('a refused route raises the screen', await evalJs(
      'document.documentElement.dataset.licenseGate === "on"'
    ));
    // Put it back down WITHOUT closeGate(), whose 'blocked' path would leave
    // for /transactions and take every dashboard assertion below with it.
    await evalJs('document.documentElement.dataset.licenseGate = "off"');
    await settle();

    // A locked link is INERT: no hover, no click, and out of the tab order, so it
    // offers no action the app will refuse. Clicking one must do nothing: no
    // navigation, and no activation screen.
    check('locked links take no pointer', await evalJs(
      '[...document.querySelectorAll(".nav a[data-paid]")]'
      + '.every(l => getComputedStyle(l).pointerEvents === "none")'
    ));
    check('and are out of the tab order', await evalJs(
      '[...document.querySelectorAll(".nav a[data-paid]")]'
      + '.every(l => l.tabIndex === -1 && l.getAttribute("aria-disabled") === "true")'
    ));
    await evalJs('document.querySelector(".nav a[data-paid]").click()');
    await settle();
    check('clicking one does nothing', await evalJs(
      'document.documentElement.dataset.licenseGate !== "on" && location.pathname === "/"'
    ));

    // The bug in the nav-only version: the dashboard's empty-state cards render
    // links into Statements, which are not in the nav, so they bypassed the lock.
    // Any link to a paid PAGE must be intercepted, wherever it was rendered.
    // :not([data-paid]) matters: the sidebar's Statements link comes first in the
    // DOM, and it is the one link that must stay inert.
    check('the dashboard really does link into a paid page', await evalJs(
      '!!document.querySelector(\'a[href^="/statements"]:not([data-paid])\')'
    ));
    await evalJs('document.querySelector(\'a[href^="/statements"]:not([data-paid])\').click()');
    await settle();
    check('an in-page link raises the screen instead', await evalJs(
      'document.documentElement.dataset.licenseGate === "on"'
      + ' && location.pathname === "/"'
    ));
    await evalJs('document.documentElement.dataset.licenseGate = "off"');
    await settle();

    // ── Opening and closing the screen ────────────────────────────────────
    // The Unlock button is the only door in the nav, but not the only door.
    await evalJs('document.querySelector("[data-license-unlock]").click()');
    await settle();
    check('the Unlock button raises the screen', await evalJs(
      'document.documentElement.dataset.licenseGate === "on"'
      + ' && getComputedStyle(document.querySelector("[data-activation-screen]")).display === "flex"'
    ));
    check('the key field has focus', await evalJs(
      'document.activeElement === document.querySelector("[data-license-input]")'
    ));
    check('the lead line is the one in the markup', await evalJs(
      'document.querySelector("[data-gate-lead]").textContent.trim()'
      + '.startsWith("Aventurine is a paid app")'
    ));
    check('the activation URL is a live control', await evalJs(
      '(() => { const b = document.querySelector("[data-license-open]");'
      + ' return !!b && b.tagName === "BUTTON"'
      + ' && b.closest(".license-gate-steps li") !== null'
      + ' && b.textContent.includes("aventurine-app.com/activate"); })()'
    ));

    // Closing is the difference from the lockout: there is a usable app behind
    // the screen.
    await evalJs('document.querySelector("[data-license-close]").click()');
    await settle();
    check('it closes again', await evalJs(
      'document.documentElement.dataset.licenseGate === "off"'
      + ' && location.pathname === "/"'
    ));

    // ── Activating lights the rest up ─────────────────────────────────────
    // installDevLicense writes license.json directly, matching what a successful
    // activate would have produced, so refreshing the panel is the correct last
    // step.
    require('./lib/dev-license').installDevLicense();
    await evalJs('window.licenseActions.refresh()');
    await settle(400);

    check('the tier becomes full', await evalJs(
      'document.documentElement.dataset.licenseTier === "full"'
    ));
    check('Year to Year appears', await evalJs(
      'getComputedStyle(document.querySelector("#dashboard-section-overtime")).display !== "none"'
    ));
    check('the locks come off the nav', await evalJs(
      '[...document.querySelectorAll(".nav a[data-paid]")]'
      + '.every(l => getComputedStyle(l.querySelector(".nav-lock")).display === "none"'
      + ' && getComputedStyle(l).pointerEvents !== "none"'
      + ' && l.tabIndex !== -1 && !l.hasAttribute("aria-disabled"))'
    ));
    check('the Unlock button retires', await evalJs(
      'getComputedStyle(document.querySelector("[data-license-unlock]")).display === "none"'
    ));
    check('About now names the licensee', await evalJs(
      'document.querySelector("[data-about-license-section]").hidden === false'
      + ' && document.querySelector("[data-about-license]").textContent === "dev@localhost"'
    ));
    check('the next launch will not flash the free layout', await evalJs(
      'localStorage.getItem("license-activated") === "1"'
    ));
    const paidNow = await evalJs(`Promise.all([
        apiFetch("/api/trends"),
        apiFetch("/api/recurring"),
        apiFetch("/api/forecast"),
      ].map(p => p.then(r => r.status)))`);
    check('paid routes answer', paidNow.every((s) => s === 200));

    // ── Deactivating from About ───────────────────────────────────────────
    // Preferences is opened alongside About to prove the modal sweep is not
    // special-cased to the one the click came from.
    await evalJs('document.querySelector("[data-action=\'open-about\']").click()');
    await evalJs('document.querySelector("[data-modal=\'preferences\']").hidden = false');
    check('About is open before deactivating', await evalJs(
      'document.querySelector("[data-modal=\'about\']").hidden === false'
    ));

    // Deactivate confirms first, and Cancel must cancel: a confirm step that
    // deactivates anyway is worse than no confirm step.
    await evalJs('document.querySelector("[data-license-remove]").click()');
    await settle(200);
    check('Deactivate asks before acting', await evalJs(
      'document.querySelector("[data-modal=\'license-deactivate\']").hidden === false'
      + ' && document.documentElement.dataset.licenseTier === "full"'
    ));
    await evalJs('document.querySelector("[data-license-remove-cancel]").click()');
    await settle(200);
    check('cancelling deactivates nothing', await evalJs(
      'document.querySelector("[data-modal=\'license-deactivate\']").hidden === true'
      + ' && document.documentElement.dataset.licenseTier === "full"'
    ));
    check('and leaves About where it was', await evalJs(
      'document.querySelector("[data-modal=\'about\']").hidden === false'
    ));
    check('cancelling really did not deactivate', await evalJs(
      'apiFetch("/api/license").then(r => r.json()).then(b => b.licensed === true)'
    ));

    await evalJs('document.querySelector("[data-license-remove]").click()');
    await settle(200);
    await evalJs('document.querySelector("[data-license-remove-confirm]").click()');

    // Deactivation reloads: the page behind the modal may be showing paid data
    // the free tier cannot reload. So the window has to be waited for again
    // rather than talked to through a handle that is mid-navigation.
    await settle(600);
    win = await waitForWindow();
    await settle(600);

    check('deactivating drops the tier', await evalJs(
      'document.documentElement.dataset.licenseTier === "free"'
    ));
    check('and takes Year to Year away again', await evalJs(
      'getComputedStyle(document.querySelector("#dashboard-section-overtime")).display === "none"'
    ));
    check('and closes every chrome modal', await evalJs(
      '[...document.querySelectorAll(".settings-modal-overlay, .db-modal-overlay")]'
      + '.every(m => m.hidden === true)'
    ));
    check('paid routes are shut again', await evalJs(
      'apiFetch("/api/trends").then(r => r.status === 402)'
    ));
    check('the ledger is not', await evalJs(
      'apiFetch("/api/transactions").then(r => r.status === 200)'
    ));

  } catch (e) {
    console.error('FAIL  exception:', e.message);
    failed = true;
  }

  console.log(failed ? 'ACTIVATION: FAIL' : 'ACTIVATION: PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
