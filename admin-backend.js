/* Bridges.directory admin portal, connected to the real database (Supabase).
 *
 * Only runs when window.BRIDGES.enabled is true (open the page with ?backend=1; ?backend=0 turns it off).
 * With it off, admin.html is exactly Atharva's prototype.
 *
 * The agreed admin portal does THREE jobs and nothing else:
 *   1. approve or reject volunteer applications
 *   2. view volunteers and remove one
 *   3. view contributions
 * The prototype's other sections (members, faculty, reports, page text, roles, settings, export)
 * are not reachable when this is on. The database refuses every call that does not come from an admin
 * (public.admin_* functions check public.is_admin()), so hiding things here is only for looks.
 *
 * This file is self-contained: Atharva's page keeps all its code inside a closure, so we cannot reach it.
 * We take over #root, reuse the prototype's CSS classes, and never use #hash links (the prototype
 * listens for hashchange and would redraw over us).
 */
(function () {
  'use strict';
  var B = window.BRIDGES;
  if (!B || !B.enabled) return;
  if (!window.supabase || !window.supabase.createClient) { console.error('admin-backend: supabase library missing'); return; }

  var root = document.getElementById('root');
  var toasts = document.getElementById('toasts');
  var sb = window.supabase.createClient(B.supabaseUrl, B.publishableKey);

  /* ------------------------------------------------------------------ small helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ICONS = {
    layout: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
  };
  var ico = function (n, s) { s = s || 16; return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>'; };
  var initials = function (n) { return String(n || '?').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); };
  var ini = function (n, cls) { return '<span class="ini' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + esc(initials(n)) + '</span>'; };
  var fmtD = function (iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  var rel = function (iso) {
    if (!iso) return '—';
    var s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'Just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    var d = Math.floor(s / 86400);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    return fmtD(iso);
  };
  var inr = function (paise) { return '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  var phoneFmt = function (p) { var m = /^\+91([6-9]\d{4})(\d{5})$/.exec(p || ''); return m ? '+91 ' + m[1] + ' ' + m[2] : (p || '—'); };

  function toast(msg, o) {
    o = o || {};
    var k = o.k || 'pos';
    var el = document.createElement('div');
    el.className = 'toast ' + k;
    el.innerHTML = '<span class="ti">' + ico(k === 'pos' ? 'check' : 'alert', 15) + '</span><div>' + (o.t ? '<b>' + esc(o.t) + '</b>' : '') + '<p>' + esc(msg) + '</p></div><button class="ib" type="button" aria-label="Dismiss">' + ico('x', 15) + '</button>';
    if (!toasts) return;
    toasts.appendChild(el);
    while (toasts.children.length > 3) toasts.firstChild.remove();
    var off = function () { if (el.isConnected) el.remove(); };
    $('.ib', el).addEventListener('click', off);
    setTimeout(off, o.d || 4200);
  }

  function modal(html, label) {
    var m = document.createElement('div');
    m.className = 'md';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', label || 'Dialog');
    m.innerHTML = '<div class="md-in">' + html + '</div>';
    var prev = document.activeElement;
    var close = function () { m.remove(); document.removeEventListener('keydown', key, true); if (prev && prev.focus) prev.focus(); };
    var key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-mclose]')) close(); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(m);
    var f = $('.btn.primary,.btn.danger', m);
    if (f) f.focus();
    m.close = close;
    return m;
  }
  var mdHead = function (t, sub) { return '<div class="md-h"><div><h3>' + esc(t) + '</h3>' + (sub ? '<p class="help">' + esc(sub) + '</p>' : '') + '</div><button class="ib" type="button" data-mclose aria-label="Close">' + ico('x', 18) + '</button></div>'; };

  // confirm box that stays open (and shows the error) if the database says no
  function confirmBox(o, run) {
    var m = modal(mdHead(o.t, o.sub) + (o.body || '') + '<p class="help" id="cbErr" style="color:var(--neg-fg);min-height:1em" role="alert"></p>' +
      '<div class="md-f"><button class="btn ghost" type="button" data-mclose>Cancel</button><button class="btn ' + (o.danger ? 'danger' : 'primary') + '" type="button" data-ok>' + esc(o.ok || 'Confirm') + '</button></div>', o.t);
    var ok = $('[data-ok]', m);
    ok.addEventListener('click', function () {
      ok.disabled = true;
      $('#cbErr', m).textContent = '';
      Promise.resolve(run()).then(function () { m.close(); }).catch(function (e) {
        ok.disabled = false;
        $('#cbErr', m).textContent = friendly(e);
      });
    });
    return m;
  }

  var MESSAGES = {
    admins_only: 'This account is not an admin.',
    not_pending: 'Someone already decided on this one. The list has been refreshed.',
    not_a_volunteer: 'That person is not a volunteer any more. The list has been refreshed.',
    bad_decision: 'Something went wrong. Please try again.'
  };
  function friendly(e) {
    var m = (e && (e.message || e.error_description)) || String(e);
    for (var k in MESSAGES) if (m.indexOf(k) >= 0) return MESSAGES[k];
    if (/JWT|expired|not_signed_in|401/.test(m)) return 'Your sign-in expired. Please sign in again.';
    return 'Could not do that: ' + m;
  }
  var isAdminsOnly = function (e) { return e && /admins_only/.test(e.message || ''); };

  /* ------------------------------------------------------------------ state */
  var ST = {
    session: null, isAdmin: false, view: 'overview', tab: 'pending', cf: 'all', vq: '',
    insts: {}, apps: { pending: [], approved: [], rejected: [] }, vols: [], contribs: [], contribMore: false, loaded: false
  };
  var VIEWS = { overview: 'Overview', applications: 'Volunteer applications', volunteers: 'Volunteers', contributions: 'Contributions' };

  var instLabel = function (id) { return ST.insts[id] || (id ? String(id).toUpperCase() : 'Unknown'); };

  async function rpc(name, args) {
    var r = await sb.rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  /* ------------------------------------------------------------------ data */
  async function loadCore() {
    var res = await Promise.all([
      sb.from('institutes').select('id,short'),
      rpc('admin_list_applications', { p_status: 'pending' }),
      rpc('admin_list_volunteers'),
      loadContribs(true)
    ]);
    if (res[0].error) throw res[0].error;
    ST.insts = {};
    (res[0].data || []).forEach(function (i) { ST.insts[i.id] = i.short; });
    ST.apps.pending = res[1] || [];
    ST.vols = res[2] || [];
    ST.loaded = true;
  }
  async function loadContribs(reset) {
    var offset = reset ? 0 : ST.contribs.length;
    var rows = await rpc('admin_list_contributions', { p_limit: 200, p_offset: offset });
    ST.contribs = reset ? rows : ST.contribs.concat(rows);
    ST.contribMore = rows.length === 200;
  }
  async function loadApps(status) { ST.apps[status] = await rpc('admin_list_applications', { p_status: status }); }
  // after any change, reload everything the three views show
  async function refreshAll() {
    var res = await Promise.all([rpc('admin_list_applications', { p_status: 'pending' }), rpc('admin_list_volunteers'), loadContribs(true)]);
    ST.apps.pending = res[0] || [];
    ST.vols = res[1] || [];
    if (ST.tab !== 'pending') await loadApps(ST.tab);
  }

  /* ------------------------------------------------------------------ screens: gate and refusal */
  function showLoading() {
    root.innerHTML = '<div class="gate"><div class="gate-c"><div><span class="pill">Admin</span></div><p>Loading…</p></div></div>';
  }
  function showSignIn() {
    root.innerHTML = '<div class="gate"><div class="gate-c"><div><span class="pill">Admin</span></div><div style="display:grid;gap:10px"><h1>Bridges.directory admin</h1><p>For the Bridges team only. Sign in on the Bridges.directory site first, then you will come straight back here.</p></div>' +
      '<a class="btn primary" id="gSite" href="index.html#login">Sign in on Bridges.directory</a></div></div>';
    $('#gSite').addEventListener('click', function () { try { localStorage.setItem('bridges-after-login', 'admin.html'); } catch (e) { /* ignore */ } });
  }
  function showNotAdmin() {
    var who = ST.session && ST.session.user && ST.session.user.email ? ST.session.user.email : 'this account';
    root.innerHTML = '<div class="gate"><div class="gate-c"><div><span class="pill">Admin</span></div><div style="display:grid;gap:10px"><h1>You need an admin account</h1><p>' + esc(who) + ' is signed in, but it is not on the admin team. Ask the owner to add you, or sign in with a different account.</p></div>' +
      '<div style="display:grid;gap:8px"><a class="btn primary" href="index.html">Back to Bridges.directory</a><button class="btn ghost" type="button" id="gOut">Sign out</button></div></div></div>';
    $('#gOut').addEventListener('click', signOut);
  }

  /* ------------------------------------------------------------------ shell */
  var NAV = [
    ['overview', 'Overview', 'layout'],
    ['applications', 'Volunteer applications', 'inbox'],
    ['volunteers', 'Volunteers', 'users'],
    ['contributions', 'Contributions', 'wallet']
  ];
  var isDark = function () { return document.documentElement.dataset.theme === 'dark'; };
  function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('bridges-admin-theme', t); } catch (e) { /* ignore */ } }

  function buildShell() {
    root.innerHTML = '<div class="app"><aside class="side" id="side" aria-label="Admin menu"></aside><div class="scrim" id="scrim" hidden></div><div class="main"><header class="top"><button class="ib menu-b" type="button" id="menuB" aria-label="Open menu">' + ico('menu', 20) + '</button><h1 id="title"></h1><span class="sp"></span><a class="btn secondary sm" href="index.html" target="_blank" rel="noopener noreferrer">' + ico('ext', 14) + '<span>Open site</span></a></header><main class="view" id="view"></main></div></div>';
    $('#menuB').addEventListener('click', function () { document.body.classList.add('nav-open'); $('#scrim').hidden = false; });
    $('#scrim').addEventListener('click', closeNav);
    $('#view').addEventListener('click', onViewClick);
    $('#side').addEventListener('click', onSideClick);
  }
  function closeNav() { document.body.classList.remove('nav-open'); var s = $('#scrim'); if (s) s.hidden = true; }

  function renderSide() {
    var email = ST.session && ST.session.user ? ST.session.user.email : '';
    var pending = ST.apps.pending.length;
    $('#side').innerHTML = '<a class="brand" href="admin.html" data-view="overview"><span>Bridges<span class="tld">.directory</span></span><span class="pill">Admin</span></a>' +
      '<nav class="nav" aria-label="Main">' + NAV.map(function (n) {
        var c = n[0] === 'applications' ? pending : 0;
        return '<a href="admin.html" data-view="' + n[0] + '"' + (ST.view === n[0] ? ' aria-current="page"' : '') + '>' + ico(n[2], 17) + '<span>' + n[1] + '</span>' + (c ? '<span class="nb" aria-label="' + c + ' waiting">' + c + '</span>' : '') + '</a>';
      }).join('') + '</nav>' +
      '<div class="side-f" style="padding-bottom:52px"><div class="me">' + ini(email || 'A', 'team') + '<div style="min-width:0"><b class="ell">' + esc(email) + '</b><small>Admin</small></div><button class="ib" type="button" id="themeB" aria-label="Switch to ' + (isDark() ? 'light' : 'dark') + ' mode">' + ico(isDark() ? 'sun' : 'moon', 17) + '</button></div>' +
      '<div class="side-l"><button class="lnkb" type="button" id="outB" style="font-weight:400">Sign out</button></div></div>';
    $('#themeB').addEventListener('click', function () { setTheme(isDark() ? 'light' : 'dark'); renderSide(); });
    $('#outB').addEventListener('click', signOut);
  }

  function go(view, opts) {
    ST.view = view;
    if (!(opts && opts.noPush)) { try { history.pushState({ v: view }, '', location.pathname + '?view=' + view); } catch (e) { /* ignore */ } }
    render();
    window.scrollTo(0, 0);
  }
  function onSideClick(e) {
    var a = e.target.closest('[data-view]');
    if (!a) return;
    e.preventDefault();
    closeNav();
    go(a.dataset.view);
  }

  /* ------------------------------------------------------------------ views */
  var ph = function (t, p) { return '<div class="ph"><div><h2>' + esc(t) + '</h2>' + (p ? '<p>' + esc(p) + '</p>' : '') + '</div></div>'; };
  var tableCols = function (c, ct) { return '--cols:' + c + ';--cols-t:' + (ct || c) + ';--cols-m:minmax(0,1fr) auto'; };

  function render() {
    if (!$('.app')) buildShell();
    $('#title').textContent = VIEWS[ST.view] || 'Overview';
    document.title = (VIEWS[ST.view] || 'Overview') + ' · Bridges admin';
    renderSide();
    var v = $('#view');
    if (!ST.loaded) { v.innerHTML = '<div class="empty"><span>Loading…</span></div>'; return; }
    if (ST.view === 'applications') v.innerHTML = viewApplications();
    else if (ST.view === 'volunteers') v.innerHTML = viewVolunteers();
    else if (ST.view === 'contributions') v.innerHTML = viewContributions();
    else v.innerHTML = viewOverview();
  }

  function paidSum() { return ST.contribs.filter(function (c) { return c.status === 'paid'; }).reduce(function (a, c) { return a + Number(c.amount_paise); }, 0); }
  function paidCount() { return ST.contribs.filter(function (c) { return c.status === 'paid'; }).length; }

  function viewOverview() {
    var pend = ST.apps.pending;
    var tile = function (view, ic, label, n, d, hot) { return '<a class="card tile' + (hot ? ' hot' : '') + '" href="admin.html" data-view="' + view + '"><small>' + ico(ic, 14) + label + '</small><b>' + n + '</b><span class="d">' + d + '</span></a>'; };
    var oldest = pend.length ? pend[0].created_at : '';
    var recentC = ST.contribs.slice(0, 5);
    return ph('Welcome', 'Here is what needs the Bridges team right now.') +
      '<div class="tiles">' +
      tile('applications', 'inbox', 'Waiting for a decision', pend.length, oldest ? 'Oldest ' + rel(oldest).toLowerCase() : 'All caught up', pend.length) +
      tile('volunteers', 'users', 'Volunteers', ST.vols.length, 'Can review certificates') +
      tile('contributions', 'wallet', 'Raised', inr(paidSum()), paidCount() + ' paid contribution' + (paidCount() === 1 ? '' : 's')) +
      tile('contributions', 'wallet', 'Started, not paid', ST.contribs.filter(function (c) { return c.status === 'created'; }).length, 'Payment not completed') +
      '</div>' +
      '<div class="cols"><section class="card"><div class="card-h"><h3>Waiting for a decision</h3><a class="btn ghost sm" href="admin.html" data-view="applications">See all' + ico('right', 14) + '</a></div>' +
      (pend.length ? '<div class="tbl" style="' + tableCols('minmax(0,1.6fr) minmax(0,1fr) 110px') + '">' + pend.slice(0, 5).map(function (a) {
        return '<div class="tr"><div class="who">' + ini(a.name, 'stu') + '<span><b>' + esc(a.name) + '</b><small class="mo">' + esc(instLabel(a.institute_id)) + '</small></span></div><span class="hm ell">' + esc(instLabel(a.institute_id)) + '</span><span class="sub" style="text-align:right">' + rel(a.created_at) + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">' + ico('check', 20) + '<span>No applications are waiting.</span></div>') + '</section>' +
      '<section class="card"><div class="card-h"><h3>Recent contributions</h3><a class="btn ghost sm" href="admin.html" data-view="contributions">See all' + ico('right', 14) + '</a></div>' +
      (recentC.length ? '<div class="tbl" style="' + tableCols('minmax(0,1.4fr) minmax(0,1fr) 96px') + '">' + recentC.map(function (c) {
        return '<div class="tr"><b style="font-weight:500">' + esc(c.display_name) + '</b><span>' + inr(c.amount_paise) + ' ' + statusPill(c.status) + '</span><span class="sub" style="text-align:right">' + rel(c.paid_at || c.created_at) + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">' + ico('wallet', 20) + '<span>No contributions yet.</span></div>') + '</section></div>';
  }

  function viewApplications() {
    var tabs = [['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected']];
    var list = ST.apps[ST.tab] || [];
    var pend = ST.tab === 'pending';
    var cols = tableCols(pend ? 'minmax(0,2fr) minmax(0,1fr) minmax(0,1.2fr) 130px 90px 190px' : 'minmax(0,2fr) minmax(0,1fr) minmax(0,1.2fr) 130px 90px',
                         pend ? 'minmax(0,1fr) 130px 190px' : 'minmax(0,1fr) 130px');
    var head = '<div class="tr th"><span>Name</span><span class="ht">Institute</span><span class="ht">Branch and year</span><span>Phone</span><span class="ht">Applied</span>' + (pend ? '<span></span>' : '') + '</div>';
    var rows = list.map(function (a) {
      return '<div class="tr"><div class="who">' + ini(a.name, 'stu') + '<span><b>' + esc(a.name) + '</b><small class="mo">' + esc(instLabel(a.institute_id)) + ' · ' + esc(phoneFmt(a.phone)) + '</small></span></div>' +
        '<span class="hm ht ell">' + esc(instLabel(a.institute_id)) + '</span><span class="hm ht ell sub">' + esc(a.branch || '—') + (a.year ? ' · ' + esc(a.year) : '') + '</span>' +
        '<span class="hm" style="font-variant-numeric:tabular-nums">' + esc(phoneFmt(a.phone)) + '</span><span class="hm ht sub">' + rel(a.created_at) + '</span>' +
        (ST.tab === 'pending' ? '<span style="display:flex;gap:8px;justify-content:flex-end"><button class="btn secondary sm neg" type="button" data-reject="' + esc(a.application_id) + '" aria-label="Reject ' + esc(a.name) + '">' + ico('x', 14) + '<span class="hm">Reject</span></button><button class="btn primary sm" type="button" data-approve="' + esc(a.application_id) + '" aria-label="Approve ' + esc(a.name) + '">' + ico('check', 14) + '<span class="hm">Approve</span></button></span>' : '') + '</div>';
    }).join('');
    return ph('Volunteer applications', 'Current students who offered to check certificates. Approve only people you are happy to share certificate details with.') +
      '<section class="card"><div class="tools"><div class="seg" role="group" aria-label="Status">' + tabs.map(function (t) { return '<button type="button" data-tab="' + t[0] + '" aria-pressed="' + (ST.tab === t[0]) + '">' + t[1] + (t[0] === 'pending' && ST.apps.pending.length ? ' (' + ST.apps.pending.length + ')' : '') + '</button>'; }).join('') + '</div>' +
      '<span class="cnt">' + list.length + ' ' + (list.length === 1 ? 'application' : 'applications') + '</span></div>' +
      '<div class="tbl" id="appList" style="' + cols + '">' + (list.length ? head + rows : '<div class="empty">' + ico('inbox', 20) + '<span>' + (ST.tab === 'pending' ? 'No applications are waiting.' : 'Nothing here yet.') + '</span></div>') + '</div></section>';
  }

  function viewVolunteers() {
    var q = ST.vq.trim().toLowerCase();
    var list = ST.vols.filter(function (v) { return !q || (v.name + ' ' + v.phone + ' ' + instLabel(v.institute_id)).toLowerCase().indexOf(q) >= 0; });
    var cols = tableCols('minmax(0,2fr) minmax(0,1fr) 150px 110px 110px', 'minmax(0,1fr) 150px 110px');
    return ph('Volunteers', 'Students who check certificates. Removing someone takes away their access straight away, and they can apply again later.') +
      '<section class="card"><div class="tools"><label class="srch">' + ico('search', 15) + '<input class="input" id="vQ" type="search" placeholder="Name, phone or institute" aria-label="Search volunteers" value="' + esc(ST.vq) + '"></label><span class="cnt">' + list.length + ' of ' + ST.vols.length + '</span></div>' +
      '<div class="tbl" id="volList" style="' + cols + '">' + (list.length ? '<div class="tr th"><span>Name</span><span class="ht">Institute</span><span>Phone</span><span class="ht">Since</span><span></span></div>' + list.map(function (v) {
        return '<div class="tr"><div class="who">' + ini(v.name, 'stu') + '<span><b>' + esc(v.name) + '</b><small class="mo">' + esc(instLabel(v.institute_id)) + ' · ' + esc(phoneFmt(v.phone)) + '</small></span></div><span class="hm ht ell">' + esc(instLabel(v.institute_id)) + '</span><span class="hm" style="font-variant-numeric:tabular-nums">' + esc(phoneFmt(v.phone)) + '</span><span class="hm ht sub">' + fmtD(v.since) + '</span><span style="display:flex;justify-content:flex-end"><button class="btn secondary sm neg" type="button" data-remove="' + esc(v.user_id) + '">Remove</button></span></div>';
      }).join('') : '<div class="empty">' + ico('users', 20) + '<span>' + (ST.vols.length ? 'No volunteers match.' : 'There are no volunteers yet.') + '</span></div>') + '</div></section>';
  }

  var statusPill = function (s) { return s === 'paid' ? '<span class="pill pos dot">Paid</span>' : s === 'failed' ? '<span class="pill neg dot">Failed</span>' : '<span class="pill warn dot">Started</span>'; };

  function viewContributions() {
    var f = ST.cf;
    var list = ST.contribs.filter(function (c) { return f === 'all' || c.status === f; });
    var cols = tableCols('minmax(0,1.6fr) 130px 110px 150px 150px', 'minmax(0,1fr) 110px 110px');
    return ph('Contributions', 'Money members have given to keep Bridges.directory running. This is a view only: payments are recorded by the payment system, never by hand.') +
      '<div class="tiles">' +
      '<div class="card tile"><small>' + ico('wallet', 14) + 'Raised so far</small><b>' + inr(paidSum()) + '</b><span class="d">' + paidCount() + ' paid</span></div>' +
      '<div class="card tile"><small>' + ico('wallet', 14) + 'Started, not paid</small><b>' + ST.contribs.filter(function (c) { return c.status === 'created'; }).length + '</b><span class="d">Payment not completed</span></div></div>' +
      '<section class="card"><div class="tools"><div class="seg" role="group" aria-label="Status">' + [['all', 'All'], ['paid', 'Paid'], ['created', 'Started'], ['failed', 'Failed']].map(function (t) { return '<button type="button" data-cf="' + t[0] + '" aria-pressed="' + (f === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div><span class="cnt">' + list.length + ' shown</span></div>' +
      '<div class="tbl" style="' + cols + '">' + (list.length ? '<div class="tr th"><span>Name</span><span>Amount</span><span>Status</span><span class="ht">Started</span><span class="ht">Paid</span></div>' + list.map(function (c) {
        return '<div class="tr"><div class="who">' + ini(c.anonymous ? 'A' : c.display_name, '') + '<span><b>' + esc(c.display_name) + '</b><small class="mo">' + inr(c.amount_paise) + ' · ' + rel(c.paid_at || c.created_at) + '</small></span></div><span class="hm" style="font-variant-numeric:tabular-nums">' + inr(c.amount_paise) + '</span><span>' + statusPill(c.status) + '</span><span class="hm ht sub">' + fmtD(c.created_at) + '</span><span class="hm ht sub">' + (c.paid_at ? fmtD(c.paid_at) : '—') + '</span></div>';
      }).join('') : '<div class="empty">' + ico('wallet', 20) + '<span>No contributions match.</span></div>') + '</div>' +
      (ST.contribMore ? '<div style="padding:var(--sp-m);text-align:center"><button class="btn secondary" type="button" data-more>Load more</button></div>' : '') + '</section>';
  }

  /* ------------------------------------------------------------------ actions */
  function findApp(id) { return ST.apps.pending.filter(function (a) { return a.application_id === id; })[0]; }

  function onViewClick(e) {
    var t;
    if ((t = e.target.closest('[data-view]'))) { e.preventDefault(); go(t.dataset.view); return; }
    if ((t = e.target.closest('[data-tab]'))) { ST.tab = t.dataset.tab; (ST.tab === 'pending' ? Promise.resolve() : loadApps(ST.tab)).then(render, function (er) { fail(er); }); return; }
    if ((t = e.target.closest('[data-cf]'))) { ST.cf = t.dataset.cf; render(); return; }
    if ((t = e.target.closest('[data-more]'))) { t.disabled = true; loadContribs(false).then(render, function (er) { t.disabled = false; fail(er); }); return; }
    if ((t = e.target.closest('[data-approve]'))) { return decide(t.dataset.approve, 'approve'); }
    if ((t = e.target.closest('[data-reject]'))) { return decide(t.dataset.reject, 'reject'); }
    if ((t = e.target.closest('[data-remove]'))) { return removeVol(t.dataset.remove); }
  }
  // the search box re-renders the list as you type
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'vQ') {
      ST.vq = e.target.value;
      var pos = e.target.selectionStart;
      $('#view').innerHTML = viewVolunteers();
      var el = $('#vQ'); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } }
    }
  });

  function fail(e) {
    if (isAdminsOnly(e)) { ST.isAdmin = false; showNotAdmin(); return; }
    toast(friendly(e), { k: 'neg', t: 'Something went wrong' });
  }

  function decide(id, decision) {
    var a = findApp(id);
    if (!a) return;
    var approve = decision === 'approve';
    confirmBox({
      t: (approve ? 'Approve ' : 'Reject ') + a.name + (approve ? ' as a volunteer?' : '\'s application?'),
      sub: approve ? 'They will be able to open and review other people\'s certificates. Their number (' + phoneFmt(a.phone) + ') will be shared with coordinators and the volunteer WhatsApp group.' : 'They will not become a volunteer. They can apply again later.',
      ok: approve ? 'Approve' : 'Reject', danger: !approve
    }, function () {
      return rpc('admin_review_application', { p_application: id, p_decision: decision }).then(function () {
        return refreshAll();
      }, function (e) {
        if (/not_pending/.test(e.message || '')) return refreshAll().then(function () { render(); throw e; });
        throw e;
      }).then(function () {
        render();
        toast(a.name + (approve ? ' is now a volunteer.' : '\'s application was rejected.'), { t: approve ? 'Approved' : 'Rejected' });
      });
    });
  }

  function removeVol(userId) {
    var v = ST.vols.filter(function (x) { return x.user_id === userId; })[0];
    if (!v) return;
    confirmBox({
      t: 'Remove ' + v.name + ' as a volunteer?',
      sub: 'They lose access to certificates straight away and their number is removed from our records. They can apply again later. Remember to take them out of the volunteer WhatsApp group.',
      ok: 'Remove', danger: true
    }, function () {
      return rpc('admin_remove_volunteer', { p_user: userId }).then(function () { return refreshAll(); }, function (e) {
        if (/not_a_volunteer/.test(e.message || '')) return refreshAll().then(function () { render(); throw e; });
        throw e;
      }).then(function () { render(); toast(v.name + ' is no longer a volunteer.', { t: 'Removed' }); });
    });
  }

  async function signOut() {
    try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
    ST.session = null; ST.isAdmin = false; ST.loaded = false;
    showSignIn();
  }

  /* ------------------------------------------------------------------ start */
  var booting = false;
  async function boot() {
    if (booting) return;
    booting = true;
    try {
      showLoading();
      var s = await sb.auth.getSession();
      ST.session = s.data && s.data.session;
      if (!ST.session) { showSignIn(); return; }
      var ok = false;
      try { ok = await rpc('is_admin'); } catch (e) { ok = false; }
      ST.isAdmin = ok === true;
      if (!ST.isAdmin) { showNotAdmin(); return; }
      var m = /[?&]view=(\w+)/.exec(location.search);
      ST.view = m && VIEWS[m[1]] ? m[1] : 'overview';
      buildShell();
      render();
      try { await loadCore(); } catch (e) { if (isAdminsOnly(e)) { ST.isAdmin = false; showNotAdmin(); return; } toast(friendly(e), { k: 'neg', t: 'Could not load' }); }
      render();
    } finally { booting = false; }
  }

  window.addEventListener('popstate', function () {
    if (!ST.isAdmin) return;
    var m = /[?&]view=(\w+)/.exec(location.search);
    ST.view = m && VIEWS[m[1]] ? m[1] : 'overview';
    render();
  });
  // Atharva's page redraws itself on any #hash change; if that ever happens, put our screen back.
  window.addEventListener('hashchange', function () { setTimeout(function () { if (ST.isAdmin && !$('#view')) { buildShell(); render(); } else if (!ST.session) { showSignIn(); } }, 0); });
  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') { ST.session = null; ST.isAdmin = false; ST.loaded = false; showSignIn(); }
    else if (event === 'SIGNED_IN' && !ST.isAdmin) { setTimeout(boot, 0); }
  });

  showLoading();   // replace the prototype's screen straight away
  boot();
})();
