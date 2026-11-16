// Member-site checks for supabase/0002_member_site.sql (volunteer_queue_details), inside ONE
// transaction that is rolled back, so nothing is left behind.
//   cd supabase && npm i pg && node tests-member.js ../.env
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
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set local role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{}', true)`); await q('set local role anon'); };
  const err = async (fn) => { const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };

  await q('begin');
  try {
    await q(`select set_config('app.skip_email', 'on', true)`);
    const mk = async (email) => { const id = uid(); await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, inst, o = {}) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, campus, branch, year, verified, listed, verify_method, is_volunteer)
               values ($1,$2,$3,$4,'Delhi','Fashion Design',2028,$5,$5,$6,$7)`, [id, kind, o.name || 'TEST ' + id.slice(0, 4), inst, !!o.verified, o.verified ? 'certificate' : null, !!o.vol]);
      await q(`insert into public.profile_private (id, email_personal) values ($1,$2)`, [id, `t${id.slice(0, 6)}@example.com`]);
    };
    const V1 = await mk('mv1@test.invalid'), V2 = await mk('mv2@test.invalid'), APP = await mk('mapp@test.invalid'), NV = await mk('mnv@test.invalid');
    for (const v of [V1, V2]) await addProfile(v, 'student', 'nift', { verified: true, vol: true });
    await addProfile(NV, 'student', 'nift', { verified: true });
    await addProfile(APP, 'alum', 'iitb', { name: 'TEST Applicant' });
    await as(APP);
    const rid = (await q(`select public.submit_certificate('image/png', $1) id`, [PNG])).rows[0].id;
    // V1 has a pending request of their own (inserted directly) (own request must be hidden from V1)
    await q('reset role');

    // ---- directory version (the site re-downloads the directory only when this changes)
    await asAnon();
    await expectErr('directory version: anon refused', () => q(`select public.directory_version()`), /permission denied/);
    await as(NV);
    const v1 = (await q(`select public.directory_version() v`)).rows[0].v;
    ok('directory version: counts the visible members', v1.n >= 3 && !!v1.at, JSON.stringify(v1));
    await q('reset role');
    await q(`update public.profiles set last_seen = now() + interval '1 minute' where id = $1`, [V1]);
    await as(NV);
    const v2 = (await q(`select public.directory_version() v`)).rows[0].v;
    ok('directory version: unchanged when only last seen moves', v2.n === v1.n && v2.at === v1.at, JSON.stringify([v1, v2]));
    await q('reset role');
    await q(`update public.profiles set branch = 'Textile Design' where id = $1`, [V1]);
    await as(NV);
    const v3 = (await q(`select public.directory_version() v`)).rows[0].v;
    ok('directory version: changes when a visible profile is edited', v3.at !== v2.at && v3.n === v2.n, JSON.stringify([v2, v3]));
    await q('reset role');
    await q(`update public.profiles set listed = false where id = $1`, [V2]);
    await as(NV);
    const v4 = (await q(`select public.directory_version() v`)).rows[0].v;
    ok('directory version: the count drops when someone is hidden', v4.n === v3.n - 1, JSON.stringify([v3, v4]));
    await q('reset role');
    ok('directory name index exists', (await q(`select 1 from pg_indexes where indexname = 'profiles_dir_name_idx'`)).rowCount === 1);
    const own = uid();
    await q(`insert into public.verification_requests (id, applicant_id, delete_after) values ($1,$2, now()+interval '30 days')`, [own, V1]);
    await as(V1);

    await asAnon();
    await expectErr('anon cannot call volunteer_queue_details', () => q('select * from public.volunteer_queue_details()'), /permission denied/);
    await as(NV);
    await expectErr('non-volunteer is refused', () => q('select * from public.volunteer_queue_details()'), /volunteers_only/);

    await as(V1);
    let rows = (await q('select * from public.volunteer_queue_details()')).rows;
    ok('volunteer sees the applicant request', rows.some(r => r.request_id === rid));
    ok('volunteer does not see their own request', !rows.some(r => r.request_id === own));
    const row = rows.find(r => r.request_id === rid) || {};
    ok('row has name, institute, branch, year, kind', row.name === 'TEST Applicant' && row.institute_id === 'iitb' && row.branch === 'Fashion Design' && row.year === 2028 && row.kind === 'alum');
    ok('row carries no email or contact column', !Object.keys(row).some(k => /email|phone|link|avatar|reviewer/i.test(k)));
    ok('approvals starts at 0', row.approvals === 0);

    await q(`select public.review_certificate($1,'approve')`, [rid]);
    rows = (await q('select * from public.volunteer_queue_details()')).rows;
    ok('reviewed request disappears for the reviewer', !rows.some(r => r.request_id === rid));

    await as(V2);
    rows = (await q('select * from public.volunteer_queue_details()')).rows;
    ok('second volunteer still sees it, with 1 approval', (rows.find(r => r.request_id === rid) || {}).approvals === 1);
    await q(`select public.review_certificate($1,'approve')`, [rid]);
    rows = (await q('select * from public.volunteer_queue_details()')).rows;
    ok('approved request leaves the queue', !rows.some(r => r.request_id === rid));
  } catch (e) {
    fail++; console.log('FAIL (crashed) ' + e.message);
  } finally {
    await q('reset role').catch(() => {});
    await q('rollback');
    const left = (await q(`select (select count(*) from auth.users where email like 'm%@test.invalid')::int u`)).rows[0];
    console.log(`\nrolled back. test users left behind: ${left.u}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
