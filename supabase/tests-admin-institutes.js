// Checks the admin's control of a member's extra institutes (list, add, change, verify, remove) against the real database
// inside ONE transaction that is rolled back: nothing is left behind, no email is sent.
//   cd supabase && node tests-admin-institutes.js ../.env
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
  const emails = {};
  let cur = null;
  const as = async (id) => { cur = id; await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated', email: emails[id] || '' })]); await q('set local role authenticated'); };
  const root = () => q('reset role');
  const rq = async (sql, p) => { const prev = cur; await root(); const r = await q(sql, p); if (prev) await as(prev); return r; };
  const err = async (fn) => { const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    const mk = async (email) => { await root(); const id = uid(); emails[id] = email; await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const prof = (kind, inst, year, extra = {}) => JSON.stringify(Object.assign({ kind, name: 'TEST ' + kind, institute_id: inst, branch: 'Design', year, helps: [0], email_personal: 'x@test.invalid' }, extra));
    const setCode = async (id, code) => { await rq(`update public.email_verifications set code_hash = public.hash_code($2) where user_id = $1 and not used`, [id, code]); };

    const addProfile = async (id, kind, name, inst, year = 2020) => {
      await root();
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method, campus) values ($1,$2,$3,$4,'Fashion Design',$5,true,true,'certificate','')`, [id, kind, name, inst, year]);
      await q(`insert into public.profile_private (id) values ($1)`, [id]);
    };
    const ADM = await mk('adm@test.invalid'), NOADM = await mk('noadm@test.invalid'), P = await mk('p@test.invalid'), VIEW = await mk('view@test.invalid');
    await root(); await q(`insert into public.admins (user_id, role) values ($1,'Owner')`, [ADM]);
    await addProfile(P, 'alum', 'TEST Priya', 'nift', 2018);
    await addProfile(VIEW, 'student', 'TEST Viewer', 'iitb', 2025);
    const set = async (link, o) => (await q(`select public.admin_set_member_institute($1,$2,$3::jsonb) id`, [P, link, JSON.stringify(o)])).rows[0].id;
    const list = async () => (await q(`select * from public.admin_member_institutes($1)`, [P])).rows;

    await as(NOADM);
    await expectErr('a non-admin cannot list a member\'s institutes', () => q(`select * from public.admin_member_institutes($1)`, [P]), /.+/);
    await expectErr('a non-admin cannot add one', () => q(`select public.admin_set_member_institute($1,null,'{"institute_id":"nid","kind":"student","branch":"X","year":2024}')`, [P]), /.+/);
    await as(ADM);
    ok('a member with none starts with an empty list', (await list()).length === 0);
    const L1 = await set(null, { institute_id: 'nid', kind: 'student', branch: 'Communication Design', year: 2027, campus: 'Ahmedabad' });
    let rows = await list();
    ok('the admin adds a Master\'s at NID; an admin-added one counts as checked', rows.length === 1 && rows[0].verified === true && rows[0].verify_method === 'admin' && rows[0].kind === 'student' && rows[0].short === 'NID', JSON.stringify(rows));
    // the directory shows it under NID
    await as(VIEW);
    let dir = (await q(`select * from public.directory_institutes()`)).rows;
    ok('the directory lists the person under the extra institute', dir.some(r => r.profile_id === P && r.institute_id === 'nid'), JSON.stringify(dir.slice(0, 3)));
    await as(ADM);
    await set(L1, { branch: 'Industrial Design', year: 2028 });
    rows = await list();
    ok('the admin changes the branch and year', rows[0].branch === 'Industrial Design' && rows[0].year === 2028 && rows[0].verified === true, JSON.stringify(rows));
    await set(L1, { verified: false });
    rows = await list();
    ok('the admin can mark it not verified (it leaves the directory)', rows[0].verified === false && rows[0].verify_method === null);
    await as(VIEW);
    dir = (await q(`select * from public.directory_institutes()`)).rows;
    ok('an unverified extra institute is not in the directory', !dir.some(r => r.profile_id === P && r.institute_id === 'nid'));
    await as(ADM);
    await set(L1, { verified: true });
    rows = await list();
    ok('and verified again', rows[0].verified === true && rows[0].verify_method === 'admin');
    await set(L1, { kind: 'alum' });
    ok('the status can be changed to alum', (await list())[0].kind === 'alum');
    await expectErr('the main institute cannot be added again', () => set(null, { institute_id: 'nift', kind: 'alum', branch: 'X', year: 2020 }), /already_added/);
    await expectErr('the same extra institute cannot be added twice', () => set(null, { institute_id: 'nid', kind: 'student', branch: 'X', year: 2020, campus: 'Ahmedabad' }), /already_added/);
    await expectErr('a wrong status is refused', () => set(null, { institute_id: 'iitd', kind: 'faculty', branch: 'X', year: 2020 }), /bad_kind/);
    await expectErr('an unknown institute is refused', () => set(null, { institute_id: 'nope', kind: 'alum', branch: 'X', year: 2020 }), /bad_institute/);
    await expectErr('a blank branch is refused', () => set(null, { institute_id: 'iitd', kind: 'alum', branch: ' ', year: 2020 }), /bad_branch/);
    await expectErr('an absurd year is refused', () => set(null, { institute_id: 'iitd', kind: 'alum', branch: 'X', year: 1800 }), /bad_year/);
    await expectErr('a campus that does not belong is refused', () => set(null, { institute_id: 'nid', kind: 'alum', branch: 'X', year: 2020, campus: 'Narnia' }), /bad_campus/);
    await expectErr('a link that is not this member\'s is refused', () => set('00000000-0000-0000-0000-000000000000', { branch: 'X' }), /not_found/);
    for (const i of ['iitd', 'iitg', 'iith', 'iiti']) await set(null, { institute_id: i, kind: 'alum', branch: 'B.Des', year: 2020 });
    await expectErr('more than five extra institutes are refused', () => set(null, { institute_id: 'iitk', kind: 'alum', branch: 'B.Des', year: 2020 }), /too_many_institutes/);
    await q(`select public.admin_remove_member_institute($1)`, [L1]);
    ok('the admin removes one', (await list()).length === 4);
    await expectErr('removing it again says it is gone', () => q(`select public.admin_remove_member_institute($1)`, [L1]), /not_found/);
    const log = await rq(`select count(*) n from public.admin_log where act in ('Added an institute to a member','Changed a member''s institute','Removed an institute from a member')`);
    ok('every change is in the activity log', +log.rows[0].n >= 9, JSON.stringify(log.rows[0]));
    // last active moves quietly, at most every ten minutes
    await root(); await q(`update public.profiles set last_seen = null where id = $1`, [P]);
    await as(P); await q(`select public.touch_last_seen()`);
    await root();
    const ls1 = (await q(`select last_seen from public.profiles where id = $1`, [P])).rows[0].last_seen;
    ok('a member coming back sets Last active', ls1 !== null);
    await q(`update public.profiles set last_seen = now() - interval '2 minutes' where id = $1`, [P]);
    await as(P); await q(`select public.touch_last_seen()`); await root();
    const ls2 = (await q(`select (now() - last_seen) > interval '1 minute' as old from public.profiles where id = $1`, [P])).rows[0].old;
    ok('and it does not move again within ten minutes', ls2 === true);
    const nlog = await rq(`select count(*) n from public.admin_log where who_id = $1 and act = 'Signed in with Google'`, [P]);
    ok('and it writes no log line', +nlog.rows[0].n === 0);
  } finally {
    await q('rollback');
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
