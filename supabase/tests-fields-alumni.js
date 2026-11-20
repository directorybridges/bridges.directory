// Checks fields, alumni email codes and admin-managed email domains against the real database
// inside ONE transaction that is rolled back: nothing is left behind, no email is sent.
//   cd supabase && node tests-fields-alumni.js ../.env
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

    // ---------------------------------------------------------------- fields
    const S1 = await mk('s1@test.invalid'), S2 = await mk('s2@test.invalid'), S3 = await mk('s3@test.invalid'), AL = await mk('al@test.invalid');
    await as(S1);
    await q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'nid', 2025, { fields: [0, 7] })]);
    let r = await rq(`select fields from public.profiles where id = $1`, [S1]);
    ok('a student is saved with the fields they picked', JSON.stringify(r.rows[0].fields) === '[0,7]', JSON.stringify(r.rows[0]));
    await as(S2);
    await expectErr('four fields are refused', () => q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'nid', 2025, { fields: [0, 1, 2, 3] })]), /bad_fields/);
    await expectErr('a field that does not exist is refused', () => q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'nid', 2025, { fields: [9] })]), /bad_fields/);
    await q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'nift', 2025, { fields: [1, 1, 8] })]);
    r = await rq(`select fields from public.profiles where id = $1`, [S2]);
    ok('a repeated field is saved once', JSON.stringify(r.rows[0].fields) === '[1,8]', JSON.stringify(r.rows[0]));
    await as(AL);
    await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', 'nift', 2026, { fields: [1, 2], experiences: [{ role: 'Designer', org: 'X', f: 1 }] })]);
    r = await rq(`select fields from public.profiles where id = $1`, [AL]);
    ok('an alum keeps no fields of their own (theirs come from their experience)', r.rows[0].fields.length === 0, JSON.stringify(r.rows[0]));
    await as(S1);
    await q(`update public.profiles set fields = '{2,3,4}' where id = $1`, [S1]);
    r = await rq(`select fields from public.profiles where id = $1`, [S1]);
    ok('a member can change their fields', JSON.stringify(r.rows[0].fields) === '[2,3,4]');
    await expectErr('a member cannot save more than 3 fields', () => q(`update public.profiles set fields = '{0,1,2,3}' where id = $1`, [S1]), /profiles_fields_ok/);

    // ---------------------------------------------------------------- alumni email
    await expectErr('a student cannot ask for an alumni code', () => q(`select public.request_alumni_code('a@alumni.nift.ac.in')`), /alums_only/);
    await as(AL);                                                         // NIFT alum, batch 2026
    await expectErr('an address that is not an alumni address is refused', () => q(`select public.request_alumni_code('me@gmail.com')`), /alumni_domain_mismatch/);
    await expectErr('a student address is not an alumni address', () => q(`select public.request_alumni_code('me@nift.ac.in')`), /alumni_domain_mismatch/);
    await expectErr('another institute\'s alumni address is refused', () => q(`select public.request_alumni_code('me@alumni.iitb.ac.in')`), /alumni_domain_mismatch/);
    await expectErr('a malformed address is refused', () => q(`select public.request_alumni_code('not an email')`), /bad_email/);
    await q(`select public.request_alumni_code('Me@Alumni.NIFT.ac.in')`);
    r = await rq(`select purpose, email from public.email_verifications where user_id = $1`, [AL]);
    ok('the code is stored for the alumni address, lower-cased', r.rows.length === 1 && r.rows[0].purpose === 'alumni' && r.rows[0].email === 'me@alumni.nift.ac.in', JSON.stringify(r.rows));
    await setCode(AL, '123456');
    r = await q(`select public.confirm_email_code('000000') ok`);
    ok('a wrong code does not verify', r.rows[0].ok === false);
    r = await q(`select public.confirm_email_code('123456') ok`);
    ok('the right code verifies the alum', r.rows[0].ok === true);
    r = await rq(`select p.verified, p.listed, p.verify_method, pp.email_alumni from public.profiles p join public.profile_private pp on pp.id = p.id where p.id = $1`, [AL]);
    ok('the alum is listed as verified by alumni email, address kept private', r.rows[0].verified && r.rows[0].listed && r.rows[0].verify_method === 'alumni_email' && r.rows[0].email_alumni === 'me@alumni.nift.ac.in', JSON.stringify(r.rows[0]));
    await expectErr('a verified alum cannot ask again', () => q(`select public.request_alumni_code('me@alumni.nift.ac.in')`), /already_verified/);

    const OLD = await mk('old@test.invalid'), IB1 = await mk('ib1@test.invalid'), NID1 = await mk('nid1@test.invalid');
    await as(OLD); await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', 'nift', 2025)]);
    await expectErr('NIFT alumni emails start with the batch of 2026', () => q(`select public.request_alumni_code('old@alumni.nift.ac.in')`), /alumni_batch_too_early/);
    await as(IB1); await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', 'iitb', 2010)]);
    await q(`select public.request_alumni_code('x@alumni.iitb.ac.in')`);
    ok('an IIT alum of any batch can ask (no first batch set)', true);
    await as(NID1); await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', 'nid', 2020)]);
    await expectErr('an institute with no alumni domain gets a clear refusal', () => q(`select public.request_alumni_code('x@alumni.nid.edu')`), /alumni_domain_mismatch/);
    const DUP = await mk('dup@test.invalid');
    await as(DUP); await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', 'nift', 2026)]);
    await expectErr('an alumni address already on another profile is refused', () => q(`select public.request_alumni_code('me@alumni.nift.ac.in')`), /alumni_email_taken/);

    // ---------------------------------------------------------------- the code for a student still works, and student codes can be switched off
    const ST = await mk('st@test.invalid');
    await as(ST); await q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'iitd', 2025)]);
    await expectErr('an alumni address cannot get a student code', () => q(`select public.request_email_code('x@alumni.iitd.ac.in')`), /email_domain_mismatch/);
    await q(`select public.request_email_code('x@iitd.ac.in')`);
    ok('a student address still gets a student code', true);

    // ---------------------------------------------------------------- admin: domains
    const ADM = await mk('adm@test.invalid'), NOADM = await mk('noadm@test.invalid');
    await root(); await q(`insert into public.admins (user_id, role) values ($1,'Owner')`, [ADM]);
    await as(NOADM);
    await expectErr('a non-admin cannot see the domain lists', () => q(`select public.admin_domains()`), /.+/);
    await expectErr('a non-admin cannot add a domain', () => q(`select public.admin_add_domain('student','nid',null,'extra.nid.test.ac.in')`), /.+/);
    await as(ADM);
    r = await q(`select public.admin_domains() j`);
    ok('the admin sees the seeded alumni domains', r.rows[0].j.alumni.some(x => x.d === 'alumni.iitb.ac.in') && r.rows[0].j.alumni.find(x => x.d === 'alumni.nift.ac.in').from === 2026, JSON.stringify(r.rows[0].j.alumni.slice(0, 2)));
    r = await q(`select public.admin_add_domain('student','nid',null,'@Students.NID-Test.ac.in') j`);
    ok('the admin adds a student domain to an existing institute', r.rows[0].j.institute_id === 'nid');
    await expectErr('the same domain twice is refused', () => q(`select public.admin_add_domain('student','nid',null,'students.nid-test.ac.in')`), /domain_exists/);
    await expectErr('a domain already used for alumni cannot also be a student domain', () => q(`select public.admin_add_domain('student','nift',null,'alumni.nift.ac.in')`), /domain_exists/);
    await expectErr('a personal email provider is refused', () => q(`select public.admin_add_domain('student','nid',null,'gmail.com')`), /personal_domain/);
    await expectErr('a nonsense domain is refused', () => q(`select public.admin_add_domain('student','nid',null,'not a domain')`), /bad_domain/);
    await expectErr('an unknown institute is refused', () => q(`select public.admin_add_domain('student','zzz',null,'ok.example.ac.in')`), /bad_institute/);
    await expectErr('a new institute needs a name', () => q(`select public.admin_add_domain('student','new','','new1.example.ac.in')`), /bad_name/);
    await expectErr('an institute that already exists cannot be added as new', () => q(`select public.admin_add_domain('student','new','NIFT','new2.example.ac.in')`), /institute_exists/);
    await expectErr('an absurd first batch is refused', () => q(`select public.admin_add_domain('alumni','iitr',null,'alumni.iitr-test.ac.in',1800)`), /bad_batch/);
    // a student at NID can now verify with the added domain
    await root();
    await q(`update public.profiles set verified=false, listed=false, verify_method=null where id = $1`, [NID1]);
    await as(NID1);
    await expectErr('(an alum cannot use the student code)', () => q(`select public.request_email_code('a@students.nid-test.ac.in')`), /students_only/);
    const NS = await mk('ns@test.invalid');
    await as(NS); await q(`select public.create_my_profile($1::jsonb)`, [prof('student', 'nid', 2025)]);
    await q(`select public.request_email_code('a@students.nid-test.ac.in')`);
    ok('a student can verify with a domain the admin added', true);
    r = await rq(`select public.extra_domains() j`);
    ok('the site can read the added student domain', r.rows[0].j.student.some(x => x.d === 'students.nid-test.ac.in' && x.inst === 'nid'), JSON.stringify(r.rows[0].j.student));
    // switch off
    await as(ADM);
    const dom = (await q(`select (j->'student'->0->>'id')::uuid id from (select public.admin_domains() j) t`)).rows[0].id;
    await q(`select public.admin_set_domain($1, false)`, [dom]);
    await as(NS);
    await expectErr('a switched-off student domain stops working', () => q(`select public.request_email_code('b@students.nid-test.ac.in')`), /email_domain_mismatch/);
    await as(ADM);
    await q(`select public.admin_remove_domain($1)`, [dom]);
    r = await q(`select public.admin_domains() j`);
    ok('a removed domain is gone', !r.rows[0].j.student.some(x => x.d === 'students.nid-test.ac.in'));
    // new institute through an alumni domain
    r = await q(`select public.admin_add_domain('alumni','new','Test Design School','alumni.tds-test.ac.in',2024) j`);
    const nid_ = r.rows[0].j.institute_id;
    r = await rq(`select grp, short, branches, email_domain from public.institutes where id = $1`, [nid_]);
    ok('a new institute is created on the spot, in its own group', r.rows[0] && r.rows[0].grp === 'other' && r.rows[0].short === 'Test Design School' && r.rows[0].branches[0] === 'Design', JSON.stringify(r.rows[0]));
    const NA = await mk('na@test.invalid');
    await as(NA); await q(`select public.create_my_profile($1::jsonb)`, [prof('alum', nid_, 2023)]);
    await expectErr('the new institute\'s first batch is respected', () => q(`select public.request_alumni_code('x@alumni.tds-test.ac.in')`), /alumni_batch_too_early/);
    await as(ADM);
    r = await q(`select public.admin_domains() j`);
    ok('the admin list marks the new institute', r.rows[0].j.alumni.some(x => x.d === 'alumni.tds-test.ac.in' && x.new === true));
    const log = await rq(`select count(*) n from public.admin_log where act in ('Added institute email domain','Added alumni email domain','Removed a domain','Switched a domain off')`);
    ok('every change is written to the activity log', +log.rows[0].n >= 4, JSON.stringify(log.rows[0]));
  } finally {
    await q('rollback');
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
