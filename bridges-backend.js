/* Bridges.directory: wires the member site (Atharva's index.html) to the real Supabase backend.
 *
 * Does nothing unless window.BRIDGES.enabled is true (?backend=1, ?backend=0 turns it off), so the
 * site stays exactly the prototype until the owner flips it on. Never edit index.html for this:
 * Atharva's artifact replaces it every few hours.
 *
 * How it attaches. The prototype's script is one closed function, so its state (S, people, queue)
 * and its functions can't be reached from outside. This file therefore does a small, safe rewrite
 * of the page it was loaded into (phase 1): it fetches the same page, adds a few lines to the
 * prototype's script (a hook, "don't restore the fake session", "start after we know who you are")
 * and re-opens the document. Phase 2 (this file runs again, now with the hook) replaces the
 * prototype's invented data with real data and routes every action through Supabase.
 * tools/wire-backend.js could do the same rewrite at build time; this keeps working without it.
 */
(function () {
  'use strict';
  var B = window.BRIDGES;
  if (!B || !B.enabled) return;

  /* ONE flag for the QR-code question. Aman's chat says volunteers scan the QR to check the name;
     the agreed schedule says QR codes must be covered. The redaction tool gets this flag; flip it
     here once Aman decides. */
  var COVER_QR = true;

  if (typeof window.__BRX !== 'function') { attach(); return; }
  try { sessionStorage.removeItem('bridges-hook-tried'); } catch (e) {}
  window.__BRDONE = true;
  try { run(); } catch (e) { console.error('[bridges] backend failed to start', e); window.__BRBOOT && window.__BRBOOT(); }

  /* =============================================================== phase 1: attach the hook */
  function attach() {
    /* The flag stops an endless reload loop. It stores the time, and counts only for 20 seconds, so a refresh or an
       interrupted load can never leave a tab stuck on the error. */
    var KEY = 'bridges-hook-tried', tried = !!window.__BRHOOKING;
    try { var at = Number(sessionStorage.getItem(KEY)); tried = tried || (at > 0 && Date.now() - at < 20000); } catch (e) {}
    if (tried) return banner('The backend could not attach to this page. Open the site with ?backend=0 to go back to the prototype.');
    window.__BRHOOKING = true;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) {}
    document.documentElement.style.visibility = 'hidden';
    fetch(location.pathname + location.search, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var out = patch(html);
        if (!out) { document.documentElement.style.visibility = ''; return banner('The page changed shape, so the backend could not attach. Open with ?backend=0 for the prototype.'); }
        document.open(); document.write(out); document.close();
      })
      .catch(function () { document.documentElement.style.visibility = ''; banner('The backend could not attach (no connection?).'); });
  }
  function banner(t) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;padding:12px 16px;border-radius:12px;background:#7a1f1f;color:#fff;font:14px/1.4 system-ui';
    d.textContent = t; (document.body || document.documentElement).appendChild(d);
  }
  function patch(h) {
    var miss = [];
    function rep(a, b) { if (h.indexOf(a) < 0) { miss.push(a.slice(0, 48)); return; } h = h.replace(a, function () { return b; }); }
    function repRe(re, b) { if (!re.test(h)) { miss.push(String(re).slice(0, 48)); return; } h = h.replace(re, function () { return b; }); }
    /* 1. the hook, and no fake "stay logged in" session */
    repRe(/loadSession\(\);\s*renderNav\(\);/, "window.__BRX=function(c){return eval(c)};\nif(!(window.BRIDGES&&window.BRIDGES.enabled))loadSession();\nrenderNav();");
    rep('function saveSession(){', 'function saveSession(){ if(window.BRIDGES&&window.BRIDGES.enabled)return;');
    /* 2. start only once we know who is signed in (falls back after 5 s) */
    repRe(/\nroute\(\);\s*animatePage\(\);\s*\}\)\(\);/, "\nwindow.__BRBOOT=function(){if(window.__BRBOOTED)return;window.__BRBOOTED=1;route();animatePage();};\nif(!(window.BRIDGES&&window.BRIDGES.enabled)){window.__BRBOOT();}else{setTimeout(window.__BRBOOT,5000);}\n})();");
    /* 3. one helper the backend replaces */
    rep('const maskEmail =', 'let maskEmail =');
    if (miss.length) { console.warn('[bridges] could not patch:', miss); return null; }
    return h;
  }

  /* =============================================================== phase 2: the wiring */
  function run() {
    var X = window.__BRX;
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
    var S = X('S'), people = X('people'), queue = X('queue'), faculty = X('faculty'), IB = X('IB'), FUND = X('FUND');
    var F = function (n) { return X(n).apply(null, [].slice.call(arguments, 1)); };
    var toast = function (m, o) { return F('toast', m, o); };
    function setFn(n, f) { window.__brtmp = f; try { X(n + '=window.__brtmp'); } finally { delete window.__brtmp; } }
    var sb = window.supabase.createClient(B.supabaseUrl, B.publishableKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    var BR = { uid: null, contacts: {}, bypass: false, peopleAt: 0, fundAt: 0, queueAt: 0, counts: {}, settling: null, booted: false, reportTarget: null, rejectId: null };
    window.__BR = { sb: sb, state: BR, coverQR: COVER_QR };   // handy in the console and for tests

    var ERR = {
      not_signed_in: 'Please sign in again.', profile_exists: 'You already have a profile.', bad_institute: 'Pick your institute again.', bad_campus: 'Pick your campus again.',
      email_domain_mismatch: 'That is not an address at your institute.', too_many_requests: 'Too many tries. Please wait a little and try again.', too_many_attempts: 'Too many tries. Please wait a little.',
      already_verified: 'You are already verified.', students_only: 'Only students can verify with an institute email.', no_active_code: 'That code has expired. Ask for a new one.',
      request_pending: 'Your certificate is already with the volunteers.', bad_file_size: 'That file is too large.', limit_reached: 'You have used all your contacts for this week.',
      verified_only: 'Only verified members can do that.', not_found: 'That person is no longer listed.', own_contact: 'That is your own listing.', own_listing: 'That is your own listing.',
      consent_required: 'Please tick the box to continue.', application_exists: 'You have already applied.', verified_students_only: 'Only verified students can volunteer.',
      number_mismatch: 'That does not match the number you registered.', not_a_volunteer: 'You are not a volunteer.', volunteers_only: 'Only volunteers can do that.',
      own_application: 'You cannot review your own application.', already_reviewed: 'You have already reviewed this one.', not_pending: 'Someone has already decided this one.',
      signups_paused: 'Sign-ups are paused right now. Please try again later.', account_blocked: 'This account cannot be used on Bridges.directory. Write to us if you think this is a mistake.', codes_off: 'Email codes are switched off for your institute right now. Upload your certificate instead.',
      file_deleted: 'That file has already been deleted.', upload_failed: 'The file did not go through. Check your connection and try again.', database_error: 'Something went wrong on our side. Please try again.', server_error: 'Something went wrong on our side. Please try again.', verified_alums_only: 'Only verified alumni can refer.', bad_email: 'Enter a valid email address.', amount_too_small: 'The smallest contribution is ₹10.'
    };
    function why(e) {
      var m = (e && e.message) || '';
      if (m === 'signups_paused' && window.BPublic && window.BPublic.pause_msg) return window.BPublic.pause_msg;
      if (ERR[m]) return ERR[m];
      if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Check your internet and try again.';
      return 'Something went wrong. Please try again.';
    }
    function rpc(n, a) { return sb.rpc(n, a || {}).then(function (r) { if (r.error) throw r.error; return r.data; }); }
    function ok(r) { if (r.error) throw r.error; return r.data; }

    /* ---------- quiet the prototype's "this is a demo" notes ---------- */
    var st = document.createElement('style');
    st.textContent = '.demo{display:none!important}.dr-f{display:none!important}.ft-b span:last-child:not(:first-child){display:none}';
    document.head.appendChild(st);

    /* ---------- shapes: database row -> the prototype's person ---------- */
    var VM = { institute_email: 'email', certificate: 'documents', referral: 'referral' };
    var normLinks = function (l) { return (Array.isArray(l) ? l : []).map(function (x) { return { t: x.t || 'portfolio', url: x.url || '', name: x.name || '' }; }).filter(function (x) { return x.url; }); };
    function mapRow(r) {
      var exp = Array.isArray(r.experiences) ? r.experiences : [], x = exp[0] || {};
      return { id: r.id, kind: r.kind, name: r.name, inst: r.institute_id || '', campus: r.campus || '', branch: r.branch || '', year: r.year || 0,
        works: r.kind === 'alum' ? (x.f != null ? +x.f : 0) : -1, role: x.role || '', org: x.org || '', exp: r.kind === 'alum' ? exp : [], open: r.helps || [],
        v: VM[r.verify_method] || 'email', email: '', email2: '', cemail: '', av: r.avatar && typeof r.avatar === 'object' ? r.avatar : {}, links: [], site: '',
        vrec: { at: r.verified_at ? new Date(r.verified_at) : new Date(), r: [] }, vol: !!r.is_volunteer };
    }
    function mapVapp(a) {
      if (!a) return null;
      var at = new Date(a.created_at);
      if (a.status === 'pending') return { phone: a.phone, status: 'review', at: at };
      if (a.status === 'approved') return { phone: a.phone, status: 'approved', at: at };
      if (a.status === 'rejected') return { phone: a.phone, status: 'rejected', at: at, why: 'We could not verify that number.' };
      return null;
    }
    function buildMe(stt, user) {
      var row = stt.row, priv = stt.priv || {}, g = (user.email || '').toLowerCase(), p = mapRow(row);
      if (row.kind === 'faculty') {
        /* faculty title and department live in experiences[0] (title/dept, or role/org) until the team decides otherwise */
        var x0 = (Array.isArray(row.experiences) && row.experiences[0]) || {};
        p.fid = (g.split('@')[0] || '').toUpperCase(); p.title = x0.title || x0.role || 'Faculty'; p.dept = x0.dept || x0.org || row.branch || '';
        p.email = g; p.exp = []; p.open = [];
      } else if (row.kind === 'student') {
        p.email = priv.email_institute || g; p.email2 = priv.email_institute ? g : '';
      } else {
        p.email = g; p.cemail = priv.email_personal && priv.email_personal.toLowerCase() !== g ? priv.email_personal : '';
      }
      p.googleEmail = g; p.links = normLinks(priv.links); p.volPhone = priv.vol_phone || ''; p.volApp = mapVapp(stt.vapp); p.fresh = false;
      return p;
    }
    function merge(t, s) { Object.keys(s).forEach(function (k) { if (s[k] !== undefined) t[k] = s[k]; }); return t; }
    var nameFromEmail = function (em) { return (String(em).split('@')[0] || '').split(/[._\-+0-9]+/).filter(Boolean).map(function (w) { return w[0].toUpperCase() + w.slice(1); }).join(' ') || 'New member'; };

    /* ---------- loading ---------- */
    async function fetchMe(user) {
      var row = ok(await sb.from('profiles').select('*').eq('id', user.id).maybeSingle());
      if (!row) return { row: null };
      var priv = ok(await sb.from('profile_private').select('*').eq('id', user.id).maybeSingle()) || {};
      var vapp = ok(await sb.from('volunteer_applications').select('*').eq('user_id', user.id).maybeSingle());
      return { row: row, priv: priv, vapp: vapp };
    }
    async function loadSettings() {
      try { var rows = ok(await sb.from('settings').select('key,value')); rows.forEach(function (r) { if (r.key === 'weekly_contacts') S.limit = +r.value || S.limit; }); } catch (e) {}
    }
    function makeReveals(week, old) {
      var w = {}; week.forEach(function (i) { w[i] = 1; }); var o = new Set(old);
      return new Proxy(w, { get: function (t, k) { return typeof k === 'string' ? ((k in t || o.has(k)) ? 1 : undefined) : t[k]; } });
    }
    async function loadContacts() {
      var left = await rpc('contacts_left'), rows = (await rpc('my_contacts')) || [];
      var used = Math.max(0, S.limit - left);
      BR.contacts = {}; rows.forEach(function (r) { BR.contacts[r.target_id] = { email: r.email || '', links: normLinks(r.links) }; });
      var ids = rows.map(function (r) { return r.target_id; }), week = ids.slice(0, used), old = ids.slice(used);
      for (var i = week.length; i < used; i++) week.push('_n' + i);   // opened people who are no longer listed still use up the week
      S.reveals = makeReveals(week, old);
    }
    // "n|time" of the directory as the database has it now; the directory is only downloaded again when this changes
    async function dirVersion() { try { var v = await rpc('directory_version'); return v ? v.n + '|' + v.at : ''; } catch (e) { return ''; } }
    async function loadDirectory() {
      var ver = await dirVersion();
      var rows = [], from = 0, size = 1000, cols = 'id,kind,name,institute_id,campus,branch,year,helps,avatar,experiences,verify_method,verified_at,is_volunteer,listed,verified';
      for (;;) {
        var r = ok(await sb.from('profiles').select(cols).eq('listed', true).eq('verified', true).eq('status', 'active').order('name').order('id').range(from, from + size - 1));
        rows = rows.concat(r); if (r.length < size) break; from += size;
      }
      var me = S.user; people.length = 0;
      rows.forEach(function (r) {
        if (!(r.listed && r.verified)) return;
        if (!IB[r.institute_id]) { console.warn('[bridges] unknown institute', r.institute_id); return; }
        if (me && r.id === me.id) { people.push(me); return; }
        var p = mapRow(r), c = BR.contacts[r.id]; if (c) { p.cemail = c.email; p.links = c.links; }
        people.push(p);
      });
      BR.peopleAt = Date.now(); BR.dirVer = ver;
      try { (await rpc('institute_counts')).forEach(function (c) { BR.counts[c.institute_id] = { alums: +c.alums, students: +c.students }; }); } catch (e) {}
    }
    async function loadRefs() {
      var me = S.user; if (!me || me.kind !== 'alum') return;
      var rows = (await rpc('my_referrals')) || [];
      me.refs = rows.map(function (r) { return { email: r.invitee_email, name: '', code: '', at: r.status === 'expired' ? new Date(Date.now() - 15 * 864e5) : new Date(r.created_at), status: r.status === 'joined' ? 'joined' : 'pending' }; });
    }
    async function loadFund() {
      var p = await rpc('contribution_progress');
      if (p && p[0]) { FUND.goal = Math.round(p[0].target_paise / 100); FUND.raised = p[0].raised_paise / 100; }
      var g = (await rpc('recent_contributions', { p_limit: 10 })) || [];
      FUND.gifts = g.map(function (x) {
        var anon = x.name === 'Anonymous', pe = anon ? null : people.filter(function (q) { return q.name === x.name; })[0];
        return { name: x.name, av: anon ? -1 : (pe ? pe.av : {}), amt: x.amount_paise / 100, at: new Date(x.paid_at) };
      });
      BR.fundAt = Date.now();
    }
    function mapQ(r) {
      var n = r.approvals || 0;
      return { id: r.request_id, kind: r.kind || 'alum', name: r.name || 'New member', inst: r.institute_id, campus: r.campus || '', branch: r.branch || '', year: r.year || '',
        works: -1, role: '', org: '', open: [], email: '', approvals: new Array(n).fill('•'), status: 'pending', file: 'Certificate (redacted)', fileUrl: 'pending', fileType: '', at: new Date(r.submitted_at) };
    }
    async function loadQueue() {
      if (!S.user || !S.user.vol) { queue.length = 0; return; }
      var rows;
      try { rows = await rpc('volunteer_queue_details'); }
      catch (e) { rows = ((await rpc('volunteer_queue')) || []).map(function (r) { return { request_id: r.request_id, institute_id: r.institute_id, submitted_at: r.submitted_at }; }); }
      var keep = queue.filter(function (q) { return q.status !== 'pending' && !q.mine; });
      queue.length = 0; (rows || []).forEach(function (r) { queue.push(mapQ(r)); }); keep.forEach(function (k) { queue.push(k); });
      BR.queueAt = Date.now();
    }
    async function loadMember() {
      await loadSettings();
      await loadContacts();
      await loadDirectory();
      await Promise.all([loadRefs().catch(function () {}), loadFund().catch(function () {}), loadQueue().catch(function () {})]);
    }

    /* ---------- who is signed in, and what do they need to do next ---------- */
    function clearMember() {
      S.user = null; S.reveals = {}; people.length = 0; queue.length = 0; BR.contacts = {}; BR.uid = null; BR.dirVer = '';
      S.join = { step: 1, kind: 'student', d: null, method: 'email', file: null, consent: false, qid: null, viaInstant: false, code: '', otp: null, g: '', gn: '' };
    }
    function dFromRow(row, priv, g) {
      var exp = Array.isArray(row.experiences) ? row.experiences : [], x = exp[0] || {};
      return { name: row.name, inst: row.institute_id, campus: row.campus || '', branch: row.branch || '', year: String(row.year || ''), email: g, open: row.helps || [], links: normLinks(priv.links),
        exp: exp, works: x.f != null ? +x.f : 0, role: x.role || '', org: x.org || '', av: row.avatar || 0, cemail: '', email2: '' };
    }
    async function settle() {
      if (BR.settling) return BR.settling;
      BR.settling = (async function () {
        var s = (await sb.auth.getSession()).data.session;
        if (!s) { clearMember(); return 'out'; }
        BR.uid = s.user.id;
        var stt = await fetchMe(s.user), J = S.join, g = (s.user.email || '').toLowerCase(),
          meta = s.user.user_metadata || {}, gn = meta.full_name || meta.name || nameFromEmail(g);
        if (!stt.row) {                                   // signed in with Google, no profile yet
          S.user = null; J.g = g; J.gn = gn; J.step = 1; J.d = Object.assign({}, J.d || {}); if (!J.d.name) J.d.name = gn;
          return 'profile';
        }
        var me = buildMe(stt, s.user);
        if (me.kind !== 'faculty' && !stt.row.verified) { // has a profile, still has to prove it
          S.user = null; J.g = g; J.gn = gn; J.kind = me.kind; J.d = dFromRow(stt.row, stt.priv, g); J.otp = null;
          var rs = {}; try { rs = (await rpc('my_request_status')) || {}; } catch (e) {}
          queue.length = 0; J.qid = null;
          if (rs.status === 'pending') {
            queue.push({ id: 'q-me', kind: me.kind, name: me.name, inst: me.inst, campus: me.campus, branch: me.branch, year: me.year, approvals: [], status: 'pending', mine: true, file: '', at: new Date(rs.submitted_at) });
            J.qid = 'q-me'; J.step = 3;
          } else { J.step = 2; J.method = me.kind === 'student' ? 'email' : 'upload'; if (rs.status === 'rejected') J.method = 'upload', BR.note = rejectNote(rs.reason); }
          return 'verify';
        }
        S.user = me; BR.uid = me.id;
        await loadMember();
        return 'member';
      })().finally(function () { BR.settling = null; });
      return BR.settling;
    }
    function rejectNote(r) {
      return { name_mismatch: 'The volunteers could not match the name.', unreadable: 'The file was not readable.', not_a_certificate: 'The file did not look like a certificate.', institute_mismatch: 'The institute did not match.' }[r] || 'The volunteers could not verify it.';
    }
    function goNext(out, fresh) {
      var h = (location.hash || '').replace(/^#/, '').split('/')[0];
      if (out === 'member') {
        try { if (localStorage.getItem('bridges-after-login') === 'admin.html') { localStorage.removeItem('bridges-after-login'); location.href = 'admin.html'; return; } } catch (e) {}
        renderAll();
        if (h === 'login' || h === 'join' || h === '') { if (S.join.step !== 4) location.hash = 'home'; }
        if (fresh) toast('Signed in as ' + S.user.name + '.', { t: 'Welcome back, ' + S.user.name.split(' ')[0] });
      } else if (out === 'profile' || out === 'verify') {
        if (['join', 'terms', 'privacy', 'cookies', 'guidelines', 'about'].indexOf(h) < 0) location.hash = 'join';
        renderAll();
      } else { renderAll(); }
    }
    function renderAll() { F('renderNav'); if (X('parse')().v === 'join') F('renderJoin'); else if (BR.booted) F('route'); }

    /* ---------- Google and faculty sign-in ---------- */
    async function googleSignIn() {
      try {
        var cfg = await fetch(B.supabaseUrl + '/auth/v1/settings', { headers: { apikey: B.publishableKey } }).then(function (r) { return r.json(); });
        if (!(cfg && cfg.external && cfg.external.google)) { toast('Google sign-in is not switched on yet. Faculty can sign in with their ID.', { t: 'Not available yet', k: 'warn' }); return; }
      } catch (e) {}
      try { sessionStorage.setItem('bridges-oauth', '1'); } catch (e) {}
      var r = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
      if (r.error) toast('Could not start Google sign-in. Please try again.', { t: 'Sign-in failed', k: 'warn' });
    }
    async function facultyLogin() {
      var id = $('#f-id').value.trim(), pw = $('#f-pw').value, err = $('#f-err'), L = S.login;
      L.fid = id; $$('#ff .input').forEach(function (i) { i.removeAttribute('aria-invalid'); });
      if (!id || !pw) { err.textContent = 'Enter your faculty ID and password.'; (id ? $('#f-pw') : $('#f-id')).setAttribute('aria-invalid', 'true'); (id ? $('#f-pw') : $('#f-id')).focus(); return; }
      var email = id.indexOf('@') > 0 ? id.toLowerCase() : id.toLowerCase() + '@faculty.bridges.directory';
      var btn = $('#ff button[type="submit"]'); if (btn) btn.disabled = true;
      var r = await sb.auth.signInWithPassword({ email: email, password: pw });
      if (btn) btn.disabled = false;
      if (!r.error && r.data && r.data.user) BR.uid = r.data.user.id;
      if (r.error) {
        var banned = r.error.code === 'user_banned' || /banned/i.test(r.error.message || '');
        err.textContent = banned ? 'This account is switched off. Ask the Bridges team.' : 'That ID and password do not match. Check the email from the Bridges team, or ask them to reset it.';
        if (!banned) sb.rpc('log_faculty_failed', { p_fid: id }).then(function () {}, function () {});
        $('#f-pw').value = ''; $('#f-pw').setAttribute('aria-invalid', 'true'); $('#f-pw').focus(); return;
      }
      sb.rpc('log_signin', { p_faculty: true }).then(function () {}, function () {});
      var out = await settle();
      if (out === 'member') F('signIn', S.user, S.user.kind === 'faculty' ? 'faculty ID ' + S.user.fid : '');
      else goNext(out);
    }
    async function signOutNow() { if (BR.uid) { try { await sb.rpc('log_signout'); } catch (e) {} } try { await sb.auth.signOut(); } catch (e) {} BR.uid = null; }

    /* ---------- join: profile, institute email, certificate, referral ---------- */
    function joinErr(t) { var e = $('#j-err2') || $('#j-err'); if (e) e.textContent = t; }
    async function createProfile() {
      var J = S.join, d = F('readJ1'), err = $('#j-err'); J.d = d; err.textContent = '';
      $$('#jf1 .input').forEach(function (i) { i.removeAttribute('aria-invalid'); });
      function bad(msg, sel) { err.textContent = msg; var el = $(sel); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } }
      if (!d.name) return bad('Enter your full name.', '#j-name');
      if (!d.inst) return bad('Choose your institute.', '#j-inst');
      if (!d.branch) return bad('Choose your branch.', '#j-branch');
      if (!d.year) return bad('Choose your year.', '#j-year');
      if (J.kind === 'alum') {
        if (!d.exp || !d.exp.length) return bad('Add at least one experience.', '#jf1');
        var blank = d.exp.findIndex(function (x) { return !x.role; });
        if (blank >= 0) { var r0 = $$('#jf1 .xp [data-k="role"]')[blank]; if (r0) r0.setAttribute('aria-invalid', 'true'); err.textContent = 'Add a role for each experience, or remove the empty one.'; if (r0) r0.focus(); return; }
        var noField = $$('#jf1 .xp').find(function (r) { return $('[data-k="f"]', r).value === '-1' && !$('[data-k="fo"]', r).value.trim(); });
        if (noField) { var o = $('[data-k="fo"]', noField); o.setAttribute('aria-invalid', 'true'); o.focus(); err.textContent = 'Type your field, or pick one from the list.'; return; }
      }
      if (!d.open.length) return bad('Pick at least one thing you can help with.', '#jf1 .checks input');
      if (!X('checkLinks')($('#j-links'), err)) return;
      var btn = $('#jf1 button[type="submit"]'); if (btn) btn.disabled = true;
      try {
        await rpc('create_my_profile', { p: { kind: J.kind, name: d.name, institute_id: d.inst, campus: d.campus || '', branch: d.branch, year: +d.year, helps: d.open,
          avatar: d.av && typeof d.av === 'object' ? d.av : {}, experiences: J.kind === 'alum' ? d.exp : [], links: d.links || [],
          email_personal: J.kind === 'student' ? J.g : (d.cemail || J.g) } });
      } catch (e) { if (btn) btn.disabled = false; if (e.message !== 'profile_exists') { err.textContent = why(e); return; } }
      var out = await settle(); goNext(out);
    }
    /* certificates in R2: the browser talks to the certificate Worker, which asks the database before it does anything */
    async function certToken() { var s = (await sb.auth.getSession()).data.session; if (!s) throw { message: 'not_signed_in' }; return s.access_token; }
    async function certFail(r) { var j = null; try { j = await r.json(); } catch (e) { /* no body */ } throw { message: (j && j.error) || 'upload_failed' }; }
    async function uploadCert(blob) {
      var id = await rpc('submit_certificate_start', { p_mime: blob.type, p_bytes: blob.size });
      var r = await fetch(B.certWorkerUrl + '/u/' + id, { method: 'PUT', headers: { Authorization: 'Bearer ' + await certToken(), 'Content-Type': blob.type }, body: blob });
      if (!r.ok) await certFail(r);
    }
    async function readCert(id) {
      var r = await fetch(B.certWorkerUrl + '/f/' + id, { headers: { Authorization: 'Bearer ' + await certToken() } });
      if (!r.ok) await certFail(r);
      return r.blob();
    }
    async function toBase64(blob) {
      return new Promise(function (res, rej) { var fr = new FileReader(); fr.onerror = function () { rej(fr.error); }; fr.onload = function () { res(String(fr.result).split(',')[1] || ''); }; fr.readAsDataURL(blob); });
    }
    async function verifyStep(btn) {
      var J = S.join, d = J.d || {}, err = $('#j-err2'); if (err) err.textContent = ''; BR.note = '';
      if (J.method === 'upload') {
        if (!J.fileObj) return joinErr('Choose your certificate first.');
        var cb = $('#j-consent'); if (!cb || !cb.checked) return joinErr('Tick the box to say you are happy for two volunteers to check it.');
        if (!window.BridgesRedact || typeof window.BridgesRedact.open !== 'function') {
          console.warn('[bridges] redact.js is not loaded: refusing to upload an un-redacted certificate.');
          return joinErr('The hiding tool did not load, so nothing was sent. Reload the page and try again.');
        }
        btn.disabled = true;
        try {
          var blob = await window.BridgesRedact.open(J.fileObj, { coverQR: COVER_QR });
          if (!blob) { btn.disabled = false; return; }                       // closed without sending
          if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw { message: 'bad_type' };
          if (blob.size > 8000000) throw { message: 'bad_file_size' };
          if (B.certWorkerUrl) await uploadCert(blob); else await rpc('submit_certificate', { p_mime: blob.type, p_data_base64: await toBase64(blob) });
          var out = await settle(); goNext(out); toast('Sent to the volunteer queue.');
        } catch (e) { btn.disabled = false; joinErr(e.message === 'bad_type' ? 'The hidden copy was not an image. Try again.' : why(e)); }
        return;
      }
      if (J.method === 'email') {
        if (!J.otp) {
          var inp = $('#j-iemail'), dom = IB[d.inst].d, typed = (inp.value || '').trim().toLowerCase();
          inp.removeAttribute('aria-invalid');
          if (!typed || !F('validEmail', typed) || !F('domainOk', typed, d.inst)) { joinErr('Use your ' + dom + ' address.'); inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
          btn.disabled = true;
          try { await rpc('request_email_code', { p_email: typed }); } catch (e) { btn.disabled = false; joinErr(e.message === 'email_domain_mismatch' ? 'Use your ' + dom + ' address.' : why(e)); return; }
          J.iemail = typed; J.otp = { email: typed, code: '', at: Date.now() }; F('renderJoin'); toast('Code sent to ' + typed + '.', { t: 'Check your inbox', k: 'info', i: 'mail' });
          return;
        }
        var code = $$('[data-otp]').map(function (i) { return i.value; }).join('');
        if (code.length !== 6) return joinErr('Enter all 6 digits.');
        btn.disabled = true;
        try {
          var good = await rpc('confirm_email_code', { p_code: code });
          if (!good) { btn.disabled = false; $$('[data-otp]').forEach(function (i) { i.value = ''; }); var f0 = $('[data-otp="0"]'); if (f0) f0.focus(); return joinErr('That code is not right. Check the email and try again.'); }
        } catch (e) { btn.disabled = false; return joinErr(why(e)); }
        /* members see the institute email first (as in the prototype): drop the personal fallback we stored at sign-up */
        try { await sb.from('profile_private').update({ email_personal: null }).eq('id', BR.uid); } catch (e) {}
        await becomeMember('Email confirmed. You\'re listed.', 'email'); return;
      }
      /* referral */
      var rc = ($('#j-code').value || '').trim();
      if (!rc) return joinErr('Enter the referral code from your email.');
      btn.disabled = true;
      try {
        var good2 = await rpc('redeem_referral', { p_code: rc });
        if (!good2) { btn.disabled = false; return joinErr('That code did not work. Check it, or ask your referrer for a new one.'); }
      } catch (e) { btn.disabled = false; return joinErr(why(e)); }
      await becomeMember('You\'re listed.', 'referral');
    }
    async function becomeMember(msg, via) {
      var J = S.join, out = await settle();
      if (out !== 'member') return goNext(out);
      S.user.fresh = true; J.step = 4; J.viaInstant = via !== 'documents'; J.otp = null;
      F('renderNav'); F('renderJoin'); toast(msg, { t: 'You\'re listed' });
    }
    async function checkJoinStatus(silent) {
      var J = S.join; if (J.step !== 3) return;
      var rs = (await rpc('my_request_status')) || {};
      if (rs.status === 'approved') { var out = await settle(); if (out === 'member') { S.user.fresh = true; S.join.step = 4; S.join.viaInstant = false; F('renderNav'); F('renderJoin'); toast('Approved. You\'re now listed.'); } return; }
      if (rs.status === 'rejected') { BR.note = rejectNote(rs.reason); J.step = 2; J.method = 'upload'; J.file = null; J.fileObj = null; queue.length = 0; J.qid = null; F('renderJoin'); return; }
      if (!silent) toast('Still with the volunteers. We\'ll list you as soon as two have approved.', { k: 'info', i: 'info' });
    }
    /* anything after the prototype drew the join page */
    function postJoin() {
      var J = S.join, v = $('#v-join'); if (!v) return;
      if (refPost()) return;
      var jc = $('#j-code', v); if (jc) { jc.maxLength = 15; jc.placeholder = 'Code from your email'; }
      if (J.step === 2) {
        var back = $('[data-jback]', v); if (back) back.remove();
        if (BR.note) { var e2 = $('#j-err2', v); if (e2) e2.textContent = BR.note + ' Upload a new file.'; }
        startOverLink($('.actions', v));
      }
      if (J.step === 3) {
        var mini = $('.mini', v); if (mini) mini.remove();
        var sk = $('[data-jskip]', v); if (sk) sk.closest('.actions').innerHTML = '<button class="btn primary" type="button" data-jstatus>Check status</button>';
        var pm = $('.prog-top .muted', v); if (pm) pm.textContent = 'With the volunteers';
        startOverLink($('.status', v));
      }
    }
    function startOverLink(host) {
      if (!host || $('[data-jstart]', host)) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'lnkb'; b.setAttribute('data-jstart', ''); b.textContent = 'Not right? Delete this profile and start again';
      b.style.justifySelf = 'start'; host.appendChild(b);
    }
    function startOver() {
      var m = F('modal', F('mdHead', 'Start again?', 'This deletes the profile you just made, so you can sign up again with the right details.')
        + '<div class="actions" style="padding-top:var(--sp-m)"><button class="btn danger" type="button" data-delstart>Delete and start again</button><button class="btn ghost" type="button" data-mclose>Cancel</button></div>', 'Start again');
      m.addEventListener('click', async function (ev) {
        if (!ev.target.closest('[data-delstart]')) return;
        try { await rpc('delete_my_account'); } catch (e) { return toast(why(e), { k: 'warn' }); }
        await signOutNow(); clearMember(); m.close(); location.hash = 'join'; F('renderNav'); F('route'); toast('Your profile was deleted. You can sign up again.', { k: 'info', i: 'trash' });
      });
    }

    /* ---------- referral landing: code first, then Google, then the profile, then listed ---------- */
    var REFKEY = 'bridges-ref';
    function rfEsc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function rfNorm(t) { return String(t || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
    function refGet() { try { var o = JSON.parse(localStorage.getItem(REFKEY) || 'null'); if (o && Date.now() - o.at < 3 * 3600 * 1000) return o; localStorage.removeItem(REFKEY); } catch (e) { /* storage blocked */ } return null; }
    function refSet(o) { try { localStorage.setItem(REFKEY, JSON.stringify(Object.assign({ at: Date.now() }, o))); } catch (e) { /* storage blocked */ } }
    function refClear() { try { localStorage.removeItem(REFKEY); } catch (e) { /* storage blocked */ } }
    function refRoute() { var p = (location.hash || '').replace(/^#/, '').split('/'); if (p[0] !== 'join' || p[1] !== 'referral') return null; try { return decodeURIComponent(p[2] || ''); } catch (e) { return p[2] || ''; } }
    function refShell(cur) {
      var steps = ['Referral code', 'Sign in', 'Your profile', 'Listed'], pct = [6, 30, 55, 100][cur - 1], label = cur === 4 ? 'Done' : 'Step ' + cur + ' of 4';
      var items = steps.map(function (t, i) { var n = i + 1, cls = cur > n ? 'done' : cur === n ? 'cur' : ''; return '<li class="' + cls + '"><span class="dot">' + (cls === 'done' ? F('ico', 'check', 10) : '') + '</span><span>' + rfEsc(t) + '</span></li>'; }).join('');
      return '<div class="prog" aria-label="Sign-up progress"><div class="prog-top"><b>' + rfEsc(steps[cur - 1]) + '</b><span class="muted">' + label + '</span></div>'
        + '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="--p:' + pct + '%"></i></div><ol class="steps">' + items + '</ol></div>';
    }
    function refHead() {
      return '<div class="head"><span class="eyebrow">Sign up · Referral</span><h2 class="h2">Sign up with a referral</h2>'
        + '<p class="lede">Someone from your institute vouched for you. Enter the code from your email and you skip verification.</p>'
        + '<p class="help" style="margin-top:6px">No code? <a href="#join/alum"><b>Sign up as an alum</b></a> and verify with your certificate.</p></div>';
    }
    function refPage(cur, inner) { $('#v-join').innerHTML = refHead() + '<div class="wrap" style="display:grid;gap:var(--sp-l)">' + refShell(cur) + (inner || '') + '</div>'; }
    function refFail(msg) { BR.rf = Object.assign(BR.rf || {}, { err: msg, checking: false }); F('renderJoin'); }
    async function refCheck(code) {
      var c = rfNorm(code);
      if (c.length < 4) return refFail('Enter the code from your email.');
      var res; try { res = await rpc('check_referral', { p_code: c }); } catch (e) { return refFail(why(e)); }
      if (!res || !res.ok) return refFail('That code did not work. Check it, or ask your referrer for a new one.');
      refSet({ code: c, kind: res.kind, inst: res.institute_id, iname: res.institute_name, ishort: res.institute_short, by: res.by || '' });
      BR.rf = { change: false, err: '', code: '' }; F('renderJoin');
    }
    function refLanding(rc) {
      var R = BR.rf = BR.rf || { change: false, err: '', code: '' }, ref = refGet();
      if (ref && !R.change && (!rc || rfNorm(rc) === ref.code)) {
        var kindW = ref.kind === 'student' ? 'a student' : 'an alum', who = ref.by ? rfEsc(ref.by) + ' vouched for you' : 'The Bridges team invited you';
        refPage(2, '<div class="form" style="display:grid;gap:var(--sp-m)"><span class="pill pos" style="justify-self:start">' + F('ico', 'check', 12) + ' Code accepted</span>'
          + '<div><h3>' + who + '</h3><p class="help" style="margin-top:4px">' + (ref.by ? rfEsc(ref.by) + ' is a verified alum of ' + rfEsc(ref.iname) + '. ' : '') + 'You\'ll be listed as ' + kindW + ' of ' + rfEsc(ref.iname) + ' and verified as soon as you finish your profile.</p></div>'
          + F('gBtn', 'Continue with Google', 'data-jg')
          + '<p class="help" style="text-align:center">Wrong code? <button class="lnkb" type="button" data-rf-diff>Use a different one</button></p>'
          + '<p class="legal-l">By continuing, you agree to the <a href="#terms">Terms of use</a> and <a href="#privacy">Privacy policy</a>.</p></div>');
        return;
      }
      if (rc && !R.tried && !R.change) { R.tried = true; R.checking = true; R.code = rc; refCheck(rc); }
      refPage(1, '<form class="form" id="rf-form" novalidate style="display:grid;gap:var(--sp-s)"><div><h3>Enter your referral code</h3>'
        + '<p class="help" style="margin-top:4px">It\'s in the email from Bridges.directory. If you opened the link in that email, it\'s already filled in.</p></div>'
        + '<div style="display:flex;gap:var(--sp-xs);flex-wrap:wrap"><input class="input code-in" id="rf-in" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="15" placeholder="Code from your email" style="flex:1 1 200px;max-width:320px" value="' + rfEsc(R.code || rc || '') + '"'
        + (R.err ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit"' + (R.checking ? ' disabled' : '') + '>' + (R.checking ? 'Checking…' : 'Check code') + '</button></div>'
        + '<p class="err" id="rf-err" role="alert">' + rfEsc(R.err || '') + '</p></form>'
        + '<p class="alt-sw" style="text-align:center">Already have an account? <a href="#login">Log in</a></p>');
      var inp = $('#rf-in'); if (inp && !R.checking && !('ontouchstart' in window)) inp.focus();
    }
    /* signed in with Google: the profile page, with the institute fixed by the referral and no "I am" switch */
    function refProfile(ref) {
      var J = S.join, v = $('#v-join'); if (!v) return;
      if (J.kind !== ref.kind) { J.kind = ref.kind; if (J.d) { J.d.year = ''; J.d.open = []; } F('renderJoin'); return; }
      var pr = $('.prog', v); if (pr) pr.outerHTML = refShell(3);
      var eb = $('.head .eyebrow', v); if (eb) eb.textContent = 'Sign up · Referral';
      var h2 = $('.head .h2', v); if (h2) h2.textContent = 'Sign up with a referral';
      var lede = $('.head .lede', v); if (lede) lede.textContent = 'Your code is accepted. Finish your profile and you are listed straight away.';
      var seg = $('[data-jk]', v); if (seg) { var row = seg.closest('.fr'); if (row) row.remove(); }
      var sel = $('#j-inst', v);
      if (sel) {
        $$('option', sel).forEach(function (o) { if (o.value && o.value !== ref.inst && o.value.indexOf(ref.inst + '|') !== 0) o.remove(); });
        $$('optgroup', sel).forEach(function (g) { if (!g.children.length) g.remove(); });
        var real = $$('option', sel).filter(function (o) { return o.value; });
        if (real.length === 1) {                           // only one choice: set it in the form data, then redraw so the branch list opens
          var pt = real[0].value.split('|');
          if (!J.d || J.d.inst !== pt[0] || (J.d.campus || '') !== (pt[1] || '')) { J.d = Object.assign({}, J.d, { inst: pt[0], campus: pt[1] || '', branch: '' }); F('renderJoin'); return; }
          $$('option', sel).filter(function (o) { return !o.value; }).forEach(function (o) { o.remove(); });
        }
        var fr = sel.closest('.fr'), lh = fr && $('.lh span', fr); if (lh) lh.textContent = 'Set by your referral.';
      }
      var btn = $('#jf1 button[type="submit"]', v); if (btn) btn.textContent = 'Finish and get listed';
    }
    /* the profile is saved: use the code at once instead of showing the verification page */
    async function refRedeem(ref) {
      var J = S.join, v = $('#v-join'); if (!v) return;
      v.innerHTML = refHead() + '<div class="wrap" style="display:grid;gap:var(--sp-l)">' + refShell(3) + '<p class="help">Checking your code…</p></div>';
      if (BR.rfBusy) return;
      BR.rfBusy = true;
      var good = false, msg = '';
      try { good = await rpc('redeem_referral', { p_code: ref.code }); if (!good) msg = 'That code did not work. Check it, or ask your referrer for a new one.'; } catch (e) { msg = why(e); }
      BR.rfBusy = false; refClear();
      if (good) { await becomeMember('You\'re listed.', 'referral'); return; }
      J.method = 'referral'; J.code = ref.code; F('renderJoin'); joinErr(msg);
    }
    function refPost() {
      var J = S.join, rc = refRoute();
      if (S.user && rc !== null) { location.hash = 'home'; toast('You already have an account.', { k: 'info', i: 'info' }); return true; }
      if (!J.g && J.step === 1 && !S.user) { if (rc === null) return false; refLanding(rc); return true; }
      var ref = refGet(); if (!ref) return false;
      if (J.step === 1 && J.g) { refProfile(ref); return true; }
      if (J.step === 2) { refRedeem(ref); return true; }
      return false;
    }

    /* ---------- directory actions ---------- */
    async function reveal(btn, e) {
      var id = btn.dataset.reveal; btn.disabled = true;
      try {
        var r = await rpc('reveal_contact', { p_target: id });
        BR.contacts[id] = { email: r.email || '', links: normLinks(r.links) };
        var p = people.filter(function (q) { return q.id === id; })[0]; if (p) { p.cemail = r.email || ''; p.links = BR.contacts[id].links; }
        if (btn.isConnected) { btn.disabled = false; replay(btn); }
      } catch (err) {
        if (btn.isConnected) btn.disabled = false;
        if (err.message === 'limit_reached') { try { await loadContacts(); } catch (x) {} var lim = $('#lim'); if (lim) lim.innerHTML = F('limitHtml'); F('renderList'); }
        toast(why(err), { t: err.message === 'limit_reached' ? 'No contacts left' : 'Could not open it', k: 'warn' });
      }
    }
    function replay(el) { BR.bypass = true; try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } finally { BR.bypass = false; } }
    var REASON = ['wrong_details', 'wrong_details', 'spam', 'harassment', 'other'];
    async function sendReport(btn) {
      var m = btn.closest('.md'), i = m ? $('input[name="rpr"]:checked', m) : null, n = m ? $('#rp-n', m) : null;
      if (!BR.reportTarget) return;
      btn.disabled = true;
      try { await rpc('send_report', { p_target: BR.reportTarget, p_reason: REASON[+(i ? i.value : 4)] || 'other', p_note: n && n.value.trim() ? n.value.trim().slice(0, 500) : null }); }
      catch (e) { btn.disabled = false; return toast(why(e), { k: 'warn' }); }
      btn.disabled = false; replay(btn);
    }
    setFn('openInvite', function () {
      var u = S.user; if (!u) return;
      var m = F('modal', F('mdHead', 'Invite friends', 'Send them this link. They\'ll still verify themselves when they sign up.')
        + '<div class="lnk"><span id="inv-lk">' + F('ico', 'link', 14) + 'Making your link…</span><button class="btn ghost sm" type="button" data-copy disabled>' + F('ico', 'copy', 14) + 'Copy link</button></div>'
        + '<p class="help">The link is yours alone. We don\'t send invite emails for you yet, so share it yourself.</p>'
        + '<div class="md-f"><button class="btn primary" type="button" data-mclose>Done</button></div>', 'Invite friends');
      rpc('create_invite', {}).then(function (tok) {
        var link = location.origin + '/?invite=' + tok;
        $('#inv-lk', m).innerHTML = F('ico', 'link', 14) + F('esc', link.replace(/^https?:\/\//, ''));
        var c = $('[data-copy]', m); c.disabled = false; c.onclick = function () { try { navigator.clipboard.writeText(link); } catch (e) {} toast('Invite link copied.'); };
      }).catch(function (e) { $('#inv-lk', m).textContent = why(e); });
    });

    /* ---------- profile, data, account ---------- */
    async function saveProfile() {
      var u = S.user; if (!u || S.pEdit) return;       // the prototype keeps the form open when something is invalid
      try {
        ok(await sb.from('profiles').update({ avatar: typeof u.av === 'object' ? u.av : {}, experiences: u.kind === 'alum' ? (u.exp || []) : [], helps: u.open }).eq('id', u.id));
        var pp = { links: u.links || [] }; if (u.kind === 'alum') pp.email_personal = u.cemail || u.googleEmail || u.email;
        ok(await sb.from('profile_private').update(pp).eq('id', u.id));
      } catch (e) {
        toast('Saved here, but not on the server. ' + why(e), { t: 'Could not save', k: 'warn' });
        try { var s = (await sb.auth.getSession()).data.session; merge(u, buildMe(await fetchMe(s.user), s.user)); F('renderProfile'); } catch (x) {}
      }
    }
    setFn('exportData', async function (u) {
      try {
        var d = await rpc('export_my_data'), name = 'bridges-' + (u.name || 'me').toLowerCase().replace(/[^a-z]+/g, '-') + '.json';
        var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        toast('A copy of your data was saved as ' + name + '.', { t: 'Download started', k: 'info', i: 'download' });
      } catch (e) { toast(why(e), { t: 'Could not export', k: 'warn' }); }
    });
    async function deleteAccount(btn) {
      btn.disabled = true;
      try { await rpc('delete_my_account'); } catch (e) { btn.disabled = false; return toast(why(e), { k: 'warn' }); }
      try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
      BR.uid = null; btn.disabled = false; replay(btn);
      people.length = 0; queue.length = 0;
    }

    /* ---------- referrals, volunteers, queue ---------- */
    async function sendReferral() {
      var u = S.user; if (!u) return;
      var em = ($('#r-em').value || '').trim(), nm = ($('#r-name').value || '').trim();
      if (!F('validEmail', em)) { var i = $('#r-em'); i.setAttribute('aria-invalid', 'true'); i.focus(); return toast('Enter their email address.', { k: 'warn' }); }
      try { await rpc('create_referral', { p_email: em }); } catch (e) { return toast(why(e), { t: 'Not sent', k: 'warn' }); }
      u.refs = u.refs || []; u.refs.unshift({ email: em.toLowerCase(), name: nm, code: '', at: new Date(), status: 'pending' });
      F('renderRefer');
      F('modal', F('mdHead', 'Referral sent', F('esc', nm || em) + ' will get an email with their code.')
        + '<p class="help">The code works once and expires in 14 days. They enter it at the verify step when they sign up as an alum of ' + F('esc', IB[u.inst].s) + '.</p>'
        + '<div class="md-f"><button class="btn primary" type="button" data-mclose>Done</button></div>', 'Referral sent');
    }
    async function applyVolunteer() {
      var u = S.user; if (!u) return;
      var ph = ($('#v-ph').value || '').replace(/\D/g, '').slice(-10), ck = $('#v-ok');
      if (!/^[6-9]\d{9}$/.test(ph)) { $('#v-ph').setAttribute('aria-invalid', 'true'); $('#v-ph').focus(); return toast('Enter a 10 digit Indian mobile number.', { k: 'warn' }); }
      if (!ck || !ck.checked) return toast('Tick the box to say you are happy for the number to be shared.', { k: 'warn' });
      try { await rpc('apply_volunteer', { p_phone: '+91' + ph, p_consent: true }); } catch (e) { return toast(why(e), { t: 'Not sent', k: 'warn' }); }
      u.volApp = { phone: '+91' + ph, status: 'review', at: new Date() }; F('renderVolunteer'); F('renderNav'); toast('Application submitted.');
    }
    async function stepDownNow(btn) {
      var m = btn.closest('.md'), v = ($('#sd-ph', m).value || '').replace(/\D/g, '').slice(-10), er = $('#sd-err', m);
      try { await rpc('step_down_volunteer', { p_phone: '+91' + v }); }
      catch (e) { er.textContent = e.message === 'number_mismatch' ? 'That does not match the number you registered.' : why(e); $('#sd-ph', m).setAttribute('aria-invalid', 'true'); return; }
      replay(btn); queue.length = 0;
    }
    async function refreshMe(then) {
      var s = (await sb.auth.getSession()).data.session; if (!s || !S.user) return;
      merge(S.user, buildMe(await fetchMe(s.user), s.user)); if (S.user.vol) await loadQueue();
      F('renderNav'); if (then) then();
    }
    var RJ = { 'Name doesn\'t match': 'name_mismatch', 'Wrong institute': 'institute_mismatch', 'Year doesn\'t match': 'other', 'Unreadable file': 'unreadable', 'Other': 'other' };
    setFn('approve', function (q) {
      rpc('review_certificate', { p_request: q.id, p_decision: 'approve' }).then(function (r) {
        toast(r === 'approved' ? q.name + ' is approved and listed.' : 'Approved. It needs one more volunteer.');
      }).catch(function (e) { toast(why(e), { t: 'Not recorded', k: 'warn' }); })
        .then(function () { return loadQueue(); }).then(function () { F('renderNav'); if (X('parse')().v === 'queue') F('renderQueue'); });
    });
    async function rejectNow(btn) {
      var m = btn.closest('.md'), q = queue.filter(function (x) { return x.id === BR.rejectId; })[0]; if (!q) return;
      var label = $('#rj', m).value; btn.disabled = true;
      try { await rpc('review_certificate', { p_request: q.id, p_decision: 'reject', p_reason: RJ[label] || 'other' }); }
      catch (e) { btn.disabled = false; return toast(why(e), { t: 'Not recorded', k: 'warn' }); }
      q.status = 'rejected'; q.why = label; m.close(); toast(q.name + '\'s certificate was rejected.', { k: 'info' });
      await loadQueue(); F('renderNav'); F('renderQueue');
    }
    async function viewDoc(btn) {
      var q = queue.filter(function (x) { return x.id === btn.dataset.doc; })[0]; if (!q) return;
      btn.disabled = true;
      try {
        var r = await rpc('get_certificate', { p_request: q.id }), fileBlob;
        if (r.r2) { if (!B.certWorkerUrl) throw { message: 'upload_failed' }; fileBlob = await readCert(q.id); }
        else { var bin = atob(r.data), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); fileBlob = new Blob([bytes], { type: r.mime }); }
        if (q.fileUrl && q.fileUrl.indexOf('blob:') === 0) URL.revokeObjectURL(q.fileUrl);
        q.fileUrl = URL.createObjectURL(fileBlob); q.fileType = r.mime;
        btn.disabled = false; replay(btn);
        var lg = $('.lb .legend'); if (lg && lg.lastChild && lg.lastChild.nodeType === 3) lg.lastChild.textContent = 'Fields to check. Everything else was hidden before upload.';
      } catch (e) { btn.disabled = false; toast(why(e), { t: 'Could not open it', k: 'warn' }); }
    }

    /* ---------- contributions ---------- */
    async function contribute() {
      var G = S.give, u = S.user; if (!u) return;
      var amt = G.custom ? +G.custom : G.amt, er = $('#g-err'); if (er) er.textContent = '';
      if (!(amt >= 10)) { if (er) er.textContent = 'The smallest contribution is ₹10.'; return; }
      var b = $('#g-go'); if (b) b.disabled = true;
      try { await rpc('start_contribution', { p_amount_paise: Math.round(amt * 100), p_anonymous: !!G.anon, p_name: null }); }
      catch (e) { if (b) b.disabled = false; if (er) er.textContent = why(e); return; }
      if (b) b.disabled = false;
      F('modal', F('mdHead', 'Payments open soon', 'Online payments are not switched on yet, so nothing was charged.')
        + '<p class="help">Thank you for wanting to help. We\'ll open payments shortly, and the amount you chose will be one tap away.</p>'
        + '<div class="md-f"><button class="btn primary" type="button" data-mclose>Done</button></div>', 'Payments open soon');
    }

    /* ---------- render wrappers (draw first, then tidy) ---------- */
    function wrap(name, after) { var orig = X(name); setFn(name, function () { var r = orig.apply(null, arguments); try { after(); } catch (e) { console.error('[bridges]', name, e); } return r; }); }
    wrap('renderLogin', function () { var d = $('#v-login [data-demo], #v-login [data-demofac]'); if (d) { var blk = d.closest('.form'); if (blk) blk.remove(); } });
    wrap('renderJoin', postJoin);
    wrap('renderVolunteer', function () {
      var sim = $('#v-volunteer [data-vsim]');
      if (sim) { var a = sim.closest('.actions'); a.innerHTML = '<button class="btn secondary" type="button" data-vcheck>Check status</button>'; }
    });
    wrap('renderContribute', function () {
      var d = $('#v-contribute .demo'); if (d) { d.className = 'help'; d.style.display = 'block'; d.textContent = 'Online payments open soon. Nothing is charged yet.'; }
      if (Date.now() - BR.fundAt > 15000 && S.user) { BR.fundAt = Date.now(); loadFund().then(function () { var f = document.activeElement; if (X('parse')().v === 'contribute' && !(f && f.id === 'g-custom')) F('renderContribute'); }).catch(function () {}); }
    });
    wrap('renderQueue', function () {
      if (Date.now() - BR.queueAt > 15000 && S.user && S.user.vol) { BR.queueAt = Date.now(); loadQueue().then(function () { if (X('parse')().v === 'queue' && !$('.md')) F('renderQueue'); F('renderNav'); }).catch(function () {}); }
    });
    function staleDir() {
      if (Date.now() - BR.peopleAt < 60000 || !S.user) return; BR.peopleAt = Date.now();
      dirVersion().then(function (v) { if (v && v === BR.dirVer) return null; return loadDirectory(); }).then(function (did) { if (did === null) return; var v = X('parse')().v; if (v === 'directory') F('refreshDir'); else if (v === 'browse') F('renderBrowse'); F('renderNav'); }).catch(function () {});
    }
    wrap('renderDirectory', staleDir); wrap('renderBrowse', staleDir);
    setFn('maskEmail', function () { return 'Email hidden until you open it'; });
    var ftb = $('.ft-b span:last-child'); if (ftb && $('.ft-b span:first-child') !== ftb) ftb.textContent = '';

    /* ---------- events: act before the prototype does, and stop its pretend version ---------- */
    function on(type, sel, fn) {
      window.addEventListener(type, function (e) {
        if (BR.bypass) return;
        var t = e.target && e.target.closest ? e.target.closest(sel) : null; if (!t) return;
        fn(e, t);
      }, true);
    }
    function own(e) { e.preventDefault(); e.stopImmediatePropagation(); }
    function guard(fn) { return function (e, t) { own(e); Promise.resolve().then(function () { return fn(e, t); }).catch(function (x) { console.error('[bridges]', x); toast(why(x), { k: 'warn' }); }); }; }
    on('click', '[data-gsign],[data-jg]', guard(googleSignIn));
    on('click', '[data-demo],[data-demofac]', own);
    on('submit', '#ff', guard(facultyLogin));
    on('click', '[data-jgchange]', guard(async function () { await signOutNow(); clearMember(); location.hash = 'join'; F('renderNav'); F('renderJoin'); }));
    on('submit', '#jf1', guard(createProfile));
    on('click', '[data-jm]', guard(function (e, t) { S.join.method = t.dataset.jm; S.join.otp = null; F('renderJoin'); }));
    on('click', '[data-jback]', own);
    on('click', '[data-jskip]', own);
    on('click', '[data-unfile]', guard(function () { S.join.file = null; S.join.fileObj = null; F('renderJoin'); }));
    on('click', '[data-otpedit]', guard(function () { S.join.otp = null; F('renderJoin'); }));
    on('click', '[data-otprs]', guard(async function () {
      var J = S.join; if (!J.otp) return;
      try { await rpc('request_email_code', { p_email: J.otp.email }); } catch (e) { return toast(why(e), { k: 'warn' }); }
      J.otp.at = Date.now(); F('renderJoin'); toast('Code sent to ' + J.otp.email + '.', { t: 'Check your inbox', k: 'info', i: 'mail' });
    }));
    on('click', '[data-jgo]', guard(function (e, t) { return verifyStep(t); }));
    on('submit', '#rf-form', guard(function () { var R = BR.rf = BR.rf || {}; R.err = ''; R.checking = true; R.tried = true; R.change = false; R.code = $('#rf-in').value; F('renderJoin'); return refCheck(R.code); }));
    on('click', '[data-rf-diff]', guard(function () { refClear(); BR.rf = { change: true, err: '', code: '', tried: true }; F('renderJoin'); }));
    on('input', '#rf-in,#j-code', function (e, t) { t.value = t.value.toUpperCase().replace(/[^A-Z0-9 \-]/g, '').slice(0, 15); });
    on('click', '[data-jstatus]', guard(function () { return checkJoinStatus(false); }));
    on('click', '[data-jstart]', guard(startOver));
    on('click', '[data-reveal]', guard(function (e, t) { return reveal(t, e); }));
    on('click', '[data-report]', function (e, t) { BR.reportTarget = t.dataset.report; });
    on('click', '[data-rpsend]', guard(function (e, t) { return sendReport(t); }));
    on('click', '[data-no]', function (e, t) { BR.rejectId = t.dataset.no; });
    on('click', '.md[aria-label="Confirm rejection"] [data-yes]', guard(function (e, t) { return rejectNow(t); }));
    on('click', '[data-doc]', guard(function (e, t) { return viewDoc(t); }));
    on('submit', '#v-volunteer form', guard(applyVolunteer));
    on('click', '[data-vsim]', own);
    on('click', '[data-vcheck]', guard(function () { return refreshMe(function () { F('renderVolunteer'); toast(S.user.vol ? 'You\'re a volunteer now.' : 'Still being checked.', { k: 'info', i: 'info' }); }); }));
    on('click', '.md[aria-label="Step down as a volunteer"] [data-yes]', guard(function (e, t) { return stepDownNow(t); }));
    on('submit', '#rf', guard(sendReferral));
    on('submit', '#gf', guard(contribute));
    on('click', '[data-delyes]', guard(function (e, t) { return deleteAccount(t); }));
    on('click', '[data-act="logout"]', function () { signOutNow().then(function () { people.length = 0; queue.length = 0; BR.contacts = {}; }); });
    on('submit', '#pf', function () { setTimeout(saveProfile, 0); });

    /* ---------- boot ---------- */
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === 'SIGNED_OUT' && BR.uid) { setTimeout(function () { clearMember(); if (BR.booted) { F('renderNav'); F('route'); } }, 0); }
      else if (ev === 'SIGNED_IN' && session && BR.booted) { setTimeout(function () { if (session.user.id === BR.uid || BR.settling) return; settle().then(function (o) { goNext(o, true); }); }, 0); }
    });
    var start = function () { if (BR.booted) return; BR.booted = true; if (window.__BRBOOT) window.__BRBOOT(); };
    var fresh = false; try { fresh = sessionStorage.getItem('bridges-oauth') === '1'; sessionStorage.removeItem('bridges-oauth'); } catch (e) {}
    settle().then(function (out) { BR.booted = true; if (fresh && BR.uid) sb.rpc('log_signin', { p_faculty: false }).then(function () {}, function () {}); goNext(out, fresh && out === 'member'); if (window.__BRBOOT) window.__BRBOOT(); })
      .catch(function (e) { console.error('[bridges] start-up failed', e); start(); toast('Could not reach the server. Please reload in a moment.', { t: 'Offline?', k: 'warn' }); });
    /* gentle polling: join status while waiting, the volunteer queue while volunteering */
    setInterval(function () {
      if (document.hidden) return;
      if (S.join.step === 3 && !S.user) checkJoinStatus(true).catch(function () {});
      else if (S.user && S.user.vol) loadQueue().then(function () { F('renderNav'); if (X('parse')().v === 'queue' && !$('.md,.lb')) F('renderQueue'); }).catch(function () {});
    }, 45000);
  }
})();
