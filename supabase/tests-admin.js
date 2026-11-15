// Checks the three admin jobs (and that everyone else is refused) against the real database
// inside ONE transaction that is rolled back, so nothing is left behind.
//   cd supabase && npm i pg && node tests-admin.js ../.env
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
  const q = (sql, p) => c.query(sql, p);
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set local role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{}', true)`); await q('set local role anon'); };
  const err = async (fn) => { const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    const mk = async (email) => { const id = uid(); await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, name) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method)
               values ($1,'student',$2,'iitb','CSE',3,true,true,'certificate')`, [id, name]);
      await q(`insert into public.profile_private (id) values ($1)`, [id]);
    };
    const ADM = await mk('adm@test.invalid'), NON = await mk('non@test.invalid'),
          S1 = await mk('s1@test.invalid'), S2 = await mk('s2@test.invalid'), S3 = await mk('s3@test.invalid');
    await q(`insert into public.admins (user_id) values ($1)`, [ADM]);
    await addProfile(NON, 'TEST NonAdmin'); await addProfile(S1, 'TEST One'); await addProfile(S2, 'TEST Two'); await addProfile(S3, 'TEST Three');
    for (const [id, ph] of [[S1, '+919000000001'], [S2, '+919000000002'], [S3, '+919000000003']])
      await q(`insert into public.volunteer_applications (user_id, phone, consent) values ($1,$2,true)`, [id, ph]);
    await q(`insert into public.contributions (user_id, display_name, amount_paise, status, paid_at) values ($1,'TEST Payer',50000,'paid',now())`, [NON]);
    await q(`insert into public.contributions (user_id, display_name, amount_paise, status) values ($1,'TEST Started',20000,'created')`, [NON]);

    const appId = {};
    for (const [k, u] of [['S1', S1], ['S2', S2], ['S3', S3]]) appId[k] = (await q(`select id from public.volunteer_applications where user_id=$1`, [u])).rows[0].id;

    // ---- everyone who is not an admin is refused, on every admin call
    await asAnon();
    await expectErr('anon cannot list applications', () => q(`select * from public.admin_list_applications('pending')`), /permission denied|admins_only/);
    await as(NON);
    ok('non-admin: is_admin is false', (await q('select public.is_admin() a')).rows[0].a === false);
    await expectErr('non-admin cannot list applications', () => q(`select * from public.admin_list_applications('pending')`), /admins_only/);
    await expectErr('non-admin cannot list volunteers', () => q(`select * from public.admin_list_volunteers()`), /admins_only/);
    await expectErr('non-admin cannot list contributions', () => q(`select * from public.admin_list_contributions(10,0)`), /admins_only/);
    await expectErr('non-admin cannot approve', () => q(`select public.admin_review_application($1, 'approve')`, [appId.S1]), /admins_only/);
    await expectErr('non-admin cannot remove a volunteer', () => q(`select public.admin_remove_volunteer($1)`, [S1]), /admins_only/);
    await expectErr('non-admin cannot read the admins table', () => q(`select * from public.admins`), /permission denied/);

    // ---- job 1: approve / reject
    await as(ADM);
    ok('admin: is_admin is true', (await q('select public.is_admin() a')).rows[0].a === true);
    let pend = (await q(`select * from public.admin_list_applications('pending')`)).rows.filter(r => /^TEST/.test(r.name));
    ok('admin sees the 3 pending applications', pend.length === 3, 'got ' + pend.length);
    ok('pending list carries name, institute, branch, year, phone', pend[0].institute_id === 'iitb' && pend[0].branch === 'CSE' && pend[0].year === 3 && /^\+91/.test(pend[0].phone));
    await q(`select public.admin_review_application($1,'approve')`, [appId.S1]);
    await q(`select public.admin_review_application($1,'reject')`, [appId.S3]);
    await q('reset role');
    const p1 = (await q(`select is_volunteer from public.profiles where id=$1`, [S1])).rows[0];
    const pp1 = (await q(`select vol_phone from public.profile_private where id=$1`, [S1])).rows[0];
    ok('approved: becomes a volunteer and phone is stored for coordinators', p1.is_volunteer === true && pp1.vol_phone === '+919000000001');
    const p3 = (await q(`select is_volunteer from public.profiles where id=$1`, [S3])).rows[0];
    ok('rejected: is not a volunteer', p3.is_volunteer === false);
    ok('review records who decided and when', (await q(`select reviewed_by, reviewed_at from public.volunteer_applications where user_id=$1`, [S1])).rows[0].reviewed_by === ADM);
    await as(ADM);
    await expectErr('deciding twice is refused', () => q(`select public.admin_review_application($1,'approve')`, [appId.S1]), /not_pending/);
    pend = (await q(`select * from public.admin_list_applications('pending')`)).rows.filter(r => /^TEST/.test(r.name));
    ok('only one application is still waiting', pend.length === 1 && pend[0].name === 'TEST Two');
    ok('rejected tab lists the rejected one', (await q(`select * from public.admin_list_applications('rejected')`)).rows.some(r => r.name === 'TEST Three'));
    ok('approved tab lists the approved one', (await q(`select * from public.admin_list_applications('approved')`)).rows.some(r => r.name === 'TEST One'));
    await expectErr('a made-up decision is refused', () => q(`select public.admin_review_application($1,'maybe')`, [appId.S2]), /bad_decision/);

    // ---- job 2: view / remove volunteers
    await as(ADM);
    let vols = (await q(`select * from public.admin_list_volunteers()`)).rows.filter(r => /^TEST/.test(r.name));
    ok('admin sees the one volunteer', vols.length === 1 && vols[0].name === 'TEST One' && vols[0].phone === '+919000000001');
    await q(`select public.admin_remove_volunteer($1)`, [S1]);
    vols = (await q(`select * from public.admin_list_volunteers()`)).rows.filter(r => /^TEST/.test(r.name));
    ok('removed: gone from the volunteer list', vols.length === 0);
    await q('reset role');
    ok('removed: access and phone are taken away', (await q(`select p.is_volunteer, pp.vol_phone from public.profiles p join public.profile_private pp on pp.id=p.id where p.id=$1`, [S1])).rows[0].is_volunteer === false
      && (await q(`select vol_phone from public.profile_private where id=$1`, [S1])).rows[0].vol_phone === null);
    ok('removed: application is marked removed', (await q(`select status from public.volunteer_applications where user_id=$1`, [S1])).rows[0].status === 'removed');
    await as(ADM);
    await expectErr('removing a non-volunteer is refused', () => q(`select public.admin_remove_volunteer($1)`, [S1]), /not_a_volunteer/);

    // ---- job 3: view contributions
    const cs = (await q(`select * from public.admin_list_contributions(50,0)`)).rows.filter(r => /^TEST/.test(r.display_name));
    ok('admin sees both contributions', cs.length === 2);
    ok('amounts and status are right', cs.some(r => r.status === 'paid' && Number(r.amount_paise) === 50000) && cs.some(r => r.status === 'created' && Number(r.amount_paise) === 20000));
    ok('limit is respected', (await q(`select * from public.admin_list_contributions(1,0)`)).rows.length === 1);
    await expectErr('admin cannot write contributions directly', () => q(`insert into public.contributions (display_name, amount_paise) values ('x', 100)`), /permission denied|row-level/);
  } catch (e) {
    fail++; console.log('FAIL test run crashed: ' + e.message);
  } finally {
    await q('rollback');
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed (all test data rolled back)`);
  process.exit(fail ? 1 : 0);
})();
