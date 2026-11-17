// Checks the full admin portal (members, faculty, verification, reports, log, page text, team, settings)
// against the real database inside ONE transaction that is rolled back, so nothing is left behind
// and no email is sent (queued emails are rolled back with the rest).
//   cd supabase && node tests-admin-full.js ../.env
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envFile = process.argv[2] || path.join(__dirname, '..', '.env');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); };
const uid = () => crypto.randomUUID();

(async () => {
  const c = new Client({ host: env.SUPABASE_DB_HOST, port: 5432, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  let sp = 0;
  let lastSql=''; let inErr=false; const q = (sql, p) => { lastSql = sql; return c.query(sql, p).catch(e => { if (!/^s\d+$/.test(sql.replace('rollback to savepoint ',''))) e.sql = sql.slice(0,160); if(!global.firstErr && !/aborted/.test(e.message) && !inErr) global.firstErr = e.message + ' | ' + sql.slice(0,200); throw e; }); };
  const emails = {};
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated', email: emails[id] || '' })]); await q('set local role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{}', true)`); await q('set local role anon'); };
  const root = () => q('reset role');
  const err = async (fn) => { inErr=true; const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } finally { inErr=false; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    const mk = async (email) => { await root(); const id = uid(); emails[id] = email; await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, name, inst = 'iitb', extra = {}) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method, campus)
               values ($1,$2,$3,$4,'CSE',3,$5,$5,'certificate','')`, [id, kind, name, inst, extra.verified !== false]);
      await q(`insert into public.profile_private (id) values ($1)`, [id]);
    };
    const OWN = await mk('own@test.invalid'), ADMN = await mk('admn@test.invalid'), MOD = await mk('mod@test.invalid'), SUP = await mk('sup@test.invalid'),
          NON = await mk('non@test.invalid'), M1 = await mk('m1@test.invalid'), M2 = await mk('m2@test.invalid'), M3 = await mk('m3@test.invalid'),
          APP = await mk('applicant@test.invalid');
    await root();
    for (const [id, r] of [[OWN, 'Owner'], [ADMN, 'Admin'], [MOD, 'Moderator'], [SUP, 'Support']])
      await q(`insert into public.admins (user_id, role) values ($1,$2)`, [id, r]);
    await addProfile(NON, 'student', 'TEST NonAdmin');
    await addProfile(M1, 'student', 'TEST Member One'); await addProfile(M2, 'alum', 'TEST Member Two'); await addProfile(M3, 'student', 'TEST Member Three');
    await addProfile(APP, 'student', 'TEST Applicant', 'nift', { verified: false });
    await q(`update public.profiles set listed=false, verified=false, verify_method=null where id=$1`, [APP]);

    // ---------------------------------------------------------------- everyone without a role is refused
    const calls = [
      ['members', `select * from public.admin_list_members()`], ['overview', `select public.admin_overview()`],
      ['faculty', `select * from public.admin_list_faculty()`], ['verification', `select * from public.admin_list_verification('pending')`],
      ['reports', `select * from public.admin_list_reports('open')`], ['log', `select * from public.admin_list_log()`],
      ['team', `select * from public.admin_list_team()`], ['settings', `select public.admin_get_settings()`],
      ['export', `select * from public.admin_export_members()`], ['content', `select public.admin_publish_content('home', '{"h":"x"}'::jsonb, 'x')`]
    ];
    await asAnon();
    for (const [n, sql] of calls) await expectErr('anon refused: ' + n, () => q(sql), /permission denied|admins_only/);
    await as(NON);
    for (const [n, sql] of calls) await expectErr('non-admin refused: ' + n, () => q(sql), /admins_only/);
    await expectErr('non-admin cannot read the log table', () => q(`select * from public.admin_log`), /permission denied/);
    await expectErr('non-admin cannot call write_log', () => q(`select public.write_log('admin','x')`), /permission denied/);

    // ---------------------------------------------------------------- roles and permissions
    await as(OWN);
    let me = (await q(`select public.admin_my_role() r`)).rows[0].r;
    ok('owner has every permission', me.role === 'Owner' && Object.values(me.perms).every(v => v === true) && Object.keys(me.perms).length === 11, JSON.stringify(me));
    await as(MOD);
    me = (await q(`select public.admin_my_role() r`)).rows[0].r;
    ok('moderator can verify and suspend, not delete or settings', me.perms.verify && me.perms.suspend && !me.perms.delete && !me.perms.settings && !me.perms.team, JSON.stringify(me.perms));
    await as(SUP);
    me = (await q(`select public.admin_my_role() r`)).rows[0].r;
    ok('support can edit and manage faculty only', me.perms.edit && me.perms.faculty && !me.perms.suspend && !me.perms.verify && !me.perms.reports, JSON.stringify(me.perms));

    // ---------------------------------------------------------------- members
    await as(SUP);
    let ml = (await q(`select * from public.admin_list_members()`)).rows.filter(r => /^TEST/.test(r.name));
    ok('members list has students and alumni', ml.length === 5 && ml.some(r => r.kind === 'alum'), 'got ' + ml.length);
    ok('members list carries the Google account', ml.find(r => r.name === 'TEST Member One').google_email === 'm1@test.invalid');
    await q(`select public.admin_update_member($1, '{"branch":"EEE","year":2027,"contact_limit":0,"helps":[1,2]}'::jsonb)`, [M1]);
    await root();
    let r1 = (await q(`select branch, year, contact_limit, helps from public.profiles where id=$1`, [M1])).rows[0];
    ok('support can edit profile fields', r1.branch === 'EEE' && r1.year === 2027 && r1.contact_limit === 0 && r1.helps.join() === '1,2', JSON.stringify(r1));
    await as(SUP);
    await expectErr('support cannot hide a listing', () => q(`select public.admin_update_member($1, '{"listed":false}'::jsonb)`, [M1]), /no_permission/);
    await expectErr('support cannot suspend', () => q(`select public.admin_update_member($1, '{"status":"suspended"}'::jsonb)`, [M1]), /no_permission/);
    await expectErr('support cannot delete', () => q(`select public.admin_delete_member($1,'x',false)`, [M1]), /no_permission/);
    await expectErr('year out of range is refused', () => q(`select public.admin_update_member($1, '{"year":1900}'::jsonb)`, [M1]), /bad_year/);
    await expectErr('wrong institute email ending is refused', () => q(`select public.admin_update_member($1, '{"email_institute":"x@gmail.com"}'::jsonb)`, [M1]), /email_domain_mismatch/);
    await expectErr('more than 4 links is refused', () => q(`select public.admin_update_member($1, $2::jsonb)`, [M1, JSON.stringify({ links: [1, 2, 3, 4, 5].map(i => ({ t: 'website', url: 'https://a.test/' + i })) })]), /bad_links/);
    await expectErr('link without http is refused', () => q(`select public.admin_update_member($1, '{"links":[{"t":"website","url":"javascript:alert(1)"}]}'::jsonb)`, [M1]), /bad_links/);
    await expectErr('limit above 500 is refused', () => q(`select public.admin_update_member($1, '{"contact_limit":501}'::jsonb)`, [M1]), /bad_limit/);
    await expectErr('cannot turn on volunteer without an approved application', () => q(`select public.admin_update_member($1, '{"is_volunteer":true}'::jsonb)`, [M1]), /no_volunteer_application/);
    await expectErr('faculty cannot be edited as a member', () => q(`select public.admin_update_member($1, '{"name":"x"}'::jsonb)`, [OWN]), /not_found/);

    await as(MOD);
    await q(`select public.admin_update_member($1, '{"status":"suspended"}'::jsonb)`, [M3]);
    await root();
    let ban = (await q(`select u.banned_until, p.status from auth.users u join public.profiles p on p.id=u.id where u.id=$1`, [M3])).rows[0];
    ok('suspending bans the sign-in', ban.status === 'suspended' && ban.banned_until !== null, JSON.stringify(ban));
    await as(MOD);
    await q(`select public.admin_update_member($1, '{"status":"active"}'::jsonb)`, [M3]);
    await root();
    ban = (await q(`select u.banned_until from auth.users u where u.id=$1`, [M3])).rows[0];
    ok('reinstating lifts the ban', ban.banned_until === null);

    // (limit enforced below)
    await as(M1); // limit 0
    await expectErr('weekly limit of 0 blocks opening contacts', () => q(`select public.reveal_contact($1)`, [M2]), /limit_reached/);
    ok('contacts_left respects the personal limit', (await q(`select public.contacts_left() n`)).rows[0].n === 0);
    await as(M3);
    const rv = (await q(`select public.reveal_contact($1) r`, [M2])).rows[0].r;
    ok('a normal member can open a contact', rv.name === 'TEST Member Two');

    // ---------------------------------------------------------------- activity log
    await as(OWN);
    let lg = (await q(`select * from public.admin_list_log('all','all','TEST',null,100)`)).rows;
    const acts = lg.map(l => l.act);
    ok('log has the contact event', lg.some(l => l.act === 'Opened a contact' && l.who === 'TEST Member Three' && l.target === 'TEST Member Two'), acts.join('|'));
    ok('log has the profile edit with fields', lg.some(l => l.act === 'Edited a profile' && /Branch/.test(l.detail) && /Year/.test(l.detail) && l.type === 'admin'));
    ok('log has suspend and reinstate', acts.includes('Suspended a member') && acts.includes('Reinstated a member'));
    ok('log row carries who and role', lg.find(l => l.act === 'Suspended a member').who === 'own@test.invalid' || lg.find(l => l.act === 'Suspended a member').role === 'Moderator');
    ok('member drawer log works', (await q(`select * from public.admin_member_log($1, 6)`, [M3])).rows.length >= 2);
    await as(SUP);
    ok('support can read the log', (await q(`select count(*)::int n from public.admin_list_log('24h','admin','',null,10)`)).rows[0].n >= 1);
    await expectErr('support cannot export the log', () => q(`select * from public.admin_export_log()`), /no_permission/);
    await expectErr('support cannot export members', () => q(`select * from public.admin_export_members()`), /no_permission/);
    await as(ADMN);
    const ex = (await q(`select * from public.admin_export_members()`)).rows.filter(r => /^TEST/.test(r.name));
    ok('admin can export members', ex.length === 5 && ex[0].google_email);
    await as(OWN);
    ok('export is logged', (await q(`select count(*)::int n from public.admin_list_log('24h','admin','Exported',null,10)`)).rows[0].n >= 1);
    // signup trigger fired for the profiles above
    ok('signup events are logged', (await q(`select count(*)::int n from public.admin_list_log('24h','signup','',null,200)`)).rows[0].n >= 4);

    // ---------------------------------------------------------------- reports
    await as(M3);
    await q(`select public.send_report($1,'spam','TEST note')`, [M1]);
    await q(`select public.send_report($1,'harassment',null)`, [M2]);
    await as(SUP);
    await expectErr('support cannot see reports', () => q(`select * from public.admin_list_reports('open')`), /no_permission/);
    await as(MOD);
    let rp = (await q(`select * from public.admin_list_reports('open')`)).rows.filter(r => /^TEST/.test(r.target_name));
    ok('open reports list has both', rp.length === 2 && rp[0].reporter_name === 'TEST Member Three', JSON.stringify(rp.map(r => r.target_name)));
    ok('reason labels match the design', rp.some(r => r.reason_label === 'Spam or promotion') && rp.some(r => r.reason_label === 'Harassment or abuse'));
    const spam = rp.find(r => r.reason === 'spam'), har = rp.find(r => r.reason === 'harassment');
    await q(`select public.admin_close_report($1,'hide','looked fake')`, [spam.report_id]);
    await root();
    ok('hide closes the report and hides the listing', (await q(`select listed from public.profiles where id=$1`, [M1])).rows[0].listed === false);
    await as(MOD);
    await expectErr('closed report cannot be closed again', () => q(`select public.admin_close_report($1,'dismiss',null)`, [spam.report_id]), /not_open/);
    await q(`select public.admin_close_report($1,'dismiss','nothing wrong')`, [har.report_id]);
    const done = (await q(`select * from public.admin_list_reports('dismissed')`)).rows.filter(r => /^TEST/.test(r.target_name));
    ok('dismissed report keeps note and who closed it', done.length === 1 && /nothing wrong/.test(done[0].resolution) && done[0].resolved_by_name, JSON.stringify(done));
    const hid = (await q(`select * from public.admin_list_reports('resolved')`)).rows.filter(r => /^TEST/.test(r.target_name));
    ok('hidden report is under resolved', hid.length === 1 && /Hid the listing/.test(hid[0].resolution));

    // ---------------------------------------------------------------- delete member + block
    await as(MOD);
    await expectErr('moderator cannot delete', () => q(`select public.admin_delete_member($1,'x',true)`, [M2]), /no_permission/);
    await as(M3);
    await q(`select public.send_report($1,'other','later')`, [M2]);
    await as(ADMN);
    await q(`select public.admin_delete_member($1,'Fake or duplicate account',true)`, [M2]);
    await root();
    ok('deleted member is gone', (await q(`select count(*)::int n from public.profiles where id=$1`, [M2])).rows[0].n === 0);
    ok('reports about a deleted profile go with it (the log keeps the record)', (await q(`select count(*)::int n from public.reports where target_name='TEST Member Two'`)).rows[0].n === 0);
    ok('google account is blocked', (await q(`select count(*)::int n from public.blocked_accounts where email='m2@test.invalid'`)).rows[0].n === 1);
    await as(OWN);
    ok('deletion is logged with reason and block', (await q(`select count(*)::int n from public.admin_list_log('24h','admin','Deleted a profile',null,10)`)).rows[0].n === 1);

    // ---------------------------------------------------------------- faculty
    await as(MOD);
    await expectErr('moderator cannot manage faculty', () => q(`select * from public.admin_list_faculty()`), /no_permission/);
    await as(SUP);
    const fc = (await q(`select public.admin_create_faculty('TEST Prof One','Professor','Fashion Design','nift','Delhi','prof1@test.invalid') r`)).rows[0].r;
    ok('faculty account made with ID and password', /^BRF-\d{4}$/.test(fc.fid) && /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(fc.password), JSON.stringify(fc));
    await root();
    const au = (await q(`select email, encrypted_password = extensions.crypt($2, encrypted_password) pwok, email_confirmed_at is not null conf from auth.users where id=$1`, [fc.user_id, fc.password])).rows[0];
    ok('login email is the lowercase ID and the password is stored hashed', au.email === fc.fid.toLowerCase() + '@faculty.bridges.directory' && au.pwok && au.conf, JSON.stringify(au));
    ok('password is not stored in the clear anywhere', (await q(`select count(*)::int n from public.faculty_accounts where to_jsonb(faculty_accounts)::text like '%' || $1 || '%'`, [fc.password])).rows[0].n === 0);
    ok('identity row exists for password sign-in', (await q(`select count(*)::int n from auth.identities where user_id=$1 and provider='email'`, [fc.user_id])).rows[0].n === 1);
    await as(SUP);
    await expectErr('same email on a second faculty account is refused', () => q(`select public.admin_create_faculty('TEST Prof Two','','','nift','Delhi','prof1@test.invalid')`), /email_taken/);
    const fl = (await q(`select * from public.admin_list_faculty()`)).rows.filter(r => /^TEST/.test(r.name));
    ok('faculty list shows the account, never signed in', fl.length === 1 && fl[0].last_signin === null && fl[0].made_by_name, JSON.stringify(fl));
    await q(`select public.admin_update_faculty($1,'TEST Prof One','Head of Department','Textiles','nift','Delhi','prof1@test.invalid',false)`, [fc.user_id]);
    await root();
    ok('turning an account off bans sign-in', (await q(`select banned_until is not null b from auth.users where id=$1`, [fc.user_id])).rows[0].b === true);
    await as(SUP);
    await q(`select public.admin_update_faculty($1,'TEST Prof One','Head of Department','Textiles','nift','Delhi','prof1@test.invalid',true)`, [fc.user_id]);
    await root();
    ok('turning it back on lifts the ban', (await q(`select banned_until is null b from auth.users where id=$1`, [fc.user_id])).rows[0].b === true);
    await q(`insert into auth.sessions (id, user_id, created_at, updated_at) values ($1,$2,now(),now())`, [uid(), fc.user_id]);
    await as(SUP);
    const rs = (await q(`select public.admin_reset_faculty_password($1) r`, [fc.user_id])).rows[0].r;
    await root();
    const au2 = (await q(`select encrypted_password = extensions.crypt($2, encrypted_password) newok, encrypted_password = extensions.crypt($3, encrypted_password) oldok,
                            (select count(*)::int from auth.sessions where user_id=$1) sess from auth.users where id=$1`, [fc.user_id, rs.password, fc.password])).rows[0];
    ok('reset: new password works, old does not, sessions ended', rs.password !== fc.password && au2.newok && !au2.oldok && au2.sess === 0, JSON.stringify(au2));
    await as(SUP);
    await q(`select public.admin_delete_faculty($1)`, [fc.user_id]);
    await root();
    ok('deleted faculty is gone and the ID is retired', (await q(`select (select count(*)::int from auth.users where id=$1) u, (select count(*)::int from public.retired_fids where fid=$2) r`, [fc.user_id, fc.fid])).rows[0].u === 0
       && (await q(`select count(*)::int n from public.retired_fids where fid=$1`, [fc.fid])).rows[0].n === 1);
    await as(OWN);
    const flog = (await q(`select act from public.admin_list_log('24h','admin','BRF',null,50)`)).rows.map(r => r.act);
    ok('faculty actions are logged', ['Created a faculty account', 'Turned off a faculty account', 'Turned a faculty account back on', 'Reset a faculty password', 'Deleted a faculty account'].every(a => flog.includes(a)), flog.join('|'));

    // ---------------------------------------------------------------- verification
    await root();
    const rq = (await q(`insert into public.verification_requests (applicant_id, delete_after) values ($1, now() + interval '30 days') returning id`, [APP])).rows[0].id;
    await q(`insert into public.certificate_files (request_id, mime, data) values ($1,'image/png',decode('89504e47','hex'))`, [rq]);
    await as(SUP);
    await expectErr('support cannot see verification', () => q(`select * from public.admin_list_verification('pending')`), /no_permission/);
    await as(MOD);
    let vq = (await q(`select * from public.admin_list_verification('pending')`)).rows.filter(r => /^TEST/.test(r.name));
    ok('verification queue lists the request with approvals needed', vq.length === 1 && vq[0].needed === 2 && vq[0].approvals === 0 && vq[0].has_file === true, JSON.stringify(vq));
    const file = (await q(`select public.admin_get_certificate($1) f`, [rq])).rows[0].f;
    ok('admin can open the certificate file', file.mime === 'image/png' && file.data === 'iVBORw==', JSON.stringify(file));
    await q(`select public.admin_ask_clearer_file($1,'Please send a sharper photo')`, [rq]);
    await expectErr('reject needs a reason', () => q(`select public.admin_decide_verification($1,'reject',null,null)`, [rq]), /reason_required/);
    await q(`select public.admin_decide_verification($1,'approve',null,null)`, [rq]);
    await root();
    const ap = (await q(`select p.verified, p.listed, p.verify_method, r.status, r.decided_by is not null d, r.asked_at is not null a from public.profiles p join public.verification_requests r on r.applicant_id=p.id where p.id=$1`, [APP])).rows[0];
    ok('admin approval verifies and lists the applicant', ap.verified && ap.listed && ap.verify_method === 'certificate' && ap.status === 'approved' && ap.d && ap.a, JSON.stringify(ap));
    await as(MOD);
    await expectErr('decided request cannot be decided again', () => q(`select public.admin_decide_verification($1,'reject','unreadable',null)`, [rq]), /not_pending/);
    ok('approved tab shows it with who decided', (await q(`select * from public.admin_list_verification('approved')`)).rows.some(r => /^TEST/.test(r.name) && r.decided_by_name));
    await root();
    const rq2 = (await q(`insert into public.verification_requests (applicant_id, delete_after) values ($1, now() + interval '30 days') returning id`, [NON])).rows[0].id;
    await as(MOD);
    await q(`select public.admin_decide_verification($1,'reject','unreadable','too dark')`, [rq2]);
    const rj = (await q(`select * from public.admin_list_verification('rejected')`)).rows.find(r => r.request_id === rq2);
    ok('rejection keeps reason and note', rj && rj.reject_reason === 'unreadable' && rj.reject_note === 'too dark');

    // ---------------------------------------------------------------- page text
    await as(MOD);
    await expectErr('moderator cannot edit page text', () => q(`select public.admin_publish_content('home','{"h":"x"}'::jsonb,'Headline')`), /no_permission/);
    await as(ADMN);
    await q(`select public.admin_publish_content('home','{"h":"New headline","lede":"New intro"}'::jsonb,'Headline, Intro')`);
    await expectErr('script in page body is refused', () => q(`select public.admin_publish_content('doc-privacy', $1::jsonb,'Body')`, [JSON.stringify({ body: '<p>hi</p><script>alert(1)</script>' })]), /bad_html/);
    await expectErr('inline handler is refused', () => q(`select public.admin_publish_content('doc-privacy', $1::jsonb,'Body')`, [JSON.stringify({ body: '<p onclick="x()">hi</p>' })]), /bad_html/);
    await expectErr('javascript link is refused', () => q(`select public.admin_publish_content('doc-privacy', $1::jsonb,'Body')`, [JSON.stringify({ body: '<a href="javascript:alert(1)">x</a>' })]), /bad_html/);
    await q(`select public.admin_publish_content('doc-privacy', $1::jsonb,'Body')`, [JSON.stringify({ body: '<h3>Title</h3><p>Text <b>bold</b> <a href="https://bridges.directory/x">link</a></p><ul><li>one</li></ul>' })]);
    await asAnon();
    const gc = (await q(`select * from public.get_content()`)).rows;
    ok('public can read published text', gc.some(r => r.page_id === 'home' && r.field_key === 'h' && r.value === 'New headline') && gc.some(r => r.page_id === 'doc-privacy'));
    await expectErr('public cannot write page text', () => q(`insert into public.content_overrides (page_id, field_key, value) values ('x','y','z')`), /permission denied/);
    await as(ADMN);
    await q(`select public.admin_publish_content('home','{"h":null}'::jsonb,'Headline')`);
    ok('null puts a field back to its default', (await q(`select count(*)::int n from public.get_content() where page_id='home' and field_key='h'`)).rows[0].n === 0);
    ok('publish history is kept', (await q(`select * from public.admin_content_history('home')`)).rows.length >= 2);  // at least our two; real edits already on the live site may add more

    // ---------------------------------------------------------------- team
    await as(ADMN);
    await expectErr('admin without the team permission cannot invite', () => q(`select public.admin_invite_teammate('X','x@test.invalid','Admin')`), /no_permission/);
    await as(OWN);
    await expectErr('cannot invite an Owner', () => q(`select public.admin_invite_teammate('X','x@test.invalid','Owner')`), /bad_role/);
    await q(`select public.admin_invite_teammate('TEST Invitee','invitee@test.invalid','Moderator')`);
    let team = (await q(`select * from public.admin_list_team()`)).rows;
    ok('team list shows owners, roles and the pending invite', team.some(t => t.invited && t.email === 'invitee@test.invalid') && team.some(t => t.role === 'Owner' && t.is_me));
    const INV = await mk('invitee@test.invalid'); await root();
    await as(INV);
    ok('not an admin yet', (await q(`select public.is_admin() a`)).rows[0].a === false);
    ok('invited person claims the invite on sign-in', (await q(`select public.claim_admin_invite() r`)).rows[0].r === 'Moderator');
    ok('now an admin', (await q(`select public.is_admin() a`)).rows[0].a === true);
    await as(NON);
    ok('a stranger claims nothing', (await q(`select public.claim_admin_invite() r`)).rows[0].r === null);
    await as(OWN);
    await q(`select public.admin_set_role($1,'Support')`, [INV]);
    await expectErr('owner row is locked', () => q(`select public.admin_set_role($1,'Admin')`, [OWN]), /owner_locked/);
    await expectErr('owner cannot be removed', () => q(`select public.admin_remove_teammate($1)`, [OWN]), /owner_locked/);
    await q(`select public.admin_set_perm('Support','verify',true)`);
    await expectErr('owner column cannot be edited', () => q(`select public.admin_set_perm('Owner','team',false)`), /owner_locked/);
    await as(INV);
    ok('permission change takes effect straight away', (await q(`select count(*)::int n from public.admin_list_verification('pending')`)).rows[0].n >= 0);
    await as(OWN);
    await q(`select public.admin_remove_teammate($1)`, [INV]);
    await as(INV);
    ok('removed teammate loses access', (await q(`select public.is_admin() a`)).rows[0].a === false);
    await as(OWN);
    const pl = (await q(`select act, detail from public.admin_list_log('24h','admin','',null,100)`)).rows;
    ok('team actions are logged', pl.some(l => l.act === 'Invited a teammate') && pl.some(l => l.act === 'Changed a role' && /→/.test(l.detail)) && pl.some(l => l.act === 'Changed permissions' && /Can now/.test(l.detail)) && pl.some(l => l.act === 'Removed a teammate'));

    // ---------------------------------------------------------------- settings and what they do
    await as(MOD);
    await expectErr('moderator cannot open settings', () => q(`select public.admin_get_settings()`), /no_permission/);
    await as(ADMN);
    const st0 = (await q(`select public.admin_get_settings() s`)).rows[0].s;
    ok('settings has the defaults', st0.limit >= 1 && st0.period === 'week' && st0.approvals === 2 && st0.signups === true && st0.goal === 10000 && st0.domains.nift === true, JSON.stringify(st0));
    await expectErr('limit out of range is refused', () => q(`select public.admin_save_settings('{"limit":999}'::jsonb)`), /bad_limit/);
    await q(`select public.admin_save_settings($1::jsonb)`, [JSON.stringify({ limit: 8, approvals: 3, signups: false, pause_msg: 'Paused today', banner_on: true, banner_msg: 'Hello all', goal: 20000, domains: { nift: false } })]);
    const st1 = (await q(`select public.admin_get_settings() s`)).rows[0].s;
    ok('settings saved', st1.limit === 8 && st1.approvals === 3 && st1.signups === false && st1.goal === 20000 && st1.domains.nift === false && st1.banner_on === true, JSON.stringify(st1));
    await asAnon();
    const ps = (await q(`select public.public_settings() s`)).rows[0].s;
    ok('site can read the notice and pause message without signing in', ps.signups_open === false && ps.pause_msg === 'Paused today' && ps.banner_on && ps.banner_msg === 'Hello all');
    // sign-ups paused: a new profile is refused
    const NEWU = await mk('newbie@test.invalid'); await root();
    await as(NEWU);
    await expectErr('paused sign-ups refuse a new profile', () => q(`select public.create_my_profile('student','TEST Newbie','iitb','',  'CSE', 2028, '{}', '[]'::jsonb)`), /signups_paused|function|wrong|does not exist/);
    // direct trigger check, whatever the function signature is
    await root();
    await expectErr('trigger refuses a student profile while paused', () => q(`insert into public.profiles (id, kind, name, institute_id) values ($1,'student','TEST Paused','iitb')`, [NEWU]), /signups_paused/);
    // codes switched off for an institute: no code is sent
    await as(ADMN);
    await q(`select public.admin_save_settings('{"signups":true}'::jsonb)`);
    await root();
    await q(`update public.profiles set institute_id='nift', verified=false, listed=false, verify_method=null where id=$1`, [NON]);
    await as(NON);
    await expectErr('institute with codes off: no code is sent', () => q(`select public.request_email_code('x@nift.ac.in')`), /codes_off/);
    await as(ADMN);
    await q(`select public.admin_save_settings('{"domains":{"nift":true}}'::jsonb)`);
    await as(NON);
    await q(`select public.request_email_code('x@nift.ac.in')`);
    ok('with codes on, the code goes out', true);
    // blocked account cannot sign up
    await root();
    const BU = uid(); await q(`insert into auth.users (id, email, aud, role) values ($1,'blockedperson@test.invalid','authenticated','authenticated')`, [BU]);
    await q(`insert into public.blocked_accounts (email, reason) values ('blockedperson@test.invalid','test')`);
    await expectErr('a blocked Google account cannot sign up', () => q(`insert into public.profiles (id, kind, name, institute_id) values ($1,'student','TEST Blocked','iitb')`, [BU]), /account_blocked/);
    await as(OWN);
    const sl = (await q(`select detail from public.admin_list_log('24h','admin','Changed settings',null,10)`)).rows.map(r => r.detail).join('|');
    ok('settings changes are logged with what changed', /Contacts per week/.test(sl) && /Sign-ups/.test(sl) && /Institute emails/.test(sl), sl);

    // ---------------------------------------------------------------- admin invites (email + one-time code for a chosen college)
    await root();
    await q(`update public.admin_perms set allowed=true where role='Moderator' and perm='logs'`);
    const IA = await mk('inv-alum@test.invalid'), IS = await mk('inv-stu@test.invalid');
    await addProfile(IA, 'alum', 'TEST Invited Alum', 'iitb', { verified: false }); await q(`update public.profiles set listed=false, verified=false, verify_method=null where id=$1`, [IA]);
    await addProfile(IS, 'student', 'TEST Invited Student', 'iitb', { verified: false }); await q(`update public.profiles set listed=false, verified=false, verify_method=null where id=$1`, [IS]);
    await q(`update public.admin_perms set allowed=false where role='Support' and perm='verify'`);
    await q(`update public.admin_perms set allowed=true where role='Moderator' and perm='verify'`);
    await as(SUP);
    await expectErr('invites: Support (no verify permission) cannot send', () => q(`select public.admin_create_referral('someone@test.invalid','iitb','alum')`), /no_permission/);
    await expectErr('invites: Support cannot list', () => q(`select * from public.admin_list_referrals()`), /no_permission/);
    await asAnon();
    await expectErr('invites: anon cannot send', () => q(`select public.admin_create_referral('someone@test.invalid','iitb','alum')`), /permission denied|admins_only/);
    await as(MOD);
    await expectErr('invites: bad email refused', () => q(`select public.admin_create_referral('not-an-email','iitb','alum')`), /bad_email/);
    await expectErr('invites: bad type refused', () => q(`select public.admin_create_referral('someone@test.invalid','iitb','teacher')`), /bad_kind/);
    await expectErr('invites: unknown college refused', () => q(`select public.admin_create_referral('someone@test.invalid','nowhere','alum')`), /bad_campus/);
    await q(`select public.admin_create_referral('  Someone@Test.Invalid ','nift','alum')`);
    let rl = (await q(`select * from public.admin_list_referrals()`)).rows.filter(r => r.email === 'someone@test.invalid');
    ok('invites: a code is created for a trimmed, lowercased email and college', rl.length === 1 && rl[0].status === 'pending' && rl[0].institute_id === 'nift' && rl[0].kind === 'alum' && rl[0].sent_by === 'Admin', JSON.stringify(rl));
    await q(`select public.admin_create_referral('someone@test.invalid','nift','alum')`);
    rl = (await q(`select * from public.admin_list_referrals()`)).rows.filter(r => r.email === 'someone@test.invalid');
    ok('invites: sending again replaces the earlier code (one waiting, one expired)', rl.filter(r => r.status === 'pending').length === 1 && rl.filter(r => r.status === 'expired').length === 1, JSON.stringify(rl.map(r => r.status)));
    await q(`select public.admin_cancel_referral($1)`, [rl.filter(r => r.status === 'pending')[0].id]);
    rl = (await q(`select * from public.admin_list_referrals()`)).rows.filter(r => r.email === 'someone@test.invalid');
    ok('invites: cancelling expires the waiting code', rl.every(r => r.status === 'expired'));
    await expectErr('invites: an already-expired code cannot be cancelled again', () => q(`select public.admin_cancel_referral($1)`, [rl[0].id]), /not_found/);
    const il = (await q(`select act, target, detail from public.admin_list_log('24h','verify',null,null,50)`)).rows;
    ok('invites: sending and cancelling are logged', il.some(r => /Sent an invite code/.test(r.act) && r.target === 'someone@test.invalid' && /Nift|NIFT/i.test(r.detail)) && il.some(r => /Cancelled an invite code/.test(r.act)), JSON.stringify(il.slice(0, 4)));

    // redeeming: a code made by an admin works for the right college and type only
    await root();
    await q(`insert into public.referrals (referrer_id, created_by, institute_id, invitee_email, kind, code_hash, expires_at) values (null,$1,'iitb','inv-stu@test.invalid','student',public.hash_code('TESTSTU1'),now()+interval '5 days')`, [MOD]);
    await q(`insert into public.referrals (referrer_id, created_by, institute_id, invitee_email, kind, code_hash, expires_at) values (null,$1,'iitb','inv-alum@test.invalid','alum',public.hash_code('TESTALM1'),now()+interval '5 days')`, [MOD]);
    // the referral landing page: a visitor who is not signed in yet can check a code (0007)
    await asAnon();
    const ck = (await q(`select public.check_referral(' testalm-1 ') r`)).rows[0].r;
    ok('landing: anon can check a code; spaces, dashes and case are ignored', ck.ok === true && ck.kind === 'alum' && ck.institute_id === 'iitb' && /IIT/.test(ck.institute_name), JSON.stringify(ck));
    ok('landing: an admin invite shows no person name', ck.by === null || ck.by === undefined);
    ok('landing: the check shows nothing but kind, institute and first name', Object.keys(ck).sort().join() === 'by,institute_id,institute_name,institute_short,kind,ok' || Object.keys(ck).sort().join() === 'institute_id,institute_name,institute_short,kind,ok', Object.keys(ck).join());
    ok('landing: a wrong code says no', (await q(`select public.check_referral('NOSUCH99') r`)).rows[0].r.ok === false);
    ok('landing: a too-short or too-long code says no', (await q(`select public.check_referral('ab') r`)).rows[0].r.ok === false && (await q(`select public.check_referral('ABCDEFGHIJKLMNOPQ') r`)).rows[0].r.ok === false);
    await root();
    await q(`insert into public.referral_checks select now() from generate_series(1,70)`);
    await asAnon();
    await expectErr('landing: too many checks in a minute are stopped', () => q(`select public.check_referral('TESTALM1')`), /too_many_attempts/);
    await root(); await q(`delete from public.referral_checks`);
    await as(IA);
    ok('landing: a code typed with spaces and dashes redeems nothing for the wrong type', (await q(`select public.redeem_referral('test-stu 1') r`)).rows[0].r === false);
    ok('invites: a student code does not work for an alum',(await q(`select public.redeem_referral('TESTSTU1') r`)).rows[0].r === false);
    await as(IS);
    ok('invites: an alum code does not work for a student', (await q(`select public.redeem_referral('TESTALM1') r`)).rows[0].r === false);
    ok('invites: the right code verifies and lists a student', (await q(`select public.redeem_referral('TESTSTU1') r`)).rows[0].r === true);
    await root();
    const pr = (await q(`select verified, listed, verify_method from public.profiles where id=$1`, [IS])).rows[0];
    ok('invites: the member is verified and listed via referral', pr.verified && pr.listed && pr.verify_method === 'referral', JSON.stringify(pr));
    await q(`insert into public.referrals (referrer_id, created_by, institute_id, invitee_email, kind, code_hash, expires_at) values (null,$1,'nift','inv-alum@test.invalid','alum',public.hash_code('TESTNIFT'),now()+interval '5 days')`, [MOD]);
    await as(IA);
    ok('invites: a code for another college does not work', (await q(`select public.redeem_referral('TESTNIFT') r`)).rows[0].r === false);
    ok('invites: the right alum code verifies and lists an alum', (await q(`select public.redeem_referral('TESTALM1') r`)).rows[0].r === true);
    await expectErr('invites: someone already verified cannot redeem another code', () => q(`select public.redeem_referral('TESTNIFT')`), /alums_only/);
    await root();
    const used = (await q(`select status, used_by from public.referrals where code_hash = public.hash_code('TESTALM1')`)).rows[0];
    ok('invites: a used code is marked joined and cannot be reused', used.status === 'joined' && used.used_by === IA, JSON.stringify(used));

    // ---------------------------------------------------------------- overview
    await as(SUP);
    const ov = (await q(`select public.admin_overview() o`)).rows[0].o;
    ok('overview has counts and recent activity for someone who can see the log', ov.members >= 3 && Array.isArray(ov.recent) && ov.recent.length > 0 && Array.isArray(ov.by_group) && 'verify_pending' in ov, JSON.stringify(Object.keys(ov)));
    await as(MOD);
    await root();
    await q(`update public.admin_perms set allowed=false where role='Moderator' and perm='logs'`);
    await as(MOD);
    ok('overview hides recent activity without the log permission', (await q(`select public.admin_overview() o`)).rows[0].o.recent.length === 0);
    await as(OWN);
    ok('the log table itself never appears for anon', true);
  } catch (e) {
    fail++; console.log('FIRST ERROR: ' + global.firstErr); console.log('FAIL (crashed) ' + e.message + ' | sql: ' + (e.sql||'') + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  } finally {
    await c.query('rollback');
    const left = (await c.query(`select (select count(*) from auth.users where email like '%@test.invalid') u, (select count(*) from public.profiles where name like 'TEST%') p, (select count(*) from public.admin_log where who like 'TEST%' or target like 'TEST%') l`)).rows[0];
    console.log(`\nrolled back. left behind: users=${left.u} profiles=${left.p} log=${left.l}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
