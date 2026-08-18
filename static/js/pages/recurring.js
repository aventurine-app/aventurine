'use strict';

(function () {
  // ─── Recurring ──────────────────────────────────────────────────────────────
  // The calendar IS the page. Every occurrence of an adopted schedule — actual
  // past charges and projected future ones alike — renders as a chip in its
  // day cell, and the chip is where that schedule's data lives: hovering one
  // opens a card carrying the whole row (name, type, cadence, amount) with its
  // pencil and trash can. There is no separate table to keep in sync with the
  // grid; the two used to be the same data drawn twice.
  //
  // Detection/cycle-classification/projection is server-side (GET
  // /api/recurring?month=YYYY-MM, backed by detectRecurringSeries in
  // services/predictions.js).
  //
  // The page starts EMPTY, however much recurring history the ledger holds:
  // detection is a guess, so it doesn't get to fill the calendar by itself.
  // The user runs it from the ⋮ menu ("Find recurring schedules"), ticks the
  // patterns they recognize in the picker (openDetectDialog → GET
  // /api/recurring/candidates, POST /api/recurring/adopt), and those start
  // appearing on the grid. Schedules can also be added by hand from the + a
  // day cell reveals on hover — which is what makes the due date a thing the
  // user points at rather than a field they fill in — and removed from the
  // card's trash can, one at a time or all at once (⋮ → "Clear all recurring
  // schedules"). See "Detect" and "Add / remove".
  //
  // Globals (loaded before this script): apiFetch (api.js), escapeHtml
  // (escape.js), formatCurrency/applyCurrencyFormat/stripCurrencyValue
  // (currency.js), merchantAvatarHtml (avatar.js), UI (ui.js).

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const CYCLE_LABEL = {
    weekly: 'Weekly', biweekly: 'Biweekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
  };
  const CYCLE_OPTIONS = Object.keys(CYCLE_LABEL);
  const DIRECTION_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
  const DIRECTION_OPTIONS = Object.keys(DIRECTION_LABEL);
  // Chips per day before the cell collapses the rest behind a "+n more" the
  // user can expand. A cap is needed (a busy 1st-of-the-month would otherwise
  // stretch one row of the grid), but nothing may become unreachable: the
  // calendar is now the only way to get at a schedule.
  const MAX_CHIPS_PER_DAY = 3;
  // Grace period before a card closes when the pointer leaves the chip —
  // enough to cross the gap into the card itself, which is how the pencil and
  // trash can are reachable without clicking first.
  const CLOSE_DELAY_MS = 180;

  // Inlined so the card's actions don't depend on an icon font / external
  // sprite. pencil/check/cross/trash are the same drawings (and the same
  // 20-box, 1.5-stroke language) the Transactions ledger uses for its row
  // actions, since those are the same verbs; `plus` is the day cell's own
  // add affordance, drawn to match.
  const ICONS = {
    pencil: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M14.5 3.5l2 2-9.5 9.5-3 1 1-3 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    check:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    trash:  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus:   '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 5v10M5 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

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

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtShortDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const thisYear = new Date().getFullYear();
    return y === thisYear ? `${MONTHS_SHORT[m - 1]} ${d}` : `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
  }

  // Mirror of services/predictions.js's normaliseDesc — used client-side only
  // to warn the Add-schedule dialog when a name won't key off any letters
  // (the backend is the actual source of truth and re-derives this itself).
  function normaliseDesc(desc) {
    return String(desc || '').toLowerCase().replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim();
  }

  let month = currentMonthKey();
  let data = { series: [], occurrences: [] };
  // The occurrence whose card is open, as {key, date} — an identity that
  // survives a calendar rebuild, unlike a DOM node. `pinned` is set by a click
  // and keeps the card open when the pointer leaves; hover alone doesn't.
  let activeOcc = null;
  let pinned = false;
  // Key of the schedule being edited in the card, or null. Editing implies
  // pinned, and freezes hover: the pointer wandering across the grid must not
  // swap the card out from under a half-typed correction.
  let editingKey = null;
  // ISO dates whose "+n more" the user expanded, so the extra chips stay put
  // across re-renders within the month.
  const expandedDays = new Set();
  let closeTimer = null;

  // ─── Calendar ────────────────────────────────────────────────────────────

  function seriesFor(key) {
    return data.series.find((s) => s.key === key) || {};
  }

  function occLabel(occ) {
    const s = seriesFor(occ.key);
    return s.display_name || s.description || occ.key;
  }

  /** One occurrence, as a chip in its day cell: merchant avatar, name, amount.
   *  This is the schedule's home on the page — a <button> so it is focusable
   *  and Enter/Space-activatable without re-implementing either.
   *
   *  The avatar is the same deterministic colour+initials circle the ledger
   *  and the card use (avatar.js), so a merchant looks identical everywhere —
   *  and only that: direction is carried by the chip's own tint (the
   *  rec-occ-<direction> class, recurring.css), not by anything drawn on the
   *  circle. */
  function chipHtml(occ) {
    const label = occLabel(occ);
    const active = activeOcc && activeOcc.key === occ.key;
    const cls = `rec-occ rec-occ-${occ.direction} rec-occ-${occ.actual ? 'actual' : 'projected'}`
      + (active ? ' rec-occ-active' : '');
    const tip = `${label} — ${formatCurrency(occ.amount, true)}${occ.actual ? '' : ' (projected)'}`;
    return `<button type="button" class="${cls}" data-key="${escapeHtml(occ.key)}" data-date="${escapeHtml(occ.date)}"
      aria-label="${escapeHtml(tip)}" aria-expanded="${active ? 'true' : 'false'}">
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
      // Add-here button, revealed by hovering the cell (recurring.css). Adding
      // by hand is an act about a DATE — "I get charged $12 on the 3rd" — so
      // it belongs on the day itself, where the answer to "which date" is
      // already the cell the pointer is in, rather than in a menu that then
      // has to ask.
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

  /** The empty state sits above the grid rather than replacing it — the month
   *  is still worth seeing — and its CTA is the whole point here: nothing
   *  arrives on the calendar until the user asks for detection. */
  function renderEmpty() {
    const host = document.getElementById('rec-empty');
    if (!host) return;
    host.hidden = data.series.length > 0;
    if (host.hidden) { host.innerHTML = ''; return; }
    host.innerHTML = UI.emptyState({
      icon: 'calendar',
      title: 'No recurring schedules yet',
      desc: 'Look through your transactions for subscriptions, bills and paychecks that repeat on a steady schedule, and pick the ones to track. To add one by hand, hover the day it falls on and press the + in the corner.',
      action: { label: 'Find recurring schedules', name: 'detect', primary: true },
      compact: true,
    });
  }

  // ─── The card ────────────────────────────────────────────────────────────
  // One floating element, reused for whichever chip is active. It carries the
  // same row the old side table did — avatar + name, type, cadence, amount,
  // pencil, trash — so the data reads identically, it just lives on the
  // occurrence now. Parked on <body> and fixed-positioned so the calendar's
  // scroll container can't clip it.

  function popEl() {
    let el = document.getElementById('rec-pop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rec-pop';
      el.className = 'rec-pop';
      el.hidden = true;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Recurring schedule');
      document.body.appendChild(el);
    }
    return el;
  }

  function chipFor(ref) {
    if (!ref) return null;
    return document.querySelector(
      `.rec-occ[data-key="${CSS.escape(ref.key)}"][data-date="${CSS.escape(ref.date)}"]`
    );
  }

  function occFor(ref) {
    if (!ref) return null;
    return data.occurrences.find((o) => o.key === ref.key && o.date === ref.date) || null;
  }

  function cycleOptionsHtml(selected) {
    return CYCLE_OPTIONS.map((c) =>
      `<option value="${c}"${c === selected ? ' selected' : ''}>${CYCLE_LABEL[c]}</option>`
    ).join('');
  }

  function typeOptionsHtml(selected) {
    return DIRECTION_OPTIONS.map((d) =>
      `<option value="${d}"${d === selected ? ' selected' : ''}>${DIRECTION_LABEL[d]}</option>`
    ).join('');
  }

  function actionBtn(action, key, icon, label, extraCls = '') {
    return `<button type="button" class="rec-action-btn ${extraCls}" data-action="${action}"
      data-key="${escapeHtml(key)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ICONS[icon]}</button>`;
  }

  /** The schedule's category, as the ledger draws it (transactions.js's
   *  txRenderDisplayRow): the category NAME in a pill tinted by direction —
   *  income green, expense red, transfer blue — with an uncategorized one
   *  falling back to the amber "needs review" pill regardless of direction. */
  function categoryPillHtml(s, direction) {
    if (!s.category) return '<span class="rec-type-pill rec-type-empty">Uncategorized</span>';
    return `<span class="rec-type-pill rec-type-${direction}" title="${escapeHtml(s.category)}">${escapeHtml(s.category)}</span>`;
  }

  /** The card's merchant identity — avatar + name — as a link into the ledger,
   *  pre-filtered to this schedule's transactions. A chip on the calendar is a
   *  prediction with no visible evidence behind it; this is the "why is this
   *  here?" answer, and it lands on the rows detection actually grouped (the
   *  backend hands over a search term drawn from their descriptions, not from
   *  the schedule's label — which may be a user override that matches nothing).
   *
   *  It lives on the card rather than on the chip because a chip is itself a
   *  <button>: an <a> nested in one is invalid, and a second click target
   *  inside it would fight the click that pins the card. The card is already
   *  where this schedule's actions live, and it's one hover away.
   *
   *  A hand-added schedule has nothing behind it (search is null), so it stays
   *  plain text — a link to an empty table answers nothing. */
  function merchantHtml(label, s) {
    const inner = `${merchantAvatarHtml(label)}<span class="rec-pop-name">${escapeHtml(label)}</span>`;
    if (!s.search) return `<span class="rec-pop-merchant" title="${escapeHtml(label)}">${inner}</span>`;
    return `<a class="rec-pop-merchant rec-pop-merchant-link"
      href="/transactions?name=${encodeURIComponent(s.search)}"
      title="See ${escapeHtml(label)} transactions in the ledger">${inner}</a>`;
  }

  /** Display mode: one flat row — name · category · amount · cadence — then the
   *  actions. Every field sits on the same line at the same rhythm; nothing is
   *  a sub-line of anything else. The amount shown is the OCCURRENCE's — a past
   *  charge keeps whatever really hit the account, which is the whole reason to
   *  hover a specific day rather than read an average. */
  function cardDisplayHtml(occ, s) {
    const label = occLabel(occ);
    return `<div class="rec-pop-row">
      ${merchantHtml(label, s)}
      ${categoryPillHtml(s, occ.direction)}
      <span class="rec-pop-amount rec-amount-${occ.direction}">${escapeHtml(formatCurrency(occ.amount, true))}</span>
      <span class="rec-pop-cadence">${escapeHtml(CYCLE_LABEL[s.cycle] || s.cycle || '')}</span>
      <span class="rec-action-group">
        ${actionBtn('edit', occ.key, 'pencil', `Edit ${label}`)}
        ${actionBtn('delete', occ.key, 'trash', `Delete ${label}`, 'rec-action-delete')}
      </span>
    </div>`;
  }

  /** Edit mode: the same row as inputs. The amount here is the SCHEDULE's
   *  predicted amount, not this occurrence's — an edit corrects the standing
   *  schedule, and past charges are history that no correction rewrites. */
  function cardEditHtml(occ, s) {
    const label = s.display_name || s.description || occ.key;
    // Two rows, unlike display mode: a name field plus three controls plus two
    // buttons across one line leaves the name a few dozen pixels, and the name
    // is the field most likely to be the reason the user opened this at all.
    return `<div class="rec-pop-row rec-pop-editing">
      <div class="rec-pop-edit-name">
        ${merchantAvatarHtml(label)}
        <span class="rec-pop-label">
          <input type="text" class="rec-input rec-input-name" data-field="display_name"
            value="${escapeHtml(label)}" maxlength="100" aria-label="Merchant name">
          <span class="rec-pop-sub">Next ${escapeHtml(fmtShortDate(s.next_date || occ.date))}</span>
        </span>
      </div>
      <div class="rec-pop-edit-fields">
        <select class="rec-input rec-select" data-field="direction" aria-label="Type">
          ${typeOptionsHtml(s.direction)}
        </select>
        <select class="rec-input rec-select" data-field="cycle" aria-label="Cadence">
          ${cycleOptionsHtml(s.cycle)}
        </select>
        <input type="text" inputmode="decimal" class="rec-input rec-input-amount" data-field="amount"
          value="${escapeHtml(formatCurrency(s.amount, true, { editable: true }))}" aria-label="Amount">
        <span class="rec-action-group">
          ${actionBtn('save', occ.key, 'check', 'Save changes', 'rec-action-save')}
          ${actionBtn('cancel', occ.key, 'cross', 'Discard changes')}
        </span>
      </div>
    </div>`;
  }

  function positionCard(anchor) {
    const pop = popEl();
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const gap = 8;
    // Below the chip by default, flipped above when the month's last rows would
    // otherwise push the card off-screen.
    let top = a.bottom + gap;
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - gap);
    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - p.width - 8));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  /** Draw (or redraw) the card for whatever is active, anchored to its chip.
   *  Closes itself if the occurrence went away — deleted, or the month moved
   *  on under it. */
  function renderCard() {
    const pop = popEl();
    const occ = occFor(activeOcc);
    const chip = chipFor(activeOcc);
    if (!occ || !chip) { closeCard(); return; }
    const s = seriesFor(occ.key);
    pop.innerHTML = editingKey === occ.key ? cardEditHtml(occ, s) : cardDisplayHtml(occ, s);
    pop.hidden = false;
    pop.classList.toggle('rec-pop-pinned', pinned);
    positionCard(chip);
  }

  /** Light up every chip of the active schedule — a monthly bill's whole run
   *  across the grid, not just the one under the pointer. Done by toggling
   *  classes rather than re-rendering: the pointer is sitting on one of these
   *  nodes, and replacing them mid-hover would restart the mouseover/mouseout
   *  cycle underneath it. */
  function applyActiveHighlight() {
    const key = activeOcc ? activeOcc.key : null;
    document.querySelectorAll('.rec-occ').forEach((el) => {
      const on = key !== null && el.dataset.key === key;
      el.classList.toggle('rec-occ-active', on);
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }

  function openCard(ref, { pin = false } = {}) {
    clearTimeout(closeTimer);
    activeOcc = ref;
    if (pin) pinned = true;
    applyActiveHighlight();
    renderCard();
  }

  function closeCard() {
    clearTimeout(closeTimer);
    activeOcc = null;
    pinned = false;
    editingKey = null;
    const pop = popEl();
    pop.hidden = true;
    pop.innerHTML = '';
    applyActiveHighlight();
  }

  function scheduleClose() {
    if (pinned || editingKey) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeCard, CLOSE_DELAY_MS);
  }

  // ─── Editing ─────────────────────────────────────────────────────────────
  // The pencil turns the card into inputs; ✓ commits all four fields in a
  // single override POST, ✗ (or closing the card) throws the edits away.
  // Nothing is written while the user types, so there is no debounce and no
  // half-saved schedule: it is either what it was or what the user confirmed.

  async function saveOverride(key, patch) {
    const res = await apiFetch('/api/recurring/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...patch }),
    });
    if (!res.ok) {
      window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
      return false;
    }
    return true;
  }

  function startEdit(key) {
    editingKey = key;
    pinned = true;
    renderCard();
    const input = popEl().querySelector('.rec-input-name');
    if (input) { input.focus(); input.select(); }
  }

  function cancelEdit() {
    if (!editingKey) return;
    editingKey = null;
    renderCard();
  }

  /** Read the card's inputs, flagging (rather than silently correcting)
   *  anything the backend would reject — a blank name or a non-positive
   *  amount — so ✓ never quietly writes something the user didn't type. */
  function readEditCard() {
    const pop = popEl();
    const nameInput = pop.querySelector('.rec-input-name');
    const amountInput = pop.querySelector('.rec-input-amount');
    if (!nameInput || !amountInput) return null;
    const name = nameInput.value.trim();
    const amount = parseFloat(stripCurrencyValue(amountInput.value));

    nameInput.classList.toggle('invalid', !name);
    amountInput.classList.toggle('invalid', !(amount > 0));
    if (!name || !(amount > 0)) return null;

    return {
      display_name: name,
      amount,
      direction: pop.querySelector('[data-field="direction"]').value,
      cycle: pop.querySelector('[data-field="cycle"]').value,
    };
  }

  async function commitEdit(key) {
    const patch = readEditCard();
    if (!patch) return;
    if (!await saveOverride(key, patch)) return;
    editingKey = null;
    // A cadence or direction change moves and recolours this schedule's
    // projected chips (placement is server-only logic), so re-fetch and let
    // the card re-anchor to whatever chip now sits under it.
    await load();
    followSchedule(key);
  }

  /** Keep an edited schedule in sight. Re-cadencing "monthly" to "yearly" can
   *  empty the month on screen of every chip that schedule had — and with the
   *  calendar as the only surface, that reads as "my edit deleted it". So when
   *  a schedule has nothing left in the visible month, the calendar follows it
   *  to where its next occurrence actually falls and re-opens its card there. */
  async function followSchedule(key) {
    if (data.occurrences.some((o) => o.key === key)) { renderCard(); return; }
    const s = seriesFor(key);
    const target = s.next_date ? s.next_date.slice(0, 7) : null;
    if (!target || target === month) { closeCard(); return; }

    month = target;
    closeCard();
    expandedDays.clear();
    await load();
    const occ = data.occurrences.find((o) => o.key === key);
    if (occ) openCard({ key, date: occ.date }, { pin: true });
    const [y, m] = target.split('-').map(Number);
    window.UI?.toast?.(`${s.display_name || s.description} next lands in ${MONTHS[m - 1]} ${y}.`);
  }

  // ─── Detect ──────────────────────────────────────────────────────────────
  // Detection runs only when asked. The picker lists what the backend found
  // and hasn't been adopted yet (GET /api/recurring/candidates) — every box
  // ticked to start, since the common answer is "yes, all of these" — and
  // adopting the ticked ones (POST /api/recurring/adopt) is what puts them on
  // the calendar. Nothing is written by opening the dialog, so cancelling
  // leaves the database exactly as it was.

  function candidateRowHtml(s, i) {
    const label = s.display_name || s.description;
    const detail = [
      CYCLE_LABEL[s.cycle] || s.cycle,
      `${s.occurrences} charge${s.occurrences === 1 ? '' : 's'}`,
      `next ${fmtShortDate(s.next_date)}`,
    ].join(' · ');
    return `<label class="rec-cand-row">
      <input type="checkbox" class="rec-cand-cb" data-key="${escapeHtml(s.key)}" data-index="${i}" checked>
      ${merchantAvatarHtml(label)}
      <span class="rec-cand-text">
        <span class="rec-cand-name">${escapeHtml(label)}</span>
        <span class="rec-cand-detail">${escapeHtml(detail)}</span>
      </span>
      <span class="rec-cand-amount rec-amount-${s.direction}">${escapeHtml(formatCurrency(s.amount, true))}</span>
    </label>`;
  }

  async function openDetectDialog() {
    closeCard();
    const res = await apiFetch('/api/recurring/candidates');
    if (!res.ok) {
      window.UI?.toast?.("Couldn't scan your transactions — try again.", { type: 'error' });
      return;
    }
    const { candidates } = await res.json();

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const close = () => overlay.remove();

    if (!candidates.length) {
      overlay.innerHTML = `
      <div class="confirm-dialog rec-detect-dialog">
        <button class="dialog-close-btn" aria-label="Close">×</button>
        <p><strong>No new recurring schedules found</strong></p>
        <p class="rec-detect-note">A pattern needs a few charges at a steady interval before it can be spotted. Import more history, or add a schedule by hand with the + on the day it falls on.</p>
        <div class="confirm-actions">
          <button class="confirm-cancel">Close</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
      overlay.querySelector('.confirm-cancel').addEventListener('click', close);
      return;
    }

    overlay.innerHTML = `
    <div class="confirm-dialog rec-detect-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p><strong>Recurring schedules found</strong></p>
      <p class="rec-detect-note">These transactions look like they repeat. Keep the ones you want to track — you can correct any detail afterwards.</p>
      <label class="rec-cand-all">
        <input type="checkbox" id="rec-cand-all" checked>
        <span>Select all (${candidates.length})</span>
      </label>
      <div class="rec-cand-list">${candidates.map(candidateRowHtml).join('')}</div>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-add" id="rec-cand-ok">Add selected</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

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
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);

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
  function confirmRemoveSchedule(key) {
    const s = seriesFor(key);
    const label = s.display_name || s.description || key;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p>Delete the <strong>${escapeHtml(label)}</strong> schedule?</p>
      <p class="rec-detect-note">Its transactions stay in your ledger, and detection can offer it again later.</p>
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
      const res = await apiFetch(`/api/recurring/schedule/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) {
        window.UI?.toast?.("Couldn't delete it — try again.", { type: 'error' });
        return;
      }
      closeCard();
      await load();
    });
  }

  /** ⋮ → "Clear all recurring schedules": the card's trash can applied to
   *  every schedule at once, under exactly the same rule — detected ones are
   *  un-adopted (back in the picker, corrections intact), hand-added ones are
   *  dropped. So what this clears is the CALENDAR, and the wording says so
   *  rather than implying the history behind it is going anywhere. */
  function confirmClearAll() {
    closeCard();
    const n = data.series.length;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p>Clear all <strong>${n}</strong> recurring schedule${n === 1 ? '' : 's'}?</p>
      <p class="rec-detect-note">The calendar goes back to blank. Your transactions stay in the ledger, and detection can offer the ones it found again.</p>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-delete">Clear all</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-delete').addEventListener('click', async () => {
      close();
      const res = await apiFetch('/api/recurring/schedules', { method: 'DELETE' });
      if (!res.ok) {
        window.UI?.toast?.("Couldn't clear your schedules — nothing was removed.", { type: 'error' });
        return;
      }
      expandedDays.clear();
      await load();
    });
  }

  /** Form dialog for a schedule with no transactions behind it yet — e.g.
   *  "I know I'll be charged $12/mo starting next month." Every field is
   *  required (unlike editing an existing schedule, where each field is
   *  independently optional): a manual schedule with a gap in any of them
   *  can't project anything, so the dialog only submits once all five are
   *  filled in validly.
   *
   *  Opened from a day cell's +, so `iso` is that day: the due date arrives
   *  already answered and the user starts on the name. It stays an editable
   *  field rather than a fixed caption — the cell says which date they meant,
   *  not that they can't have changed their mind about it. */
  function openAddDialog(iso) {
    closeCard();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog rec-add-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p><strong>Add a recurring schedule</strong></p>
      <label class="rec-add-field">
        <span class="rec-add-label">Name</span>
        <input type="text" class="rec-dialog-input" id="rec-add-name" maxlength="100" placeholder="e.g. Gym Membership" autocomplete="off">
      </label>
      <label class="rec-add-field">
        <span class="rec-add-label">Type</span>
        <select class="rec-select" id="rec-add-type">${typeOptionsHtml('expense')}</select>
      </label>
      <label class="rec-add-field">
        <span class="rec-add-label">Cadence</span>
        <select class="rec-select" id="rec-add-cycle">${cycleOptionsHtml('monthly')}</select>
      </label>
      <label class="rec-add-field">
        <span class="rec-add-label">Amount</span>
        <input type="text" inputmode="decimal" class="rec-dialog-input" id="rec-add-amount"
          placeholder="${escapeHtml(formatCurrency(0, true, { editable: true }))}" autocomplete="off">
      </label>
      <label class="rec-add-field">
        <span class="rec-add-label">Next due date</span>
        <input type="date" class="rec-dialog-input" id="rec-add-date" value="${escapeHtml(iso || '')}">
      </label>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-add">Add</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const nameInput   = overlay.querySelector('#rec-add-name');
    const typeSelect  = overlay.querySelector('#rec-add-type');
    const cycleSelect = overlay.querySelector('#rec-add-cycle');
    const amountInput = overlay.querySelector('#rec-add-amount');
    const dateInput   = overlay.querySelector('#rec-add-date');
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-close-btn').addEventListener('click', close);
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    amountInput.addEventListener('input', () => applyCurrencyFormat(amountInput));
    nameInput.focus();

    overlay.querySelector('.confirm-add').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const amount = parseFloat(stripCurrencyValue(amountInput.value));
      let invalid = false;
      const mark = (input, ok) => { input.classList.toggle('invalid', !ok); if (!ok) invalid = true; };
      mark(nameInput, name && normaliseDesc(name));
      mark(amountInput, amount > 0);
      mark(dateInput, !!dateInput.value);
      if (invalid) return;

      const res = await apiFetch('/api/recurring/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: name, direction: typeSelect.value, cycle: cycleSelect.value,
          amount, next_date: dateInput.value,
        }),
      });
      if (!res.ok) {
        window.UI?.toast?.("Couldn't add that schedule — try again.", { type: 'error' });
        return;
      }
      close();
      // Jump to the month the new schedule first lands in, so it is visible on
      // the grid straight away — the calendar is the only place it appears.
      // Usually a no-op now that the date comes from a cell in the visible
      // month; it still matters when the user moves the date while in here.
      month = dateInput.value.slice(0, 7);
      await load();
    });
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────────

  function renderToolbar() {
    const [y, m] = month.split('-').map(Number);
    const label = document.getElementById('rec-month-label');
    if (label) label.textContent = `${MONTHS[m - 1]} ${y}`;
    // Nothing to go back to while we're already there — disabled rather than
    // hidden, so the arrows and the ⋮ never move under the pointer.
    const today = document.getElementById('rec-month-today');
    if (today) today.disabled = month === currentMonthKey();
  }

  function render() {
    renderToolbar();
    renderEmpty();
    renderCalendar();
    if (activeOcc) renderCard();
  }

  async function load() {
    const res = await apiFetch(`/api/recurring?month=${encodeURIComponent(month)}`);
    if (!res.ok) return;
    data = await res.json();
    render();
  }

  function goToMonth(key) {
    month = key;
    closeCard();
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

    // Whole-page actions only: adding by hand is a property of a day now, so
    // it lives on the day cells (see .rec-day-add).
    //
    // Clear-all is offered only when there is something to clear. UI.openMenu
    // has no disabled state, and an item that opens a confirm dialog in order
    // to do nothing is worse than one that isn't there — the empty state
    // already says the page is blank.
    document.getElementById('rec-kebab-btn').addEventListener('click', (e) => {
      const items = [{ label: 'Find recurring schedules', action: openDetectDialog }];
      if (data.series.length) {
        items.push({ label: 'Clear all recurring schedules', action: confirmClearAll, danger: true });
      }
      UI.openMenu(e.currentTarget, items);
    });

    const calendar = document.getElementById('rec-calendar');
    const pop = popEl();

    // ── Chip → card ──
    // mouseover/mouseout (they bubble, unlike mouseenter/leave) so one pair of
    // listeners covers every chip across every re-render.
    calendar.addEventListener('mouseover', (e) => {
      const chip = e.target.closest('.rec-occ');
      if (!chip || editingKey) return;
      openCard({ key: chip.dataset.key, date: chip.dataset.date });
    });
    calendar.addEventListener('mouseout', (e) => {
      if (!e.target.closest('.rec-occ')) return;
      // Moving between two chips fires mouseout before the next mouseover —
      // the delayed close lets that mouseover cancel it, so the card doesn't
      // flicker as the pointer crosses a day cell.
      scheduleClose();
    });
    // Tabbing to a chip previews it exactly as hovering does. Deliberately not
    // pinned: focus also lands on a chip the instant it is clicked, and a
    // pre-pinned card would make that click read as the second (dismissing)
    // one of a toggle.
    calendar.addEventListener('focusin', (e) => {
      const chip = e.target.closest('.rec-occ');
      if (!chip || editingKey) return;
      openCard({ key: chip.dataset.key, date: chip.dataset.date });
    });
    calendar.addEventListener('click', (e) => {
      // The day's + — the schedule being added is due on that day, so the
      // dialog opens with the date already filled in.
      const add = e.target.closest('[data-add]');
      if (add) { openAddDialog(add.dataset.add); return; }
      const expand = e.target.closest('[data-expand]');
      if (expand) {
        const iso = expand.dataset.expand;
        if (expandedDays.has(iso)) expandedDays.delete(iso); else expandedDays.add(iso);
        renderCalendar();
        if (activeOcc) renderCard();
        return;
      }
      const chip = e.target.closest('.rec-occ');
      if (!chip) return;
      // Clicking the open chip again puts the card away; otherwise a click
      // pins it, so the pointer can leave the chip to reach the pencil/trash.
      const same = activeOcc && activeOcc.key === chip.dataset.key && activeOcc.date === chip.dataset.date;
      if (same && pinned) { closeCard(); return; }
      openCard({ key: chip.dataset.key, date: chip.dataset.date }, { pin: true });
    });

    // ── Inside the card ──
    pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    pop.addEventListener('mouseleave', scheduleClose);
    pop.addEventListener('click', (e) => {
      const btn = e.target.closest('.rec-action-btn');
      if (!btn) return;
      const { action, key } = btn.dataset;
      if (action === 'edit') startEdit(key);
      else if (action === 'save') commitEdit(key);
      else if (action === 'cancel') cancelEdit();
      else if (action === 'delete') confirmRemoveSchedule(key);
    });
    // Enter commits the open card, so an edit can be finished from the
    // keyboard without hunting for the ✓ — the dialogs elsewhere in the app
    // behave the same way. Escape is handled once, at the document level
    // below, so it can't both cancel the edit and close the card.
    pop.addEventListener('keydown', (e) => {
      if (editingKey && e.key === 'Enter') { e.preventDefault(); commitEdit(editingKey); }
    });
    pop.addEventListener('input', (e) => {
      if (e.target.classList.contains('rec-input-amount')) applyCurrencyFormat(e.target);
      // Typing is the fix for whatever the ✓ attempt flagged, so clear it as
      // soon as they start rather than leaving a red box under a corrected value.
      if (e.target.classList.contains('rec-input')) e.target.classList.remove('invalid');
    });

    document.getElementById('rec-empty').addEventListener('click', (e) => {
      if (e.target.closest('[data-empty-action="detect"]')) openDetectDialog();
    });

    // A pinned card is dismissed the way every other transient surface in the
    // app is: Escape, or a click anywhere that isn't it.
    //
    // Capture phase, deliberately: the card's own buttons re-render it, which
    // detaches the very node that was clicked. By the time a bubbling listener
    // ran, e.target would be orphaned and closest() would find no #rec-pop
    // ancestor — so pressing the pencil would read as an outside click and
    // close the card instead of opening the editor.
    document.addEventListener('click', (e) => {
      if (!pinned || e.target.closest('#rec-pop, .rec-occ, .confirm-overlay')) return;
      closeCard();
    }, true);
    // Escape steps back one level at a time: out of an edit first, out of the
    // card second. A dialog on top owns its own Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-overlay')) return;
      if (editingKey) cancelEdit();
      else if (activeOcc) closeCard();
    });

    // The card is fixed-positioned against its chip, so it has to follow the
    // page under it (the .page scroll container scrolls, not the window).
    const reanchor = () => {
      if (!activeOcc) return;
      const chip = chipFor(activeOcc);
      if (chip) positionCard(chip); else closeCard();
    };
    window.addEventListener('resize', reanchor);
    document.addEventListener('scroll', reanchor, true);

    window.addEventListener('currencychange', render);
    load();
  });
}());
