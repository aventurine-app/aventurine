'use strict';

// ─── Top Merchants (Reports → Spending) ──────────────────────────────────────
// The twenty merchants the user spent the most with over the selected window.
// Sibling of trends.js in the same panel: that one plots categories over time,
// this one totals merchants.
//
// Data comes from GET /api/top-merchants (already ranked, already capped at 20).
// The merchant-grouping rule lives in the backend, since it is shared with the
// Recurring page's detection.
//
// WHY HORIZONTAL BARS AND NOT THE SHARED FinanceChart: twenty merchant names
// will not fit under twenty columns, and this is one measure over twenty
// merchants, not a series over time — the readable form is a ranked list of
// bars from a common left baseline, where the eye compares lengths down one
// edge. It's rows of HTML rather than SVG for the same reason the ledger is:
// each row carries the merchant avatar (brand icon or initials, avatar.js) and
// is a link into the ledger, both of which come free in the DOM.
//
// THE BAR IS A SHARE OF THE PERIOD'S SPENDING, not a share of rank 1. Scaled
// against the top merchant, the first bar always ran the full width whatever it
// was worth — a chart whose longest mark is a constant states nothing about the
// amount, only about the order, which the rank column already gives. The
// denominator is the payload's `total`: every expense in the window, including
// the rows no bar was built from (the unidentifiable ones and everything past
// rank 20), so a bar's length is its share of what was actually spent rather
// than its share of the chart.
//
// COLOUR IS THE CATEGORY, never the rank. A categorical ramp must encode
// identity, and a bar's identity is the category its merchant spent the most in
// over the window (`category` on the payload). The hues are the Spending Trends
// rail's own, arriving over `aventurine:category-colors`, so a band up in that
// chart and the bars beneath it are the same colour for the same category. They
// are applied to the rows already on screen as a custom property rather than by
// re-rendering, the same in-place refresh the merchant-icon setting uses, so a
// map that lands after the first paint does not restart the bars' animation.
// Without the map the bars keep the palette's first stop, which is what the
// card drew when every bar wore one hue.
//
// THE AMOUNT RIDES INSIDE THE BAR, at its left end, so the bar and the total
// are one column instead of two, and it appears only while the row is hovered
// or focused — the ranking is read by length, and twenty standing numbers sit
// on top of the shape they are drawn inside. The number is printed twice, one
// copy over the track and one clipped to the fill's own width, so whichever
// background a digit lands on it is drawn in the ink that reads against it — a
// short bar's amount spills onto the track in body ink rather than being
// clipped away.
//
// ONE LIST, RANK 1 TO 20, UNDER A HEADER ROW. Every row is drawn the same way,
// so the ranking is read down one column of lengths with nothing promoted out
// of it. The header names the three cells; it sits outside the <ol> so the list
// stays a list of merchants, and it shares the row grid so the labels sit over
// the cells they name.
//
// THE ROW IS THE BAR AND NOTHING ELSE. Two cells that answered "is this
// rising" — a 50px sparkline of the merchant's own months and a percentage
// pill against the window before this one — have both been removed. The card
// ranks who was spent the most with over a stated window; the direction each
// merchant is moving is a second question with its own chart above it, and
// twenty small marks answering it in the margin were the bulk of both the DOM
// and the payload.
//
// THE CATEGORY CHIP mirrors the Trends rail's focus, over the
// `aventurine:category-focus` event. Clearing it here clears it there.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), merchantAvatarHtml (avatar.js), UI (ui.js).

(function () {
  // The windows the picker offers, matching the Spending Trends card beside it
  // so the two cards of this tab cover the same spans. The endpoint also takes
  // `window=all`, which nothing here asks for.
  const WINDOW_LABELS = { 3: '3 Months', 6: '6 Months', 12: '1 Year', 24: '2 Years', 60: '5 Years' };
  const ALLOWED_WINDOWS = ['3', '6', '12', '24', '60'];
  const FOCUS_EVENT = 'aventurine:category-focus';
  const COLORS_EVENT = 'aventurine:category-colors';

  const state = {
    window: '12',
    category: null,     // { key, name } when the Trends rail has focused one
    data: null,         // { window, from, category, total, limit, merchants:[…] }
    colors: null,       // Map<categoryKey, hex> published by the Trends rail
  };

  // ─── Data ──────────────────────────────────────────────────────────────────

  async function load() {
    let url = `/api/top-merchants?window=${encodeURIComponent(state.window)}`;
    if (state.category) url += `&category=${encodeURIComponent(state.category.key)}`;
    const res = await apiFetch(url);
    if (!res.ok) return;
    state.data = await res.json();
    render();
  }

  // The bars are the whole report: no description above them, the same as the
  // Forecast card, which keeps its method in the title's tooltip. The window
  // picker in the header states the span they cover.
  function render() {
    const btn = document.getElementById('merchants-range-btn');
    if (btn) btn.textContent = WINDOW_LABELS[state.window];
    renderFilter();
    renderChart();
  }

  // ─── Category chip ─────────────────────────────────────────────────────────

  function renderFilter() {
    const el = document.getElementById('merchants-filter');
    if (!el) return;
    if (!state.category) { el.innerHTML = ''; return; }
    const name = escapeHtml(state.category.name);
    el.innerHTML = `<span class="tm-chip">${name}<button type="button" class="tm-chip-x"
      aria-label="Clear the ${name} filter">&times;</button></span>`;
    el.querySelector('.tm-chip-x').addEventListener('click', () => {
      // Dispatched rather than applied directly: the rail owns the focus, and
      // its own listener is what puts this card back to the full ranking.
      window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: null }));
    });
  }

  // ─── Bar colour ────────────────────────────────────────────────────────────

  /** #rgb / #rrggbb / rgb(...) -> [r,g,b], or null. The map arrives as whatever
   *  getComputedStyle resolved the --cat-* ramp to, which is a hex under both
   *  shipped palettes but need not stay one. */
  function parseColor(c) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(String(c || '').trim());
    if (rgb) {
      const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
    }
    return null;
  }

  /** Ink that reads against a bar, picked per bar rather than fixed. The card
   *  drew every bar in one hue and could name one ink for it; with eight the
   *  ramp runs dark to light under the accent palette, so a single ink would be
   *  unreadable at one end of it. WCAG relative luminance, against the same 0.4
   *  cut the ramp was checked at. */
  function inkFor(color) {
    const rgb = parseColor(color);
    if (!rgb) return null;
    const lin = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return L > 0.4 ? 'var(--text-primary)' : '#fff';
  }

  /** Paint the rows on screen from the current map. In place, on the rows that
   *  are already there: the map can arrive before or after the first response,
   *  and a re-render would restart twenty bar animations for a colour change. */
  function applyColors() {
    const el = document.getElementById('merchants-chart');
    if (!el) return;
    el.querySelectorAll('.tm-row[data-cat]').forEach((row) => {
      const color = state.colors && state.colors.get(row.dataset.cat);
      if (!color) {
        row.style.removeProperty('--tm-bar');
        row.style.removeProperty('--tm-bar-ink');
        return;
      }
      row.style.setProperty('--tm-bar', color);
      const ink = inkFor(color);
      if (ink) row.style.setProperty('--tm-bar-ink', ink);
      else row.style.removeProperty('--tm-bar-ink');
    });
  }

  // ─── Chart ─────────────────────────────────────────────────────────────────

  /** The merchant's own name, as a link into the ledger where one is possible.
   *  Same rule as the Recurring calendar's merchant link: a bar is a group of
   *  transactions, so clicking it opens that group in the ledger's Name filter.
   *  A merchant with no usable search term stays plain text rather than linking
   *  to a table that would come back empty. */
  function merchantLink(m, inner, cls) {
    const label = escapeHtml(m.name);
    return m.search
      ? `<a class="${cls} ${cls}-link" href="/transactions?name=${encodeURIComponent(m.search)}"
           title="See ${label} transactions in the ledger">${inner}</a>`
      : `<span class="${cls}" title="${label}">${inner}</span>`;
  }

  function barRow(m, rank, spent) {
    // The full track is everything spent in the window, so a bar's length is the
    // merchant's share of it. The floor keeps a small merchant visible as a mark
    // rather than as nothing; below it the ranking would end in a row of empty
    // tracks that all read the same.
    const share = spent > 0 ? m.total / spent : 0;
    const pct = spent > 0 ? Math.max(share * 100, 1.5) : 0;
    // Each bar animates shortly after the one above it, so the list fills
    // top-down in rank order, as the other charts fill left-to-right in time
    // order.
    const delay = Math.min((rank - 1) * 25, 500);
    const label = escapeHtml(m.name);
    const inner = `${merchantAvatarHtml(m.name)}<span class="tm-name">${label}</span>`;
    const times = `${m.count} transaction${m.count === 1 ? '' : 's'}`;
    // The share is the one thing the bar now states that nothing else on the
    // row does — the track has no printed scale, so the reading goes in the
    // tooltip beside the transaction count.
    const shareText = spent > 0 ? `, ${(share * 100).toFixed(1)}% of spending` : '';
    // Cents are always drawn, even on a whole-dollar total, so every amount
    // breaks at the same place down the column.
    const amount = escapeHtml(formatCurrency(m.total));
    const width = `width:${pct.toFixed(2)}%`;
    // data-cat carries the category the bar is coloured from; applyColors reads
    // it off the row rather than the row being re-rendered for a colour.
    const cat = m.category ? ` data-cat="${escapeHtml(m.category)}"` : '';
    return `<li class="tm-row"${cat}>
      <span class="tm-rank">${rank}</span>
      ${merchantLink(m, inner, 'tm-merchant')}
      <span class="tm-track" title="${label}: ${times}${shareText}">
        <span class="tm-fill" style="${width};animation-delay:${delay}ms"></span>
        <span class="tm-amount">${amount}</span>
        <span class="tm-amount-in" style="${width};animation-delay:${delay}ms"
          aria-hidden="true">${amount}</span>
      </span>
    </li>`;
  }

  // The column labels. Aligned by the row grid itself, so each label sits over
  // the cell it names at every breakpoint.
  const HEAD_ROW = `<div class="tm-row tm-head">
      <span>#</span>
      <span>Merchant</span>
      <span class="tm-h-total">Total</span>
    </div>`;

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
        title: state.category ? `Nothing in ${state.category.name}` : 'No spending to rank yet',
        desc: state.category
          ? 'No merchants in this category over this time frame.'
          : 'Nothing in this time frame. Try a longer one.',
      });
      return;
    }

    // Every expense in the window, named or not, ranked or not — see barRow.
    // Falls back to the ranking's own sum on an older response that carried no
    // total, which is the widest denominator available there.
    const spent = state.data.total > 0
      ? state.data.total
      : list.reduce((sum, m) => sum + m.total, 0);
    const rows = list.map((m, i) => barRow(m, i + 1, spent)).join('');
    // One wrapper holds the header and the list, so the bleed to the card's
    // edges is set once and the two grids stay in the same box.
    el.innerHTML = `<div class="tm-table">${HEAD_ROW}<ol class="tm-rows">${rows}</ol></div>`;
    applyColors();
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function wireRangePicker() {
    // The window is a STRING here ('3' … '60'), since it goes straight into the
    // query and the endpoint's own 'all' has no number to parse.
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
    // The Trends rail beside this card owns the focus. A change of category is
    // a different ranking, so it costs a request; the chip is drawn from the
    // event rather than from the response so it appears with the click.
    // The Trends rail assigns the category colours; the bars follow them. The
    // map can land either side of this card's own response, so it is stored on
    // arrival and applied to whatever rows are on screen.
    window.addEventListener(COLORS_EVENT, (e) => {
      state.colors = (e.detail && e.detail.colors) || null;
      applyColors();
    });
    window.addEventListener(FOCUS_EVENT, (e) => {
      const next = e.detail ? { key: e.detail.key, name: e.detail.name } : null;
      const same = (state.category && state.category.key) === (next && next.key);
      if (same) return;
      state.category = next;
      renderFilter();
      load();
    });
    load();
  });
}());
