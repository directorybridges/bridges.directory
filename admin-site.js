/* Admin screens: Page text, Roles and permissions, Settings (real data). Plugs into window.BAdmin from admin-backend.js. */
(function () {
  'use strict';
  var A = window.BAdmin;
  if (!A) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, ico = A.ico, ini = A.ini, rel = A.rel, fmtDT = A.fmtDT, ST = A.ST, ph = A.ph, rpc = A.rpc, toast = A.toast;
  var DATA = window.BADMIN_DATA || { PAGES: [], OPEN: [], OPEN_FOR: {} };
  var PAGES = DATA.PAGES || [];
  var GLOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  /* ------------------------------------------------------------------ page text */
  var S = { page: 'home', draft: {} };
  var pub = function (pg, k) { return A.pageText(pg, k); };
  var def = function (pg, k) { return A.pageDefault(pg, k); };
  var cur = function (pg, k) { return S.draft[pg] && S.draft[pg][k] != null ? S.draft[pg][k] : pub(pg, k); };
  var dirtyN = function (pg) { return S.draft[pg] ? Object.keys(S.draft[pg]).filter(function (k) { return S.draft[pg][k] !== pub(pg, k); }).length : 0; };
  var pageOf = function (id) { return PAGES.filter(function (p) { return p.id === id; })[0]; };
  var hist = {};

  // the page body may only use a few tags; the preview strips everything else, the database refuses it on publish
  function cleanHtml(html) {
    var doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html'), rootEl = doc.getElementById('r');
    var ok = { H3: 1, P: 1, UL: 1, LI: 1, B: 1, A: 1, BR: 1 };
    (function walk(n) {
      Array.prototype.slice.call(n.childNodes).forEach(function (c) {
        if (c.nodeType === 1) {
          if (!ok[c.tagName]) { c.remove(); return; }
          Array.prototype.slice.call(c.attributes).forEach(function (a) {
            if (!(c.tagName === 'A' && a.name === 'href' && /^https:\/\//i.test(a.value))) c.removeAttribute(a.name);
          });
          if (c.tagName === 'A') { c.setAttribute('rel', 'noopener noreferrer'); c.setAttribute('target', '_blank'); }
          walk(c);
        } else if (c.nodeType !== 3) c.remove();
      });
    })(rootEl);
    return rootEl.innerHTML;
  }
  function previewHtml(p) {
    var v = function (k) { return esc(cur(p.id, k)); };
    if (p.pv === 'hero') return '<div class="pv hero"><h4>' + v('h') + '</h4><p>' + v('lede') + '</p><div class="pb"><span>' + v('b1') + '</span><span class="s">' + v('b2') + '</span></div></div>';
    if (p.pv === 'head') return '<div class="pv"><span class="eb">' + v('eb') + '</span><h4>' + v('h') + '</h4><p>' + v('lede') + '</p>' + (p.g ? '<span class="gbtn">' + GLOGO + '<span>' + v('b1') + '</span></span>' : '<div class="pb"><span>' + v('b1') + '</span></div>') + '</div>';
    if (p.pv === 'footer') return '<div class="pv"><b style="font-size:1.0625rem;letter-spacing:-.02em">Bridges<span class="muted" style="font-weight:400">.directory</span></b><p>' + v('about') + '</p><p class="help">' + v('note') + '</p></div>';
    if (p.pv === 'toast') return '<div class="pv" style="gap:10px">' + [['in_t', 'in', 'check'], ['out_t', 'out', 'x'], ['list_t', 'list', 'check']].map(function (t) { return '<div class="tst"><span class="ini" style="width:28px;height:28px;background:var(--pos-bg);color:var(--pos-fg)">' + ico(t[2], 14) + '</span><div><b>' + v(t[0]) + '</b><p>' + v(t[1]) + '</p></div></div>'; }).join('') + '</div>';
    if (p.pv === 'email') return '<div class="pv"><div class="mail"><span class="sub">From Bridges.directory &lt;no-reply@bridges.directory&gt;</span><b>' + v('fac_s') + '</b><pre>' + v('fac_b') + '</pre></div><div class="mail"><span class="sub">Other subject lines</span><b>' + v('code_s') + '</b><b>' + v('inv_s') + '</b><b>' + v('ref_s') + '</b></div></div>';
    return '<div class="pv"><span class="eb">' + esc(p.eb || 'Legal') + '</span><h4>' + v('t') + '</h4><p>' + v('lede') + '</p><div class="lgl">' + cleanHtml(cur(p.id, 'body')) + '</div></div>';
  }
  function loadHist(pg) { return rpc('admin_content_history', { p_page: pg }).then(function (r) { hist[pg] = r || []; }, function () { hist[pg] = []; }); }

  function renderContent() {
    if (!pageOf(S.page)) S.page = 'home';
    var p = pageOf(S.page), n = dirtyN(p.id), E = A.can('content');
    if (!hist[p.id]) { loadHist(p.id).then(function () { if (ST.view === 'content' && S.page === p.id) renderContent(); }); }
    var grps = []; PAGES.forEach(function (x) { if (grps.indexOf(x.grp) < 0) grps.push(x.grp); });
    var h = hist[p.id] || [];
    A.view().innerHTML = ph('Page text', 'Edit the words on any page, notification or email. Changes stay a draft until you publish. Words in {braces} fill in automatically, so keep them.') +
      '<div class="ce"><nav class="ce-l" aria-label="Pages">' + grps.map(function (g) {
        return '<div class="nav-h">' + g + '</div>' + PAGES.filter(function (x) { return x.grp === g; }).map(function (x) { return '<button type="button" data-pg="' + x.id + '" aria-current="' + (x.id === p.id) + '">' + esc(x.n) + (dirtyN(x.id) ? '<span class="dot" aria-label="Unpublished changes"></span>' : '') + '</button>'; }).join('');
      }).join('') + '</nav>' +
      '<div class="ce-f"><select class="input ce-sel" id="pgSel" aria-label="Page">' + grps.map(function (g) { return '<optgroup label="' + g + '">' + PAGES.filter(function (x) { return x.grp === g; }).map(function (x) { return '<option value="' + x.id + '"' + (x.id === p.id ? ' selected' : '') + '>' + esc(x.n) + (dirtyN(x.id) ? ' (edited)' : '') + '</option>'; }).join('') + '</optgroup>'; }).join('') + '</select>' +
      '<section class="card"><div class="card-h"><div><h3>' + esc(p.n) + '</h3>' + (p.path ? '<a class="sub" href="index.html' + esc(p.path) + '" target="_blank" rel="noopener noreferrer">Shows on ' + esc(p.path) + ' ' + ico('ext', 12) + '</a>' : '<span class="sub">Sent or shown by the site</span>') + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (n ? '<button class="btn ghost sm" type="button" id="cDis">Discard</button>' : '') + '<button class="btn primary sm" type="button" id="cPub"' + (n && E ? '' : ' disabled') + '>' + (n ? 'Publish ' + n + ' change' + (n === 1 ? '' : 's') : 'No changes') + '</button></div></div>' +
      '<div class="card-b"><div id="cPv">' + previewHtml(p) + '</div>' +
      (E ? '' : '<div class="callout">' + ico('lock', 15) + '<span>Your role can read page text but cannot change it.</span></div>') +
      p.f.map(function (f) {
        var k = f[0], l = f[1], dv = f[2], t = f[3], val = cur(p.id, k), ch = val !== pub(p.id, k), cust = val !== dv;
        return '<div class="fld' + (ch ? ' chg' : '') + '" data-fk="' + k + '"><div class="fld-h"><label class="label" for="c-' + k + '">' + esc(l) + '</label>' + (ch ? '<span class="pill warn">Draft</span>' : cust ? '<span class="pill">Edited</span>' : '') + (cust && E ? '<button class="lnkb" type="button" data-cdef="' + k + '">Reset to default</button>' : '') + '</div>' +
          (t ? '<textarea class="input' + (t === 'h' ? ' code-ta' : '') + '" id="c-' + k + '" rows="' + (t === 'h' ? 14 : Math.min(8, Math.max(2, Math.ceil(val.length / 80) + (val.split('\n').length - 1)))) + '" data-ck="' + k + '"' + (E ? '' : ' disabled') + '>' + esc(val) + '</textarea>' : '<input class="input" id="c-' + k + '" data-ck="' + k + '" value="' + esc(val) + '"' + (E ? '' : ' disabled') + '>') +
          '<span class="cc">' + val.length + ' characters' + (t === 'h' ? ' · HTML: h3, p, ul, li, a, b' : '') + '</span></div>';
      }).join('') + '</div></section>' +
      '<section class="card"><div class="card-h"><h3>Published changes</h3></div><div class="card-b">' + (h.length ? '<div class="hist">' + h.map(function (x) { return '<div><span>' + x.n + ' field' + (x.n === 1 ? '' : 's') + ' by ' + esc(x.by_name) + '</span><span class="sub">' + fmtDT(x.at) + '</span></div>'; }).join('') + '</div>' : '<p class="help">No changes published for this page yet. It shows the default text.</p>') + '</div></section></div></div>';
    $$('[data-pg]').forEach(function (b) { b.addEventListener('click', function () { S.page = b.dataset.pg; renderContent(); window.scrollTo(0, 0); }); });
    $('#pgSel').addEventListener('change', function (e) { S.page = e.target.value; renderContent(); });
    $$('[data-ck]').forEach(function (i) {
      i.addEventListener('input', function () {
        var k = i.dataset.ck; S.draft[p.id] = S.draft[p.id] || {}; S.draft[p.id][k] = i.value;
        $('#cPv').innerHTML = previewHtml(p);
        var fl = i.closest('.fld'), ch = i.value !== pub(p.id, k);
        fl.classList.toggle('chg', ch);
        $('.cc', fl).firstChild.textContent = i.value.length + ' characters' + (i.classList.contains('code-ta') ? ' · HTML: h3, p, ul, li, a, b' : '');
        var n2 = dirtyN(p.id), b = $('#cPub'); b.disabled = !n2 || !E; b.textContent = n2 ? 'Publish ' + n2 + ' change' + (n2 === 1 ? '' : 's') : 'No changes';
        if (!!n2 !== !!$('#cDis') || ch !== !!$('.pill.warn', fl)) { var pos = i.selectionStart; renderContent(); var j = $('#c-' + k); j.focus(); try { j.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
      });
    });
    $$('[data-cdef]').forEach(function (b) { b.addEventListener('click', function () { var k = b.dataset.cdef; S.draft[p.id] = S.draft[p.id] || {}; S.draft[p.id][k] = def(p.id, k); renderContent(); }); });
    if ($('#cDis')) $('#cDis').addEventListener('click', function () { S.draft[p.id] = {}; renderContent(); toast('Back to the published text.', { t: 'Draft discarded', k: 'info', i: 'undo' }); });
    $('#cPub').addEventListener('click', function () { publish(p); });
  }
  function publish(p) {
    var ks = Object.keys(S.draft[p.id] || {}).filter(function (k) { return S.draft[p.id][k] !== pub(p.id, k); });
    if (!ks.length) return;
    var label = function (k) { return p.f.filter(function (x) { return x[0] === k; })[0][1]; };
    A.confirmBox({ t: 'Publish ' + ks.length + ' change' + (ks.length === 1 ? '' : 's') + ' to ' + p.n + '?', sub: 'Everyone sees the new text straight away.', ok: 'Publish',
      body: '<div class="mini">' + ks.map(function (k) { return '<div><b style="font-weight:500">' + esc(label(k)) + '</b><span>' + (S.draft[p.id][k] === def(p.id, k) ? 'Back to default' : 'Changed') + '</span></div>'; }).join('') + '</div>' }, function () {
      var changes = {};
      ks.forEach(function (k) { changes[k] = S.draft[p.id][k] === def(p.id, k) ? null : S.draft[p.id][k]; });
      return rpc('admin_publish_content', { p_page: p.id, p_changes: changes, p_labels: ks.map(label).join(', ') }).then(function () {
        return rpc('get_content');
      }).then(function (rows) {
        A.setContent(rows); S.draft[p.id] = {}; delete hist[p.id];
        if (ST.view === 'content') renderContent();
        toast(p.n + ' has the new text.', { t: 'Published' });
      });
    });
  }
  A.register('content', { render: renderContent });

  /* ------------------------------------------------------------------ roles and permissions */
  var T = { rows: null };
  function loadTeam() {
    return Promise.all([rpc('admin_list_team'), rpc('admin_get_perms')]).then(function (r) {
      T.rows = r[0] || [];
      ST.matrix = {};
      (r[1] || []).forEach(function (x) { (ST.matrix[x.role] = ST.matrix[x.role] || {})[x.perm] = x.allowed; });
    });
  }
  function renderRoles() {
    if (T.rows === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      loadTeam().then(function () { if (ST.view === 'roles') renderRoles(); }, A.fail);
      return;
    }
    var can = A.can('team'), ROLES = A.ROLES, lim = (ST.ov && ST.ov.limit) || 5;
    var pill = function (r) { return '<span class="pill' + (r === 'Owner' ? ' fac' : '') + '">' + r + '</span>'; };
    A.view().innerHTML = ph('Roles and permissions', 'Who is on the team and what each role can do. "Preview the admin as" in the menu shows the admin through a role\'s eyes.', can ? '<button class="btn primary" type="button" id="tInv">' + ico('uplus', 16) + 'Invite a teammate</button>' : '') +
      '<section class="card"><div class="card-h"><h3>Team</h3><span class="sub">' + T.rows.length + ' people</span></div><div class="tbl" style="--cols:minmax(200px,2fr) 170px 120px 40px;--cols-m:minmax(0,1fr) auto"><div class="tr th"><span>Name</span><span>Role</span><span>Last active</span><span></span></div>' +
      T.rows.map(function (t, i) {
        var key = t.user_id || ('inv:' + t.email);
        return '<div class="tr"><span class="who">' + ini(t.name, 'team') + '<span><b>' + esc(t.name) + (t.is_me ? ' <span class="muted" style="font-weight:400">(you)</span>' : '') + '</b><small>' + esc(t.email) + '</small></span></span>' +
          '<span>' + (t.role === 'Owner' || !can || t.invited ? pill(t.role) : '<select class="input" data-trole="' + esc(key) + '" aria-label="Role for ' + esc(t.name) + '" style="height:34px">' + ROLES.slice(1).map(function (r) { return '<option' + (r === t.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>') + '</span>' +
          '<span class="sub hm">' + (t.invited ? 'Invited, not signed in yet' : rel(t.last_signin)) + '</span><span class="hm">' + (t.role !== 'Owner' && can ? '<button class="ib" type="button" data-trm="' + esc(key) + '" aria-label="Remove ' + esc(t.name) + '">' + ico('trash', 15) + '</button>' : '') + '</span></div>';
      }).join('') + '</div></section>' +
      '<section class="card"><div class="card-h"><h3>What each role can do</h3>' + (can ? '<span class="sub">Changes save straight away</span>' : '<span class="sub">Only the owner can change these</span>') + '</div><div class="mx"><table><thead><tr><th scope="col">Permission</th>' + ROLES.map(function (r) { return '<th scope="col">' + r + '<small>' + A.ROLE_DESC[r] + '</small></th>'; }).join('') + '</tr></thead><tbody>' +
      A.PERMS.map(function (pm) {
        return '<tr><td>' + pm[1] + '</td>' + ROLES.map(function (r) { return '<td><input type="checkbox" data-perm="' + r + '|' + pm[0] + '" aria-label="' + r + ': ' + pm[1] + '"' + (r === 'Owner' || (ST.matrix[r] && ST.matrix[r][pm[0]]) ? ' checked' : '') + (r === 'Owner' || !can ? ' disabled' : '') + '></td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></section>' +
      '<section class="card"><div class="card-h"><h3>What members can do</h3><span class="sub">Set by the site\'s rules</span></div><div class="card-b rules">' +
      '<div>' + A.kindPill('student') + '<ul><li>Sign in with Google, verify with an institute email code or a certificate</li><li>Browse and open ' + lim + ' contacts a week</li><li>Volunteer to check certificates</li><li>Edit their own profile</li></ul></div>' +
      '<div>' + A.kindPill('alum') + '<ul><li>Sign in with Google, verify with a certificate or a referral code</li><li>Browse and open ' + lim + ' contacts a week</li><li>Refer other alumni from their institute</li><li>Edit their own profile</li></ul></div>' +
      '<div>' + A.kindPill('faculty') + '<ul><li>Sign in with an ID and password from the team</li><li>Browse and open ' + lim + ' contacts a week</li><li>Never listed in the directory</li><li>Cannot edit their profile or password</li></ul></div></div></section>';
    var byKey = function (k) { return T.rows.filter(function (t) { return (t.user_id || ('inv:' + t.email)) === k; })[0]; };
    var reload = function () { T.rows = null; A.refreshCounts(); if (ST.view === 'roles') renderRoles(); };
    if ($('#tInv')) $('#tInv').addEventListener('click', function () {
      A.confirmBox({ t: 'Invite a teammate', sub: 'They sign in to the admin with this Google account. We email them the link.', ok: 'Send invite',
        body: '<div class="fld"><label class="label" for="ti-n">Name</label><input class="input" id="ti-n" maxlength="80"></div><div class="fld"><label class="label" for="ti-e">Google account</label><input class="input" id="ti-e" type="email" placeholder="name@gmail.com"></div><div class="fld"><label class="label" for="ti-r">Role</label><select class="input" id="ti-r">' + ROLES.slice(1).map(function (r) { return '<option' + (r === 'Moderator' ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></div>' }, function (md) {
        var n = $('#ti-n', md).value.trim(), e = $('#ti-e', md).value.trim().toLowerCase();
        if (!n) { $('#ti-n', md).focus(); throw new Error('name_required'); }
        if (!A.validEmail(e)) { $('#ti-e', md).focus(); throw new Error('bad_email'); }
        return rpc('admin_invite_teammate', { p_name: n, p_email: e, p_role: $('#ti-r', md).value }).then(function () { reload(); toast(n + ' can sign in as ' + $('#ti-r', md).value + ' once they sign in with that Google account.', { t: 'Invite sent', i: 'mail' }); });
      });
    });
    $$('[data-trole]').forEach(function (s) {
      s.addEventListener('change', function () {
        var t = byKey(s.dataset.trole), old = t.role;
        rpc('admin_set_role', { p_user: t.user_id, p_role: s.value }).then(function () { reload(); toast(t.name + ' is now ' + (s.value === 'Admin' ? 'an ' : 'a ') + s.value + '.', { t: 'Role changed' }); }, function (e) { s.value = old; A.fail(e); });
      });
    });
    $$('[data-trm]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = byKey(b.dataset.trm);
        A.confirmBox({ t: 'Remove ' + t.name + (t.invited ? '\'s invite?' : ' from the team?'), sub: t.invited ? 'The invite stops working.' : 'They lose access to the admin straight away. Their past actions stay in the log.', ok: 'Remove', danger: true }, function () {
          return (t.invited ? rpc('admin_cancel_invite', { p_email: t.email }) : rpc('admin_remove_teammate', { p_user: t.user_id })).then(function () { reload(); toast(t.name + (t.invited ? '\'s invite is cancelled.' : ' no longer has admin access.'), { t: 'Removed', k: 'info' }); });
        });
      });
    });
    $$('[data-perm]').forEach(function (c) {
      c.addEventListener('change', function () {
        var pr = c.dataset.perm.split('|'), l = A.PERMS.filter(function (x) { return x[0] === pr[1]; })[0][1];
        rpc('admin_set_perm', { p_role: pr[0], p_perm: pr[1], p_allowed: c.checked }).then(function () {
          (ST.matrix[pr[0]] = ST.matrix[pr[0]] || {})[pr[1]] = c.checked; A.renderSide();
          toast(pr[0] + 's ' + (c.checked ? 'can now ' : 'can no longer ') + l.charAt(0).toLowerCase() + l.slice(1) + '.', { t: 'Permissions updated', i: 'lock' });
        }, function (e) { c.checked = !c.checked; A.fail(e); });
      });
    });
  }
  A.register('roles', { render: renderRoles });

  /* ------------------------------------------------------------------ settings */
  var G = { cur: null };
  function renderSettings() {
    if (G.cur === null) {
      A.view().innerHTML = '<div class="empty"><span>Loading…</span></div>';
      rpc('admin_get_settings').then(function (s) { G.cur = s; if (ST.view === 'settings') renderSettings(); }, A.fail);
      return;
    }
    var s = JSON.parse(JSON.stringify(G.cur)), E = A.can('settings');
    var row = function (t, p, ctl) { return '<div class="set"><div><b>' + t + '</b><p class="help">' + p + '</p></div><div class="ctl">' + ctl + '</div></div>'; };
    A.view().innerHTML = ph('Settings', 'Rules that apply across Bridges.directory.') +
      '<section class="card">' +
      row('Contacts per week', 'How many contacts each member can open in a week. You can change it for one person from their profile.', '<input class="input" id="s-limit" type="number" min="1" max="30" value="' + s.limit + '" style="max-width:120px">') +
      row('Volunteer approvals', 'How many volunteers must approve a certificate before someone is listed. An admin can always approve on their own.', '<div class="seg" role="group" aria-label="Approvals needed">' + [1, 2, 3].map(function (n) { return '<button type="button" data-ap="' + n + '" aria-pressed="' + (s.approvals === n) + '">' + n + '</button>'; }).join('') + '</div>') +
      row('Institute emails for codes', 'Students with an address on these domains can verify with a 6-digit code. Turn one off to send that institute\'s students to certificate checks instead.', '<div class="doms">' + ST.instRows.map(function (i) { return '<label><span><b style="font-weight:500">' + esc(i.short) + '</b> <code>@' + esc(i.email_domain) + '</code></span><span class="tgl" style="flex:none"><input type="checkbox" data-dom="' + esc(i.id) + '" aria-label="' + esc(i.short) + '"' + (s.domains[i.id] !== false ? ' checked' : '') + '></span></label>'; }).join('') + '</div>') +
      row('Sign-ups', 'Pause new sign-ups without affecting existing members.', '<label class="tgl"><span><b>Open for new members</b></span><input type="checkbox" id="s-su"' + (s.signups ? ' checked' : '') + '></label><textarea class="input" id="s-pm" rows="2" maxlength="300" aria-label="Message while paused"' + (s.signups ? ' hidden' : '') + '>' + esc(s.pause_msg) + '</textarea>') +
      row('Site notice', 'A short message at the top of every page, for maintenance or news.', '<label class="tgl"><span><b>Show a notice</b></span><input type="checkbox" id="s-bn"' + (s.banner_on ? ' checked' : '') + '></label><input class="input" id="s-bm" maxlength="300" placeholder="e.g. Bridges will be down for 10 minutes at 11 pm tonight." value="' + esc(s.banner_msg) + '"' + (s.banner_on ? '' : ' hidden') + '>') +
      row('Yearly contribution goal', 'Shown on the Contribute page and the home tile.', '<div style="display:flex;align-items:center;gap:8px"><span class="muted">₹</span><input class="input" id="s-goal" type="number" min="0" step="500" value="' + s.goal + '" style="max-width:160px"></div>') +
      '<div class="savebar"><span class="help" id="s-n">No unsaved changes</span><button class="btn primary" type="button" id="s-save" disabled>Save settings</button></div></section>';
    if (!E) $$('#view input,#view textarea,#view [data-ap],#s-save').forEach(function (i) { i.disabled = true; });
    var label = { limit: 'Contacts per week', approvals: 'Volunteer approvals', domains: 'Institute emails', signups: 'Sign-ups', pause_msg: 'Pause message', banner_on: 'Site notice', banner_msg: 'Notice text', goal: 'Contribution goal' };
    var diff = function () { return Object.keys(label).filter(function (k) { return JSON.stringify(s[k]) !== JSON.stringify(G.cur[k]); }); };
    var upd = function () { var n = diff().length; $('#s-n').textContent = n ? n + ' unsaved change' + (n === 1 ? '' : 's') : 'No unsaved changes'; $('#s-save').disabled = !n || !E; };
    $('#s-limit').addEventListener('input', function (e) { s.limit = Math.max(1, Math.min(30, +e.target.value || 1)); upd(); });
    $$('[data-ap]').forEach(function (b) { b.addEventListener('click', function () { s.approvals = +b.dataset.ap; $$('[data-ap]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); upd(); }); });
    $$('[data-dom]').forEach(function (c) { c.addEventListener('change', function () { s.domains[c.dataset.dom] = c.checked; upd(); }); });
    $('#s-su').addEventListener('change', function (e) { s.signups = e.target.checked; $('#s-pm').hidden = s.signups; upd(); });
    $('#s-pm').addEventListener('input', function (e) { s.pause_msg = e.target.value; upd(); });
    $('#s-bn').addEventListener('change', function (e) { s.banner_on = e.target.checked; $('#s-bm').hidden = !s.banner_on; upd(); });
    $('#s-bm').addEventListener('input', function (e) { s.banner_msg = e.target.value; upd(); });
    $('#s-goal').addEventListener('input', function (e) { s.goal = Math.max(0, Math.round(+e.target.value || 0)); upd(); });
    $('#s-save').addEventListener('click', function () {
      var ks = diff(); if (!ks.length) return;
      var send = {}; ks.forEach(function (k) { send[k] = s[k]; });
      var b = $('#s-save'); b.disabled = true;
      rpc('admin_save_settings', { p: send }).then(function () {
        G.cur = null; return Promise.all([rpc('admin_get_settings'), rpc('admin_overview')]);
      }).then(function (r) {
        G.cur = r[0]; ST.ov = r[1];
        if (ST.view === 'settings') renderSettings();
        toast(ks.map(function (k) { return label[k]; }).join(', ') + '.', { t: 'Settings saved' });
      }).catch(function (e) { b.disabled = false; A.fail(e); });
    });
  }
  A.register('settings', { render: renderSettings });
})();
