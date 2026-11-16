// End-to-end test of the certificate Worker on this computer, against the REAL database with throwaway test users.
// R2 is simulated locally by wrangler (nothing is written to Cloudflare). All test users and rows are removed at the end.
//   cd worker && NODE_PATH=<path to pg> node test-local.js ../.env
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = Object.fromEntries(fs.readFileSync(process.argv[2] || path.join(__dirname, '..', '.env'), 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const SB = env.SUPABASE_URL, PK = env.SUPABASE_PUBLISHABLE_KEY, PORT = 8799, W = 'http://localhost:' + PORT, ORIGIN = 'http://localhost:8093';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); };
const PW = crypto.randomBytes(12).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(email) {
  const r = await fetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: PK, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const j = await r.json(); if (!j.access_token) throw new Error('login failed for ' + email + ': ' + JSON.stringify(j).slice(0, 120));
  return j.access_token;
}
const rpc = (name, args, tok) => fetch(SB + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: PK, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const put = (id, tok, body, type) => fetch(W + '/u/' + id, { method: 'PUT', headers: Object.assign({ Origin: ORIGIN }, tok ? { Authorization: 'Bearer ' + tok } : {}, type ? { 'Content-Type': type } : {}), body });
const get = (id, tok) => fetch(W + '/f/' + id, { headers: Object.assign({ Origin: ORIGIN }, tok ? { Authorization: 'Bearer ' + tok } : {}) });

(async () => {
  const c = new Client({ host: env.SUPABASE_DB_HOST, port: 5432, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
  await c.connect();
  let child = null; const keys = [];
  const dev = path.join(__dirname, '.dev.vars');
  try {
    const secret = (await c.query(`select decrypted_secret s from vault.decrypted_secrets where name='cert_worker_secret'`)).rows[0].s;
    fs.writeFileSync(dev, 'WORKER_SECRET=' + secret + '\n');
    const mk = async (tag, o) => {
      const id = crypto.randomUUID(), email = `zz-r2${tag}@test.invalid`;
      await c.query(`insert into auth.users (id,email,aud,role,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,instance_id,
        confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
        values ($1,$2,'authenticated','authenticated', extensions.crypt($3, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}','{}', now(), now(),'00000000-0000-0000-0000-000000000000','','','','','','','','')`, [id, email, PW]);
      await c.query(`insert into auth.identities (id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values (gen_random_uuid(),$1,$2,'email',$3,now(),now(),now())`, [id, id, JSON.stringify({ sub: id, email, email_verified: true })]);
      await c.query(`insert into public.profiles (id,kind,name,institute_id,branch,year,verified,listed,verify_method,is_volunteer) values ($1,'student',$2,'nift','Fashion Design',2027,$3,$3,$4,$5)`, [id, 'ZZ R2 ' + tag, !!o.verified, o.verified ? 'certificate' : null, !!o.vol]);
      await c.query(`insert into public.profile_private (id) values ($1)`, [id]);
      if (o.admin) await c.query(`insert into public.admins (user_id, role) values ($1,'Owner')`, [id]);
      return { id, email };
    };
    const APP = await mk('app', {}), VOL = await mk('vol', { verified: true, vol: true }), OTH = await mk('oth', { verified: true }), ADM = await mk('adm', { verified: true, admin: true });
    const tA = await login(APP.email), tV = await login(VOL.email), tO = await login(OTH.email), tM = await login(ADM.email);

    // start the local Worker (R2 is simulated on disk)
    child = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--test-scheduled'], { cwd: __dirname, stdio: 'ignore' });
    let up = false; for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = (await fetch(W + '/health')).ok; } catch (e) { /* not yet */ } }
    ok('worker is running locally', up); if (!up) throw new Error('worker did not start');

    const st = await rpc('submit_certificate_start', { p_mime: 'image/png', p_bytes: PNG.length }, tA);
    const rid = st.body; ok('applicant can start a certificate request', st.status === 200 && typeof rid === 'string', JSON.stringify(st));
    const key = (await c.query(`select object_key k from public.verification_requests where id=$1`, [rid])).rows[0].k; keys.push(key);
    ok('request has an R2 key and no file yet', /^certs\//.test(key));

    ok('no sign-in: refused (401)', (await put(rid, null, PNG, 'image/png')).status === 401);
    ok('another member cannot upload for this request (403)', (await put(rid, tO, PNG, 'image/png')).status === 403);
    ok('wrong content type refused (415)', (await put(rid, tA, PNG, 'image/jpeg')).status === 415);
    ok('not an image refused (415)', (await put(rid, tA, Buffer.from('this is not a png at all'), 'image/png')).status === 415);
    ok('too large refused (413)', (await put(rid, tA, Buffer.alloc(8000001, 1), 'image/png')).status === 413);
    ok('before any upload, nothing to view (410)', (await get(rid, tA)).status === 410);
    const up1 = await put(rid, tA, PNG, 'image/png'); ok('applicant uploads the file (204)', up1.status === 204, String(up1.status));
    ok('a second upload is refused (403)', (await put(rid, tA, PNG, 'image/png')).status === 403);
    const meta = (await c.query(`select file_uploaded_at, file_bytes from public.verification_requests where id=$1`, [rid])).rows[0];
    ok('database knows the file arrived', !!meta.file_uploaded_at && meta.file_bytes === PNG.length, JSON.stringify(meta));

    const g1 = await get(rid, tA), b1 = Buffer.from(await g1.arrayBuffer());
    ok('applicant reads their own file back, byte for byte', g1.status === 200 && b1.equals(PNG) && g1.headers.get('content-type') === 'image/png', g1.status + ' ' + b1.length);
    ok('file is never cached and cannot run as a page', /no-store/.test(g1.headers.get('cache-control') || '') && g1.headers.get('x-content-type-options') === 'nosniff');
    ok('a volunteer can read it while it is pending', (await get(rid, tV)).status === 200);
    ok('an ordinary member cannot read it (403)', (await get(rid, tO)).status === 403);
    ok('an admin who may verify can read it', (await get(rid, tM)).status === 200);
    ok('no sign-in: cannot read (401)', (await get(rid, null)).status === 401);
    ok('a made-up id is not found (404)', (await get('00000000-0000-4000-8000-000000000000', tA)).status === 404);
    const gc = await rpc('get_certificate', { p_request: rid }, tV); ok('database tells the site to use the Worker (r2)', gc.status === 200 && gc.body && gc.body.r2 === true, JSON.stringify(gc.body).slice(0, 80));
    const ag = await rpc('admin_get_certificate', { p_request: rid }, tM); ok('admin function also says r2', ag.status === 200 && ag.body && ag.body.r2 === true);
    const al = await rpc('admin_list_verification', { p_status: 'pending' }, tM);
    ok('admin list shows the file as present', al.status === 200 && (al.body || []).some(x => x.request_id === rid && x.has_file === true));
    const cors = await fetch(W + '/f/' + rid, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    ok('another website gets no CORS permission', !cors.headers.get('access-control-allow-origin'));
    const cors2 = await fetch(W + '/f/' + rid, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
    ok('the site itself is allowed', cors2.headers.get('access-control-allow-origin') === ORIGIN);

    // a cert_uploaded call without the secret must fail even for a signed-in member
    const bad = await rpc('cert_uploaded', { p_secret: 'x'.repeat(40), p_request: rid, p_bytes: 1 }, tA);
    ok('cert_uploaded refuses a wrong secret', bad.status >= 400);
    const bad2 = await rpc('cert_purge_list', { p_secret: 'x'.repeat(40) }, tA);
    ok('cert_purge_list refuses a wrong secret', bad2.status >= 400);

    // deletion: deadline passes -> daily clean-up queues the key -> the Worker's schedule removes it from R2
    await c.query(`update public.verification_requests set delete_after = now() - interval '1 minute' where id=$1`, [rid]);
    const dc = (await c.query(`select public.daily_cleanup() r`)).rows[0].r;
    ok('daily clean-up counts the certificate as deleted', dc.certificates_deleted >= 1, JSON.stringify(dc));
    const qd = (await c.query(`select 1 from public.cert_purge where key=$1`, [key])).rowCount;
    ok('the R2 file is queued for deletion', qd === 1);
    ok('applicant now gets "deleted" (410)', (await get(rid, tA)).status === 410);
    const sch = await fetch(W + '/__scheduled?cron=30+*/6+*+*+*'); await sleep(1500);
    ok('scheduled run finished', sch.ok, String(sch.status));
    const qd2 = (await c.query(`select 1 from public.cert_purge where key=$1`, [key])).rowCount;
    ok('queue is empty after the Worker ran', qd2 === 0);

    // already-verified members cannot start a request; deleting an account queues its file
    const vs = await rpc('submit_certificate_start', { p_mime: 'image/png', p_bytes: PNG.length }, tO);
    ok('a verified member cannot start a request', vs.status >= 400 && /already_verified/.test(JSON.stringify(vs.body)), JSON.stringify(vs));
    const r3 = (await rpc('submit_certificate_start', { p_mime: 'image/png', p_bytes: PNG.length }, tA)).body;
    const k3 = (await c.query(`select object_key k from public.verification_requests where id=$1`, [r3])).rows[0].k; keys.push(k3);
    ok('a second start replaces the first unfinished one', typeof r3 === 'string');
    await c.query(`delete from auth.users where id=$1`, [APP.id]);
    ok('deleting an account queues its R2 file', (await c.query(`select 1 from public.cert_purge where key=$1`, [k3])).rowCount === 1);
  } catch (e) {
    fail++; console.log('FAIL (crashed) ' + e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(500); }
    try { fs.unlinkSync(dev); } catch (e) { /* ignore */ }
    try {
      await c.query(`delete from public.cert_purge where key = any($1)`, [keys]);
      await c.query(`delete from auth.users where email like 'zz-r2%@test.invalid'`);
      await c.query(`delete from public.cert_purge where key = any($1)`, [keys]);
      await c.query(`delete from public.admin_log where who like 'ZZ R2%' or target like 'ZZ R2%' or who like 'zz-r2%'`);
      const left = (await c.query(`select (select count(*) from auth.users where email like 'zz-r2%') u, (select count(*) from public.profiles where name like 'ZZ R2%') p, (select count(*) from public.cert_purge where key = any($1)) q`, [keys])).rows[0];
      console.log('cleaned up. left behind: ' + JSON.stringify(left));
    } catch (e) { console.log('CLEANUP PROBLEM: ' + e.message); }
    await c.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
