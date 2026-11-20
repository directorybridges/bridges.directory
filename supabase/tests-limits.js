// Checks the adjustable contact limit (site count + day/week, per role, per person) against the real database
// inside ONE transaction that is rolled back, so no setting, member or log line is left behind.
//   cd supabase && node tests-limits.js ../.env
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
    // the live settings can have been changed by the client: start every check from the documented defaults (rolled back at the end)
    await q(`update public.settings set value = 'week' where key = 'contact_period'`); await q(`update public.settings set value = '5' where key = 'weekly_contacts'`); await q(`update public.settings set value = '' where key like 'contact_limit_%'`);
  try {
    const mk = async (email) => { await root(); const id = uid(); emails[id] = email; await q(`insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`, [id, email]); return id; };
    const addProfile = async (id, kind, name, extra = {}) => {
      await q(`insert into public.profiles (id, kind, name, institute_id, branch, year, verified, listed, verify_method, campus, is_volunteer)
               values ($1,$2,$3,'iitb','CSE',3,true,$4,'certificate','',$5)`, [id, kind, name, kind !== 'faculty', !!extra.vol]);
      await q(`insert into public.profile_private (id, email_personal) values ($1,$2)`, [id, name.replace(/\W+/g, '').toLowerCase() + '@test.invalid']);
    };
    const OWN = await mk('own@test.invalid'), STU = await mk('stu@test.invalid'), VOL = await mk('vol@test.invalid'),
          ALM = await mk('alm@test.invalid'), FAC = await mk('fac@test.invalid');
    const T = []; for (let i = 0; i < 14; i++) T.push(await mk('t' + i + '@test.invalid'));
    await root();
    await q(`insert into public.admins (user_id, role) values ($1,'Owner')`, [OWN]);
    await addProfile(STU, 'student', 'TEST Student'); await addProfile(VOL, 'student', 'TEST Volunteer', { vol: true });
    await addProfile(ALM, 'alum', 'TEST Alum'); await addProfile(FAC, 'faculty', 'TEST Faculty');
    for (let i = 0; i < T.length; i++) await addProfile(T[i], i % 2 ? 'alum' : 'student', 'TEST Target ' + i);
    const lim = async (id) => { await root(); return (await one(`select public.contact_limit_for($1) n`, [id])).n; };

    // ---------------------------------------------------------------- defaults
    await root();
    const st = await one(`select public.cfg('weekly_contacts') n, public.cfg('contact_period') p`);
    ok('the site starts at a count per week', st.p === 'week' && +st.n >= 1, JSON.stringify(st));
    await q(`update public.settings set value='5' where key='weekly_contacts'`); // known start inside this rolled-back test
    ok('everyone starts on the site limit', (await lim(STU)) === 5 && (await lim(VOL)) === 5 && (await lim(ALM)) === 5 && (await lim(FAC)) === 5);

    // ---------------------------------------------------------------- the admin settings screen's calls
    await as(STU);
    await expectErr('a member cannot read the admin settings', () => q(`select public.admin_get_settings()`), /no_permission|admins_only|not_admin/);
    await expectErr('a member cannot change the settings', () => q(`select public.admin_save_settings('{"limit":50}'::jsonb)`), /no_permission|admins_only|not_admin/);
    await as(OWN);
    const g0 = (await one(`select public.admin_get_settings() s`)).s;
    ok('settings carry the period and the role limits', g0.period === 'week' && g0.limit === 5 && g0.role_limits && 'volunteer' in g0.role_limits && g0.role_limits.volunteer === null, JSON.stringify(g0));
    await expectErr('a site limit of 0 is refused', () => q(`select public.admin_save_settings('{"limit":0}'::jsonb)`), /bad_limit/);
    await expectErr('a site limit above 500 is refused', () => q(`select public.admin_save_settings('{"limit":501}'::jsonb)`), /bad_limit/);
    await expectErr('a period other than day or week is refused', () => q(`select public.admin_save_settings('{"period":"month"}'::jsonb)`), /bad_period/);
    await expectErr('an unknown role is refused', () => q(`select public.admin_save_settings('{"role_limits":{"boss":3}}'::jsonb)`), /bad_limit/);
    await expectErr('a part-number role limit is refused', () => q(`select public.admin_save_settings('{"role_limits":{"alum":3.5}}'::jsonb)`), /bad_limit/);
    await expectErr('a role limit above 500 is refused', () => q(`select public.admin_save_settings('{"role_limits":{"alum":501}}'::jsonb)`), /bad_limit/);
    await q(`select public.admin_save_settings('{"limit":7,"period":"day","role_limits":{"volunteer":12,"faculty":3}}'::jsonb)`);
    const g1 = (await one(`select public.admin_get_settings() s`)).s;
    ok('saved: 7 a day, volunteers 12, faculty 3, others on the default', g1.limit === 7 && g1.period === 'day' && g1.role_limits.volunteer === 12 && g1.role_limits.faculty === 3 && g1.role_limits.student === null && g1.role_limits.alum === null, JSON.stringify(g1));
    await root();
    const lg = await one(`select detail from public.admin_log where act='Changed settings' order by id desc limit 1`);
    ok('the change is written to the activity log', /Contact limit/.test(lg.detail) && /Contact limit period/.test(lg.detail) && /by role/.test(lg.detail), JSON.stringify(lg));
    await as(OWN);
    await q(`select public.admin_save_settings('{"role_limits":{"faculty":null}}'::jsonb)`);
    ok('a role limit can go back to the default', (await one(`select public.admin_get_settings() s`)).s.role_limits.faculty === null);
    await q(`select public.admin_save_settings('{"role_limits":{"faculty":3}}'::jsonb)`);
    const ov = (await one(`select public.admin_overview() o`)).o;
    ok('the overview shows the period and role limits', ov.period === 'day' && ov.limit === 7 && ov.role_limits.volunteer === 12, JSON.stringify([ov.period, ov.limit, ov.role_limits]));

    // ---------------------------------------------------------------- who gets which number
    ok('student: site limit', (await lim(STU)) === 7);
    ok('alum: site limit', (await lim(ALM)) === 7);
    ok('volunteer: the volunteer number', (await lim(VOL)) === 12);
    ok('faculty: the faculty number', (await lim(FAC)) === 3);
    await as(OWN);
    await q(`select public.admin_update_member($1, '{"contact_limit":250}'::jsonb)`, [VOL]);
    ok('a personal number beats the role number, and any number to 500 is allowed', (await lim(VOL)) === 250);
    await as(OWN);
    await expectErr('a personal number above 500 is refused', () => q(`select public.admin_update_member($1, '{"contact_limit":501}'::jsonb)`, [VOL]), /bad_limit/);
    await expectErr('a negative personal number is refused', () => q(`select public.admin_update_member($1, '{"contact_limit":-1}'::jsonb)`, [VOL]), /bad_limit/);
    await q(`select public.admin_update_member($1, '{"contact_limit":null}'::jsonb)`, [VOL]);
    ok('clearing the personal number goes back to the role number', (await lim(VOL)) === 12);
    await q(`select public.admin_update_member($1, '{"contact_limit":7}'::jsonb)`, [ALM]);
    ok('an odd personal number such as 7 is accepted', (await lim(ALM)) === 7);
    await q(`select public.admin_update_member($1, '{"contact_limit":null}'::jsonb)`, [ALM]);
    await as(OWN);
    const ex2 = (await q(`select * from public.admin_export_members() where name = 'TEST Volunteer'`)).rows[0];
    ok('the export shows the number each member really has', ex2 && ex2.weekly_contacts === 12, JSON.stringify(ex2));

    // ---------------------------------------------------------------- the day window
    await as(STU);
    let m = (await one(`select public.my_contact_limit() m`)).m;
    ok('member counter: 7 a day, none used', m.limit === 7 && m.used === 0 && m.left === 7 && m.period === 'day', JSON.stringify(m));
    const rs = await (async () => { await root(); return one(`select (($1::timestamptz) at time zone 'Asia/Kolkata')::time t, ($1::timestamptz > now() and $1::timestamptz <= now() + interval '1 day') in_day`, [m.resets_at]); })();
    ok('a day resets at midnight India time, within 24 hours', String(rs.t).startsWith('00:00:00') && rs.in_day, JSON.stringify(rs));
    await root();
    await q(`update public.settings set value='' where key='contact_limit_student'`);
    await q(`update public.profiles set contact_limit = 2 where id = $1`, [STU]);
    await root();
    // an old reveal from before this week (so also before today) must not count today
    await q(`insert into public.contact_reveals (user_id, target_id, week_start, created_at) values ($1,$2,current_date, (date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') - interval '2 hours')`, [STU, T[0]]);
    await as(STU);
    ok('an older contact does not use up today\'s', (await one(`select public.contacts_left() n`)).n === 2);
    await q(`select public.reveal_contact($1)`, [T[1]]);
    await q(`select public.reveal_contact($1)`, [T[2]]);
    ok('two opened today leaves none', (await one(`select public.contacts_left() n`)).n === 0);
    await expectErr('the third in one day is refused', () => q(`select public.reveal_contact($1)`, [T[3]]), /limit_reached/);
    const same = (await one(`select public.reveal_contact($1) r`, [T[1]])).r;
    ok('opening one you already have again is free', same.name === 'TEST Target 1');
    m = (await one(`select public.my_contact_limit() m`)).m;
    ok('counter says 2 of 2 used', m.limit === 2 && m.used === 2 && m.left === 0, JSON.stringify(m));
    await root();
    const dl = await one(`select detail from public.admin_log where act='Opened a contact' and who_id=$1 order by id desc limit 1`, [STU]);
    ok('the log line says "today" for a day limit', /Contact 2 of 2 today/.test(dl.detail), JSON.stringify(dl));

    // ---------------------------------------------------------------- the week window
    await q(`update public.settings set value='week' where key='contact_period'`);
    await as(STU);
    m = (await one(`select public.my_contact_limit() m`)).m;
    const wr = await (async () => { await root(); return one(`select extract(dow from (($1::timestamptz) at time zone 'Asia/Kolkata'))::int d, (($1::timestamptz) at time zone 'Asia/Kolkata')::time t, ($1::timestamptz > now() and $1::timestamptz <= now() + interval '7 days') in_wk`, [m.resets_at]); })();
    ok('a week resets Monday 00:00 India time', m.period === 'week' && wr.d === 1 && String(wr.t).startsWith('00:00:00') && wr.in_wk, JSON.stringify([m, wr]));
    ok('this week the two opened today still count', m.used === 2 && m.left === 0, JSON.stringify(m));
    await root();
    await q(`update public.profiles set contact_limit = 4 where id = $1`, [STU]);
    await as(STU);
    await q(`select public.reveal_contact($1)`, [T[3]]);
    await root();
    const wl = await one(`select detail from public.admin_log where act='Opened a contact' and who_id=$1 order by id desc limit 1`, [STU]);
    ok('the log line says "this week" for a week limit', /Contact 3 of 4 this week/.test(wl.detail), JSON.stringify(wl));
    // a reveal from before this week started is not counted
    await q(`insert into public.contact_reveals (user_id, target_id, week_start, created_at) values ($1,$2,current_date, (date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') - interval '1 hour')`, [STU, T[9]]);
    await as(STU);
    ok('last week\'s contact does not count this week', (await one(`select public.my_contact_limit() m`)).m.used === 3);

    // ---------------------------------------------------------------- roles in action, faculty included
    await as(FAC);
    ok('faculty can open contacts up to their own number', (await one(`select public.my_contact_limit() m`)).m.limit === 3);
    for (const t of [T[4], T[5], T[6]]) await q(`select public.reveal_contact($1)`, [t]);
    await expectErr('faculty are stopped at their number', () => q(`select public.reveal_contact($1)`, [T[7]]), /limit_reached/);
    await as(VOL);
    ok('a volunteer has the volunteer number', (await one(`select public.my_contact_limit() m`)).m.limit === 12);
    await root();
    await q(`update public.settings set value='1' where key='contact_limit_alum'`);
    await as(ALM);
    await q(`select public.reveal_contact($1)`, [T[8]]);
    await expectErr('alumni are stopped at the alumni number', () => q(`select public.reveal_contact($1)`, [T[10]]), /limit_reached/);
    await root();
    await q(`update public.profiles set is_volunteer = true where id = $1`, [ALM]);
    ok('an alum who is also a volunteer gets the volunteer number', (await lim(ALM)) === 12);
    await as(ALM);
    await q(`select public.reveal_contact($1)`, [T[10]]);
    ok('so they can open more', (await one(`select public.my_contact_limit() m`)).m.used === 2);

    // ---------------------------------------------------------------- the rules for signed-out people and the old limit of 0
    await root();
    await q('set local role anon');
    await expectErr('signed-out people cannot ask for a limit', () => q(`select public.my_contact_limit()`), /permission denied|not_signed_in/);
    await root();
    await q(`update public.profiles set contact_limit = 0 where id = $1`, [STU]);
    await as(STU);
    ok('a personal limit of 0 means no new contacts', (await one(`select public.contacts_left() n`)).n === 0);
  } catch (e) {
    fail++; console.log('FIRST ERROR: ' + global.firstErr); console.log('FAIL (crashed) ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  } finally {
    await c.query('rollback');
    const left = (await c.query(`select (select count(*) from auth.users where email like '%@test.invalid') u, (select count(*) from public.profiles where name like 'TEST%') p, (select count(*) from public.settings where key = 'contact_period' and value <> 'week') s`)).rows[0];
    console.log(`\nrolled back. left behind: users=${left.u} profiles=${left.p} changed-settings=${left.s}`);
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
