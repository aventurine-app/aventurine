'use strict';

(function () {
  // ─── Recurring ──────────────────────────────────────────────────────────────
  // The calendar IS the page. Every occurrence of an adopted schedule — actual
  // past charges and projected future ones alike — renders as a chip in its
  // day cell, and the chip is where that schedule's data lives: the merchant,
  // the amount, and the rest in its tooltip. CLICKING one opens that schedule's
  // editor — the same dialog a rail row opens, on the surface the schedule
  // already lives on, so the grid is not a read-only picture of rows that can
  // only be changed elsewhere. There is no separate table of the same rows to
  // keep in sync with the grid; the two used to be the same data drawn twice.
  //
  // Nothing opens on HOVER. A chip used to open a floating card there, and a
  // card wide enough to hold a row covers the days around its chip, so crossing
  // the grid with the pointer kept hiding the part of the month being read. The
  // card is gone and opening is a click, so there is no half-open card to keep
  // alive or time out.
  //
  // Two panels frame the grid, and both answer questions the grid cannot. They
  // are scoped differently on purpose. renderSummary totals the DISPLAYED MONTH
  // by direction — money in, out and moved — which is not readable off 42 cells.
  // renderRail lists EVERY schedule against its next due date, whatever month
  // that falls in, so a quarterly bill or an annual renewal is visible from a
  // month it has nothing in; clicking one takes the calendar to it. The rail
  // also carries this page's two whole-list buttons at its foot, and a trash can
  // per row.
  //
  // EVERY change to a schedule goes through one dialog, openScheduleDialog:
  // creating and editing, from the rail, from a chip, and from a day cell's +.
  // A chip and a rail row only decide WHICH schedule; they never hold an
  // editable copy of one.
  //
  // Detection/cycle-classification/projection is server-side (GET
  // /api/recurring?month=YYYY-MM, backed by detectRecurringSeries in
  // services/predictions.js).
  //
  // Cadence is a RULE, not one of five names (services/recurrence.js): every N
  // weeks on a weekday, or every N months on a date or on an nth weekday, with
  // an optional end date. ruleLabel/ruleSentence are the two readings of one —
  // a word where there is room for a word, a line where there is room for a
  // line.
  //
  // The page starts EMPTY, however much recurring history the ledger holds:
  // detection is heuristic, so it does not populate the calendar on its own.
  // The user runs it from the rail's "Detect Schedules", ticks the patterns
  // they recognize in the picker (openDetectDialog → GET
  // /api/recurring/candidates, POST /api/recurring/adopt), and those appear on
  // the grid. Schedules are added by hand either from "Create Schedule", which
  // opens on today, or from the + a day cell reveals on hover, which opens on
  // that cell's date — the quicker route when the date is the thing being
  // thought about. Editing is a chip or a rail row; removing is the trash can on
  // a rail row, the one surface that lists every schedule whatever month it
  // falls in. See "Detect" and "Add / remove".
  //
  // Globals (loaded before this script): apiFetch (api.js), escapeHtml
  // (escape.js), formatCurrency/applyCurrencyFormat/stripCurrencyValue
  // (currency.js), merchantAvatarHtml (avatar.js), UI (ui.js).

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const DIRECTION_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
  const DIRECTION_OPTIONS = Object.keys(DIRECTION_LABEL);
  // Chips per day before the cell collapses the rest behind a "+n more" the
  // user can expand. A cap is needed (a busy 1st-of-the-month would otherwise
  // stretch one row of the grid), but nothing may become unreachable: the
  // calendar is now the only way to get at a schedule.
  const MAX_CHIPS_PER_DAY = 3;
  // Inlined so the rail's row actions do not depend on an icon font or external
  // sprite. pencil/check/cross/trash are the same drawings (and the same 20-box,
  // 1.5-stroke style) the Transactions ledger uses for its row actions, since the
  // actions are the same; `plus` is the day cell's add button, drawn to match.
  // These glyphs and the card chrome below come from UI (shell/ui.js),
  // shared with the Balance Forecast's pin cards.
  const ICONS = UI.CARD_ICONS;

  // Trash / pencil / check / cross buttons, in the markup the rail's rows use
  // (only the trash can, here — a row is its own edit control):
  // `data-action` says which, `data-key` says whose. From the shared factory
  // rather than hand-written, so these stay the same control the Transactions
  // ledger and the Balance Forecast's pin cards draw.
  const actionBtn = UI.cardActions('rec', 'key');

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function addMonthKey(key, n) {
    const [y, m] = key.split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    const year = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return `${year}-${String(mo).padStart(2, '0')}`;
  }

  // Mirror of services/predictions.js's normaliseDesc — used client-side only to
  // warn the Add-schedule dialog when a name produces no letters in the key. The
  // backend is authoritative and re-derives this on save.
  function normaliseDesc(desc) {
    return String(desc || '').toLowerCase().replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim();
  }

  let month = currentMonthKey();
  let data = { series: [], occurrences: [] };
  // key -> schedule, rebuilt whenever `data` is. Every chip on the grid asks for
  // its schedule by key (occLabel), so a scan per chip would make one render
  // cost chips x schedules.
  let seriesByKey = new Map();
  // The schedule a rail row is being pointed at. Hovering the rail lights that
  // schedule's chips up on the grid: the rail is for finding a schedule on the
  // calendar, and the chips are where it is.
  let railHoverKey = null;
  // The schedule a rail row was CLICKED on, which is the same mark made to stay:
  // the click takes the calendar to that schedule's month, and the highlight is
  // then the whole answer — it is what says which of that month's chips is the
  // one just asked for. It outlives the pointer. Another row, Escape, or
  // stepping to another month by hand ends it.
  let pickedKey = null;
  // ISO dates whose "+n more" the user expanded, so the extra chips stay put
  // across re-renders within the month.
  const expandedDays = new Set();

  // ─── Calendar ────────────────────────────────────────────────────────────

  function seriesFor(key) {
    return seriesByKey.get(key) || {};
  }

  function occLabel(occ) {
    const s = seriesFor(occ.key);
    return s.display_name || s.description || occ.key;
  }

  /** The schedule marked on both surfaces, from the two things that can name
   *  one: the rail row under the pointer, and the rail row last clicked (or
   *  saved). Hover sits above the click deliberately — running the pointer down
   *  the rail reads each schedule in turn, and the picked row takes the mark
   *  back when the pointer leaves.
   *
   *  The markup builders and applyActiveHighlight both read it, so a re-render
   *  and a re-mark can never disagree about what is lit. */
  function activeKey() {
    return railHoverKey || pickedKey;
  }

  /** One occurrence, as a chip in its day cell: merchant avatar, name, amount.
   *  This is the schedule's home on the page, so it is also where that schedule
   *  is opened for editing: a <button>, opening the same dialog the rail row
   *  does. It spent a while as a plain tile, from when clicking it opened a
   *  floating card that only re-read the fields the chip already draws; the
   *  editor is not that — it is the one thing the grid cannot show.
   *
   *  `title` carries what a narrow day cell cannot: the name ellipses first, and
   *  a projected charge has to say that it is one. It stays a tooltip rather
   *  than a line of text so it takes none of the grid.
   *
   *  The avatar is the same deterministic colour+initials circle the ledger uses
   *  (avatar.js), so a merchant renders identically everywhere. Direction is
   *  shown by the chip's tint (the rec-occ-<direction> class, recurring.css),
   *  not by the circle. */
  function chipHtml(occ) {
    const label = occLabel(occ);
    const cls = `rec-occ rec-occ-${occ.direction} rec-occ-${occ.actual ? 'actual' : 'projected'}`
      + (activeKey() === occ.key ? ' rec-occ-active' : '');
    const tip = `${label} — ${formatCurrency(occ.amount, true)}${occ.actual ? '' : ' (projected)'}`;
    return `<button type="button" class="${cls}" aria-haspopup="dialog"
      data-key="${escapeHtml(occ.key)}" data-date="${escapeHtml(occ.date)}"
      title="${escapeHtml(tip)}">
      ${merchantAvatarHtml(label)}
      <span class="rec-occ-name">${escapeHtml(label)}</span>
      <span class="rec-occ-amount">${escapeHtml(formatCurrency(occ.amount, true))}</span>
    </button>`;
  }

  function renderCalendar() {
    const host = document.getElementById('rec-calendar');
    if (!host) return;

    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const startWeekday = new Date(y, m - 1, 1).getDay(); // 0=Sun

    const byDate = new Map();
    for (const occ of data.occurrences) {
      let arr = byDate.get(occ.date);
      if (!arr) { arr = []; byDate.set(occ.date, arr); }
      arr.push(occ);
    }

    const today = todayIso();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push({ outside: true });
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      cells.push({ day, iso, occs: byDate.get(iso) || [] });
    }
    while (cells.length % 7 !== 0) cells.push({ outside: true });

    const cellHtml = cells.map((c) => {
      if (c.outside) return '<div class="rec-day rec-day-outside"></div>';
      const expanded = expandedDays.has(c.iso);
      const shown = expanded ? c.occs : c.occs.slice(0, MAX_CHIPS_PER_DAY);
      const overflow = c.occs.length - shown.length;
      const chips = shown.map(chipHtml).join('')
        + (overflow > 0
          ? `<button type="button" class="rec-day-more" data-expand="${c.iso}">+${overflow} more</button>`
          : '')
        + (expanded && c.occs.length > MAX_CHIPS_PER_DAY
          ? `<button type="button" class="rec-day-more" data-expand="${c.iso}">Show less</button>`
          : '');
      // Add-here button, revealed by hovering the cell (recurring.css). Adding by
      // hand is anchored to a DATE, so the control is on the day cell and the due
      // date is the cell the pointer is in, rather than a field in a menu.
      const add = `<button type="button" class="rec-day-add" data-add="${c.iso}"
        title="Add a recurring schedule due ${escapeHtml(fmtShortDate(c.iso))}"
        aria-label="Add a recurring schedule due ${escapeHtml(fmtShortDate(c.iso))}">${ICONS.plus}</button>`;
      return `<div class="rec-day${c.iso === today ? ' rec-day-today' : ''}">
        <span class="rec-day-num">${c.day}</span>
        ${add}
        <div class="rec-day-occs">${chips}</div>
      </div>`;
    }).join('');

    host.innerHTML = `<div class="rec-cal-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="rec-cal-grid">${cellHtml}</div>`;
  }

  // ─── Month totals ────────────────────────────────────────────────────────
  // The three figures above the grid: what the displayed month is expected to
  // bring in, pay out and move. They total the OCCURRENCES the calendar is
  // drawing — recorded charges and projections alike — so the row can never
  // disagree with the chips underneath it, and stepping to another month
  // retotals with it.
  //
  // Ledger amounts are positive magnitudes (direction carries the sign), so all
  // three figures are positive and it is the label and the colour that tell
  // them apart, not a minus sign.

  const SUMMARY_TILES = [
    ['income', 'Expected income'],
    ['expense', 'Expected expenses'],
    ['transfer', 'Expected transfers'],
  ];

  function monthTotals() {
    const totals = { income: 0, expense: 0, transfer: 0 };
    for (const occ of data.occurrences) {
      if (Object.hasOwn(totals, occ.direction)) totals[occ.direction] += occ.amount;
    }
    return totals;
  }

  function renderSummary() {
    const host = document.getElementById('rec-summary');
    if (!host) return;
    const totals = monthTotals();
    host.innerHTML = SUMMARY_TILES.map(([direction, label]) => `<div class="rec-sum-tile">
      <span class="rec-sum-label">${label}</span>
      <span class="rec-sum-value rec-amount-${direction}">${escapeHtml(formatCurrency(totals[direction], true))}</span>
    </div>`).join('');
  }

  // ─── The rail ────────────────────────────────────────────────────────────
  // EVERY adopted schedule, soonest due first, against the date its next charge
  // falls on. Deliberately not month-scoped, unlike the totals above it: the
  // month on screen shows what is due inside it, and the rail answers the other
  // question, "what is running and what is coming", including a quarterly bill
  // or an annual renewal that lands nowhere near the month being looked at.
  //
  // A row is the EDIT control for its schedule: clicking one opens the editor
  // dialog. That is why there is no pencil beside it — a 28px button repeating
  // what the whole row already does, on a row whose only other reading was a
  // highlight, is one control too many.
  //
  // Hovering still wires the rail to the grid, which is the other half of what
  // the panel is for: it lights that schedule's chips where the month on screen
  // has any, so the rail finds a schedule on the calendar without opening
  // anything. The mark is also what a saved edit leaves behind (goToSchedule),
  // which is how the editor answers "where did that land".

  /** A row is a <div>, not a <button>: it holds the button that opens the editor
   *  AND the trash can, and a button cannot nest inside another one. The row
   *  carries the schedule's key, so both controls act on the same schedule. No
   *  date: the row is not tied to one occurrence.
   *
   *  Three fields: the merchant, the cadence and the next due date. Cadence is
   *  the one that says whether a date months out is normal or a lapse, so the
   *  rail answers "what is running, and how often" on its own — a chip's card is
   *  only needed for the amount. ruleLabel is the short reading; the full
   *  sentence (interval, day, end date) is the cell's tooltip. */
  function railRowHtml(s) {
    const label = s.display_name || s.description || s.key;
    // The next occurrence on or after today — the backend walks a lapsed
    // schedule forward (nextDueOnOrAfter). A schedule whose end date has passed
    // has no next one at all, and says so: it stays listed, greyed, until the
    // user deletes it, because a row that vanished on its end date would read as
    // data the app lost.
    const due = s.ended ? 'Ended' : (s.next_date ? fmtShortDate(s.next_date) : '');
    const active = activeKey() === s.key;
    return `<div class="rec-rail-row${active ? ' rec-rail-active' : ''}${s.ended ? ' rec-rail-ended' : ''}"
      data-key="${escapeHtml(s.key)}">
      <button type="button" class="rec-rail-open" aria-haspopup="dialog"
        title="Edit ${escapeHtml(label)}">
        ${merchantAvatarHtml(label)}
        <span class="rec-rail-name">${escapeHtml(label)}</span>
        <span class="rec-rail-cadence" title="${escapeHtml(ruleSentence(s.rule))}">${escapeHtml(ruleLabel(s.rule))}</span>
        <span class="rec-rail-date">${escapeHtml(due)}</span>
      </button>
      <span class="rec-action-group">
        ${actionBtn('delete', s.key, 'trash', `Delete ${label}`, 'rec-action-delete')}
      </span>
    </div>`;
  }

  /** The rail, head to foot. The two buttons at the bottom are the page's only
   *  whole-list actions, and they sit here rather than in a menu on the toolbar
   *  because this is the panel the schedules they create land in. Adding from a
   *  day cell's + is still there, and still the quicker route when the date is
   *  the thing the user is thinking about. */
  function renderRail() {
    const host = document.getElementById('rec-rail');
    if (!host) return;
    const body = data.series.length
      ? `<div class="rec-rail-list">${data.series.map(railRowHtml).join('')}</div>`
      : '<p class="rec-rail-empty">No schedules yet.</p>';
    host.innerHTML = `<div class="rec-rail-head">
        <span class="rec-rail-head-main">
          <span class="rec-rail-head-label"></span>
          <span class="rec-rail-head-label">Schedule</span>
          <span class="rec-rail-head-label">Cadence</span>
          <span class="rec-rail-head-label">Next</span>
        </span>
        <span class="rec-rail-head-actions"></span>
      </div>${body}
      <div class="rec-rail-foot">
        <button type="button" class="button-primary" data-rail-action="create">Create Schedule</button>
        <button type="button" class="button-primary" data-rail-action="detect">Detect Schedules</button>
      </div>`;
  }

  /** The chip for an occurrence, when the grid is drawing one. */
  function chipFor(ref) {
    if (!ref) return null;
    return document.querySelector(
      `.rec-occ[data-key="${CSS.escape(ref.key)}"][data-date="${CSS.escape(ref.date)}"]`
    );
  }

  function typeOptionsHtml(selected) {
    return DIRECTION_OPTIONS.map((d) =>
      `<option value="${d}"${d === selected ? ' selected' : ''}>${DIRECTION_LABEL[d]}</option>`
    ).join('');
  }

  /** Light up every chip of the active SCHEDULE — a monthly bill's whole run
   *  across the grid, not just the one under the pointer — and its rail row with
   *  them, so pointing at either surface marks the schedule on both. */
  function applyActiveHighlight() {
    const key = activeKey();
    markChips(key);
    markRailRows(key);
  }

  /** The grid's half. Class only, no ARIA state — which is why this is not
   *  UI.markActive: that toggles aria-expanded with the class, and a chip opens
   *  a modal dialog rather than expanding anything. The mark says which schedule
   *  the rail is pointing at, not that something is open. */
  function markChips(key) {
    document.querySelectorAll('.rec-occ').forEach((chip) => {
      chip.classList.toggle('rec-occ-active', key != null && chip.dataset.key === key);
    });
  }

  /** The rail's half of the same job, and class-only for the same reason. A rail
   *  row is a <div> wrapping the button, so the fill goes on the row. */
  function markRailRows(key) {
    document.querySelectorAll('.rec-rail-row').forEach((row) => {
      row.classList.toggle('rec-rail-active', key != null && row.dataset.key === key);
    });
  }

  /** Mark `key` on the month currently on screen, uncollapsing its day if the
   *  chip is hiding behind a "+n more". False when this month draws nothing for
   *  it, which is the rail's normal case: it lists every schedule, most of which
   *  are elsewhere. */
  function markScheduleInMonth(key) {
    const occ = data.occurrences.find((o) => o.key === key);
    if (!occ) return false;
    revealOccurrence({ key, date: occ.date });
    pickedKey = key;
    applyActiveHighlight();
    return true;
  }

  /** Follow a schedule to wherever it actually is: the calendar steps to the
   *  month of its next charge, and its chips there light up. The highlight is
   *  the whole answer — the grid draws every field a schedule has, so there is
   *  nothing left for it to open. */
  async function goToSchedule(key) {
    if (markScheduleInMonth(key)) return true;
    const target = seriesFor(key).next_date?.slice(0, 7);
    if (!target || target === month) return false;
    month = target;
    expandedDays.clear();
    await load();
    return markScheduleInMonth(key);
  }

  /** Make sure an occurrence has a chip on the grid before anything points at
   *  it. A rail row can name one sitting behind its day's "+n more", and a mark
   *  on a chip that is not drawn is no answer at all — so the day is expanded
   *  first, which is also what shows the user where the schedule went. */
  function revealOccurrence(ref) {
    if (chipFor(ref)) return;
    expandedDays.add(ref.date);
    renderCalendar();
  }

  /** Drop the rail's mark, for Escape. The calendar stays where the click took
   *  it: the month on screen is where the user asked to be, and only the
   *  highlight was ever transient. */
  function clearPick() {
    pickedKey = null;
    applyActiveHighlight();
  }

  // ─── The editor ──────────────────────────────────────────────────────────
  // ONE dialog for every change a schedule can take, and the only one on the
  // page. Creating (the rail's Create Schedule, a day cell's +) and editing
  // (clicking a chip or a rail row) all open it, so there is a single form to
  // read a schedule in and a single place a change is made.
  //
  // It replaced an edit mode inside the chip's card. That card is one row wide,
  // which was enough for a name, a type, a cadence and an amount and is not
  // enough for a repeat rule: a frequency, an interval, a day or an nth
  // weekday, an end date and the amount range. The card is gone, and the chip
  // that used to open it opens this instead.
  //
  // WHAT IS SENT. Editing sends only what the user actually changed (diffPatch).
  // That matters beyond saving bytes: a null field on a detected schedule means
  // "follow the ledger", so writing every field back on every save would quietly
  // pin a schedule's name, amount and cadence the first time someone corrected
  // its spelling.

  const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const POSITION_LABELS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [-1, 'Last']];
  const REPEAT_MODES = [
    ['weekly', 'Weekly'],
    ['monthly-date', 'Monthly (by date)'],
    ['monthly-day', 'Monthly (by day)'],
  ];
  // Matches services/recurrence.js's MAX_INTERVAL. A larger number is a typo
  // rather than a cadence.
  const MAX_INTERVAL = 120;

  /** The familiar name for a cadence, where one exists, and "every N" where it
   *  does not. Used where there is room for a word and not for a sentence — the
   *  card's cadence cell and the detection picker's detail line. */
  function ruleLabel(rule) {
    if (!rule) return '';
    if (rule.freq === 'weekly') {
      return { 1: 'Weekly', 2: 'Biweekly' }[rule.interval] || `Every ${rule.interval} weeks`;
    }
    return { 1: 'Monthly', 3: 'Quarterly', 12: 'Yearly' }[rule.interval] || `Every ${rule.interval} months`;
  }

  /** The whole rule in one line, for the editor's readout and for the tooltip on
   *  surfaces that only have room for the short label. */
  function ruleSentence(rule) {
    if (!rule) return '';
    const every = rule.freq === 'weekly'
      ? (rule.interval === 1 ? 'Every week' : `Every ${rule.interval} weeks`)
      : (rule.interval === 1 ? 'Every month' : `Every ${rule.interval} months`);
    let on = '';
    if (rule.freq === 'weekly') {
      on = ` on ${WEEKDAY_LABELS[rule.weekday]}`;
    } else if (rule.month_mode === 'day') {
      const pos = (POSITION_LABELS.find(([v]) => v === rule.pos) || [1, 'First'])[1].toLowerCase();
      on = ` on the ${pos} ${WEEKDAY_LABELS[rule.weekday]}`;
    } else if (rule.day) {
      on = ` on the ${ordinal(rule.day)}`;
    }
    return every + on + (rule.until ? `, until ${fmtShortDate(rule.until)}` : '');
  }

  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
  }

  /** The rule as the form's controls hold it. The three repeat modes are one
   *  control here and two fields in the rule (freq + month_mode), because
   *  "monthly by date" and "monthly by day" are one choice to the user. */
  function ruleToForm(rule) {
    const base = { mode: 'monthly-date', interval: 1, weekday: 1, day: 1, pos: 1 };
    if (!rule) return base;
    if (rule.freq === 'weekly') {
      return { ...base, mode: 'weekly', interval: rule.interval, weekday: rule.weekday ?? 1 };
    }
    if (rule.month_mode === 'day') {
      return {
        ...base, mode: 'monthly-day', interval: rule.interval,
        weekday: rule.weekday ?? 1, pos: rule.pos ?? 1,
      };
    }
    return { ...base, mode: 'monthly-date', interval: rule.interval, day: rule.day ?? 1 };
  }

  function formToRule(f, until) {
    if (f.mode === 'weekly') {
      return { freq: 'weekly', interval: f.interval, weekday: f.weekday, month_mode: null, day: null, pos: null, until };
    }
    if (f.mode === 'monthly-day') {
      return { freq: 'monthly', interval: f.interval, weekday: f.weekday, month_mode: 'day', day: null, pos: f.pos, until };
    }
    return { freq: 'monthly', interval: f.interval, weekday: null, month_mode: 'date', day: f.day, pos: null, until };
  }

  /** A dropdown, drawn the way the rest of the app draws one: the platform
   *  arrow off (see .rec-select) and the app's own caret over it. A <select>
   *  cannot hold a child, so the caret is a sibling inside the wrapper — the
   *  same arrangement the ledger's row selects use (transactions.css
   *  .tx-select-wrap), and the same Phosphor glyph the report pickers carry. */
  function selectHtml(attrs, inner) {
    return `<span class="rec-select-wrap"><select class="rec-select" ${attrs}>${inner}</select>${UI.PICKER_CARET}</span>`;
  }

  const optionsHtml = (pairs, selected) => pairs
    .map(([value, label]) =>
      `<option value="${escapeHtml(String(value))}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

  // The Name field's merchant suggestions. Two characters before the first
  // lookup — one letter matches most of the lexicon — and a pause long enough
  // that typing a full name costs one request rather than one per key.
  const SUGGEST_DELAY_MS = 160;
  const SUGGEST_MIN_CHARS = 2;

  const dayOptions = Array.from({ length: 31 }, (_, i) => [i + 1, ordinal(i + 1)]);
  const weekdayOptions = WEEKDAY_LABELS.map((label, i) => [i, label]);

  /** The repeat block's second row, which is the one that changes with the mode:
   *  a weekday, a day of the month, or a position and a weekday. */
  function repeatDetailHtml(f) {
    if (f.mode === 'weekly') {
      return `<label class="rec-field">
        <span class="rec-field-label">On</span>
        ${selectHtml('data-form="weekday"', optionsHtml(weekdayOptions, f.weekday))}
      </label>`;
    }
    if (f.mode === 'monthly-day') {
      return `<label class="rec-field">
        <span class="rec-field-label">On the</span>
        <span class="rec-field-pair">
          ${selectHtml('data-form="pos"', optionsHtml(POSITION_LABELS, f.pos))}
          ${selectHtml('data-form="weekday"', optionsHtml(weekdayOptions, f.weekday))}
        </span>
      </label>`;
    }
    return `<label class="rec-field">
      <span class="rec-field-label">On the</span>
      ${selectHtml('data-form="day"', optionsHtml(dayOptions, f.day))}
    </label>`;
  }

  function editorHtml(s, { creating, dateIso }) {
    const f = ruleToForm(s.rule);
    const label = s.display_name || s.description || '';
    const until = s.rule && s.rule.until ? s.rule.until : '';
    const unit = f.mode === 'weekly' ? 'weeks' : 'months';
    // The anchor is only the user's on a schedule with no transactions behind
    // it. A detected one takes its dates from the ledger, so there is nothing
    // here to move.
    const dateField = creating || s.manual ? `<label class="rec-field">
        <span class="rec-field-label">Next charge</span>
        <input type="date" class="rec-dialog-input" data-form="next_date"
          value="${escapeHtml(creating ? dateIso : (s.next_date || dateIso))}">
      </label>` : '';

    // A rule between the bands and no headings over them: the form asks two
    // questions (what is it, and how does it repeat), and a rule is enough to
    // say where one ends. They are drawn edge to edge
    // (.rec-edit-rule), so each band reads as a strip of the dialog rather than
    // as a line floating inside it.
    return `<p class="rec-edit-title"><strong>${creating ? 'New schedule' : 'Edit schedule'}</strong></p>
      <hr class="rec-edit-rule">

      <div class="rec-edit-grid">
        <!-- Not a <label> wrapper like the fields below it: the suggestion list
             is a sibling of the input rather than part of it, and a click
             anywhere inside a label is forwarded to that label's control. -->
        <div class="rec-field rec-field-wide rec-name-field">
          <label class="rec-field-label" for="rec-name-input">Name</label>
          <div class="rec-name-row">
            <span class="rec-name-avatar" id="rec-name-avatar" aria-hidden="true">${merchantAvatarHtml(label)}</span>
            <input type="text" class="rec-dialog-input" id="rec-name-input" data-form="display_name" maxlength="100"
              value="${escapeHtml(label)}" placeholder="e.g. Gym Membership" autocomplete="off"
              role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="rec-name-suggest">
          </div>
          <div class="rec-suggest" id="rec-name-suggest" role="listbox" aria-label="Matching merchants" hidden></div>
        </div>
        <label class="rec-field">
          <span class="rec-field-label">Type</span>
          ${selectHtml('data-form="direction"', typeOptionsHtml(s.direction || 'expense'))}
        </label>
        <label class="rec-field">
          <span class="rec-field-label">Amount</span>
          <input type="text" inputmode="decimal" class="rec-dialog-input rec-input-amount" data-form="amount"
            value="${s.amount == null ? '' : escapeHtml(formatCurrency(s.amount, true, { editable: true }))}"
            placeholder="${escapeHtml(formatCurrency(0, true, { editable: true }))}" autocomplete="off">
        </label>
      </div>

      <hr class="rec-edit-rule">
      <div class="rec-edit-grid">
        <label class="rec-field">
          <span class="rec-field-label">Repeat by</span>
          ${selectHtml('data-form="mode"', optionsHtml(REPEAT_MODES, f.mode))}
        </label>
        <label class="rec-field">
          <span class="rec-field-label">Every</span>
          <span class="rec-field-pair">
            <input type="number" class="rec-dialog-input rec-input-interval" data-form="interval"
              min="1" max="${MAX_INTERVAL}" step="1" value="${f.interval}">
            <span class="rec-field-unit" data-form="unit">${unit}</span>
          </span>
        </label>
        <div class="rec-edit-detail">${repeatDetailHtml(f)}</div>
        ${dateField}
      </div>

      <!-- Most schedules run until they are cancelled, so the end date is not a
           field by default: it is one tick, and the date appears when it is
           ticked. A Never/On pair asked every user to answer a question almost
           none of them have. -->
      <div class="rec-edit-ends">
        <label class="rec-check">
          <input type="checkbox" data-form="ends-on"${until ? ' checked' : ''}>
          <span>Ends on</span>
        </label>
        <input type="date" class="rec-dialog-input rec-input-until" data-form="until"
          value="${escapeHtml(until)}"${until ? '' : ' hidden'}>
      </div>

      <p class="rec-edit-readout" id="rec-edit-readout"></p>

      <div class="confirm-actions">
        <button class="db-btn confirm-cancel">Cancel</button>
        <button class="db-btn db-btn-primary" id="rec-edit-save">${creating ? 'Create' : 'Save'}</button>
      </div>`;
  }

  /** Only what changed, so a detected schedule keeps following the ledger on
   *  every field the user did not touch. */
  function diffPatch(before, after) {
    const patch = {};
    for (const [field, value] of Object.entries(after)) {
      const was = before[field];
      const same = field === 'rule'
        ? JSON.stringify(was) === JSON.stringify(value)
        : was === value;
      if (!same) patch[field] = value;
    }
    return patch;
  }

  /**
   * The editor. `key` names the schedule to edit; without one it creates,
   * anchored on `dateIso` (a day cell's date, or today).
   */
  async function openScheduleDialog({ key = null, dateIso = null } = {}) {
    const creating = !key;
    const s = creating
      ? { direction: 'expense', amount: null, rule: null, manual: true }
      : seriesFor(key);
    if (!creating && !s.key) return;
    const anchor = dateIso || todayIso();

    const { overlay, close } = UI.dialog(editorHtml(s, { creating, dateIso: anchor }), {
      className: 'rec-edit-dialog',
    });

    const el = (sel) => overlay.querySelector(sel);
    const form = ruleToForm(s.rule);

    /** Read the controls back into the rule the form describes. */
    function readForm() {
      form.mode = el('[data-form="mode"]').value;
      form.interval = Math.max(1, Math.min(MAX_INTERVAL, Number(el('[data-form="interval"]').value) || 1));
      const pick = (name, fallback) => {
        const node = el(`[data-form="${name}"]`);
        return node ? Number(node.value) : fallback;
      };
      form.weekday = pick('weekday', form.weekday);
      form.day = pick('day', form.day);
      form.pos = pick('pos', form.pos);
      const endsOn = el('[data-form="ends-on"]').checked;
      const until = endsOn ? el('[data-form="until"]').value : '';
      return formToRule(form, until || null);
    }

    function syncReadout() {
      el('#rec-edit-readout').textContent = ruleSentence(readForm());
    }

    /** The mode control changes which fields exist, so its row is redrawn. */
    function redrawDetail() {
      readForm();
      el('.rec-edit-detail').innerHTML = repeatDetailHtml(form);
      el('[data-form="unit"]').textContent = form.mode === 'weekly' ? 'weeks' : 'months';
      syncReadout();
    }

    // ── Name: avatar, and the merchants the lexicon knows ──────────────────
    // Typing a name offers matching merchants (GET /api/recurring/brands, the
    // bundled lexicon rather than the ledger). Picking one writes the merchant's
    // canonical spelling, and that spelling is what draws the brand avatar —
    // avatar.js slugs the label and looks it up in the icon manifest the same
    // lexicon generated.
    //
    // It claims NOTHING. No transaction, no alias, no history: a suggestion
    // fills in one field the user can immediately overwrite. A schedule is
    // still joined to the ledger by its key alone, exactly as before.
    const nameInput = el('#rec-name-input');
    const avatarBox = el('#rec-name-avatar');
    const suggestBox = el('#rec-name-suggest');
    const typeSelect = el('[data-form="direction"]');

    let suggestions = [];
    let suggestIndex = -1;   // -1 = nothing highlighted; Enter then saves nothing
    let suggestTimer = null;
    let suggestGeneration = 0;
    let avatarFor = null;    // the label the avatar currently draws

    /** Keep the avatar showing the name as typed. Re-rendered only when the
     *  name actually changed, so holding a key down does not rebuild it per
     *  keystroke. */
    function syncAvatar() {
      const label = nameInput.value.trim();
      if (label === avatarFor) return;
      avatarFor = label;
      avatarBox.innerHTML = merchantAvatarHtml(label);
    }

    function closeSuggest() {
      suggestions = [];
      suggestIndex = -1;
      suggestBox.hidden = true;
      suggestBox.innerHTML = '';
      nameInput.setAttribute('aria-expanded', 'false');
    }

    function suggestRowHtml(b, i) {
      // tabindex="-1": the arrow keys walk the list, Tab leaves it. A row that
      // took a Tab stop would put eight of them between Name and Type.
      return `<button type="button" class="rec-suggest-row" role="option" tabindex="-1" data-index="${i}"
        aria-selected="${i === suggestIndex}">
        ${merchantAvatarHtml(b.name)}
        <span class="rec-suggest-name">${escapeHtml(b.name)}</span>
      </button>`;
    }

    function renderSuggest() {
      if (!suggestions.length) { closeSuggest(); return; }
      suggestBox.innerHTML = suggestions.map(suggestRowHtml).join('');
      suggestBox.hidden = false;
      nameInput.setAttribute('aria-expanded', 'true');
    }

    /** Move the highlight, wrapping at both ends so one key reaches every row. */
    function moveSuggest(step) {
      if (!suggestions.length) return;
      suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length;
      [...suggestBox.children].forEach((row, i) => {
        row.classList.toggle('rec-suggest-active', i === suggestIndex);
        row.setAttribute('aria-selected', String(i === suggestIndex));
      });
      suggestBox.children[suggestIndex].scrollIntoView({ block: 'nearest' });
    }

    /** Take a suggestion: its name, and nothing else. The type, the amount and
     *  the cadence are left alone — the lexicon knows what a merchant is called,
     *  not what they charge this user. */
    function applySuggestion(i) {
      const brand = suggestions[i];
      if (!brand) return;
      nameInput.value = brand.name;
      nameInput.classList.remove('invalid');
      closeSuggest();
      syncAvatar();
      nameInput.focus();
    }

    async function searchBrands() {
      const q = nameInput.value.trim();
      if (q.length < SUGGEST_MIN_CHARS) { closeSuggest(); return; }
      // Every keystroke can outrun the one before it; only the newest answer may
      // paint, or a slow early response overwrites a fast later one.
      const mine = ++suggestGeneration;
      const res = await apiFetch(`/api/recurring/brands?q=${encodeURIComponent(q)}`);
      if (mine !== suggestGeneration || !res.ok) return;
      const { brands } = await res.json();
      if (mine !== suggestGeneration) return;
      // A name already spelled exactly as the one merchant offered is answered:
      // re-opening the list over it would only be something else to dismiss.
      suggestions = (brands.length === 1 && brands[0].name === nameInput.value.trim()) ? [] : brands;
      suggestIndex = -1;
      renderSuggest();
    }

    function queueSuggest() {
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(searchBrands, SUGGEST_DELAY_MS);
    }

    // mousedown, not click: it fires before the input loses focus, so picking a
    // row cannot race the focusout that closes the list.
    suggestBox.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.rec-suggest-row');
      if (!row) return;
      e.preventDefault();
      applySuggestion(Number(row.dataset.index));
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!suggestions.length) return;
        e.preventDefault();
        moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' && suggestIndex >= 0) {
        e.preventDefault();
        applySuggestion(suggestIndex);
        return;
      }
      // Dismiss the list, not the dialog: the editor's Escape listener is on the
      // document, so stopping here is what keeps an open list from closing the
      // form the user is still filling in.
      if (e.key === 'Escape' && !suggestBox.hidden) {
        e.stopPropagation();
        clearTimeout(suggestTimer);
        suggestGeneration++;
        closeSuggest();
      }
    });

    el('.rec-name-field').addEventListener('focusout', (e) => {
      if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
      clearTimeout(suggestTimer);
      suggestGeneration++;
      closeSuggest();
    });

    syncReadout();
    syncAvatar();
    nameInput.focus();
    nameInput.select();

    overlay.addEventListener('change', (e) => {
      if (e.target.matches('[data-form="mode"]')) { redrawDetail(); return; }
      if (e.target.matches('[data-form="ends-on"]')) {
        const on = e.target.checked;
        const date = el('[data-form="until"]');
        date.hidden = !on;
        // An end date with nothing in it is not an end date. Offering the day
        // the schedule next falls on is the only guess that is never wrong by a
        // cycle, and it is one the user is about to move anyway.
        if (on && !date.value) date.value = s.next_date || anchor;
        if (on) date.focus();
      }
      syncReadout();
    });
    overlay.addEventListener('input', (e) => {
      if (e.target === nameInput) { syncAvatar(); queueSuggest(); }
      if (e.target.classList.contains('rec-input-amount')) applyCurrencyFormat(e.target);
      if (e.target.matches('[data-form="interval"], [data-form="until"]')) syncReadout();
      e.target.classList.remove('invalid');
    });
    el('#rec-edit-save').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const amount = parseFloat(stripCurrencyValue(el('[data-form="amount"]').value));
      const rule = readForm();
      const dateNode = el('[data-form="next_date"]');

      // Marked rather than corrected: saving must never store a value the user
      // did not type.
      const mark = (node, ok) => { if (node) node.classList.toggle('invalid', !ok); return ok; };
      let valid = mark(nameInput, !!name && !!normaliseDesc(name));
      valid = mark(el('[data-form="amount"]'), amount > 0) && valid;
      valid = mark(dateNode, !dateNode || !!dateNode.value) && valid;
      valid = mark(el('[data-form="until"]'), !rule.until || rule.until >= (dateNode ? dateNode.value : rule.until)) && valid;
      if (!valid) return;

      let res;
      if (creating) {
        res = await apiFetch('/api/recurring/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: name, direction: typeSelect.value,
            amount, next_date: dateNode.value, rule, until: rule.until,
          }),
        });
      } else {
        const after = {
          display_name: name,
          direction: typeSelect.value,
          amount,
          rule: { ...rule, until: null },
          until: rule.until,
        };
        if (dateNode) after.next_date = dateNode.value;

        const patch = diffPatch({
          display_name: s.display_name || s.description,
          direction: s.direction,
          amount: s.amount,
          rule: { ...ruleFromFormState(s), until: null },
          until: (s.rule && s.rule.until) || null,
          next_date: s.next_date,
        }, after);
        if (!Object.keys(patch).length) { close(); return; }
        res = await apiFetch('/api/recurring/override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: s.key, ...patch }),
        });
      }

      if (!res.ok) {
        window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
        return;
      }
      const saved = creating ? (await res.json()).key : s.key;
      close();
      await load();
      goToSchedule(saved);
    });
  }

  /** The schedule's rule in the same shape readForm produces, so the two can be
   *  compared field by field without one carrying nulls the other omits. */
  function ruleFromFormState(s) {
    return formToRule(ruleToForm(s.rule), null);
  }

  // ─── Detect ──────────────────────────────────────────────────────────────
  // Detection runs only on request. The picker lists what the backend found that
  // is not yet adopted (GET /api/recurring/candidates), and adopting the ticked
  // ones (POST /api/recurring/adopt) puts them on the calendar. Opening the
  // dialog writes nothing, so cancelling leaves the database unchanged.
  //
  // Nothing starts ticked. Detection is a heuristic reading of the ledger, so
  // every row here is a guess the user is being asked about — and a pre-ticked
  // list answers for them: the fast path becomes "Add", which adopts whatever
  // the guess happened to include. Starting empty makes each schedule on the
  // calendar one the user actually chose, and "Select all" is one click away
  // for the run where the guess is right.

  function candidateRowHtml(s, i) {
    const label = s.display_name || s.description;
    const detail = [
      ruleLabel(s.rule),
      `${s.occurrences} charge${s.occurrences === 1 ? '' : 's'}`,
      `next ${fmtShortDate(s.next_date)}`,
    ].join(' · ');
    return `<label class="rec-cand-row">
      <input type="checkbox" class="rec-cand-cb" data-key="${escapeHtml(s.key)}" data-index="${i}">
      ${merchantAvatarHtml(label)}
      <span class="rec-cand-text">
        <span class="rec-cand-name">${escapeHtml(label)}</span>
        <span class="rec-cand-detail">${escapeHtml(detail)}</span>
      </span>
      <span class="rec-cand-amount rec-amount-${s.direction}">${escapeHtml(formatCurrency(s.amount, true))}</span>
    </label>`;
  }

  async function openDetectDialog() {
    const res = await apiFetch('/api/recurring/candidates');
    if (!res.ok) {
      window.UI?.toast?.("Couldn't scan your transactions — try again.", { type: 'error' });
      return;
    }
    const { candidates } = await res.json();

    if (!candidates.length) {
      UI.dialog(`
        <p><strong>No new recurring schedules found</strong></p>
        <p class="rec-detect-note">A pattern needs a few charges at a steady interval before it can be spotted. Import more history, or add a schedule by hand with the + on the day it falls on.</p>
        <div class="confirm-actions">
          <button class="db-btn confirm-cancel">Close</button>
        </div>`, { className: 'rec-detect-dialog' });
      return;
    }

    const { overlay, close } = UI.dialog(`
      <p><strong>Recurring schedules found</strong></p>
      <p class="rec-detect-note">These transactions look like they repeat. Keep the ones you want to track — you can correct any detail afterwards.</p>
      <label class="rec-cand-all">
        <input type="checkbox" id="rec-cand-all">
        <span>Select all (${candidates.length})</span>
      </label>
      <div class="rec-cand-list">${candidates.map(candidateRowHtml).join('')}</div>
      <div class="confirm-actions">
        <button class="db-btn confirm-cancel">Cancel</button>
        <button class="db-btn db-btn-primary confirm-add" id="rec-cand-ok">Add selected</button>
      </div>`, { className: 'rec-detect-dialog' });

    const allBox = overlay.querySelector('#rec-cand-all');
    const boxes = [...overlay.querySelectorAll('.rec-cand-cb')];
    const okBtn = overlay.querySelector('#rec-cand-ok');
    const checked = () => boxes.filter((b) => b.checked);

    // "Add selected" with nothing selected has nothing to do, and the backend
    // rejects an empty list — so the button reflects that rather than
    // producing an error the user can't act on.
    function syncState() {
      const n = checked().length;
      allBox.checked = n === boxes.length;
      allBox.indeterminate = n > 0 && n < boxes.length;
      okBtn.disabled = n === 0;
      okBtn.textContent = n ? `Add ${n} schedule${n === 1 ? '' : 's'}` : 'Add selected';
    }
    syncState();

    allBox.addEventListener('change', () => {
      boxes.forEach((b) => { b.checked = allBox.checked; });
      syncState();
    });
    overlay.querySelector('.rec-cand-list').addEventListener('change', syncState);

    okBtn.addEventListener('click', async () => {
      const keys = checked().map((b) => b.dataset.key);
      if (!keys.length) return;
      const adopt = await apiFetch('/api/recurring/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      if (!adopt.ok) {
        window.UI?.toast?.("Couldn't add those schedules — try again.", { type: 'error' });
        return;
      }
      close();
      await load();
    });
  }

  // ─── Add / remove ─────────────────────────────────────────────────────────

  /** Small confirm dialog, same .confirm-* shell the rest of the app uses for
   *  destructive prompts. The wording names what is actually lost: the
   *  schedule, not the transactions it was detected from. */
  async function confirmRemoveSchedule(key) {
    const s = seriesFor(key);
    const label = s.display_name || s.description || key;
    const ok = await UI.confirm({
      message: `
      <p>Delete the <strong>${escapeHtml(label)}</strong> schedule?</p>
      <p class="rec-detect-note">Its transactions stay in your ledger, and detection can offer it again later.</p>`,
    });
    if (!ok) return;
    const res = await apiFetch(`/api/recurring/schedule/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) {
      window.UI?.toast?.("Couldn't delete it — try again.", { type: 'error' });
      return;
    }
    if (pickedKey === key) pickedKey = null;
    await load();
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────────

  function renderToolbar() {
    const [y, m] = month.split('-').map(Number);
    const label = document.getElementById('rec-month-label');
    if (label) UI.setPickerLabel(label, `${MONTHS[m - 1]} ${y}`);
    // Nothing to go back to while we're already there — disabled rather than
    // hidden, so the stepper's controls never move under the pointer.
    const today = document.getElementById('rec-month-today');
    if (today) today.disabled = month === currentMonthKey();
  }

  function render() {
    renderToolbar();
    renderSummary();
    renderRail();
    renderCalendar();
  }

  async function load() {
    const res = await apiFetch(`/api/recurring?month=${encodeURIComponent(month)}`);
    if (!res.ok) return;
    data = await res.json();
    seriesByKey = new Map(data.series.map((s) => [s.key, s]));
    render();
  }

  function goToMonth(key) {
    month = key;
    pickedKey = null;
    expandedDays.clear();
    load();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rec-month-prev').addEventListener('click', () => goToMonth(addMonthKey(month, -1)));
    document.getElementById('rec-month-next').addEventListener('click', () => goToMonth(addMonthKey(month, 1)));

    // One hop home from anywhere — the arrows reach past either end of the
    // picker's window, so a user can be years out with no short way back.
    document.getElementById('rec-month-today').addEventListener('click', () => {
      const key = currentMonthKey();
      if (key !== month) goToMonth(key);
    });

    // The label is a picker, like Dashboard's month stepper — .stepper-label draws a
    // caret and a pointer cursor, so it has to open something. The window runs
    // a few months ahead of today rather than stopping there the way Dashboard's
    // does: this report projects upcoming charges. The arrows still reach past
    // either end.
    // Same static width as Dashboard's stepper: the label is pinned to the
    // widest month name it can carry, so walking the calendar leaves the arrows
    // and the picker under them exactly where they were. Any 4-digit year
    // measures the same (tabular-nums), so today's stands in for all of them.
    window.UI?.lockPickerWidth?.(
      document.getElementById('rec-month-label'),
      MONTHS.map((m) => `${m} ${new Date().getFullYear()}`),
    );

    document.getElementById('rec-month-label').addEventListener('click', (e) => {
      e.stopPropagation();
      const items = [];
      for (let i = 3; i > -9; i--) {
        const key = addMonthKey(currentMonthKey(), i);
        const [y, m] = key.split('-').map(Number);
        items.push({
          label: `${MONTHS[m - 1]} ${y}`,
          selected: key === month,
          action: () => goToMonth(key),
        });
      }
      UI.openMenu(e.currentTarget, items);
    });

    const calendar = document.getElementById('rec-calendar');

    // ── The grid's own three controls ──
    // A chip, a day's + and a day's "+n more", delegated so one listener covers
    // every cell across every re-render.
    calendar.addEventListener('click', (e) => {
      // The day's + — the schedule being added is due on that day, so the
      // dialog opens with the date already filled in.
      const add = e.target.closest('[data-add]');
      if (add) { openScheduleDialog({ dateIso: add.dataset.add }); return; }
      // A chip opens its own schedule's editor. Which occurrence was clicked
      // does not matter: a schedule's fields belong to the whole series, so the
      // dialog is keyed by the schedule, not by the date under the pointer.
      const chip = e.target.closest('.rec-occ');
      if (chip) { openScheduleDialog({ key: chip.dataset.key }); return; }
      const expand = e.target.closest('[data-expand]');
      if (!expand) return;
      const iso = expand.dataset.expand;
      if (expandedDays.has(iso)) expandedDays.delete(iso); else expandedDays.add(iso);
      renderCalendar();
    });

    // ── Rail → grid ──
    // Hover marks the schedule wherever the month on screen draws it; the click
    // does the same and makes it stay, following the schedule to another month
    // if that is where it lives. Same delegation as the chip above: listeners
    // that outlive every re-render.
    const rail = document.getElementById('rec-rail');

    function markRailHover(e) {
      const row = e.target.closest('.rec-rail-row');
      if (!row) return;
      railHoverKey = row.dataset.key;
      applyActiveHighlight();
    }

    function clearRailHover(e) {
      if (!e.target.closest('.rec-rail-row')) return;
      railHoverKey = null;
      applyActiveHighlight();
    }

    rail.addEventListener('mouseover', markRailHover);
    rail.addEventListener('mouseout', clearRailHover);
    rail.addEventListener('focusin', markRailHover);
    rail.addEventListener('focusout', clearRailHover);
    rail.addEventListener('click', (e) => {
      const foot = e.target.closest('[data-rail-action]');
      if (foot) {
        // A schedule created from here has no day cell behind it, so it opens on
        // today and the user moves the date if it belongs elsewhere.
        if (foot.dataset.railAction === 'create') openScheduleDialog({});
        else openDetectDialog();
        return;
      }

      const row = e.target.closest('.rec-rail-row');
      if (!row) return;
      const { key } = row.dataset;

      // The trash can acts on the whole schedule, so it needs nothing on the
      // calendar to be pointing at: the confirm is a dialog, like the editor.
      if (e.target.closest('.rec-action-btn')) { confirmRemoveSchedule(key); return; }

      // Anything else on the row opens that schedule's editor.
      openScheduleDialog({ key });
    });

    // The rail's mark is the page's one piece of transient state, so Escape
    // drops it. A dialog on top handles its own Escape first.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-overlay')) return;
      if (pickedKey) clearPick();
    });

    window.addEventListener('currencychange', render);
    load();
  });
}());
