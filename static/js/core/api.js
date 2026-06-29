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

(function () {
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/');

  function responseLike(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  // ── Fixtures (browser-only UI mode) ─────────────────────────────────────
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

  const FL_FIXTURES = {
    '/api/db/status': {
      ok: true, path: '(fixtures)', encrypted: false, locked: false,
      encryption_available: true,
    },
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
    '/api/transactions': {
      transactions: [
        { id: 1, date: `${year}-03-04`, description: 'NETFLIX.COM', category_id: null,
          tx_type: 'expense', amount: 15.49, notes: '' },
        { id: 2, date: `${year}-03-01`, description: 'ACME PAYROLL', category_id: 1,
          tx_type: 'income', amount: 2100, notes: '' },
      ],
      categories: [
        { id: 1, key: 'income', name: 'Primary Income', cat_type: 'income', position: 0 },
        { id: 4, key: 'food',   name: 'Food',   cat_type: 'expense', position: 5 },
      ],
    },
    '/api/categories': {
      categories: [
        { id: 1, key: 'income',     name: 'Primary Income',    cat_type: 'income',    flex_type: 'flex',  position: 0 },
        { id: 2, key: 'side',       name: 'Side Income',       cat_type: 'income',    flex_type: 'flex',  position: 1 },
        { id: 4, key: 'rent',       name: 'Rent / Mortgage',   cat_type: 'expense',   flex_type: 'fixed', position: 0 },
        { id: 5, key: 'food',       name: 'Food',              cat_type: 'expense',   flex_type: 'flex',  position: 1 },
        { id: 6, key: 'utilities',  name: 'Utilities',         cat_type: 'expense',   flex_type: 'flex',  position: 2 },
        { id: 7, key: 'savings',    name: 'Emergency Fund',    cat_type: 'savings',   flex_type: 'goal',  position: 0 },
        { id: 8, key: 'investing',  name: 'Brokerage',         cat_type: 'investing', flex_type: 'goal',  position: 0 },
        { id: 9, key: 'retirement', name: 'Retirement',        cat_type: 'investing', flex_type: 'goal',  position: 1 },
      ],
    },
    '/api/portfolio/data': {
      accounts: [{
        id: 1, name: 'My Portfolio',
        entries: [{ id: 1, ticker: 'VTI', asset_name: 'Total Market ETF',
                    amount: 12, price: 210.5, market_price: 268.4 }],
      }],
    },
    '/api/credit-cards/data': {
      cards: [{ id: 1, name: 'Demo Card', credit_limit: 5000, rewards_pct: 1.5,
                annual_fee: 0, category_id: 4 }],
      categories: [{ id: 4, name: 'Food' }],
      monthly_spend: { 4: 520.0 },
    },
    '/api/predictions/upcoming': { upcoming: [] },
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
    '/api/budget': {
      ok: true, year, month: 'March',
      categories: [
        // Budgeted envelopes (target > 0) show on the dashboard; the unbudgeted
        // ones (target 0, with or without spend) live behind "Add a budget".
        { key: 'rent',      name: 'Rent / Mortgage',    cat_type: 'expense',   target: 1500, spent: 1500, remaining: 0 },
        { key: 'food',      name: 'Food',               cat_type: 'expense',   target: 500,  spent: 420,  remaining: 80 },
        { key: 'utilities', name: 'Utilities',          cat_type: 'expense',   target: 150,  spent: 182,  remaining: -32 },
        { key: 'general',   name: 'General',            cat_type: 'expense',   target: 0,    spent: 60,   remaining: -60 },
        { key: 'travel',    name: 'Travel',             cat_type: 'expense',   target: 0,    spent: 0,    remaining: 0 },
        { key: 'savings',   name: 'Primary Savings',    cat_type: 'savings',   target: 400,  spent: 400,  remaining: 0 },
        { key: 'investing', name: 'Investment Account', cat_type: 'investing', target: 0,    spent: 0,    remaining: 0 },
      ],
      summary: { received: 4200 },
    },
    '/api/forecast': forecastFixture,
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
    '/api/app-settings': { tx_auto_match: 'on', tx_fuzzy_threshold: '1' },
    '/api/transactions/hashes': { hashes: [] },
    '/api/transactions/similar': { transactions: [] },
    '/api/transactions/uncategorized-count': { count: 1 },
  };

  function fixtureResponse(method, url) {
    const path = url.split('?')[0];
    if (method === 'GET') {
      const body = FL_FIXTURES[path];
      return responseLike(body ? 200 : 404, body ?? { ok: false, error: 'not found' });
    }
    // Writes in fixture mode are accepted and ignored.
    return responseLike(200, { ok: true });
  }

  /** Drop-in replacement for fetch() at the app's /api/* call sites. */
  async function apiFetch(url, opts = {}) {
    if (!isApi(url)) return fetch(url, opts);

    const method = (opts.method || 'GET').toUpperCase();

    if (window.financeApi && window.financeApi.request) {
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

  window.apiFetch = apiFetch;
}());
