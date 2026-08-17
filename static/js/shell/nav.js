'use strict';

// Highlights the current page's link in the shared sidebar. The sidebar is one
// partial served to every route (pages/partials/sidebar.html), so the .active
// class can no longer be baked into per-page markup — derive it from the URL.
(function () {
  let p = location.pathname;
  // Plain-browser mode: a page opened straight from pages/ — map
  // ".../pages/dashboard.html" back to its app:// route shape.
  const m = p.match(/\/pages\/([\w-]+)\.html$/);
  if (m) p = m[1] === 'dashboard' ? '/' : `/${m[1]}`;
  document.querySelectorAll('.menu .nav a[href]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === p);
  });
}());

// (The Transactions link used to carry an uncategorized-count pill, refreshed
// here on every page load and by the Transactions page after each edit. It was
// removed — the count lives on the Transactions page itself, where it can be
// acted on — and with it the GET /api/transactions/uncategorized-count route it
// was the only caller of.)
