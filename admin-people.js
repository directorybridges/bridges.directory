/* Admin screens: Members and Faculty accounts (real data). Plugs into window.BAdmin from admin-backend.js. */
(function () {
  'use strict';
  var A = window.BAdmin;
  if (!A) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, ico = A.ico, ini = A.ini, rel = A.rel, fmtD = A.fmtD, ST = A.ST, ph = A.ph, rpc = A.rpc, toast = A.toast;
  var DATA = window.BADMIN_DATA || { PAGES: [], OPEN: [], OPEN_FOR: {} };
  var OPEN = DATA.OPEN || [];

  var VM = { institute_email: 'Institute email code', certificate: 'Certificate', referral: 'Referral code' };
  var KIND = { student: 'Student', alum: 'Alum', faculty: 'Faculty' };
  var EXP_T = { job: 'Job', venture: 'Own venture', free: 'Freelance' };
  var LINK_T = { portfolio: 'Portfolio', behance: 'Behance', website: 'Website', other: 'Other link' };
  var LINK_PH = { portfolio: 'yourname.com/work', behance: 'behance.net/yourname', website: 'yourname.com', other: 'Dribbble, LinkedIn or a PDF link' };
  var LINK_MAX = 4;
  /* what a member gets when no personal number is set: their role's number, else the site number */
  function defLimit(m) {
    var o = ST.ov || {}, rl = o.role_limits || {}, role = m.is_volunteer ? 'volunteer' : m.kind, n = rl[role] != null ? rl[role] : (o.limit || 5);
    return n + (o.period === 'day' ? ' a day' : ' a week');
  }
  var linkText = function (ls) { return (ls || []).map(function (l) { return (LINK_T[l.t] || 'Link') + (l.name ? ' (' + l.name + ')' : '') + ': ' + l.url; }).join('; '); };
  var badLink = function (u) { return /\s/.test(u) || !/\.[a-z]{2,}$/i.test(u.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0]); };

  var inst = function (id) { return ST.instRows.filter(function (i) { return i.id === id; })[0]; };
  function instOptions(cur) {
    return A.GROUPS.map(function (g) {
      return '<optgroup label="' + g[1] + 's">' + ST.instRows.filter(function (i) { return i.grp === g[0]; }).map(function (i) {
        var opts = (i.campuses && i.campuses.length) ? i.campuses.map(function (c) { return [i.id + '|' + c, i.short + ' ' + c]; }) : [[i.id, i.short]];
        // an institute with campuses, but this person has none set: keep that as the starting choice instead of silently picking the first campus
        if (i.campuses && i.campuses.length && cur === i.id) opts.unshift([i.id, i.short + ' (campus not set)']);
        return opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
      }).join('') + '</optgroup>';
    }).join('');
  }
  var splitInst = function (v) { var p = String(v || '').split('|'); return { inst: p[0], campus: p[1] || '' }; };
  var instKey = function (m) { return m.institute_id + (m.campus ? '|' + m.campus : ''); };

  /* ------------------------------------------------------------------ links editor (Atharva's classes) */
  var lkRow = function (l, dis) {
    return '<div class="lk-r"><select class="input lk-t" aria-label="Link type"' + dis + '>' + Object.keys(LINK_T).map(function (k) { return '<option value="' + k + '"' + (l.t === k ? ' selected' : '') + '>' + LINK_T[k] + '</option>'; }).join('') + '</select>' +
      '<input class="input lk-u" type="url" inputmode="url" aria-label="Link address" placeholder="' + esc(LINK_PH[l.t] || LINK_PH.portfolio) + '" value="' + esc(l.url) + '"' + dis + '>' +
      '<button class="lk-x" type="button" aria-label="Remove link" title="Remove"' + dis + '>' + ico('trash', 15) + '</button>' +
      '<input class="input lk-n" maxlength="40" aria-label="Link name (optional)" placeholder="Name (optional)" value="' + esc(l.name || '') + '"' + dis + '></div>';
  };
  var linksEditor = function (links, dis) {
    var rows = (links && links.length ? links : [{ t: 'portfolio', url: '', name: '' }]).slice(0, LINK_MAX);
    return '<div class="lk-ed">' + rows.map(function (l) { return lkRow(l, dis); }).join('') + '<div class="lk-f"><button class="btn ghost sm" type="button" data-ladd' + (rows.length >= LINK_MAX || dis ? ' disabled' : '') + '>' + ico('plus', 14) + 'Add a link</button><span class="help" data-lkn>' + rows.length + ' of ' + LINK_MAX + '</span></div></div>';
  };
  var readLinks = function (r) {
    return $$('.lk-r', r).map(function (x) { return { t: $('.lk-t', x).value, url: $('.lk-u', x).value.trim().replace(/\/+$/, ''), name: $('.lk-n', x).value.trim() }; }).filter(function (l) { return l.url; }).slice(0, LINK_MAX);
  };
  function lkCount(ed) { var n = $$('.lk-r', ed).length; $('[data-lkn]', ed).textContent = n + ' of ' + LINK_MAX; $('[data-ladd]', ed).disabled = n >= LINK_MAX; }
  // capture phase, and stop the prototype's own handlers from also reacting to the same click
  document.addEventListener('click', function (e) {
    var add = e.target.closest && e.target.closest('[data-ladd]');
    if (add) {
      e.stopPropagation();
      var ed = add.closest('.lk-ed');
      if ($$('.lk-r', ed).length >= LINK_MAX) return;
      $('.lk-f', ed).insertAdjacentHTML('beforebegin', lkRow({ t: 'portfolio', url: '', name: '' }, ''));
      lkCount(ed); $$('.lk-u', ed).pop().focus();
      return;
    }
    var x = e.target.closest && e.target.closest('#dw .lk-x');
    if (x) {
      e.stopPropagation();
      var ed2 = x.closest('.lk-ed'), r = x.closest('.lk-r');
      if ($$('.lk-r', ed2).length === 1) { $$('input', r).forEach(function (i) { i.value = ''; }); $('.lk-t', r).value = 'portfolio'; } else r.remove();
      lkCount(ed2);
    }
  }, true);

  /* ------------------------------------------------------------------ members */
  var M = { rows: null, loading: false, f: { q: '', kind: 'all', g: '', st: '' } };
  var stOf = function (m) { return m.status === 'suspended' ? 'suspended' : !m.verified ? 'unverified' : !m.listed ? 'hidden' : 'active'; };
  var stPill = function (m) {
    return { active: '<span class="pill pos dot">Listed</span>', hidden: '<span class="pill warn dot">Hidden</span>', suspended: '<span class="pill neg dot">Suspended</span>', unverified: '<span class="pill dot">Not verified</span>' }[stOf(m)];
  };
  var grpOf = function (m) { var i = inst(m.institute_id); return i ? i.grp : ''; };
  var memberById = function (id) { return (M.rows || []).filter(function (m) { return m.id === id; })[0]; };

  function loadMembers() {
    if (M.loading) return Promise.resolve();
    M.loading = true;
    return rpc('admin_list_members').then(function (r) { M.rows = r || []; }).finally(function () { M.loading = false; });
  }

  function renderMembers(arg) {
    if (M.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadMembers().then(function () { if (ST.view === 'members') renderMembers(arg); }, A.fail);
      return;
    }
    var f = M.f;
    if (ST.mq) { f.q = ST.mq; ST.mq = ''; }
    A.view().innerHTML = ph('Members', 'Everyone on Bridges.directory. Open someone to edit, hide, suspend or delete them.', A.can('export') ? '<button class="btn secondary" type="button" id="mExp">' + ico('download', 16) + 'Export CSV</button>' : '') +
      '<section class="card"><div class="tools"><label class="srch">' + ico('search', 15) + '<input class="input" id="mQ" type="search" placeholder="Name, email or institute" aria-label="Search members" value="' + esc(f.q) + '"></label>' +
      '<div class="seg" role="group" aria-label="Type">' + [['all', 'Everyone'], ['student', 'Students'], ['alum', 'Alumni']].map(function (k) { return '<button type="button" data-mk="' + k[0] + '" aria-pressed="' + (f.kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>' +
      '<select class="input" id="mG" aria-label="Institute"><option value="">All institutes</option>' + A.GROUPS.map(function (g) { return '<option value="' + g[0] + '"' + (f.g === g[0] ? ' selected' : '') + '>' + g[1] + 's</option>'; }).join('') + '</select>' +
      '<select class="input" id="mS" aria-label="Status"><option value="">Any status</option>' + [['active', 'Listed'], ['hidden', 'Hidden'], ['suspended', 'Suspended'], ['unverified', 'Not verified']].map(function (s) { return '<option value="' + s[0] + '"' + (f.st === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select>' +
      '<span class="cnt" id="mN"></span></div><div class="tbl" id="mList"></div></section>';
    drawMembers();
    $('#mQ').addEventListener('input', function (e) { f.q = e.target.value; drawMembers(); });
    $$('[data-mk]').forEach(function (b) { b.addEventListener('click', function () { f.kind = b.dataset.mk; $$('[data-mk]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); drawMembers(); }); });
    $('#mG').addEventListener('change', function (e) { f.g = e.target.value; drawMembers(); });
    $('#mS').addEventListener('change', function (e) { f.st = e.target.value; drawMembers(); });
    if ($('#mExp')) $('#mExp').addEventListener('click', exportMembers);
    if (arg && memberById(arg)) openMember(arg);
  }
  function drawMembers() {
    var f = M.f, q = f.q.trim().toLowerCase();
    var list = M.rows.filter(function (m) {
      return (f.kind === 'all' || m.kind === f.kind) && (!f.g || grpOf(m) === f.g) && (!f.st || stOf(m) === f.st) &&
        (!q || [m.name, m.google_email, m.email_institute, m.email_personal, A.instLabel(m.institute_id), m.branch].join(' ').toLowerCase().indexOf(q) >= 0);
    });
    $('#mN').textContent = list.length + ' of ' + M.rows.length;
    var shown = list.slice(0, M.max || 100);
    $('#mList').setAttribute('style', '--cols:minmax(0,2.2fr) 84px minmax(0,1.2fr) minmax(0,1.4fr) 104px 100px 16px;--cols-t:minmax(0,2fr) 84px minmax(0,1.2fr) 104px 16px;--cols-m:minmax(0,1fr) auto');
    $('#mList').innerHTML = '<div class="tr th"><span>Name</span><span>Type</span><span>Institute</span><span class="ht">Branch and year</span><span>Status</span><span class="ht">Joined</span><span></span></div>' +
      (shown.length ? shown.map(function (m) {
        return '<button class="tr" type="button" data-om="' + m.id + '"><span class="who">' + ini(m.name, m.kind === 'student' ? 'stu' : 'alum') + '<span><b>' + esc(m.name) + '</b><small>' + esc(m.google_email) + '</small><small class="mo">' + esc(KIND[m.kind] + ' · ' + A.instLabel(m.institute_id)) + '</small></span></span>' +
          '<span class="hm">' + A.kindPill(m.kind) + '</span><span class="hm ell">' + esc(A.instLabel(m.institute_id) + (m.campus ? ' ' + m.campus : '')) + '</span><span class="hm ht ell sub">' + esc(m.branch || '—') + (m.year ? ' · ' + m.year : '') + '</span><span>' + stPill(m) + '</span><span class="hm ht sub">' + fmtD(m.created_at) + '</span><span class="chev hm">' + ico('right', 14) + '</span></button>';
      }).join('') : '<div class="empty">' + ico('search', 20) + '<span>' + (M.rows.length ? 'No members match these filters.' : 'No one has joined yet.') + '</span></div>') +
      (list.length > shown.length ? '<div class="more"><button class="btn secondary sm" type="button" id="mMore">Show ' + Math.min(100, list.length - shown.length) + ' more</button></div>' : '');
    $$('[data-om]', $('#mList')).forEach(function (b) { b.addEventListener('click', function () { openMember(b.dataset.om); }); });
    if ($('#mMore')) $('#mMore').addEventListener('click', function () { M.max = (M.max || 100) + 100; drawMembers(); });
  }

  function exportMembers() {
    var b = $('#mExp'); b.disabled = true;
    rpc('admin_export_members').then(function (rows) {
      A.download('bridges-members.csv', A.csv([['Name', 'Type', 'Institute', 'Campus', 'Branch', 'Year', 'Google account', 'Institute email', 'Contact email', 'Links', 'Verified by', 'Status', 'Listed', 'Contacts allowed (per day or per week, see Settings)', 'Joined', 'Last active']]
        .concat(rows.map(function (r) { return [r.name, KIND[r.kind], r.institute, r.campus, r.branch, r.year, r.google_email, r.email_institute, r.email_personal, linkText(r.links), r.verified_by, r.status, r.listed ? 'Yes' : 'No', r.weekly_contacts, fmtD(r.created_at), fmtD(r.last_seen)]; }))));
      A.refreshCounts();
    }).catch(A.fail).finally(function () { b.disabled = false; });
  }

  function openMember(id) {
    var m = memberById(id);
    if (!m) return;
    var E = A.can('edit'), H = A.can('suspend'), dis = E ? '' : ' disabled', stu = m.kind === 'student';
    var xp = Array.isArray(m.experiences) ? m.experiences : [];
    var expT = function (x) { return EXP_T[x.t] ? x.t : 'job'; };
    var xrow = function (x) {
      return '<div class="xrow"><select class="input" data-x="t" aria-label="Type"' + dis + '>' + Object.keys(EXP_T).map(function (k) { return '<option value="' + k + '"' + (expT(x) === k ? ' selected' : '') + '>' + EXP_T[k] + '</option>'; }).join('') + '</select>' +
        '<input class="input" data-x="role" placeholder="Role" aria-label="Role" value="' + esc(x.role) + '"' + dis + '><input class="input" data-x="org" placeholder="Organisation" aria-label="Organisation" value="' + esc(x.org) + '"' + dis + '>' +
        '<button class="ib" type="button" data-xdel aria-label="Remove experience"' + dis + '>' + ico('trash', 15) + '</button></div>';
    };
    var ins = inst(m.institute_id) || { branches: [], campuses: [], email_domain: '' };
    var branchOpts = function (i, cur) {
      var bs = (i.branches || []).slice(); if (cur && bs.indexOf(cur) < 0) bs.unshift(cur);
      return bs.map(function (b) { return '<option' + (b === cur ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('');
    };
    var body = '<div class="sec"><div class="sum">' + ini(m.name, 'lg ' + (stu ? 'stu' : 'alum')) + '<div style="min-width:0"><h3>' + esc(m.name) + '</h3><div class="pills">' + A.kindPill(m.kind) + stPill(m) + (m.is_volunteer ? '<span class="pill">Volunteer</span>' : '') + '</div></div></div>' +
      '<div class="kv"><div><small>Joined</small><b>' + fmtD(m.created_at) + '</b></div><div><small>Last active</small><b>' + rel(m.last_seen) + '</b></div><div><small>Verified by</small><b>' + esc(m.verified ? (VM[m.verify_method] || 'Admin') : 'Not verified yet') + '</b></div></div></div>' +
      (E ? '' : '<div class="callout">' + ico('lock', 15) + '<span>Your role can see this profile but cannot edit it.</span></div>') +
      '<div class="sec"><h4>Profile</h4><div class="grid2"><div class="fld"><label class="label" for="e-name">Full name</label><input class="input" id="e-name" value="' + esc(m.name) + '"' + dis + '></div>' +
      '<div class="fld"><label class="label" for="e-kind">Type</label><select class="input" id="e-kind"' + dis + '><option value="student"' + (stu ? ' selected' : '') + '>Current student</option><option value="alum"' + (!stu ? ' selected' : '') + '>Alum</option></select></div></div>' +
      '<div class="fld"><label class="label" for="e-inst">Institute</label><select class="input" id="e-inst"' + dis + '>' + instOptions(instKey(m)) + '</select></div>' +
      '<div class="grid2"><div class="fld"><label class="label" for="e-branch">Branch</label><select class="input" id="e-branch"' + dis + '>' + branchOpts(ins, m.branch) + '</select></div>' +
      '<div class="fld"><label class="label" for="e-year" id="e-yl">' + (stu ? 'Graduating in' : 'Graduated in') + '</label><input class="input" id="e-year" type="number" min="1970" max="2032" value="' + esc(m.year || '') + '"' + dis + '></div></div>' +
      '<div class="fld"><span class="label">Portfolio and links</span>' + linksEditor(m.links, dis) + '<span class="help">Up to ' + LINK_MAX + '. Members see them when they open this contact.</span></div>' +
      '<div class="fld"><span class="label">Happy to help with</span><div class="checks">' + OPEN.map(function (o, i) { return '<label><input type="checkbox" data-open="' + i + '"' + ((m.helps || []).indexOf(i) >= 0 ? ' checked' : '') + dis + '>' + esc(o) + '</label>'; }).join('') + '</div></div>' +
      '<div class="fld" id="e-xpw"' + (stu ? ' hidden' : '') + '><span class="label">Experience</span><div style="display:grid;gap:8px" id="e-xp">' + xp.map(xrow).join('') + '</div><button class="btn ghost sm" type="button" id="e-xadd" style="justify-self:start"' + dis + '>' + ico('plus', 14) + 'Add experience</button></div></div>' +
      '<div class="sec"><h4>Sign-in and contact</h4><div class="fld"><label class="label" for="e-g">Google account</label><input class="input" id="e-g" type="email" value="' + esc(m.google_email) + '" disabled><span class="help">They sign in with this. It is managed by Google, so it cannot be changed here. If they lost access, they need to join again with a new account.</span></div>' +
      (stu ? '<div class="fld" id="e-iew"><label class="label" for="e-ie">Institute email</label><input class="input" id="e-ie" type="email" value="' + esc(m.email_institute || '') + '" placeholder="Not added"' + dis + '><span class="help">Verified with a one-time code. Members see it when they open this contact.</span></div>' : '') +
      '<div class="fld" id="e-cew"' + (stu ? ' hidden' : '') + '><label class="label" for="e-ce">Contact email</label><input class="input" id="e-ce" type="email" value="' + esc(m.email_personal || '') + '" placeholder="Same as the Google account"' + dis + '><span class="help">Members see this when they open the contact.</span></div></div>' +
      '<div class="sec"><h4>Listing and limits</h4>' +
      '<label class="tgl"><span><b>Listed in the directory</b><span class="help">When off, the profile is hidden from the directory and browse pages, but they can still sign in.</span></span><input type="checkbox" id="e-listed"' + (m.listed ? ' checked' : '') + (H && m.verified ? '' : ' disabled') + '></label>' +
      (m.verified ? '' : '<p class="help">Not verified yet. They are listed once a volunteer or admin approves their certificate.</p>') +
      '<div class="fld"><label class="label" for="e-limit">Contacts they can open ' + (ST.ov && ST.ov.period === 'day' ? 'each day' : 'each week') + '</label><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input class="input" id="e-limit" type="number" min="0" max="500" step="1" value="' + (m.contact_limit == null ? '' : m.contact_limit) + '" placeholder="Default: ' + esc(defLimit(m)) + '" style="max-width:190px"' + dis + '>' + (E ? '<button class="btn ghost sm" type="button" id="e-limdef">Use default</button>' : '') + '</div><span class="help">Any number from 0 to 500. Empty uses the default for their role (' + esc(defLimit(m)) + '). 0 means they cannot open contacts.</span></div>' +
      (stu ? '<label class="tgl" id="e-volw"><span><b>Volunteer</b><span class="help">Volunteers review certificates from new members. Turn on only after approving their application under Volunteer applications; turning off removes their access.</span></span><input type="checkbox" id="e-vol"' + (m.is_volunteer ? ' checked' : '') + dis + '></label>' : '') + '</div>' +
      '<div class="sec"><h4>Account status</h4><div class="seg" role="group" aria-label="Account status" id="e-st">' + [['active', 'Active'], ['suspended', 'Suspended']].map(function (s) { return '<button type="button" data-st="' + s[0] + '" aria-pressed="' + (m.status === s[0]) + '"' + (H ? '' : ' disabled') + '>' + s[1] + '</button>'; }).join('') + '</div><p class="help">Suspended members cannot sign in and are not listed. Their data stays until you delete it.</p></div>' +
      '<div class="sec"><h4>Recent activity</h4><div id="e-act"><p class="help">' + (A.can('logs') ? 'Loading…' : 'Your role cannot see the activity log.') + '</p></div>' +
      (A.can('logs') ? '<button class="btn ghost sm" type="button" id="e-logs" style="justify-self:start">See all activity' + ico('right', 14) + '</button>' : '') + '</div>' +
      (A.can('delete') ? '<div class="sec dz"><h4>Delete profile</h4><p class="help">Removes the profile, the sign-in and their data at once. This cannot be undone.</p><button class="btn secondary neg" type="button" id="e-del" style="justify-self:start">' + ico('trash', 15) + 'Delete profile</button></div>' : '');
    var d = A.drawer(m.name, body, '<p class="err" id="e-err" role="alert"></p><button class="btn ghost" type="button" data-dwclose>' + (E || H ? 'Cancel' : 'Close') + '</button>' + (E || H ? '<button class="btn primary" type="button" id="e-save">Save changes</button>' : ''));
    var st = m.status;
    if (A.can('logs')) rpc('admin_member_log', { p_id: m.id, p_limit: 6 }).then(function (rows) {
      var box = $('#e-act', d); if (!box) return;
      box.innerHTML = rows.length ? '<div class="mini">' + rows.map(function (l) { return '<div><b style="font-weight:400">' + esc(l.target_id === m.id && l.who !== m.name ? l.who + ' · ' + l.act : l.act + (l.target ? ': ' + l.target : '')) + '</b><span>' + rel(l.at) + '</span></div>'; }).join('') + '</div>' : '<p class="help">Nothing in the last two weeks.</p>';
    }, function () { var box = $('#e-act', d); if (box) box.innerHTML = '<p class="help">Could not load the activity.</p>'; });
    if ($('#e-limdef', d)) $('#e-limdef', d).addEventListener('click', function () { $('#e-limit', d).value = ''; $('#e-limit', d).focus(); });
    $('#e-inst', d).addEventListener('change', function (e) {
      var x = splitInst(e.target.value), i = inst(x.inst) || { branches: [] };
      $('#e-branch', d).innerHTML = branchOpts(i, '');
    });
    $('#e-kind', d).addEventListener('change', function (e) {
      var s = e.target.value === 'student';
      $('#e-xpw', d).hidden = s; $('#e-cew', d).hidden = s;
      if ($('#e-iew', d)) $('#e-iew', d).hidden = !s;
      if ($('#e-volw', d)) $('#e-volw', d).hidden = !s;
      $('#e-yl', d).textContent = s ? 'Graduating in' : 'Graduated in';
    });
    if ($('#e-xadd', d)) $('#e-xadd', d).addEventListener('click', function () { var w = $('#e-xp', d); w.insertAdjacentHTML('beforeend', xrow({ t: 'job', role: '', org: '' })); $('input', w.lastElementChild).focus(); });
    $('#e-xp', d).addEventListener('click', function (e) { var b = e.target.closest('[data-xdel]'); if (b) b.closest('.xrow').remove(); });
    $$('[data-st]', d).forEach(function (b) { b.addEventListener('click', function () { st = b.dataset.st; $$('[data-st]', d).forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); }); });
    if ($('#e-logs', d)) $('#e-logs', d).addEventListener('click', function () { ST.lq = m.name; A.go('logs'); });
    if ($('#e-del', d)) $('#e-del', d).addEventListener('click', function () { deleteMember(m); });
    if ($('#e-save', d)) $('#e-save', d).addEventListener('click', function () { saveMember(m, d, st); });
  }

  function saveMember(m, d, st) {
    var err = $('#e-err', d); err.textContent = '';
    $$('.input', d).forEach(function (i) { i.removeAttribute('aria-invalid'); });
    var bad = function (sel, msg) { var i = $(sel, d); if (i) { i.setAttribute('aria-invalid', 'true'); i.focus(); } err.textContent = msg; };
    var name = $('#e-name', d).value.trim(), kind = $('#e-kind', d).value, x = splitInst($('#e-inst', d).value), year = parseInt($('#e-year', d).value, 10);
    if (!name) return bad('#e-name', 'Add their name.');
    if (!year || year < 1970 || year > 2032) return bad('#e-year', 'Enter a year between 1970 and 2032.');
    var limRaw = $('#e-limit', d).value.trim();
    if (limRaw !== '' && !(/^\d+$/.test(limRaw) && +limRaw <= 500)) return bad('#e-limit', 'Use a whole number from 0 to 500, or leave it empty for the default.');
    var badL = $$('.lk-u', d).filter(function (i) { return i.value.trim() && badLink(i.value.trim()); })[0];
    if (badL) { badL.setAttribute('aria-invalid', 'true'); badL.focus(); err.textContent = '"' + badL.value.trim() + '" does not look like a web address.'; return; }
    var ie = $('#e-ie', d) ? $('#e-ie', d).value.trim().toLowerCase() : '', ce = $('#e-ce', d) ? $('#e-ce', d).value.trim().toLowerCase() : '';
    var i2 = inst(x.inst);
    if (kind === 'student' && ie) {
      var dom = i2 ? i2.email_domain : '', host = ie.split('@')[1] || '';
      if (!A.validEmail(ie) || !(host === dom || host.slice(-dom.length - 1) === '.' + dom)) return bad('#e-ie', 'Use an address that ends with @' + dom + ', or leave it empty.');
    }
    if (kind === 'alum' && ce && !A.validEmail(ce)) return bad('#e-ce', 'Enter a valid contact email.');
    var exps = kind === 'alum' ? $$('.xrow', d).map(function (r, i) {
      var orig = (Array.isArray(m.experiences) && m.experiences[i]) || { from: m.year, to: 0 };
      return Object.assign({}, orig, { t: $('[data-x="t"]', r).value, role: $('[data-x="role"]', r).value.trim(), org: $('[data-x="org"]', r).value.trim() });
    }).filter(function (e) { return e.role; }) : [];
    var next = {
      name: name, kind: kind, institute_id: x.inst, campus: x.campus, branch: $('#e-branch', d).value, year: year, links: readLinks(d),
      helps: $$('[data-open]', d).filter(function (c) { return c.checked; }).map(function (c) { return +c.dataset.open; }),
      contact_limit: $('#e-limit', d).value === '' ? null : +$('#e-limit', d).value
    };
    if (!$('#e-listed', d).disabled) next.listed = $('#e-listed', d).checked;
    if (!$$('[data-st]', d)[0].disabled) next.status = st;
    if (kind === 'student') { next.email_institute = ie; if ($('#e-vol', d)) next.is_volunteer = $('#e-vol', d).checked; } else { next.email_personal = ce; next.experiences = exps; }
    if (kind === 'student' && m.kind === 'alum') next.experiences = [];
    var orig = { name: m.name, kind: m.kind, institute_id: m.institute_id, campus: m.campus || '', branch: m.branch || '', year: m.year, links: m.links || [], helps: m.helps || [],
      contact_limit: m.contact_limit, listed: m.listed, status: m.status, email_institute: m.email_institute || '', email_personal: m.email_personal || '', is_volunteer: m.is_volunteer, experiences: m.experiences || [] };
    var norm = function (v) { return JSON.stringify(v); };
    var send = {};
    Object.keys(next).forEach(function (k) {
      if (k === 'links') { var a = (orig.links || []).map(function (l) { return { t: l.t || 'portfolio', url: String(l.url || '').replace(/\/+$/, ''), name: l.name || '' }; }); if (norm(a) !== norm(next.links)) send.links = next.links; return; }
      if (norm(next[k]) !== norm(orig[k])) send[k] = next[k];
    });
    // moving to another institute without touching campus must still send both together
    if (send.institute_id !== undefined || send.campus !== undefined) { send.institute_id = next.institute_id; send.campus = next.campus; }
    var keys = Object.keys(send);
    if (!keys.length) { A.closeDrawer(); return; }
    var btn = $('#e-save', d); btn.disabled = true;
    rpc('admin_update_member', { p_id: m.id, p: send }).then(function () {
      A.closeDrawer();
      toast(name.split(' ')[0] + '\'s profile was updated.', { t: 'Saved' });
      M.rows = null; A.refreshCounts();
      if (ST.view === 'members') renderMembers('');
    }, function (e) {
      btn.disabled = false;
      if (/admins_only/.test(e.message || '')) return A.fail(e);
      err.textContent = A.friendly(e);
      if (/not_found/.test(e.message || '')) { M.rows = null; }
    });
  }

  function deleteMember(m, after) {
    A.confirmBox({
      t: 'Delete ' + m.name + '\'s profile?', sub: 'The profile, the sign-in and their data are removed straight away. This cannot be undone.', ok: 'Delete profile', danger: true,
      body: '<div class="fld"><label class="label" for="dl-r">Reason</label><select class="input" id="dl-r"><option>They asked to be deleted</option><option>Fake or duplicate account</option><option>Broke the community guidelines</option><option>Other</option></select></div>' +
        '<label class="tgl"><span><b>Block this Google account</b><span class="help">' + esc(m.google_email) + ' cannot sign up again.</span></span><input type="checkbox" id="dl-b"></label>'
    }, function (md) {
      return rpc('admin_delete_member', { p_id: m.id, p_reason: $('#dl-r', md).value, p_block: $('#dl-b', md).checked }).then(function () {
        A.closeDrawer(true); M.rows = null; A.refreshCounts();
        toast(m.name + '\'s profile is gone.', { t: 'Profile deleted', k: 'info', i: 'trash' });
        if (after) after(); else if (ST.view === 'members') renderMembers('');
      });
    });
  }
  A.members = { ensure: function (id) { return (M.rows === null ? loadMembers() : Promise.resolve()).then(function () { return memberById(id); }); }, open:function (id) { return (M.rows === null ? loadMembers() : Promise.resolve()).then(function () { openMember(id); }); }, reload: function () { M.rows = null; }, remove: deleteMember, byId: memberById };

  A.register('members', { render: renderMembers });

  /* ------------------------------------------------------------------ faculty */
  var F = { rows: null, loading: false, q: '' };
  var fOn = function (f) { return f.status === 'active'; };
  var facPill = function (f) { return fOn(f) ? '<span class="pill pos dot">Active</span>' : '<span class="pill neg dot">Disabled</span>'; };

  function loadFaculty() {
    if (F.loading) return Promise.resolve();
    F.loading = true;
    return rpc('admin_list_faculty').then(function (r) { F.rows = r || []; }).finally(function () { F.loading = false; });
  }
  function renderFaculty(arg) {
    if (F.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadFaculty().then(function () { if (ST.view === 'faculty') renderFaculty(arg); }, A.fail);
      return;
    }
    var q = F.q.trim().toLowerCase();
    var list = F.rows.filter(function (f) { return !q || [f.name, f.fid, f.email, A.instLabel(f.institute_id), f.dept].join(' ').toLowerCase().indexOf(q) >= 0; });
    A.view().innerHTML = ph('Faculty accounts', 'Faculty sign in with an ID and password you give them. They are never listed and cannot edit their profile.', '<button class="btn primary" type="button" id="fNew">' + ico('plus', 16) + 'New faculty account</button>') +
      '<section class="card"><div class="tools"><label class="srch">' + ico('search', 15) + '<input class="input" id="fQ" type="search" placeholder="Name, ID or institute" aria-label="Search faculty" value="' + esc(F.q) + '"></label><span class="cnt">' + list.length + ' account' + (list.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="tbl" style="--cols:minmax(0,2fr) 100px minmax(0,1.3fr) minmax(0,1.3fr) 96px 110px 16px;--cols-t:minmax(0,2fr) 100px minmax(0,1.3fr) 96px 16px;--cols-m:minmax(0,1fr) auto"><div class="tr th"><span>Name</span><span>Faculty ID</span><span>Institute</span><span class="ht">Title</span><span>Status</span><span class="ht">Last sign-in</span><span></span></div>' +
      (list.length ? list.map(function (f) {
        return '<button class="tr" type="button" data-of="' + f.user_id + '"><span class="who">' + ini(f.name, 'fac') + '<span><b>' + esc(f.name) + '</b><small>' + esc(f.email || 'No email') + '</small><small class="mo"><code>' + esc(f.fid) + '</code> · ' + esc(A.instLabel(f.institute_id)) + '</small></span></span><span class="hm"><code>' + esc(f.fid) + '</code></span><span class="hm ell">' + esc(A.instLabel(f.institute_id)) + '</span><span class="hm ht ell sub">' + esc(f.title) + '</span><span>' + facPill(f) + '</span><span class="hm ht sub">' + rel(f.last_signin) + '</span><span class="chev hm">' + ico('right', 14) + '</span></button>';
      }).join('') : '<div class="empty">' + ico('key', 20) + '<span>No faculty accounts yet.</span></div>') + '</div></section>' +
      '<div class="callout">' + ico('lock', 15) + '<span>Passwords are stored encrypted, so nobody can see them, including you. You see a password once, when you create an account or reset its password. Faculty cannot change it themselves.</span></div>';
    $('#fNew').addEventListener('click', function () { openFaculty(null); });
    $('#fQ').addEventListener('input', function (e) { F.q = e.target.value; var pos = e.target.selectionStart; renderFaculty(''); var i = $('#fQ'); i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } });
    $$('[data-of]').forEach(function (b) { b.addEventListener('click', function () { openFaculty(b.dataset.of); }); });
    if (!list.length) return;
  }

  function openFaculty(id) {
    var f = id ? F.rows.filter(function (x) { return x.user_id === id; })[0] : null, isNew = !f;
    var x = f || { fid: '', name: '', title: '', dept: '', institute_id: (ST.instRows[0] || {}).id || '', campus: '', email: '', status: 'active' };
    var body = (isNew ? '<div class="callout">' + ico('info', 15) + '<span>When you create the account you get an ID and a password to send them. Their profile will not appear in the directory.</span></div>'
        : '<div class="sec"><div class="sum">' + ini(x.name, 'lg fac') + '<div style="min-width:0"><h3>' + esc(x.name) + '</h3><div class="pills"><span class="pill fac">Faculty</span>' + facPill(x) + '<span class="pill">' + ico('eyeoff', 12) + 'Not in the directory</span></div></div></div>' +
          '<div class="kv"><div><small>Created</small><b>' + fmtD(x.created_at) + ' by ' + esc(x.made_by_name || 'the team') + '</b></div><div><small>Last sign-in</small><b>' + rel(x.last_signin) + '</b></div><div><small>Password set</small><b>' + fmtD(x.pw_at) + '</b></div></div></div>') +
      '<div class="sec"><h4>Profile</h4><div class="fld"><label class="label" for="f-name">Full name</label><input class="input" id="f-name" value="' + esc(x.name) + '" placeholder="e.g. Anjali Mehra"></div>' +
      '<div class="grid2"><div class="fld"><label class="label" for="f-title">Title</label><input class="input" id="f-title" value="' + esc(x.title) + '" placeholder="Associate Professor"></div><div class="fld"><label class="label" for="f-dept">Department</label><input class="input" id="f-dept" value="' + esc(x.dept) + '" placeholder="Communication Design"></div></div>' +
      '<div class="fld"><label class="label" for="f-inst">Institute</label><select class="input" id="f-inst">' + instOptions(x.institute_id + (x.campus ? '|' + x.campus : '')) + '</select></div>' +
      '<div class="fld"><label class="label" for="f-email">Email</label><input class="input" id="f-email" type="email" value="' + esc(x.email) + '" placeholder="name@nid.edu"><span class="help">Where you send their ID and password. It is not used to sign in.</span></div></div>' +
      '<div class="sec"><h4>Sign-in</h4><div class="fld"><span class="label">Faculty ID</span>' + (isNew ? '<span class="help">The ID is made when you create the account.</span>' : '<div style="display:flex;align-items:center;gap:10px"><code style="font-size:1rem">' + esc(x.fid) + '</code><button class="btn ghost sm" type="button" id="f-copyid">' + ico('copy', 14) + 'Copy</button></div>') + '<span class="help">IDs are unique and cannot be reused, even after an account is deleted.</span></div>' +
      (isNew ? '' : '<div class="fld"><span class="label">Password</span><div style="display:flex;align-items:center;gap:10px"><span>••••••••••</span><button class="btn secondary sm" type="button" id="f-reset">' + ico('refresh', 14) + 'Reset password</button></div><span class="help">Resetting signs them out everywhere. You will see the new password once.</span></div>' +
        '<label class="tgl"><span><b>Account active</b><span class="help">Turn off to stop them signing in without deleting the account.</span></span><input type="checkbox" id="f-active"' + (fOn(x) ? ' checked' : '') + '></label>') + '</div>' +
      (isNew ? '' : '<div class="sec dz"><h4>Delete account</h4><p class="help">They cannot sign in any more, and their profile is erased. The ID stays retired.</p><button class="btn secondary neg" type="button" id="f-del" style="justify-self:start">' + ico('trash', 15) + 'Delete account</button></div>');
    var d = A.drawer(isNew ? 'New faculty account' : x.name, body, '<p class="err" id="f-err" role="alert"></p><button class="btn ghost" type="button" data-dwclose>Cancel</button><button class="btn primary" type="button" id="f-save">' + (isNew ? 'Create account' : 'Save changes') + '</button>');
    if ($('#f-copyid', d)) $('#f-copyid', d).addEventListener('click', function () { A.copy(x.fid, 'Faculty ID'); });
    if ($('#f-reset', d)) $('#f-reset', d).addEventListener('click', function () {
      A.confirmBox({ t: 'Reset ' + x.name.split(' ')[0] + '\'s password?', sub: 'Their current password stops working right away, and they are signed out everywhere.', ok: 'Reset password' }, function () {
        return rpc('admin_reset_faculty_password', { p_id: x.user_id }).then(function (r) { A.closeDrawer(true); F.rows = null; credModal({ name: x.name, email: x.email }, r.fid || x.fid, r.password, false); if (ST.view === 'faculty') renderFaculty(''); });
      });
    });
    if ($('#f-del', d)) $('#f-del', d).addEventListener('click', function () {
      A.confirmBox({ t: 'Delete ' + x.name + '\'s account?', sub: 'They cannot sign in any more. This cannot be undone.', ok: 'Delete account', danger: true }, function () {
        return rpc('admin_delete_faculty', { p_id: x.user_id }).then(function () { A.closeDrawer(true); F.rows = null; toast(x.fid + ' is retired.', { t: 'Faculty account deleted', k: 'info', i: 'trash' }); if (ST.view === 'faculty') renderFaculty(''); A.refreshCounts(); });
      });
    });
    $('#f-save', d).addEventListener('click', function () {
      var err = $('#f-err', d); err.textContent = ''; $$('.input', d).forEach(function (i) { i.removeAttribute('aria-invalid'); });
      var bad = function (sel, msg) { var i = $(sel, d); i.setAttribute('aria-invalid', 'true'); i.focus(); err.textContent = msg; };
      var name = $('#f-name', d).value.trim(), email = $('#f-email', d).value.trim().toLowerCase(), it = splitInst($('#f-inst', d).value);
      if (!name) return bad('#f-name', 'Add their name.');
      if (email && !A.validEmail(email)) return bad('#f-email', 'Enter a valid email, or leave it empty.');
      var btn = $('#f-save', d); btn.disabled = true;
      var title = $('#f-title', d).value.trim(), dept = $('#f-dept', d).value.trim();
      var done = isNew
        ? rpc('admin_create_faculty', { p_name: name, p_title: title, p_dept: dept, p_institute: it.inst, p_campus: it.campus, p_email: email }).then(function (r) {
          A.closeDrawer(true); F.rows = null; if (ST.view === 'faculty') renderFaculty(''); A.refreshCounts();
          credModal({ name: name, email: email }, r.fid, r.password, true);
        })
        : rpc('admin_update_faculty', { p_id: x.user_id, p_name: name, p_title: title, p_dept: dept, p_institute: it.inst, p_campus: it.campus, p_email: email, p_active: $('#f-active', d).checked }).then(function () {
          A.closeDrawer(); F.rows = null; if (ST.view === 'faculty') renderFaculty(''); toast(name + '\'s account is up to date.', { t: 'Saved' });
        });
      done.catch(function (e) { btn.disabled = false; if (/admins_only/.test(e.message || '')) return A.fail(e); err.textContent = A.friendly(e); });
    });
  }

  var fill = function (t, o) { return String(t).replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); };
  function credModal(f, fid, pw, created) {
    var txt = function (k) { return A.pageText('emails', k); };
    var mail = fill(txt('fac_b'), { name: f.name.split(' ')[0], id: fid, password: pw });
    var m = A.modal(A.mdHead(created ? 'Account created' : 'New password set', 'Send these to ' + f.name + '. The password will not be shown again.') +
      '<div class="cred"><div class="cred-r"><div><small>Faculty ID</small><code>' + esc(fid) + '</code></div><button class="btn ghost sm" type="button" data-cp="id">' + ico('copy', 14) + 'Copy</button></div>' +
      '<div class="cred-r"><div><small>Password</small><code>' + esc(pw) + '</code></div><button class="btn ghost sm" type="button" data-cp="pw">' + ico('copy', 14) + 'Copy</button></div></div>' +
      '<div class="callout warn">' + ico('alert', 15) + '<span>Send the password privately, for example in a direct email to ' + esc(f.email || 'them') + '. Do not post it in a group.</span></div>' +
      '<div class="md-f"><button class="btn secondary" type="button" data-cp="mail">' + ico('mail', 15) + 'Copy welcome email</button><button class="btn primary" type="button" data-mclose>Done</button></div>', 'Faculty credentials');
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cp]'); if (!b) return; var k = b.dataset.cp;
      if (k === 'id') A.copy(fid, 'Faculty ID'); else if (k === 'pw') A.copy(pw, 'Password'); else A.copy('Subject: ' + txt('fac_s') + '\n\n' + mail, 'Welcome email');
    });
  }

  A.register('faculty', { render: renderFaculty });

  /* ------------------------------------------------------------------ Invites: email a one-time code for a chosen college */
  var IV = { rows: null, loading: false, kind: 'alum', inst: '' };
  var ivPill = function (r) { return { pending: '<span class="pill warn dot">Waiting</span>', joined: '<span class="pill pos dot">Joined</span>', expired: '<span class="pill dot">Expired</span>' }[r.status] || ''; };
  function loadInvites() {
    if (IV.loading) return Promise.resolve();
    IV.loading = true;
    return rpc('admin_list_referrals', { p_limit: 200 }).then(function (r) { IV.rows = r || []; }).finally(function () { IV.loading = false; });
  }
  function instPlain(cur) {
    return A.GROUPS.map(function (g) {
      return '<optgroup label="' + g[1] + 's">' + ST.instRows.filter(function (i) { return i.grp === g[0]; }).map(function (i) {
        return '<option value="' + esc(i.id) + '"' + (i.id === cur ? ' selected' : '') + '>' + esc(i.short) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }
  function renderInvites() {
    if (IV.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadInvites().then(function () { if (ST.view === 'invites') renderInvites(); }, A.fail);
      return;
    }
    if (!IV.inst) IV.inst = (ST.instRows[0] || {}).id || '';
    var waiting = IV.rows.filter(function (r) { return r.status === 'pending'; }).length;
    A.view().innerHTML = ph('Invites', 'Add an email address and pick a college. They get a one-time code by email. With it they sign in with Google, choose that college and are verified and listed straight away.') +
      '<section class="card"><div style="padding:16px 18px"><div class="fld"><label class="label" for="iv-em">Email addresses</label><textarea class="input" id="iv-em" rows="2" placeholder="name@gmail.com" style="resize:vertical"></textarea><span class="help">One address, or several separated by commas, spaces or new lines.</span></div>' +
      '<div class="grid2"><div class="fld"><label class="label" for="iv-in">College</label><select class="input" id="iv-in">' + instPlain(IV.inst) + '</select></div>' +
      '<div class="fld"><span class="label">They are</span><div class="seg" role="group" aria-label="They are">' + [['alum', 'Alum'], ['student', 'Student']].map(function (k) { return '<button type="button" data-ik="' + k[0] + '" aria-pressed="' + (IV.kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div></div></div>' +
      '<p class="err" id="iv-err" role="alert"></p><div style="display:flex;justify-content:flex-end"><button class="btn primary" type="button" id="iv-send">' + ico('mail', 16) + 'Send invite</button></div></div></section>' +
      '<section class="card" style="margin-top:16px"><div class="tools"><b>Sent invites</b><span class="cnt">' + IV.rows.length + ' sent · ' + waiting + ' waiting</span></div>' +
      '<div class="tbl" style="--cols:minmax(0,2fr) minmax(0,1fr) 84px 96px 110px 90px;--cols-t:minmax(0,2fr) minmax(0,1fr) 96px 90px;--cols-m:minmax(0,1fr) auto"><div class="tr th"><span>Email</span><span>College</span><span class="ht">Type</span><span>Status</span><span class="ht">Sent</span><span></span></div>' +
      (IV.rows.length ? IV.rows.map(function (r) {
        return '<div class="tr"><span class="who"><span><b class="ell">' + esc(r.email) + '</b><small class="mo">' + esc(r.institute + ' · ' + (KIND[r.kind] || r.kind)) + '</small></span></span><span class="hm ell">' + esc(r.institute) + '</span><span class="hm ht sub">' + esc(KIND[r.kind] || r.kind) + (r.sent_by === 'Member' ? ' · by a member' : '') + '</span><span>' + ivPill(r) + '</span><span class="hm ht sub">' + fmtD(r.created_at) + '</span><span class="hm">' + (r.status === 'pending' ? '<button class="btn ghost sm" type="button" data-ic="' + r.id + '">Cancel</button>' : '') + '</span></div>';
      }).join('') : '<div class="empty">' + ico('mail', 20) + '<span>No invites sent yet.</span></div>') + '</div></section>' +
      '<div class="callout">' + ico('info', 15) + '<span>A code works once, only for the college you picked, and expires after the number of days set in Settings. Sending again to the same address and college replaces the earlier code.</span></div>';
    $('#iv-in').addEventListener('change', function (e) { IV.inst = e.target.value; });
    $$('[data-ik]').forEach(function (b) { b.addEventListener('click', function () { IV.kind = b.dataset.ik; $$('[data-ik]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); }); });
    $('#iv-send').addEventListener('click', sendInvites);
    $$('[data-ic]').forEach(function (b) { b.addEventListener('click', function () {
      var r = IV.rows.filter(function (x) { return x.id === b.dataset.ic; })[0]; if (!r) return;
      A.confirmBox({ t: 'Cancel this invite?', sub: 'The code sent to ' + r.email + ' stops working.', ok: 'Cancel invite', danger: true }, function () {
        return rpc('admin_cancel_referral', { p_id: r.id }).then(function () { IV.rows = null; toast('The code for ' + r.email + ' no longer works.', { t: 'Invite cancelled', k: 'info' }); if (ST.view === 'invites') renderInvites(); });
      });
    }); });
  }
  function sendInvites() {
    var err = $('#iv-err'), btn = $('#iv-send'), raw = $('#iv-em').value;
    var list = raw.split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; });
    err.textContent = '';
    if (!list.length) { err.textContent = 'Enter at least one email address.'; return; }
    var bad = list.filter(function (x) { return !A.validEmail(x); });
    if (bad.length) { err.textContent = 'This does not look like an email address: ' + bad[0]; return; }
    if (list.length > 20) { err.textContent = 'Send up to 20 at a time.'; return; }
    btn.disabled = true;
    var ok = 0, failed = [];
    list.reduce(function (p, em) {
      return p.then(function () { return rpc('admin_create_referral', { p_email: em, p_institute: IV.inst, p_kind: IV.kind }).then(function () { ok++; }, function (e) {
        if (/admins_only/.test(e.message || '')) throw e;
        failed.push(em + ' (' + A.friendly(e) + ')');
      }); });
    }, Promise.resolve()).then(function () {
      IV.rows = null;
      if (ok) toast(ok === 1 ? 'Code sent to ' + list[0] + '.' : ok + ' codes sent.', { t: 'Invite sent' });
      renderInvites();
      if (failed.length) setTimeout(function () { var e2 = $('#iv-err'); if (e2) e2.textContent = 'Not sent: ' + failed.join('; '); }, 400);
    }, function (e) { btn.disabled = false; A.fail(e); });
  }
  A.register('invites', { render: renderInvites });

})();
