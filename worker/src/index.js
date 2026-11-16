/* Bridges.directory certificate Worker.
 *
 * Certificates are stored in a PRIVATE Cloudflare R2 bucket. Nothing here decides who may see a file: every request is
 * first checked by the Supabase database, using the caller's own sign-in. The Worker only moves bytes.
 *
 *   PUT /u/<request id>   upload the redacted certificate (image/jpeg, image/png or image/webp), sign-in required
 *   GET /f/<request id>   read it back, only for the applicant, an approver on the pending queue, or an admin who may verify
 *   scheduled             every 6 hours: delete from R2 the files the database queued for deletion
 *
 * Settings (wrangler.toml): SUPABASE_URL, SUPABASE_KEY (the public publishable key), ALLOWED_ORIGINS.
 * Secret (wrangler secret put WORKER_SECRET): the value stored in Supabase Vault as cert_worker_secret.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsFor(req, env) {
  const origin = req.headers.get('Origin') || '';
  const ok = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).indexOf(origin) >= 0;
  const h = { 'Vary': 'Origin' };
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const reply = (status, body, cors, extra) => new Response(body == null ? null : JSON.stringify(body),
  { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors, extra || {}) });

// call a database function. With a member token it runs as that member; with null it runs as the public key (the secret proves the Worker).
async function rpc(env, name, args, token) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + (token || env.SUPABASE_KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {})
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  return { ok: r.ok, status: r.status, data };
}
const why = (r) => {
  const m = String((r.data && (r.data.message || r.data.error_description)) || '');
  if (r.status === 401 || /JWT|not_signed_in/i.test(m)) return [401, 'not_signed_in'];
  if (/file_deleted/.test(m)) return [410, 'file_deleted'];
  if (/not_found/.test(m)) return [404, 'not_found'];
  if (/not_allowed/.test(m)) return [403, 'not_allowed'];
  return [502, 'database_error'];
};

// the first bytes must really be the image type the member said it is
function looksLike(mime, b) {
  const u = new Uint8Array(b.slice(0, 12));
  if (mime === 'image/jpeg') return u[0] === 0xFF && u[1] === 0xD8 && u[2] === 0xFF;
  if (mime === 'image/png') return u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47;
  if (mime === 'image/webp') return u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50;
  return false;
}

async function purge(env) {
  const l = await rpc(env, 'cert_purge_list', { p_secret: env.WORKER_SECRET }, null);
  if (!l.ok) { console.error('purge list failed', l.status); return { error: l.status }; }
  const keys = Array.isArray(l.data) ? l.data : [];
  if (!keys.length) return { deleted: 0 };
  await env.BUCKET.delete(keys);
  const d = await rpc(env, 'cert_purge_done', { p_secret: env.WORKER_SECRET, p_keys: keys }, null);
  if (!d.ok) console.error('purge confirm failed', d.status);
  return { deleted: keys.length };
}

export default {
  async fetch(req, env) {
    const cors = corsFor(req, env), url = new URL(req.url), parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return reply(200, { ok: true }, cors);
    try {
      const auth = req.headers.get('Authorization') || '', token = /^Bearer\s+(.+)$/i.exec(auth);
      const id = parts[1];
      if (parts.length !== 2 || !UUID.test(id || '')) return reply(404, { error: 'not_found' }, cors);
      if (!token) return reply(401, { error: 'not_signed_in' }, cors);
      const jwt = token[1];

      if (req.method === 'PUT' && parts[0] === 'u') {
        const may = await rpc(env, 'cert_may_upload', { p_request: id }, jwt);
        if (!may.ok) { const [s, e] = why(may); return reply(s, { error: e }, cors); }
        const { key, mime, max_bytes } = may.data;
        if ((req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== mime) return reply(415, { error: 'bad_type' }, cors);
        const declared = Number(req.headers.get('Content-Length') || 0);
        if (declared > max_bytes) return reply(413, { error: 'bad_file_size' }, cors);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > max_bytes) return reply(413, { error: 'bad_file_size' }, cors);
        if (!looksLike(mime, buf)) return reply(415, { error: 'bad_type' }, cors);
        await env.BUCKET.put(key, buf, { httpMetadata: { contentType: mime } });
        const done = await rpc(env, 'cert_uploaded', { p_secret: env.WORKER_SECRET, p_request: id, p_bytes: buf.byteLength }, null);
        if (!done.ok) { await env.BUCKET.delete(key); const [s, e] = why(done); return reply(s, { error: e }, cors); }
        return reply(204, null, cors);
      }

      if (req.method === 'GET' && parts[0] === 'f') {
        const may = await rpc(env, 'cert_may_view', { p_request: id }, jwt);
        if (!may.ok) { const [s, e] = why(may); return reply(s, { error: e }, cors); }
        const obj = await env.BUCKET.get(may.data.key);
        if (!obj) return reply(410, { error: 'file_deleted' }, cors);
        return new Response(obj.body, { status: 200, headers: Object.assign({
          'Content-Type': may.data.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline; filename="certificate"', 'Content-Security-Policy': "default-src 'none'; sandbox"
        }, cors) });
      }
      return reply(405, { error: 'method_not_allowed' }, cors);
    } catch (e) {
      console.error('worker error', e && e.message);
      return reply(500, { error: 'server_error' }, cors);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(purge(env)); }
};
