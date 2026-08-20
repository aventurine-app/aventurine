'use strict';

// Boots the REAL app entry with NO license against an isolated profile, and
// asserts from inside the renderer that the SOFT gate is what it claims to be:
// the ledger works, the paid destinations do not, the activation screen opens
// and closes on request, and pasting a valid key lights the rest up.
//
// The renderer half matters more here than it did under the total lockout. Then
// there was one state and it covered everything; now the free tier is a real
// layout that a stylesheet decides, so "did the paid section actually stay
// hidden" is a question only a running window can answer.
//
// The counterpart to verify-e2e.js, which installs a throwaway license and so
// never exercises this path at all.
//
//   npx electron scripts/verify-activation.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-act-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
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

    // The one section the backend cannot defend, so the stylesheet is all
    // there is. If this ever passes by accident the free tier is giving away
    // the thing it exists to sell.
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
        apiFetch("/api/recurring"),
        apiFetch("/api/report-card"),
        apiFetch("/api/portfolio/data"),
        apiFetch("/api/credit-cards/data"),
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

    // A locked link is INERT. No hover, no click, and out of the tab order, so
    // it cannot promise an action the app will refuse. Clicking one has to do
    // nothing at all: not navigate, and not raise the screen either.
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

    // The bug the nav-only version had: the dashboard's empty-state cards render
    // their own links into Statements, and those are not in the nav, so they
    // walked straight past the lock. Anything pointing at a paid PAGE has to be
    // answered, wherever it was drawn.
    // :not([data-paid]) matters: the sidebar's own Statements link comes first
    // in the DOM, and it is the one link that must stay silent.
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

    // Closing is the whole difference from the lockout: there is an app back
    // there, and the user asked to see it.
    await evalJs('document.querySelector("[data-license-close]").click()');
    await settle();
    check('it closes again', await evalJs(
      'document.documentElement.dataset.licenseGate === "off"'
      + ' && location.pathname === "/"'
    ));

    // ── Activating lights the rest up ─────────────────────────────────────
    // installDevLicense writes license.json directly, which is what a
    // successful activate would have produced, so refreshing the panel is the
    // honest last step.
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

    // Deactivate asks first, and Cancel has to mean it: a confirm step that
    // still deactivates on the way out is worse than no confirm step.
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
