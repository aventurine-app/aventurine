'use strict';

// ─── Saved & Invested (Reports) ──────────────────────────────────────────────
// Two charts off ONE payload (GET /api/transfers): how much moved into the
// user's own savings and investment accounts each month, and where it went.
// "Transfer" is the DIRECTION the ledger already derives, not a category the
// user has to curate — see handlers/transfers.js for why that swap happened. Sibling of trends.js
// / topmerchants.js, and deliberately shaped like neither of them alone — the
// second chart here is the first one broken out, not a second question, so the
// two share a window picker and a single fetch. That is the whole reason there
// is one control above both cards instead of one in each card header: the
// moment the two can be set to different months, the stack stops explaining the
// line and both charts get less trustworthy for it.
//
// WHY A LINE THEN A STACK. The first question is "am I putting more or less
// away", which is a shape over time and reads off a line. The second is "and to whom",
// which is a part-to-whole broken out over the same months — the one job a
// stacked column does better than anything else. Splitting them is what keeps
// the first answer readable: a reader should not have to decode a stack to see
// a trend.
//
// COLOUR FOLLOWS THE MERCHANT, NOT ITS RANK. Slots are assigned on first sight
// and kept for as long as the page is open (see assignColors), so changing the
// window does not repaint the merchants that survived it. A reader who has
// learned that Vanguard is the blue band should not have that taken away by a
// picker. Eight is the hard ceiling — the categorical ramp is eight steps and a
// ninth would have to be a generated or reused hue, indistinguishable under
// colour-vision deficiency. The backend already folds the tail into one "Other"
// group, which wears a neutral rather than a ninth hue precisely so it never
// reads as a merchant.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), merchantAvatarHtml (avatar.js), FinanceChart (chart.js),
// UI (ui.js).

(function () {
  const WINDOW_LABELS = { 3: '3 Months', 6: '6 Months', 12: '12 Months', 24: '24 Months' };
  const ALLOWED_WINDOWS = [3, 6, 12, 24];

  // The key the backend gives the folded tail. It is not a merchant, so it gets
  // a neutral instead of a palette slot and never links into the ledger.
  const OTHER_KEY = '__other__';

  const state = {
    window: 12,
    data: null,          // { window, months, total, monthly, merchants:[…] }
    colors: new Map(),   // merchant key -> colour, kept across window changes
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

  /** Give every merchant a stable colour. Keys already on screen keep the slot
   *  they had; new ones take the lowest slot nobody is using, and only fall back
   *  to rank order once all eight are spoken for (which the backend's cap makes
   *  unreachable in one payload, but a sequence of window changes can reach). */
  function assignColors() {
    readPalettes();
    const merchants = (state.data && state.data.merchants) || [];
    const live = new Set(merchants.map((m) => m.key));
    // Forget merchants no window shows any more, so their slots come back.
    for (const key of [...state.colors.keys()]) {
      if (!live.has(key)) state.colors.delete(key);
    }
    const taken = new Set(state.colors.values());
    merchants.forEach((m, i) => {
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
    // "Other" is a bucket, not a merchant, so it wears a neutral. Giving it a
    // ninth hue would put it in the legend as though it were somebody.
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
    renderMerchants();
  }

  // The window's total, in the first card's header. A figure, not a sentence:
  // the picker beside it already says what span it covers, and the chart under
  // it says how it got there.
  function renderTotal() {
    const el = document.getElementById('transfers-total');
    if (!el || !state.data) return;
    el.textContent = state.data.total > 0 ? formatCurrency(state.data.total) : '';
  }

  function renderTrend() {
    const container = document.getElementById('transfers-chart');
    if (!container || !state.data) return;
    const { months, monthly, total, everTransferred } = state.data;

    // Two different nothings, and they want opposite things said. A ledger that
    // has never held a transfer needs a way to start; a ledger that just has not
    // held one lately needs a longer time frame, and offering it the button
    // would be answering a question it didn't ask.
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

  function renderMerchants() {
    const container = document.getElementById('transfers-merchants-chart');
    const legend = document.getElementById('transfers-legend');
    if (!container || !state.data) return;
    const { months, merchants } = state.data;

    if (!merchants.length) {
      FinanceChart.renderStacked('transfers-merchants-chart', { series: [], slots: [] });
      // Compact, and it says nothing the card above just said: an empty stack
      // and an empty line are the same nothing, and the card above already
      // named it and carries whatever action there is. Two full empty states
      // stacked is a wall, and two copies of the same advice reads as a fault.
      container.innerHTML = UI.emptyState({
        icon: 'chart', compact: true,
        title: 'Nothing to break out',
      });
      if (legend) legend.innerHTML = '';
      return;
    }

    // Ranked biggest-first, so the largest band sits on the baseline where it is
    // easiest to read and "Other" rides on top out of the way.
    const series = merchants.map((m) => ({
      label: m.name,
      color: colorOf(m),
      points: months.map((ym) => ({ ...ymToSlot(ym), value: m.monthly[ym] || 0 })),
    }));
    FinanceChart.renderStacked('transfers-merchants-chart', { series, slots: months.map(ymToSlot) });
    renderLegend(merchants);
  }

  // A legend, always: eight bands cannot be told apart by hue alone, and colour
  // is never allowed to be the only channel carrying identity. It doubles as the
  // table view — each row states the merchant's window total next to its swatch,
  // so every number in the stack is readable without hovering anything.
  function renderLegend(merchants) {
    const el = document.getElementById('transfers-legend');
    if (!el) return;
    el.innerHTML = merchants
      .map((m) => {
        const label = escapeHtml(m.name);
        const swatch = `<span class="tfr-swatch" style="background:${colorOf(m)}"></span>`;
        const amount = `<span class="tfr-legend-amount">${escapeHtml(formatCurrency(m.total))}</span>`;
        // Same rule as Top Merchants and the Recurring calendar: a group of
        // transactions opens as that group in the ledger's Name filter. "Other"
        // is not one group, so it never links.
        if (!m.search) {
          return `<span class="tfr-legend-item">${swatch}<span class="tfr-legend-name">${label}</span>${amount}</span>`;
        }
        return `<a class="tfr-legend-item tfr-legend-link" href="/transactions?name=${encodeURIComponent(m.search)}"
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
      // is preserved, so a merchant keeps its position in the ramp.
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
