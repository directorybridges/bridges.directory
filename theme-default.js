/* Light mode by default, for everyone. People can switch to dark and it is remembered.
 * There is no "follow the system" setting. Loaded first in <head> so the page never flashes dark. */
(function () {
  var admin = /admin/i.test(location.pathname);
  var key = admin ? 'bridges-admin-theme' : 'bridges-theme';
  var t = 'light';
  try {
    var saved = localStorage.getItem(key);
    if (saved === 'dark' || saved === 'light') t = saved;
    else if (admin) localStorage.setItem(key, 'light'); // the admin page decides on its own when nothing is saved
  } catch (e) { /* storage blocked: stay light */ }
  document.documentElement.dataset.theme = t;
  var st = document.createElement('style');
  st.textContent = '[data-theme-set="system"]{display:none!important}.side-card:has([data-theme-set]) .help{display:none}';
  document.head.appendChild(st);
})();
