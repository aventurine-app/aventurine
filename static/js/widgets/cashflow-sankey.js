'use strict';

// ─── Cash Flow (Reports) — Sankey diagram ────────────────────────────────────
// Second report on the Cash Flow Reports page (pages/cash-flow.html), shown when
// the "Cash Flow" tab is selected. Visualises a year's money movement as a
// Sankey: income categories on the left feed a central Net Inflow node, which
// fans out to expense categories on the right. Each band is sized by that
// category's yearly total; the pipes are colour-blended and animated.
//
// Pure renderer — no dedicated backend. It reuses GET /api/data (the Cash Flow
// table payload) and aggregates each category across the 12 months of the
// selected year on the client. Self-contained inline SVG, the same approach as
// forecast.js / home.js (CSP-clean: no CDN library, no inline handlers). Styled
// in forecast.css under the .cashflow-sankey namespace.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), UI.emptyState (ui.js), CURRENCY_SYMBOL / formatCurrency
// (currency.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // The whole diagram stays in the UI accent family and follows the accent on a
  // palette/theme swap. Inflow vs. outflow separate by SATURATION, not hue:
  // income takes the saturated accent (--chart-* tokens) and leads on the base
  // accent at the central Net Inflow node; expenses take the greyed muted-accent
  // ramp (--chart-muted-*). Colours are read from the tokens at render time
  // (readSankeyPalettes) — the arrays below are first-paint fallbacks mirroring
  // the light-theme accent ramp.
  const NET_FALLBACK = '#8fb088';
  const INCOME_FALLBACK = ['#8fb088', '#a9c1a4', '#7c9670', '#647a59', '#5c7152', '#b6c8b2'];
  const EXPENSE_FALLBACK = ['#7d8a78', '#5f6b5b', '#737f6e', '#8b9785'];

  function readSankeyPalettes() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      net: v('--chart-1', NET_FALLBACK),
      income: ['--chart-1', '--chart-3', '--chart-5', '--chart-7', '--chart-2', '--chart-6']
        .map((n, i) => v(n, INCOME_FALLBACK[i])),
      expense: ['--chart-muted-1', '--chart-muted-2', '--chart-muted-3', '--chart-muted-4']
        .map((n, i) => v(n, EXPENSE_FALLBACK[i])),
    };
  }

  const CHART_RATIO = 320 / 800;   // taller than the line charts — Sankeys need room
  const PAD = { l: 150, r: 150, t: 28, b: 16 };
  const NODE_W = 13;               // node-bar thickness
  const GAP = 8;                   // vertical gap between stacked side nodes
  const MIN_BAND = 1.5;            // floor so a tiny category is still visible
  const LABEL_GAP = 26;            // min vertical spacing between adjacent labels (name + amount)
  const CENTER_LABEL_GAP = 12;     // breathing room between the centre label group and the Net Inflow node

  const state = {
    data: null,   // last /api/data payload
    year: null,   // selected year (number)
  };

  let chartObserver = null;
  let firstPaint = true;

  // Deep-link a category to the Transactions ledger, pre-filtered to that
  // category and the year on screen. The Transactions page reads these back from
  // location.search (txApplyUrlFilters). `cat` is the stable category key — the
  // same slug both this diagram (GET /api/data columns) and the Transactions
  // category list share — so it survives renames.
  function categoryHref(key) {
    return `/transactions?year=${state.year}&cat=${encodeURIComponent(key)}`;
  }

  // ─── Currency helpers (mirror forecast.js) ─────────────────────────────────
  const fmtMoney = (n) => formatCurrency(n, true);

  function fmtCompact(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1_000_000) return sign + CURRENCY_SYMBOL + (abs / 1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000)     return sign + CURRENCY_SYMBOL + (abs / 1_000).toFixed(1) + 'K';
    return sign + CURRENCY_SYMBOL + abs.toFixed(0);
  }

  // ─── Data ───────────────────────────────────────────────────────────────────

  async function load() {
    const res = await apiFetch('/api/data');
    if (!res.ok) return;
    state.data = await res.json();

    const years = (state.data.years || []).slice().sort((a, b) => b - a);
    if (state.year === null || !years.includes(state.year)) {
      state.year = years.length ? years[0] : null;
    }
    buildYearMenu(years);
    render();
  }

  /** Sum each category across the 12 months of `year`, split by income/expense.
   *  Returns { income:[{key,label,total}], expense:[…], totalIncome, totalExpense },
   *  zero categories dropped, sorted by total desc (largest bands lead). */
  function aggregate(year) {
    const cols = (state.data.columns || []);
    const months = ((state.data.entries || {})[String(year)]) || {};

    const totals = new Map(); // key -> running sum
    for (const month of MONTHS) {
      const cells = months[month];
      if (!cells) continue;
      for (const [key, value] of Object.entries(cells)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          totals.set(key, (totals.get(key) || 0) + value);
        }
      }
    }

    const side = (type) => cols
      .filter((c) => c.type === type)
      .map((c) => ({ key: c.key, label: c.label, total: totals.get(c.key) || 0 }))
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total);

    const income = side('income');
    const expense = side('expense');
    const sum = (arr) => arr.reduce((a, c) => a + c.total, 0);
    return { income, expense, totalIncome: sum(income), totalExpense: sum(expense) };
  }

  // ─── SVG builder ─────────────────────────────────────────────────────────────

  /** Horizontal Sankey ribbon between two equal-height slots. */
  function ribbon(sx, s0, tx, t0, h) {
    const f = (n) => Math.round(n * 100) / 100;
    const mx = (sx + tx) / 2;
    const s1 = s0 + h;
    const t1 = t0 + h;
    return `M ${f(sx)} ${f(s0)} C ${f(mx)} ${f(s0)} ${f(mx)} ${f(t0)} ${f(tx)} ${f(t0)}`
         + ` L ${f(tx)} ${f(t1)} C ${f(mx)} ${f(t1)} ${f(mx)} ${f(s1)} ${f(sx)} ${f(s1)} Z`;
  }

  function buildSVG(W) {
    const { income, expense, totalIncome, totalExpense } = aggregate(state.year);
    if (totalIncome <= 0 && totalExpense <= 0) return null; // caller → empty state

    // Accent-derived colours, read fresh so a palette/theme swap retones the diagram.
    const { net: NET_COLOR, income: INCOME_PALETTE, expense: EXPENSE_PALETTE } = readSankeyPalettes();

    // Tall enough that every category label on the busier side gets its own
    // LABEL_GAP of vertical room (so the spread pass below never has to overlap).
    const labelRoom = Math.max(income.length, expense.length) * LABEL_GAP + PAD.t + PAD.b + 12;
    const H = Math.max(Math.round(W * CHART_RATIO), labelRoom, 260);
    const availH = H - PAD.t - PAD.b;
    const maxTotal = Math.max(totalIncome, totalExpense, 1);

    // One value→px scale shared by all three columns so band widths line up. Each
    // side column also needs its inter-node gaps to fit, so take the tightest.
    const gaps = (n) => Math.max(0, n - 1) * GAP;
    const scale = Math.min(
      (availH - gaps(income.length)) / (totalIncome || 1),
      (availH - gaps(expense.length)) / (totalExpense || 1),
      availH / maxTotal
    );

    const incomeX = PAD.l;
    const expenseX = W - PAD.r - NODE_W;
    const centerX = (W - NODE_W) / 2;
    const centerH = maxTotal * scale;
    // Centre the node, but float it down off the top edge when it would otherwise
    // fill the full height (e.g. a single dominant income source), so the two-line
    // label + its CENTER_LABEL_GAP always clears the chart top.
    const centerTop = Math.max((H - centerH) / 2, CENTER_LABEL_GAP + 22);

    // Lay out a stacked side column, vertically centred. Returns nodes with y/h
    // and a colour drawn from the side's own palette, in payload order.
    const layoutSide = (items, x, palette) => {
      const colH = items.reduce((a, c) => a + Math.max(c.total * scale, MIN_BAND), 0) + gaps(items.length);
      let y = (H - colH) / 2;
      return items.map((c, i) => {
        const h = Math.max(c.total * scale, MIN_BAND);
        const node = { ...c, x, y, h, color: palette[i % palette.length] };
        y += h + GAP;
        return node;
      });
    };

    const incomeNodes = layoutSide(income, incomeX, INCOME_PALETTE);
    const expenseNodes = layoutSide(expense, expenseX, EXPENSE_PALETTE);

    // Nodes + labels. A tiny category sits on a near-zero-height node, so
    // centring its label on the node would stack it onto its neighbour. Decouple
    // the labels from the bands: push them apart to at least LABEL_GAP within the
    // chart bounds, then draw a thin leader back to each node. The bands/nodes
    // themselves stay exactly value-proportional.
    const spreadLabels = (sideNodes) => {
      const top = PAD.t + 10;
      const bottom = H - PAD.b - 12;
      const ys = sideNodes.map((n) => n.y + n.h / 2);
      for (let i = 1; i < ys.length; i++) {
        if (ys[i] < ys[i - 1] + LABEL_GAP) ys[i] = ys[i - 1] + LABEL_GAP;
      }
      // If the stack overflowed the bottom, settle it back upward from the end.
      if (ys.length && ys[ys.length - 1] > bottom) {
        ys[ys.length - 1] = bottom;
        for (let i = ys.length - 2; i >= 0; i--) {
          if (ys[i] > ys[i + 1] - LABEL_GAP) ys[i] = ys[i + 1] - LABEL_GAP;
        }
      }
      if (ys.length && ys[0] < top) {
        ys[0] = top;
        for (let i = 1; i < ys.length; i++) {
          if (ys[i] < ys[i - 1] + LABEL_GAP) ys[i] = ys[i - 1] + LABEL_GAP;
        }
      }
      return ys;
    };

    const r1 = (v) => Math.round(v * 10) / 10;
    // Build one side. Each category is a single link wrapping its WAVE (the
    // ribbon) + leader + labels — that whole flow is the click target, so you
    // click the big wave, not the thin end bar. The bars come back separately to
    // paint on top as bare caps, outside any link. The ribbon stacks against the
    // centre node from centerTop (income flows node→centre, expense centre→node).
    // dir: -1 → income (labels to the left), +1 → expense (labels to the right).
    const sideMarkup = (sideNodes, anchor, dir, isIncome) => {
      const labelYs = spreadLabels(sideNodes);
      let waves = '';
      let bars = '';
      let slot = centerTop;
      sideNodes.forEach((n, i) => {
        const cy = n.y + n.h / 2;
        const ly = labelYs[i];
        const edgeX = dir < 0 ? n.x : n.x + NODE_W; // node edge facing the label
        const labelX = edgeX + dir * 10;            // text anchor x
        const h = n.total * scale;                  // true height; slot stays exact
        // Income flows node→centre slot; expense flows centre slot→node.
        const d = isIncome
          ? ribbon(n.x + NODE_W, n.y, centerX, slot, Math.max(h, MIN_BAND))
          : ribbon(centerX + NODE_W, slot, n.x, n.y, Math.max(h, MIN_BAND));
        const flow = isIncome
          ? `${escapeHtml(n.label)} → Net Inflow`
          : `Net Inflow → ${escapeHtml(n.label)}`;
        const aria = `${n.label}: ${fmtMoney(n.total)} — view transactions for ${state.year}`;

        // Wave + leader + labels are one link; the <title> gives the whole flow
        // a single hover tooltip.
        let g = `<a class="sankey-cat" href="${escapeHtml(categoryHref(n.key))}" tabindex="0" role="link" aria-label="${escapeHtml(aria)}">`
              + `<title>${flow}: ${fmtMoney(n.total)}</title>`
              + `<path class="sankey-link" d="${d}" fill="${n.color}"></path>`;
        if (Math.abs(ly - cy) > 1) {
          g += `<path class="sankey-leader" d="M ${r1(edgeX)} ${r1(cy)} L ${r1(labelX)} ${r1(ly)}" fill="none"/>`;
        }
        g += `<text class="sankey-label" x="${labelX}" y="${r1(ly - 3)}" text-anchor="${anchor}">${escapeHtml(n.label)}</text>`
           + `<text class="sankey-amount" x="${labelX}" y="${r1(ly + 11)}" text-anchor="${anchor}">${escapeHtml(fmtCompact(n.total))}</text>`
           + `</a>`;
        waves += g;

        // Bare node cap, painted on top of the waves layer (outside the link).
        bars += `<rect class="sankey-node" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="2" fill="${n.color}">`
              + `<title>${escapeHtml(n.label)}: ${fmtMoney(n.total)}</title></rect>`;
        slot += h;
      });
      return { waves, bars };
    };

    const inc = sideMarkup(incomeNodes, 'end', -1, true);
    const exp = sideMarkup(expenseNodes, 'start', 1, false);
    const waves = inc.waves + exp.waves;   // bottom layer: ribbons + labels (clickable)
    let bars = inc.bars + exp.bars;        // top layer: bare node caps

    // Centre node — sized to the larger side; label sits above it. Not a
    // category, so it stays outside any link.
    const cLabelX = centerX + NODE_W / 2;
    bars += `<rect class="sankey-node sankey-node-center" x="${centerX}" y="${centerTop}" width="${NODE_W}" height="${centerH}" rx="2" fill="${NET_COLOR}">`
          + `<title>Net Inflow: ${fmtMoney(totalIncome)}</title></rect>`
          + `<text class="sankey-label sankey-label-center" x="${cLabelX}" y="${centerTop - CENTER_LABEL_GAP - 11}" text-anchor="middle">Net Inflow</text>`
          + `<text class="sankey-amount sankey-label-center" x="${cLabelX}" y="${centerTop - CENTER_LABEL_GAP}" text-anchor="middle">${escapeHtml(fmtCompact(totalIncome))}</text>`;

    const cls = `cashflow-sankey${firstPaint ? ' sankey-enter' : ''}`;
    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="${cls}" style="display:block;">`
         + `${waves}${bars}</svg>`;
  }

  // ─── Render + responsive redraw ──────────────────────────────────────────────

  function showEmpty(show) {
    const el = document.getElementById('cashflow-empty');
    const chart = document.getElementById('cashflow-chart');
    if (!el || !chart) return;
    if (show) {
      el.innerHTML = UI.emptyState({
        icon: 'chart',
        title: state.year === null ? 'No data yet' : 'Nothing to chart for this year',
        desc: 'Add income and expenses on the Cash Flow page and the diagram will map how your money moves.',
        action: { label: 'Open Cash Flow', href: '/statements#cash-flow', icon: 'plus', primary: true },
      });
      chart.innerHTML = '';
    } else {
      el.innerHTML = '';
    }
  }

  function render() {
    const el = document.getElementById('cashflow-chart');
    if (!el || !state.data) return;
    const target = el.parentElement || el; // .chart-area
    if (chartObserver) chartObserver.disconnect();

    let lastW = 0;
    const draw = (w) => {
      w = Math.round(w);
      if (w <= 0 || w === lastW) return;
      lastW = w;
      const svg = buildSVG(w);
      if (svg === null) { showEmpty(true); return; }
      showEmpty(false);
      el.innerHTML = svg;
      firstPaint = false;
    };

    chartObserver = new ResizeObserver((entries) => draw(entries[0].contentRect.width));
    chartObserver.observe(target);
    draw(target.clientWidth);
  }

  // ─── Year picker (mirrors forecast.js's range picker) ────────────────────────

  function buildYearMenu(years) {
    const btn = document.getElementById('cashflow-year-btn');
    const menu = document.getElementById('cashflow-year-menu');
    if (!btn || !menu) return;

    if (!years.length) {
      btn.textContent = 'No data';
      btn.disabled = true;
      menu.innerHTML = '';
      return;
    }
    btn.disabled = false;
    btn.textContent = String(state.year);
    menu.innerHTML = years
      .map((y) => `<button type="button" data-year="${y}">${y}</button>`)
      .join('');
    menu.querySelectorAll('button[data-year]').forEach((b) =>
      b.addEventListener('click', () => {
        const y = parseInt(b.dataset.year, 10);
        menu.hidden = true;
        if (y === state.year) return;
        state.year = y;
        btn.textContent = String(y);
        render();
      }));
  }

  function wireYearPicker() {
    const btn = document.getElementById('cashflow-year-btn');
    const menu = document.getElementById('cashflow-year-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!btn.disabled) menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', () => { menu.hidden = true; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('cashflow-chart')) return;
    wireYearPicker();
    load();
    // Retone amounts when the currency symbol changes in Settings.
    window.addEventListener('currencychange', () => { firstPaint = false; render(); });
  });
}());
