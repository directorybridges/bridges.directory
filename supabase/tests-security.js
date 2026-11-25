// Checks the security hardening (migration 0014): avatar shape, size caps, daily limits, against the real database
// inside ONE transaction that is rolled back, so no setting, member or log line is left behind.
//   cd supabase && node tests-security.js ../.env
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
  let sp = 0, inErr = false;
  const q = (sql, p) => c.query(sql, p).catch(e => { if (!global.firstErr && !/aborted/.test(e.message) && !inErr) global.firstErr = e.message + ' | ' + sql.slice(0, 200); throw e; });
  const emails = {};
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated', email: emails[id] || '' })]); await q('set local role authenticated'); };
  const root = () => q('reset role');
  const err = async (fn) => { inErr = true; const n = 's' + (++sp); await q('savepoint ' + n); try { await fn(); await q('release savepoint ' + n); return null; } catch (e) { await q('rollback to savepoint ' + n); return e.message; } finally { inErr = false; } };
  const expectErr = async (name, fn, re) => { const m = await err(fn); ok(name, m && re.test(m), 'got: ' + m); };
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  await q('begin');
  try {
    // the migration is applied inside this rolled-back transaction first, so the test also works before it is live (and again after)
    await q(fs.readFileSync(path.join(__dirname, '0014_security_hardening.sql'), 'utf8'));
    const mk = async (email) => { await root(); const id = uid(); emails[id] = email; await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, name) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method, campus)
               values ($1,$2,$3,'iitb','CSE',3,true,true,'certificate','')`, [id, kind, name]);
      await q(`insert into public.profile_private (id, email_personal) values ($1,$2)`, [id, name.replace(/\W+/g, '').toLowerCase() + '@test.invalid']);
    };
    const ME = await mk('me@test.invalid'), OTHER = await mk('other@test.invalid');
    const T = []; for (let i = 0; i < 12; i++) T.push(await mk('t' + i + '@test.invalid'));
    await root(); await addProfile(ME, 'student', 'TEST Me'); await addProfile(OTHER, 'alum', 'TEST Other');
    for (let i = 0; i < T.length; i++) await addProfile(T[i], 'student', 'TEST Target ' + i);

    // ---------------------------------------------------------------- 1. avatar shape (what the avatar maker and older versions produce is accepted)
    await as(ME);
    const setAv = (a) => q(`update public.profiles set avatar = $1::jsonb where id = $2`, [JSON.stringify(a), ME]);
    const goodAv = [
      ['the default avatar', {}],
      ['a current avatar', { p: 'f', f: 3, h: 'H14', g: 2, j: [2], b: 0, s: 4, bg: 6 }],
      ['an avatar with two jewellery items', { p: 'm', f: 5, h: 'H02', g: 0, j: [1, 4], b: 3, s: 15, bg: 14 }],
      ['an older avatar (round 3 format)', { g: 'm', x: 2, f: 1, h: 'bob', e: 1, s: 7, b: 9 }],
    ];
    for (const [n, a] of goodAv) { const m = await err(() => setAv(a)); ok('accepted: ' + n, m === null, m); }
    const badAv = [
      ['a negative background (used to crash the avatar drawing)', { bg: -3 }],
      ['a negative t-shirt', { s: -5 }],
      ['a huge number', { f: 1e9 }],
      ['an unknown preset', { p: 'zzz', h: 'x' }],
      ['a preset that is not text', { p: 5 }],
      ['text where a number belongs', { s: '4' }],
      ['a script in a field', { h: '<script>alert(1)</script>' }],
      ['an unknown key', { evil: 1 }],
      ['too many jewellery items', { j: [1, 2, 3, 4, 5] }],
      ['jewellery that is not a number', { j: ['a'] }],
      ['an avatar that is not an object', [1, 2, 3]],
      ['an avatar over 400 characters', { h: 'H01', p: 'a', f: 1, g: 1, j: [1], b: 1, s: 1, bg: 1, e: 1, x: 1, pad: 'y'.repeat(400) }],
    ];
    for (const [n, a] of badAv) await expectErr('refused: ' + n, () => setAv(a), /violates check constraint|profiles_avatar_ok/);
    await expectErr('refused when a profile is created through the sign-up call too', () => q(`select public.create_my_profile($1::jsonb)`, [JSON.stringify({ kind: 'student', name: 'TEST Bad', institute_id: 'iitb', branch: 'CSE', year: 2027, avatar: { bg: -1 } })]), /violates check constraint|profiles_avatar_ok|profile_exists/);

    // ---------------------------------------------------------------- 2. size caps
    const exps = n => Array.from({ length: n }, (_, i) => ({ t: 'job', role: 'Designer ' + i, org: 'Studio', from: 2020, to: 2021, f: 0, fo: '' }));
    const setExp = (e) => q(`update public.profiles set experiences = $1::jsonb where id = $2`, [JSON.stringify(e), ME]);
    ok('12 experiences are fine', (await err(() => setExp(exps(12)))) === null);
    await expectErr('13 experiences are refused', () => setExp(exps(13)), /violates check constraint|profiles_experiences_size/);
    await expectErr('experiences over 20,000 characters are refused', () => setExp([{ t: 'job', role: 'x'.repeat(21000), org: 'y' }]), /violates check constraint|profiles_experiences_size/);
    await expectErr('13 "happy to help with" choices are refused', () => q(`update public.profiles set helps = $1::int[] where id = $2`, [Array.from({ length: 13 }, (_, i) => i % 7), ME]), /violates check constraint|profiles_helps_size/);
    ok('4 links are fine', (await err(() => q(`update public.profile_private set links = $1::jsonb where id = $2`, [JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ t: 'portfolio', url: 'https://example.com/' + i, name: 'n' }))), ME]))) === null);
    await expectErr('7 links are refused', () => q(`update public.profile_private set links = $1::jsonb where id = $2`, [JSON.stringify(Array.from({ length: 7 }, () => ({ t: 'portfolio', url: 'https://e.com', name: '' }))), ME]), /violates check constraint|pp_links_size/);
    await expectErr('links over 8,000 characters are refused', () => q(`update public.profile_private set links = $1::jsonb where id = $2`, [JSON.stringify([{ t: 'portfolio', url: 'https://e.com/' + 'a'.repeat(9000), name: '' }]), ME]), /violates check constraint|pp_links_size/);
    await expectErr('an email over 254 characters is refused', () => q(`update public.profile_private set email_personal = $1 where id = $2`, ['a'.repeat(250) + '@x.com', ME]), /violates check constraint|pp_email_len/);
    await expectErr('a campus name over 80 characters is refused', () => q(`update public.profiles set campus = $1 where id = $2`, ['c'.repeat(81), ME]), /violates check constraint|profiles_campus_len/);
    ok('normal edits still work (name, branch, helps, email)', (await err(async () => {
      await q(`update public.profiles set name = 'TEST Me', branch = 'Design', helps = '{0,1,4}' where id = $1`, [ME]);
      await q(`update public.profile_private set email_personal = 'me.new@test.invalid' where id = $1`, [ME]);
    })) === null);
    await root();
    await expectErr('a phone over 20 characters is refused', () => q(`insert into public.volunteer_applications (user_id, phone, consent) values ($1, $2, true)`, [ME, '9'.repeat(21)]), /violates check constraint|va_phone_len/);
    await expectErr('an email-code address over 254 characters is refused', () => q(`insert into public.email_verifications (user_id, email, code_hash) values ($1, $2, 'x')`, [ME, 'a'.repeat(250) + '@x.com']), /violates check constraint|ev_email_len/);

    // ---------------------------------------------------------------- 3. limits
    await as(ME);
    for (let i = 0; i < 10; i++) ok('report ' + (i + 1) + ' of 10 today is accepted', (await err(() => q(`select public.send_report($1, 'spam', 'test')`, [T[i]]))) === null);
    await expectErr('the 11th report in a day is refused', () => q(`select public.send_report($1, 'spam', 'test')`, [T[10]]), /too_many_requests/);
    await as(OTHER);
    ok('another member can still report (the limit is per member)', (await err(() => q(`select public.send_report($1, 'spam', 'test')`, [T[0]]))) === null);

    await as(ME);
    for (let i = 0; i < 20; i++) { const m = await err(() => q(`select public.create_invite($1)`, ['friend' + i + '@test.invalid'])); if (m) { ok('invite ' + (i + 1) + ' of 20 is accepted', false, m); break; } if (i === 19) ok('20 invites a day are accepted', true); }
    await expectErr('the 21st invite in a day is refused', () => q(`select public.create_invite('late@test.invalid')`), /too_many_requests/);

    for (let i = 0; i < 10; i++) { const m = await err(() => q(`select public.start_contribution(50000, false, $1)`, ['TEST Donor ' + i])); if (m) { ok('contribution start ' + (i + 1) + ' of 10 an hour is accepted', false, m); break; } if (i === 9) ok('10 contribution starts an hour are accepted', true); }
    await expectErr('the 11th contribution start in an hour is refused', () => q(`select public.start_contribution(50000, false, 'TEST Donor late')`), /too_many_requests/);
    await root();
    await q(`delete from public.contributions where user_id = $1`, [ME]);
    await as(ME);
    const cid = (await one(`select public.start_contribution(50000, false, $1) id`, ['n'.repeat(200)])).id;
    await root();
    ok('a long display name is cut to 80 characters instead of being stored whole', (await one(`select char_length(display_name) n from public.contributions where id = $1`, [cid])).n === 80);
  } catch (e) {
    fail++; console.log('FIRST ERROR: ' + global.firstErr); console.log('FAIL (crashed) ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  } finally {
    await c.query('rollback');
    const left = (await c.query(`select (select count(*) from auth.users where email like '%@test.invalid') u, (select count(*) from public.profiles where name like 'TEST%') p`)).rows[0];
    console.log(`\nrolled back. left behind: users=${left.u} profiles=${left.p}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
