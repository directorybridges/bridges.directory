/* Member site: shows what the admin published.
 *   1. Page text from "Page text" in the admin (public.get_content), swapped into the page wherever the default wording appears.
 *   2. The site notice and the "sign-ups are paused" message from Settings (public.public_settings).
 * Atharva's page keeps its text inside its own code, so this works on the finished page: it looks for the default sentence
 * (from admin-data.js) inside the right part of the page and replaces it. If a sentence is not found it is simply skipped, so a
 * wording change in the page can never break the site. Only runs when window.BRIDGES.enabled is true.
 */
(function () {
  'use strict';
  var B = window.BRIDGES, DATA = window.BADMIN_DATA;
  if (!B || !B.enabled || !DATA || !DATA.PAGES) return;

  var CACHE = 'bridges-content-cache';
  var state = { content: {}, pub: { signups_open: true, pause_msg: '', banner_on: false, banner_msg: '' } };
  window.BPublic = state.pub;

  // each page's text lives inside one part of the page
  var SCOPE = { home: '#v-home', login: '#v-login', faculty: '#v-login', join: '#v-join', directory: '#v-directory, #v-browse', contribute: '#v-contribute', footer: 'footer.ft', notify: '#toasts' };
  var scopeOf = function (pageId) { return pageId.indexOf('doc-') === 0 ? '#v-doc' : SCOPE[pageId]; };

  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var textOfHtml = function (h) { var d = document.createElement('div'); d.innerHTML = h; return norm(d.textContent); };

  // the body of a page may only use a few tags (the database refuses anything else, this is a second lock)
  function cleanHtml(html) {
    var doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html'), r = doc.getElementById('r');
    var ok = { H3: 1, P: 1, UL: 1, LI: 1, B: 1, A: 1, BR: 1 };
    (function walk(n) {
      Array.prototype.slice.call(n.childNodes).forEach(function (c) {
        if (c.nodeType === 1) {
          if (!ok[c.tagName]) { c.remove(); return; }
          Array.prototype.slice.call(c.attributes).forEach(function (a) { if (!(c.tagName === 'A' && a.name === 'href' && /^https:\/\//i.test(a.value))) c.removeAttribute(a.name); });
          if (c.tagName === 'A') { c.setAttribute('rel', 'noopener noreferrer'); c.setAttribute('target', '_blank'); }
          walk(c);
        } else if (c.nodeType !== 3) c.remove();
      });
    })(r);
    return r.innerHTML;
  }

  // "Hello {name}" becomes a pattern that also matches "Hello Priya"; the same words are put back into the new text
  function matcher(def) {
    var names = [], src = escRe(norm(def)).replace(/\\\{(\w+)\\\}/g, function (m, k) { names.push(k); return '(.+?)'; });
    if (!names.length) { var plain = norm(def); return { test: function (t) { return t === plain; }, fill: function (o) { return o; } }; }
    var re = new RegExp('^' + src + '$');
    return {
      test: function (t) { return re.test(t); },
      fill: function (o, t) { var m = re.exec(t) || [], vals = {}; names.forEach(function (k, i) { vals[k] = m[i + 1]; }); return o.replace(/\{(\w+)\}/g, function (x, k) { return vals[k] != null ? vals[k] : x; }); }
    };
  }

  var rules = null;
  function buildRules() {
    rules = [];
    DATA.PAGES.forEach(function (p) {
      var scope = scopeOf(p.id), over = state.content[p.id];
      if (!scope || !over) return;
      p.f.forEach(function (f) {
        var k = f[0], def = f[2], type = f[3];
        if (over[k] == null || over[k] === def) return;
        if (type === 'h') rules.push({ scope: scope + ' .doc-b', html: true, defText: textOfHtml(def), out: over[k] });
        else { var m = matcher(def); rules.push({ scope: scope, m: m, out: over[k] }); }
      });
    });
  }

  function setText(el, text) {
    el.textContent = '';
    String(text).split('\n').forEach(function (line, i) { if (i) el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(line)); });
  }
  var leafLike = function (el) {
    for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === 1 && c.tagName !== 'BR') return false; if (c.nodeType !== 1 && c.nodeType !== 3) return false; }
    return true;
  };

  // the text of an element, with a line break counted as a space
  function elText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; t += c.nodeType === 3 ? c.nodeValue : ' '; }
    return norm(t);
  }
  function applyContent() {
    if (!rules) buildRules();
    rules.forEach(function (r) {
      Array.prototype.forEach.call(document.querySelectorAll(r.scope), function (root) {
        if (r.html) {
          if (norm(root.textContent) === r.defText) root.innerHTML = cleanHtml(r.out);
          return;
        }
        var els = root.matches('*') ? [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'))) : [];
        els.forEach(function (el) {
          if (!leafLike(el) || /^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
          var t = elText(el);
          if (t && r.m.test(t)) setText(el, r.m.fill(r.out, t));
        });
      });
    });
  }

  /* ------------------------------------------------------------------ notice and paused sign-ups */
  function applyNotice() {
    var p = state.pub, n = document.getElementById('br-notice');
    if (p.banner_on && p.banner_msg) {
      if (!n) {
        n = document.createElement('div'); n.id = 'br-notice'; n.setAttribute('role', 'status');
        n.style.cssText = 'padding:10px 16px;text-align:center;font-size:.875rem;line-height:1.4;background:var(--fill-2);color:var(--ink);border-bottom:1px solid var(--line)';
        var h = document.querySelector('header.nav'); document.body.insertBefore(n, h || document.body.firstChild);
      }
      if (n.textContent !== p.banner_msg) n.textContent = p.banner_msg;
    } else if (n) n.remove();
    var j = document.getElementById('v-join'), c = j && j.querySelector('[data-br-paused]');
    if (j && !p.signups_open) {
      if (!c) { c = document.createElement('div'); c.className = 'callout'; c.setAttribute('data-br-paused', ''); c.setAttribute('role', 'status'); c.style.margin = '0 0 16px'; j.insertBefore(c, j.firstChild); }
      var msg = p.pause_msg || 'Sign-ups are paused for now. Please check back soon.';
      if (c.textContent !== msg) c.textContent = msg;
    } else if (c) c.remove();
  }

  var running = false, queued = false, obs = null;
  function run() {
    if (running) { queued = true; return; }
    running = true;
    if (obs) obs.disconnect();
    try { applyContent(); applyNotice(); } catch (e) { console.error('[bridges] content', e); }
    if (obs) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    running = false;
    if (queued) { queued = false; schedule(); }
  }
  var timer = null;
  function schedule() { if (timer) return; timer = setTimeout(function () { timer = null; run(); }, 80); }

  function setContent(rows) {
    state.content = {};
    (rows || []).forEach(function (r) { (state.content[r.page_id] = state.content[r.page_id] || {})[r.field_key] = r.value; });
    rules = null;
  }
  function call(name) {
    return fetch(B.supabaseUrl + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: B.publishableKey, Authorization: 'Bearer ' + B.publishableKey, 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { if (!r.ok) throw new Error(name + ' ' + r.status); return r.json(); });
  }
  function save() { try { localStorage.setItem(CACHE, JSON.stringify({ content: state.content, pub: state.pub })); } catch (e) { /* ignore */ } }
  var last = 0;
  function refresh() {
    last = Date.now();
    return Promise.all([call('get_content'), call('public_settings')]).then(function (r) {
      setContent(r[0]);
      Object.keys(state.pub).forEach(function (k) { delete state.pub[k]; });
      Object.assign(state.pub, r[1] || {});
      save(); schedule();
    }).catch(function (e) { console.warn('[bridges] could not load published text', e && e.message); });
  }

  // show what was last published straight away, then ask for the latest
  try {
    var c = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (c && c.content) { setContent(Object.keys(c.content).reduce(function (a, p) { Object.keys(c.content[p]).forEach(function (k) { a.push({ page_id: p, field_key: k, value: c.content[p][k] }); }); return a; }, [])); Object.assign(state.pub, c.pub || {}); }
  } catch (e) { /* ignore */ }
  var start = function () {
    obs = new MutationObserver(schedule);
    run();
    refresh();
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - last > 120000) refresh(); });
    setInterval(function () { if (!document.hidden) refresh(); }, 600000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
