'use strict';

// Highlights the current page's link in the shared sidebar. The sidebar is one
// partial served to every route (pages/partials/sidebar.html), so the .active
// class can no longer be baked into per-page markup — derive it from the URL.
(function () {
  let p = location.pathname;
  // Plain-browser mode: a page opened straight from pages/ — map
  // ".../pages/home.html" back to its app:// route shape.
  const m = p.match(/\/pages\/([\w-]+)\.html$/);
  if (m) p = m[1] === 'home' ? '/' : `/${m[1]}`;
  document.querySelectorAll('.menu .nav a[href]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === p);
  });
}());

// ─── Uncategorized-transaction badge ────────────────────────────────────────
// The Transactions sidebar link carries a pill showing how many transactions
// are still uncategorized. nav.js loads on every page, so the badge stays
// current app-wide; the Transactions page also calls setUncatBadge() after each
// edit so the count tracks live without re-fetching.
(function () {
  function setUncatBadge(n) {
    const el = document.getElementById('nav-uncat-badge');
    if (!el) return;
    const count = Number(n) || 0;
    el.textContent = count > 99 ? '99+' : String(count);
    el.hidden = count <= 0;
  }

  async function refreshUncatBadge() {
    try {
      const r = await apiFetch('/api/transactions/uncategorized-count');
      if (!r.ok) return;
      const data = await r.json();
      setUncatBadge(data.count);
    } catch {
      // Badge is non-essential chrome — a failed count just leaves it hidden.
    }
  }

  window.setUncatBadge = setUncatBadge;
  window.refreshUncatBadge = refreshUncatBadge;
  refreshUncatBadge();
}());
