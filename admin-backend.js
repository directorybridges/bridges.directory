/* Bridges.directory admin portal, connected to the real database (Supabase).
 *
 * Only runs when window.BRIDGES.enabled is true. With it off, admin.html is exactly Atharva's prototype.
 *
 * This file is the core: sign-in gate, menu, roles, overview and the three volunteer/money screens.
 * The other screens live in their own files and plug in through window.BAdmin.register():
 *   admin-people.js      Members, Faculty accounts
 *   admin-moderation.js  Verification, Reports, Activity log
 *   admin-site.js        Page text, Roles and permissions, Settings
 * Every call goes to a public.admin_* function. The database checks who is asking and what their role allows,
 * so hiding buttons here is only for looks: nothing here can do more than the database allows.
 *
 * Atharva's page keeps all its code inside a closure, so we cannot reach it. We take over #root, reuse the
 * prototype's CSS classes, and never use #hash links (the prototype listens for hashchange and redraws).
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
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    key: '<path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    shieldok: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    uplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    cap: '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'
  };
  var ico = function (n, s) { s = s || 16; return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>'; };
  var initials = function (n) { return String(n || '?').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); };
  var ini = function (n, cls) { return '<span class="ini' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + esc(initials(n)) + '</span>'; };
  var fmtD = function (iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'; };
  var fmtDT = function (iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };
  var rel = function (iso) {
    if (!iso) return 'Never';
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
  var validEmail = function (e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e || '').trim()); };

  function toast(msg, o) {
    o = o || {};
    var k = o.k || 'pos';
    var el = document.createElement('div');
    el.className = 'toast ' + k;
    el.innerHTML = '<span class="ti">' + ico(o.i || (k === 'pos' ? 'check' : k === 'info' ? 'info' : 'alert'), 15) + '</span><div>' + (o.t ? '<b>' + esc(o.t) + '</b>' : '') + '<p>' + esc(msg) + '</p></div><button class="ib" type="button" aria-label="Dismiss">' + ico('x', 15) + '</button>';
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
    var f = $('input:not([type=checkbox]),select,textarea', m) || $('.btn.primary,.btn.danger', m);
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
      var out;
      try { out = run(m); } catch (e) { out = Promise.reject(e); }
      Promise.resolve(out).then(function (res) { if (res !== false) m.close(); else ok.disabled = false; }).catch(function (e) {
        ok.disabled = false;
        var er = $('#cbErr', m);
        if (er) er.textContent = friendly(e);
      });
    });
    return m;
  }

  // side panel (members, faculty)
  var dwPrev = null;
  function drawer(title, body, foot) {
    closeDrawer(true);
    var d = document.createElement('div');
    d.className = 'dw'; d.id = 'dw';
    d.innerHTML = '<div class="dw-s" data-dwclose></div><div class="dw-p" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="dw-h"><h3>' + esc(title) + '</h3><button class="ib" type="button" data-dwclose aria-label="Close">' + ico('x', 18) + '</button></div><div class="dw-b">' + body + '</div>' + (foot ? '<div class="dw-f">' + foot + '</div>' : '') + '</div>';
    dwPrev = document.activeElement;
    document.body.appendChild(d);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('on'); }); });
    d.addEventListener('click', function (e) { if (e.target.closest('[data-dwclose]')) closeDrawer(); });
    setTimeout(function () { var f = $('.dw-b input:not([disabled]),.dw-b select:not([disabled])', d) || $('[data-dwclose].ib', d); if (f) f.focus({ preventScroll: true }); }, 60);
    return d;
  }
  function closeDrawer(now) {
    var d = $('#dw');
    if (!d) return;
    document.body.style.overflow = '';
    if (now) { d.remove(); return; }
    d.classList.remove('on');
    setTimeout(function () { d.remove(); }, 300);
    if (dwPrev && dwPrev.isConnected) dwPrev.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('#dw') && !$('.md')) closeDrawer();
    if (e.key === 'Escape') document.body.classList.remove('nav-open');
  });

  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Saved as ' + name + '.', { t: 'Download started', k: 'info', i: 'download' });
  }
  var csv = function (rows) {
    return rows.map(function (r) {
      return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\n');
  };
  var copy = function (text, what) {
    var ok = function () { toast(what + ' copied.', { t: 'Copied', k: 'info', i: 'copy' }); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, ok); else ok();
  };

  /* ------------------------------------------------------------------ errors */
  var MESSAGES = {
    admins_only: 'This account is not an admin.',
    no_permission: 'Your role is not allowed to do this.',
    not_pending: 'Someone already decided on this one. The list has been refreshed.',
    not_a_volunteer: 'That person is not a volunteer any more. The list has been refreshed.',
    not_open: 'Someone already closed this report. The list has been refreshed.',
    not_found: 'That record is gone. The list has been refreshed.',
    bad_decision: 'Something went wrong. Please try again.',
    bad_year: 'The year must be between 1970 and 2032.',
    bad_links: 'Links: up to 4, and each must look like a web address, for example yourname.com/work.',
    bad_campus: 'That campus does not belong to the institute.',
    bad_limit: 'That is not an allowed number.',
    bad_email: 'That email address does not look right.',
    bad_kind: 'The type must be student or alum.',
    bad_institute: 'Pick an institute from the list.',
    bad_branch: 'The branch is too long.',
    bad_experience: 'The experience list is not valid.',
    bad_status: 'That status is not allowed.',
    bad_role: 'That role cannot be given this way.',
    bad_perm: 'That permission does not exist.',
    bad_approvals: 'Approvals must be 1, 2 or 3.',
    bad_goal: 'That goal is not allowed.',
    bad_html: 'The page body can only use h3, p, ul, li, b and a (with an https link). Remove anything else.',
    bad_page: 'That page cannot be edited.',
    bad_field: 'That field cannot be edited.',
    too_long: 'That text is too long.',
    name_required: 'Add their name first.',
    reason_required: 'Please give a reason.',
    email_domain_mismatch: 'That institute email does not end with the institute\'s email domain.',
    email_taken: 'This email is already on another account.',
    no_volunteer_application: 'They need an approved volunteer application first. Approve one under Volunteer applications.',
    owner_locked: 'The owner cannot be changed or removed.',
    already_on_team: 'They are already on the team.',
    not_yourself: 'You cannot do this to your own account.',
    file_deleted: 'The certificate file has already been deleted.', upload_failed: 'The file could not be opened. Check the connection and try again.',
    no_free_id: 'No free faculty ID is left. Please tell the developer.',
    signups_paused: 'Sign-ups are paused.',
    account_blocked: 'This account is blocked.',
    codes_off: 'Email codes are switched off for this institute.'
  };
  function friendly(e) {
    var m = (e && (e.message || e.error_description)) || String(e);
    for (var k in MESSAGES) if (m.indexOf(k) >= 0) return MESSAGES[k];
    if (/JWT|expired|not_signed_in|401/.test(m)) return 'Your sign-in expired. Please sign in again.';
    return 'Could not do that: ' + m;
  }
  var isAdminsOnly = function (e) { return e && /admins_only/.test(e.message || ''); };
  function fail(e) {
    if (isAdminsOnly(e)) { ST.isAdmin = false; showNotAdmin(); return; }
    toast(friendly(e), { k: 'neg', t: 'Something went wrong' });
  }

  /* ------------------------------------------------------------------ state, roles */
  var ROLES = ['Owner', 'Admin', 'Moderator', 'Support'];
  var PERMS = [
    ['logs', 'View the activity log'], ['edit', 'Edit member profiles'], ['suspend', 'Hide or suspend members'], ['delete', 'Delete profiles'],
    ['verify', 'Approve or reject verification'], ['reports', 'Handle reports'], ['faculty', 'Manage faculty accounts'], ['content', 'Edit page text'],
    ['export', 'Export data'], ['settings', 'Change settings'], ['team', 'Manage the team and roles']
  ];
  var ROLE_DESC = { Owner: 'Everything. Cannot be changed.', Admin: 'Runs the site day to day.', Moderator: 'Verification, reports and hiding listings.', Support: 'Helps members and faculty with accounts.' };

  var ST = {
    session: null, isAdmin: false, view: 'overview', arg: '', tab: 'pending', cf: 'all', vq: '',
    role: 'Support', as: 'Support', matrix: {}, counts: { apps: 0, verify: 0, reports: 0 }, ov: null,
    insts: {}, instRows: [], apps: { pending: [], approved: [], rejected: [] }, vols: [], contribs: [], contribMore: false, loaded: false,
    mq: '', lq: '', content: {}
  };
  var can = function (p) { return ST.as === 'Owner' || !!(ST.matrix[ST.as] && ST.matrix[ST.as][p]); };
  var lock = function (p) { return can(p) ? '' : ' disabled title="Your role cannot do this"'; };
  var instLabel = function (id) { return ST.insts[id] || (id ? String(id).toUpperCase() : 'Unknown'); };
  var GROUPS = [['nift', 'NIFT'], ['nid', 'NID'], ['iit', 'IIT']];

  async function rpc(name, args) {
    var r = await sb.rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  /* ------------------------------------------------------------------ the plug-in table for the other screens */
  var VIEWS = {};   // name -> { title, needs, render(arg) }
  var A = {
    sb: sb, rpc: rpc, $: $, $$: $$, esc: esc, ico: ico, ini: ini, rel: rel, fmtD: fmtD, fmtDT: fmtDT, inr: inr, validEmail: validEmail,
    toast: toast, modal: modal, mdHead: mdHead, confirmBox: confirmBox, drawer: drawer, closeDrawer: closeDrawer,
    download: download, csv: csv, copy: copy, friendly: friendly, fail: fail, ST: ST, can: can, lock: lock, instLabel: instLabel,
    ROLES: ROLES, PERMS: PERMS, ROLE_DESC: ROLE_DESC, GROUPS: GROUPS,
    ph: function (t, p, acts) { return '<div class="ph"><div><h2>' + esc(t) + '</h2>' + (p ? '<p>' + esc(p) + '</p>' : '') + '</div>' + (acts ? '<div class="acts">' + acts + '</div>' : '') + '</div>'; },
    view: function () { return $('#view'); },
    go: go, rerender: function () { render(); }, refreshCounts: refreshCounts, renderSide: function () { renderSide(); },
    register: function (name, def) { VIEWS[name] = def; }
  };
  window.BAdmin = A;

  /* ------------------------------------------------------------------ data */
  async function loadCore() {
    var res = await Promise.all([
      sb.from('institutes').select('id,short,name,grp,email_domain,campuses,branches,codes_enabled').order('short'),
      rpc('admin_list_applications', { p_status: 'pending' }),
      rpc('admin_list_volunteers'),
      loadContribs(true),
      rpc('admin_overview'),
      rpc('admin_get_perms'),
      rpc('get_content')
    ]);
    if (res[0].error) throw res[0].error;
    ST.insts = {}; ST.instRows = res[0].data || [];
    ST.instRows.forEach(function (i) { ST.insts[i.id] = i.short; });
    ST.apps.pending = res[1] || [];
    ST.vols = res[2] || [];
    ST.ov = res[4];
    ST.matrix = {};
    (res[5] || []).forEach(function (r) { (ST.matrix[r.role] = ST.matrix[r.role] || {})[r.perm] = r.allowed; });
    ST.counts = { apps: ST.apps.pending.length, verify: Number(ST.ov.verify_pending) || 0, reports: Number(ST.ov.reports_open) || 0 };
    setContent(res[6]);
    ST.loaded = true;
  }
  // published page text: ST.content[page][field] = text. Anything not in there shows the default from admin-data.js.
  function setContent(rows) {
    ST.content = {};
    (rows || []).forEach(function (r) { (ST.content[r.page_id] = ST.content[r.page_id] || {})[r.field_key] = r.value; });
  }
  function pageDefault(page, key) {
    var d = window.BADMIN_DATA, p = d && d.PAGES.filter(function (x) { return x.id === page; })[0];
    var f = p && p.f.filter(function (x) { return x[0] === key; })[0];
    return f ? f[2] : '';
  }
  A.setContent = setContent;
  A.pageDefault = pageDefault;
  A.pageText = function (page, key) { var v = ST.content && ST.content[page] && ST.content[page][key]; return v != null ? v : pageDefault(page, key); };
  async function loadContribs(reset) {
    var offset = reset ? 0 : ST.contribs.length;
    var rows = await rpc('admin_list_contributions', { p_limit: 200, p_offset: offset });
    ST.contribs = reset ? rows : ST.contribs.concat(rows);
    ST.contribMore = rows.length === 200;
  }
  async function loadApps(status) { ST.apps[status] = await rpc('admin_list_applications', { p_status: status }); }
  async function refreshCounts() {
    try {
      var r = await Promise.all([rpc('admin_overview'), rpc('admin_list_applications', { p_status: 'pending' })]);
      ST.ov = r[0]; ST.apps.pending = r[1] || [];
      ST.counts = { apps: ST.apps.pending.length, verify: Number(ST.ov.verify_pending) || 0, reports: Number(ST.ov.reports_open) || 0 };
      renderSide();
    } catch (e) { /* the menu numbers just stay as they were */ }
  }
  // after any volunteer change, reload what those views show
  async function refreshAll() {
    var res = await Promise.all([rpc('admin_list_applications', { p_status: 'pending' }), rpc('admin_list_volunteers'), loadContribs(true), rpc('admin_overview')]);
    ST.apps.pending = res[0] || [];
    ST.vols = res[1] || [];
    ST.ov = res[3];
    ST.counts.apps = ST.apps.pending.length;
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
  // [heading, [[view, label, icon, count(), permission]]]
  var NAV = [
    [null, [['overview', 'Overview', 'layout']]],
    ['People', [['members', 'Members', 'users'], ['invites', 'Invites', 'mail', null, 'verify'], ['faculty', 'Faculty accounts', 'key', null, 'faculty'],
                ['applications', 'Volunteer applications', 'inbox', function () { return ST.counts.apps; }], ['volunteers', 'Volunteers', 'users']]],
    ['Moderation', [['verify', 'Verification', 'shieldok', function () { return ST.counts.verify; }, 'verify'],
                    ['reports', 'Reports', 'flag', function () { return ST.counts.reports; }, 'reports'], ['logs', 'Activity log', 'activity', null, 'logs']]],
    ['Money', [['contributions', 'Contributions', 'wallet']]],
    ['Site', [['content', 'Page text', 'type', null, 'content'], ['roles', 'Roles and permissions', 'lock'], ['settings', 'Settings', 'sliders', null, 'settings']]]
  ];
  var TITLES = { overview: 'Overview', members: 'Members', invites: 'Invites', faculty: 'Faculty accounts', applications: 'Volunteer applications', volunteers: 'Volunteers',
                 verify: 'Verification', reports: 'Reports', logs: 'Activity log', contributions: 'Contributions', content: 'Page text', roles: 'Roles and permissions', settings: 'Settings' };
  var NEEDS = { invites: 'verify', faculty: 'faculty', verify: 'verify', reports: 'reports', logs: 'logs', content: 'content', settings: 'settings' };
  var isDark = function () { return document.documentElement.dataset.theme === 'dark'; };
  function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('bridges-admin-theme', t); } catch (e) { /* ignore */ } }

  function buildShell() {
    root.innerHTML = '<div class="app"><aside class="side" id="side" aria-label="Admin menu"></aside><div class="scrim" id="scrim" hidden></div><div class="main"><header class="top"><button class="ib menu-b" type="button" id="menuB" aria-label="Open menu">' + ico('menu', 20) + '</button><h1 id="title"></h1><span class="sp"></span>' +
      '<label class="qs"><span class="sr" hidden>Search members</span>' + ico('search', 15) + '<input class="input" id="qs" type="search" placeholder="Search members" aria-label="Search members"></label>' +
      '<a class="btn secondary sm" href="index.html" target="_blank" rel="noopener noreferrer">' + ico('ext', 14) + '<span>Open site</span></a></header><div id="asbar"></div><main class="view" id="view"></main></div></div>';
    $('#menuB').addEventListener('click', function () { document.body.classList.add('nav-open'); $('#scrim').hidden = false; });
    $('#scrim').addEventListener('click', closeNav);
    $('#view').addEventListener('click', onViewClick);
    $('#side').addEventListener('click', onSideClick);
    $('#qs').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { ST.mq = e.target.value.trim(); e.target.value = ''; ST.arg = ''; if (ST.view === 'members') render(); else go('members'); }
    });
  }
  function closeNav() { document.body.classList.remove('nav-open'); var s = $('#scrim'); if (s) s.hidden = true; }

  function renderSide() {
    if (!$('#side')) return;
    var email = ST.session && ST.session.user ? ST.session.user.email : '';
    var name = (ST.ov && ST.ov.me_name) || email;
    $('#side').innerHTML = '<a class="brand" href="admin.html" data-view="overview"><span>Bridges<span class="tld">.directory</span></span><span class="pill">Admin</span></a>' +
      NAV.map(function (g) {
        var items = g[1].filter(function (it) { return !it[4] || can(it[4]); });
        if (!items.length) return '';
        return '<nav class="nav" aria-label="' + (g[0] || 'Main') + '">' + (g[0] ? '<div class="nav-h">' + g[0] + '</div>' : '') + items.map(function (it) {
          var c = it[3] ? it[3]() : 0;
          return '<a href="admin.html" data-view="' + it[0] + '"' + (ST.view === it[0] ? ' aria-current="page"' : '') + '>' + ico(it[2], 17) + '<span>' + it[1] + '</span>' + (c ? '<span class="nb" aria-label="' + c + ' waiting">' + c + '</span>' : '') + '</a>';
        }).join('') + '</nav>';
      }).join('') +
      '<div class="side-f" style="padding-bottom:52px"><div class="me">' + ini(name || 'A', 'team') + '<div style="min-width:0"><b class="ell">' + esc(email) + '</b><small>' + esc(ST.role) + '</small></div><button class="ib" type="button" id="themeB" aria-label="Switch to ' + (isDark() ? 'light' : 'dark') + ' mode">' + ico(isDark() ? 'sun' : 'moon', 17) + '</button></div>' +
      (ST.role === 'Owner' ? '<label class="asr"><span class="label">Preview the admin as</span><select class="input" id="asSel">' + ROLES.map(function (r) { return '<option' + (r === ST.as ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label>' : '') +
      '<div class="side-l"><button class="lnkb" type="button" id="outB" style="font-weight:400">Sign out</button></div></div>';
    $('#themeB').addEventListener('click', function () { setTheme(isDark() ? 'light' : 'dark'); renderSide(); });
    $('#outB').addEventListener('click', signOut);
    var sel = $('#asSel');
    if (sel) sel.addEventListener('change', function (e) {
      ST.as = e.target.value;
      if (NEEDS[ST.view] && !can(NEEDS[ST.view])) go('overview'); else render();
      toast(ST.as === 'Owner' ? 'You are back to your own view.' : 'You are seeing what a ' + ST.as + ' can do. Nothing changes for them.', { t: 'Previewing as ' + ST.as, k: 'info', i: 'eye' });
    });
  }

  function go(view, opts) {
    opts = opts || {};
    closeDrawer(true);
    ST.view = view; ST.arg = opts.arg || '';
    if (!opts.noPush) { try { history.pushState({ v: view }, '', location.pathname + '?view=' + view + (ST.arg ? '&id=' + encodeURIComponent(ST.arg) : '')); } catch (e) { /* ignore */ } }
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
  var ph = A.ph;
  var tableCols = function (c, ct) { return '--cols:' + c + ';--cols-t:' + (ct || c) + ';--cols-m:minmax(0,1fr) auto'; };
  A.tableCols = tableCols;

  function render() {
    if (!$('.app')) buildShell();
    if (NEEDS[ST.view] && ST.loaded && !can(NEEDS[ST.view])) { ST.view = 'overview'; }
    $('#title').textContent = TITLES[ST.view] || 'Overview';
    document.title = (TITLES[ST.view] || 'Overview') + ' · Bridges admin';
    $('#asbar').innerHTML = ST.as !== ST.role ? '<div class="asbar">' + ico('eye', 15) + '<span>Previewing as ' + esc(ST.as) + '. Actions this role cannot take are turned off.</span><button class="lnkb" type="button" id="asOff">Back to ' + esc(ST.role) + '</button></div>' : '';
    if ($('#asOff')) $('#asOff').addEventListener('click', function () { ST.as = ST.role; render(); });
    renderSide();
    var v = $('#view');
    if (!ST.loaded) { v.innerHTML = '<div class="empty"><span>Loading…</span></div>'; return; }
    if (VIEWS[ST.view]) { VIEWS[ST.view].render(ST.arg); return; }
    if (ST.view === 'applications') v.innerHTML = viewApplications();
    else if (ST.view === 'volunteers') v.innerHTML = viewVolunteers();
    else if (ST.view === 'contributions') v.innerHTML = viewContributions();
    else v.innerHTML = viewOverview();
  }

  function paidSum() { return ST.contribs.filter(function (c) { return c.status === 'paid'; }).reduce(function (a, c) { return a + Number(c.amount_paise); }, 0); }
  function paidCount() { return ST.contribs.filter(function (c) { return c.status === 'paid'; }).length; }
  var logCls = function (r) { return r === 'Student' ? 'stu' : r === 'Alum' ? 'alum' : r === 'Faculty' ? 'fac' : ROLES.indexOf(r) >= 0 ? 'team' : ''; };
  A.logCls = logCls;
  var kindPill = function (k) { return k === 'student' ? '<span class="pill stu">Student</span>' : k === 'alum' ? '<span class="pill alum">Alum</span>' : '<span class="pill fac">Faculty</span>'; };
  A.kindPill = kindPill;

  function viewOverview() {
    var o = ST.ov || {}, now = new Date().getHours();
    var tile = function (view, ic, label, n, d, hot) { return '<a class="card tile' + (hot ? ' hot' : '') + '" href="admin.html" data-view="' + view + '"><small>' + ico(ic, 14) + label + '</small><b>' + n + '</b><span class="d">' + d + '</span></a>'; };
    var attn = [];
    if (Number(o.verify_old_count)) attn.push(['verify', 'clock', o.verify_old_count + ' verification request' + (o.verify_old_count === 1 ? ' has' : 's have') + ' waited over 2 days', 'Oldest: ' + rel(o.verify_oldest)]);
    if (Number(o.reports_open)) attn.push(['reports', 'flag', o.reports_open + ' open report' + (o.reports_open === 1 ? '' : 's'), 'Newest: ' + rel(o.reports_newest)]);
    if (Number(o.vol_pending)) attn.push(['applications', 'inbox', o.vol_pending + ' volunteer application' + (o.vol_pending === 1 ? '' : 's') + ' waiting', 'Approve only people you trust with certificates']);
    if (Number(o.faculty_failed)) attn.push(['logs', 'alert', o.faculty_failed + ' failed faculty sign-in' + (o.faculty_failed === 1 ? '' : 's') + ' in 3 days', 'Check the activity log']);
    var never = o.faculty_never || [];
    if (never.length) attn.push(['faculty', 'key', never.length + ' faculty account' + (never.length === 1 ? ' has not' : 's have not') + ' signed in yet', never.join(', ')]);
    if (Number(o.suspended)) attn.push(['members', 'ban', o.suspended + ' suspended member' + (o.suspended === 1 ? '' : 's'), 'Review when the reason no longer applies']);
    var byG = GROUPS.map(function (g) {
      var r = (o.by_group || []).filter(function (x) { return x.grp === g[0]; })[0] || { students: 0, alums: 0 };
      return [g[1], r.students, r.alums, Number(r.students) + Number(r.alums)];
    });
    var recent = o.recent || [];
    return ph('Good ' + (now < 12 ? 'morning' : now < 17 ? 'afternoon' : 'evening'), 'Here is what is happening on Bridges.directory.') +
      '<div class="tiles">' +
      tile('members', 'users', 'Members', o.members || 0, '+' + (o.new_week || 0) + ' this week') +
      tile('members', 'cap', 'Students · Alumni', (o.students || 0) + ' · ' + (o.alums || 0), 'Listed and verified') +
      tile('faculty', 'key', 'Faculty accounts', o.faculty || 0, 'Not in the directory') +
      tile('verify', 'shieldok', 'Waiting for verification', o.verify_pending || 0, Number(o.verify_pending) ? 'Oldest ' + rel(o.verify_oldest).toLowerCase() : 'All caught up', Number(o.verify_old_count)) +
      tile('reports', 'flag', 'Open reports', o.reports_open || 0, Number(o.reports_open) ? 'Reply within 3 days' : 'Nothing open', Number(o.reports_open)) +
      tile('logs', 'activity', 'Sign-ins', o.signins_week || 0, 'Last 7 days') +
      tile('logs', 'mail', 'Contacts opened', o.contacts_week || 0, 'Last 7 days') +
      tile('applications', 'inbox', 'Volunteer applications', o.vol_pending || 0, Number(o.vol_pending) ? 'Waiting for a decision' : 'All caught up', Number(o.vol_pending)) +
      tile('volunteers', 'users', 'Volunteers', ST.vols.length, 'Can review certificates') +
      tile('contributions', 'wallet', 'Raised', inr(paidSum()), paidCount() + ' paid contribution' + (paidCount() === 1 ? '' : 's')) +
      tile('settings', 'sliders', 'Contacts per week', o.limit || 5, 'Per member, by default') +
      '</div>' +
      '<div class="cols"><section class="card"><div class="card-h"><h3>Recent activity</h3>' + (can('logs') ? '<a class="btn ghost sm" href="admin.html" data-view="logs">See all' + ico('right', 14) + '</a>' : '') + '</div>' +
      (recent.length ? '<div class="tbl" style="' + tableCols('minmax(0,1.3fr) minmax(0,1.6fr) 96px') + '">' + recent.map(function (l) {
        return '<div class="tr"><div class="who">' + ini(l.who, logCls(l.role)) + '<span><b>' + esc(l.who) + '</b><small class="ro">' + esc(l.role) + '</small><small class="mo">' + esc(l.act + (l.target ? ': ' + l.target : '')) + '</small></span></div><div class="hm" style="min-width:0"><span class="lt ' + esc(l.type) + (l.sev ? ' ' + esc(l.sev) : '') + '"><i></i>' + esc(l.act) + '</span>' + (l.target ? '<small class="sub ell" style="display:block">' + esc(l.target) + '</small>' : '') + '</div><span class="sub" style="text-align:right">' + rel(l.at) + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">' + ico('activity', 20) + '<span>' + (can('logs') ? 'Nothing has happened yet.' : 'Your role cannot see the activity log.') + '</span></div>') + '</section>' +
      '<div style="display:grid;gap:var(--sp-l)"><section class="card"><div class="card-h"><h3>Needs attention</h3></div>' +
      (attn.length ? '<div class="tbl" style="--cols:28px minmax(0,1fr) 16px;--cols-m:28px minmax(0,1fr) 16px">' + attn.map(function (a) {
        return '<a class="tr" href="admin.html" data-view="' + a[0] + '" style="text-decoration:none"><span class="ini" style="width:28px;height:28px">' + ico(a[1], 14) + '</span><span style="min-width:0"><b style="font-weight:500;display:block">' + esc(a[2]) + '</b><small class="sub ell" style="display:block">' + esc(a[3]) + '</small></span><span class="chev">' + ico('right', 14) + '</span></a>';
      }).join('') + '</div>' : '<div class="empty">' + ico('check', 20) + '<span>Nothing needs you right now.</span></div>') +
      '</section><section class="card"><div class="card-h"><h3>By institute</h3></div><div class="tbl" style="--cols:minmax(0,1fr) 70px 70px 60px;--cols-m:minmax(0,1fr) 60px 60px 50px"><div class="tr th"><span>Institute</span><span>Students</span><span>Alumni</span><span>Total</span></div>' +
      byG.map(function (g) { return '<div class="tr"><b style="font-weight:500">' + g[0] + 's</b><span>' + g[1] + '</span><span>' + g[2] + '</span><b style="font-weight:600">' + g[3] + '</b></div>'; }).join('') + '</div></section></div></div>';
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

  /* ------------------------------------------------------------------ actions (volunteer screens) */
  function findApp(id) { return ST.apps.pending.filter(function (a) { return a.application_id === id; })[0]; }

  function onViewClick(e) {
    var t;
    if ((t = e.target.closest('[data-view]'))) { e.preventDefault(); go(t.dataset.view, { arg: t.dataset.arg }); return; }
    if (VIEWS[ST.view]) return;   // the plug-in screens handle their own buttons
    if ((t = e.target.closest('[data-tab]'))) { ST.tab = t.dataset.tab; (ST.tab === 'pending' ? Promise.resolve() : loadApps(ST.tab)).then(render, function (er) { fail(er); }); return; }
    if ((t = e.target.closest('[data-cf]'))) { ST.cf = t.dataset.cf; render(); return; }
    if ((t = e.target.closest('[data-more]'))) { t.disabled = true; loadContribs(false).then(render, function (er) { t.disabled = false; fail(er); }); return; }
    if ((t = e.target.closest('[data-approve]'))) { return decide(t.dataset.approve, 'approve'); }
    if ((t = e.target.closest('[data-reject]'))) { return decide(t.dataset.reject, 'reject'); }
    if ((t = e.target.closest('[data-remove]'))) { return removeVol(t.dataset.remove); }
  }
  // the volunteer search box re-renders the list as you type
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'vQ') {
      ST.vq = e.target.value;
      var pos = e.target.selectionStart;
      $('#view').innerHTML = viewVolunteers();
      var el = $('#vQ'); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } }
    }
  });

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
    try { await rpc('log_signout'); } catch (e) { /* ignore */ }
    try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
    ST.session = null; ST.isAdmin = false; ST.loaded = false;
    showSignIn();
  }

  /* ------------------------------------------------------------------ start */
  function readUrl() {
    var v = /[?&]view=(\w+)/.exec(location.search), id = /[?&]id=([^&]+)/.exec(location.search);
    ST.view = v && TITLES[v[1]] ? v[1] : 'overview';
    ST.arg = id ? decodeURIComponent(id[1]) : '';
  }
  var booting = false;
  async function boot() {
    if (booting) return;
    booting = true;
    try {
      showLoading();
      var s = await sb.auth.getSession();
      ST.session = s.data && s.data.session;
      if (!ST.session) { showSignIn(); return; }
      try { await rpc('claim_admin_invite'); } catch (e) { /* not invited: fine */ }
      var ok = false;
      try { ok = await rpc('is_admin'); } catch (e) { ok = false; }
      ST.isAdmin = ok === true;
      if (!ST.isAdmin) { showNotAdmin(); return; }
      try { var me = await rpc('admin_my_role'); ST.role = me.role; ST.as = me.role; } catch (e) { /* stays Support: the safest view */ }
      readUrl();
      buildShell();
      render();
      try { await loadCore(); } catch (e) { if (isAdminsOnly(e)) { ST.isAdmin = false; showNotAdmin(); return; } toast(friendly(e), { k: 'neg', t: 'Could not load' }); }
      render();
    } finally { booting = false; }
  }

  window.addEventListener('popstate', function () { if (!ST.isAdmin) return; closeDrawer(true); readUrl(); render(); });
  // Atharva's page redraws itself on any #hash change; if that ever happens, put our screen back.
  window.addEventListener('hashchange', function () { setTimeout(function () { if (ST.isAdmin && !$('#view')) { buildShell(); render(); } else if (!ST.session) { showSignIn(); } }, 0); });
  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') { ST.session = null; ST.isAdmin = false; ST.loaded = false; showSignIn(); }
    else if (event === 'SIGNED_IN' && !ST.isAdmin) { setTimeout(boot, 0); }
  });

  showLoading();   // replace the prototype's screen straight away
  // start after every script on the page has run, so the other screens have plugged in
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
})();
