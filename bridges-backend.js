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
      file_deleted: 'That file has already been deleted.', upload_failed: 'The file did not go through. Check your connection and try again.', database_error: 'Something went wrong on our side. Please try again.', server_error: 'Something went wrong on our side. Please try again.', verified_alums_only: 'Only verified alumni can refer.', bad_email: 'Enter a valid email address.', amount_too_small: 'The smallest contribution is ₹10.',
      alums_only: 'Only alumni can do that.', bad_fields: 'Pick up to 3 fields.', alumni_domain_mismatch: 'That is not an alumni email we recognise for your institute.',
      alumni_batch_too_early: 'Alumni emails for your institute start with a later batch. Verify with a certificate or a referral code instead.', alumni_email_taken: 'That alumni email is already on a profile. Log in with the Google account you joined with.'
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
    st.textContent = '.demo{display:none!important}.dr-f{display:none!important}.ft-b span:last-child:not(:first-child){display:none}'
      /* touch screens: the small footer links, "Report" and "See my listing" get a taller tap area (nothing moves or changes size) */
      + '@media (pointer:coarse){.ft-col a,.ft-col button,.rp,.mine-l{position:relative}.ft-col a::after,.ft-col button::after{content:"";position:absolute;inset:-5px -6px}.rp::after,.mine-l::after{content:"";position:absolute;inset:-6px -4px}}';
    document.head.appendChild(st);

    /* ---------- shapes: database row -> the prototype's person ---------- */
    var VM = { institute_email: 'email', certificate: 'documents', referral: 'referral', alumni_email: 'alumni' };
    var normLinks = function (l) { return (Array.isArray(l) ? l : []).map(function (x) { return { t: x.t || 'portfolio', url: x.url || '', name: x.name || '' }; }).filter(function (x) { return x.url; }); };
    function mapRow(r) {
      var exp = Array.isArray(r.experiences) ? r.experiences : [], x = exp[0] || {};
      return { id: r.id, kind: r.kind, name: r.name, inst: r.institute_id || '', campus: r.campus || '', branch: r.branch || '', year: r.year || 0,
        works: r.kind === 'alum' ? (x.f != null ? +x.f : 0) : -1, role: x.role || '', org: x.org || '', exp: r.kind === 'alum' ? exp : [], open: r.helps || [],
        v: VM[r.verify_method] || 'email', email: '', email2: '', cemail: '', av: r.avatar && typeof r.avatar === 'object' ? r.avatar : {}, links: [], site: '',
        vrec: { at: r.verified_at ? new Date(r.verified_at) : new Date(), r: [] }, vol: !!r.is_volunteer,
        fields: r.kind === 'student' ? (Array.isArray(r.fields) ? r.fields : []) : undefined };
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
        if (priv.email_alumni) p.aemail = priv.email_alumni;      // shown to the member only; others see just "Verified by alumni email"
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
      try { clApply(await rpc('my_contact_limit')); return; } catch (e) { /* older database: fall back to the site number below */ }
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
      var rows = [], from = 0, size = 1000, cols = 'id,kind,name,institute_id,campus,branch,year,helps,avatar,experiences,fields,verify_method,verified_at,is_volunteer,listed,verified';
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
      await loadAlts();
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
      await Promise.all([loadRefs().catch(function () {}), loadFund().catch(function () {}), loadQueue().catch(function () {}), loadInsts().catch(function () {})]);
    }

    /* ---------- who is signed in, and what do they need to do next ---------- */
    function clearMember() {
      S.user = null; S.reveals = {}; people.length = 0; queue.length = 0; BR.contacts = {}; BR.uid = null; BR.dirVer = '';
      S.join = { step: 1, kind: 'student', mode: '', ref: null, rcode: '', rerr: '', d: null, method: 'email', file: null, consent: false, qid: null, viaInstant: false, code: '', otp: null, g: '', gn: '' };
    }
    function dFromRow(row, priv, g) {
      var exp = Array.isArray(row.experiences) ? row.experiences : [], x = exp[0] || {};
      return { fields: Array.isArray(row.fields) ? row.fields : [], name: row.name, inst: row.institute_id, campus: row.campus || '', branch: row.branch || '', year: String(row.year || ''), email: g, open: row.helps || [], links: normLinks(priv.links),
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
          } else { J.step = 2; J.method = me.kind === 'student' ? 'email' : (F('alumOk', J.d) ? 'alumni' : 'upload'); if (rs.status === 'rejected') J.method = 'upload', BR.note = rejectNote(rs.reason); }
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
    /* Google's own sign-in popup (Google Identity Services). The browser asks Google for a sign-in token and we hand it to
       Supabase, so the member never visits the supabase.co address. Off unless config has googleClientId and
       googleButton:true (or ?gis=1 in one browser for testing, ?gis=0 to undo). Any failure falls back to the redirect. */
    function gisOn() {
      try { var m = /[?&]gis=([01])/.exec(location.search); if (m) localStorage.setItem('bridges-gis', m[1]); } catch (e) {}
      var on = !!B.googleButton; try { var v = localStorage.getItem('bridges-gis'); if (v === '1') on = true; if (v === '0') on = false; } catch (e) {}
      return on && !!B.googleClientId;
    }
    function gisLoad() {
      if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
      return new Promise(function (ok, no) {
        var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
        s.onload = ok; s.onerror = no; document.head.appendChild(s); setTimeout(no, 8000);
      });
    }
    async function gisSignIn() {
      try {
        await gisLoad();
        return await new Promise(function (resolve) {
          var settled = false, done = function (v) { if (!settled) { settled = true; resolve(v); } };
          google.accounts.id.initialize({
            client_id: B.googleClientId, use_fedcm_for_prompt: true, cancel_on_tap_outside: false, auto_select: false,
            callback: async function (resp) {
              try {
                var r = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential });
                if (r.error || !r.data || !r.data.user) { console.warn('[bridges] token sign-in failed', r.error); return done(false); }
                BR.uid = r.data.user.id;
                sb.rpc('log_signin', { p_faculty: false }).then(function () {}, function () {});
                var out = await settle(); goNext(out, out === 'member'); done(true);
              } catch (e) { console.warn('[bridges] token sign-in error', e); done(false); }
            }
          });
          google.accounts.id.prompt(function (n) {
            // a popup that could not open or was skipped falls back to the redirect; a member who closes it stays on the page
            if (n.isNotDisplayed && n.isNotDisplayed()) done(false);
            else if (n.isSkippedMoment && n.isSkippedMoment()) done(false);
            else if (n.isDismissedMoment && n.isDismissedMoment() && n.getDismissedReason() !== 'credential_returned') done(true);
          });
        });
      } catch (e) { console.warn('[bridges] Google popup unavailable', e); return false; }
    }
    /* Google's real button, laid invisibly over our own "Continue with Google" buttons, so the click opens Google's popup
       directly (this is the path that works in every browser). Our button looks exactly the same. */
    var gisCred = async function (resp) {
      try {
        var r = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential });
        if (r.error || !r.data || !r.data.user) { console.warn('[bridges] token sign-in failed', r.error); toast('Could not sign in with Google. Please try again.', { t: 'Sign-in failed', k: 'warn' }); return; }
        BR.uid = r.data.user.id;
        sb.rpc('log_signin', { p_faculty: false }).then(function () {}, function () {});
        var out = await settle(); goNext(out, out === 'member');
      } catch (e) { console.warn('[bridges] token sign-in error', e); toast('Could not sign in with Google. Please try again.', { t: 'Sign-in failed', k: 'warn' }); }
    };
    function gisOverlays() {
      if (!gisOn()) return;
      gisLoad().then(function () {
        google.accounts.id.initialize({ client_id: B.googleClientId, callback: gisCred, ux_mode: 'popup', auto_select: false });
        var map = new Map();
        var tick = function () {
          var live = new Set();
          $$('[data-gsign],[data-jg]').forEach(function (b) {
            var r = b.getBoundingClientRect();
            if (r.width < 40 || r.height < 20 || !b.offsetParent) return;
            live.add(b);
            var o = map.get(b);
            if (!o) {
              var box = document.createElement('div'), inner = document.createElement('div');
              box.setAttribute('aria-hidden', 'true');
              box.style.cssText = 'position:fixed;overflow:hidden;opacity:0.01;z-index:2147483000;cursor:pointer;';
              inner.style.cssText = 'width:400px;height:40px;transform-origin:0 0;';
              box.appendChild(inner); document.body.appendChild(box);
              google.accounts.id.renderButton(inner, { type: 'standard', size: 'large', theme: 'outline', text: 'continue_with', width: 400 });
              o = { box: box, inner: inner }; map.set(b, o);
            }
            o.box.style.left = r.left + 'px'; o.box.style.top = r.top + 'px'; o.box.style.width = r.width + 'px'; o.box.style.height = r.height + 'px';
            o.inner.style.transform = 'scale(' + (r.width / 400) + ',' + (r.height / 40) + ')';
          });
          map.forEach(function (o, b) { if (!live.has(b)) { o.box.parentNode.removeChild(o.box); map.delete(b); } });
        };
        setInterval(tick, 250); window.addEventListener('scroll', tick, true); window.addEventListener('resize', tick); tick();
      }, function () { /* Google's script is blocked: the buttons keep the normal redirect */ });
    }
    async function googleSignIn() {
      try {
        var cfg = await fetch(B.supabaseUrl + '/auth/v1/settings', { headers: { apikey: B.publishableKey } }).then(function (r) { return r.json(); });
        if (!(cfg && cfg.external && cfg.external.google)) { toast('Google sign-in is not switched on yet. Faculty can sign in with their ID.', { t: 'Not available yet', k: 'warn' }); return; }
      } catch (e) {}
      if (gisOn() && await gisSignIn()) return;       // Google's own popup; any problem falls back to the redirect below
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
      /* students pick up to 3 fields; if they skip it, the field that fits their branch is used (same as the prototype) */
      if (J.kind === 'student' && !(d.fields && d.fields.length)) d.fields = X('seedFields')({ branch: d.branch }, 1);
      var btn = $('#jf1 button[type="submit"]'); if (btn) btn.disabled = true;
      try {
        await rpc('create_my_profile', { p: { kind: J.kind, name: d.name, institute_id: d.inst, campus: d.campus || '', branch: d.branch, year: +d.year, helps: d.open, fields: J.kind === 'student' ? (d.fields || []) : [],
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
      if (J.method === 'alumni') {
        /* alumni email: a 6-digit code to the address the institute gave at graduation (only institutes on the admin's list, only batches that got one) */
        var ad = X('alumDomFor')(d.inst);
        if (!J.otp) {
          var ai = $('#j-aemail'), at = (ai.value || '').trim().toLowerCase();
          function abad(m) { joinErr(m); ai.setAttribute('aria-invalid', 'true'); ai.focus(); }
          ai.removeAttribute('aria-invalid');
          if (!ad || !F('alumOk', d)) return;                                // the page already shows why, with no button
          if (!at) return abad('Enter your full alumni email, like you@' + ad.d + '.');
          if (!F('validEmail', at)) return abad('Enter your full alumni email, like you@' + ad.d + '.');
          var ao = X('alumDomOf')(at);
          if (!ao) return abad(F('domainOk', at, d.inst) ? 'That\'s a student address. Use the alumni email ending in @' + ad.d + '.' : '@' + at.split('@')[1] + ' isn\'t an alumni email we recognise. Use the one ending in @' + ad.d + '.');
          if (ao.inst !== d.inst) return abad('That\'s an ' + IB[ao.inst].s + ' alumni email, but your profile says ' + IB[d.inst].s + '. Go back and change your institute, or use your @' + ad.d + ' address.');
          btn.disabled = true;
          try { await rpc('request_alumni_code', { p_email: at }); } catch (e) { btn.disabled = false; return abad(why(e)); }
          J.aemail = at; J.otp = { email: at, code: '', at: Date.now() }; F('renderJoin'); toast('Code sent to ' + at + '.', { t: 'Check your inbox', k: 'info', i: 'mail' });
          return;
        }
        var acode = $$('[data-otp]').map(function (i) { return i.value; }).join('');
        if (acode.length !== 6) return joinErr('Enter all 6 digits.');
        btn.disabled = true;
        try {
          var agood = await rpc('confirm_email_code', { p_code: acode });
          if (!agood) { btn.disabled = false; $$('[data-otp]').forEach(function (i) { i.value = ''; }); var a0 = $('[data-otp="0"]'); if (a0) a0.focus(); return joinErr('That code is not right. Check the email and try again.'); }
        } catch (e) { btn.disabled = false; return joinErr(why(e)); }
        await becomeMember('Alumni email confirmed. You\'re listed.', 'alumni'); return;
      }
      if (J.method === 'email') {
        if (!J.otp) {
          var inp = $('#j-iemail'), dom = IB[d.inst].d, typed = (inp.value || '').trim().toLowerCase();
          inp.removeAttribute('aria-invalid');
          if (typed && F('validEmail', typed) && X('alumDomOf')(typed)) { joinErr('That\'s an alumni email. Students verify with their current institute email.'); inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
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
      if (refPost() || kindPost()) return;
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
      var all = cur > 4; if (all) cur = 4;               // 5 = every step finished (the Listed page)
      var steps = ['Referral code', 'Sign in', 'Your profile', 'Listed'], pct = [6, 30, 55, 100][cur - 1], label = cur === 4 ? 'Done' : 'Step ' + cur + ' of 4';
      var items = steps.map(function (t, i) { var n = i + 1, cls = all || cur > n ? 'done' : cur === n ? 'cur' : ''; return '<li class="' + cls + '"><span class="dot">' + (cls === 'done' ? F('ico', 'check', 10) : '') + '</span><span>' + rfEsc(t) + '</span></li>'; }).join('');
      return '<div class="prog" aria-label="Sign-up progress"><div class="prog-top"><b>' + rfEsc(steps[cur - 1]) + '</b><span class="muted">' + label + '</span></div>'
        + '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="--p:' + pct + '%"></i></div><ol class="steps">' + items + '</ol></div>';
    }
    function refHead() {
      return '<div class="head"><span class="eyebrow">Sign up · Referral</span><h2 class="h2">Sign up with a referral</h2>'
        + '<p class="lede">An alum of your institute vouched for you. Enter the code from your email and you skip verification.</p>'
        + '<p style="margin-top:4px;font-size:.875rem;color:var(--muted)">No code? <a href="#join/alum"><b>Sign up as an alum</b></a> and verify with your certificate.</p></div>';
    }
    function refPage(cur, inner) { $('#v-join').innerHTML = refHead() + '<div class="wrap" style="display:grid;gap:var(--sp-l)">' + refShell(cur) + (inner || '') + '</div>'; }
    function refFail(msg) { BR.rf = Object.assign(BR.rf || {}, { err: msg, checking: false }); F('renderJoin'); }
    async function refCheck(code) {
      var c = rfNorm(code);
      if (c.length < 6) return refFail('Codes look like K7Q2M4XD. Check the email from Bridges.directory.');
      var res; try { res = await rpc('check_referral', { p_code: c }); } catch (e) { return refFail(why(e)); }
      if (!res || !res.ok) return refFail('That code did not work. Check it, or ask your referrer for a new one.');
      refSet({ code: c, kind: res.kind, inst: res.institute_id, iname: res.institute_name, ishort: res.institute_short, by: res.by || '', byFull: res.by_full || '', byAv: res.by_avatar || null });
      BR.rf = { change: false, err: '', code: '' }; F('renderJoin');
    }
    function refLanding(rc) {
      var R = BR.rf = BR.rf || { change: false, err: '', code: '' }, ref = refGet();
      if (ref && !R.change && (!rc || rfNorm(rc) === ref.code)) {
        var kindW = ref.kind === 'student' ? 'a student' : 'an alum', nm = ref.byFull || ref.by, who = nm ? rfEsc(nm) + ' vouched for you' : 'The Bridges team invited you', av = '';
        if (ref.byAv && nm) { try { av = F('avatarHtml', ref.byAv).replace('<span class="av">', '<span class="av" style="width:56px;height:56px">'); } catch (e) { av = ''; } }
        refPage(2, '<div class="form" style="display:grid;gap:var(--sp-m)"><div style="display:flex;gap:var(--sp-m);align-items:flex-start">' + av + '<div style="min-width:0;display:grid;gap:8px;justify-items:start"><span class="pill pos">' + F('ico', 'check', 12) + ' Code ' + rfEsc(ref.code) + ' accepted</span>'
          + '<div><h3>' + who + '</h3><p class="help" style="margin-top:4px">' + (ref.by ? rfEsc(ref.by) + ' is a verified alum of ' + rfEsc(ref.iname) + '. ' : '') + 'You\'ll be listed as ' + kindW + ' of ' + rfEsc(ref.iname) + ' and verified as soon as you finish your profile.</p></div></div></div>'
          + '<hr style="border:0;border-top:1px solid var(--line);margin:0">'
          + F('gBtn', 'Continue with Google', 'data-jg')
          + '<p class="help" style="text-align:center;font-size:.875rem">Wrong code? <button class="lnkb" type="button" data-rf-diff>Use a different one</button></p>'
          + '<p class="legal-l">By continuing, you agree to the <a href="#terms">Terms of use</a> and <a href="#privacy">Privacy policy</a>.</p></div>');
        return;
      }
      if (rc && !R.tried && !R.change) { R.tried = true; R.checking = true; R.code = rc; refCheck(rc); }
      refPage(1, '<form class="form" id="rf-form" novalidate style="display:grid;gap:var(--sp-m)"><div style="display:flex;gap:var(--sp-m);align-items:flex-start"><span style="flex:none;width:48px;height:48px;border-radius:10px;background:var(--butter);display:grid;place-items:center;color:var(--tint-ink)">' + F('ico', 'key', 20) + '</span><div style="min-width:0"><h3>Enter your referral code</h3>'
        + '<p class="help" style="margin-top:4px">It\'s in the email from Bridges.directory and looks like K7Q2M4XD. If you opened the link in that email, it\'s already filled in.</p></div></div>'
        + '<div style="display:flex;gap:12px;flex-wrap:wrap"><input class="input code-in" id="rf-in" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="15" placeholder="XXXXXXXX" style="flex:0 1 180px" value="' + rfEsc(R.code || rc || '') + '"'
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
      var hd = $('.head', v); if (hd) hd.outerHTML = refHead();   // same heading block as the first two steps
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
          if (!$('.rf-fixed', sel.parentNode)) {            // one fixed institute: show it as a plain line with a "Referral" tag, the select stays (hidden) to carry the value
            sel.hidden = true; sel.value = real[0].value;
            var fx = document.createElement('div'); fx.className = 'rf-fixed'; fx.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;padding:0 8px 0 12px;border-radius:8px;background:var(--fill);font-size:.875rem';
            fx.innerHTML = '<span>' + rfEsc(real[0].textContent) + '</span><span class="pill pos">' + F('ico', 'check', 12) + ' Referral</span>'; sel.parentNode.insertBefore(fx, sel);
          }
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
      if (good) { BR.rfDone = true; await becomeMember('Your referral verified you. You\'re listed.', 'referral'); return; }
      J.method = 'referral'; J.code = ref.code; F('renderJoin'); joinErr(msg);
    }
    function refPost() {
      var J = S.join, rc = refRoute();
      if (S.user && rc !== null && !(J.step === 4 && BR.rfDone)) {
        $('#v-join').innerHTML = refHead() + '<div class="wrap" style="display:grid;gap:var(--sp-l)"><div class="status"><div><h3>You\'re logged in as ' + rfEsc(S.user.name) + '</h3><p class="help" style="margin-top:4px">Referral codes are for new members. Log out first to sign up with this code.</p></div>'
          + '<div class="actions" style="padding-top:0"><button class="btn primary" type="button" data-act="logout">Log out</button><a class="btn ghost" href="#home">Cancel</a></div></div></div>';
        return true;
      }
      if (!J.g && J.step === 1 && !S.user) { if (rc === null) return false; refLanding(rc); return true; }
      if (J.step === 4 && BR.rfDone && S.user) {          // listed through a referral: same page, referral heading and a finished progress bar
        var v4 = $('#v-join'), eb4 = $('.head .eyebrow', v4), h4 = $('.head .h2', v4), l4 = $('.head .lede', v4), pr4 = $('.prog', v4);
        if (eb4) eb4.textContent = 'Sign up · Referral'; if (h4) h4.textContent = 'Sign up with a referral'; if (l4) l4.textContent = 'An alum of your institute vouched for you. Enter the code from your email and you skip verification.';
        if (pr4) pr4.outerHTML = refShell(5);
        return true;
      }
      if (J.step !== 4) BR.rfDone = false;
      var ref = refGet(); if (!ref) return false;
      if (J.step === 1 && J.g) { refProfile(ref); return true; }
      if (J.step === 2) { refRedeem(ref); return true; }
      return false;
    }

    /* ---------- sign-up chooser and separate student / alum pages (no "I am" switch) ---------- */
    var KINDKEY = 'bridges-kind';
    function kindGet() { try { var o = JSON.parse(localStorage.getItem(KINDKEY) || 'null'); if (o && Date.now() - o.at < 3 * 3600 * 1000 && (o.k === 'student' || o.k === 'alum')) return o.k; localStorage.removeItem(KINDKEY); } catch (e) { /* storage blocked */ } return null; }
    function kindSet(k) { try { localStorage.setItem(KINDKEY, JSON.stringify({ k: k, at: Date.now() })); } catch (e) { /* storage blocked */ } }
    /* the headings and the two cards come from the artifact itself (joinHead / kindPickHtml), so they follow Atharva's design and wording */
    function kindHead(k) {
      var v = $('#v-join'), hd = $('.head', v); if (!hd) return;
      var J = S.join, was = [J.kind, J.mode]; J.kind = k; J.mode = '';
      try { hd.outerHTML = F('joinHead'); } finally { J.kind = was[0]; J.mode = was[1]; }
    }
    function kindChooser() {
      var J = S.join, was = [J.kind, J.mode]; J.kind = ''; J.mode = '';
      try { $('#v-join').innerHTML = F('joinHead') + '<div class="wrap" style="display:grid;gap:var(--sp-l)">' + F('kindPickHtml') + '</div>'; } finally { J.kind = was[0]; J.mode = was[1]; }
    }
    /* runs after the prototype drew the join page; true = this function drew everything */
    function kindPost() {
      var J = S.join, v = $('#v-join'), arg = X('parse')().arg;
      if (!v || S.user || J.step !== 1) return false;
      if (!J.g) {
        refClear();                                   // a half-finished referral must not follow someone who chose the normal way
        if (arg === 'student' || arg === 'alum') { J.kind = arg; J._k = arg; kindSet(arg); kindHead(arg); return false; }
        kindChooser(); return true;
      }
      var k = (arg === 'student' || arg === 'alum') ? arg : (kindGet() || J.kind);
      if (J.kind !== k || (J._k && J._k !== k)) { J.kind = k; J._k = k; if (J.d) { J.d.year = ''; J.d.open = []; } F('renderJoin'); return true; }
      J._k = k; kindSet(k); kindHead(k);
      var seg = $('[data-jk]', v); if (seg) { var row = seg.closest('.fr'); if (row) row.remove(); }
      return false;
    }

    /* ---------- more than one institute: add, verify, show (Master's / PhD at another institute) ---------- */
    Object.assign(ERR, { verify_first: 'Finish verifying your first institute before adding another.', already_added: 'You have already added that institute.', too_many_institutes: 'You can add up to 5 more institutes.',
      bad_branch: 'Choose your branch.', bad_year: 'Choose a valid year.', bad_kind: 'Choose whether you study there now or studied there.' });
    var aiCss = document.createElement('style');
    aiCss.textContent = '.ai-l{display:grid;gap:0;list-style:none;padding:0;margin:0}.ai-r{display:grid;gap:6px;padding:var(--sp-s) 0;border-top:1px solid var(--line)}.ai-r:first-child{border-top:0;padding-top:0}'
      + '.ai-t{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ai-t b{font-size:.9375rem}.ai-m{color:var(--muted);font-size:.8125rem}.ai-a{display:flex;gap:8px;flex-wrap:wrap;align-items:center}'
      + '.ai-f{display:grid;gap:var(--sp-s)}.ai-f>div{display:grid;gap:6px}.ai-f .checks{display:grid;gap:8px}.ai-ms{display:flex;gap:8px;flex-wrap:wrap}'
      + '.pc-also{color:var(--ink-2);font-size:.8125rem;line-height:1.5;padding:0 0 var(--sp-s)}.pc-also b{color:var(--ink)}';
    document.head.appendChild(aiCss);
    var aiEsc = function (t) { return F('esc', t == null ? '' : String(t)); };
    function aiName(x) { var I = IB[x.inst]; return I ? I.s + (x.campus ? ' ' + x.campus : '') : x.inst; }
    function aiLabel(x) { return aiName(x) + ' · ' + (x.kind === 'student' ? 'Student' : 'Alum'); }
    async function loadInsts() {
      var me = S.user; if (!me) return;
      if (me.kind === 'faculty') { me.insts = []; return; }
      var rows = (await rpc('my_institutes')) || [];
      me.insts = rows.map(function (r) { return { id: r.id, inst: r.institute_id, campus: r.campus || '', branch: r.branch, year: r.year, kind: r.kind, verified: !!r.verified, method: r.verify_method, rs: r.request_status, rr: r.request_reason }; });
    }
    /* each listed person also carries their verified extra institutes (p.alt); the directory then finds them under each one */
    async function loadAlts() {
      var rows = []; try { rows = (await rpc('directory_institutes')) || []; } catch (e) { rows = []; }
      var by = {}; people.forEach(function (p) { p.alt = []; by[p.id] = p; });
      rows.forEach(function (r) { var p = by[r.profile_id]; if (p && IB[r.institute_id]) p.alt.push({ inst: r.institute_id, campus: r.campus || '', branch: r.branch, year: r.year || 0, kind: r.kind }); });
    }
    var aiMain = function (p) { return { inst: p.inst, campus: p.campus, branch: p.branch, year: p.year, kind: p.kind }; };
    /* the directory: someone who matches the filter only through an extra institute is shown as that institute while the list is drawn */
    (function () {
      var origList = X('renderList'), pass = X('pass'), origPanel = X('panelHtml');
      setFn('renderList', function () {
        var sw = [];
        try {
          people.forEach(function (p) {
            if (!p.alt || !p.alt.length || pass(p, S.f, S.q)) return;
            for (var i = 0; i < p.alt.length; i++) {
              if (pass(Object.assign({}, p, p.alt[i]), S.f, S.q)) { var m = aiMain(p); sw.push([p, m]); p._main = m; Object.assign(p, p.alt[i]); break; }
            }
          });
          return origList.apply(null, arguments);
        } finally { sw.forEach(function (x) { Object.assign(x[0], x[1]); delete x[0]._main; }); }
      });
      setFn('panelHtml', function (p) {
        var h = origPanel.apply(null, arguments);
        try {
          var all = [p._main || aiMain(p)].concat(p.alt || []).filter(function (x) { return !(x.inst === p.inst && (x.campus || '') === (p.campus || '') && x.kind === p.kind); });
          if (all.length && h.indexOf('<div class="pc-cols">') >= 0) {
            h = h.replace('<div class="pc-cols">', function () { return '<p class="pc-also"><b>Also:</b> ' + all.map(function (x) { return aiEsc(aiLabel(x) + (x.branch ? ' · ' + x.branch : '')); }).join(' · ') + '</p><div class="pc-cols">'; });
          }
        } catch (e) { console.error('[bridges] panel', e); }
        return h;
      });
    })();

    /* my profile: the list of my institutes */
    function aiState(L) {
      if (L.verified) return '<span class="pill pos">' + F('ico', 'check', 12) + ' Verified</span>';
      if (L.rs === 'pending') return '<span class="pill">With the volunteers</span>';
      return '<span class="pill">Not verified yet</span>';
    }
    function aiCard(u) {
      var ls = u.insts || [], main = { inst: u.inst, campus: u.campus, branch: u.branch, year: u.year, kind: u.kind };
      var h = '<div class="side-card" id="ai-card"><h3>Your institutes</h3><ul class="ai-l">'
        + '<li class="ai-r"><div class="ai-t"><b>' + aiEsc(aiName(main)) + '</b><span class="pill ' + (main.kind === 'student' ? 'stu' : 'alum') + '">' + (main.kind === 'student' ? 'Student' : 'Alum') + '</span><span class="pill pos">' + F('ico', 'check', 12) + ' Verified</span></div><span class="ai-m">' + aiEsc(main.branch) + ' · ' + (main.kind === 'student' ? 'graduating ' : 'batch of ') + aiEsc(main.year) + ' · main institute</span>'
        + (u.kind === 'alum' ? '<div class="ai-a"><a class="btn ghost sm" href="#refer" data-ai-refer="' + aiEsc(main.inst) + '">' + F('ico', 'uplus', 14) + 'Refer someone</a></div>' : '') + '</li>';
      ls.forEach(function (L) {
        var rej = !L.verified && L.rs === 'rejected', pend = !L.verified && L.rs === 'pending';
        h += '<li class="ai-r"><div class="ai-t"><b>' + aiEsc(aiName(L)) + '</b><span class="pill ' + (L.kind === 'student' ? 'stu' : 'alum') + '">' + (L.kind === 'student' ? 'Student' : 'Alum') + '</span>' + aiState(L) + '</div>'
          + '<span class="ai-m">' + aiEsc(L.branch) + ' · ' + (L.kind === 'student' ? 'graduating ' : 'batch of ') + aiEsc(L.year) + (L.verified ? '' : pend ? ' · two volunteers are checking your certificate' : rej ? ' · your last certificate was not approved' : ' · not shown in the directory until verified') + '</span>'
          + '<div class="ai-a">' + (L.verified ? (L.kind === 'alum' ? '<a class="btn ghost sm" href="#refer" data-ai-refer="' + aiEsc(L.inst) + '">' + F('ico', 'uplus', 14) + 'Refer someone</a>' : '') : pend ? '' : '<button class="btn secondary sm" type="button" data-ai-verify="' + aiEsc(L.id) + '">Verify</button>')
          + '<button class="btn ghost sm" type="button" data-ai-remove="' + aiEsc(L.id) + '">Remove</button></div></li>';
      });
      h += '</ul>' + (ls.length < 5 ? '<button class="btn secondary sm" type="button" data-ai-add style="justify-self:start">' + F('ico', 'plus', 14) + 'Add another institute</button>' : '')
        + '<p class="help">Did a Master\'s or PhD somewhere else? Add it here. You can be a student at one institute and an alum at another. Each one is verified on its own.</p></div>';
      return h;
    }
    wrap('renderProfile', function () {
      var u = S.user, v = $('#v-profile'); if (!u || u.kind === 'faculty' || !v) return;
      var side = $('.pgrid > div:last-child .side-card', v); if (!side || $('#ai-card', v)) return;
      if (!u.insts) { u.insts = []; loadInsts().then(function () { if (X('parse')().v === 'profile') F('renderProfile'); }).catch(function () {}); return; }
      side.insertAdjacentHTML('afterend', aiCard(u));
    });
    async function aiRefresh(then) {
      await loadInsts(); await loadDirectory(); BR.peopleAt = Date.now();
      if (X('parse')().v === 'profile') F('renderProfile'); else if (X('parse')().v === 'directory') F('refreshDir');
      F('renderNav'); if (then) then();
    }

    /* add an institute */
    var aiYears = function (kind) {
      var T = X('THIS_YEAR'), ys = []; if (kind === 'student') { for (var y = T; y <= T + 7; y++) ys.push(y); } else { for (var z = T; z >= 1980; z--) ys.push(z); }
      return '<option value="">' + (kind === 'student' ? 'Expected year' : 'Year you graduated') + '</option>' + ys.map(function (y) { return '<option>' + y + '</option>'; }).join('');
    };
    function openAdd() {
      var u = S.user; if (!u) return;
      var m = F('modal', F('mdHead', 'Add another institute', 'For example a Master\'s or PhD at a different institute.')
        + '<form class="ai-f" id="ai-f" novalidate>'
        + '<div><span class="label" style="margin:0">Your status there</span><div class="checks"><label><input type="radio" name="ai-k" value="student" checked> I study here now</label><label><input type="radio" name="ai-k" value="alum"> I studied here (alum)</label></div></div>'
        + '<div><label class="label" for="ai-inst" style="margin:0">Institute</label>' + F('selWrap', '<select class="input" id="ai-inst">' + F('instOptions', '', 'Choose an institute') + '</select>') + '</div>'
        + '<div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-s)"><div style="display:grid;gap:6px"><label class="label" for="ai-branch" style="margin:0">Branch</label>' + F('selWrap', '<select class="input" id="ai-branch" disabled><option value="">Pick institute first</option></select>') + '</div>'
        + '<div style="display:grid;gap:6px"><label class="label" for="ai-year" style="margin:0">Year</label>' + F('selWrap', '<select class="input" id="ai-year">' + aiYears('student') + '</select>') + '</div></div>'
        + '<p class="err" id="ai-err" role="alert"></p>'
        + '<div class="md-f"><button class="btn primary" type="submit">Add and verify</button><button class="btn ghost" type="button" data-mclose>Cancel</button></div></form>', 'Add another institute');
      var kindNow = function () { var r = $('input[name="ai-k"]:checked', m); return r ? r.value : 'student'; };
      m.addEventListener('change', function (e) {
        if (e.target.id === 'ai-inst') {
          var x = String(e.target.value || '').split('|'), I = IB[x[0]], br = $('#ai-branch', m);
          br.innerHTML = I ? '<option value="">Branch</option>' + I.br.map(function (b) { return '<option>' + aiEsc(b) + '</option>'; }).join('') : '<option value="">Pick institute first</option>'; br.disabled = !I;
        } else if (e.target.name === 'ai-k') { $('#ai-year', m).innerHTML = aiYears(kindNow()); }
      });
      m.addEventListener('submit', function (e) {
        e.preventDefault();
        var err = $('#ai-err', m), x = String($('#ai-inst', m).value || '').split('|'), b = $('#ai-branch', m).value, y = $('#ai-year', m).value, btn = $('button[type="submit"]', m);
        if (!x[0]) { err.textContent = 'Choose an institute.'; return; }
        if (!b) { err.textContent = 'Choose your branch.'; return; }
        if (!y) { err.textContent = 'Choose your year.'; return; }
        btn.disabled = true; err.textContent = '';
        rpc('add_my_institute', { p: { institute_id: x[0], campus: x[1] || '', branch: b, year: +y, kind: kindNow() } }).then(function (id) {
          return loadInsts().then(function () { if (X('parse')().v === 'profile') F('renderProfile'); var L = (S.user.insts || []).filter(function (q) { return q.id === id; })[0]; if (L) aiVerifyUI(m, L); else m.close(); });
        }).catch(function (x2) { btn.disabled = false; err.textContent = why(x2); });
      });
    }

    /* verify an added institute: institute email, certificate, or a referral code */
    function aiVerifyHtml(L, st) {
      var I = IB[L.inst], mth = st.method, btnM = function (k, t) { return '<button class="btn ' + (mth === k ? 'primary' : 'secondary') + ' sm" type="button" data-ai-m="' + k + '">' + t + '</button>'; }, body;
      if (mth === 'email') {
        body = st.sent
          ? '<p class="help">We sent a 6-digit code to ' + aiEsc(st.email) + '. It works for 10 minutes.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input" id="ai-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6-digit code" style="max-width:180px"><button class="btn primary" type="button" data-ai-go>Verify</button><button class="btn ghost" type="button" data-ai-again>Use another address</button></div>'
          : '<label class="label" for="ai-em" style="margin:0">Your ' + aiEsc(I.s) + ' email</label><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input" id="ai-em" type="email" placeholder="you@' + aiEsc(I.d) + '" style="flex:1 1 220px"><button class="btn primary" type="button" data-ai-go>Send code</button></div><p class="help">Works if you still have an address at ' + aiEsc(I.d) + '.</p>';
      } else if (mth === 'upload') {
        body = '<p class="help">Upload your certificate. You hide the private parts before it is sent, and two volunteers check the rest.</p><input class="input" id="ai-file" type="file" accept="image/png,image/jpeg,image/webp,image/*">'
          + '<label class="checks" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="ai-consent"> <span class="help">I am happy for two volunteers to check it. The file is deleted once they decide.</span></label><div><button class="btn primary" type="button" data-ai-go>Hide details and send</button></div>';
      } else {
        body = '<p class="help">If a verified alum of ' + aiEsc(I.s) + ' referred you, enter the code from your email.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input code-in" id="ai-ref" maxlength="15" autocomplete="off" autocapitalize="characters" placeholder="Code from your email" style="flex:1 1 200px;max-width:300px"><button class="btn primary" type="button" data-ai-go>Use code</button></div>';
      }
      return F('mdHead', 'Verify ' + aiEsc(aiName(L)), (L.kind === 'student' ? 'Prove you study here.' : 'Prove you studied here.') + ' Until then it is not shown in the directory.')
        + '<div class="ai-f"><div class="ai-ms">' + btnM('email', 'Institute email') + btnM('upload', 'Certificate') + btnM('referral', 'Referral code') + '</div>' + body + '<p class="err" id="ai-err2" role="alert"></p>'
        + '<div class="md-f"><button class="btn ghost" type="button" data-mclose>Not now</button></div></div>';
    }
    function aiVerifyUI(m, L) {
      var st = { method: L.kind === 'student' ? 'email' : 'upload', sent: false, email: '' };
      m.set(aiVerifyHtml(L, st));
      var err = function (t) { var e = $('#ai-err2', m); if (e) e.textContent = t || ''; };
      var redraw = function () { m.set(aiVerifyHtml(L, st)); };
      var done = async function (msg) { await aiRefresh(); m.close(); toast(msg, { t: 'Verified' }); };
      m.onclick = null;
      m.addEventListener('click', async function (e) {
        var t = e.target.closest('[data-ai-m],[data-ai-go],[data-ai-again]'); if (!t) return;
        if (t.dataset.aiM) { st.method = t.dataset.aiM; st.sent = false; redraw(); return; }
        if (t.hasAttribute('data-ai-again')) { st.sent = false; redraw(); return; }
        err(''); t.disabled = true;
        try {
          if (st.method === 'email') {
            if (!st.sent) {
              var em = ($('#ai-em', m).value || '').trim().toLowerCase();
              if (!em || !F('validEmail', em) || !F('domainOk', em, L.inst)) { t.disabled = false; return err('Use your ' + IB[L.inst].d + ' address.'); }
              try { await rpc('request_link_code', { p_link: L.id, p_email: em }); } catch (x) { t.disabled = false; return err(x.message === 'email_domain_mismatch' ? 'Use your ' + IB[L.inst].d + ' address.' : x.message === 'codes_off' ? ERR.codes_off : why(x)); }
              st.sent = true; st.email = em; redraw(); return;
            }
            var code = ($('#ai-code', m).value || '').replace(/\D/g, '');
            if (code.length !== 6) { t.disabled = false; return err('Enter all 6 digits.'); }
            var good; try { good = await rpc('confirm_link_code', { p_link: L.id, p_code: code }); } catch (x) { t.disabled = false; return err(why(x)); }
            if (!good) { t.disabled = false; return err('That code is not right. Check the email and try again.'); }
            return done('Email confirmed. You are now also listed under ' + aiName(L) + '.');
          }
          if (st.method === 'referral') {
            var rc = ($('#ai-ref', m).value || '').trim(); if (!rc) { t.disabled = false; return err('Enter the referral code from your email.'); }
            var ok2; try { ok2 = await rpc('redeem_link_referral', { p_link: L.id, p_code: rc }); } catch (x) { t.disabled = false; return err(why(x)); }
            if (!ok2) { t.disabled = false; return err('That code did not work. Check it, or ask your referrer for a new one.'); }
            return done('Referral accepted. You are now also listed under ' + aiName(L) + '.');
          }
          var f = $('#ai-file', m).files[0];
          if (!f) { t.disabled = false; return err('Choose your certificate first.'); }
          if (!$('#ai-consent', m).checked) { t.disabled = false; return err('Tick the box to say you are happy for two volunteers to check it.'); }
          if (!window.BridgesRedact || typeof window.BridgesRedact.open !== 'function') { t.disabled = false; return err('The hiding tool did not load, so nothing was sent. Reload the page and try again.'); }
          m.style.display = 'none';
          var blob; try { blob = await window.BridgesRedact.open(f, { coverQR: COVER_QR }); } finally { m.style.display = ''; }
          if (!blob) { t.disabled = false; return; }
          if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) { t.disabled = false; return err('The hidden copy was not an image. Try again.'); }
          if (blob.size > 8000000) { t.disabled = false; return err(ERR.bad_file_size); }
          try {
            if (B.certWorkerUrl) {
              var rid = await rpc('submit_link_certificate_start', { p_link: L.id, p_mime: blob.type, p_bytes: blob.size });
              var rs = await fetch(B.certWorkerUrl + '/u/' + rid, { method: 'PUT', headers: { Authorization: 'Bearer ' + await certToken(), 'Content-Type': blob.type }, body: blob });
              if (!rs.ok) await certFail(rs);
            } else { await rpc('submit_link_certificate', { p_link: L.id, p_mime: blob.type, p_data_base64: await toBase64(blob) }); }
          } catch (x) { t.disabled = false; return err(why(x)); }
          await loadInsts(); if (X('parse')().v === 'profile') F('renderProfile'); m.close(); toast('Sent to the volunteer queue. We\'ll list you there once two volunteers approve.', { t: 'Sent' });
        } catch (x) { t.disabled = false; console.error('[bridges]', x); err(why(x)); }
      });
    }
    function openVerify(L) { var m = F('modal', '', 'Verify ' + aiName(L)); aiVerifyUI(m, L); }
    async function removeInst(id) {
      var L = ((S.user && S.user.insts) || []).filter(function (q) { return q.id === id; })[0]; if (!L) return;
      var m = F('modal', F('mdHead', 'Remove ' + aiEsc(aiName(L)) + '?', 'It will no longer be on your profile or in the directory. You can add it again later.')
        + '<div class="md-f"><button class="btn danger" type="button" data-ai-rm>Remove</button><button class="btn ghost" type="button" data-mclose>Cancel</button></div>', 'Remove institute');
      m.addEventListener('click', async function (e) {
        if (!e.target.closest('[data-ai-rm]')) return;
        try { await rpc('remove_my_institute', { p_link: id }); } catch (x) { return toast(why(x), { k: 'warn' }); }
        m.close(); await aiRefresh(); toast('Removed.', { k: 'info', i: 'trash' });
      });
    }
    on('click', '[data-ai-add]', guard(openAdd));
    on('click', '[data-ai-verify]', guard(function (e, t) { var L = ((S.user && S.user.insts) || []).filter(function (q) { return q.id === t.dataset.aiVerify; })[0]; if (L) openVerify(L); }));
    on('click', '[data-ai-remove]', guard(function (e, t) { return removeInst(t.dataset.aiRemove); }));
    on('click', '[data-ai-refer]', function (e, t) { BR.refInst = t.dataset.aiRefer; });
    on('input', '#ai-ref', function (e, t) { t.value = t.value.toUpperCase().replace(/[^A-Z0-9 \-]/g, '').slice(0, 15); });

    /* refer someone: you can refer for any institute where you are a verified alum */
    function aiReferTo(u) {
      var out = []; if (u.kind === 'alum') out.push({ inst: u.inst, campus: u.campus });
      (u.insts || []).forEach(function (L) { if (L.verified && L.kind === 'alum') out.push({ inst: L.inst, campus: L.campus }); });
      var seen = {}; return out.filter(function (x) { var k = x.inst; if (seen[k]) return false; seen[k] = 1; return true; });
    }
    (function () {
      var origRefer = X('renderRefer');
      setFn('renderRefer', function () {
        var u = S.user; if (!u || u.kind === 'faculty') return origRefer();
        var opts = aiReferTo(u);
        if (!opts.length && !u.insts) { u.insts = []; loadInsts().then(function () { if (X('parse')().v === 'refer') F('renderRefer'); }).catch(function () {}); return origRefer(); }
        if (!opts.length) return origRefer();
        var cur = opts.filter(function (o) { return o.inst === BR.refInst; })[0] || opts[0]; BR.refInst = cur.inst;
        var k0 = u.kind, i0 = u.inst, c0 = u.campus; u.kind = 'alum'; u.inst = cur.inst; u.campus = cur.campus;
        try { var r = origRefer(); } finally { u.kind = k0; u.inst = i0; u.campus = c0; }
        var form = $('#rf');
        if (form && opts.length > 1) {
          form.insertAdjacentHTML('afterbegin', '<div style="display:grid;gap:6px"><label class="label" for="r-inst" style="margin:0">Refer to alumni of</label>'
            + F('selWrap', '<select class="input" id="r-inst">' + opts.map(function (o) { return '<option value="' + aiEsc(o.inst) + '"' + (o.inst === cur.inst ? ' selected' : '') + '>' + aiEsc(IB[o.inst].n) + '</option>'; }).join('') + '</select>') + '</div>');
        }
        return r;
      });
    })();
    on('change', '#r-inst', function (e, t) { BR.refInst = t.value; F('renderRefer'); });

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
        ok(await sb.from('profiles').update({ avatar: typeof u.av === 'object' ? u.av : {}, experiences: u.kind === 'alum' ? (u.exp || []) : [], helps: u.open, fields: u.kind === 'student' ? (u.fields || []).slice(0, 3) : [] }).eq('id', u.id));
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
      var rInst = BR.refInst || u.inst; try { await rpc('create_referral_for', { p_email: em, p_institute: rInst }); } catch (e) { return toast(why(e), { t: 'Not sent', k: 'warn' }); }
      u.refs = u.refs || []; u.refs.unshift({ email: em.toLowerCase(), name: nm, code: '', at: new Date(), status: 'pending' });
      F('renderRefer');
      F('modal', F('mdHead', 'Referral sent', F('esc', nm || em) + ' will get an email with their code.')
        + '<p class="help">The code works once and expires in 14 days. They enter it at the verify step when they sign up as an alum of ' + F('esc', IB[rInst].s) + '.</p>'
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

    /* ---------- contact limit (R11): the member's own number, per day or per week ---------- */
    var CL = { day: false };
    function clApply(m) { S.limit = m.limit; BR.period = m.period; BR.resetsAt = m.resets_at ? new Date(m.resets_at) : null; CL.day = m.period === 'day'; }
    /* the prototype's wording says "week"; with a daily limit say "day" instead (not on the legal pages, which the admin edits as page text) */
    function dayWords(t) { return t.replace(/\bthis week\b/g, 'today').replace(/\beach week\b/g, 'each day').replace(/\ba week\b/g, 'a day').replace(/\bper week\b/g, 'per day').replace(/resets Monday/g, 'resets at midnight'); }
    function clTidy(node) {
      if (!CL.day || !node) return;
      var host = node.nodeType === 1 ? node : node.parentElement, v = host && host.closest ? host.closest('[id^="v-"]') : null;
      if (v && /^v-(about|privacy|terms|cookies|guidelines)$/.test(v.id)) return;
      var hit = [];
      if (node.nodeType === 3) hit.push(node);
      else if (node.nodeType === 1) { var w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), n; while ((n = w.nextNode())) { if (/week|Monday/.test(n.nodeValue)) hit.push(n); } }
      hit.forEach(function (t) { var nv = dayWords(t.nodeValue); if (nv !== t.nodeValue) t.nodeValue = nv; });
    }
    new MutationObserver(function (ms) { if (!CL.day) return; ms.forEach(function (m) { [].forEach.call(m.addedNodes, clTidy); }); }).observe(document.body, { childList: true, subtree: true });
    var clOrigLimit = X('limitHtml'), clOrigReset = X('nextReset');
    setFn('limitHtml', function () { var h = clOrigLimit.apply(null, arguments); return CL.day ? dayWords(h) : h; });
    /* the reset date comes from the database (midnight India time for a day, Monday 00:00 for a week) */
    setFn('nextReset', function () { if (!BR.resetsAt) return clOrigReset(); var t = new Date(BR.resetsAt.getTime() + 330 * 60000); return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); });
    /* when the day or week rolls over while the page is open, count again from the database */
    function clDue() { return !!(S.user && BR.resetsAt && Date.now() > BR.resetsAt.getTime()); }
    async function clRefresh() { try { await loadSettings(); await loadContacts(); renderAll(); } catch (e) { /* try again next tick */ } }
    setInterval(function () { if (!document.hidden && clDue()) clRefresh(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && clDue()) clRefresh(); });

    /* ---------- render wrappers (draw first, then tidy) ---------- */
    function wrap(name, after) { var orig = X(name); setFn(name, function () { var r = orig.apply(null, arguments); try { after(); } catch (e) { console.error('[bridges]', name, e); } return r; }); }
    wrap('renderLogin', function () { var d = $('#v-login [data-demo], #v-login [data-demofac]'); if (d) { var blk = d.closest('.form'); if (blk) blk.remove(); } });
    (function () {
      var origRJ = X('renderJoin');
      setFn('renderJoin', function () {
        S.join.mode = ''; S.join.ref = null;      // our referral screens (below) handle codes with the real database
        var r = origRJ.apply(null, arguments);
        try { postJoin(); } catch (e) { console.error('[bridges] renderJoin', e); }
        return r;
      });
    })();
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
      try { await rpc(J.method === 'alumni' ? 'request_alumni_code' : 'request_email_code', { p_email: J.otp.email }); } catch (e) { return toast(why(e), { k: 'warn' }); }
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

    /* ---------- email domains and institutes the admin manages (Settings) ---------- */
    BR.xdoms = [];
    function registerInst(r) {
      var G = X('GROUPS'), GB = X('GB'), GS = X('GSING'), INST = X('INST'), g = r.grp;
      if (!GB[g]) { var o = { k: g, label: 'Other institutes' }; G.push(o); GB[g] = o; GS[g] = 'Other'; }
      var i = { id: r.id, s: r.short, n: r.name, g: g, d: r.email_domain || '', br: (r.branches && r.branches.length) ? r.branches : ['Design'] };
      if (r.campuses && r.campuses.length) i.cp = r.campuses;
      INST.push(i); IB[r.id] = i;
    }
    async function loadDomains() {
      try {
        ok(await sb.from('institutes').select('id,short,name,grp,email_domain,campuses,branches')).forEach(function (r) { if (!IB[r.id]) registerInst(r); });
        var xd = await rpc('extra_domains'), A = X('ALUM_DOMS');
        BR.xdoms = (xd && xd.student) || [];
        A.length = 0; ((xd && xd.alumni) || []).forEach(function (a) { A.push({ inst: a.inst, d: a.d, from: a.from || 0 }); });
      } catch (e) { console.warn('[bridges] could not load the domain lists, using the built-in ones', e); }
    }
    /* a student address is the institute's own domain or one the admin added; an alumni address is never a student address */
    (function () {
      var orig = X('domainOk');
      setFn('domainOk', function (email, instId) {
        var m = /^[^\s@]+@([^\s@]+)$/.exec(String(email || '').trim().toLowerCase()); if (!m) return false;
        var dm = m[1]; if (X('alumDomOf')(email)) return false;
        if (orig(email, instId)) return true;
        return BR.xdoms.some(function (x) { return x.inst === instId && (dm === x.d || dm.endsWith('.' + x.d)); });
      });
    })();

    /* ---------- boot ---------- */
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === 'SIGNED_OUT' && BR.uid) { setTimeout(function () { clearMember(); if (BR.booted) { F('renderNav'); F('route'); } }, 0); }
      else if (ev === 'SIGNED_IN' && session && BR.booted) { setTimeout(function () { if (session.user.id === BR.uid || BR.settling) return; settle().then(function (o) { goNext(o, true); }); }, 0); }
    });
    gisOverlays();
    var start = function () { if (BR.booted) return; BR.booted = true; if (window.__BRBOOT) window.__BRBOOT(); };
    var fresh = false; try { fresh = sessionStorage.getItem('bridges-oauth') === '1'; sessionStorage.removeItem('bridges-oauth'); } catch (e) {}
    loadDomains().then(function () { return settle(); }).then(function (out) { BR.booted = true; if (BR.uid) { if (fresh) sb.rpc('log_signin', { p_faculty: false }).then(function () {}, function () {}); else sb.rpc('touch_last_seen').then(function () {}, function () {}); } goNext(out, fresh && out === 'member'); if (window.__BRBOOT) window.__BRBOOT(); })
      .catch(function (e) { console.error('[bridges] start-up failed', e); start(); toast('Could not reach the server. Please reload in a moment.', { t: 'Offline?', k: 'warn' }); });
    /* gentle polling: join status while waiting, the volunteer queue while volunteering */
    setInterval(function () {
      if (document.hidden) return;
      if (S.join.step === 3 && !S.user) checkJoinStatus(true).catch(function () {});
      else if (S.user && S.user.vol) loadQueue().then(function () { F('renderNav'); if (X('parse')().v === 'queue' && !$('.md,.lb')) F('renderQueue'); }).catch(function () {});
    }, 45000);
  }
})();
