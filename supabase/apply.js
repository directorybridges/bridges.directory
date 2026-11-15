// Applies supabase/0001_init.sql, seeds institutes, stores the Resend key in Supabase Vault,
// and schedules the daily clean-up. Safe to run again.
//   cd supabase && npm i pg && node apply.js ../.env
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const envFile = process.argv[2] || path.join(__dirname, '..', '.env');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

(async () => {
  const c = new Client({
    host: env.SUPABASE_DB_HOST, port: 5432, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
  });
  await c.connect();
  try {
    for (const f of fs.readdirSync(__dirname).filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort()) {
      await c.query(fs.readFileSync(path.join(__dirname, f), 'utf8'));
      console.log('applied', f);
    }

    const inst = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-institutes.json'), 'utf8'));
    for (const i of inst) {
      await c.query(
        `insert into public.institutes (id, short, name, grp, email_domain, campuses, branches)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (id) do update set short=excluded.short, name=excluded.name, grp=excluded.grp,
           email_domain=excluded.email_domain, campuses=excluded.campuses, branches=excluded.branches`,
        [i.id, i.short, i.name, i.grp, i.email_domain, i.campuses, i.branches]);
    }
    console.log('institutes seeded:', inst.length);

    if (env.RESEND_API_KEY) {
      const has = await c.query(`select 1 from vault.secrets where name = 'resend_api_key'`);
      if (has.rowCount === 0) {
        await c.query(`select vault.create_secret($1, 'resend_api_key', 'Resend key for sending site emails')`, [env.RESEND_API_KEY]);
        console.log('resend key stored in vault');
      } else {
        await c.query(`select vault.update_secret(id, $1) from vault.secrets where name = 'resend_api_key'`, [env.RESEND_API_KEY]);
        console.log('resend key refreshed in vault');
      }
    }

    // 02:00 India time = 20:30 UTC
    await c.query(`select cron.unschedule(jobid) from cron.job where jobname = 'bridges-daily-cleanup'`);
    await c.query(`select cron.schedule('bridges-daily-cleanup', '30 20 * * *', $$select public.daily_cleanup()$$)`);
    console.log('daily clean-up scheduled');
  } finally {
    await c.end();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
