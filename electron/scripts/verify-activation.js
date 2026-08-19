'use strict';

// Boots the REAL app entry with NO license against an isolated profile, and
// asserts from inside the renderer that the activation screen is the only
// thing there: the gate is painted, the backend refuses every route but
// /api/license, the title bar's menus are suppressed, and pasting a valid key
// takes it all down.
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
    const win = await waitForWindow();
    const evalJs = (js) => win.webContents.executeJavaScript(js, true);

    // Let shell/license.js finish its first status read.
    await new Promise((r) => setTimeout(r, 600));

    const lic = await evalJs('apiFetch("/api/license").then(r => r.json())');
    check('install reports unactivated', lic.licensed === false);

    check('activation screen is painted', await evalJs(
      'document.documentElement.dataset.licenseGate === "on"'
      + ' && getComputedStyle(document.querySelector("[data-activation-screen]")).display === "flex"'
    ));
    check('it covers the page', await evalJs(
      '(() => { const r = document.querySelector("[data-activation-screen]").getBoundingClientRect();'
      + ' return r.width === window.innerWidth && r.bottom === window.innerHeight && r.top === 40; })()'
    ));
    // Step one's URL is the only way out of the app, and it is a <button>
    // because navigation is locked to the app origin - so it has to be wired,
    // not merely styled.
    check('the activation URL is a live control', await evalJs(
      '(() => { const b = document.querySelector("[data-license-open]");'
      + ' return !!b && b.tagName === "BUTTON"'
      + ' && b.closest(".license-gate-steps li") !== null'
      + ' && b.textContent.includes("aventurine-app.com/activate"); })()'
    ));
    // The lead line lives in chrome.html; license.js only swaps it out to
    // explain a gate that is up for some reason other than a fresh install,
    // and must restore what the markup says. A second copy of the copy in the
    // JS meant editing the markup silently changed nothing.
    check('the lead line is the one in the markup', await evalJs(
      'document.querySelector("[data-gate-lead]").textContent.trim()'
      + '.startsWith("Aventurine is a paid app")'
    ));
    check('the key field has focus', await evalJs(
      'document.activeElement === document.querySelector("[data-license-input]")'
    ));
    check('title bar menus are suppressed', await evalJs(
      'getComputedStyle(document.querySelector(".titlebar-menu")).display === "none"'
    ));
    check('window controls survive', await evalJs(
      'getComputedStyle(document.querySelector(".titlebar-controls")).display !== "none"'
    ));
    check('About names no licensee', await evalJs(
      'document.querySelector("[data-about-license-section]").hidden === true'
    ));

    // The backend half of the lockout: nothing but /api/license answers.
    const probes = await evalJs(`Promise.all([
        apiFetch("/api/data"),
        apiFetch("/api/db/status"),
        apiFetch("/api/transactions"),
        apiFetch("/api/onboarding"),
      ].map(p => p.then(r => r.status)))`);
    check('every data route answers 402', probes.every((s) => s === 402));

    // And pasting a real key takes the whole thing down. installDevLicense
    // writes license.json directly, which is what a successful activate would
    // have produced, so refreshing the panel is the honest last step.
    require('./lib/dev-license').installDevLicense();
    await evalJs('window.licenseActions.refresh()');
    await new Promise((r) => setTimeout(r, 400));

    check('activating lowers the gate', await evalJs(
      'document.documentElement.dataset.licenseGate === "off"'
      + ' && getComputedStyle(document.querySelector("[data-activation-screen]")).display === "none"'
    ));
    check('title bar menus come back', await evalJs(
      'getComputedStyle(document.querySelector(".titlebar-menu")).display !== "none"'
    ));
    check('About now names the licensee', await evalJs(
      'document.querySelector("[data-about-license-section]").hidden === false'
      + ' && document.querySelector("[data-about-license]").textContent === "dev@localhost"'
    ));
    check('the next launch will not flash the gate', await evalJs(
      'localStorage.getItem("license-activated") === "1"'
    ));
    check('data routes answer again', await evalJs(
      'apiFetch("/api/data").then(r => r.status === 200)'
    ));

    // ── Deactivating from About puts the gate back ────────────────────────
    // The button lives inside a modal, so raising the gate has to take that
    // modal down with it — otherwise About stays open over the activation
    // screen, offering controls that address an app which has stopped
    // answering. Preferences is opened alongside it to prove the sweep is not
    // special-cased to the one modal the click came from.
    await evalJs('document.querySelector("[data-action=\'open-about\']").click()');
    await evalJs('document.querySelector("[data-modal=\'preferences\']").hidden = false');
    check('About is open before deactivating', await evalJs(
      'document.querySelector("[data-modal=\'about\']").hidden === false'
    ));

    // Deactivate asks first, and Cancel has to mean it: a confirm step that
    // still deactivates on the way out is worse than no confirm step.
    await evalJs('document.querySelector("[data-license-remove]").click()');
    await new Promise((r) => setTimeout(r, 200));
    check('Deactivate asks before acting', await evalJs(
      'document.querySelector("[data-modal=\'license-deactivate\']").hidden === false'
      + ' && document.documentElement.dataset.licenseGate === "off"'
    ));
    await evalJs('document.querySelector("[data-license-remove-cancel]").click()');
    await new Promise((r) => setTimeout(r, 200));
    check('cancelling deactivates nothing', await evalJs(
      'document.querySelector("[data-modal=\'license-deactivate\']").hidden === true'
      + ' && document.documentElement.dataset.licenseGate === "off"'
    ));
    check('and leaves About where it was', await evalJs(
      'document.querySelector("[data-modal=\'about\']").hidden === false'
    ));
    check('cancelling really did not deactivate', await evalJs(
      'apiFetch("/api/license").then(r => r.json()).then(b => b.licensed === true)'
    ));

    await evalJs('document.querySelector("[data-license-remove]").click()');
    await new Promise((r) => setTimeout(r, 200));
    await evalJs('document.querySelector("[data-license-remove-confirm]").click()');
    await new Promise((r) => setTimeout(r, 400));

    check('deactivating raises the gate', await evalJs(
      'document.documentElement.dataset.licenseGate === "on"'
      + ' && getComputedStyle(document.querySelector("[data-activation-screen]")).display === "flex"'
    ));
    check('and closes every chrome modal behind it', await evalJs(
      '[...document.querySelectorAll(".settings-modal-overlay, .db-modal-overlay")]'
      + '.every(m => m.hidden === true)'
    ));
    check('data routes are shut again', await evalJs(
      'apiFetch("/api/data").then(r => r.status === 402)'
    ));


  } catch (e) {
    console.error('FAIL  exception:', e.message);
    failed = true;
  }

  console.log(failed ? 'ACTIVATION: FAIL' : 'ACTIVATION: PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
