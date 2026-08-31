'use strict';

// Locked-database verification: boots the REAL app against a throwaway profile
// and asserts, from INSIDE the renderer, the two halves of the locked-database
// rule (see CLAUDE.md).
//
//   1. The sessionStorage dataset cache (core/store.js) persists for an
//      UNENCRYPTED database and refuses to for an encrypted one. Chromium keeps
//      sessionStorage in a LevelDB under the app profile, so a persisted cache
//      is a plaintext mirror of the ledger sitting on disk beside the SQLCipher
//      file — which is exactly what encryption was chosen to prevent.
//   2. Locking blanks the app rather than only dropping the backend's key: the
//      content region goes hidden, the scrim goes opaque, chrome modals close,
//      the cache is dropped, and the prompt cannot be dismissed into a hidden
//      page.
//
// verify-e2e.js cannot cover this: it drives an unencrypted database and never
// locks, so both mechanisms sit in their permissive state throughout. Run with
//   npm run verify:lock
//
// The profile is a fresh mkdtemp, so the encrypt step below rewrites a database
// this script created and nothing else.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir, set AFTER requiring main.js — see the same note in
// verify-e2e.js: main.js re-points userData at the shared dev profile at
// require time, and an earlier setPath would be silently clobbered.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-lock-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
app.setPath('userData', tmp);

// main.js requests the single-instance lock at REQUIRE time, and in dev it has
// already re-pointed userData at the shared 'aventurine-dev' profile — before
// the setPath above can isolate us. So a running `npm start` makes this process
// the losing second instance: main.js calls app.quit(), whenReady never fires,
// and the script would exit 0 having asserted nothing at all. A verification
// that passes vacuously is worse than one that fails, so say so and fail.
if (!app.hasSingleInstanceLock()) {
  console.error('LOCK: FAIL — another Aventurine instance holds the single-instance '
    + 'lock. Close `npm start` (or the installed app) and run this again.');
  process.exit(1);
}

const DEADLINE_MS = 20000;
const PASSPHRASE = 'verify-lock-passphrase';

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
  require('./lib/dev-license').installDevLicense();

  let failed = false;
  const check = (label, cond) => {
    console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
    if (!cond) failed = true;
  };

  try {
    const win = await waitForWindow();
    const evalJs = (js) => win.webContents.executeJavaScript(js, true);

    // dbactions.js reads GET /api/db/status at load and only then answers
    // Store.setPersistence, so every assertion below has to wait for that round
    // trip rather than assume it landed.
    const waitFor = async (js, label) => {
      const t0 = Date.now();
      for (;;) {
        if (await evalJs(js)) return true;
        if (Date.now() - t0 > DEADLINE_MS) {
          console.log(`FAIL  timed out waiting: ${label}`);
          failed = true;
          return false;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const reload = async () => {
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    };

    // How many of Store's three keys are on disk right now.
    const CACHED = 'Object.keys(sessionStorage).filter(k => k.startsWith("fl-store-v2-")).length';

    // ── 1. Unencrypted: the cache is allowed to persist ────────────────────
    check('starts unencrypted and unlocked', await evalJs(
      'apiFetch("/api/db/status").then(r => r.json()).then(s => !s.encrypted && !s.locked)'));

    await waitFor('typeof window.Store === "object"', 'Store global');
    await evalJs('Store.ensure("ie")');
    check('unencrypted DB caches the dataset to sessionStorage',
      await waitFor(`${CACHED} > 0`, 'cache written'));

    // ensure() waits for the persistence answer before it will read the cache,
    // so a gate that never resolved would stall every dataset for the whole
    // PERSIST_WAIT_MS backstop instead of failing outright. The margin is two
    // orders of magnitude, so this pins the stall without pinning a timing.
    await reload();
    const warmMs = await evalJs(`(async () => {
        const t = performance.now();
        await Store.ensure("ie");
        return performance.now() - t;
      })()`);
    check(`warm read is not stalled behind the gate (${warmMs.toFixed(0)}ms)`, warmMs < 500);

    // ── 2. Encrypted: it is not ────────────────────────────────────────────
    const enc = await evalJs(`apiFetch("/api/db/encryption", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: "encrypt", newPassword: ${JSON.stringify(PASSPHRASE)}})
      }).then(r => r.json())`);
    check('database encrypts in place', enc.ok === true && enc.encrypted === true);

    await reload();
    // setPersistence(false) purges on the way down, so the keys written while
    // the database was plaintext must be gone even before anything re-fetches.
    check('encrypting purges the cache an earlier state wrote',
      await waitFor(`${CACHED} === 0`, 'cache purged'));

    await evalJs('Store.ensure("ie")');
    // Give a write the chance to happen before concluding it did not.
    await new Promise((r) => setTimeout(r, 400));
    check('encrypted DB never writes the dataset to sessionStorage',
      (await evalJs(CACHED)) === 0);
    check('encrypted DB still serves the dataset in memory',
      await evalJs('Store.ensure("ie").then(d => !!d && Array.isArray(d.years))'));

    // ── 3. Locking blanks the app ──────────────────────────────────────────
    const locked = await evalJs(`apiFetch("/api/db/lock", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"
      }).then(r => r.json())`);
    check('backend reports the database locked', locked.locked === true);

    // Exactly what autolock.js calls when the idle timer fires.
    await evalJs(`window.dbActions.showUnlock(${JSON.stringify(locked.path)})`);

    check('lock marks the document', await evalJs(
      'document.documentElement.dataset.dbLocked === "1"'));
    check('lock hides the page content', await evalJs(
      'getComputedStyle(document.querySelector(".page")).visibility === "hidden"'));
    // An opaque colour computes to rgb(); the dismissable modes' scrim is an
    // rgba() with alpha 0.55, so this distinguishes cover from blur.
    check('lock makes the scrim opaque', await evalJs(
      'getComputedStyle(document.getElementById("db-modal")).backgroundColor.startsWith("rgb(")'));
    check('unlock prompt is showing', await evalJs(
      'document.getElementById("db-modal").hidden === false'
      + ' && document.getElementById("db-modal-title").textContent === "Unlock Database"'));
    check('lock drops the in-memory and on-disk cache', await evalJs(CACHED) === 0);

    // ── 4. The prompt cannot be dismissed into a hidden page ───────────────
    // "Open a different database…" swaps unlock mode for the dismissable open
    // mode; Cancel there must fall back to the prompt, not hide it.
    await evalJs('document.getElementById("db-switch-open-btn").click()');
    check('switch reaches the dismissable open mode', await evalJs(
      'document.getElementById("db-modal-title").textContent === "Open Database"'));
    await evalJs('document.getElementById("db-cancel-btn").click()');
    check('cancelling a locked app returns to the prompt', await evalJs(
      'document.getElementById("db-modal").hidden === false'
      + ' && document.getElementById("db-modal-title").textContent === "Unlock Database"'));

    // ── 5. Unlocking restores normal service ───────────────────────────────
    const unlocked = await evalJs(`apiFetch("/api/db/unlock", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({password: ${JSON.stringify(PASSPHRASE)}})
      }).then(r => r.json())`);
    check('the passphrase still unlocks', unlocked.ok === true && unlocked.locked === false);

    // ── 6. Encrypt → decrypt → encrypt, through the real UI ────────────────
    // The steps above drive POST /api/db/encryption directly, which proves the
    // persistence gate purges on its own. This drives the modal the user
    // actually uses (core/encryption.js), which ALSO clears sessionStorage and
    // reloads on success — so the round trip is what says whether the two
    // mechanisms agree at every transition rather than only at the first.
    await reload();

    /** Drive the Encryption modal the way Settings → Security → Manage… does. */
    const encryptionModal = async (action, current, next) => {
      await evalJs('window.securityActions.showEncryption()');
      // open() renders optimistically and re-renders once GET /api/db/status
      // lands; submitting before that would pick the wrong action.
      await waitFor(
        'document.querySelector("[data-enc-status]").textContent.length > 0',
        'encryption modal status');
      await evalJs(`(() => {
        const o = document.querySelector('[data-modal="encryption"]');
        const radio = o.querySelector('.enc-action-radio[value=${JSON.stringify(action)}]');
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
        o.querySelector('[data-enc-current-input]').value = ${JSON.stringify(current)};
        o.querySelector('[data-enc-new-input]').value = ${JSON.stringify(next)};
        o.querySelector('[data-enc-confirm-input]').value = ${JSON.stringify(next)};
        o.querySelector('[data-enc-submit]').click();
      })()`);
      // Success reloads; that is the signal the request went through.
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    };

    await encryptionModal('decrypt', PASSPHRASE, '');
    check('decrypting leaves the database unencrypted', await evalJs(
      'apiFetch("/api/db/status").then(r => r.json()).then(s => !s.encrypted)'));
    await evalJs('Store.ensure("ie")');
    check('a decrypted database caches again',
      await waitFor(`${CACHED} > 0`, 'cache restored'));

    await encryptionModal('encrypt', '', PASSPHRASE);
    check('re-encrypting leaves the database encrypted', await evalJs(
      'apiFetch("/api/db/status").then(r => r.json()).then(s => s.encrypted)'));
    check('re-encrypting clears the cache the plaintext phase wrote',
      await waitFor(`${CACHED} === 0`, 'cache cleared again'));
    await evalJs('Store.ensure("ie")');
    await new Promise((r) => setTimeout(r, 400));
    check('and it stays clear', (await evalJs(CACHED)) === 0);
  } catch (err) {
    console.log('FAIL  threw:', err && err.message);
    failed = true;
  }

  console.log(failed ? 'LOCK: FAIL' : 'LOCK: PASS');
  app.exit(failed ? 1 : 0);
});
