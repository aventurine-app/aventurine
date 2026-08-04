'use strict';

// ─── Balance Forecast (Reports) ──────────────────────────────────────────────
// ONE account's balance, week by week, with TODAY IN THE MIDDLE: real recorded
// balances on the left, the projection on the right, meeting at a shared point.
// A projected slope only means something next to the slope it was estimated
// from, so the two are drawn together and told apart by weight — solid over a
// filled area for the past, dashed and lighter for the future, with a marked
// divider between them. All computation is server-side (GET /api/forecast);
// this file renders the two halves and owns the planned-items CRUD.
//
// The report answers one question, so it opens by answering it in a sentence —
// "if the next 3 months look like your recent history, Checking lands near
// $4,120 on Nov 4" — and then draws the shape. That sentence is normally the
// ONLY text above the chart. The stat grid that used to sit here (typical
// monthly net / projected end / lowest point, each with its own info bubble)
// made the reader assemble the sentence themselves out of three numbers; the
// provenance footnote and the "hover the line to…" instruction that briefly
// replaced it were just more words in the same place. What is left renders
// conditionally and only when it changes how the number should be read: the dip
// (when the line actually goes below where it started), the scope fallback, the
// transfers switch, and a stale starting balance. Method notes live in the
// card title's one tooltip.
//
// PLANNED ITEMS live ON the line. Each is a pin at its date, hovering (or
// clicking, which pins the card) opens a floating card carrying label, amount,
// date, pencil and trash — the same interaction the Recurring calendar gives a
// chip, for the same reason: the thing you point at should be the thing you
// edit. Adding works the way that page's day-cell + does — hovering the plot
// reveals a guide at the date under the pointer, and pressing it opens the
// dialog with that date already answered.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), CURRENCY_SYMBOL / formatCurrency / stripCurrencyValue /
// applyCurrencyFormat (currency.js), UI (ui.js).

(function () {
  const ALLOWED_MONTHS = [1, 3, 6];
  const MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const FLOW_LABEL = { expense: 'Expense', income: 'Income' };

  // Grace period before the card closes when the pointer leaves a pin — enough
  // to cross the gap into the card, which is how the pencil and trash are
  // reachable without clicking first. Same figure as the Recurring calendar.
  const CLOSE_DELAY_MS = 180;

  // Same drawings (and the same 20-box, 1.5-stroke language) as the Recurring
  // card's actions and the ledger's row actions — these are the same verbs.
  const ICONS = {
    pencil: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M14.5 3.5l2 2-9.5 9.5-3 1 1-3 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    check:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    trash:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus:   '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 5v10M5 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const state = {
    months: 3,
    account: null,          // selected Balance-Sheet account key; null = server default
    includeTransfers: true, // count transfers (money moved out) as outflows
    data: null,             // last /api/forecast payload
    activeId: null,         // planned item whose card is open, or null
    pinned: false,          // click-pinned card survives the pointer leaving
    editingId: null,        // planned item being edited in the card, or null
  };

  let closeTimer = null;
  // Geometry of the last drawn chart, so the overlay and the pins can map
  // between dates and pixels without re-deriving the scales.
  let plot = null;

  // ─── Dates ───────────────────────────────────────────────────────────────

  function todayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const DAY_MS = 86400000;
  const toUTC = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fromUTC = (ms) => {
    const dt = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
  };
  const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
  const addDays = (iso, n) => fromUTC(toUTC(iso) + n * DAY_MS);

  function fmtShortDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const thisYear = new Date().getFullYear();
    return y === thisYear ? `${MONTHS_SHORT[m - 1]} ${d}` : `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
  }

  /** 'YYYY-MM' → "March 2026", for the starting-balance provenance line. */
  function fmtMonthKey(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_LONG[m - 1]} ${y}`;
  }

  // ─── Currency ────────────────────────────────────────────────────────────

  const fmtMoney = (n) => formatCurrency(n, true);

  // Axis labels come from axisFormatter (currency.js), which is handed the whole
  // tick set: formatting ticks one at a time made distinct gridlines share a
  // label whenever the step wasn't a round thousand.

  // ─── Data ────────────────────────────────────────────────────────────────

  async function load() {
    let url = `/api/forecast?months=${state.months}`;
    if (state.account !== null) url += `&account=${encodeURIComponent(state.account)}`;
    if (!state.includeTransfers) url += '&include_transfers=0';
    const res = await apiFetch(url);
    if (!res.ok) return;
    state.data = await res.json();

    // Keep the local selection in step with what the server actually resolved
    // (e.g. the default it picked on first load).
    state.account = state.data.start_account;
    render();
  }

  function render() {
    syncAccountSelect();
    renderSummary();
    renderChartResponsive();
    if (state.activeId != null) renderCard();
  }

  const plannedItems = () => (state.data && state.data.planned) || [];
  const itemFor = (id) => plannedItems().find((p) => p.id === id) || null;

  /**
   * Whether there is anything worth drawing. `series` is NOT the test: the
   * weekly buckets are generated from the calendar, so a database with nothing
   * in it still comes back with a full set of them and the old `!series.length`
   * check never fired — a fresh install drew a flat $0 line pinned to the axis
   * with an empty left half. The real question is whether any of the three
   * things that can place or move the line exist.
   */
  function hasAnythingToShow() {
    const d = state.data;
    if (!d || !d.series || !d.series.length) return false;
    return (d.history && d.history.length > 0) || plannedItems().length > 0 || !!d.start_balance;
  }

  // ─── Account picker ──────────────────────────────────────────────────────
  // The same menu-opener button the horizon picker uses, driven by UI.openMenu
  // — so the two controls in the header are one widget wearing two labels
  // rather than a native <select> sitting next to a styled button.

  const accountBtn = () => document.getElementById('forecast-account-btn');

  function syncAccountSelect() {
    const btn = accountBtn();
    if (!btn || !state.data) return;
    const accounts = state.data.accounts || [];
    const current = accounts.find((a) => a.key === state.data.start_account);
    btn.textContent = current ? current.label : 'No accounts';
    btn.disabled = !accounts.length;
    // Pin the button to the widest account name it can ever show, so switching
    // accounts doesn't shove the horizon picker sideways (same treatment as the
    // month steppers).
    UI.lockPickerWidth(btn, accounts.length ? accounts.map((a) => a.label) : ['No accounts']);
  }

  function openAccountMenu(e) {
    const accounts = (state.data && state.data.accounts) || [];
    if (!accounts.length) return;
    e.stopPropagation();
    UI.openMenu(e.currentTarget, accounts.map((a) => ({
      // The balance rides in the MENU, where there is room for it, rather than
      // in the button — the sentence below already says what it starts from.
      label: a.balance != null ? `${a.label} — ${formatCurrency(a.balance, true)}` : `${a.label} — no balance yet`,
      selected: a.key === state.data.start_account,
      action: () => {
        if (a.key === state.account) return;
        state.account = a.key;
        closeCard();
        load();
      },
    })));
  }

  // ─── The sentence ────────────────────────────────────────────────────────

  /** Wrap a value as an emphasised span in the lead sentence. */
  const strong = (text, cls = '') =>
    `<span class="fc-lead-value${cls ? ' ' + cls : ''}">${escapeHtml(String(text))}</span>`;

  function renderSummary() {
    const el = document.getElementById('forecast-summary');
    if (!el || !state.data) return;
    const d = state.data;
    const { summary, accounts, start_account: startKey } = d;

    if (!hasAnythingToShow()) {
      el.innerHTML = UI.emptyState({
        icon: 'forecast',
        title: 'Nothing to forecast yet',
        desc: 'Import a few months of transactions, or record a cash balance on your Balance Sheet, '
          + 'and Aventurine will project your balance forward from them.',
        action: { label: 'Add transactions', href: '/transactions', icon: 'plus', primary: true },
      });
      return;
    }

    const account = (accounts || []).find((a) => a.key === startKey);
    const accountName = account ? account.label : 'your balance';
    const months = summary.monthsUsed || 0;
    const horizon = `${d.months} month${d.months === 1 ? '' : 's'}`;

    let html = '';

    // ── Lead: the answer, in a sentence. The conditional is the honest frame —
    // this is a projection of the recent past, not a prediction — and it is
    // also where the two knobs the reader just used are echoed back.
    const money = (n, extra = '') => strong(fmtMoney(n), `fc-lead-money${extra ? ' ' + extra : ''}`);
    if (months > 0) {
      html += `<p class="fc-lead">If the next ${strong(horizon)} look like your recent history,
        ${escapeHtml(accountName)} lands near
        ${money(summary.endBalance, summary.endBalance < 0 ? 'fc-neg' : '')}
        on ${strong(fmtShortDate(summary.endDate))}.</p>`;
    } else {
      // Nothing to average from: the line is whatever the user pinned to it,
      // and saying "typical month" of no months would be a fiction.
      html += `<p class="fc-lead">Not enough complete months yet to estimate a typical month —
        this line shows ${escapeHtml(accountName)} carrying
        ${money(d.start_balance)} forward with only your planned items applied.</p>`;
    }

    // ── Risk line, only when there is a risk. `dips` is false on a line that
    // only climbs, where "lowest point" was just week zero wearing a warning.
    if (summary.belowZero) {
      html += `<p class="fc-risk fc-risk-alarm">Runs out of money the week of
        ${escapeHtml(summary.lowest.label)}, down to
        ${escapeHtml(fmtMoney(summary.lowest.balance))}.</p>`;
    } else if (summary.dips) {
      html += `<p class="fc-risk">Tightest the week of ${escapeHtml(summary.lowest.label)},
        at ${escapeHtml(fmtMoney(summary.lowest.balance))}.</p>`;
    }

    // ── Caveats ONLY. There is no standing provenance line and no "hover the
    // line to…" instruction: in the ordinary case the sentence above is the
    // whole of the text here, and the method lives in the title's tooltip. What
    // survives is what would make the number wrong to read at face value, so
    // anything showing up below is worth the room it takes.
    const notes = [];
    if (d.scope === 'ledger' && account) {
      // The projection fell back to every transaction because this account owns
      // none — worth saying, since the reader picked an account by name.
      notes.push('Based on every transaction — none are assigned to this account yet.');
    }
    if (!d.include_transfers) notes.push('Transfers are not counted as spending.');
    if (notes.length) html += `<p class="fc-note">${escapeHtml(notes.join(' '))}</p>`;

    // The Balance Sheet is month-granular, so a start balance can be months old
    // while the line starts today. Say so — and say where to fix it — rather
    // than presenting a stale figure as "your balance".
    const staleNote = startBalanceNote(d, account);
    if (staleNote) html += `<p class="fc-note fc-note-warn">${staleNote}</p>`;

    el.innerHTML = html;
  }

  /** The starting-balance caveat, or '' when there is nothing worth saying.
   *  Returns HTML (it carries a link into the Balance Sheet). */
  function startBalanceNote(d, account) {
    if (!account) {
      return 'Starting from zero — no cash account on your Balance Sheet yet.';
    }
    if (account.balance == null || !d.start_as_of) {
      return `Starting from zero — ${escapeHtml(account.label)} has no balance recorded yet. `
        + '<a href="/statements">Add one on the Balance Sheet</a>.';
    }
    // Anything older than last month is stale enough that the flows since then
    // are already missing from the level the line starts at.
    const current = todayIso().slice(0, 7);
    const [cy, cm] = current.split('-').map(Number);
    const [ay, am] = d.start_as_of.split('-').map(Number);
    const monthsOld = (cy * 12 + cm) - (ay * 12 + am);
    if (monthsOld <= 1) return '';
    return `Starts from your ${escapeHtml(account.label)} balance for `
      + `${escapeHtml(fmtMonthKey(d.start_as_of))} — anything spent since is not reflected. `
      + '<a href="/statements">Update the Balance Sheet</a> for a sharper start.';
  }

  // ─── Chart ───────────────────────────────────────────────────────────────
  // Self-contained inline SVG, single weekly series, x scaled by DATE (not by
  // week index) so a planned item pins to the day it actually falls on.

  const CHART_RATIO = 240 / 800;
  const CHART_PAD = { l: 60, r: 22, t: 20, b: 34 };
  let chartObserver = null;

  function readAccent() {
    // The forecast line is a neutral projection, so it follows the UI accent and
    // retones with a palette swap — not the green/red reserved for gain/loss.
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
    return v || '#8fb088';
  }

  function niceTicks(min, max, target = 4) {
    if (max <= min) return [min];
    const rough = (max - min) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if      (norm < 2) step = 2  * mag;
    else if (norm < 5) step = 5  * mag;
    else               step = 10 * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
  }

  /**
   * The value axis. Zero is pulled into the domain when the projection actually
   * gets near it — that is when "how close to broke" is the question the chart
   * is being read for. It is NOT forced in otherwise: on a healthy $124k-$132k
   * balance, anchoring to zero squeezed the entire line into the top 6% of the
   * plot and hid every movement the report exists to show.
   */
  function valueTicks(values) {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = (hi - lo) || Math.abs(hi) || 1;
    const nearZero = lo <= 0 || lo < span * 0.5;
    return niceTicks(nearZero ? Math.min(0, lo) : lo, Math.max(0, hi), 4);
  }

  /** Catmull-Rom → bezier smoothing (same construction as dashboard.js). */
  function smoothPath(pts) {
    const f = (n) => Math.round(n * 100) / 100;
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
    let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      d += ` C ${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)},`
         + ` ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)},`
         + ` ${f(p2.x)} ${f(p2.y)}`;
    }
    return d;
  }

  /** The balance the line carries on a given date — the week that date falls
   *  in, so a pin sits ON the line rather than floating beside it. */
  function balanceOn(iso) {
    const series = state.data.series;
    for (const s of series) {
      if (iso >= s.weekStart && iso <= s.weekEnd) return s.balance;
    }
    return iso < series[0].weekStart ? state.data.anchor.balance : series[series.length - 1].balance;
  }

  /**
   * Two halves meeting at today, which sits dead centre: real weekly balances on
   * the left, the projection on the right. The split is what makes the
   * projection readable — a slope only means something next to the slope it came
   * from — and it is drawn, not just labelled: the past is a solid line over a
   * filled area, the future is dashed and lighter over a fainter one, with a
   * marked divider between them. Dashing rather than a second hue is deliberate:
   * the app carries "prediction, not record" as one step back in emphasis (see
   * .rec-occ-projected on the Recurring calendar), and red/green are spoken for
   * by gain/loss everywhere else.
   */
  function buildChartSVG(W, animate) {
    const d = state.data;
    const series = d ? d.series : [];
    // Nothing to draw — the empty state renders above instead of a flat line at
    // zero pretending to be a projection.
    if (!hasAnythingToShow()) { plot = null; return ''; }

    // The anchor — today, at the balance before any projected flow — is the LAST
    // history point and the FIRST forecast point, so the two paths join exactly.
    const anchor = d.anchor || { date: series[0].weekStart, balance: series[0].balance };
    const anchorPt = { date: anchor.date, balance: anchor.balance, anchor: true };
    const pastPts = [
      ...(d.history || []).map((h) => ({ date: h.weekEnd, balance: h.balance, past: h })),
      anchorPt,
    ];
    const futurePts = [
      anchorPt,
      ...series.map((s) => ({ date: s.weekEnd, balance: s.balance, week: s })),
    ];

    const yTicks = valueTicks([...pastPts, ...futurePts].map((p) => p.balance));
    const minVal = yTicks[0];
    const maxVal = yTicks[yTicks.length - 1];
    const valRange = maxVal - minVal || 1;

    const H = Math.max(Math.round(W * CHART_RATIO), 210);
    const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
    const CW = W - PL - PR;
    const CH = H - PT - PB;

    // Domain comes from the server, symmetric about today by construction —
    // re-deriving it from whichever points happen to exist would drift the
    // divider off centre as soon as history is shorter than the horizon.
    const domain = d.domain || { start: pastPts[0].date, end: futurePts[futurePts.length - 1].date };
    const first = domain.start;
    const totalDays = Math.max(1, daysBetween(first, domain.end));
    const xScale = (iso) => PL + (daysBetween(first, iso) / totalDays) * CW;
    const yScale = (v) => PT + CH - ((v - minVal) / valRange) * CH;

    // Published for the overlay + pins. `todayX` is where planning starts.
    plot = {
      W, H, PL, PR, PT, PB, CW, CH,
      first, last: domain.end, totalDays, xScale, yScale,
      today: anchor.date, todayX: xScale(anchor.date),
    };

    const color = readAccent();
    const lowestWeek = d.summary.lowest && d.summary.lowest.weekStart;
    const baseY = H - PB;

    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"
      class="forecast-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;

    const fmtAxis = axisFormatter(yTicks);
    for (const v of yTicks) {
      const y = yScale(v);
      svg += `<line class="chart-grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
      svg += `<text class="chart-label" x="${PL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
    }

    if (minVal < 0 && maxVal > 0) {
      const y0 = yScale(0);
      svg += `<line class="chart-zero" x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}"/>`;
    }

    // The divider: everything right of it is projected.
    svg += `<line class="fc-today-rule" x1="${plot.todayX}" y1="${PT}" x2="${plot.todayX}" y2="${baseY}"/>`;

    // X labels — up to ~9 evenly spaced across the whole domain, with the centre
    // one always reading "Today" (dropping any neighbour that would collide).
    const allPts = [...pastPts, ...futurePts.slice(1)];
    const anchorIdx = pastPts.length - 1;
    const stride = Math.max(1, Math.round(allPts.length / 9));
    allPts.forEach((p, i) => {
      if (i === anchorIdx) return;
      if (i % stride !== 0 && i !== allPts.length - 1) return;
      if (Math.abs(i - anchorIdx) < stride * 0.75) return; // too close to "Today"
      svg += `<text class="chart-label" x="${xScale(p.date)}" y="${H - PB + 18}" text-anchor="middle">${escapeHtml(fmtShortDate(p.date))}</text>`;
    });
    svg += `<text class="chart-label fc-today-label" x="${plot.todayX}" y="${H - PB + 18}" text-anchor="middle">Today</text>`;

    const gradId = 'fcgrad';
    const gradProjId = 'fcgradproj';
    const topY = yScale(maxVal);
    svg += `<defs>
      <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="0" y1="${topY}" x2="0" y2="${baseY}">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="${gradProjId}" gradientUnits="userSpaceOnUse" x1="0" y1="${topY}" x2="0" y2="${baseY}">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.11"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>`;

    const draw = (pts, { projected }) => {
      if (pts.length < 2) return '';
      const xy = pts.map((p) => ({ x: xScale(p.date), y: yScale(p.balance) }));
      const lineD = smoothPath(xy);
      const areaD = `${lineD} L ${xy[xy.length - 1].x} ${baseY} L ${xy[0].x} ${baseY} Z`;
      // pathLength on the ACTUAL line only: it normalises the path to 1 unit so
      // the draw animation can sweep it with dashoffset — which would also
      // rescale the projected line's dash pattern into one giant dash.
      return `<path class="fc-area${projected ? ' fc-area-projected' : ''}" d="${areaD}"
          fill="url(#${projected ? gradProjId : gradId})"/>
        <path class="${projected ? 'fc-line-projected' : 'fc-line-actual'}" d="${lineD}"
          ${projected ? '' : 'pathLength="1"'} fill="none" stroke="${color}"
          stroke-width="${projected ? 2 : 2.25}" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    svg += draw(pastPts, { projected: false });
    svg += draw(futurePts, { projected: true });

    const dot = (p) => {
      const isLow = p.week && p.week.weekStart === lowestWeek && d.summary.dips;
      const cls = `chart-dot${p.anchor ? ' chart-dot-anchor' : ''}`
        + `${p.week ? ' chart-dot-projected' : ''}`
        + `${isLow ? ' chart-dot-low' : ''}${p.balance < 0 ? ' chart-dot-neg' : ''}`;
      let title;
      if (p.anchor) title = `Today: ${fmtMoney(p.balance)}`;
      else if (p.past) title = `Week of ${p.past.label}: ${fmtMoney(p.balance)}`;
      else title = `Projected week of ${p.week.label}: ${fmtMoney(p.balance)} (net ${fmtMoney(p.week.net)})`;
      return `<circle class="${cls}" cx="${xScale(p.date)}" cy="${yScale(p.balance)}"
        r="${isLow ? 4.5 : 3}" fill="${color}"><title>${escapeHtml(title)}</title></circle>`;
    };
    svg += allPts.map(dot).join('');

    svg += '</svg>';
    return svg;
  }

  // ─── Planned pins (HTML overlay above the SVG) ───────────────────────────
  // Drawn as DOM rather than SVG nodes so they are ordinary focusable buttons
  // with the app's own hover/focus treatment, exactly like the Recurring
  // calendar's chips.

  function renderPins() {
    const host = document.getElementById('forecast-overlay');
    if (!host) return;
    // No chart to pin to (empty forecast, or a tab that has never been laid
    // out) — clear rather than leave the last render's pins floating over
    // nothing, and drop any card anchored to one of them.
    if (!plot || !state.data) {
      if (host.innerHTML) { host.innerHTML = ''; closeCard(); }
      return;
    }
    host.style.width = `${plot.W}px`;
    host.style.height = `${plot.H}px`;

    // Future half only. A planned item dated in the past projects nothing, and a
    // pin sitting over recorded history would read as something that happened.
    const inRange = plannedItems().filter((p) => p.date >= plot.today && p.date <= plot.last);
    host.innerHTML = inRange.map((p) => {
      const x = plot.xScale(p.date);
      const y = plot.yScale(balanceOn(p.date));
      const active = state.activeId === p.id;
      const tip = `${p.label} — ${p.flow === 'income' ? '+' : '−'}${formatCurrency(p.amount, true)} on ${fmtShortDate(p.date)}`;
      return `<button type="button" class="fc-pin fc-pin-${p.flow}${active ? ' fc-pin-active' : ''}"
        data-id="${p.id}" style="left:${x}px;top:${y}px"
        aria-label="${escapeHtml(tip)}" aria-expanded="${active ? 'true' : 'false'}"></button>`;
    }).join('');

    // The add-here guide: a vertical rule at the date under the pointer, capped
    // by one pill carrying the + and the date it would use. Hidden until the
    // plot is hovered (see .fc-guide in forecast.css) so the chart is not
    // permanently wearing a control. The date rides IN the pill rather than
    // sitting under the axis, where it landed on top of the tick labels.
    host.insertAdjacentHTML('beforeend', `<div class="fc-guide" id="fc-guide" hidden>
      <div class="fc-guide-line"></div>
      <button type="button" class="fc-guide-add" id="fc-guide-add"
        aria-label="Plan an item on this date">${ICONS.plus}<span class="fc-guide-date" id="fc-guide-date"></span></button>
    </div>`);
  }

  /** The date under a pointer x (client coords), or null when the pointer isn't
   *  over the plannable half. Planning is a FUTURE act: left of the divider is
   *  recorded history, and a planned item dated back there projects nothing. */
  function dateAtX(clientX) {
    const host = document.getElementById('forecast-overlay');
    if (!host || !plot) return null;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    if (x < plot.todayX - 4 || x > plot.PL + plot.CW + 8) return null;
    const frac = Math.min(1, Math.max(0, (x - plot.PL) / (plot.CW || 1)));
    return addDays(plot.first, Math.round(frac * plot.totalDays));
  }

  function moveGuide(clientX) {
    const guide = document.getElementById('fc-guide');
    if (!guide || !plot) return;
    const iso = dateAtX(clientX);
    if (!iso) { guide.hidden = true; return; }
    guide.hidden = false;
    guide.dataset.date = iso;
    const x = plot.xScale(iso);
    guide.style.left = `${x}px`;
    const label = document.getElementById('fc-guide-date');
    if (label) label.textContent = fmtShortDate(iso);
    const add = document.getElementById('fc-guide-add');
    if (!add) return;
    add.setAttribute('aria-label', `Plan an item on ${fmtShortDate(iso)}`);
    // The pill is centred on the guide by default; near either end of the plot
    // that would push it outside the card, which clips it. Anchor it to the
    // inside edge instead so it always stays whole.
    const EDGE = 70;
    add.classList.toggle('fc-guide-add-start', x - plot.todayX < EDGE);
    add.classList.toggle('fc-guide-add-end', (plot.PL + plot.CW) - x < EDGE);
  }

  function hideGuide() {
    const guide = document.getElementById('fc-guide');
    if (guide) guide.hidden = true;
  }

  function renderChartResponsive() {
    const el = document.getElementById('forecast-chart');
    if (!el) return;
    const target = document.getElementById('forecast-plot') || el;
    if (chartObserver) chartObserver.disconnect();

    let animate = true;
    let lastW = 0;
    const draw = (w) => {
      w = Math.round(w);
      if (w <= 0) return;
      // Re-draw on a width change, and on demand (data changed) at the same width.
      lastW = w;
      el.innerHTML = buildChartSVG(w, animate);
      animate = false;
      renderPins();
    };
    chartObserver = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastW) draw(w);
    });
    chartObserver.observe(target);
    draw(target.clientWidth);
  }

  // ─── The card ────────────────────────────────────────────────────────────
  // One floating element, reused for whichever pin is active — the row the
  // Planned Items table used to hold, now anchored to the pin it describes.
  // Parked on <body> and fixed-positioned so the page's scroll container can't
  // clip it. Mirrors #rec-pop on the Recurring page.

  function popEl() {
    let el = document.getElementById('fc-pop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fc-pop';
      el.className = 'fc-pop';
      el.hidden = true;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Planned item');
      document.body.appendChild(el);
    }
    return el;
  }

  const pinFor = (id) =>
    (id == null ? null : document.querySelector(`.fc-pin[data-id="${CSS.escape(String(id))}"]`));

  function actionBtn(action, id, icon, label, extraCls = '') {
    return `<button type="button" class="fc-action-btn ${extraCls}" data-action="${action}"
      data-id="${id}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ICONS[icon]}</button>`;
  }

  /** Display mode: label · date · amount, then the actions — one flat line, the
   *  same rhythm as the Recurring card. */
  function cardDisplayHtml(p) {
    const sign = p.flow === 'income' ? '+' : '−';
    return `<div class="fc-pop-row">
      <span class="fc-pop-label" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</span>
      <span class="fc-pop-date">${escapeHtml(fmtShortDate(p.date))}</span>
      <span class="fc-pop-amount fc-amount-${p.flow}">${escapeHtml(sign + fmtMoney(p.amount))}</span>
      <span class="fc-action-group">
        ${actionBtn('edit', p.id, 'pencil', `Edit ${p.label}`)}
        ${actionBtn('delete', p.id, 'trash', `Delete ${p.label}`, 'fc-action-delete')}
      </span>
    </div>`;
  }

  /** Edit mode: the same row as inputs, stacked so the label keeps a full row —
   *  it is usually the reason the card was opened. Nothing is written while
   *  typing; ✓ commits all four fields at once. */
  function cardEditHtml(p) {
    return `<div class="fc-pop-row fc-pop-editing">
      <input type="text" class="fc-input fc-input-label" data-field="label" maxlength="100"
        value="${escapeHtml(p.label)}" aria-label="Description" placeholder="Description">
      <div class="fc-pop-edit-fields">
        <select class="fc-input fc-select" data-field="flow" aria-label="Type">
          ${Object.keys(FLOW_LABEL).map((f) =>
            `<option value="${f}"${f === p.flow ? ' selected' : ''}>${FLOW_LABEL[f]}</option>`).join('')}
        </select>
        <input type="date" class="fc-input fc-input-date" data-field="date"
          value="${escapeHtml(p.date)}" min="${escapeHtml(plot ? plot.first : '')}"
          max="${escapeHtml(maxPlannedDate())}" aria-label="Date">
        <input type="text" inputmode="decimal" class="fc-input fc-input-amount" data-field="amount"
          value="${escapeHtml(formatCurrency(p.amount, true, { editable: true }))}" aria-label="Amount">
        <span class="fc-action-group">
          ${actionBtn('save', p.id, 'check', 'Save changes', 'fc-action-save')}
          ${actionBtn('cancel', p.id, 'cross', 'Discard changes')}
        </span>
      </div>
    </div>`;
  }

  /** The furthest date a planned item can usefully carry: the end of the
   *  longest horizon. Beyond it nothing is projected and — with the line as the
   *  only home for these — nothing would be reachable either. */
  function maxPlannedDate() {
    const t = todayIso();
    const [y, m, d] = t.split('-').map(Number);
    const total = (m - 1) + Math.max(...ALLOWED_MONTHS);
    const yy = y + Math.floor(total / 12);
    const mm = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const p = (n) => String(n).padStart(2, '0');
    return `${yy}-${p(mm)}-${p(Math.min(d, lastDay))}`;
  }

  function positionCard(anchor) {
    const pop = popEl();
    const a = anchor.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const gap = 10;
    let top = a.bottom + gap;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, a.top - r.height - gap);
    let left = a.left + a.width / 2 - r.width / 2;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - r.width - 8));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  function renderCard() {
    const pop = popEl();
    const item = itemFor(state.activeId);
    const pin = pinFor(state.activeId);
    if (!item || !pin) { closeCard(); return; }
    pop.innerHTML = state.editingId === item.id ? cardEditHtml(item) : cardDisplayHtml(item);
    pop.hidden = false;
    pop.classList.toggle('fc-pop-pinned', state.pinned);
    positionCard(pin);
  }

  function applyActiveHighlight() {
    document.querySelectorAll('.fc-pin').forEach((el) => {
      const on = state.activeId != null && el.dataset.id === String(state.activeId);
      el.classList.toggle('fc-pin-active', on);
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }

  function openCard(id, { pin = false } = {}) {
    clearTimeout(closeTimer);
    state.activeId = id;
    if (pin) state.pinned = true;
    applyActiveHighlight();
    renderCard();
  }

  function closeCard() {
    clearTimeout(closeTimer);
    state.activeId = null;
    state.pinned = false;
    state.editingId = null;
    const pop = popEl();
    pop.hidden = true;
    pop.innerHTML = '';
    applyActiveHighlight();
  }

  function scheduleClose() {
    if (state.pinned || state.editingId != null) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeCard, CLOSE_DELAY_MS);
  }

  // ─── Editing ─────────────────────────────────────────────────────────────

  function startEdit(id) {
    state.editingId = id;
    state.pinned = true;
    renderCard();
    const input = popEl().querySelector('.fc-input-label');
    if (input) { input.focus(); input.select(); }
  }

  function cancelEdit() {
    if (state.editingId == null) return;
    state.editingId = null;
    renderCard();
  }

  /** Read the card's inputs, flagging (rather than silently correcting)
   *  anything the backend would reject, so ✓ never quietly writes something the
   *  user didn't type. */
  function readEditCard() {
    const pop = popEl();
    const labelInput = pop.querySelector('.fc-input-label');
    const amountInput = pop.querySelector('.fc-input-amount');
    const dateInput = pop.querySelector('.fc-input-date');
    if (!labelInput || !amountInput || !dateInput) return null;

    const label = labelInput.value.trim();
    const amount = parseFloat(stripCurrencyValue(amountInput.value));
    const date = dateInput.value;

    labelInput.classList.toggle('invalid', !label);
    amountInput.classList.toggle('invalid', !(amount > 0));
    dateInput.classList.toggle('invalid', !/^\d{4}-\d{2}-\d{2}$/.test(date));
    if (!label || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

    return { label, amount, date, flow: pop.querySelector('[data-field="flow"]').value };
  }

  async function commitEdit(id) {
    const patch = readEditCard();
    if (!patch) return;
    const res = await apiFetch(`/api/forecast/planned/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      UI.toast("Couldn't save that item — it hasn't been stored.", { type: 'error' });
      return;
    }
    state.editingId = null;
    await load();
    followItem(id, patch.date);
  }

  /**
   * Keep an edited item in sight. Moving its date past the current horizon
   * takes its pin off the chart — and with the line as its only home, that
   * reads as "my edit deleted it". So the horizon widens to the smallest one
   * that still shows it, and the card re-opens where it landed. Same rule the
   * Recurring calendar follows when an edit moves a chip out of the month.
   */
  async function followItem(id, date) {
    if (plot && date >= plot.today && date <= plot.last) { openCard(id, { pin: true }); return; }
    const fits = ALLOWED_MONTHS.find((m) => {
      const t = todayIso();
      const [y, mo] = t.split('-').map(Number);
      const total = (mo - 1) + m;
      const end = `${y + Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
      return date < end;
    });
    if (!fits || fits === state.months) { closeCard(); return; }
    setHorizon(fits);
    await load();
    openCard(id, { pin: true });
    UI.toast(`Showing ${fits} month${fits === 1 ? '' : 's'} so ${fmtShortDate(date)} is on the chart.`);
  }

  function confirmDelete(id) {
    const item = itemFor(id);
    if (!item) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p>Delete the <strong>${escapeHtml(item.label)}</strong> planned item?</p>
      <p class="fc-dialog-note">It only affects this projection — no transaction is touched.</p>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-delete">Delete</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-delete').addEventListener('click', async () => {
      close();
      const res = await apiFetch(`/api/forecast/planned/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        UI.toast("Couldn't delete that item — try again.", { type: 'error' });
        return;
      }
      closeCard();
      await load();
    });
  }

  /** Add dialog, opened from the guide's + so the date arrives already answered
   *  — the same trade the Recurring page's day-cell + makes. It stays an
   *  editable field: the pointer said which date they meant, not that they
   *  can't have changed their mind. */
  function openAddDialog(iso) {
    closeCard();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog fc-add-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p><strong>Plan an item</strong></p>
      <p class="fc-dialog-note">A one-off payment or receipt you already know about. It bends this
        projection only — it is not a transaction, and nothing is added to your ledger.</p>
      <label class="fc-add-field">
        <span class="fc-add-label">Description</span>
        <input type="text" class="fc-dialog-input" id="fc-add-label" maxlength="100"
          placeholder="e.g. Property tax" autocomplete="off">
      </label>
      <label class="fc-add-field">
        <span class="fc-add-label">Type</span>
        <select class="fc-select" id="fc-add-flow">
          ${Object.keys(FLOW_LABEL).map((f) => `<option value="${f}">${FLOW_LABEL[f]}</option>`).join('')}
        </select>
      </label>
      <label class="fc-add-field">
        <span class="fc-add-label">Amount</span>
        <input type="text" inputmode="decimal" class="fc-dialog-input" id="fc-add-amount"
          placeholder="${escapeHtml(formatCurrency(0, true, { editable: true }))}" autocomplete="off">
      </label>
      <label class="fc-add-field">
        <span class="fc-add-label">Date</span>
        <input type="date" class="fc-dialog-input" id="fc-add-date"
          value="${escapeHtml(iso || todayIso())}"
          min="${escapeHtml(todayIso())}" max="${escapeHtml(maxPlannedDate())}">
      </label>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-add">Add</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const labelInput = overlay.querySelector('#fc-add-label');
    const flowSelect = overlay.querySelector('#fc-add-flow');
    const amountInput = overlay.querySelector('#fc-add-amount');
    const dateInput = overlay.querySelector('#fc-add-date');
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    amountInput.addEventListener('input', () => applyCurrencyFormat(amountInput));
    labelInput.focus();

    overlay.querySelector('.confirm-add').addEventListener('click', async () => {
      const label = labelInput.value.trim();
      const amount = parseFloat(stripCurrencyValue(amountInput.value));
      let invalid = false;
      const mark = (input, ok) => { input.classList.toggle('invalid', !ok); if (!ok) invalid = true; };
      mark(labelInput, !!label);
      mark(amountInput, amount > 0);
      mark(dateInput, /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value));
      if (invalid) return;

      const res = await apiFetch('/api/forecast/planned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, flow: flowSelect.value, amount, date: dateInput.value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        UI.toast(data.error || "Couldn't add that item — try again.", { type: 'error' });
        return;
      }
      const added = await res.json().catch(() => ({}));
      close();
      await load();
      if (added.item) followItem(added.item.id, added.item.date);
    });
  }

  // ─── Controls ────────────────────────────────────────────────────────────

  function setHorizon(m) {
    state.months = m;
    const btn = document.getElementById('forecast-range-btn');
    if (btn) btn.textContent = `${m} Month${m === 1 ? '' : 's'}`;
  }

  function wireRangePicker() {
    const btn = document.getElementById('forecast-range-btn');
    const menu = document.getElementById('forecast-range-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', () => { menu.hidden = true; });
    menu.querySelectorAll('button[data-months]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = parseInt(b.dataset.months, 10);
        if (!ALLOWED_MONTHS.includes(m)) return;
        setHorizon(m);
        menu.hidden = true;
        closeCard();
        load();
      }));
  }

  /** Planned items stored outside the longest horizon — they contribute nothing
   *  to any projection and have no pin to live on, so the ⋮ offers a way to be
   *  rid of them, and only when there are some. */
  function strandedItems() {
    const max = maxPlannedDate();
    const today = todayIso();
    return plannedItems().filter((p) => p.date < today || p.date > max);
  }

  function confirmClearStranded() {
    const stranded = strandedItems();
    if (!stranded.length) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p>Clear <strong>${stranded.length}</strong> planned item${stranded.length === 1 ? '' : 's'} outside the forecast?</p>
      <p class="fc-dialog-note">These are dated before today or beyond the longest horizon, so nothing
        projects them. No transaction is touched.</p>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-delete">Clear</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-delete').addEventListener('click', async () => {
      close();
      for (const p of stranded) {
        await apiFetch(`/api/forecast/planned/${p.id}`, { method: 'DELETE' });
      }
      await load();
    });
  }

  function wireKebab() {
    const btn = document.getElementById('forecast-kebab-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      const items = [{
        // Counting transfers is a real question but a rarely-changed one, so it
        // sits behind the ⋮ rather than spending a third slot in the header.
        label: 'Count transfers as spending',
        selected: state.includeTransfers,
        action: () => {
          state.includeTransfers = !state.includeTransfers;
          closeCard();
          load();
        },
      }];
      const n = strandedItems().length;
      if (n) {
        items.push({
          label: `Clear ${n} planned item${n === 1 ? '' : 's'} outside the forecast`,
          action: confirmClearStranded,
          danger: true,
        });
      }
      UI.openMenu(e.currentTarget, items);
    });
  }

  function wirePlot() {
    const overlay = document.getElementById('forecast-overlay');
    const plotBox = document.getElementById('forecast-plot');
    const pop = popEl();
    if (!overlay || !plotBox) return;

    // ── Pin → card. mouseover/mouseout (they bubble, unlike mouseenter/leave)
    // so one pair of listeners covers every pin across every re-render.
    overlay.addEventListener('mouseover', (e) => {
      const pin = e.target.closest('.fc-pin');
      if (!pin || state.editingId != null) return;
      openCard(Number(pin.dataset.id));
    });
    overlay.addEventListener('mouseout', (e) => {
      if (!e.target.closest('.fc-pin')) return;
      scheduleClose();
    });
    overlay.addEventListener('focusin', (e) => {
      const pin = e.target.closest('.fc-pin');
      if (!pin || state.editingId != null) return;
      openCard(Number(pin.dataset.id));
    });
    overlay.addEventListener('click', (e) => {
      const add = e.target.closest('#fc-guide-add');
      if (add) {
        const guide = document.getElementById('fc-guide');
        openAddDialog(guide && guide.dataset.date);
        return;
      }
      const pin = e.target.closest('.fc-pin');
      if (!pin) return;
      const id = Number(pin.dataset.id);
      // Clicking the open pin again puts the card away; otherwise a click pins
      // it, so the pointer can leave to reach the pencil/trash.
      if (state.activeId === id && state.pinned) { closeCard(); return; }
      openCard(id, { pin: true });
    });

    // ── The add-here guide follows the pointer across the plot.
    plotBox.addEventListener('mousemove', (e) => {
      if (state.editingId != null || state.pinned) { hideGuide(); return; }
      if (e.target.closest('.fc-pin')) { hideGuide(); return; }
      moveGuide(e.clientX);
    });
    plotBox.addEventListener('mouseleave', hideGuide);

    // ── Inside the card.
    pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    pop.addEventListener('mouseleave', scheduleClose);
    pop.addEventListener('click', (e) => {
      const btn = e.target.closest('.fc-action-btn');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const { action } = btn.dataset;
      if (action === 'edit') startEdit(id);
      else if (action === 'save') commitEdit(id);
      else if (action === 'cancel') cancelEdit();
      else if (action === 'delete') confirmDelete(id);
    });
    pop.addEventListener('keydown', (e) => {
      if (state.editingId != null && e.key === 'Enter') {
        e.preventDefault();
        commitEdit(state.editingId);
      }
    });
    pop.addEventListener('input', (e) => {
      if (e.target.classList.contains('fc-input-amount')) applyCurrencyFormat(e.target);
      if (e.target.classList.contains('fc-input')) e.target.classList.remove('invalid');
    });

    // A pinned card is dismissed the way every other transient surface is:
    // Escape, or a click that isn't it. Capture phase, deliberately — the
    // card's own buttons re-render it, detaching the node that was clicked, so
    // a bubbling listener would see an orphan and read the pencil as an
    // outside click. (Same reasoning as recurring.js.)
    document.addEventListener('click', (e) => {
      if (!state.pinned || e.target.closest('#fc-pop, .fc-pin, .confirm-overlay')) return;
      closeCard();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-overlay')) return;
      if (state.editingId != null) cancelEdit();
      else if (state.activeId != null) closeCard();
    });

    // The card is fixed-positioned against its pin, so it has to follow the
    // page under it (the .page scroll container scrolls, not the window).
    const reanchor = () => {
      if (state.activeId == null) return;
      const pin = pinFor(state.activeId);
      if (pin) positionCard(pin); else closeCard();
    };
    window.addEventListener('resize', reanchor);
    document.addEventListener('scroll', reanchor, true);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireRangePicker();
    wireKebab();
    wirePlot();
    const acc = accountBtn();
    if (acc) acc.addEventListener('click', openAccountMenu);
    load();
    // Re-render currency-bearing UI if the symbol changes in Settings.
    window.addEventListener('currencychange', render);
  });
}());
