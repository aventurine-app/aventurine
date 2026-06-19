'use strict';

// Cash Flow Reports — tab bar controller (pages/cash-flow.html).
// Standard ARIA tablist: click or arrow/Home/End to switch report panels,
// with roving tabindex so only the active tab is in the tab order. Built for
// one report today (Forecast); adding a report = a `.cf-tab` button in the
// tablist + a matching `.cf-panel[data-panel]` — no JS change needed.
(function () {
  const tablist = document.querySelector('.cf-tabs');
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('.cf-tab'));
  const panels = Array.from(document.querySelectorAll('.cf-panel'));
  if (!tabs.length) return;

  function select(tab, focus) {
    const id = tab.dataset.tab;
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach((p) => { p.hidden = p.dataset.panel !== id; });
    if (focus) tab.focus();
  }

  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('.cf-tab');
    if (tab) select(tab);
  });

  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j >= 0) { e.preventDefault(); select(tabs[j], true); }
  });

  // Sync initial state (roving tabindex + panel visibility) to the markup's
  // pre-selected tab.
  select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);
}());
