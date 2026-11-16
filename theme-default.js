/* Admin portal only: light mode by default. People can switch to dark with the toggle and it is remembered.
 * A dark value that was saved before anyone pressed the toggle (an old default) is reset to light once.
 * Loaded first in <head> so the page never flashes dark. */
(function () {
  var admin = /admin/i.test(location.pathname);
  var key = admin ? 'bridges-admin-theme' : 'bridges-theme';
  var t = 'light';
  try {
    var saved = localStorage.getItem(key);
    if (admin) {
      /* only a real press of the toggle counts as a choice */
      var chosen = localStorage.getItem('bridges-admin-theme-chosen') === '1';
      if (chosen && (saved === 'dark' || saved === 'light')) t = saved;
      else localStorage.setItem(key, 'light');
    } else if (saved === 'dark' || saved === 'light') t = saved;
  } catch (e) { /* storage blocked: stay light */ }
  document.documentElement.dataset.theme = t;
  if (admin) document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#themeB')) { try { localStorage.setItem('bridges-admin-theme-chosen', '1'); } catch (x) {} }
  }, true);
  var st = document.createElement('style');
  st.textContent = '[data-theme-set="system"]{display:none!important}.side-card:has([data-theme-set]) .help{display:none}';
  document.head.appendChild(st);
})();
