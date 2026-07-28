'use strict';

(function () {
  // ─── Recurring (Reports) ────────────────────────────────────────────────────
  // Calendar (left) + full editable listing (right) of every currently-active
  // recurring series. Detection/cycle-classification/projection is server-side
  // (GET /api/recurring?month=YYYY-MM, backed by detectRecurringSeries in
  // services/predictions.js); the list's merchant name/cadence/amount are
  // pre-filled predictions the user can correct in place, persisted as a
  // per-series override (POST /api/recurring/override) — see the "Editing"
  // section below. Otherwise this page just lays out the response and handles
  // month navigation + calendar<->table linked selection.
  //
  // Globals (loaded before this script): apiFetch (api.js), escapeHtml
  // (escape.js), debounce (format.js), formatCurrency/applyCurrencyFormat/
  // stripCurrencyValue (currency.js), merchantAvatarHtml (avatar.js), UI (ui.js).

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
  const MAX_DOTS_PER_DAY = 4;

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

  function initial(name) {
    return String(name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  // Mirror of services/predictions.js's normaliseDesc — used client-side only
  // to warn the Add-schedule dialog when a name won't key off any letters
  // (the backend is the actual source of truth and re-derives this itself).
  function normaliseDesc(desc) {
    return String(desc || '').toLowerCase().replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim();
  }

  let month = currentMonthKey();
  let data = { series: [], occurrences: [] };
  let selectedKey = null;

  // ─── Calendar ────────────────────────────────────────────────────────────

  function seriesFor(key) {
    return data.series.find((s) => s.key === key) || {};
  }

  function dotHtml(occ) {
    const s = seriesFor(occ.key);
    const label = s.display_name || s.description || occ.key;
    const cls = `rec-dot rec-dot-${occ.direction} rec-dot-${occ.actual ? 'actual' : 'projected'}`
      + (occ.key === selectedKey ? ' rec-dot-selected' : '');
    const tip = `${label} — ${formatCurrency(occ.amount, true)}${occ.actual ? '' : ' (projected)'}`;
    return `<span class="${cls}" data-key="${escapeHtml(occ.key)}" title="${escapeHtml(tip)}"
      tabindex="0" role="button" aria-label="${escapeHtml(tip)}">${escapeHtml(initial(label))}</span>`;
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
      const shown = c.occs.slice(0, MAX_DOTS_PER_DAY);
      const overflow = c.occs.length - shown.length;
      const dots = shown.map(dotHtml).join('')
        + (overflow > 0 ? `<span class="rec-day-more">+${overflow}</span>` : '');
      return `<div class="rec-day${c.iso === today ? ' rec-day-today' : ''}">
        <span class="rec-day-num">${c.day}</span>
        <div class="rec-day-dots">${dots}</div>
      </div>`;
    }).join('');

    host.innerHTML = `<div class="rec-cal-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="rec-cal-grid">${cellHtml}</div>`;
  }

  // ─── Table ───────────────────────────────────────────────────────────────
  // Rows are pre-filled with the detected series (merchant label, cadence,
  // predicted amount) but every field is directly editable — a correction
  // persists as a per-series override (POST /api/recurring/override) layered
  // on top of the detection on every future read, same "predict, then let
  // the user correct" shape the auto-categorizer uses elsewhere in the app.

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

  function rowHtml(s) {
    const label = s.display_name || s.description;
    const cls = `rec-row${s.key === selectedKey ? ' rec-row-selected' : ''}`;
    const key = escapeHtml(s.key);
    return `<tr class="${cls}" data-key="${key}" tabindex="0" role="button">
      <td><div class="rec-row-name">
        ${merchantAvatarHtml(label)}
        <span class="rec-row-label">
          <input type="text" class="rec-input rec-input-name" data-key="${key}" data-field="display_name"
            value="${escapeHtml(label)}" maxlength="100" aria-label="Merchant name">
          <span class="rec-row-cycle">Next ${fmtShortDate(s.next_date)}</span>
        </span>
      </div></td>
      <td class="rec-col-type">
        <select class="rec-input rec-select" data-key="${key}" data-field="direction" aria-label="Type">
          ${typeOptionsHtml(s.direction)}
        </select>
      </td>
      <td class="rec-col-cadence">
        <select class="rec-input rec-select" data-key="${key}" data-field="cycle" aria-label="Cadence">
          ${cycleOptionsHtml(s.cycle)}
        </select>
      </td>
      <td class="rec-amount rec-amount-${s.direction}">
        <input type="text" inputmode="decimal" class="rec-input rec-input-amount" data-key="${key}" data-field="amount"
          value="${escapeHtml(formatCurrency(s.amount, true, { editable: true }))}" aria-label="Amount">
      </td>
      <td class="rec-col-remove">
        <button type="button" class="rec-remove-btn" data-key="${key}" aria-label="Remove ${escapeHtml(label)}" title="Remove">×</button>
      </td>
    </tr>`;
  }

  function renderTable() {
    const host = document.getElementById('rec-list');
    if (!host) return;
    if (!data.series.length) {
      host.innerHTML = UI.emptyState({
        icon: 'calendar',
        title: 'No recurring schedules yet',
        desc: 'Once a transaction repeats on a steady schedule — weekly, monthly, and so on — it shows up here automatically. Or use the ⋮ menu to add one yourself.',
      });
      return;
    }
    host.innerHTML = `<table class="rec-table">
      <thead><tr>
        <th>Merchant</th><th class="rec-col-type">Type</th><th class="rec-col-cadence">Cadence</th>
        <th class="rec-col-amount">Amount</th><th class="rec-col-remove"></th>
      </tr></thead>
      <tbody>${data.series.map(rowHtml).join('')}</tbody>
    </table>`;
  }

  // ─── Editing ─────────────────────────────────────────────────────────────
  // Text/amount fields save 600ms after typing stops (one debounced saver per
  // (key, field), cached so repeated keystrokes across renders keep
  // coalescing correctly); the cadence <select> saves immediately on change,
  // since a picked option is already a single discrete action. A save never
  // triggers a table rebuild — that would drop focus mid-edit — so on
  // success we only patch `data` in place and repaint the calendar, whose
  // dots read display_name/amount for their tooltip text. A cadence change
  // also reshuffles which future days get a projected dot (server-only
  // logic), so that one path re-fetches instead.

  const _saveDebouncers = new Map(); // `${key}:${field}` -> debounced saver

  function debouncedSaver(key, field) {
    const cacheKey = `${key}:${field}`;
    let fn = _saveDebouncers.get(cacheKey);
    if (!fn) {
      fn = debounce((value) => saveOverride(key, { [field]: value }), 600);
      _saveDebouncers.set(cacheKey, fn);
    }
    return fn;
  }

  async function saveOverride(key, patch) {
    const res = await apiFetch('/api/recurring/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...patch }),
    });
    if (!res.ok) {
      window.UI?.toast?.("Couldn't save your change — it hasn't been stored.", { type: 'error' });
    }
  }

  function seriesIndex(key) {
    return data.series.findIndex((s) => s.key === key);
  }

  function onNameInput(input) {
    const key = input.dataset.key;
    const i = seriesIndex(key);
    if (i === -1) return;
    const value = input.value.trim();
    if (!value) return; // wait for a non-empty name before saving
    data.series[i].display_name = value;
    renderCalendar();
    debouncedSaver(key, 'display_name')(value);
  }

  function onNameBlur(input) {
    const s = seriesFor(input.dataset.key);
    if (!input.value.trim()) input.value = s.display_name || s.description || '';
  }

  function onAmountInput(input) {
    applyCurrencyFormat(input);
    const key = input.dataset.key;
    const i = seriesIndex(key);
    if (i === -1) return;
    const parsed = parseFloat(stripCurrencyValue(input.value));
    if (!parsed || parsed <= 0) return; // wait for a valid amount before saving
    data.series[i].amount = parsed;
    // Past occurrences are real transaction amounts and never change; only
    // still-projected dots follow the new predicted amount.
    for (const occ of data.occurrences) {
      if (occ.key === key && !occ.actual) occ.amount = parsed;
    }
    renderCalendar();
    debouncedSaver(key, 'amount')(parsed);
  }

  function onAmountBlur(input) {
    const s = seriesFor(input.dataset.key);
    const parsed = parseFloat(stripCurrencyValue(input.value));
    if (!parsed || parsed <= 0) input.value = formatCurrency(s.amount, true, { editable: true });
  }

  async function onCycleChange(select) {
    const key = select.dataset.key;
    await saveOverride(key, { cycle: select.value });
    // The cadence change moves future projected dots to new dates — that
    // placement logic is server-only, so re-fetch rather than guess locally.
    // Patch in place (calendar + this row's "Next ..." subtext) instead of
    // calling load()/render(): a full table rebuild here would tear out
    // whatever <input> DOM node a debounced name/amount save is still
    // in-flight against (on this row or another), even though the save
    // itself would still land correctly a moment later.
    const res = await apiFetch(`/api/recurring?month=${encodeURIComponent(month)}`);
    if (!res.ok) return;
    data = await res.json();
    renderCalendar();
    const s = seriesFor(key);
    const cycleLabel = document.querySelector(`.rec-row[data-key="${CSS.escape(key)}"] .rec-row-cycle`);
    if (cycleLabel && s.next_date) cycleLabel.textContent = `Next ${fmtShortDate(s.next_date)}`;
  }

  // Unlike cadence, a direction change doesn't move any dates around — it
  // only recolors this schedule everywhere it appears — so it's a pure
  // client-side patch + calendar repaint, no re-fetch needed.
  function onTypeChange(select) {
    const key = select.dataset.key;
    const i = seriesIndex(key);
    if (i === -1) return;
    data.series[i].direction = select.value;
    for (const occ of data.occurrences) {
      if (occ.key === key) occ.direction = select.value;
    }
    renderCalendar();
    const row = document.querySelector(`.rec-row[data-key="${CSS.escape(key)}"]`);
    const amountCell = row?.querySelector('.rec-amount');
    if (amountCell) {
      amountCell.classList.remove('rec-amount-income', 'rec-amount-expense', 'rec-amount-transfer');
      amountCell.classList.add(`rec-amount-${select.value}`);
    }
    saveOverride(key, { direction: select.value });
  }

  // ─── Add / remove ─────────────────────────────────────────────────────────

  /** Small confirm dialog, same .confirm-* shell the rest of the app uses for
   *  destructive prompts. */
  function confirmRemoveSchedule(key) {
    const s = seriesFor(key);
    const label = s.display_name || s.description || key;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <button class="dialog-close-btn" aria-label="Close">×</button>
      <p>Remove <strong>${escapeHtml(label)}</strong> from Recurring?</p>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-delete">Remove</button>
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
        window.UI?.toast?.("Couldn't remove it — try again.", { type: 'error' });
        return;
      }
      if (selectedKey === key) selectedKey = null;
      await load();
    });
  }

  /** Form dialog for a schedule with no transactions behind it yet — e.g.
   *  "I know I'll be charged $12/mo starting next month." Every field is
   *  required (unlike editing an existing row, where each field is
   *  independently optional): a manual schedule with a gap in any of them
   *  can't project anything, so the dialog only submits once all five are
   *  filled in validly. */
  function openAddDialog() {
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
        <input type="date" class="rec-dialog-input" id="rec-add-date">
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
      await load();
    });
  }

  // ─── Toolbar + linked selection ─────────────────────────────────────────

  function renderToolbar() {
    const [y, m] = month.split('-').map(Number);
    const label = document.getElementById('rec-month-label');
    if (label) label.textContent = `${MONTHS[m - 1]} ${y}`;
  }

  function applySelection() {
    document.querySelectorAll('.rec-dot[data-key]').forEach((el) => {
      el.classList.toggle('rec-dot-selected', el.dataset.key === selectedKey);
    });
    document.querySelectorAll('.rec-row[data-key]').forEach((el) => {
      el.classList.toggle('rec-row-selected', el.dataset.key === selectedKey);
    });
  }

  function selectKey(key) {
    selectedKey = selectedKey === key ? null : key;
    applySelection();
    if (selectedKey) {
      const row = document.querySelector(`.rec-row[data-key="${CSS.escape(selectedKey)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function render() {
    renderToolbar();
    renderCalendar();
    renderTable();
  }

  async function load() {
    const res = await apiFetch(`/api/recurring?month=${encodeURIComponent(month)}`);
    if (!res.ok) return;
    data = await res.json();
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rec-month-prev').addEventListener('click', () => {
      month = addMonthKey(month, -1);
      selectedKey = null;
      load();
    });
    document.getElementById('rec-month-next').addEventListener('click', () => {
      month = addMonthKey(month, 1);
      selectedKey = null;
      load();
    });

    // The label is a picker, like Home's month stepper — .stepper-label draws a
    // caret and a pointer cursor, so it has to open something. The window runs
    // a few months ahead of today rather than stopping there the way Home's
    // does: this report projects upcoming charges. The arrows still reach past
    // either end.
    document.getElementById('rec-month-label').addEventListener('click', (e) => {
      e.stopPropagation();
      const items = [];
      for (let i = 3; i > -9; i--) {
        const key = addMonthKey(currentMonthKey(), i);
        const [y, m] = key.split('-').map(Number);
        items.push({
          label: `${MONTHS[m - 1]} ${y}`,
          selected: key === month,
          action: () => { month = key; selectedKey = null; load(); },
        });
      }
      UI.openMenu(e.currentTarget, items);
    });

    document.getElementById('rec-kebab-btn').addEventListener('click', (e) => {
      UI.openMenu(e.currentTarget, [
        { label: 'Add recurring schedule', action: openAddDialog },
      ]);
    });

    const layout = document.getElementById('rec-layout');
    // Row selection is a click/keydown on the row itself; a click/keydown
    // that landed in one of the row's own editable controls (or its remove
    // button) should act on that control, not also toggle the
    // calendar-linked selection underneath it.
    layout.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.rec-remove-btn');
      if (removeBtn) { confirmRemoveSchedule(removeBtn.dataset.key); return; }
      if (e.target.closest('input, select')) return;
      const el = e.target.closest('[data-key]');
      if (el) selectKey(el.dataset.key);
    });
    layout.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('input, select, button')) return;
      const el = e.target.closest('[data-key]');
      if (!el) return;
      e.preventDefault();
      selectKey(el.dataset.key);
    });

    const list = document.getElementById('rec-list');
    list.addEventListener('input', (e) => {
      if (e.target.classList.contains('rec-input-name')) onNameInput(e.target);
      else if (e.target.classList.contains('rec-input-amount')) onAmountInput(e.target);
    });
    // blur doesn't bubble, so this needs the capture phase to reach the list
    // via delegation instead of one listener per input.
    list.addEventListener('blur', (e) => {
      if (e.target.classList.contains('rec-input-name')) onNameBlur(e.target);
      else if (e.target.classList.contains('rec-input-amount')) onAmountBlur(e.target);
    }, true);
    list.addEventListener('change', (e) => {
      if (!e.target.classList.contains('rec-select')) return;
      if (e.target.dataset.field === 'cycle') onCycleChange(e.target);
      else if (e.target.dataset.field === 'direction') onTypeChange(e.target);
    });

    window.addEventListener('currencychange', render);
    load();
  });
}());
