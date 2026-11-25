/* Page titles, descriptions and headings for every page of the member site.
   The site is one page with #routes, so the browser tab, history, bookmarks and screen readers need the title to change with the page.
   Lives in its own file (like hero-globe.js), so a new design file from Atharva does not remove it. Re-added by tools/wire-backend.js. */
(function () {
  var SITE = 'Bridges.directory';
  var HOME_T = SITE + ' | Talk to someone who\'s already there';
  var HOME_D = 'A free, verified directory of students and alumni from India\'s design schools: the NIFTs, the NIDs and the IITs. Find someone from your branch and ask about entrances, portfolios, campus life or work.';
  var T = {
    browse: 'Browse by institute', directory: 'Directory', login: 'Log in', queue: 'Verification',
    volunteer: 'Become a volunteer', refer: 'Refer an alum', profile: 'My profile', contribute: 'Contribute',
    about: 'About', privacy: 'Privacy policy', terms: 'Terms of use', cookies: 'Cookie policy', guidelines: 'Community guidelines'
  };
  var JOIN = { student: 'Sign up as a student', alum: 'Sign up as an alum', referral: 'Sign up with a referral' };
  var D = {
    about: 'Bridges.directory is a free, verified directory of students and alumni from India\'s design schools. Built by their own, kept running by contributors.',
    guidelines: 'How members of Bridges.directory ask, answer and treat each other.',
    privacy: 'What Bridges.directory collects, why, and how long it is kept.',
    terms: 'The terms for using Bridges.directory.',
    cookies: 'The cookies Bridges.directory uses and how to change your choice.',
    contribute: 'Bridges.directory is free to use. Contributions keep it running.',
    login: 'Log in to Bridges.directory with the Google account you joined with.',
    join: 'Join Bridges.directory as a student or an alum of a listed institute.'
  };
  function route() {
    var h = (location.hash || '').replace(/^#/, '').split('/');
    var a = h[0] || '', b = h[1] || '';
    if (a === 'join') return { title: (JOIN[b] || 'Sign up') + ' · ' + SITE, desc: D.join };
    if (T[a]) return { title: T[a] + ' · ' + SITE, desc: D[a] || HOME_D };
    return { title: HOME_T, desc: HOME_D };
  }
  function setMeta(sel, attr, val) { var m = document.querySelector(sel); if (m) m.setAttribute(attr, val); }
  function apply() {
    var r = route();
    if (document.title !== r.title) document.title = r.title;
    setMeta('meta[name="description"]', 'content', r.desc);
    // every page needs one main heading: the visible page's first heading becomes the h1 for assistive tech and crawlers
    var main = document.querySelector('main:not([hidden])');
    if (main && !main.querySelector('h1')) {
      var h = main.querySelector('.head .h2, .h2, h2');
      if (h && h.getAttribute('aria-level') !== '1') { h.setAttribute('role', 'heading'); h.setAttribute('aria-level', '1'); }
    }
  }
  var t;
  function later() { clearTimeout(t); t = setTimeout(apply, 60); }
  window.addEventListener('hashchange', later);
  window.addEventListener('DOMContentLoaded', later);
  window.addEventListener('load', later);
  try { new MutationObserver(later).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  later();
})();
