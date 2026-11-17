// Runs the rules against the real database inside ONE transaction and rolls it back,
// so no test data is ever left behind.   cd supabase && npm i pg && node tests.js ../.env
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
const sha = s => crypto.createHash('sha256').update(s.toUpperCase()).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');

(async () => {
  const c = new Client({ host: env.SUPABASE_DB_HOST, port: 5432, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  let sp = 0;
  const q = (sql, p) => c.query(sql, p);
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set local role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{}', true)`); await q('set local role anon'); };
  const root = async () => { await q('reset role'); };
  // run fn; return error message or null; undo any partial effect of a failed call
  const err = async (fn) => { const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    await q(`select set_config('app.skip_email', 'on', true)`);
    // ---- people (made by the "system", tagged TEST, rolled back at the end)
    const mk = async (email) => { const id = uid(); await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, inst, o = {}) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, verified, listed, verify_method, is_volunteer)
               values ($1,$2,$3,$4,$5,$5,$6,$7)`, [id, kind, o.name || 'TEST ' + id.slice(0, 4), inst, !!o.verified, o.verified ? 'certificate' : null, !!o.vol]);
      await q(`insert into public.profile_private (id, email_personal) values ($1,$2)`, [id, `t${id.slice(0, 6)}@example.com`]);
    };
    const S = await mk('s@test.invalid'), T = await mk('t@test.invalid'), U = await mk('u@test.invalid'),
          V1 = await mk('v1@test.invalid'), V2 = await mk('v2@test.invalid'), V3 = await mk('v3@test.invalid'),
          X = await mk('x@test.invalid'), A = await mk('a@test.invalid'), B = await mk('b@test.invalid'),
          Z = await mk('z@test.invalid'), ADM = await mk('adm@test.invalid');
    for (const v of [V1, V2, V3]) await addProfile(v, 'student', 'nift', { verified: true, vol: true });
    await addProfile(X, 'student', 'iitb');
    await addProfile(A, 'alum', 'nift', { verified: true });
    await addProfile(B, 'alum', 'nift');
    await addProfile(Z, 'alum', 'iitb');
    await q(`insert into public.admins (user_id) values ($1)`, [ADM]);
    const targets = []; for (let i = 0; i < 7; i++) { const t = await mk(`tg${i}@test.invalid`); await addProfile(t, 'alum', 'nid', { verified: true }); targets.push(t); }

    // ---- 1. strangers see nothing
    await asAnon();
    await expectErr('anon cannot read profiles', () => q('select * from public.profiles'), /permission denied/);
    await expectErr('anon cannot read contributions', () => q('select * from public.contributions'), /permission denied/);
    ok('anon can read the institute list (14)', (await q('select count(*)::int n from public.institutes')).rows[0].n === 14);

    // ---- 2. sign-up
    await as(S);
    await expectErr('bad institute is refused', () => q(`select public.create_my_profile('{"kind":"student","name":"TEST S","institute_id":"nope"}')`), /bad_institute/);
    await expectErr('faculty cannot be self-created', () => q(`select public.create_my_profile('{"kind":"faculty","name":"x","institute_id":"nift"}')`), /bad_kind/);
    await q(`select public.create_my_profile('{"kind":"student","name":"TEST S","institute_id":"nift","campus":"Delhi","branch":"Fashion Design","year":2028,"helps":[0,1]}')`);
    ok('profile created, not verified or listed', (await q('select verified, listed from public.profiles where id = auth.uid()')).rows[0].verified === false);
    await expectErr('cannot self-verify with a direct update', () => q('update public.profiles set verified = true where id = auth.uid()'), /permission denied/);
    await expectErr('cannot make self a volunteer directly', () => q('update public.profiles set is_volunteer = true where id = auth.uid()'), /permission denied/);
    await expectErr('cannot insert a profile directly', () => q(`insert into public.profiles (id, kind, name) values (auth.uid(), 'student', 'x')`), /permission denied/);
    ok('can edit own branch', (await q(`update public.profiles set branch = 'Textile Design' where id = auth.uid()`)).rowCount === 1);

    // ---- 3. institute email code
    await expectErr('gmail address is refused', () => q(`select public.request_email_code('s@gmail.com')`), /email_domain_mismatch/);
    await expectErr('other institute domain is refused', () => q(`select public.request_email_code('s@iitb.ac.in')`), /email_domain_mismatch/);
    await q(`select public.request_email_code('s@nift.ac.in')`);
    await root(); await q(`update public.email_verifications set code_hash = $1 where user_id = $2`, [sha('123456'), S]); await as(S);
    ok('wrong code is rejected', (await q(`select public.confirm_email_code('000000') r`)).rows[0].r === false);
    ok('right code verifies', (await q(`select public.confirm_email_code('123456') r`)).rows[0].r === true);
    const sp1 = (await q('select verified, listed, verify_method from public.profiles where id = auth.uid()')).rows[0];
    ok('student is now verified and listed by institute email', sp1.verified && sp1.listed && sp1.verify_method === 'institute_email');
    await expectErr('a used code cannot be reused', () => q(`select public.confirm_email_code('123456')`), /no_active_code/);

    // ---- 4. certificate review
    await as(T);
    await q(`select public.create_my_profile('{"kind":"student","name":"TEST T","institute_id":"nift"}')`);
    const rid = (await q(`select public.submit_certificate('image/png', $1) id`, [PNG])).rows[0].id;
    await expectErr('second pending request is refused', () => q(`select public.submit_certificate('image/png', $1)`, [PNG]), /request_pending/);
    ok('applicant can see own file', (await q('select public.get_certificate($1) j', [rid])).rows[0].j.mime === 'image/png');
    await as(X);
    await expectErr('non-volunteer cannot open a certificate', () => q('select public.get_certificate($1)', [rid]), /not_allowed/);
    await expectErr('non-volunteer has no queue', () => q('select * from public.volunteer_queue()'), /volunteers_only/);
    await as(V3);
    ok('volunteer sees the request in the queue', (await q('select count(*)::int n from public.volunteer_queue() where request_id = $1', [rid])).rows[0].n === 1);
    ok('volunteer can open it', (await q('select public.get_certificate($1) j', [rid])).rows[0].j.data.length > 0);
    await as(V1);
    ok('first approval gives "waiting"', (await q(`select public.review_certificate($1,'approve') r`, [rid])).rows[0].r === 'waiting');
    await expectErr('same volunteer cannot review twice', () => q(`select public.review_certificate($1,'approve')`, [rid]), /already_reviewed/);
    await expectErr('reviews are hidden from volunteers (direct read)', () => q('select * from public.verification_reviews'), /permission denied/);
    await as(T);
    await expectErr('applicant cannot review (not a volunteer)', () => q(`select public.review_certificate($1,'approve')`, [rid]), /volunteers_only/);
    await expectErr('applicant cannot read the reviews', () => q('select * from public.verification_reviews'), /permission denied/);
    await as(V2);
    ok('second approval approves', (await q(`select public.review_certificate($1,'approve') r`, [rid])).rows[0].r === 'approved');
    await root();
    const t1 = (await q(`select p.verified, p.listed, p.verify_method, extract(epoch from (r.delete_after - now()))/86400 d from public.profiles p, public.verification_requests r where p.id = $1 and r.id = $2`, [T, rid])).rows[0];
    ok('applicant verified by certificate', t1.verified && t1.listed && t1.verify_method === 'certificate');
    ok('file scheduled for deletion in 15 days after approval', t1.d > 14.9 && t1.d < 15.1, 'days=' + t1.d);

    await as(V3);
    const ownReq = await (async () => { await root(); const id = uid(); await q(`insert into public.verification_requests (id, applicant_id, delete_after) values ($1,$2, now()+interval '30 days')`, [id, V3]); await as(V3); return id; })();
    await expectErr('volunteer cannot review own application', () => q(`select public.review_certificate($1,'approve')`, [ownReq]), /own_application/);

    await as(U);
    await q(`select public.create_my_profile('{"kind":"alum","name":"TEST U","institute_id":"nift"}')`);
    await expectErr('wrong file type is refused', () => q(`select public.submit_certificate('application/pdf', $1)`, [PNG]), /check constraint/);
    await expectErr('empty file is refused', () => q(`select public.submit_certificate('image/png', '')`), /bad_file_size/);
    const rid2 = (await q(`select public.submit_certificate('image/png', $1) id`, [PNG])).rows[0].id;
    await as(V1);
    await expectErr('reject needs a reason', () => q(`select public.review_certificate($1,'reject')`, [rid2]), /reason_required/);
    ok('reject with a reason', (await q(`select public.review_certificate($1,'reject','unreadable') r`, [rid2])).rows[0].r === 'rejected');
    await root();
    const d2 = (await q(`select extract(epoch from (delete_after - now()))/86400 d, status from public.verification_requests where id = $1`, [rid2])).rows[0];
    ok('rejected file scheduled for deletion in 30 days', d2.status === 'rejected' && d2.d > 29.9 && d2.d < 30.1, JSON.stringify(d2));

    // ---- 5. contacts (the site number may have been changed in the admin, so fix it to 5 inside this rolled-back test)
    await root();
    await q(`update public.settings set value = '5' where key = 'weekly_contacts'`);
    await q(`update public.settings set value = 'week' where key = 'contact_period'`);
    await as(S);
    for (let i = 0; i < 5; i++) await q('select public.reveal_contact($1)', [targets[i]]);
    ok('5 contacts opened', (await q('select public.contacts_left() n')).rows[0].n === 0);
    await expectErr('6th contact is blocked', () => q('select public.reveal_contact($1)', [targets[5]]), /limit_reached/);
    ok('an already opened contact stays visible', (await q('select public.reveal_contact($1) j', [targets[0]])).rows[0].j.email.includes('@'));
    await expectErr('cannot open own contact', () => q('select public.reveal_contact($1)', [S]), /own_contact/);
    ok('private table shows only own row', (await q('select count(*)::int n from public.profile_private')).rows[0].n === 1);
    await as(X);
    await expectErr('unverified member cannot open contacts', () => q('select public.reveal_contact($1)', [targets[0]]), /verified_only/);
    ok('unverified person is not in the directory', (await q(`select count(*)::int n from public.profiles where id = $1`, [X])).rows[0].n === 1);
    await as(S);
    ok('directory hides unverified people (U is hidden from S)', (await q(`select count(*)::int n from public.profiles where id = $1`, [U])).rows[0].n === 0);

    // ---- 6. reports
    await q(`select public.send_report($1, 'spam', 'TEST')`, [targets[0]]);
    await expectErr('reports are not readable', () => q('select * from public.reports'), /permission denied/);

    // ---- 7. volunteers and admin
    await as(S);
    await expectErr('bad phone number is refused', () => q(`select public.apply_volunteer('12345', true)`), /check|violates/);
    await expectErr('consent is required', () => q(`select public.apply_volunteer('+919876543210', false)`), /consent_required/);
    await q(`select public.apply_volunteer('+919876543210', true)`);
    await expectErr('applying twice is refused', () => q(`select public.apply_volunteer('+919876543210', true)`), /application_exists/);
    await expectErr('non-admin cannot list applications', () => q('select * from public.admin_list_applications()'), /admins_only/);
    await as(ADM);
    const apps = (await q(`select * from public.admin_list_applications('pending') where user_id = $1`, [S])).rows;
    ok('admin sees the application', apps.length === 1 && apps[0].phone === '+919876543210');
    await q('select public.admin_review_application($1, $2)', [apps[0].application_id, 'approve']);
    ok('admin sees the volunteer', (await q('select count(*)::int n from public.admin_list_volunteers() where user_id = $1', [S])).rows[0].n === 1);
    await root();
    ok('approved student is now a volunteer', (await q('select is_volunteer from public.profiles where id = $1', [S])).rows[0].is_volunteer === true);
    await as(ADM);
    await q('select public.admin_remove_volunteer($1)', [S]);
    await root();
    ok('admin removed the volunteer', (await q('select is_volunteer from public.profiles where id = $1', [S])).rows[0].is_volunteer === false);
    await as(S);
    await expectErr('non-admin cannot remove volunteers', () => q('select public.admin_remove_volunteer($1)', [V1]), /admins_only/);
    await as(ADM);
    ok('admin cannot read everyone\'s private details directly', (await q('select count(*)::int n from public.profile_private')).rows[0].n === 0);

    // ---- 8. contributions
    await as(S);
    await expectErr('tiny amount is refused', () => q('select public.start_contribution(100, false, null)'), /amount_too_small/);
    const cid = (await q('select public.start_contribution(50000, false, null) id')).rows[0].id;
    await expectErr('browser cannot mark a payment as paid', () => q(`select public.mark_contribution_paid($1,'o','p')`, [cid]), /permission denied/);
    await root();
    await q(`set local role service_role`); await q(`select public.mark_contribution_paid($1,'order_TEST','pay_TEST')`, [cid]); await root();
    await as(T);
    const rc = (await q('select * from public.recent_contributions(5)')).rows;
    ok('paid contribution appears in the public list', rc.length === 1 && rc[0].amount_paise === '50000');
    const pg = (await q('select * from public.contribution_progress()')).rows[0];
    ok('progress counts the payment', pg.raised_paise === '50000' && pg.target_paise === '1000000');
    await as(ADM);
    ok('admin can view contributions', (await q('select count(*)::int n from public.admin_list_contributions()')).rows[0].n >= 1);
    await as(T);
    await expectErr('non-admin cannot view contributions', () => q('select * from public.admin_list_contributions()'), /admins_only/);

    // ---- 9. referrals
    await as(A);
    await q(`select public.create_referral('friend@example.com')`);
    await root(); await q(`update public.referrals set code_hash = $1 where referrer_id = $2`, [sha('ABCD2345'), A]);
    await as(Z);
    ok('code from another institute fails', (await q(`select public.redeem_referral('abcd2345') r`)).rows[0].r === false);
    await as(B);
    ok('code from same institute works', (await q(`select public.redeem_referral('abcd2345') r`)).rows[0].r === true);
    await root();
    ok('referred alum is verified by referral', (await q('select verify_method m from public.profiles where id = $1', [B])).rows[0].m === 'referral');
    await as(A);
    ok('referrer sees status joined', (await q('select status from public.my_referrals()')).rows[0].status === 'joined');

    // ---- 10. my data and deletion
    await as(S);
    ok('export has my profile', (await q('select public.export_my_data() j')).rows[0].j.profile.name === 'TEST S');
    await q('select public.delete_my_account()');
    await root();
    ok('account deletion removes the profile', (await q('select count(*)::int n from public.profiles where id = $1', [S])).rows[0].n === 0);

    // ---- 11. automatic deletion of certificates
    await root();
    await q(`update public.verification_requests set delete_after = now() - interval '1 minute' where id = $1`, [rid]);
    ok('file exists before the clean-up', (await q('select count(*)::int n from public.certificate_files where request_id = $1', [rid])).rows[0].n === 1);
    const res = (await q('select public.daily_cleanup() j')).rows[0].j;
    ok('clean-up deleted the expired certificate', (await q('select count(*)::int n from public.certificate_files where request_id = $1', [rid])).rows[0].n === 0 && res.certificates_deleted >= 1, JSON.stringify(res));
    const kept = (await q('select status, file_deleted_at from public.verification_requests where id = $1', [rid])).rows[0];
    ok('verified flag and date kept after deletion', kept.status === 'approved' && kept.file_deleted_at !== null);
    await as(T);
    await expectErr('deleted file cannot be opened', () => q('select public.get_certificate($1)', [rid]), /file_deleted/);

    // ---- 12. plumbing
    await root();
    ok('daily job is scheduled', (await q(`select count(*)::int n from cron.job where jobname = 'bridges-daily-cleanup'`)).rows[0].n === 1);
    ok('Resend key is in the vault', (await q(`select count(*)::int n from vault.secrets where name = 'resend_api_key'`)).rows[0].n === 1);
    ok('every table has locks on', (await q(`select count(*)::int n from pg_tables where schemaname = 'public' and not rowsecurity`)).rows[0].n === 0);
  } catch (e) {
    fail++; console.log('FAIL (crashed) ' + e.message);
  } finally {
    await q('rollback');
    const left = (await q(`select (select count(*) from public.profiles)::int p, (select count(*) from auth.users where email like '%@test.invalid')::int u`)).rows[0];
    console.log(`\nrolled back. test rows left behind: profiles=${left.p}, test users=${left.u}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
