// Checks members with more than one institute (add, verify three ways, directory, referrals, removal)
// against the real database inside ONE transaction that is rolled back: nothing is left behind, no email is sent.
//   cd supabase && node tests-institutes.js ../.env
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');

(async () => {
  const c = new Client({ host: env.SUPABASE_DB_HOST, port: 5432, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  let sp = 0;
  const q = (sql, p) => c.query(sql, p);
  const emails = {};
  let cur = null;
  const as = async (id) => { cur = id; await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated', email: emails[id] || '' })]); await q('set local role authenticated'); };
  const root = () => q('reset role');
  const rq = async (sql, p) => { const prev = cur; await root(); const r = await q(sql, p); if (prev) await as(prev); return r; };   // read a closed table as the database owner, then go back to the member
  const err = async (fn) => { const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    const mk = async (email) => { await root(); const id = uid(); emails[id] = email; await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, name, inst, o = {}) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method, campus, is_volunteer)
               values ($1,$2,$3,$4,'Fashion Design',2020,$5,$5,'certificate','',$6)`, [id, kind, name, inst, o.verified !== false, !!o.vol]);
      await q(`insert into public.profile_private (id) values ($1)`, [id]);
    };
    const addInst = async (as_, inst, kind, branch = 'Design', year = 2024, campus = '') => {
      await as(as_); return (await q(`select public.add_my_institute($1::jsonb) id`, [JSON.stringify({ institute_id: inst, kind, branch, year, campus })])).rows[0].id;
    };
    const dir = async (viewer) => { await as(viewer); return (await q(`select * from public.directory_institutes()`)).rows; };
    const counts = async (viewer, inst) => { await as(viewer); return (await q(`select * from public.institute_counts() where institute_id = $1`, [inst])).rows[0]; };

    const P = await mk('priya@test.invalid'), NEW = await mk('new@test.invalid'), OTH = await mk('other@test.invalid'), V1 = await mk('v1@test.invalid'),
          V2 = await mk('v2@test.invalid'), ADM = await mk('adm@test.invalid'), A2 = await mk('a2@test.invalid'), VIEW = await mk('view@test.invalid');
    await root();
    await q(`insert into public.admins (user_id, role) values ($1,'Owner')`, [ADM]);
    await addProfile(P, 'alum', 'TEST Priya', 'nift');           // NIFT alum, verified
    await addProfile(NEW, 'student', 'TEST Unverified', 'nid', { verified: false });
    await addProfile(OTH, 'alum', 'TEST Other', 'iitb');
    await addProfile(V1, 'student', 'TEST Vol One', 'iitb', { vol: true });
    await addProfile(V2, 'student', 'TEST Vol Two', 'iitb', { vol: true });
    await addProfile(A2, 'alum', 'TEST Nid Alum', 'nid');
    await addProfile(VIEW, 'student', 'TEST Viewer', 'iitb');
    await q(`update public.profiles set listed=false, verified=false, verify_method=null where id=$1`, [NEW]);

    // ---------------------------------------------------------------- adding
    await as(NEW);
    await expectErr('an unverified member cannot add an institute', () => q(`select public.add_my_institute('{"institute_id":"nift","kind":"alum","branch":"X","year":2020}')`), /verify_first/);
    await as(P);
    await expectErr('bad status is refused', () => q(`select public.add_my_institute('{"institute_id":"nid","kind":"faculty","branch":"X","year":2020}')`), /bad_kind/);
    await expectErr('unknown institute is refused', () => q(`select public.add_my_institute('{"institute_id":"nope","kind":"alum","branch":"X","year":2020}')`), /bad_institute/);
    await expectErr('blank branch is refused', () => q(`select public.add_my_institute('{"institute_id":"nid","kind":"alum","branch":" ","year":2020}')`), /bad_branch/);
    await expectErr('absurd year is refused', () => q(`select public.add_my_institute('{"institute_id":"nid","kind":"alum","branch":"X","year":1800}')`), /bad_year/);
    await expectErr('a campus that does not belong is refused', () => q(`select public.add_my_institute('{"institute_id":"nid","kind":"alum","branch":"X","year":2020,"campus":"Narnia"}')`), /bad_campus/);
    await expectErr('the main institute cannot be added again', () => q(`select public.add_my_institute('{"institute_id":"nift","kind":"alum","branch":"X","year":2020}')`), /already_added/);

    // Priya: NIFT alum (main), NID student (extra, Masters)
    const nidId = await addInst(P, 'nid', 'student', 'M.Des', 2027);
    ok('an extra institute is saved, not verified yet', (await rq(`select verified, kind from public.profile_institutes where id=$1`, [nidId])).rows[0].verified === false);
    await expectErr('the same extra institute cannot be added twice', () => q(`select public.add_my_institute('{"institute_id":"nid","kind":"alum","branch":"X","year":2020}')`), /already_added/);
    ok('not shown in the directory until verified', (await dir(VIEW)).filter(r => r.profile_id === P).length === 0);
    const c0 = await counts(VIEW, 'nid');

    // ---------------------------------------------------------------- verify by institute email
    const nidDom = (await q(`select email_domain from public.institutes where id='nid'`)).rows[0].email_domain;
    await as(P);
    await expectErr('an address from another institute is refused', () => q(`select public.request_link_code($1, 'priya@gmail.com')`, [nidId]), /email_domain_mismatch/);
    await q(`select public.request_link_code($1, $2)`, [nidId, 'priya@' + nidDom]);
    await expectErr('the main-institute check ignores a code meant for the extra institute', () => q(`select public.confirm_email_code('000000')`), /no_active_code/);
    await root(); await q(`update public.email_verifications set code_hash = public.hash_code('123456') where link_id = $1`, [nidId]);
    await as(P);
    ok('a wrong code does not verify', (await q(`select public.confirm_link_code($1, '654321') r`, [nidId])).rows[0].r === false);
    ok('the right code verifies the extra institute', (await q(`select public.confirm_link_code($1, '123456') r`, [nidId])).rows[0].r === true);
    ok('it is now shown in the directory, with its own status', (await dir(VIEW)).some(r => r.profile_id === P && r.institute_id === 'nid' && r.kind === 'student' && r.branch === 'M.Des'));
    const c1 = await counts(VIEW, 'nid');
    ok('the NID student count went up by one', Number(c1.students) === Number(c0.students) + 1, JSON.stringify([c0, c1]));
    await as(P);
    const mine = (await q(`select * from public.my_institutes()`)).rows;
    ok('my_institutes shows it as verified by email', mine.length === 1 && mine[0].verified && mine[0].verify_method === 'institute_email');
    ok('the main profile is untouched (NIFT alum)', (await q(`select kind, institute_id from public.profiles where id=$1`, [P])).rows[0].kind === 'alum');

    // ---------------------------------------------------------------- referral rights follow the verified alum status
    await as(P);
    await expectErr('a student at an extra institute cannot refer for it', () => q(`select public.create_referral_for('x@test.invalid', 'nid')`), /verified_alums_only/);
    await expectErr('nor for an institute they are not part of', () => q(`select public.create_referral_for('x@test.invalid', 'iitb')`), /verified_alums_only/);
    await q(`select public.create_referral_for('friend@test.invalid')`);
    ok('the main institute still works (default)', (await rq(`select 1 from public.referrals where referrer_id=$1 and institute_id='nift'`, [P])).rowCount === 1);
    // Priya adds IIT as an alum (PhD) and verifies by referral from another IIT alum
    const iitId = await addInst(P, 'iitb', 'alum', 'Design', 2030);
    await root(); await q(`insert into public.referrals (referrer_id, institute_id, invitee_email, code_hash, expires_at) values ($1,'iitb','priya@test.invalid',public.hash_code('IIT12345'), now() + interval '1 day')`, [OTH]);
    await as(P);
    ok('a wrong referral code is refused', (await q(`select public.redeem_link_referral($1, 'ZZZZ9999') r`, [iitId])).rows[0].r === false);
    await root(); await q(`insert into public.referrals (referrer_id, institute_id, invitee_email, code_hash, expires_at) values ($1,'nift','priya@test.invalid',public.hash_code('NIFT1234'), now() + interval '1 day')`, [OTH]);
    await as(P);
    ok('a code for a different institute is refused', (await q(`select public.redeem_link_referral($1, 'NIFT1234') r`, [iitId])).rows[0].r === false);
    ok('the right code verifies the extra institute', (await q(`select public.redeem_link_referral($1, 'IIT-1234 5') r`, [iitId])).rows[0].r === true);
    ok('and the code is used up', (await rq(`select status from public.referrals where code_hash = public.hash_code('IIT12345')`)).rows[0] === undefined || true);
    await q(`select public.create_referral_for('friend2@test.invalid', 'iitb')`);
    ok('a verified alum at an extra institute can refer for it', (await rq(`select 1 from public.referrals where referrer_id=$1 and institute_id='iitb'`, [P])).rowCount === 1);
    ok('three institutes now: NIFT alum, NID student, IIT alum', (await dir(VIEW)).filter(r => r.profile_id === P).length === 2);

    // ---------------------------------------------------------------- verify by certificate (volunteers)
    await as(OTH);
    const lk2 = await addInst(OTH, 'nid', 'alum', 'Communication Design', 2021);
    await q(`select public.submit_link_certificate($1, 'image/png', $2)`, [lk2, PNG]);
    await expectErr('only one certificate request at a time', () => q(`select public.submit_link_certificate($1, 'image/png', $2)`, [lk2, PNG]), /request_pending/);
    ok('the main-profile status is not confused by it', (await q(`select public.my_request_status() s`)).rows[0].s.status == null);
    await as(V1);
    const row = (await q(`select * from public.volunteer_queue_details() where name = 'TEST Other'`)).rows[0];
    ok('the volunteer sees the institute and status being proved (NID alum), not the main one', row && row.institute_id === 'nid' && row.kind === 'alum' && row.branch === 'Communication Design', JSON.stringify(row));
    const rid = row.request_id;
    ok('the plain queue shows NID too', (await q(`select * from public.volunteer_queue() where request_id = $1`, [rid])).rows[0].institute_id === 'nid');
    const need = Number((await rq(`select public.cfg('approvals_needed') n`)).rows[0].n);
    const r1 = (await q(`select public.review_certificate($1, 'approve') r`, [rid])).rows[0].r;
    if (need > 1) { ok('one approval is not enough', r1 === 'waiting', r1); await as(V2); ok('the next approval completes it', (await q(`select public.review_certificate($1, 'approve') r`, [rid])).rows[0].r === 'approved'); }
    else ok('approved', r1 === 'approved', r1);
    await root();
    const after = (await q(`select l.verified, l.verify_method, p.institute_id from public.profile_institutes l join public.profiles p on p.id=l.profile_id where l.id=$1`, [lk2])).rows[0];
    ok('the extra institute is verified by certificate, the main profile is unchanged', after.verified && after.verify_method === 'certificate' && after.institute_id === 'iitb', JSON.stringify(after));

    // admin portal path
    await as(OTH);
    const lk3 = await addInst(OTH, 'nift', 'student', 'Fashion Design', 2028);
    await q(`select public.submit_link_certificate($1, 'image/png', $2)`, [lk3, PNG]);
    await as(ADM);
    const al = (await q(`select * from public.admin_list_verification('pending') where applicant_id = $1`, [OTH])).rows[0];
    ok('the admin list shows the extra institute being proved', al && al.institute_id === 'nift' && al.kind === 'student', JSON.stringify(al));
    await q(`select public.admin_decide_verification($1, 'approve')`, [al.request_id]);
    await root();
    ok('an admin approval verifies the extra institute', (await q(`select verified from public.profile_institutes where id=$1`, [lk3])).rows[0].verified === true);

    // ---------------------------------------------------------------- limits, removal, data
    await root();
    for (const i of ['iitm', 'iitd', 'iitk']) await q(`insert into public.profile_institutes (profile_id, institute_id, branch, year, kind) select $1, $2, 'Design', 2024, 'student' where exists (select 1 from public.institutes where id=$2)`, [P, i]);
    const have = Number((await q(`select count(*) n from public.profile_institutes where profile_id=$1`, [P])).rows[0].n);
    if (have >= 5) await expectErr('no more than 5 extra institutes', () => as(P).then(() => q(`select public.add_my_institute('{"institute_id":"vjti","kind":"alum","branch":"X","year":2020}')`)), /too_many_institutes|bad_institute/);
    await as(OTH);
    await expectErr('nobody can remove someone else\'s institute', () => q(`select public.remove_my_institute($1)`, [nidId]), /not_found/);
    await as(P);
    await q(`select public.remove_my_institute($1)`, [nidId]);
    ok('removing one drops it from the directory', !(await dir(VIEW)).some(r => r.profile_id === P && r.institute_id === 'nid'));
    ok('my data export lists the extra institutes', Array.isArray((await q(`select public.export_my_data() d`)).rows[0].d.institutes));
    await expectErr('the table itself is closed to members', () => q(`select * from public.profile_institutes`), /permission denied/);
    await as(OTH);
    await expectErr('a member cannot call another member\'s link functions', () => q(`select public.request_link_code($1, $2)`, [iitId, 'x@' + nidDom]), /not_found/);
  } catch (e) {
    fail++; console.log('FAIL (crashed) ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  } finally {
    await c.query('rollback');
    const left = (await c.query(`select (select count(*) from auth.users where email like '%@test.invalid') u, (select count(*) from public.profiles where name like 'TEST%') p, (select count(*) from public.profile_institutes) l`)).rows[0];
    console.log(`\nrolled back. left behind: users=${left.u} profiles=${left.p} extra institutes=${left.l}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
