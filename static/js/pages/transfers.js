'use strict';

// ─── Saved & Invested (Reports) ──────────────────────────────────────────────
// Two charts from ONE payload (GET /api/transfers): how much moved into the
// user's savings and investment accounts each month, and which account it went
// into. "Transfer" is the DIRECTION the ledger already derives, not a category
// the user maintains — see handlers/transfers.js. Related to trends.js and
// topmerchants.js, but structured differently from both: the second chart here
// is the first one broken out by account, not a separate measure, so the two
// share a window picker and a single fetch. That is why there is one control
// above both cards rather than one per card header: if the two could be set to
// different months, the stack would no longer sum to the line.
//
// WHY A LINE THEN A STACK. The first chart shows the amount saved over time,
// which is a shape best read from a line. The second breaks the same months down
// by account, which a stacked column shows best. Keeping them separate keeps
// the trend readable without decoding a stack.
//
// A BAND IS A TRANSFER ROW OF THE CASH FLOW GRID, so the stack is the
// statement's own itemisation of the line above it and the two agree by
// construction — see handlers/transfers.js.
//
// COLOUR FOLLOWS THE ACCOUNT, NOT ITS RANK. Slots are assigned on first sight
// and kept while the page is open (see assignColors), so changing the window
// does not re-colour the accounts that remain. Eight is the maximum: the
// categorical ramp has eight steps, and a ninth would need a generated or reused
// hue, indistinguishable under colour-vision deficiency. The backend folds the
// remainder into one "Other" group, which uses a neutral rather than a ninth hue
// so it is not mistaken for an account.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), FinanceChart (chart.js), UI (ui.js).

(function () {
  const WINDOW_LABELS = { 3: '3 Months', 6: '6 Months', 12: '12 Months', 24: '24 Months' };
  const ALLOWED_WINDOWS = [3, 6, 12, 24];

  // The key the backend gives the folded tail. It is not an account, so it gets
  // a neutral instead of a palette slot and never links into the ledger.
  const OTHER_KEY = '__other__';

  const state = {
    window: 12,
    data: null,          // { window, months, total, monthly, accounts:[…] }
    colors: new Map(),   // account key -> colour, kept across window changes
    palette: [],         // the eight categorical steps, re-read on theme change
    accent: '',          // the trend line's colour (the accent ramp's first step)
    other: '',           // the neutral the folded "Other" group wears
  };

  /** A theme token resolved to a concrete colour. chart.js writes colours into
   *  SVG PRESENTATION attributes (stroke="…", fill="…"), which do not evaluate
   *  var() — so a token has to be read here rather than handed through. */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  const ymToSlot = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return { year: y, monthIdx: m - 1 };
  };

  // ─── Data ──────────────────────────────────────────────────────────────────

  async function load() {
    const res = await apiFetch(`/api/transfers?window=${state.window}`);
    if (!res.ok) return;
    state.data = await res.json();
    assignColors();
    render();
  }

  /** Give every account a stable colour. Keys already on screen keep the slot
   *  they had; new ones take the lowest slot nobody is using, and only fall back
   *  to rank order once all eight are spoken for (which the backend's cap makes
   *  unreachable in one payload, but a sequence of window changes can reach). */
  function assignColors() {
    readPalettes();
    const accounts = (state.data && state.data.accounts) || [];
    const live = new Set(accounts.map((m) => m.key));
    // Drop accounts no longer in the payload, freeing their colour slots.
    for (const key of [...state.colors.keys()]) {
      if (!live.has(key)) state.colors.delete(key);
    }
    const taken = new Set(state.colors.values());
    accounts.forEach((m, i) => {
      if (m.key === OTHER_KEY || state.colors.has(m.key)) return;
      const free = [...state.palette.values()].find((c) => !taken.has(c));
      const color = free || [...state.palette.values()][i % state.palette.size];
      state.colors.set(m.key, color);
      taken.add(color);
    });
  }

  /** The eight categorical steps for the stack, the accent ramp's first step
   *  for the trend line, and a neutral for "Other". Re-read rather than cached
   *  once: every one of them retones when the colour theme flips. */
  function readPalettes() {
    state.palette = FinanceChart.colorMap([0, 1, 2, 3, 4, 5, 6, 7], 'categorical');
    // The accent ramp, not the categorical one: the trend chart is ONE measure
    // over time, so its colour is the UI's accent rather than an identity.
    state.accent = FinanceChart.colorMap([0], 'accent').get(0);
    // "Other" is a bucket, not an account, so it wears a neutral. Giving it a
    // ninth hue would put it in the legend as though it were one.
    state.other = cssVar('--text-tertiary', '#8a8a8a');
  }

  const colorOf = (m) =>
    (m.key === OTHER_KEY ? state.other : state.colors.get(m.key) || state.other);

  // ─── Render ────────────────────────────────────────────────────────────────

  function render() {
    const btn = document.getElementById('transfers-range-btn');
    if (btn) btn.textContent = WINDOW_LABELS[state.window];
    renderTotal();
    renderTrend();
    renderAccounts();
  }

  // The window's total, in the first card's header. A figure with no label: the
  // picker beside it states the span, and the chart below shows the breakdown.
  function renderTotal() {
    const el = document.getElementById('transfers-total');
    if (!el || !state.data) return;
    el.textContent = state.data.total > 0 ? formatCurrency(state.data.total) : '';
  }

  function renderTrend() {
    const container = document.getElementById('transfers-chart');
    if (!container || !state.data) return;
    const { months, monthly, total, everTransferred } = state.data;

    // Two different empty states with different messages. A ledger that has never
    // held a transfer gets a way to start; a ledger with none in this window gets
    // a suggestion to widen the time frame, not the start button.
    if (!(total > 0)) {
      FinanceChart.render('transfers-chart', { series: [], slots: [] });
      container.innerHTML = everTransferred
        ? UI.emptyState({
            icon: 'chart',
            title: 'Nothing put away in this time frame',
            desc: 'Try a longer one.',
          })
        : UI.emptyState({
            icon: 'chart',
            title: 'Nothing saved or invested yet',
            desc: 'Set a category to Transfer and Aventurine will chart what you put away.',
            action: { label: 'Open transactions', href: '/transactions', primary: true },
          });
      return;
    }

    // One series, so no legend: the card title already names what is plotted.
    // The accent ramp rather than the categorical one, for the same reason —
    // this is one measure over time, not a set of identities.
    const series = [{
      label: 'Invested',
      color: state.accent,
      points: months.map((ym) => ({ ...ymToSlot(ym), value: monthly[ym] || 0 })),
    }];
    // zeroBase: the line carries an area fill and is read against the zero-based
    // stack in the card below, so both halves of the report share one floor.
    FinanceChart.render('transfers-chart', { series, slots: months.map(ymToSlot), zeroBase: true });
  }

  function renderAccounts() {
    const container = document.getElementById('transfers-accounts-chart');
    const legend = document.getElementById('transfers-legend');
    if (!container || !state.data) return;
    const { months, accounts } = state.data;

    if (!accounts.length) {
      FinanceChart.renderStacked('transfers-accounts-chart', { series: [], slots: [] });
      // Compact, and it does not repeat the card above: an empty stack and an
      // empty line mean the same thing, and the card above already states it and
      // holds the action. Two full empty states stacked would fill the panel and
      // repeat the same message twice.
      container.innerHTML = UI.emptyState({
        icon: 'chart', compact: true,
        title: 'Nothing to break out',
      });
      if (legend) legend.innerHTML = '';
      return;
    }

    // Ranked biggest-first, so the largest band sits on the baseline where it is
    // easiest to read and "Other" rides on top out of the way.
    const series = accounts.map((m) => ({
      label: m.name,
      color: colorOf(m),
      points: months.map((ym) => ({ ...ymToSlot(ym), value: m.monthly[ym] || 0 })),
    }));
    FinanceChart.renderStacked('transfers-accounts-chart', { series, slots: months.map(ymToSlot) });
    renderLegend(accounts);
  }

  // A legend, always: eight bands cannot be told apart by hue alone, and colour
  // is never allowed to be the only channel carrying identity. It doubles as the
  // table view — each row states the account's window total next to its swatch,
  // so every number in the stack is readable without hovering anything.
  function renderLegend(accounts) {
    const el = document.getElementById('transfers-legend');
    if (!el) return;
    el.innerHTML = accounts
      .map((m) => {
        const label = escapeHtml(m.name);
        const swatch = `<span class="tfr-swatch" style="background:${colorOf(m)}"></span>`;
        const amount = `<span class="tfr-legend-amount">${escapeHtml(formatCurrency(m.total))}</span>`;
        // A band is one account, so it opens as that account in the ledger's
        // Category filter, on the stable key rather than the name. "Other" is
        // more than one and "Uncategorized" is not a category the filter can
        // address, so neither links.
        if (!m.cat) {
          return `<span class="tfr-legend-item">${swatch}<span class="tfr-legend-name">${label}</span>${amount}</span>`;
        }
        return `<a class="tfr-legend-item tfr-legend-link" href="/transactions?cat=${encodeURIComponent(m.cat)}"
          title="See ${label} transactions in the ledger">${swatch}<span class="tfr-legend-name">${label}</span>${amount}</a>`;
      })
      .join('');
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function wireRangePicker() {
    UI.wirePicker('transfers-range-btn', 'transfers-range-menu', (b) => {
      const w = parseInt(b.dataset.window, 10);
      if (!ALLOWED_WINDOWS.includes(w)) return;
      state.window = w;
      load();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('transfers-chart')) return;
    wireRangePicker();
    // Amounts and colours are both re-derived from state, so a currency or
    // theme change lands without another round trip.
    window.addEventListener('currencychange', render);
    window.addEventListener('themechange', () => {
      // The ramps flip with the theme and state.colors holds resolved values,
      // so the assignments have to be rebuilt from the new palette. Slot ORDER
      // is preserved, so an account keeps its position in the ramp.
      const order = [...state.colors.keys()];
      state.colors.clear();
      readPalettes();
      const slots = [...state.palette.values()];
      order.forEach((key, i) => state.colors.set(key, slots[i % slots.length]));
      render();
    });
    load();
  });
}());
