'use strict';

// ─── Cash Flow (Reports) — Sankey diagram ────────────────────────────────────
// The Reports page's landing report (pages/reports.html), shown when the
// "Cash Flow" tab is selected. Visualises a year's money movement as a
// Sankey: income categories on the left feed a central Net Inflow node, which
// fans out to expense categories on the right. Each band is sized by that
// category's yearly total; the pipes are colour-blended and animated.
//
// Pure renderer — no dedicated backend. It reuses GET /api/data (the Cash Flow
// table payload) and aggregates each category across the 12 months of the
// selected year on the client. Self-contained inline SVG, the same approach as
// forecast.js / dashboard.js (CSP-clean: no CDN library, no inline handlers). Styled
// in forecast.css under the .cashflow-sankey namespace.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), UI.emptyState (ui.js), formatCurrency (currency.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // The two sides use DIFFERENT colour schemes, which is what separates inflow
  // from outflow visually:
  //
  //   income (left)   — six shades of ONE colour (--chart-inflow-*). There are
  //       few sources, usually one dominant one, so they do not need separate
  //       hues; one colour leading into a hub of the same colour (--chart-net)
  //       renders as a single stream. Which colour depends on the graph palette:
  //       the UI accent under Aventurine, green under Gemstone (themes.css).
  //   expenses (right)— the --cat-* ramp, one colour per category, the same
  //       eight the Spending report uses. Under Gemstone that is eight distinct
  //       hues; under Aventurine it is eight steps of the accent, in
  //       size order, so the bands sort by lightness the way the amounts sort.
  //
  // The hub uses the inflow colour, since it is not a category and stays out of
  // the category spectrum. Colours are read from the tokens at render time so an
  // accent, theme or palette change re-colours the diagram; the arrays below are
  // first-paint fallbacks matching the light theme.
  const NET_FALLBACK = '#497e74';
  const INCOME_FALLBACK = ['#497e74', '#79b2a7', '#365e56', '#25413b', '#5b9f92', '#9bc5bd'];
  const CAT_FALLBACK = [
    '#1e2422', '#283a36', '#33514b', '#3e6860',
    '#4b7f75', '#659188', '#80a29c', '#99b3ae',
  ];

  function readSankeyPalettes() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      net: v('--chart-net', NET_FALLBACK),
      income: INCOME_FALLBACK.map((fb, i) => v(`--chart-inflow-${i + 1}`, fb)),
      expense: CAT_FALLBACK.map((fb, i) => v(`--cat-${i + 1}`, fb)),
    };
  }

  const CHART_RATIO = 320 / 800;   // taller than the line charts — Sankeys need room

  // ─── Layout width vs box width (why app zoom used to shrink the diagram) ─────
  // The paddings, gaps and label text below are fixed lengths, so they keep
  // their size while the container does not: app zoom shrinks the box in CSS
  // pixels, and the same 300px of label gutter then eats a far bigger share of
  // it. The ribbons paid for all of it — at 250% the span between the columns
  // had collapsed to almost nothing while the labels around it grew.
  //
  // So the diagram is LAID OUT wider than the box and the whole SVG is scaled
  // down to fit through a viewBox. Bands and labels shrink together, which keeps
  // the proportions the layout was tuned at, and zoom is what pays for the
  // shrink. It buys the layout the SQUARE ROOT of the zoom factor, which splits
  // the zoom between the two things asking for it: the labels still get visibly
  // larger (else the chart reads as the one thing on the page that ignored the
  // zoom) and the ribbons still get room instead of surrendering all of it. At
  // 100% this is a no-op — the box IS the layout width, nothing scales — so only
  // zoomed views change, and the type never ends up smaller than unzoomed.
  const MIN_CHART_W = 1280;   // widest we will lay out for; ~a comfortable window

  /** App zoom as a plain factor (1 = 100%). Only Electron has app zoom; in a
   *  plain browser (fixtures) window.aventurineZoom is absent. */
  function zoomFactor() {
    const z = window.aventurineZoom;
    const f = z ? Math.pow(1.2, z.get()) : 1;
    return Number.isFinite(f) && f > 1 ? f : 1;
  }

  /** Logical width to lay the diagram out at, for a box `boxW` CSS px wide. */
  function layoutWidth(boxW) {
    const stretched = Math.round(boxW * Math.sqrt(zoomFactor()));
    return Math.min(Math.max(boxW, MIN_CHART_W), stretched);
  }

  const PAD = { l: 150, r: 150, t: 28, b: 16 };
  const NODE_W = 13;               // node-bar thickness
  const MIN_BAND = 1.5;            // floor so a tiny category is still visible
  const LABEL_GAP = 32;            // min vertical spacing between adjacent labels (name + amount)
  const GAP = LABEL_GAP;           // vertical gap between stacked side nodes. Tied to the label block:
                                   // two adjacent bands are at least this far apart centre to centre
                                   // whatever they are worth, so every label sits on its own band's
                                   // centreline and the leader lines below stay unused
  const LABEL_MARGIN = 16;         // height held back at each end of a side column, so a hairline band
                                   // at the very top or bottom still has room for its own label
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

  // ─── Currency helpers ──────────────────────────────────────────────────────
  // One form, used for the printed amounts and the tooltips alike: the full
  // figure, grouped and in the user's own format. The labels are spaced a whole
  // label apart now, so there is room for it — a rounded "$14.8K" under a
  // category was hiding digits nothing else on the page hides.
  const fmtMoney = (n) => formatCurrency(n, true);

  /** A category's share of its OWN side's total — income bands read against
   *  income, expense bands against expenses — so the two columns each add up to
   *  100% and a small category is measured against something it belongs to.
   *  Under 10% keeps a decimal, since whole percents would flatten the tail of a
   *  dozen categories into a row of 1s and 0s. */
  function fmtShare(value, total) {
    if (!(total > 0)) return '';
    const pct = (value / total) * 100;
    if (pct > 0 && pct < 0.1) return '(<0.1%)';
    return `(${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)`;
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

  function buildSVG(boxW, boxH) {
    // Geometry below is in layout units; `k` maps them onto the box at the end.
    const W = layoutWidth(boxW);
    const k = boxW / W;   // 1 when the box was wide enough to lay out in directly
    const { income, expense, totalIncome, totalExpense } = aggregate(state.year);
    if (totalIncome <= 0 && totalExpense <= 0) return null; // caller → empty state

    // Read fresh so an accent/theme swap retones the diagram.
    const { net: NET_COLOR, income: INCOME_PALETTE, expense: EXPENSE_PALETTE } = readSankeyPalettes();

    // Tall enough that every category label on the busier side gets LABEL_GAP of
    // vertical room, so the spread pass below never overlaps labels.
    const labelRoom = Math.max(income.length, expense.length) * LABEL_GAP
      + PAD.t + PAD.b + LABEL_MARGIN * 2 + 12;
    // Height comes from the BOX when the page gave it one (see the
    // #rep-panel-cashflow rules in forecast.css): the card is stretched to the
    // viewport, so the diagram fills whatever is left under the header rather
    // than standing at a share of its own width. CHART_RATIO is only the
    // fallback for a box with no definite height — a plain browser opening the
    // page file without the app chrome, where nothing above sets one. Divide by
    // `k` because these are LAYOUT units and `k` is what maps them to CSS px, so
    // a zoomed (scaled-down) diagram still lands at boxH on screen.
    const wantH = boxH > 0 ? Math.round(boxH / k) : Math.round(W * CHART_RATIO);
    const H = Math.max(wantH, labelRoom, 260);
    // Every column hangs from ONE shared top edge — the diagram reads as a flat
    // lid with the bands growing downward off it, so the top ribbon on each side
    // runs straight across and the two sides are comparable from the same line.
    // The edge sits below the centre node's two-line label (PAD.t + LABEL_MARGIN
    // clears it), and only the space beneath it is available to the bands.
    const TOP = PAD.t + LABEL_MARGIN;
    const availH = H - TOP - PAD.b - LABEL_MARGIN;
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
    const centerTop = TOP;

    // Lay out a stacked side column from the shared top edge downward. Returns
    // nodes with y/h and a colour from that side's palette, in payload order.
    const layoutSide = (items, x, palette) => {
      let y = TOP;
      return items.map((c, i) => {
        const h = Math.max(c.total * scale, MIN_BAND);
        const node = { ...c, x, y, h, color: palette[i % palette.length] };
        y += h + GAP;
        return node;
      });
    };

    const incomeNodes = layoutSide(income, incomeX, INCOME_PALETTE);
    const expenseNodes = layoutSide(expense, expenseX, EXPENSE_PALETTE);

    // Nodes + labels. GAP already holds adjacent bands a label's height apart, so
    // in the normal case every label lands on its own band's centreline. This pass
    // is the backstop for the cases that beats — a very short chart, more
    // categories than the height can seat — pushing labels apart to at least
    // LABEL_GAP within the chart bounds and drawing a thin leader back to any node
    // it had to move away from. The bands stay exactly value-proportional either way.
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
        const share = fmtShare(n.total, isIncome ? totalIncome : totalExpense);
        g += `<text class="sankey-label" x="${labelX}" y="${r1(ly - 3)}" text-anchor="${anchor}">${escapeHtml(n.label)}</text>`
           + `<text class="sankey-amount" x="${labelX}" y="${r1(ly + 11)}" text-anchor="${anchor}">${escapeHtml(fmtMoney(n.total))}`
           + (share ? ` <tspan class="sankey-share">${escapeHtml(share)}</tspan>` : '')
           + `</text></a>`;
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
          + `<text class="sankey-label" x="${cLabelX}" y="${centerTop - CENTER_LABEL_GAP - 11}" text-anchor="middle">Net Inflow</text>`
          + `<text class="sankey-amount" x="${cLabelX}" y="${centerTop - CENTER_LABEL_GAP}" text-anchor="middle">${escapeHtml(fmtMoney(totalIncome))}</text>`;

    const cls = `cashflow-sankey${firstPaint ? ' sankey-enter' : ''}`;
    // Normally H*k IS boxH. It is larger only when the labels needed more room
    // than the viewport had (labelRoom / the 260 floor won above), and then the
    // svg is capped at the box and preserveAspectRatio="meet" shrinks the whole
    // diagram to fit instead of letting it spill out of .chart-area's clip.
    const drawH = boxH > 0 ? Math.min(Math.round(H * k), Math.round(boxH)) : Math.round(H * k);
    return `<svg width="${boxW}" height="${drawH}" viewBox="0 0 ${W} ${H}"`
         + ` preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"`
         + ` class="${cls}" style="display:block;">`
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
        // Name the destination, not the statement: this empty state sits
        // directly under a tab also labelled "Cash Flow", so "the Cash Flow
        // page" would read as somewhere on this page rather than Statements.
        desc: 'Add income and expenses to your Cash Flow statement and the diagram will map how your money moves.',
        action: { label: 'Open Statements', href: '/statements#cash-flow', primary: true },
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

    // Both dimensions are watched now that the diagram is laid out to the box's
    // height as well as its width. .chart-area's height comes from the flex
    // chain above it, never from this svg, so redrawing cannot resize the box
    // that triggered the redraw — no observer loop.
    let lastW = 0;
    let lastH = 0;
    const draw = (w, h) => {
      w = Math.round(w);
      h = Math.round(h || 0);
      if (w <= 0 || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      const svg = buildSVG(w, h);
      if (svg === null) { showEmpty(true); return; }
      showEmpty(false);
      el.innerHTML = svg;
      firstPaint = false;
    };

    chartObserver = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      draw(r.width, r.height);
    });
    chartObserver.observe(target);
    draw(target.clientWidth, target.clientHeight);
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
  }

  function wireYearPicker() {
    UI.wirePicker('cashflow-year-btn', 'cashflow-year-menu', (b) => {
      const y = parseInt(b.dataset.year, 10);
      if (y === state.year) return;
      state.year = y;
      document.getElementById('cashflow-year-btn').textContent = String(y);
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('cashflow-chart')) return;
    wireYearPicker();
    load();
    // Retone amounts when the currency symbol changes in Settings, and repaint
    // when the theme does — the node/flow colours are CSS tokens read at draw time.
    const repaint = () => { firstPaint = false; render(); };
    window.addEventListener('currencychange', repaint);
    window.addEventListener('themechange', repaint);
  });
}());
