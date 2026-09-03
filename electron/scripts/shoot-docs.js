'use strict';

// Documentation screenshot capture for the Obsidian user guide
// (../../aventurine-docs/content, whose assets/ these land in). Boots the real
// app against a throwaway profile, walks every screen, and writes one PNG per
// thing the docs need to show.
//
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
//       --no-sandbox scripts/shoot-docs.js
//
// Output goes to $SHOT_OUT (default: the temp profile).
//
// ISOLATION — both of these matter:
//   • userData is re-pointed AFTER requiring main.js (main.js re-points it at
//     the shared dev profile at require time), so nothing touches the dev DB.
//   • documents is re-pointed too. startBackend() hands the real Documents
//     folder to the backend, and a NEW database is proposed at
//     <Documents>/Aventurine — without this, creating one writes into the
//     user's actual Documents folder.
//
// DATA — invented, from a seeded generator, so a re-run produces the identical
// picture and a screenshot changes only when the UI does. The 24-month history
// carries explicit categories (no dependence on the merchant lexicon); the small
// demo import at the end is messier, so the import flow, the duplicate badges,
// the error banner and the uncategorized backlog all have data to show.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-shots-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
app.setPath('userData', tmp);
app.setPath('documents', path.join(tmp, 'Documents'));

const OUT = process.env.SHOT_OUT || tmp;
const ONLY = process.env.SHOT_ONLY ? new Set(process.env.SHOT_ONLY.split(',')) : null;
// Layout stays at 1400×900 DIPs whatever the scale — only the pixel density of
// the PNG changes, so a crop framed for the docs frames identically at 2x. Needs
// the runtime flag to match: --force-device-scale-factor=2 SHOT_SCALE=2, which
// is how the website's marketing shots are taken. Docs default to 1.
const SCALE = Number(process.env.SHOT_SCALE) || 1;
// Window size in DIPs. The docs are written against 1400×900 — widening it
// changes what fits (the Recurring merchant column, the ledger's last columns),
// so only override it for one-off captures, never for a docs refresh.
const W = Number(process.env.SHOT_W) || 1400;
const H = Number(process.env.SHOT_H) || 900;
const DEADLINE_MS = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ── The invented household ───────────────────────────────────────────────────

let seed = 20260726;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** [{year, month}] for the last `n` months, oldest first, ending this month. */
function recentMonths(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = now.getFullYear() * 12 + now.getMonth() - i;
    out.push({ year: Math.floor(t / 12), month: (t % 12) + 1 });
  }
  return out;
}

// Which account each kind of spending is put on, so the ledger's Account column
// reads like a real household's rather than one endless column of "Checking".
const ON_CARD = new Set(['food', 'shopping', 'entertainment', 'travel', 'general']);

function buildRows(catId) {
  const months = recentMonths(24);
  const today = new Date();
  const rows = [];
  const push = (y, m, d, description, key, amount, txType) => {
    if (y === today.getFullYear() && m === today.getMonth() + 1 && d > today.getDate()) return;
    rows.push({
      date: iso(y, m, Math.min(d, 28)),
      description,
      amount,
      tx_type: txType,
      category_id: catId[key],
      _account: ON_CARD.has(key) ? 'card' : 'checking',
    });
  };

  months.forEach(({ year, month }, i) => {
    const raise = 1 + i * 0.004;   // a slow, believable drift upward

    push(year, month, 1,  'PAYROLL DEPOSIT NORTHWIND', 'income', Math.round(2780 * raise * 100) / 100, 'income');
    push(year, month, 15, 'PAYROLL DEPOSIT NORTHWIND', 'income', Math.round(2780 * raise * 100) / 100, 'income');
    if (rnd() > 0.6) push(year, month, 22, 'REFUND CLEARWATER GOODS', 'other_income', between(60, 380), 'income');

    push(year, month, 2,  'HARBOR RIDGE PROPERTY MGMT', 'rent', 1850, 'expense');
    push(year, month, 6,  'CITY POWER & WATER DEPT', 'utilities', between(96, 178), 'expense');
    push(year, month, 8,  'FIBERLINE INTERNET', 'utilities', 74.99, 'expense');
    push(year, month, 12, 'MERIDIAN MUTUAL AUTO POLICY', 'insurance', 142, 'expense');
    push(year, month, 4,  'STREAMBOX MONTHLY', 'entertainment', 15.49, 'expense');
    push(year, month, 9,  'TIDEWATER MUSIC', 'entertainment', 11.99, 'expense');
    push(year, month, 3,  'IRONWORKS FITNESS', 'health', 42, 'expense');

    for (let k = 0; k < 7; k++) {
      push(year, month, 2 + k * 4, 'NORTHGATE FARMERS MARKET', 'food', between(48, 142), 'expense');
    }
    for (let k = 0; k < 6; k++) {
      push(year, month, 3 + k * 4, ['CORNER COFFEE HOUSE', 'PALOMA TAQUERIA', 'BRICK OVEN PIZZERIA'][k % 3],
        'food', between(9, 47), 'expense');
    }

    for (let k = 0; k < 3; k++) {
      push(year, month, 5 + k * 9, 'WESTVIEW FUEL', 'automobile', between(36, 68), 'expense');
    }
    if (rnd() > 0.5) push(year, month, 17, 'METRO TRANSIT PASS', 'automobile', 68, 'expense');
    if (rnd() > 0.8) push(year, month, 21, 'CEDAR AUTO REPAIR', 'automobile', between(120, 480), 'expense');

    for (let k = 0; k < 3; k++) {
      push(year, month, 7 + k * 7, ['LANTERN DEPARTMENT STORE', 'PAPERTRAIL BOOKS', 'FIELDSTONE OUTFITTERS'][k],
        'shopping', between(22, 165), 'expense');
    }
    if (rnd() > 0.75) push(year, month, 14, 'SUMMIT AIR LINES', 'travel', between(280, 890), 'expense');
    if (rnd() > 0.55) push(year, month, 19, 'HARBOR PHARMACY', 'health', between(14, 95), 'expense');
    push(year, month, 24, 'MISC HOUSEHOLD', 'general', between(18, 90), 'expense');

    push(year, month, 16, 'TRANSFER TO EMERGENCY FUND', 'savings', 600, 'transfer');
    push(year, month, 16, 'BROKERAGE CONTRIBUTION', 'investing', 500, 'transfer');
  });

  return rows;
}

/** Month-end balances per account, drifting the way real ones do. */
function buildBalances(keys) {
  const months = recentMonths(24);
  const out = [];
  let checking = 3900, fund = 8200, brokerage = 21400, retirement = 38800, card = 1450;
  months.forEach(({ year, month }, i) => {
    checking   = Math.max(1200, checking + between(-700, 900));
    fund       += 600 + between(-40, 120);
    brokerage  += 500 + between(-380, 1150) + i * 12;
    retirement += 950 + between(-520, 1680) + i * 18;
    card       = Math.min(3200, Math.max(420, card + between(-620, 700)));
    const set = (key, value) => out.push({
      year, month: MONTHS[month - 1], category: key, value: Math.round(value * 100) / 100,
    });
    set(keys.checking, checking);
    set(keys.fund, fund);
    set(keys.brokerage, brokerage);
    set(keys.retirement, retirement);
    set(keys.card, card);
  });
  return out;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function waitForWindow() {
  const t0 = Date.now();
  for (;;) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    if (Date.now() - t0 > DEADLINE_MS) throw new Error('window never finished loading');
    await sleep(200);
  }
}

app.whenReady().then(async () => {
  // The real app is read-only until activated; give this run a throwaway
  // license so the script exercises features instead of the 402 gate.
  require('./lib/dev-license').installDevLicense();

  const missing = [];
  try {
    const win = await waitForWindow();
    win.setContentSize(W, H);
    await sleep(400);

    const js = (code) => win.webContents.executeJavaScript(code, true);
    const post = (url, body) =>
      js(`apiFetch(${JSON.stringify(url)}, { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.json())`);

    // The Recurring page lists only the schedules the user adopted from its
    // detection dialog, so a freshly seeded profile lands there empty. Adopt
    // whatever detection found first — these shots document the settled page,
    // and the picker is captured separately. Idempotent: an adopted series
    // stops being offered, so a re-run finds nothing left to do.
    const adoptRecurring = async () => {
      const { candidates } = await js('apiFetch("/api/recurring/candidates").then(r => r.json())');
      if (candidates.length) await post('/api/recurring/adopt', { keys: candidates.map((s) => s.key) });
      return candidates.length;
    };

    // Screens are captured in named phases so a single one can be re-run while
    // iterating: SHOT_ONLY=transactions,import
    const phase = (name) => !ONLY || ONLY.has(name);

    // One bad rect (an element scrolled off-screen) makes capturePage throw
    // UnknownVizError; that must cost one screenshot, not the whole run.
    const shot = async (name, rect) => {
      try {
        const img = await win.webContents.capturePage(rect);
        fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG({ scaleFactor: SCALE }));
        const s = img.getSize();
        console.log(`  ${name}.png  ${s.width * SCALE}×${s.height * SCALE}`);
      } catch (e) {
        missing.push(`${name} (capture failed: ${e.message})`);
        console.log(`  !! ${name} — ${e.message}`);
      }
    };

    const rectOf = (selector) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()`);

    /** Bring an element into the viewport before cropping or hovering it — the
     *  statement tables scroll sideways, so a late column starts off-screen. */
    const scrollTo = async (selector, block = 'center') => {
      await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'center' });
      })()`);
      await sleep(350);
    };

    /** Crop to one element, with a little air around it. Clamped to the window:
     *  a rect that runs off-screen is not a screenshot, it is a crash. */
    const shotEl = async (name, selector, pad = 10) => {
      let r = await rectOf(selector);
      // A card below the fold has a valid rect that the window cannot show. Pull
      // it into view and re-measure rather than losing the shot: the dashboard's
      // third month card sits past 900px and used to fail every run.
      //
      // A card TALLER than the window (Top Merchants is 20 rows) cannot fit, so
      // centring it clips both ends and pulls the title bar into the crop. Those
      // are anchored to their top instead, with the crop running to the bottom
      // edge; a list cut off after row N is still legible as a list.
      if (r && (r.y + r.height > H || r.y < 0)) {
        await scrollTo(selector, r.height + pad * 2 > H ? 'start' : 'center');
        r = await rectOf(selector);
      }
      if (!r || r.width < 2 || r.height < 2) { missing.push(`${name} (${selector})`); return; }
      const x = Math.min(Math.max(0, Math.round(r.x - pad)), W - 2);
      const y = Math.min(Math.max(0, Math.round(r.y - pad)), H - 2);
      const width = Math.max(2, Math.min(W - x, Math.round(r.width + pad * 2)));
      const height = Math.max(2, Math.min(H - y, Math.round(r.height + pad * 2)));
      if (r.x > W || r.y > H || r.x + r.width < 0 || r.y + r.height < 0) {
        missing.push(`${name} (off-screen)`);
        return;
      }
      await shot(name, { x, y, width, height });
    };

    /** Full window, trimmed to where the page content actually ends — a
     *  screenshot with 200px of empty background reads as a mistake. */
    const shotPage = async (name, selector = '.page > *', pad = 24) => {
      const bottom = await js(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        return els.reduce((m, el) => Math.max(m, el.getBoundingClientRect().bottom), 0);
      })()`);
      await shot(name, { x: 0, y: 0, width: W, height: Math.min(H, Math.round(bottom) + pad) });
    };

    const shotWin = (name) => shot(name);

    const click = (selector) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

    /** Real mouse move, so :hover styling (the ↺ revert button, row hovers)
     *  actually appears in the capture. */
    const hover = async (selector) => {
      const r = await rectOf(selector);
      if (!r) { missing.push(`hover ${selector}`); return; }
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      });
      await sleep(250);
    };

    /** Park the pointer where it can't tint anything (OS hover artifacts). */
    const unhover = async () => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: W - 4, y: H - 4 });
      await sleep(150);
    };

    /** Drag across a block of grid cells, so a real selection is on screen. */
    const dragCells = async (fromSel, toSel) => {
      const a = await rectOf(fromSel);
      const b = await rectOf(toSel);
      if (!a || !b) { missing.push(`drag ${fromSel} → ${toSel}`); return; }
      const pt = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      const p1 = pt(a); const p2 = pt(b);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...p1, button: 'left', clickCount: 1 });
      await sleep(60);
      for (let i = 1; i <= 6; i++) {
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(p1.x + ((p2.x - p1.x) * i) / 6),
          y: Math.round(p1.y + ((p2.y - p1.y) * i) / 6),
        });
        await sleep(40);
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', ...p2, button: 'left', clickCount: 1 });
      await sleep(250);
    };

    const nav = async (route, settle = 2200) => {
      await js(`window.location.href = "app://aventurine${route}"`);
      await sleep(settle);
    };

    /** Switch the app's colour theme for a capture. theme-init.js reads
     *  'color-theme' from localStorage BEFORE first paint, so the value must be
     *  written before the navigation that should show it; changing it on a live
     *  page does not reproduce what the app does on launch. '' is the default
     *  light theme; 'dark' is used for the site's dashboard shot. */
    const setTheme = (value) =>
      js(`localStorage.setItem('color-theme', ${JSON.stringify(value)})`);

    /** Switch the chart palette for a capture. A SECOND axis from the surface
     *  theme above, read pre-paint by the same theme-init.js, so it has the same
     *  rule: write it before the navigation that should show it. '' is the
     *  accent-derived default ramp; 'gemstone' is the jewel-toned one the
     *  website's shots are taken in. */
    const setGraphTheme = (value) =>
      js(`localStorage.setItem('graph-theme', ${JSON.stringify(value)})`);

    const esc = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

    /** Answer the import's account question. With several accounts adopted the app
     *  pre-selects nothing on a first import, so the primary button stays disabled
     *  until something is chosen; this selects one rather than clicking the
     *  disabled button. */
    const pickImportAccount = async (key) => {
      const ok = await js(`(() => {
        const r = document.querySelector('.tx-import-dialog input[type="radio"][value="' + ${JSON.stringify(key)} + '"]')
          || document.querySelector('.tx-import-dialog input[type="radio"]');
        if (!r) return false;
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!ok) missing.push('import account radio');
      await sleep(300);
    };

    // ═══ Phase 1: a fresh database — first run ═══════════════════════════════
    if (phase('firstrun')) {
      console.log('\n— first run —');
      await sleep(700);
      await shotPage('firstrun-hero', '.dashboard-firstrun');
      await click('#dashboard-firstrun-start');
      await sleep(600);
      await shotEl('firstrun-account-picker', '.onb-dialog');
      await js(`(() => {
        const r = document.querySelector('.onb-dialog input[value="new:checking"]');
        r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
        const n = document.querySelector('.acct-custom-name');
        n.value = 'Everyday Checking';
        n.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(300);
      await shotEl('firstrun-account-named', '.onb-dialog');
      await click('.onb-close');
      await sleep(400);
    }

    // ═══ Seed ════════════════════════════════════════════════════════════════
    console.log('\n— seeding —');
    const status = await js('apiFetch("/api/db/status").then(r => r.json())');
    const made = await post('/api/db/create',
      { path: path.join(status.default_dir, 'Household.db'), encrypt: false });
    if (!made || made.ok !== true) throw new Error('db create failed: ' + JSON.stringify(made));
    await sleep(600);
    console.log('  database:', (await js('apiFetch("/api/db/status").then(r => r.json())')).path);

    const mkCol = async (label, type) =>
      (await post('/api/balance/columns', { label, type })).column.key;
    const keys = {
      checking:   await mkCol('Everyday Checking', 'cash'),
      fund:       await mkCol('Emergency Fund', 'cash'),
      brokerage:  await mkCol('Brokerage', 'investment'),
      retirement: await mkCol('Work 401(k)', 'retirement'),
      card:       await mkCol('Everyday Card', 'debt'),
    };

    const cats = await js('apiFetch("/api/categories").then(r => r.json())');
    const catId = {};
    const catName = {};
    for (const c of cats.categories) { catId[c.key] = c.id; catName[c.key] = c.name; }

    const all = buildRows(catId);
    const strip = (r) => { const rest = { ...r }; delete rest._account; return rest; };
    for (const which of ['checking', 'card']) {
      const rows = all.filter((r) => r._account === which).map(strip);
      const res = await post('/api/transactions/import', { rows, account_key: keys[which] });
      console.log(`  ${which}: ${res.inserted} transactions`);
    }

    const balances = buildBalances(keys);
    for (const b of balances) await post('/api/balance/entry', b);
    console.log(`  ${balances.length} balance cells`);

    // One hand-typed override, so the Cash Flow statement can show both states
    // in a single crop: April's Primary Income typed over, every other month in
    // that column still computed from the transactions.
    const now = new Date();
    await post('/api/entry', {
      year: now.getFullYear(), month: 'April', category: 'income', value: 6100,
    });

    await js('sessionStorage.clear()');

    // ═══ Phase 2: the dashboard ══════════════════════════════════════════════
    if (phase('dashboard')) {
      console.log('\n— dashboard —');
      await nav('/', 3200);
      const filled = await js(`(() => ({
        cashflow: !!document.querySelector('#mcf-chart svg'),
        spending: !!document.querySelector('#spending-chart svg'),
        snapshot: !!document.querySelector('#accounts-pie svg'),
      }))()`);
      if (!filled.cashflow || !filled.spending || !filled.snapshot) {
        throw new Error('month cards did not render data: ' + JSON.stringify(filled));
      }
      await unhover();
      await shotPage('dashboard-month-to-month', '#dashboard-section-month .dashboard-card');
      await shotEl('dashboard-month-stepper', '#dashboard-month', 8);
      await shotEl('dashboard-monthly-cash-flow', '#dashboard-section-month .dashboard-card:nth-child(1)');
      await shotEl('dashboard-capital-snapshot', '#dashboard-section-month .accounts-card');
      await shotEl('dashboard-spending', '#dashboard-section-month .dashboard-card:nth-child(3)');

      // Year to Year is the second section down the same page (it used to be a
      // tab), so it has to be scrolled to rather than clicked to.
      await scrollTo('#dashboard-section-overtime');
      await sleep(2600);
      await unhover();
      await shotEl('dashboard-year-to-year', '#dashboard-section-overtime', 24);
      await shotEl('dashboard-range-picker', '#dashboard-range', 8);
      await shotEl('dashboard-net-worth', '.networth-card');
      await shotEl('dashboard-account-balances', '#dashboard-section-overtime .dashboard-card:nth-child(2)');
      await shotEl('dashboard-income-expenses', '#dashboard-section-overtime .dashboard-card:nth-child(3)');
    }

    // ═══ Phase 3: window chrome ══════════════════════════════════════════════
    if (phase('chrome')) {
      console.log('\n— chrome —');
      await shotEl('chrome-title-bar', '.titlebar', 0);
      await click('.titlebar-menu-item[data-menu="file"]');
      await sleep(300);
      await shot('chrome-file-menu', { x: 0, y: 0, width: 420, height: 200 });
      await esc();
      await click('.titlebar-menu-item[data-menu="settings"]');
      await sleep(300);
      await shot('chrome-settings-menu', { x: 0, y: 0, width: 420, height: 200 });
      await esc();
      await sleep(200);
    }

    // ═══ Phase 4: the import flow ════════════════════════════════════════════
    // Run before the Transactions captures on purpose: it is what leaves the
    // uncategorized backlog those screenshots (and the sidebar badge) need.
    if (phase('import')) {
      console.log('\n— import —');
      await nav('/transactions', 2500);

      // Two rows lifted verbatim from what is already in the ledger, so the
      // duplicate badges in the capture are real ones the app found.
      const ledger = await js('apiFetch("/api/transactions").then(r => r.json())');
      const recent = ledger.transactions.filter((t) => t.date.startsWith(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)).slice(0, 2);

      const csvRows = [
        'Posting Date,Description,Amount,Balance',
        ...recent.map((t) => `${t.date},${t.description},-${t.amount.toFixed(2)},2413.19`),
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 5))},TRADER JOE S #221 SEATTLE WA,-84.12,2329.07`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 5))},SQ *CORNER COFFEE HOUSE 4471,-6.75,2322.32`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 4))},RIVERSIDE CINEMA 0231,-31.00,2291.32`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 4))},ACH DEBIT KLARWATER UTIL 0099,-88.40,2202.92`,
        // The same unnamed shop four times, with a different terminal number
        // each visit — what "find similar" at 80% is actually for.
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 3))},POS PURCHASE 4829 QX MKT 118,-52.18,2150.74`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 6))},POS PURCHASE 5120 QX MKT 118,-31.40,2119.34`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 8))},POS PURCHASE 6633 QX MKT 118,-77.05,2042.29`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 9))},POS PURCHASE 7014 QX MKT 118,-44.90,1997.39`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 3))},HALVORSEN & REED LLP,-420.00,1730.74`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 2))},WESTVIEW FUEL,-44.10,1686.64`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 2))},CHECK 2291,-160.00,1526.64`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 1))},HARBOR PHARMACY 22,-24.80,1501.84`,
        `${iso(now.getFullYear(), now.getMonth() + 1, Math.max(1, now.getDate() - 1))},PALOMA TAQUERIA,-18.45,1483.39`,
        'TOTALS,,,,',   // the summary row banks love — becomes the error banner
      ].join('\n');

      await js(`(() => {
        window.__csv = ${JSON.stringify(csvRows)};
        const realClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
          if (this.type !== 'file') return realClick.apply(this, arguments);
          const dt = new DataTransfer();
          dt.items.add(new File([window.__csv], 'everyday-checking-july.csv', { type: 'text/csv' }));
          this.files = dt.files;
          setTimeout(() => this.dispatchEvent(new Event('change')), 30);
        };
      })()`);

      await js('window.__p = TxFileImport.run(); "started"');
      await sleep(900);
      await pickImportAccount(keys.checking);
      await shotEl('import-account-question', '.tx-import-dialog');
      await click('.tx-import-acct-next');
      await sleep(1500);
      await shotEl('import-map-columns', '.tx-import-dialog');
      await shotEl('import-map-preview', '.tx-import-preview-wrap', 6);
      await click('.tx-import-continue-btn');
      await sleep(1800);
      await shotEl('import-here-is-your-import', '.tx-import-dialog');
      await shotEl('import-error-banner', '.tx-import-errors-banner', 6);
      await shotEl('import-uncategorized-note', '.tx-import-balance-bar', 6);
      const dupRect = await rectOf('.tx-import-row-dup');
      if (dupRect) {
        await shot('import-duplicate-rows', {
          x: Math.round(dupRect.x - 8), y: Math.round(dupRect.y - 34),
          width: Math.min(W - Math.round(dupRect.x - 8), Math.round(dupRect.width + 16)),
          height: 120,
        });
      } else missing.push('import-duplicate-rows');
      await click('.tx-import-do-btn');
      await sleep(2500);
      await shotEl('import-success', '.tx-import-dialog--success');
      await click('.tx-import-finish-btn');
      await sleep(2000);
    }

    // ═══ Phase 5: a split debit/credit file, for the mapping page ════════════
    if (phase('import')) {
      await nav('/transactions', 2500);
      const splitCsv = [
        'Date;Details;Withdrawal Amount;Deposit Amount',
        '02.07.2026;NORTHGATE FARMERS MARKET;61,40;',
        '03.07.2026;PAYROLL DEPOSIT NORTHWIND;;2.790,10',
        '05.07.2026;WESTVIEW FUEL;48,20;',
        '08.07.2026;LANTERN DEPARTMENT STORE;112,75;',
      ].join('\n');
      await js(`(() => {
        window.__csv2 = ${JSON.stringify(splitCsv)};
        const realClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
          if (this.type !== 'file') return realClick.apply(this, arguments);
          const dt = new DataTransfer();
          dt.items.add(new File([window.__csv2], 'euro-bank-export.csv', { type: 'text/csv' }));
          this.files = dt.files;
          setTimeout(() => this.dispatchEvent(new Event('change')), 30);
        };
      })()`);
      await js('window.__p2 = TxFileImport.run(); "started"');
      await sleep(900);
      await pickImportAccount(keys.checking);
      await click('.tx-import-acct-next');
      await sleep(1500);
      await shotEl('import-map-columns-split', '.tx-import-dialog');
      await click('.tx-import-close');
      await sleep(400);
    }

    // ═══ Phase 6: the transactions ledger ════════════════════════════════════
    if (phase('transactions')) {
      console.log('\n— transactions —');
      await nav('/transactions', 2500);
      await unhover();
      await shotWin('transactions-page');
      await shotEl('transactions-chips', '.tx-chips', 8);
      await shotEl('sidebar', '.menu', 0);

      // A few rows, close up: category pills, account tags, signed amounts.
      const rows = await js(`(() => {
        const tb = document.getElementById('tx-tbody');
        const b = tb.getBoundingClientRect();
        const head = document.querySelector('.tx-header-row').getBoundingClientRect();
        return { x: b.x, y: head.y, width: b.width, height: 250 };
      })()`);
      await shot('transactions-rows', {
        x: Math.round(rows.x), y: Math.round(rows.y),
        width: Math.round(rows.width), height: Math.round(rows.height),
      });

      // The clean merchant name, expanded to reveal the bank's own text. The
      // named row sits well down the list, so scroll it into view before
      // framing it — with the row above for contrast (that one has no name, so
      // it shows the bank's text directly and gets no chevron).
      const revealed = await js(`(() => {
        const btn = document.querySelector('.tx-desc-toggle');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (revealed) {
        await sleep(500);
        await scrollTo('.tx-desc-original');
        const row = await js(`(() => {
          const o = document.querySelector('.tx-desc-original');
          if (!o) return null;
          const b = o.closest('tr').getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        })()`);
        if (row) {
          await shot('transactions-clean-name', {
            x: Math.max(0, Math.round(row.x)),
            y: Math.max(0, Math.round(row.y - 58)),
            width: Math.min(W - Math.max(0, Math.round(row.x)), 900),
            height: Math.min(H - Math.max(0, Math.round(row.y - 58)), Math.round(row.height) + 118),
          });
        } else missing.push('transactions-clean-name');
      } else missing.push('transactions-clean-name');

      // Filter popovers.
      await click('.tx-filter-chip[data-filter="category"] .tx-filter-main');
      await sleep(400);
      await shotEl('transactions-filter-category', '.tx-filter-chip[data-filter="category"]', 8);
      await esc();
      await click('.tx-filter-chip[data-filter="date"] .tx-filter-main');
      await sleep(400);
      await shotEl('transactions-filter-date', '.tx-filter-chip[data-filter="date"]', 8);
      await esc();
      await sleep(200);

      // Filtered to the uncategorized backlog — the working view.
      await js(`(() => {
        const chip = document.querySelector('.tx-filter-chip[data-filter="category"] .tx-filter-main');
        chip.click();
      })()`);
      await sleep(400);
      await js(`(() => {
        const opt = [...document.querySelectorAll('.tx-pop-option')].find(o => o.textContent.trim() === 'Uncategorized');
        if (opt) opt.click();
      })()`);
      await sleep(600);
      await unhover();
      await shotWin('transactions-uncategorized');

      // Selection + the bulk-edit wizard. Narrow to the one shop that appears
      // four times under four terminal numbers, then edit two of them — so the
      // "find similar" step has the other two to offer, which is the whole
      // point of that step.
      await click('#tx-clear-all');
      await sleep(500);
      await click('.tx-filter-chip[data-filter="name"] .tx-filter-main');
      await sleep(400);
      await js(`(() => {
        const input = document.querySelector('.tx-filter-popover input[data-k="name"]');
        if (!input) return false;
        input.value = 'QX MKT';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(500);
      await esc();
      await sleep(400);
      await js(`(() => {
        [...document.querySelectorAll('.tx-row-cb')].slice(0, 2).forEach(cb => {
          cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
      })()`);
      await sleep(300);
      await shotEl('transactions-selection', '.tx-chips-right', 10);
      await click('.tx-edit-btn');
      await sleep(700);
      if (await js('!!document.querySelector(".tx-edit-dialog")')) {
        await shotEl('bulk-edit-step-edit', '.tx-edit-dialog');
        // The edit step is one control row over the rows it rewrites, whatever
        // the selection size, so the category goes in that row and not in the
        // read-only rows below it. This runs after the step-1 shot: it exists to
        // give steps 2 and 3 something to be about, since the cascade searches
        // on the category the control row hands the batch — without it the
        // similar step shoots its own "nothing has a category" empty state.
        await js(`(() => {
          const sel = document.querySelector('#tx-bulk-apply .tx-input-category');
          if (sel) {
            const opt = [...sel.options].find(o => o.textContent.trim() === 'Food');
            if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          }
          const cb = document.getElementById('tx-cascade-cb');
          if (cb) cb.checked = true;
        })()`);
        await sleep(300);
        await click('#tx-edit-next');
        await sleep(2400);
        await shotEl('bulk-edit-step-similar', '.tx-edit-dialog');
        await click('#tx-edit-next');
        await sleep(900);
        await shotEl('bulk-edit-step-review', '.tx-edit-dialog');
        await click('#tx-edit-cancel');
        await sleep(400);
      } else {
        missing.push('bulk-edit-* (no rows were selectable)');
      }

      // Delete confirmation.
      await js(`(() => {
        [...document.querySelectorAll('.tx-row-cb')].slice(0, 2).forEach(cb => {
          cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
      })()`);
      await sleep(300);
      await click('.tx-delete-btn');
      await sleep(500);
      await shotEl('transactions-delete-confirm', '.confirm-dialog');
      await click('.confirm-cancel');
      await sleep(300);

      // Clear filters, then the inline add row and the export modal.
      await click('#tx-clear-all');
      await sleep(600);
      await click('.tx-add-btn');
      await sleep(500);
      await shotEl('transactions-add-row', 'tr.tx-new', 12);
      await esc();
      await sleep(300);
      await shotEl('transactions-pagination', '.tx-pagination', 10);
      await click('.tx-export-btn');
      await sleep(600);
      await shotEl('transactions-export', '.tx-export-dialog');
      await click('.tx-import-close');
      await sleep(300);
    }

    // ═══ Phase 7: statements ═════════════════════════════════════════════════
    if (phase('statements')) {
      console.log('\n— statements —');
      await nav('/statements', 3000);
      await unhover();
      await shotWin('statements-cash-flow');
      await shotEl('statements-toolbar', '.stmt-toolbar', 6);

      // Computed (accent italics) beside a hand-typed value, close up.
      const cell = await rectOf(`#stmt-panel-cashflow input[data-col="general"]`);
      const table = await rectOf('#stmt-panel-cashflow .db-wrapper');
      if (cell && table) {
        await shot('statements-computed-cells', {
          x: Math.round(table.x), y: Math.round(table.y),
          width: Math.min(W - Math.round(table.x), 760),
          height: Math.min(H - Math.round(table.y), 420),
        });
      }
      // The ↺ that appears on a cell you have typed over — with the month name
      // and its computed neighbours in frame, so it reads as a table cell.
      const overridden = '#stmt-panel-cashflow .db-outer:not([hidden]) input[data-month="April"][data-col="income"]';
      await hover(overridden);
      const oc = await rectOf(overridden);
      if (oc) {
        await shot('statements-revert-cell', {
          x: Math.max(0, Math.round(oc.x - 200)),
          y: Math.max(0, Math.round(oc.y - 56)),
          width: 460, height: 170,
        });
      } else missing.push('statements-revert-cell');
      await unhover();

      // The ⋮ dropdown overflows its anchor, so its own rect is just the
      // button — frame the area it opens into instead.
      await click('#stmt-menu-btn');
      await sleep(400);
      const menuBtn = await rectOf('#stmt-menu-btn');
      if (menuBtn) {
        await shot('statements-menu', {
          x: Math.max(0, Math.round(menuBtn.x - 210)),
          y: Math.max(0, Math.round(menuBtn.y - 8)),
          width: 260, height: 240,
        });
      } else missing.push('statements-menu');
      await esc();
      await sleep(200);

      await click('#stmt-menu-btn');
      await sleep(300);
      await js(`(() => {
        const item = [...document.querySelectorAll('.menu-item, .p-menu-item, [role="menuitem"], button')]
          .find(b => b.textContent.trim() === 'Manage Categories');
        if (item) item.click();
      })()`);
      await sleep(900);
      await js(`(() => {
        const head = [...document.querySelectorAll('.cat-group-head')][1];
        if (head) head.click();
      })()`);
      await sleep(400);
      await shotEl('statements-manage-categories', '.cat-manager');
      await click('.cat-manager-close');
      await sleep(400);

      await click('#stmt-tab-balance');
      await sleep(1200);
      await unhover();
      await shotWin('statements-balance-sheet');
      await click('#stmt-menu-btn');
      await sleep(300);
      await js(`(() => {
        const item = [...document.querySelectorAll('.menu-item, .p-menu-item, [role="menuitem"], button')]
          .find(b => b.textContent.trim() === 'Manage Columns');
        if (item) item.click();
      })()`);
      await sleep(900);
      await js(`(() => {
        const head = document.querySelector('.cat-group-head');
        if (head) head.click();
      })()`);
      await sleep(400);
      await shotEl('statements-manage-columns', '.cat-manager');
      await click('.cat-manager-close');
      await sleep(400);

      // A block of selected cells, for the spreadsheet-editing page.
      await click('#stmt-tab-cashflow');
      await sleep(1000);
      const cols = await js(`(() => {
        const ins = [...document.querySelectorAll('#stmt-panel-cashflow .db-outer:not([hidden]) input[data-month="January"]')];
        return ins.slice(0, 3).map(i => i.dataset.col);
      })()`);
      if (cols && cols.length >= 3) {
        await dragCells(
          `#stmt-panel-cashflow .db-outer:not([hidden]) input[data-month="February"][data-col="${cols[0]}"]`,
          `#stmt-panel-cashflow .db-outer:not([hidden]) input[data-month="May"][data-col="${cols[2]}"]`);
        const t2 = await rectOf('#stmt-panel-cashflow .db-outer:not([hidden]) .db-wrapper');
        await shot('tables-cell-selection', {
          x: Math.round(t2.x), y: Math.round(t2.y),
          width: Math.min(W - Math.round(t2.x), 740),
          height: Math.min(H - Math.round(t2.y), 380),
        });
      } else missing.push('tables-cell-selection');
      await unhover();
    }

    // ═══ Phase 8: reports ════════════════════════════════════════════════════
    if (phase('reports')) {
      console.log('\n— reports —');
      // A planned item, so the forecast card has one to show. Every report on
      // the page fetches once on load, so this has to land before the nav —
      // switching tabs reveals a panel, it does not re-fetch it.
      await post('/api/forecast/planned', {
        label: 'Car insurance renewal', amount: 640, flow: 'expense',
        date: iso(now.getFullYear(), now.getMonth() + 2, 12),
      });

      // Cash Flow, Spending and Forecast are tabs of one page, so this is one
      // nav and two clicks (Recurring has its own page). The panel selectors
      // have to be scoped to the visible panel: .forecast-card matches in two
      // of them.
      await nav('/reports', 3200);
      await unhover();
      await shotPage('reports-cash-flow-diagram', '.rep-panel:not([hidden]) .forecast-card');

      // The Spending tab carries TWO cards — the trend lines and the merchant
      // ranking — so each gets its own crop rather than one shot of the panel.
      await click('#rep-tab-spending');
      await sleep(2000);
      await unhover();
      await shotEl('spending-page', '.rep-panel:not([hidden]) .trends-card', 10);
      // The chip row became the value rail (see static/js/pages/trends.js). The
      // SHOT NAME is kept: ../aventurine-docs references this file by name, and
      // renaming it here would break those pages before the docs are updated.
      await shotEl('spending-category-chips', '#trends-rail', 8);
      await shotEl('reports-top-merchants', '.rep-panel:not([hidden]) .trends-card:last-of-type', 10);

      await click('#rep-tab-transfers');
      await sleep(2500);
      await unhover();
      await shotEl('reports-saved-invested', '.rep-panel:not([hidden]) .tfr-card', 10);
      await shotEl('reports-saved-invested-merchants', '.rep-panel:not([hidden]) .tfr-card:last-of-type', 10);

      await click('#rep-tab-forecast');
      await sleep(3000);
      await unhover();
      await shotPage('reports-forecast', '.rep-panel:not([hidden]) .forecast-card');
      await shotEl('reports-forecast-summary', '#forecast-summary', 10);

      await click('#rep-tab-metrics');
      await sleep(2500);
      await unhover();
      // The whole column, not one card: the report is three stacked cards now
      // (totals, Vitals, Inflation) and cropping to .met-card catches only the
      // first of them.
      await shotEl('reports-metrics', '.rep-panel:not([hidden]) .metrics-page', 10);
    }

    // ═══ Opt-in: website feature shots ═══════════════════════════════════════
    // For aventurine-app.com's Features section, NOT for the docs — each shot is
    // cropped to the feature itself, with the title bar and the sidebar left
    // out, so the image carries no app chrome. Opt in by naming it; a plain docs
    // run skips it, which is why this is `ONLY.has` rather than `phase()`:
    //
    //   SHOT_ONLY=site SHOT_W=1900 SHOT_H=1400 SHOT_OUT=… \
    //     electron --no-sandbox --force-device-scale-factor=1.5 scripts/shoot-docs.js
    //
    // The width matters: below ~1900 the Recurring merchant column clips its
    // names (they are <input>s, so they cut mid-word rather than ellipsing) and
    // the ledger's Notes column falls off the right edge. The height matters to
    // the dashboard shot alone — see it below.
    if (ONLY && ONLY.has('site')) {
      console.log('\n— site —');

      // Every site crop is shot in the LIGHT theme and the GEMSTONE chart
      // palette, so the Features section reads as one set. Set once here rather
      // than per shot: both live in localStorage on a fixed origin, so they
      // survive every nav below. The docs phases run under the defaults, which
      // is why the pair is put back at the end of the block.
      await setTheme('');
      await setGraphTheme('gemstone');

      // Both dashboard bands — Month to Month over Year to Year, six cards.
      // Unlike the crops below this one is padded: those are cards, whose own
      // rounded edge is the frame, while the dashboard's outermost things are a
      // section heading and a stepper, and text flush to the crop edge reads as
      // clipped. 20 is the most that fits — the page's own gutter is 20 either
      // side, so any more and the rect is clamped to the window and the frame
      // goes lopsided. Needs SHOT_H ≥ 1400: at 1150 the second band is cut.
      // Stepped back one month first: the seeded ledger stops at today, so the
      // current month is a part-month and the top band would open on a half
      // paycheque against a half month of spending. The month before it is the
      // whole picture the card is meant to show.
      await nav('/', 3200);
      if (await js(`document.documentElement.dataset.graphTheme !== 'gemstone'`)) {
        throw new Error('dashboard did not load in the gemstone palette');
      }
      await click('#dashboard-month-prev');
      await sleep(900);
      await unhover();
      await shotEl('site-dashboard', '.dashboard-page', 20);

      // The ledger card: header row through the pagination footer, which is a
      // row of the same table, so one element covers it.
      // Flush to the element box, no padding: 10px of air here is 10px of the
      // title bar above the Recurring heading and of the tab bar above the
      // Sankey, which is exactly the chrome these crops exist to drop.
      await nav('/transactions', 2500);
      await unhover();
      await shotEl('site-transactions', '.tx-wrapper', 0);

      // Month stepper and the calendar with its occurrence chips — the whole
      // feature, minus the chrome around it. Shot with one schedule's card
      // pinned open: the chips carry only a name and an amount, so a bare
      // calendar shows the shape of the feature but none of its data, and the
      // card is where type/cadence/amount live now. Which chip is pinned is
      // load-bearing for the crop: the card is a fixed 460px centred on its
      // chip and clamped to the WINDOW, so one on an edge column overhangs
      // .rec-page and gets cut by the crop — it has to be a middle column. The
      // name is the card's only flexible field (~130px before it ellipses), so
      // a short merchant keeps the shot free of "…". A monthly subscription is
      // both, and is what the site's caption is about.
      await adoptRecurring();
      await nav('/recurring', 3200);
      if (!(await js(`(() => document.querySelectorAll('.rec-occ').length)()`))) {
        throw new Error('recurring calendar showed no occurrences');
      }
      await unhover();
      const pinned = await js(`(() => {
        const chip = [...document.querySelectorAll('.rec-occ')].find((el) =>
          (el.querySelector('.rec-occ-name')?.textContent || '').includes('STREAMBOX'));
        if (chip) chip.click();
        return !!chip;
      })()`);
      if (!pinned) throw new Error('no STREAMBOX chip to pin the card on');
      await sleep(400);
      if (!(await js(`(() => { const p = document.getElementById('rec-pop'); return p && !p.hidden; })()`))) {
        throw new Error('recurring card did not open');
      }
      await shotEl('site-recurring', '.rec-page', 0);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);

      // The Sankey card alone — the tab bar above it is page furniture.
      await nav('/reports', 3200);
      await unhover();
      await shotEl('site-cash-flow', '.rep-panel:not([hidden]) .forecast-card', 0);

      // Back to the defaults for any docs phase sharing the pass.
      await setGraphTheme('');
    }

    // ═══ Opt-in: full-frame app shots ════════════════════════════════
    // Whole-window captures — title bar, sidebar and page in one picture — for
    // the website, where the site crops above deliberately drop all of that.
    // Shot in the same light theme and gemstone palette, so the two sets read
    // as one app. Opt in by naming it, like `site`:
    //
    //   SHOT_ONLY=frames SHOT_W=1900 SHOT_H=1400 SHOT_OUT=… \
    //     electron --no-sandbox --force-device-scale-factor=2 scripts/shoot-docs.js
    //
    // Same 1900×1400 as `site`, and for the same reasons: below ~1900 the
    // ledger's Notes column falls off the right edge, and the dashboard's
    // second band needs the height. Full WIDTH always, but each shot is
    // trimmed to where its own page ends — the window is sized for the longest
    // of the three, and on the shorter pages that would otherwise leave a field
    // of empty background under the content, which reads as a mistake rather
    // than as an app.
    if (ONLY && ONLY.has('frames')) {
      console.log('\n— frames —');
      await setTheme('');
      await setGraphTheme('gemstone');

      // Stepped back one month for the reason the site dashboard is: the seeded
      // ledger stops at today, so the current month is a part-month and the top
      // band would open on a half paycheque against a half month of spending.
      await nav('/', 3200);
      if (await js(`document.documentElement.dataset.graphTheme !== 'gemstone'`)) {
        throw new Error('dashboard did not load in the gemstone palette');
      }
      await click('#dashboard-month-prev');
      await sleep(900);
      await unhover();
      await shotPage('frame-dashboard', '.dashboard-page', 20);

      await nav('/transactions', 2500);
      await unhover();
      await shotPage('frame-transactions', '.tx-wrapper', 20);

      // Cash Flow is the Reports page's first tab, so the nav lands on it.
      await nav('/reports', 3200);
      await unhover();
      await shotPage('frame-cash-flow', '.rep-panel:not([hidden]) .forecast-card', 20);

      // Back to the defaults for any docs phase sharing the pass.
      await setGraphTheme('');
    }

    // ═══ Phase 9: recurring ══════════════════════════════════════════════════
    if (phase('recurring')) {
      console.log('\n— recurring —');
      // Its own page, not a Reports tab. The seeded household has monthly rent,
      // utilities, two subscriptions, a gym, twice-monthly payroll and the two
      // standing transfers, so detection has real series to find without any
      // hand-authored override.
      console.log(`  ${await adoptRecurring()} candidates adopted`);
      await nav('/recurring', 3200);
      const found = await js(`(() => document.querySelectorAll('.rec-occ').length)()`);
      if (!found) throw new Error('recurring calendar showed no occurrences');
      console.log(`  ${found} occurrences on the grid`);
      await unhover();
      // Trimmed to the calendar: it is the page now, so a full-window shot
      // ends in a band of empty space below it.
      await shotPage('recurring-page', '.rec-calendar');
      await shotEl('recurring-calendar', '#rec-calendar', 8);

      // The hover card, which is where a schedule's data lives now. Clicking a
      // chip pins it, which is the only way to hold it open for a capture —
      // capturePage doesn't carry a synthetic hover. Shot with padding so the
      // card is framed with the chip it points at.
      await js(`document.querySelector('.rec-occ').click()`);
      await sleep(400);
      if (!(await js(`(() => { const p = document.getElementById('rec-pop'); return p && !p.hidden; })()`))) {
        throw new Error('recurring hover card did not open');
      }
      await shotEl('recurring-card', '#rec-pop', 12);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);
    }

    // ═══ Phase 10: tools ═════════════════════════════════════════════════════
    if (phase('tools')) {
      console.log('\n— tools —');
      // Portfolio: a few holdings.
      const acct = await js('apiFetch("/api/portfolio/data").then(r => r.json())');
      const accountId = acct.accounts[0].id;
      const holdings = [
        ['Total Market Index', 'VTSAX', 142.318, 96.4, 128.72],
        ['Global Bond Fund', 'BNDX', 310, 49.1, 51.05],
        ['Tech Growth Fund', 'TGFX', 64.5, 88.2, 112.4],
      ];
      for (const [name, ticker, amount, price, market] of holdings) {
        const e = await post('/api/portfolio/entry', { account_id: accountId });
        await js(`apiFetch('/api/portfolio/entry/${e.entry.id}', { method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asset_name: ${JSON.stringify(name)}, ticker: ${JSON.stringify(ticker)},
            amount: ${amount}, price: ${price}, market_price: ${market} }) }).then(r => r.json())`);
      }
      await js(`apiFetch('/api/portfolio/account/${accountId}', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Brokerage' }) }).then(r => r.json())`);
      await nav('/portfolio', 2500);
      await unhover();
      await shotPage('portfolio-page', '.db-outer');
    }

    // ═══ Phase 11: settings + database management ════════════════════════════
    if (phase('settings')) {
      console.log('\n— settings —');
      await nav('/', 2500);
      await click('[data-action="open-settings"]');
      await sleep(700);
      await click('#settings-tab-appearance');
      await sleep(250);
      await shotEl('preferences-appearance', '.settings-modal-tabbed');
      for (const [tab, name] of [['transactions', 'preferences-transactions'],
        ['format', 'preferences-format'], ['security', 'preferences-security']]) {
        await click(`#settings-tab-${tab}`);
        await sleep(450);
        await shotEl(name, '.settings-modal-tabbed');
      }
      await click('.settings-manage-encryption');
      await sleep(600);
      await shotEl('preferences-encryption', '.enc-modal');
      await click('[data-enc-cancel]');
      await sleep(400);
      await click('#settings-tab-transactions');
      await sleep(400);
      await click('.settings-delete-all-tx');
      await sleep(600);
      await shotEl('preferences-delete-all', '.delete-all-tx-modal');
      await click('[data-delete-all-tx-cancel]');
      await sleep(300);
      await esc();
      await sleep(300);

      // The database modals.
      await js('window.dbActions.showNew()');
      await sleep(600);
      await shotEl('database-new', '.db-modal');
      await esc();
      await sleep(300);
      await js('window.dbActions.showOpen()');
      await sleep(600);
      await shotEl('database-open', '.db-modal');
      await esc();
      await sleep(300);

      // Encrypt, then lock, to capture the unlock prompt. Last, because from
      // here on the database needs a password.
      const enc = await post('/api/db/encryption', { action: 'encrypt', newPassword: 'correct horse battery staple' });
      if (enc && enc.ok !== false) {
        await post('/api/db/lock', {});
        await nav('/', 2500);
        await shotEl('database-unlock', '.db-modal');
      } else missing.push('database-unlock');
    }

    console.log(`\nwrote screenshots to ${OUT}`);
    if (missing.length) console.log('MISSING: ' + missing.join(', '));
    app.exit(missing.length ? 3 : 0);
  } catch (err) {
    console.error('SHOOT ERROR:', (err && err.stack) || err);
    if (missing.length) console.error('MISSING so far: ' + missing.join(', '));
    app.exit(2);
  }
});
