'use strict';

// ─── Cash Flow (Reports) — Sankey diagram ────────────────────────────────────
// The Reports page's landing report (pages/reports.html), shown when the
// "Cash Flow" tab is selected. Visualises a year's money movement as a
// Sankey: income categories on the left gather into a Net Inflow bar, that
// total crosses the middle as a channel of its own, and a second bar fans it
// back out to the expense categories on the right. Each band is sized by that
// category's total over the span on screen, and every ribbon is a gradient
// running between the colours of the two bars it joins.
//
// Pure renderer — no dedicated backend. It reuses GET /api/data (the Cash Flow
// table payload) and aggregates each category on the client, over the span the
// header's joined year+month picker names: a whole year, or one month of it. Self-contained inline SVG, the same approach as
// forecast.js / dashboard.js (CSP-clean: no CDN library, no inline handlers). Styled
// in forecast.css under the .cashflow-sankey namespace.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), UI.emptyState (ui.js), formatCurrency (currency.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // COOL on the left, WARM on the right. The two sides of this diagram are not
  // two sets of categories, they are money arriving and money leaving, and the
  // temperature split is how that reads before a single label is:
  //
  //   income (left)   — the cool --chart-inflow-* ramp, six steps deepest
  //       first, walking indigo → blue → cyan. It stops SHORT of the green and
  //       teal end of the cool range, which --chart-net holds alone: the hub is
  //       then the only thing on the diagram wearing the palette's income
  //       colour, and the sources read as feeding it rather than as already
  //       being it. Same size-order rule as the outflow side, so the main
  //       earner takes the strongest step.
  //   expenses (right)— the warm --chart-outflow-* ramp, eight steps deepest
  //       first, walking crimson → red → burnt orange → amber → gold. Bands are
  //       laid out in size order, so the biggest spend takes the strongest
  //       colour and the ramp grades MAGNITUDE rather than identity — which it
  //       can afford to do because every band prints its own name and figure on
  //       itself. (Eight separate warm HUES were measured against the dataviz
  //       validator and cannot clear its adjacent-pair separation on either
  //       surface: the warm span is too narrow to hold eight. A ramp is allowed
  //       to step smoothly, and stepping in lightness and hue at once is what
  //       buys back the separation. See the token block in style.css.)
  //
  // This is the one place the expense side stopped sharing --cat-* with the
  // Spending report and the Saved & Invested stack. Those two rank and itemize
  // categories, where a colour is a NAME; here it is a direction.
  //
  // The hub is neither ramp: --chart-net is the palette's income colour (the UI
  // accent's teal under Aventurine, the emerald under Gemstone), which is why
  // both ramps are held off that hue. Colours are read from the tokens at render
  // time so a theme or palette change re-colours the diagram; the arrays below
  // are first-paint fallbacks matching the light theme.
  // Ribbons are GRADIENTS rather than flat fills: one starts in the colour of
  // the bar it leaves and ends in the colour of the bar it meets - category to
  // net on the income side, net to category on the expense side - so the middle
  // channel's colour is what both halves hand off through. A flat ribbon had to
  // take one end's colour, which left a seam at the other end.
  const NET_FALLBACK = '#497e74';
  const INCOME_FALLBACK = ['#4d4495', '#455ba7', '#3871b5', '#2888bd', '#1d9dc2', '#29b1c3'];
  const OUTFLOW_FALLBACK = [
    '#8e2932', '#9b392f', '#a6492c', '#b05929',
    '#b8692a', '#c07a2d', '#c58b36', '#ca9d42',
  ];

  function readSankeyPalettes() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      net: v('--chart-net', NET_FALLBACK),
      income: INCOME_FALLBACK.map((fb, i) => v(`--chart-inflow-${i + 1}`, fb)),
      expense: OUTFLOW_FALLBACK.map((fb, i) => v(`--chart-outflow-${i + 1}`, fb)),
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

  const PAD = { t: 12, b: 16 };
  const LABEL_OFFSET = 10;         // gap between a node's inner edge and its label text
  const EDGE_PAD = 10;             // gap between a side column and the container edge
  const NODE_W = 13;               // node-bar thickness
  const CAP_R = 4;                 // rounding on a side bar's OUTER corners only; the inner
                                   // face is square so the ribbon meets it flush
  const MIN_BAND = 1.5;            // floor so a tiny category is still visible
  const LABEL_GAP = 32;            // min vertical spacing between adjacent labels (name + amount)
  const GAP = LABEL_GAP;           // vertical gap between stacked side nodes. Tied to the label block:
                                   // two adjacent bands are at least this far apart centre to centre
                                   // whatever they are worth, so every label sits on its own band's
                                   // centreline and the leader lines below stay unused
  const LABEL_MARGIN = 16;         // height held back at each end of a side column, so a hairline band
                                   // at the very top or bottom still has room for its own label

  /* ─── Labels sit INSIDE, over the ribbons ─────────────────────────────────
     Each category's name and amount hang off the inner face of its bar, out
     over its own ribbon, rather than in a gutter outside it. The gutter used to
     be measured off the longest label and the ribbons paid for it; with the
     labels inside, the side columns sit EDGE_PAD from the card edge and the
     ribbons get the whole width. */

  const state = {
    data: null,   // last /api/data payload
    year: null,   // selected year (number)
    month: null,  // selected month name, or null for the whole year
  };

  const ENTIRE_YEAR = 'Entire year';

  let chartObserver = null;
  let firstPaint = true;

  // Deep-link a category to the Transactions ledger, pre-filtered to that
  // category and the year on screen. The Transactions page reads these back from
  // location.search (txApplyUrlFilters). `cat` is the stable category key — the
  // same slug both this diagram (GET /api/data columns) and the Transactions
  // category list share — so it survives renames.
  function categoryHref(key) {
    // `month` narrows the ledger to the same span the diagram is drawing, so a
    // band clicked while January is on screen does not open the whole year.
    const month = state.month ? `&month=${MONTHS.indexOf(state.month) + 1}` : '';
    return `/transactions?year=${state.year}${month}&cat=${encodeURIComponent(key)}`;
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

  /** Sum each category over `year` — all 12 months, or the one named by
   *  `month` — split by income/expense. Returns
   *  { income:[{key,label,total}], expense:[…], totalIncome, totalExpense },
   *  zero categories dropped, sorted by total desc (largest bands lead).
   *  One month is the same sum over a one-element span, so the diagram, its
   *  shares and the empty state all keep working with no second code path. */
  function aggregate(year, month) {
    const cols = (state.data.columns || []);
    const months = ((state.data.entries || {})[String(year)]) || {};
    const span = month ? [month] : MONTHS;

    const totals = new Map(); // key -> running sum
    for (const m of span) {
      const cells = months[m];
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
    const { income, expense, totalIncome, totalExpense } = aggregate(state.year, state.month);
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
    // Only the space beneath the edge is available to the bands; PAD.t +
    // LABEL_MARGIN is the inset that keeps the topmost band's own label on screen.
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

    // FOUR columns, not three: the income bars, the bar their total gathers
    // into, the bar the expenses leave from, and the expense bars. That gives
    // the total a CHANNEL across the middle instead of a single bar the two
    // fans meet at, so the diagram reads as three stages of one journey. The
    // span between the side columns is split into three equal ribbon runs.
    const incomeX = EDGE_PAD;
    const expenseX = W - EDGE_PAD - NODE_W;
    const run = Math.max(0, (expenseX - incomeX - NODE_W * 3) / 3);
    const hubInX = incomeX + NODE_W + run;      // where the income arrives
    const hubOutX = hubInX + NODE_W + run;      // where the expenses leave
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

    // A horizontal fill that starts at `from` where the ribbon leaves its bar
    // and reaches `to` where it meets the next one. userSpaceOnUse so the stops
    // sit at the ribbon's real x positions rather than at its bounding box -
    // every ribbon on a side then turns colour across the same two verticals,
    // and the fan reads as one blend instead of a set of separate ones. Two
    // equal colours need no gradient, so the flat fill comes back as-is.
    let gradDefs = '';
    let gradSeq = 0;
    const rampFill = (x1, x2, from, to) => {
      if (from === to) return from;
      const id = `sk-ramp-${gradSeq++}`;
      gradDefs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"`
                + ` x1="${r1(x1)}" y1="0" x2="${r1(x2)}" y2="0">`
                + `<stop offset="0" stop-color="${from}"/>`
                + `<stop offset="1" stop-color="${to}"/></linearGradient>`;
      return `url(#${id})`;
    };
    // A side bar as a path: the two corners on the card-edge side are rounded,
    // the two on the ribbon side are square. outer: -1 → rounded on the left
    // (income), +1 → rounded on the right (expense).
    const capPath = (x, y, w, h, outer) => {
      const r = Math.min(CAP_R, h / 2, w / 2);
      const x0 = r1(x), x1 = r1(x + w), y0 = r1(y), y1 = r1(y + h);
      if (outer < 0) {
        return `M ${x1} ${y0} L ${r1(x + r)} ${y0} Q ${x0} ${y0} ${x0} ${r1(y + r)}`
             + ` L ${x0} ${r1(y + h - r)} Q ${x0} ${y1} ${r1(x + r)} ${y1} L ${x1} ${y1} Z`;
      }
      return `M ${x0} ${y0} L ${r1(x + w - r)} ${y0} Q ${x1} ${y0} ${x1} ${r1(y + r)}`
           + ` L ${x1} ${r1(y + h - r)} Q ${x1} ${y1} ${r1(x + w - r)} ${y1} L ${x0} ${y1} Z`;
    };
    // Build one side. Each category is a single link wrapping its WAVE (the
    // ribbon) + leader + labels — that whole flow is the click target, so you
    // click the big wave, not the thin end bar. The bars come back separately to
    // paint on top as bare caps, outside any link. The ribbon stacks against the
    // centre node from centerTop (income flows node→centre, expense centre→node).
    // dir points from the bar toward its labels, which sit on the INNER face:
    // +1 → income (labels to the right, over the ribbon), -1 → expense (labels
    // to the left).
    const sideMarkup = (sideNodes, anchor, dir, isIncome) => {
      const labelYs = spreadLabels(sideNodes);
      let waves = '';
      let bars = '';
      let slot = centerTop;
      sideNodes.forEach((n, i) => {
        const cy = n.y + n.h / 2;
        const ly = labelYs[i];
        const edgeX = dir > 0 ? n.x + NODE_W : n.x; // inner node edge, facing the label
        const labelX = edgeX + dir * LABEL_OFFSET;  // text anchor x
        const h = n.total * scale;                  // true height; slot stays exact
        // Income flows node→hub slot; expense flows hub slot→node, and the
        // fill ramps between the two bars' colours over that same run.
        const bh = Math.max(h, MIN_BAND);
        const d = isIncome
          ? ribbon(n.x + NODE_W, n.y, hubInX, slot, bh)
          : ribbon(hubOutX + NODE_W, slot, n.x, n.y, bh);
        const fill = isIncome
          ? rampFill(n.x + NODE_W, hubInX, n.color, NET_COLOR)
          : rampFill(hubOutX + NODE_W, n.x, NET_COLOR, n.color);
        const flow = isIncome
          ? `${escapeHtml(n.label)} → Net Inflow`
          : `Net Inflow → ${escapeHtml(n.label)}`;
        const aria = `${n.label}: ${fmtMoney(n.total)} — view transactions for ${state.year}`;

        // Wave + leader + labels are one link; the <title> gives the whole flow
        // a single hover tooltip.
        let g = `<a class="sankey-cat" href="${escapeHtml(categoryHref(n.key))}" tabindex="0" role="link" aria-label="${escapeHtml(aria)}">`
              + `<title>${flow}: ${fmtMoney(n.total)}</title>`
              + `<path class="sankey-link" d="${d}" fill="${fill}"></path>`;
        if (Math.abs(ly - cy) > 1) {
          g += `<path class="sankey-leader" d="M ${r1(edgeX)} ${r1(cy)} L ${r1(labelX)} ${r1(ly)}" fill="none"/>`;
        }
        const share = fmtShare(n.total, isIncome ? totalIncome : totalExpense);
        g += `<text class="sankey-label" x="${labelX}" y="${r1(ly - 3)}" text-anchor="${anchor}">${escapeHtml(n.label)}</text>`
           + `<text class="sankey-amount" x="${labelX}" y="${r1(ly + 13)}" text-anchor="${anchor}">${escapeHtml(fmtMoney(n.total))}`
           + (share ? ` <tspan class="sankey-share">${escapeHtml(share)}</tspan>` : '')
           + `</text></a>`;
        waves += g;

        // Bare node cap, painted on top of the waves layer (outside the link).
        bars += `<path class="sankey-node" d="${capPath(n.x, n.y, NODE_W, n.h, -dir)}" fill="${n.color}">`
              + `<title>${escapeHtml(n.label)}: ${fmtMoney(n.total)}</title></path>`;
        slot += h;
      });
      return { waves, bars };
    };

    const inc = sideMarkup(incomeNodes, 'start', 1, true);
    const exp = sideMarkup(expenseNodes, 'end', -1, false);
    // The middle stage: two bars sized to the larger side, with the Net Inflow
    // channel running between them. None of it is a category, so none of it is
    // a link; ribbons meet both bars on both faces, so neither bar has an outer
    // corner to round. The channel sits in the waves layer, under the bars.
    const netTitle = `<title>Net Inflow: ${fmtMoney(totalIncome)}</title>`;
    const channel = `<path class="sankey-link sankey-link-net"`
                  + ` d="${ribbon(hubInX + NODE_W, centerTop, hubOutX, centerTop, centerH)}"`
                  + ` fill="${NET_COLOR}">${netTitle}</path>`;

    const waves = channel + inc.waves + exp.waves;  // bottom layer: ribbons + labels (clickable)
    let bars = inc.bars + exp.bars;                 // top layer: bare node caps

    for (const hx of [hubInX, hubOutX]) {
      bars += `<rect class="sankey-node sankey-node-center" x="${r1(hx)}" y="${r1(centerTop)}"`
            + ` width="${NODE_W}" height="${r1(centerH)}" fill="${NET_COLOR}">${netTitle}</rect>`;
    }
    // The label hangs off the inner face of the first hub bar and floats out
    // over the channel, the same way a category's label floats over its ribbon.
    const cLabelX = hubInX + NODE_W + LABEL_OFFSET;
    const cLabelY = centerTop + centerH / 2;
    bars += `<text class="sankey-label" x="${r1(cLabelX)}" y="${r1(cLabelY - 3)}" text-anchor="start">Net Inflow</text>`
          + `<text class="sankey-amount" x="${r1(cLabelX)}" y="${r1(cLabelY + 13)}" text-anchor="start">${escapeHtml(fmtMoney(totalIncome))}</text>`;

    const cls = `cashflow-sankey${firstPaint ? ' sankey-enter' : ''}`;
    // Normally H*k IS boxH. It is larger only when the labels needed more room
    // than the viewport had (labelRoom / the 260 floor won above), and then the
    // svg is capped at the box and preserveAspectRatio="meet" shrinks the whole
    // diagram to fit instead of letting it spill out of .chart-area's clip.
    const drawH = boxH > 0 ? Math.min(Math.round(H * k), Math.round(boxH)) : Math.round(H * k);
    return `<svg width="${boxW}" height="${drawH}" viewBox="0 0 ${W} ${H}"`
         + ` preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"`
         + ` class="${cls}" style="display:block;">`
         + `<defs>${gradDefs}</defs>${waves}${bars}</svg>`;
  }

  // ─── Render + responsive redraw ──────────────────────────────────────────────

  function showEmpty(show) {
    const el = document.getElementById('cashflow-empty');
    const chart = document.getElementById('cashflow-chart');
    if (!el || !chart) return;
    if (show) {
      el.innerHTML = UI.emptyState({
        icon: 'chart',
        title: state.year === null
          ? 'No data yet'
          : `Nothing to chart for this ${state.month ? 'month' : 'year'}`,
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

  // ─── Span picker: year + month, one joined control ───────────────────────────
  // Two .range-selector halves sharing a seam (.range-selector-pair in
  // forecast.css). The left half picks the year, the right half picks how much
  // of it to draw: "Entire year" — the option the report opened on before the
  // month half existed — or one of the twelve months, which draws that month
  // alone with the year still shown in the half to its left.
  //
  // All twelve months are listed whatever the ledger holds, so the list is the
  // same twelve rows in the same order every time it opens and does not shuffle
  // when the year changes; a month with no rows draws the card's empty state.
  // The month choice SURVIVES a year change — "March, and now show me last
  // March" is the comparison the pair is for.

  function buildYearMenu(years) {
    const btn = document.getElementById('cashflow-year-btn');
    const menu = document.getElementById('cashflow-year-menu');
    if (!btn || !menu) return;

    const monthBtn = document.getElementById('cashflow-month-btn');
    if (!years.length) {
      btn.textContent = 'No data';
      btn.disabled = true;
      menu.innerHTML = '';
      if (monthBtn) monthBtn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (monthBtn) monthBtn.disabled = false;
    btn.textContent = String(state.year);
    menu.innerHTML = years
      .map((y) => `<button type="button" data-year="${y}">${y}</button>`)
      .join('');
  }

  function buildMonthMenu() {
    const menu = document.getElementById('cashflow-month-menu');
    if (!menu) return;
    // data-month is empty for the whole-year option, which is what state.month
    // being null means — one attribute covers both cases with no sentinel.
    menu.innerHTML = [`<button type="button" data-month="">${ENTIRE_YEAR}</button>`]
      .concat(MONTHS.map((m) => `<button type="button" data-month="${m}">${m}</button>`))
      .join('');
    // Pin the half to its widest caption, so picking September does not widen
    // the pair and shove the seam sideways under the year beside it.
    UI.lockPickerWidth(document.getElementById('cashflow-month-btn'),
      [ENTIRE_YEAR].concat(MONTHS));
  }

  function wirePickers() {
    UI.wirePicker('cashflow-year-btn', 'cashflow-year-menu', (b) => {
      const y = parseInt(b.dataset.year, 10);
      if (y === state.year) return;
      state.year = y;
      document.getElementById('cashflow-year-btn').textContent = String(y);
      render();
    });

    UI.wirePicker('cashflow-month-btn', 'cashflow-month-menu', (b) => {
      const m = b.dataset.month || null;
      if (m === state.month) return;
      state.month = m;
      document.getElementById('cashflow-month-btn').textContent = m || ENTIRE_YEAR;
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('cashflow-chart')) return;
    buildMonthMenu();
    wirePickers();
    load();
    // Retone amounts when the currency symbol changes in Settings, and repaint
    // when the theme does — the node/flow colours are CSS tokens read at draw time.
    const repaint = () => { firstPaint = false; render(); };
    window.addEventListener('currencychange', repaint);
    window.addEventListener('themechange', repaint);
  });
}());
