'use strict';

// Reports — tab bar controller (pages/reports.html).
// Standard ARIA tablist: click or arrow/Home/End to switch report panels,
// with roving tabindex so only the active tab is in the tab order. Adding a
// report = a `.rep-tab` button in the tablist + a matching
// `.rep-panel[data-panel]` — no JS change needed.
//
// A hidden panel's charts draw at zero width and skip the paint; every chart
// here observes its container, so the report renders the moment its tab is
// selected. That's what lets each report load its data up front, unconditionally.
(function () {
  const tablist = document.querySelector('.rep-tabs');
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('.rep-tab'));
  const panels = Array.from(document.querySelectorAll('.rep-panel'));
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
    const tab = e.target.closest('.rep-tab');
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

  // The default report is whatever tab comes first in the row — reordering
  // the buttons in the markup is all it takes to change it.
  select(tabs[0]);
}());
