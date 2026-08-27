'use strict';

// ─── Top Merchants (Reports → Spending) ──────────────────────────────────────
// The twenty merchants the user spent the most with over the selected window,
// as a ranked horizontal bar chart. Sibling of trends.js in the same panel:
// that one plots categories over time, this one totals merchants.
//
// Data comes from GET /api/top-merchants (already ranked, already capped at 20
// — the backend owns "who is one merchant", since that rule is shared with the
// Recurring page's detection).
//
// WHY HORIZONTAL BARS AND NOT THE SHARED FinanceChart: twenty merchant names
// will not fit under twenty columns, and this is one measure over twenty
// identities, not a series over time — the form that reads is a ranked list of
// bars from a common left baseline, where the eye compares lengths down one
// edge. It's rows of HTML rather than SVG for the same reason the ledger is:
// each row carries the merchant avatar (brand icon or initials, avatar.js) and
// is a link into the ledger, both of which come free in the DOM.
//
// ONE HUE, not twenty. Length already encodes the magnitude, and colour here
// would be encoding rank — which is exactly what a categorical palette must
// never do. Twenty generated hues would also be indistinguishable under CVD.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), merchantAvatarHtml (avatar.js), UI (ui.js).

(function () {
  const WINDOW_LABELS = { 3: '3 Months', 6: '6 Months', 12: '12 Months', all: 'All Time' };
  const ALLOWED_WINDOWS = ['3', '6', '12', 'all'];

  const state = {
    window: '12',
    data: null, // { window, from, limit, merchants:[…] }
  };

  // ─── Data ──────────────────────────────────────────────────────────────────

  async function load() {
    const res = await apiFetch(`/api/top-merchants?window=${encodeURIComponent(state.window)}`);
    if (!res.ok) return;
    state.data = await res.json();
    render();
  }

  // The bars are the whole report: no standing description above them, the
  // same way the Forecast card carries its method in the title's tooltip and
  // nothing else. The window picker in the header says what span they cover.
  function render() {
    const btn = document.getElementById('merchants-range-btn');
    if (btn) btn.textContent = WINDOW_LABELS[state.window];
    renderChart();
  }

  // ─── Chart ─────────────────────────────────────────────────────────────────

  // Every row is its own grid, so the amount column has to be told how wide to
  // be or each row sizes it to its own number and the bars stop sharing a right
  // edge. Measure them all rather than trusting the leader to be the longest
  // string: that only holds while every amount is formatted the same way, and
  // the width is cheap over twenty rows. `ch` is the digit advance in the
  // tabular numeric font, and the symbol and separators are narrower than a
  // digit, so this is never short.
  function amountColumnWidth(list) {
    let widest = 0;
    for (const m of list) widest = Math.max(widest, formatCurrency(m.total).length);
    return `${Math.max(widest, 5)}ch`;
  }

  function barRow(m, rank, max) {
    // Bars are scaled against the leader, so the longest fills the track and
    // the rest are read as fractions of it. A zero-length bar can't happen —
    // the backend drops merchants with nothing to show.
    const pct = max > 0 ? Math.max((m.total / max) * 100, 1.5) : 0;
    // Each bar grows a beat after the one above it, so the list reads top-down
    // in rank order the way the other charts draw left-to-right in time order.
    const delay = Math.min((rank - 1) * 25, 500);
    const label = escapeHtml(m.name);
    const inner = `${merchantAvatarHtml(m.name)}<span class="tm-name">${label}</span>`;
    // Same rule as the Recurring calendar's merchant link: a bar is a group of
    // transactions, so clicking it opens that group in the ledger's Name filter.
    // A merchant with no usable search term stays plain text rather than
    // linking to a table that would come back empty.
    const merchant = m.search
      ? `<a class="tm-merchant tm-merchant-link" href="/transactions?name=${encodeURIComponent(m.search)}"
           title="See ${label} transactions in the ledger">${inner}</a>`
      : `<span class="tm-merchant" title="${label}">${inner}</span>`;

    const times = `${m.count} transaction${m.count === 1 ? '' : 's'}`;
    // Cents are always drawn, even on a whole-dollar total. Twenty amounts in
    // one right-aligned column read as a column only if they all break at the
    // same place — a lone "$1,240" among "$1,238.47"s shifts the digits that
    // matter and the eye has to re-find the decimal point on every row.
    return `<li class="tm-row">
      <span class="tm-rank">${rank}</span>
      ${merchant}
      <span class="tm-track" title="${label}: ${times}">
        <span class="tm-fill" style="width:${pct.toFixed(2)}%;animation-delay:${delay}ms"></span>
      </span>
      <span class="tm-amount">${escapeHtml(formatCurrency(m.total))}</span>
    </li>`;
  }

  function renderChart() {
    const el = document.getElementById('merchants-chart');
    if (!el || !state.data) return;
    const list = state.data.merchants;

    if (!list.length) {
      // Compact in both readings, and no CTA: on an empty ledger the Spending
      // Trends card directly above is already showing the full empty state
      // with the "Add transactions" button, and two of those stacked is a wall.
      el.innerHTML = UI.emptyState({
        icon: 'chart', compact: true,
        title: 'No spending to rank yet',
        desc: state.window === 'all'
          ? 'Add or import some transactions and Aventurine will show who you spend the most with.'
          : 'Nothing in this time frame. Try a longer one.',
      });
      return;
    }

    // The list arrives ranked, so the leader is simply the first row.
    const max = list[0].total;
    const rows = list.map((m, i) => barRow(m, i + 1, max)).join('');
    el.innerHTML = `<ol class="tm-rows" style="--tm-amount-w:${amountColumnWidth(list)}">${rows}</ol>`;
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function wireRangePicker() {
    // The window is a STRING here ('3' … 'all'), not a month count — 'all'
    // has no number to parse.
    UI.wirePicker('merchants-range-btn', 'merchants-range-menu', (b) => {
      const w = b.dataset.window;
      if (!ALLOWED_WINDOWS.includes(w)) return;
      state.window = w;
      load();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('merchants-chart')) return;
    wireRangePicker();
    // Amounts are re-rendered from state, so a currency/format change lands
    // without another round trip.
    window.addEventListener('currencychange', render);
    load();
  });
}());
