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
