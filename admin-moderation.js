/* Admin screens: Verification, Reports and Activity log (real data). Plugs into window.BAdmin from admin-backend.js. */
(function () {
  'use strict';
  var A = window.BAdmin;
  if (!A) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, ico = A.ico, ini = A.ini, rel = A.rel, fmtD = A.fmtD, fmtDT = A.fmtDT, ST = A.ST, ph = A.ph, rpc = A.rpc, toast = A.toast;
  var lock = A.lock;

  /* ------------------------------------------------------------------ verification */
  var V = { tab: 'pending', rows: null };
  function loadV() {
    return Promise.all(['pending', 'approved', 'rejected'].map(function (s) { return rpc('admin_list_verification', { p_status: s }); })).then(function (r) {
      V.rows = { pending: r[0] || [], approved: r[1] || [], rejected: r[2] || [] };
    });
  }
  function renderVerify() {
    if (V.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadV().then(function () { if (ST.view === 'verify') renderVerify(); }, A.fail);
      return;
    }
    var tabs = [['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected']];
    var list = V.rows[V.tab];
    var sub = function (q) { return esc(A.instLabel(q.institute_id) + (q.campus ? ' ' + q.campus : '')) + ' · ' + esc(q.branch || '—') + ' · ' + esc(q.year || '—'); };
    A.view().innerHTML = ph('Verification', 'Certificates waiting for a decision. You can approve or reject any of them yourself.') +
      '<div class="seg" role="group" aria-label="Show">' + tabs.map(function (t) { return '<button type="button" data-qf="' + t[0] + '" aria-pressed="' + (V.tab === t[0]) + '">' + t[1] + ' <span class="n">' + V.rows[t[0]].length + '</span></button>'; }).join('') + '</div>' +
      (list.length ? '<div class="qgrid">' + list.map(function (q) {
        var a = Number(q.approvals), need = Number(q.needed);
        var when = q.status === 'pending' ? 'Sent ' + rel(q.created_at).toLowerCase() : (q.status === 'approved' ? 'Approved ' : 'Rejected ') + rel(q.decided_at).toLowerCase() + (q.decided_by_name ? ' by ' + esc(q.decided_by_name) : '');
        var pips = ''; for (var i = 0; i < need; i++) pips += '<i class="' + (i < a ? 'on' : '') + '"></i>';
        return '<article class="card qc"><div class="qc-h">' + ini(q.name, q.kind === 'student' ? 'stu' : 'alum') + '<div><b>' + esc(q.name) + '</b><span class="sub">' + sub(q) + '</span></div>' + A.kindPill(q.kind) + '</div>' +
          '<div class="file">' + ico('doc', 15) + '<span class="ell">' + (q.has_file ? 'Certificate file' : 'File already deleted') + '</span>' + (q.has_file ? '<button class="btn ghost sm" type="button" data-qv="' + q.request_id + '">' + ico('eye', 14) + 'View</button>' : '') + '</div>' +
          '<div class="qc-top"><span class="appr"><span class="pips" aria-hidden="true">' + pips + '</span>' + a + ' of ' + need + ' approved</span><span class="qc-by">' + when + '</span></div>' +
          (q.asked_at ? '<p class="res">' + ico('mail', 14) + '<span>Asked for a clearer file ' + rel(q.asked_at).toLowerCase() + '.</span></p>' : '') +
          (q.status === 'rejected' ? '<p class="quote">' + esc(q.reject_reason || '') + (q.reject_note ? ' ' + esc(q.reject_note) : '') + '</p>' : '') +
          (q.status === 'pending' ? '<div class="qc-a"><button class="btn primary sm" type="button" data-qa="' + q.request_id + '"' + lock('verify') + '>' + ico('check', 14) + 'Approve</button><button class="btn secondary sm neg" type="button" data-qr="' + q.request_id + '"' + lock('verify') + '>' + ico('x', 14) + 'Reject</button><button class="btn ghost sm wide" type="button" data-qn="' + q.request_id + '"' + lock('verify') + '>' + ico('mail', 14) + 'Ask for a clearer file</button></div>' : '') +
          '</article>';
      }).join('') + '</div>' : '<section class="card"><div class="empty">' + ico('check', 20) + '<span>' + (V.tab === 'pending' ? 'No one is waiting. New certificates show up here.' : 'Nothing here yet.') + '</span></div></section>');
    var find = function (id) { return V.rows[V.tab].filter(function (q) { return q.request_id === id; })[0]; };
    $$('[data-qf]').forEach(function (b) { b.addEventListener('click', function () { V.tab = b.dataset.qf; renderVerify(); }); });
    $$('[data-qv]').forEach(function (b) { b.addEventListener('click', function () { viewFile(find(b.dataset.qv)); }); });
    $$('[data-qa]').forEach(function (b) { b.addEventListener('click', function () { approve(find(b.dataset.qa)); }); });
    $$('[data-qr]').forEach(function (b) { b.addEventListener('click', function () { reject(find(b.dataset.qr)); }); });
    $$('[data-qn]').forEach(function (b) { b.addEventListener('click', function () { askNew(find(b.dataset.qn)); }); });
  }
  function afterDecision(msg, o) {
    return loadV().then(function () { A.members.reload(); A.refreshCounts(); if (ST.view === 'verify') renderVerify(); toast(msg, o); });
  }
  function conflict(e) { if (/not_pending/.test(e.message || '')) { return loadV().then(function () { A.refreshCounts(); if (ST.view === 'verify') renderVerify(); throw e; }); } throw e; }
  function approve(q) {
    if (!q) return;
    var left = Number(q.needed) - Number(q.approvals);
    A.confirmBox({ t: 'Approve ' + q.name + '?', sub: left > 0 ? 'You are approving without waiting for ' + left + ' more volunteer' + (left === 1 ? '' : 's') + '. They will be listed straight away and we will email them.' : 'They will be listed straight away and we will email them.', ok: 'Approve and list' }, function () {
      return rpc('admin_decide_verification', { p_request: q.request_id, p_decision: 'approve' }).then(function () { return afterDecision(q.name + ' is listed now. We emailed them.', { t: 'Approved' }); }, conflict);
    });
  }
  function reject(q) {
    if (!q) return;
    A.confirmBox({
      t: 'Reject ' + q.name + '\'s request?', sub: 'We will email them the reason and the file is deleted. They can try again.', ok: 'Reject', danger: true,
      body: '<div class="fld"><label class="label" for="rj">Reason</label><select class="input" id="rj"><option>The name on the certificate does not match.</option><option>The institute, branch or year does not match.</option><option>The file is unreadable.</option><option>It is not a valid certificate.</option></select></div><div class="fld"><label class="label" for="rjn">Note to them <span class="muted" style="font-weight:400">(optional)</span></label><textarea class="input" id="rjn" rows="2" maxlength="300"></textarea></div>'
    }, function (md) {
      return rpc('admin_decide_verification', { p_request: q.request_id, p_decision: 'reject', p_reason: $('#rj', md).value, p_note: $('#rjn', md).value.trim() || null }).then(function () { return afterDecision('We emailed ' + q.name.split(' ')[0] + ' the reason.', { t: 'Rejected', k: 'info' }); }, conflict);
    });
  }
  function askNew(q) {
    if (!q) return;
    A.confirmBox({ t: 'Ask for a new file?', sub: 'We will email ' + q.email + '. The request stays in the queue.', ok: 'Send email',
      body: '<div class="fld"><label class="label" for="nf">Message</label><textarea class="input" id="nf" rows="3" maxlength="300">The file you sent is hard to read. Could you upload a clearer scan or photo?</textarea></div>' }, function (md) {
      var msg = $('#nf', md).value.trim();
      if (!msg) throw new Error('reason_required');
      return rpc('admin_ask_clearer_file', { p_request: q.request_id, p_msg: msg }).then(function () { return afterDecision('Sent to ' + q.email + '.', { t: 'Email sent', k: 'info', i: 'mail' }); }, conflict);
    });
  }
  function viewFile(q) {
    if (!q) return;
    var m = A.modal(A.mdHead('Certificate: ' + q.name, 'Admins see the whole file. Volunteers see only four lines: name, institute, branch and year.') + '<div id="cf" style="min-height:120px;display:grid;place-items:center"><span class="help">Loading…</span></div><div class="md-f"><button class="btn primary" type="button" data-mclose>Close</button></div>', 'Certificate');
    rpc('admin_get_certificate', { p_request: q.request_id }).then(function (f) {
      var box = $('#cf', m); if (!box) return;
      var bin = atob(f.data), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
      box.innerHTML = /^image\//.test(f.mime) ? '<img alt="Certificate" src="' + url + '" style="max-width:100%;max-height:70vh;border-radius:8px">' : '<iframe title="Certificate" src="' + url + '" style="width:100%;height:70vh;border:0;border-radius:8px"></iframe>';
      var obs = new MutationObserver(function () { if (!m.isConnected) { URL.revokeObjectURL(url); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
    }, function (e) { var box = $('#cf', m); if (box) box.innerHTML = '<span class="help" style="color:var(--neg-fg)">' + esc(A.friendly(e)) + '</span>'; });
  }
  A.register('verify', { render: renderVerify });

  /* ------------------------------------------------------------------ reports */
  var R = { tab: 'open', rows: null };
  var sev = function (r) { return /Harassment/.test(r) ? 'neg' : /Spam/.test(r) ? 'warn' : ''; };
  var tstPill = function (r) { return r.target_status === 'suspended' ? '<span class="pill neg dot">Suspended</span>' : !r.target_listed ? '<span class="pill warn dot">Hidden</span>' : '<span class="pill pos dot">Listed</span>'; };
  function loadR() {
    return Promise.all(['open', 'resolved', 'dismissed'].map(function (s) { return rpc('admin_list_reports', { p_status: s }); })).then(function (r) {
      R.rows = { open: r[0] || [], resolved: r[1] || [], dismissed: r[2] || [] };
    });
  }
  function renderReports() {
    if (R.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadR().then(function () { if (ST.view === 'reports') renderReports(); }, A.fail);
      return;
    }
    var tabs = [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']];
    var list = R.rows[R.tab];
    A.view().innerHTML = ph('Reports', 'Listings members have reported. Reporters stay anonymous to other members. Aim to close each within 3 days.') +
      '<div class="seg" role="group" aria-label="Show">' + tabs.map(function (t) { return '<button type="button" data-rf="' + t[0] + '" aria-pressed="' + (R.tab === t[0]) + '">' + t[1] + ' <span class="n">' + R.rows[t[0]].length + '</span></button>'; }).join('') + '</div>' +
      (list.length ? '<div class="qgrid">' + list.map(function (r) {
        var live = r.target_exists, id = r.report_id;
        return '<article class="card qc"><div class="qc-top"><span class="pill ' + sev(r.reason_label) + '">' + esc(r.reason_label) + '</span><span class="qc-by">' + rel(r.created_at) + '</span></div>' +
          '<div class="qc-h">' + ini(r.target_name, '') + '<div>' + (live ? '<button class="lnkb" type="button" data-rm="' + r.target_id + '" style="font-weight:600">' + esc(r.target_name) + '</button>' : '<b>' + esc(r.target_name) + '</b>') + '<span class="sub">' + (live ? esc(A.instLabel(r.institute_id)) : 'Profile deleted') + ' · reported by ' + esc(r.reporter_name || 'a member') + '</span></div>' + (live ? tstPill(r) : '') + '</div>' +
          (r.note ? '<p class="quote">' + esc(r.note) + '</p>' : '<p class="help">No details given.</p>') +
          (r.status !== 'open' ? '<p class="res">' + ico('check', 14) + '<span><b style="font-weight:500">' + esc(r.resolution || '') + '</b> ' + esc(r.resolved_by_name || '') + ', ' + rel(r.resolved_at).toLowerCase() + '.</span></p>'
            : '<div class="qc-a">' + (live ? '<button class="btn secondary sm" type="button" data-ra="hide" data-r="' + id + '"' + lock('suspend') + (r.target_listed ? '' : ' disabled') + '>' + ico('eyeoff', 14) + 'Hide listing</button><button class="btn secondary sm" type="button" data-ra="suspend" data-r="' + id + '"' + lock('suspend') + (r.target_status === 'suspended' ? ' disabled' : '') + '>' + ico('ban', 14) + 'Suspend</button>' : '') +
              '<button class="btn secondary sm" type="button" data-ra="resolve" data-r="' + id + '"' + lock('reports') + '>' + ico('check', 14) + 'Mark resolved</button><button class="btn ghost sm" type="button" data-ra="dismiss" data-r="' + id + '"' + lock('reports') + '>Dismiss</button>' +
              (live ? '<button class="btn ghost sm neg wide" type="button" data-ra="delete" data-r="' + id + '"' + lock('delete') + '>' + ico('trash', 14) + 'Delete profile</button>' : '') + '</div>') +
          '</article>';
      }).join('') + '</div>' : '<section class="card"><div class="empty">' + ico('check', 20) + '<span>' + (R.tab === 'open' ? 'No open reports.' : 'Nothing here yet.') + '</span></div></section>');
    $$('[data-rf]').forEach(function (b) { b.addEventListener('click', function () { R.tab = b.dataset.rf; renderReports(); }); });
    $$('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { A.go('members', { arg: b.dataset.rm }); }); });
    $$('[data-ra]').forEach(function (b) { b.addEventListener('click', function () { reportAction(R.rows.open.filter(function (x) { return x.report_id === b.dataset.r; })[0], b.dataset.ra); }); });
  }
  function reportAction(r, a) {
    if (!r) return;
    if (a === 'delete') {
      A.members.ensure(r.target_id).then(function (m) { if (!m) { toast('That profile is already gone.', { k: 'info' }); return loadR().then(renderReports); } A.members.remove(m, function () { loadR().then(function () { R.tab = 'resolved'; if (ST.view === 'reports') renderReports(); }); }); }, A.fail);
      return;
    }
    var nm = r.target_name;
    var C = {
      hide: ['Hide ' + nm + '\'s listing?', 'They can still sign in, but nobody finds them in the directory.', 'Hide listing', 'Hid the listing.'],
      suspend: ['Suspend ' + nm + '?', 'They cannot sign in and are not listed until you reinstate them.', 'Suspend', 'Suspended the account.'],
      resolve: ['Mark this report resolved?', 'Say what you did, for the record.', 'Mark resolved', 'Handled it.'],
      dismiss: ['Dismiss this report?', 'Use this when nothing was wrong. The reporter is not told.', 'Dismiss', 'Nothing wrong found.']
    }[a];
    A.confirmBox({ t: C[0], sub: C[1], ok: C[2], danger: a === 'suspend',
      body: '<div class="fld"><label class="label" for="rn">Note <span class="muted" style="font-weight:400">(for the team)</span></label><textarea class="input" id="rn" rows="2" maxlength="300" placeholder="' + (a === 'resolve' ? 'e.g. Talked to them and they removed the link.' : 'Optional') + '"></textarea></div>' }, function (md) {
      return rpc('admin_close_report', { p_id: r.report_id, p_action: a, p_note: $('#rn', md).value.trim() || null }).then(function () {
        return loadR().then(function () { A.members.reload(); A.refreshCounts(); if (ST.view === 'reports') renderReports(); toast(a === 'dismiss' ? 'The report is closed.' : C[3], { t: a === 'dismiss' ? 'Dismissed' : 'Report resolved', k: a === 'dismiss' ? 'info' : 'pos' }); });
      }, function (e) { if (/not_open/.test(e.message || '')) { return loadR().then(function () { A.refreshCounts(); if (ST.view === 'reports') renderReports(); throw e; }); } throw e; });
    });
  }
  A.register('reports', { render: renderReports });

  /* ------------------------------------------------------------------ activity log */
  var LT = { auth: 'Sign-ins', signup: 'Sign-ups', profile: 'Profiles', contact: 'Contacts', verify: 'Verification', report: 'Reports', admin: 'Team actions' };
  var L = { t: '', q: '', r: '7d', rows: [], more: false, busy: false, seq: 0 };
  var RANGES = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
  var LCOLS = '--cols:110px minmax(0,1.2fr) minmax(0,1.5fr) minmax(0,1.1fr) minmax(0,1.4fr);--cols-t:96px minmax(0,1.2fr) minmax(0,1.5fr) minmax(0,1fr);--cols-m:minmax(0,1fr)';
  var LPAGE = 60;
  // "Chrome · macOS" from a raw browser string
  function devLabel(ua) {
    if (!ua) return '—';
    var b = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var o = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? b + ' · ' + o : b;
  }
  function renderLogs() {
    if (ST.lq) { L.q = ST.lq; ST.lq = ''; L.r = 'all'; L.t = ''; }
    A.view().innerHTML = ph('Activity log', 'Every sign-in, change and team action. Entries cannot be edited or deleted.', A.can('export') ? '<button class="btn secondary" type="button" id="lExp">' + ico('download', 16) + 'Export CSV</button>' : '') +
      '<section class="card"><div class="tools"><label class="srch">' + ico('search', 15) + '<input class="input" id="lQ" type="search" placeholder="Person, action or detail" aria-label="Search the log" value="' + esc(L.q) + '"></label>' +
      '<select class="input" id="lR" aria-label="Time range">' + RANGES.map(function (k) { return '<option value="' + k[0] + '"' + (L.r === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select><span class="cnt" id="lN"></span>' +
      '<div class="chips" style="width:100%" role="group" aria-label="Type"><button class="chip" type="button" data-lt="" aria-pressed="' + (!L.t) + '">All</button>' + Object.keys(LT).map(function (k) { return '<button class="chip" type="button" data-lt="' + k + '" aria-pressed="' + (L.t === k) + '"><span class="lt ' + k + '"><i></i></span>' + LT[k] + '</button>'; }).join('') + '</div></div>' +
      '<div id="lList"></div></section>';
    var timer = null;
    $('#lQ').addEventListener('input', function (e) { L.q = e.target.value; clearTimeout(timer); timer = setTimeout(function () { fetchLogs(true); }, 250); });
    $('#lR').addEventListener('change', function (e) { L.r = e.target.value; fetchLogs(true); });
    $$('[data-lt]').forEach(function (b) { b.addEventListener('click', function () { L.t = b.dataset.lt; $$('[data-lt]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); fetchLogs(true); }); });
    if ($('#lExp')) $('#lExp').addEventListener('click', exportLog);
    fetchLogs(true);
  }
  function fetchLogs(reset) {
    var my = ++L.seq, before = reset || !L.rows.length ? null : L.rows[L.rows.length - 1].id;
    if (reset) { L.rows = []; L.more = false; $('#lList').innerHTML = '<div class="empty"><span>Loading…</span></div>'; }
    return rpc('admin_list_log', { p_range: L.r, p_type: L.t || 'all', p_q: L.q, p_before: before, p_limit: LPAGE }).then(function (rows) {
      if (my !== L.seq || ST.view !== 'logs') return;
      L.rows = L.rows.concat(rows || []); L.more = (rows || []).length === LPAGE;
      drawLogs();
    }, function (e) { if (my === L.seq) { A.fail(e); if ($('#lList')) $('#lList').innerHTML = ''; } });
  }
  function drawLogs() {
    if (!$('#lList')) return;
    $('#lN').textContent = L.rows.length + (L.more ? '+' : '') + ' event' + (L.rows.length === 1 ? '' : 's');
    $('#lList').innerHTML = '<div class="tr th" style="' + LCOLS + '"><span>When</span><span>Who</span><span>Action</span><span>About</span><span class="ht">Details</span></div>' +
      (L.rows.length ? L.rows.map(function (x) {
        return '<details class="lg"><summary class="tr" style="' + LCOLS + '"><span class="sub hm" title="' + esc(fmtDT(x.at)) + '">' + rel(x.at) + '</span><span class="who">' + ini(x.who, A.logCls(x.role)) + '<span><b>' + esc(x.who) + '</b><small class="ro">' + esc(x.role) + '</small><small class="mo">' + esc(x.act + (x.target ? ': ' + x.target : '')) + ' · ' + rel(x.at) + '</small></span></span>' +
          '<span class="lt hm ' + esc(x.type) + (x.sev ? ' ' + esc(x.sev) : '') + '"><i></i>' + esc(x.act) + '</span><span class="hm ell">' + esc(x.target || '—') + '</span><span class="hm ht ell sub">' + esc(x.detail || '') + '</span></summary>' +
          '<div class="lg-d"><div><small>Time</small>' + esc(fmtDT(x.at)) + '</div><div><small>Device</small>' + esc(devLabel(x.device)) + '</div><div><small>IP address</small>' + esc(x.ip || '—') + '</div><div><small>Event ID</small><code>ev-' + esc(x.id) + '</code></div>' + (x.target ? '<div><small>About</small>' + esc(x.target) + '</div>' : '') + (x.detail ? '<div style="grid-column:span 3"><small>Details</small>' + esc(x.detail) + '</div>' : '') + '</div></details>';
      }).join('') : '<div class="empty">' + ico('activity', 20) + '<span>No activity matches.</span></div>') +
      (L.more ? '<div class="more"><button class="btn secondary sm" type="button" id="lMore">Show more</button></div>' : '');
    if ($('#lMore')) $('#lMore').addEventListener('click', function () { this.disabled = true; fetchLogs(false); });
  }
  function exportLog() {
    var b = $('#lExp'); b.disabled = true;
    rpc('admin_export_log', { p_range: L.r, p_type: L.t || 'all', p_q: L.q }).then(function (rows) {
      A.download('bridges-activity.csv', A.csv([['Time', 'Who', 'Role', 'Type', 'Action', 'About', 'Details', 'Device', 'IP', 'Event ID']].concat((rows || []).map(function (x) { return [x.at, x.who, x.role, LT[x.type], x.act, x.target, x.detail, devLabel(x.device), x.ip, 'ev-' + x.id]; }))));
    }).catch(A.fail).finally(function () { b.disabled = false; });
  }
  A.register('logs', { render: renderLogs });
})();
