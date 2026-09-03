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
//     Nearly every page and widget module calls window.apiFetch(...) instead of
//     window.fetch(...): static/js/pages/*.js (home, transactions, trends,
//     reportcard, portfolio), static/js/widgets/*.js
//     (txfileimport, txexport, forecast, cashflow-sankey, tables), and
//     static/js/shell/*.js (nav, dbactions, autolock, titlebar, settings,
//     settingsCategories), plus core/store.js and core/encryption.js.
//   - electron/preload.js exposes window.financeApi.request(method, url,
//     body), which is the Electron-mode backend this file forwards to over
//     IPC (channel 'api:request'). On the main-process side that IPC call is
//     handled in electron/main.js and dispatched by
//     electron/backend/router.js to the real handlers under
//     electron/backend/handlers/. This file does not reference those handlers'
//     internals; it depends only on the IPC contract
//     (method, url, body) -> { status, body }.
//   - The static-fixture branch below has no server-side counterpart at
//     all: it exists purely so the UI can be opened as a plain HTML file
//     (no Electron, no backend) for fast visual iteration on layout/design.

(function () {
  // Gate: only URLs starting with /api/ are intercepted and routed by this
  // module. Everything else (fonts, images, external URLs) falls through to the
  // browser's native fetch unchanged — see the isApi(url) check in apiFetch()
  // below.
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/');

  // Builds an object shaped like the subset of the Fetch API's Response that
  // callers use (ok/status/json()/text()). Both the Electron IPC branch and the
  // fixture branch of apiFetch() return their result through this, so every
  // caller gets the same shape regardless of which backend responded and can
  // write `const r = await apiFetch(...); if (r.ok) { const data = await
  // r.json(); }`.
  function responseLike(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  // ── Fixtures (browser-only UI mode) ─────────────────────────────────────
  // Only reached when there is neither window.financeApi (Electron) nor an
  // http(s): page origin (legacy/dev server) — see the branching order in
  // apiFetch() near the bottom of this file. Nothing outside this file reads
  // FL_FIXTURES directly; pages receive it only through apiFetch()'s GET
  // responses, so this data must match the shape every consuming page and widget
  // expects (Dashboard, Trends, Report Card, Transactions, Forecast, Portfolio,
  // Balance Sheet).
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

  // The first month of Top Merchants' 12-month window. It counts the CURRENT,
  // partial month (Trends does not), so it starts a month later than the
  // trends fixture above.
  const merchantFrom = (() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  // A 3-month weekly forecast (the page's default horizon): a paycheck/rent
  // sawtooth on top of a small smooth baseline, so the cash-crunch dips show.
  // Shape mirrors what electron/backend/handlers (the real /api/forecast
  // handler) returns, so static/js/widgets/forecast.js can render either
  // source unmodified: { series[], summary, accounts[], planned[] }.
  const forecastFixture = (() => {
    const MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const iso = (offsetDays) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const startBalance = 5200;
    const series = [];
    let balance = startBalance;
    let lowest = null;
    for (let i = 0; i < 14; i++) {
      const weekStart = iso(i * 7);
      const [, m, dd] = weekStart.split('-').map(Number);
      const label = `${MS[m - 1]} ${dd}`;
      const income = i % 4 === 0 ? 4200 : 0;           // biweekly-ish paycheck
      const expense = 90 + (i % 4 === 2 ? 1500 : 0);   // smooth baseline + rent week
      const net = income - expense;
      balance += net;
      if (!lowest || balance < lowest.balance) lowest = { weekStart, label, balance };
      // weekEnd is where the point sits on the date axis (the balance shown is
      // the one reached at the end of the week) — see services/forecast.js.
      series.push({ weekStart, weekEnd: iso(i * 7 + 6), label, income, expense, net, balance });
    }
    const last = series[series.length - 1];
    // Actual weekly balances for the same span BEFORE today — the chart's left
    // half, walked backward from the starting balance the same way the real
    // service does (services/forecast.js historySeries).
    const history = [];
    let back = startBalance;
    for (let i = 1; i <= 13; i++) {
      back -= i % 4 === 1 ? 3900 : -1250;
      history.unshift({ weekEnd: iso(-i * 7), label: `wk-${i}`, balance: Math.round(back) });
    }
    return {
      ok: true, months: 3, start_balance: startBalance, start_account: 'cash',
      // The Balance Sheet month that balance came from, and how the projection
      // was scoped — both drive the sentence above the chart.
      start_as_of: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
      scope: 'account',
      include_transfers: true,
      history_months: 6,
      accounts: [
        { key: 'cash',     label: 'Cash',     type: 'cash', balance: startBalance, as_of: `${today.getFullYear()}-${pad(today.getMonth() + 1)}` },
        { key: 'checking', label: 'Checking', type: 'cash', balance: 2480, as_of: `${today.getFullYear()}-${pad(today.getMonth() + 1)}` },
      ],
      anchor: { date: iso(0), balance: startBalance },
      domain: { start: iso(-13 * 7), end: iso(13 * 7) },
      history,
      series,
      summary: {
        endBalance: last.balance,
        endDate: last.weekEnd,
        lowest, belowZero: false,
        avgIncome: 4200, avgExpense: 3800, monthsUsed: 6, window: 6,
      },
      planned: [
        { id: 1, label: 'Property tax', amount: 2000, flow: 'expense', date: iso(45) },
        { id: 2, label: 'Bonus', amount: 1500, flow: 'income', date: iso(66) },
      ],
    };
  })();

  // static/js/pages/recurring.js — a handful of recurring series + this
  // month's occurrences (calendar dots + list). The real backend recomputes
  // per `month`; this fixture returns the same shape for any month, since query
  // strings are not modeled (see fixtureResponse() below).
  //
  // These represent schedules already ADOPTED — on the real backend nothing
  // appears here until the user picks it out of the detection dialog (whose
  // candidates are in recurringCandidatesFixture below). A populated list is
  // what pure-UI work on the list and calendar needs.
  const recurringFixture = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const ym = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
    const iso = (day) => `${ym}-${pad(Math.min(day, 28))}`;
    // `search` is the term the card's merchant link passes to the Transactions
    // ledger — the substring shared by every transaction in the series, which
    // for these single-description fixtures is the description itself.
    const series = [
      { key: 'netflix', description: 'NETFLIX.COM', display_name: 'Netflix', direction: 'expense', category_id: 5, category: 'Entertainment', search: 'NETFLIX.COM', amount: 15.49, cycle: 'monthly', occurrences: 6, confidence: 0.92, last_date: iso(14), next_date: iso(14) },
      { key: 'city_fitness', description: 'CITY FITNESS CLUB', display_name: 'City Fitness', direction: 'expense', category_id: 6, category: 'Health & Fitness', search: 'CITY FITNESS CLUB', amount: 42.0, cycle: 'monthly', occurrences: 5, confidence: 0.85, last_date: iso(3), next_date: iso(3) },
      { key: 'rent', description: 'RENT', display_name: null, direction: 'expense', category_id: 2, category: 'Rent / Mortgage', search: 'RENT', amount: 1500, cycle: 'monthly', occurrences: 8, confidence: 0.98, last_date: iso(1), next_date: iso(1) },
      // Uncategorized — the card's amber "needs review" pill (.rec-type-empty).
      { key: 'spotify', description: 'SPOTIFY', display_name: 'Spotify', direction: 'expense', category_id: null, category: null, search: 'SPOTIFY', amount: 11.99, cycle: 'monthly', occurrences: 6, confidence: 0.9, last_date: iso(24), next_date: iso(24) },
      { key: 'acme_payroll', description: 'ACME PAYROLL', display_name: 'Acme Corp', direction: 'income', category_id: 1, category: 'Primary Income', search: 'ACME PAYROLL', amount: 3000, cycle: 'biweekly', occurrences: 10, confidence: 0.95, last_date: iso(15), next_date: iso(15) },
      // Hand-added: no transactions behind it, so no occurrence count, no
      // category and no `search` — the card shows its name as plain text
      // rather than as a link to a ledger view that would come back empty.
      { key: 'locker rental', description: 'Locker Rental', display_name: 'Locker Rental', direction: 'expense', category_id: null, category: null, search: null, amount: 8, cycle: 'monthly', occurrences: 0, confidence: 1, last_date: iso(26), next_date: iso(26) },
    ];
    const occurrences = series.map((s) => ({
      date: s.next_date, key: s.key, direction: s.direction, amount: s.amount,
      actual: Number(s.next_date.slice(-2)) <= today.getDate(),
    }));
    return { month: ym, series, occurrences };
  })();

  // The Recurring page's detection picker (⋮ → "Find recurring schedules").
  // Disjoint from recurringFixture above — these are detected patterns NOT yet
  // on the page, which is what the dialog lists. POST /api/recurring/adopt is
  // not modeled (fixtures are read-only), so in a plain browser the dialog
  // opens, ticks and closes without the list growing.
  const recurringCandidatesFixture = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const ym = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
    const iso = (day) => `${ym}-${pad(Math.min(day, 28))}`;
    return {
      candidates: [
        { key: 'metro power', description: 'METRO POWER & LIGHT', display_name: null, direction: 'expense', search: 'METRO POWER & LIGHT', amount: 88.4, cycle: 'monthly', occurrences: 7, confidence: 0.94, last_date: iso(9), next_date: iso(9) },
        { key: 'brightline internet', description: 'BRIGHTLINE INTERNET', display_name: 'Brightline', direction: 'expense', search: 'BRIGHTLINE INTERNET', amount: 59.99, cycle: 'monthly', occurrences: 5, confidence: 0.88, last_date: iso(19), next_date: iso(19) },
        { key: 'lakeside storage', description: 'LAKESIDE STORAGE UNIT', display_name: null, direction: 'expense', search: 'LAKESIDE STORAGE UNIT', amount: 75, cycle: 'monthly', occurrences: 4, confidence: 0.81, last_date: iso(27), next_date: iso(27) },
        { key: 'vault auto save', description: 'VAULT AUTO SAVE', display_name: null, direction: 'transfer', search: 'VAULT AUTO SAVE', amount: 250, cycle: 'biweekly', occurrences: 9, confidence: 0.76, last_date: iso(12), next_date: iso(26) },
      ],
    };
  })();

  // Static GET responses keyed by path (query strings are stripped before
  // lookup — see fixtureResponse() below). Each key corresponds 1:1 to a real
  // backend route implemented in electron/backend/handlers/ and must stay
  // shape-compatible with it, since pages cannot distinguish the two sources.
  // Comments below name the primary page or widget each entry feeds.
  // static/js/pages/transfers.js — the Saved & Invested report. Built the way
  // the real handler builds it (per-account months first, totals derived from
  // them), so the stack sums to the line here as it does against the backend.
  // One fixture serves every window, since query strings are not modeled
  // — the picker changes the label and not the bars. Nine accounts on purpose:
  // eight get a palette slot and the ninth has to fold into "Other", which is
  // the case the legend and the neutral swatch exist for. A band is a Transfer
  // ROW of the Cash Flow grid, so the names are categories and the links carry
  // the category key; the uncategorized band is here too, since it is the one
  // band the statement has no row for and therefore the one that never links.
  const transfersFixture = (() => {
    const rows = [
      { key: 'investing', name: 'Investing',        cat: 'investing', base: 600, drift: 12 },
      { key: 'savings',   name: 'Savings',          cat: 'savings',   base: 400, drift: 8 },
      { key: 'cat_31',    name: 'Brokerage',        cat: 'cat_31',    base: 180, drift: -4 },
      { key: 'cat_32',    name: 'Crypto',           cat: 'cat_32',    base: 120, drift: 6 },
      { key: 'cat_33',    name: 'Emergency Fund',   cat: 'cat_33',    base: 95,  drift: 0 },
      { key: 'cat_34',    name: 'College Fund',     cat: 'cat_34',    base: 75,  drift: 3 },
      { key: 'cat_35',    name: 'Roth IRA',         cat: 'cat_35',    base: 60,  drift: 2 },
      { key: '__uncategorized__', name: 'Uncategorized', cat: null,   base: 50,  drift: 1 },
      { key: 'cat_36',    name: 'Vacation Fund',    cat: 'cat_36',    base: 40,  drift: 0 },
    ];
    const monthly = {};
    let total = 0;
    const accounts = rows.map((b) => {
      const m = {};
      trendsMonths.forEach((ym, i) => {
        // Every third month sits out, so the stack has gaps and short columns
        // to draw rather than eight flat bands of identical height.
        const v = i % 3 === 1 && b.base < 200 ? 0 : Math.max(Math.round(b.base + b.drift * i), 0);
        if (!v) return;
        m[ym] = v;
        monthly[ym] = (monthly[ym] || 0) + v;
        total += v;
      });
      return { key: b.key, name: b.name, cat: b.cat, total: Object.values(m).reduce((a, c) => a + c, 0), monthly: m };
    });
    // The folded tail: more than one account, so it carries no category key and
    // wears a neutral instead of a ninth hue.
    const otherMonthly = {};
    trendsMonths.forEach((ym, i) => {
      const v = 25 + (i % 4) * 10;
      otherMonthly[ym] = v;
      monthly[ym] = (monthly[ym] || 0) + v;
      total += v;
    });
    accounts.push({
      key: '__other__', name: 'Other', cat: null,
      total: Object.values(otherMonthly).reduce((a, c) => a + c, 0),
      monthly: otherMonthly,
    });
    return { ok: true, window: 12, months: trendsMonths, total, monthly, accounts, everTransferred: true };
  })();

  // static/js/pages/metrics.js — the Metrics report: one year's totals, the
  // ratios behind them, and pass/fail goal checks. FIVE years, so the
  // sparklines on the headline figures have a shape to draw and the year picker
  // has something to pick; the figures improve across them so the target
  // notches on the ratio meters are seen both missed and met. Mirrors
  // electron/backend/services/reportCard.js — the same derivations off raw
  // yearly totals, so fixture mode and the real backend agree on shape.
  const reportCardFixture = (() => {
    // `cats` are the five categories the Inflation section charts, moving year to
    // year at different rates (and not all upward), so the small multiples have
    // a mix of rises and falls to draw and their shared scale has a spread.
    const raw = [
      { year: year - 4, income: 52000, expenses: 43000, transfers: 2400, invested: 900,  debt: 24000, top: 15480,
        cats: { rent: 14400, food: 6200, utilities: 2400, automobile: 4100, shopping: 3300 } },
      { year: year - 3, income: 57500, expenses: 45800, transfers: 3600, invested: 1800, debt: 20000, top: 16000,
        cats: { rent: 15120, food: 6820, utilities: 2520, automobile: 4510, shopping: 3100 } },
      { year: year - 2, income: 61000, expenses: 47400, transfers: 5400, invested: 3000, debt: 15500, top: 16600,
        cats: { rent: 15876, food: 7160, utilities: 2898, automobile: 4330, shopping: 3565 } },
      { year: year - 1, income: 66000, expenses: 46000, transfers: 7200, invested: 4800, debt: 12000, top: 15840,
        cats: { rent: 16352, food: 6874, utilities: 2840, automobile: 4763, shopping: 3850 } },
      { year,           income: 72000, expenses: 45000, transfers: 9600, invested: 6000, debt: 9000,  top: 16200,
        cats: { rent: 17170, food: 7560, utilities: 2960, automobile: 4620, shopping: 3580 } },
    ];
    // Mirrors INFLATION_CATEGORIES + categoryChange in
    // electron/backend/services/reportCard.js.
    const INF = [
      ['rent', 'Rent / Mortgage'], ['food', 'Food'], ['utilities', 'Utilities'],
      ['automobile', 'Auto & Transport'], ['shopping', 'Shopping'],
    ];
    const r2 = (n) => Math.round(n * 100) / 100;
    const ratio = (a, b) => (b > 0 ? a / b : null);
    const change = (curr, prev) =>
      (prev == null ? null : { abs: r2(curr - prev), pct: prev > 0 ? (curr - prev) / prev : null });
    // Three levels, mirroring services/reportCard.js: hit or beaten, slightly
    // off (within 5 ratio points / a 2% move), off.
    const under = (v, bound) => (v == null ? 'na' : v <= bound ? 'met' : v <= bound + 0.05 ? 'near' : 'miss');
    const over = (v, floor) => (v == null ? 'na' : v >= floor ? 'met' : v >= floor - 0.05 ? 'near' : 'miss');
    const trend = (v, ok) =>
      (v == null || v === 0 ? 'na' : ok ? 'met' : Math.abs(v) <= 0.02 ? 'near' : 'miss');

    const cards = raw.map((r, i) => {
      const prev = i ? raw[i - 1] : null;
      const net = r2(r.income - r.expenses);
      const prevNet = prev ? r2(prev.income - prev.expenses) : null;
      const er = ratio(r.expenses, r.income);
      const dti = ratio(r.debt, r.income);
      const sr = ratio(r.transfers, r.income);
      const ir = ratio(r.invested, r.income);
      const spend = prev && prev.expenses > 0 ? (r.expenses - prev.expenses) / prev.expenses : null;
      const inc = prev && prev.income > 0 ? (r.income - prev.income) / prev.income : null;
      const saved = r2(r.transfers - r.invested);
      return {
        year: r.year, income: r.income, expenses: r.expenses, transfers: r.transfers,
        saved, invested: r.invested, net, debt: r.debt,
        topExpense: { key: 'housing', name: 'Housing', amount: r.top },
        inflation: INF.map(([key, name]) => {
          const amount = r.cats[key] || 0;
          const was = prev ? (prev.cats[key] || 0) : null;
          return { key, name, amount, pct: was > 0 ? (amount - was) / was : null };
        }),
        changes: {
          income: change(r.income, prev && prev.income),
          expenses: change(r.expenses, prev && prev.expenses),
          transfers: change(r.transfers, prev && prev.transfers),
          saved: change(saved, prev && r2(prev.transfers - prev.invested)),
          invested: change(r.invested, prev && prev.invested),
          net: change(net, prevNet),
        },
        metrics: {
          expenseToIncome: er,
          debtToIncome: dti,
          cashFlowMargin: (r.income - r.expenses) / r.income,
          savingsRate: sr,
          investedRate: ir,
          topExpenseShare: ratio(r.top, r.expenses),
        },
        goals: [
          { key: 'expense_ratio',  label: 'Expenses under 70% of income',    value: er,    target: 0.70, range: null,         status: under(er, 0.70) },
          { key: 'debt_to_income', label: 'Total debt under 25% of income',  value: dti,   target: 0.25, range: null,         status: under(dti, 0.25) },
          { key: 'savings_rate',   label: 'Saving at least 20% of income',   value: sr,    target: 0.20, range: null,         status: over(sr, 0.20) },
          { key: 'invested_rate',  label: 'Investing 15% to 20% of income',  value: ir,    target: 0.15, range: [0.15, 0.20], status: over(ir, 0.15) },
          { key: 'spending_trend', label: 'Spending down from last year',    value: spend, target: null, range: null,         status: trend(spend, spend < 0) },
          { key: 'income_trend',   label: 'Income up from last year',        value: inc,   target: null, range: null,         status: trend(inc, inc > 0) },
        ],
      };
    });
    // Newest year first — the year picker and the default selection both rely
    // on that order. `bands` mirrors METRIC_BANDS in
    // electron/backend/services/reportCard.js: the coloured ranges each ratio's
    // gauge is drawn against, sent once rather than per year.
    return {
      ok: true,
      years: cards.reverse(),
      bands: {
        expenseToIncome: [
          { from: 0, to: 0.70, tone: 'good' },
          { from: 0.70, to: 0.85, tone: 'caution' },
          { from: 0.85, to: 1, tone: 'bad' },
        ],
        debtToIncome: [
          { from: 0, to: 0.25, tone: 'good' },
          { from: 0.25, to: 0.40, tone: 'caution' },
          { from: 0.40, to: 1, tone: 'bad' },
        ],
        savingsRate: [
          { from: 0, to: 0.10, tone: 'bad' },
          { from: 0.10, to: 0.20, tone: 'good' },
          { from: 0.20, to: 1, tone: 'caution' },
        ],
        investedRate: [
          { from: 0, to: 0.15, tone: 'bad' },
          { from: 0.15, to: 0.40, tone: 'good' },
          { from: 0.40, to: 1, tone: 'caution' },
        ],
      },
    };
  })();

  const FL_FIXTURES = {
    // static/js/shell/license.js — Settings → License. Fixture mode reports an
    // ACTIVATED copy, so pure-UI work renders the full app rather than the
    // activation screen.
    '/api/license': {
      state: 'licensed', licensed: true, appMajor: 1,
      license: {
        licenseId: '0000000000000000', issued: '2026-01-15',
        entitlement: 1, email: 'buyer@example.com',
      },
    },
    // static/js/shell/dbactions.js, titlebar.js — DB-open/lock status shown
    // in the title bar and the New/Open Database modal.
    '/api/db/status': {
      ok: true, path: '(fixtures)', encrypted: false, locked: false,
      encryption_available: true,
    },
    // static/js/pages/dashboard.js and the Statements page (income/expense side)
    // — monthly income/expense/transfer grid, one row per month.
    '/api/data': {
      years: [year],
      entries: {
        [String(year)]: {
          January:  { income: 4200, rent: 1500, food: 520, savings: 400 },
          February: { income: 4200, rent: 1500, food: 487, savings: 400 },
          March:    { income: 4350, rent: 1500, food: 552, savings: 450 },
        },
      },
      columns: [
        { key: 'income',        label: 'Primary Income',     type: 'income'    },
        { key: 'other_income',  label: 'Other Income',       type: 'income'    },
        { key: 'uncat_income',  label: 'Uncategorized',      type: 'income'    },
        { key: 'rent',          label: 'Rent / Mortgage',    type: 'expense'   },
        { key: 'food',     label: 'Food',          type: 'expense'   },
        { key: 'uncat_expense', label: 'Uncategorized',      type: 'expense'   },
        { key: 'savings',       label: 'Savings',            type: 'transfer'  },
        { key: 'investing',     label: 'Investing',          type: 'transfer'  },
      ],
      // Provenance layers — entries above is the blend (manual ?? computed).
      // income/food cells read as transaction-computed except March
      // food, which carries a manual override; rent/savings are plain
      // hand-entered — so pure-UI work shows every cell state (computed
      // styling, override + ↺ affordance, plain manual).
      computed: {
        [String(year)]: {
          January:  { income: 4200, food: 520 },
          February: { income: 4200, food: 487 },
          March:    { income: 4350, food: 610 },
        },
      },
      manual: {
        [String(year)]: {
          January:  { rent: 1500, savings: 400 },
          February: { rent: 1500, savings: 400 },
          March:    { rent: 1500, savings: 450, food: 552 },
        },
      },
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
    // cat_type (income/expense/transfer) and ordered by position.
    '/api/categories': {
      categories: [
        { id: 1, key: 'income',     name: 'Primary Income',    cat_type: 'income',   position: 0 },
        { id: 2, key: 'side',       name: 'Side Income',       cat_type: 'income',   position: 1 },
        { id: 4, key: 'rent',       name: 'Rent / Mortgage',   cat_type: 'expense',  position: 0 },
        { id: 5, key: 'food',       name: 'Food',              cat_type: 'expense',  position: 1 },
        { id: 6, key: 'utilities',  name: 'Utilities',         cat_type: 'expense',  position: 2 },
        { id: 7, key: 'savings',    name: 'Emergency Fund',    cat_type: 'transfer', position: 0 },
        { id: 8, key: 'investing',  name: 'Brokerage',         cat_type: 'transfer', position: 1 },
        { id: 9, key: 'retirement', name: 'Retirement',        cat_type: 'transfer', position: 2 },
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
    // Recurring-spend predictions — no dashboard widget consumes this one
    // (the Recurring report below uses detectRecurringSeries, not this
    // top-N "due soon" endpoint). Empty here since fixtures don't model it.
    '/api/predictions/upcoming': { upcoming: [] },
    '/api/recurring': recurringFixture,
    '/api/recurring/candidates': recurringCandidatesFixture,
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
    // static/js/pages/topmerchants.js — the ranked merchant bars under the
    // Spending Trends chart. One fixture serves every window (query strings are
    // ignored here), so the picker changes the label and not the bars. Mixed on
    // purpose: curated display names (which draw a brand icon and link by name)
    // alongside raw bank descriptions (initials circle, linked by the substring
    // their rows share) — both tiers have to look right in UI mode. `category`
    // is the key the bar is coloured from, drawn from the Trends fixture above
    // so the two cards agree in a plain browser the way they do in the app.
    '/api/top-merchants': (() => {
      const merchants = [
        { key: 'n:trader joe\'s',  name: "Trader Joe's",     total: 2140.32, count: 61, last_date: `${year}-08-04`, category: 'food', search: "Trader Joe's" },
        { key: 'n:costco',         name: 'Costco',           total: 1875.4,  count: 22, last_date: `${year}-08-02`, category: 'food', search: 'Costco' },
        { key: 'n:amazon',         name: 'Amazon',           total: 1502.18, count: 47, last_date: `${year}-08-09`, category: '__uncategorized__', search: 'Amazon' },
        { key: 'd:city power gas', name: 'CITY POWER & GAS', total: 1284,    count: 12, last_date: `${year}-08-01`, category: 'utilities', search: 'CITY POWER' },
        { key: 'n:target',         name: 'Target',           total: 964.77,  count: 19, last_date: `${year}-07-28`, category: '__uncategorized__', search: 'Target' },
        { key: 'n:chevron',        name: 'Chevron',          total: 812.5,   count: 24, last_date: `${year}-08-07`, category: '__uncategorized__', search: 'Chevron' },
        { key: 'n:verizon',        name: 'Verizon',          total: 780,     count: 12, last_date: `${year}-08-05`, category: 'utilities', search: 'Verizon' },
        { key: 'n:comcast',        name: 'Comcast',          total: 719.88,  count: 12, last_date: `${year}-08-03`, category: 'utilities', search: 'Comcast' },
        { key: 'd:harborside dental', name: 'HARBORSIDE DENTAL', total: 640, count: 3,  last_date: `${year}-06-19`, category: '__uncategorized__', search: 'HARBORSIDE DENTAL' },
        { key: 'n:chipotle',       name: 'Chipotle',         total: 486.25,  count: 33, last_date: `${year}-08-08`, category: 'food', search: 'Chipotle' },
        { key: 'n:walgreens',      name: 'Walgreens',        total: 421.6,   count: 17, last_date: `${year}-07-31`, category: '__uncategorized__', search: 'Walgreens' },
        { key: 'n:uber',           name: 'Uber',             total: 388.14,  count: 29, last_date: `${year}-08-09`, category: '__uncategorized__', search: 'Uber' },
        { key: 'n:state farm',     name: 'State Farm',       total: 372,     count: 6,  last_date: `${year}-08-01`, category: 'rent', search: 'State Farm' },
        { key: 'd:pinehill hardware', name: 'PINEHILL HARDWARE', total: 296.4, count: 8, last_date: `${year}-07-22`, category: 'rent', search: 'PINEHILL HARDWARE' },
        { key: 'n:spotify',        name: 'Spotify',          total: 191.88,  count: 12, last_date: `${year}-08-06`, category: 'entertainment', search: 'Spotify' },
        { key: 'n:netflix',        name: 'Netflix',          total: 185.88,  count: 12, last_date: `${year}-08-04`, category: 'entertainment', search: 'Netflix' },
        { key: 'd:lakeview parking', name: 'LAKEVIEW PARKING', total: 164,   count: 41, last_date: `${year}-08-08`, category: '__uncategorized__', search: 'LAKEVIEW PARKING' },
        { key: 'n:lyft',           name: 'Lyft',             total: 142.6,   count: 11, last_date: `${year}-07-30`, category: '__uncategorized__', search: 'Lyft' },
        { key: 'd:rosewood bakery', name: 'ROSEWOOD BAKERY',  total: 118.45, count: 26, last_date: `${year}-08-07`, category: 'food', search: 'ROSEWOOD BAKERY' },
        { key: 'n:shell',          name: 'Shell',            total: 96.2,    count: 4,  last_date: `${year}-07-25`, category: '__uncategorized__', search: 'Shell' },
      ];
      // Bigger than the twenty bars add up to: the real denominator counts the
      // rows no bar was built from — see the handler's `total`.
      const total = Math.round(merchants.reduce((a, m) => a + m.total, 0) * 1.18 * 100) / 100;
      return { ok: true, window: 12, from: merchantFrom, category: null, limit: 20, total, merchants };
    })(),
    // static/js/pages/transfers.js — see transfersFixture above.
    '/api/transfers': transfersFixture,
    // static/js/widgets/forecast.js — see forecastFixture above.
    '/api/forecast': forecastFixture,
    // static/js/pages/metrics.js — see reportCardFixture above.
    '/api/report-card': reportCardFixture,
    // static/js/pages/dashboard.js — the Financial Freedom card. Mirrors
    // financialFreedom() in electron/backend/services/reportCard.js: 25 x the
    // average expenses of the complete years, and the latest net worth's share
    // of it. Figures follow reportCardFixture's four complete years (43000,
    // 45800, 47400, 46000 → 45550 average).
    '/api/financial-freedom': {
      ok: true,
      avgExpenses: 45550,
      yearsAveraged: [year - 4, year - 3, year - 2, year - 1],
      number: 1138750,
      netWorth: 115000,
      netWorthAsOf: { year, month: 7 },
      progress: 115000 / 1138750,
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

  // The single entry point every page, widget and shell module calls instead of
  // window.fetch() for /api/* URLs (see the file-level comment above for the
  // full caller list). Resolution order per call:
  //   1. Not an /api/ URL              -> pass through to real fetch().
  //   2. window.financeApi present     -> Electron: forward over IPC to
  //      preload.js's `request` bridge, which invokes 'api:request',
  //      handled in electron/main.js and routed by
  //      electron/backend/router.js to the real handlers. This is the path
  //      used by the actual shipped app.
  //   3. http(s): page origin          -> a real HTTP server is serving the
  //      page (legacy/dev workflow, e.g. `electron/scripts/verify-e2e.js`) —
  //      pass straight through to fetch() so it reaches that server.
  //   4. Otherwise (plain file:// page, no bridge, no server)
  //                                     -> fixtureResponse() above, so pages
  //      can be opened standalone for UI/design iteration.
  // An unactivated install returns 402 for everything but /api/license
  // (electron/backend/router.js). Handling that once, here, is why no page
  // references licensing — a call site sees its request fail as it would on any
  // other error, and the shell displays the explanation.
  //
  // This dispatches an event rather than showing UI: this file is the data seam
  // and contains no UI code. static/js/shell/license.js listens and raises the
  // activation screen. Under a total lockout that screen is usually already up
  // before any page issues a request, so this path is the fallback: it catches a
  // license that stops verifying mid-session.
  function notifyGated(url) {
    window.dispatchEvent(new CustomEvent('aventurine:license-required', { detail: { url } }));
  }

  /** Drop-in replacement for fetch() at the app's /api/* call sites. */
  async function apiFetch(url, opts = {}) {
    if (!isApi(url)) return fetch(url, opts);

    const method = (opts.method || 'GET').toUpperCase();

    if (window.financeApi && window.financeApi.request) {
      // opts.body arrives fetch-style (a JSON string, e.g. JSON.stringify(...));
      // financeApi.request takes a parsed object, since IPC serializes
      // structured data natively rather than JSON strings.
      let body = null;
      if (opts.body != null) {
        try { body = JSON.parse(opts.body); } catch { body = null; }
      }
      const { status, body: data } = await window.financeApi.request(method, url, body);
      if (status === 402) notifyGated(url);
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
