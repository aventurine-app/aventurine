'use strict';

(function () {
  // ─── Recurring (Reports) ────────────────────────────────────────────────────
  // Calendar (left) + full listing (right) of every currently-active recurring
  // series. All detection/cycle-classification/projection is server-side
  // (GET /api/recurring?month=YYYY-MM, backed by detectRecurringSeries in
  // services/predictions.js); this page only lays out the response and handles
  // month navigation + calendar<->table linked selection.
  //
  // Globals (loaded before this script): apiFetch (api.js), escapeHtml
  // (escape.js), formatCurrency (currency.js), UI (ui.js).

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

  function rowHtml(s) {
    const label = s.display_name || s.description;
    const cls = `rec-row${s.key === selectedKey ? ' rec-row-selected' : ''}`;
    const sign = s.direction === 'income' ? '+' : '';
    return `<tr class="${cls}" data-key="${escapeHtml(s.key)}" tabindex="0" role="button">
      <td><div class="rec-row-name">
        <span class="rec-dot rec-dot-${s.direction} rec-dot-actual" aria-hidden="true">${escapeHtml(initial(label))}</span>
        <span class="rec-row-label">
          <span class="rec-row-merchant">${escapeHtml(label)}</span>
          <span class="rec-row-cycle">${CYCLE_LABEL[s.cycle] || s.cycle} · next ${fmtShortDate(s.next_date)}</span>
        </span>
      </div></td>
      <td class="rec-amount rec-amount-${s.direction}">${sign}${escapeHtml(formatCurrency(s.amount, true))}</td>
    </tr>`;
  }

  function renderTable() {
    const host = document.getElementById('rec-list');
    if (!host) return;
    if (!data.series.length) {
      host.innerHTML = UI.emptyState({
        icon: 'calendar',
        title: 'No recurring transactions yet',
        desc: 'Once a transaction repeats on a steady schedule — weekly, monthly, and so on — it shows up here automatically.',
      });
      return;
    }
    host.innerHTML = `<table class="rec-table">
      <thead><tr><th>Merchant</th><th class="rec-col-amount">Amount</th></tr></thead>
      <tbody>${data.series.map(rowHtml).join('')}</tbody>
    </table>`;
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

    const layout = document.getElementById('rec-layout');
    layout.addEventListener('click', (e) => {
      const el = e.target.closest('[data-key]');
      if (el) selectKey(el.dataset.key);
    });
    layout.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target.closest('[data-key]');
      if (!el) return;
      e.preventDefault();
      selectKey(el.dataset.key);
    });

    window.addEventListener('currencychange', render);
    load();
  });
}());
