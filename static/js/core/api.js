'use strict';

// ─── api.js ──────────────────────────────────────────────────────────────────
// The one data-access seam. Every page calls apiFetch() exactly like fetch();
// what backs it depends on the environment:
//
//   1. Electron (window.financeApi from preload.js): the request crosses IPC
//      to the in-process Node backend — no HTTP, no socket, no port.
//   2. A plain browser with no bridge: static fixtures (FL_FIXTURES below),
//      so pure-UI work renders with realistic data and zero backend. Writes
//      are accepted-and-ignored ({ok:true}).
//
// The return value mimics the slice of the Response interface the app uses:
// { ok, status, json() }. Non-/api/ URLs always go to the real fetch().
//
// Who depends on this file:
//   - Loaded as a plain <script> (no bundler — see the "no build step"
//     guardrail in PRODUCT.md) and attaches window.apiFetch as a global.
//     Nearly every page/widget module calls window.apiFetch(...) instead of
//     window.fetch(...): static/js/pages/*.js (home, transactions, trends,
//     reportcard, credit_cards, portfolio), static/js/widgets/*.js
//     (txfileimport, txexport, forecast, cashflow-sankey, tables), and
//     static/js/shell/*.js (nav, dbactions, autolock, titlebar, settings,
//     settingsCategories), plus core/store.js and core/encryption.js.
//   - electron/preload.js exposes window.financeApi.request(method, url,
//     body), which is the Electron-mode backend this file forwards to over
//     IPC (channel 'api:request'). On the main-process side that IPC call is
//     handled in electron/main.js and dispatched by
//     electron/backend/router.js to the real handlers under
//     electron/backend/handlers/. This file has no knowledge of those
//     handlers' internals — it only knows the IPC contract
//     (method, url, body) -> { status, body }.
//   - The static-fixture branch below has no server-side counterpart at
//     all: it exists purely so the UI can be opened as a plain HTML file
//     (no Electron, no backend) for fast visual iteration on layout/design.

(function () {
  // Gate: only URLs starting with /api/ are intercepted/routed by this
  // module. Everything else (fonts, images, external URLs) falls through to
  // the browser's native fetch untouched — see the isApi(url) check in
  // apiFetch() below.
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/');

  // Builds an object shaped like the subset of the Fetch API's Response
  // that callers actually use (ok/status/json()/text()). Both the Electron
  // IPC branch and the fixture branch of apiFetch() funnel their result
  // through this so every caller — regardless of which backend answered —
  // sees the same shape and can keep writing `const r = await apiFetch(...);
  // if (r.ok) { const data = await r.json(); }`.
  function responseLike(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  // ── Fixtures (browser-only UI mode) ─────────────────────────────────────
  // Only reached when there's neither window.financeApi (Electron) nor an
  // http(s): page origin (legacy/dev server) — see the branching order in
  // apiFetch() near the bottom of this file. Nothing outside this file
  // reads FL_FIXTURES directly; pages only ever see it indirectly through
  // apiFetch()'s GET responses, so this data must independently satisfy the
  // shape every consuming page/widget expects (Home, Trends, Report Card,
  // Transactions, Forecast, Portfolio, Credit Cards, Balance Sheet).
  // Just enough shape for every page to render: one year of sparse data.
  const year = new Date().getFullYear();

  // Trailing 12 complete months (for the Spending Trends fixture).
  const trendsMonths = (() => {
    const now = new Date();
    const out = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  })();
  const trendSeries = (base, drift) => {
    const m = {};
    trendsMonths.forEach((ym, i) => { m[ym] = Math.round(base + drift * i + (i % 3) * 12); });
    return m;
  };

  // A 3-month weekly forecast (the page's default horizon): a paycheck/rent
  // sawtooth on top of a small smooth baseline, so the cash-crunch dips show.
  // Shape mirrors what electron/backend/handlers (the real /api/forecast
  // handler) returns, so static/js/widgets/forecast.js can render either
  // source unmodified: { series[], summary, accounts[], planned[] }.
  const forecastFixture = (() => {
    const MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const startBalance = 5200;
    const series = [];
    let balance = startBalance;
    let lowest = null;
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i * 7);
      const weekStart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const label = `${MS[d.getMonth()]} ${d.getDate()}`;
      const income = i % 4 === 0 ? 4200 : 0;          // biweekly-ish paycheck
      const expense = 90 + (i % 4 === 2 ? 1500 : 0);   // smooth baseline + rent week
      const net = income - expense;
      balance += net;
      if (!lowest || balance < lowest.balance) lowest = { weekStart, label, balance };
      series.push({ weekStart, label, income, expense, net, balance });
    }
    return {
      ok: true, months: 3, start_balance: startBalance, start_account: 'cash',
      include_savings: true,
      accounts: [
        { key: 'cash',     label: 'Cash',     type: 'cash', balance: startBalance },
        { key: 'checking', label: 'Checking', type: 'cash', balance: 2480 },
      ],
      series,
      summary: {
        endBalance: series[series.length - 1].balance,
        lowest, belowZero: false,
        avgIncome: 4200, avgExpense: 3800, monthsUsed: 3,
      },
      planned: [
        { id: 1, label: 'Property tax', amount: 2000, flow: 'expense', date: series[6].weekStart },
      ],
    };
  })();

  // Static GET responses keyed by path (query strings are stripped before
  // lookup — see fixtureResponse() below). Each key corresponds 1:1 to a
  // real backend route implemented in electron/backend/handlers/ and must
  // stay shape-compatible with it, since pages can't tell which one
  // answered. Comments below name the primary page/widget each entry feeds.
  const FL_FIXTURES = {
    // static/js/shell/dbactions.js, titlebar.js — DB-open/lock status shown
    // in the title bar and the New/Open Database modal.
    '/api/db/status': {
      ok: true, path: '(fixtures)', encrypted: false, locked: false,
      encryption_available: true,
    },
    // static/js/pages/home.js and the Statements page (income/expense side)
    // — monthly income/expense/savings/investing grid, one row per month.
    '/api/data': {
      years: [year],
      entries: {
        [String(year)]: {
          January:  { income: 4200, rent: 1500, groceries: 520, savings: 400 },
          February: { income: 4200, rent: 1500, groceries: 487, savings: 400 },
          March:    { income: 4350, rent: 1500, groceries: 552, savings: 450 },
        },
      },
      columns: [
        { key: 'income',        label: 'Primary Income',     type: 'income'    },
        { key: 'other_income',  label: 'Other Income',       type: 'income'    },
        { key: 'uncat_income',  label: 'Uncategorized',      type: 'income'    },
        { key: 'rent',          label: 'Rent / Mortgage',    type: 'expense'   },
        { key: 'groceries',     label: 'Groceries',          type: 'expense'   },
        { key: 'uncat_expense', label: 'Uncategorized',      type: 'expense'   },
        { key: 'savings',       label: 'Primary Savings',    type: 'savings'   },
        { key: 'investing',     label: 'Investment Account', type: 'investing' },
      ],
      // Per-year synced-category map. Clean slate in fixtures (nothing synced).
      sync: {},
    },
    // Statements page (balance-sheet side) — monthly cash/investment/
    // retirement account balances.
    '/api/balance/data': {
      years: [year],
      entries: {
        [String(year)]: {
          January:  { cash: 3200, bank_acct: 18500, retirement: 42000 },
          February: { cash: 3350, bank_acct: 19100, retirement: 43250 },
          March:    { cash: 2980, bank_acct: 19800, retirement: 44100 },
        },
      },
      columns: [
        { key: 'cash',       label: 'Cash',               type: 'cash' },
        { key: 'bank_acct',  label: 'Bank Account',       type: 'investment' },
        { key: 'retirement', label: 'Retirement Account', type: 'retirement' },
      ],
    },
    // static/js/pages/transactions.js and static/js/widgets/txfileimport.js
    // — the ledger grid plus its category list. category_id: null on the
    // Netflix row models the cold-start-categorization gap described in
    // this workspace's CLAUDE.md (import leaves unmatched rows blank).
    '/api/transactions': {
      transactions: [
        // display_name models the lexicon's canonical merchant name; null on
        // the payroll row exercises the plain (no reveal toggle) rendering.
        { id: 1, date: `${year}-03-04`, description: 'NETFLIX.COM', display_name: 'Netflix',
          category_id: null, tx_type: 'expense', amount: 15.49, notes: '' },
        { id: 2, date: `${year}-03-01`, description: 'ACME PAYROLL', display_name: null,
          category_id: 1, tx_type: 'income', amount: 2100, notes: '' },
      ],
      categories: [
        { id: 1, key: 'income', name: 'Primary Income', cat_type: 'income', position: 0 },
        { id: 4, key: 'food',   name: 'Food',   cat_type: 'expense', position: 5 },
      ],
    },
    // static/js/shell/settingsCategories.js and any page with a category
    // picker (transactions, home) — the full category taxonomy, keyed by
    // cat_type (income/expense/savings/investing) and ordered by position.
    '/api/categories': {
      categories: [
        { id: 1, key: 'income',     name: 'Primary Income',    cat_type: 'income',    position: 0 },
        { id: 2, key: 'side',       name: 'Side Income',       cat_type: 'income',    position: 1 },
        { id: 4, key: 'rent',       name: 'Rent / Mortgage',   cat_type: 'expense',   position: 0 },
        { id: 5, key: 'food',       name: 'Food',              cat_type: 'expense',   position: 1 },
        { id: 6, key: 'utilities',  name: 'Utilities',         cat_type: 'expense',   position: 2 },
        { id: 7, key: 'savings',    name: 'Emergency Fund',    cat_type: 'savings',   position: 0 },
        { id: 8, key: 'investing',  name: 'Brokerage',         cat_type: 'investing', position: 0 },
        { id: 9, key: 'retirement', name: 'Retirement',        cat_type: 'investing', position: 1 },
      ],
    },
    // static/js/pages/portfolio.js — brokerage accounts and holdings.
    '/api/portfolio/data': {
      accounts: [{
        id: 1, name: 'My Portfolio',
        entries: [{ id: 1, ticker: 'VTI', asset_name: 'Total Market ETF',
                    amount: 12, price: 210.5, market_price: 268.4 }],
      }],
    },
    // static/js/pages/credit_cards.js — card list plus per-category monthly
    // spend, used to estimate rewards earned.
    '/api/credit-cards/data': {
      cards: [{ id: 1, name: 'Demo Card', credit_limit: 5000, rewards_pct: 1.5,
                annual_fee: 0, category_id: 4 }],
      categories: [{ id: 4, name: 'Food' }],
      monthly_spend: { 4: 520.0 },
    },
    // static/js/pages/home.js — upcoming predicted transactions widget;
    // empty here since fixtures don't model recurring-transaction detection.
    '/api/predictions/upcoming': { upcoming: [] },
    // static/js/pages/trends.js — 12-month per-category spend series for
    // the Spending Trends chart.
    '/api/trends': {
      ok: true, window: 12, months: trendsMonths,
      categories: [
        { key: 'rent',          name: 'Rent / Mortgage', monthly: trendSeries(1500, 0) },
        { key: 'food',          name: 'Food',            monthly: trendSeries(380, 14) },
        { key: 'utilities',     name: 'Utilities',       monthly: trendSeries(150, 3) },
        { key: 'entertainment', name: 'Entertainment',   monthly: trendSeries(220, -9) },
        { key: '__uncategorized__', name: 'Uncategorized', monthly: trendSeries(90, 2) },
      ],
    },
    // static/js/widgets/forecast.js — see forecastFixture above.
    '/api/forecast': forecastFixture,
    // static/js/pages/reportcard.js — year-over-year income/expense/savings
    // summary plus pass/fail goal checks.
    '/api/report-card': {
      ok: true,
      years: [
        {
          year, income: 72000, expenses: 45000, savings: 12000, debt: 9000,
          changes: {
            income:   { abs: 6000,  pct: 0.0909 },
            expenses: { abs: -1000, pct: -0.0217 },
            savings:  { abs: 3000,  pct: 0.3333 },
          },
          metrics: { expenseToIncome: 0.625, debtToIncome: 0.125, cashFlowMargin: 0.2083 },
          goals: [
            { key: 'expense_ratio',   label: 'Expenses under 70% of income',          value: 0.625,   status: 'met' },
            { key: 'savings_rate',    label: 'Saving & investing over 15% of income', value: 0.1667,  status: 'met' },
            { key: 'debt_to_income',  label: 'Total debt under 25% of income',        value: 0.125,   status: 'met' },
            { key: 'spending_trend',  label: 'Spending down from last year',          value: -0.0217, status: 'met' },
            { key: 'income_trend',    label: 'Income up from last year',              value: 0.0909,  status: 'met' },
          ],
        },
        {
          year: year - 1, income: 66000, expenses: 46000, savings: 9000, debt: 12000,
          changes: { income: null, expenses: null, savings: null },
          metrics: { expenseToIncome: 0.697, debtToIncome: 0.1818, cashFlowMargin: 0.1667 },
          goals: [
            { key: 'expense_ratio',  label: 'Expenses under 70% of income',          value: 0.697,  status: 'met' },
            { key: 'savings_rate',   label: 'Saving & investing over 15% of income', value: 0.1364, status: 'miss' },
            { key: 'debt_to_income', label: 'Total debt under 25% of income',        value: 0.1818, status: 'met' },
            { key: 'spending_trend', label: 'Spending down from last year',          value: null,   status: 'na' },
            { key: 'income_trend',   label: 'Income up from last year',              value: null,   status: 'na' },
          ],
        },
      ],
    },
    // static/js/shell/settings.js — feature toggles read by the settings
    // panel; tx_auto_match configures the learned auto-categorization
    // matcher (electron/backend/services/matchRules.js on the real backend).
    '/api/app-settings': { tx_auto_match: 'on' },
    // static/js/widgets/txfileimport.js — known transaction hashes, used
    // client-side to flag duplicate rows during import preview.
    '/api/transactions/hashes': { hashes: [] },
    // static/js/pages/transactions.js — "find similar" lookup used by the
    // bulk-recategorize action.
    '/api/transactions/similar': { transactions: [] },
    // static/js/pages/home.js — badge count driving the "N transactions
    // need a category" nudge on the dashboard.
    '/api/transactions/uncategorized-count': { count: 1 },
  };

  // Serves one GET fixture (or 404) by exact path match, ignoring query
  // strings (e.g. year=2026 params some pages append are not modeled here).
  // Any non-GET (POST/PUT/DELETE) is a no-op that reports success without
  // mutating FL_FIXTURES, so the fixture data set is effectively read-only
  // and stays identical across repeated writes within one page session —
  // there is no persistence layer backing this mode.
  function fixtureResponse(method, url) {
    const path = url.split('?')[0];
    if (method === 'GET') {
      const body = FL_FIXTURES[path];
      return responseLike(body ? 200 : 404, body ?? { ok: false, error: 'not found' });
    }
    // Writes in fixture mode are accepted and ignored.
    return responseLike(200, { ok: true });
  }

  // The single entry point every page/widget/shell module calls instead of
  // window.fetch() for /api/* URLs (see the file-level comment above for
  // the full caller list). Resolution order per call:
  //   1. Not an /api/ URL              -> pass through to real fetch().
  //   2. window.financeApi present     -> Electron: forward over IPC to
  //      preload.js's `request` bridge, which invokes 'api:request',
  //      handled in electron/main.js and routed by
  //      electron/backend/router.js to the real handlers. This is the path
  //      used by the actual shipped app.
  //   3. http(s): page origin          -> a real HTTP server is fronting us
  //      (legacy/dev workflow, e.g. `electron/scripts/verify-e2e.js`) —
  //      pass straight through to fetch() so it hits that server.
  //   4. Otherwise (plain file:// page, no bridge, no server)
  //                                     -> fixtureResponse() above, so pages
  //      can be opened standalone for UI/design iteration.
  /** Drop-in replacement for fetch() at the app's /api/* call sites. */
  async function apiFetch(url, opts = {}) {
    if (!isApi(url)) return fetch(url, opts);

    const method = (opts.method || 'GET').toUpperCase();

    if (window.financeApi && window.financeApi.request) {
      // opts.body arrives fetch-style (a JSON string, per callers' usage
      // e.g. JSON.stringify(...)); financeApi.request wants a parsed object
      // since IPC serializes structured data natively, not strings-of-JSON.
      let body = null;
      if (opts.body != null) {
        try { body = JSON.parse(opts.body); } catch { body = null; }
      }
      const { status, body: data } = await window.financeApi.request(method, url, body);
      return responseLike(status, data);
    }

    if (location.protocol === 'http:' || location.protocol === 'https:') {
      // A real HTTP backend is serving us (legacy/dev) — pass straight through.
      return fetch(url, opts);
    }

    return fixtureResponse(method, url);
  }

  // Global attachment (no ES module export — this is a plain <script>, part
  // of the app's no-build-step design). Every caller listed at the top of
  // this file references window.apiFetch directly; there is no import
  // graph to trace beyond "is api.js's <script> tag loaded before mine."
  window.apiFetch = apiFetch;
}());
