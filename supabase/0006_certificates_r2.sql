-- Certificates in private Cloudflare R2 (the plan agreed with Aman), with the database as the gatekeeper.
-- The website never holds R2 keys. A small Cloudflare Worker (worker/) does the file work, but only after it asks the database
-- (with the member's own sign-in) whether this person may upload or see this file. Old certificates already in the database keep working.
--
-- Flow:  submit_certificate_start -> browser PUTs the redacted image to the Worker -> Worker calls cert_may_upload, stores the file in R2,
--        calls cert_uploaded.  Viewing: get_certificate / admin_get_certificate say "r2", browser GETs the Worker, Worker calls cert_may_view.
--        Deleting: daily_cleanup queues the file in cert_purge; the Worker's schedule deletes it from R2 and clears the queue.

alter table public.verification_requests
  add column if not exists object_key text,
  add column if not exists file_mime text,
  add column if not exists file_bytes int,
  add column if not exists file_uploaded_at timestamptz;

create table if not exists public.cert_purge (
  key       text primary key,
  queued_at timestamptz not null default now()
);
alter table public.cert_purge enable row level security;
revoke all on public.cert_purge from anon, authenticated;

-- a secret only the Worker and the database know (kept in Supabase Vault; the Worker gets its own copy as a Worker secret)
do $$ begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cert_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cert_worker_secret', 'Shared secret between the certificate Worker and the database');
  end if;
end $$;

create or replace function public.cert_secret_ok(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p is not null and length(p) >= 32 and exists (select 1 from vault.decrypted_secrets where name = 'cert_worker_secret' and decrypted_secret = p);
$$;
revoke all on function public.cert_secret_ok(text) from public, anon, authenticated;

-- when a request row goes (account deleted, or cleaned up), its file must still be removed from R2
create or replace function public.trg_vr_purge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.object_key is not null then insert into public.cert_purge (key) values (old.object_key) on conflict do nothing; end if;
  return old;
end $$;
drop trigger if exists vr_before_delete_purge on public.verification_requests;
create trigger vr_before_delete_purge before delete on public.verification_requests for each row execute function public.trg_vr_purge();

-- 1) the member starts a certificate request; the file follows through the Worker
create or replace function public.submit_certificate_start(p_mime text, p_bytes int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; rid uuid;
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind not in ('student','alum') then raise exception 'no_profile'; end if;
  if me.verified then raise exception 'already_verified'; end if;
  if p_mime is null or p_mime not in ('image/jpeg','image/png','image/webp') then raise exception 'bad_type'; end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > public.cfg('max_certificate_bytes')::int then raise exception 'bad_file_size'; end if;
  -- an earlier attempt whose file never arrived does not block a new one
  delete from public.verification_requests v
   where v.applicant_id = u and v.status = 'pending' and v.file_uploaded_at is null and not exists (select 1 from public.certificate_files f where f.request_id = v.id);
  if exists (select 1 from public.verification_requests where applicant_id = u and status = 'pending') then raise exception 'request_pending'; end if;
  insert into public.verification_requests (applicant_id, delete_after, object_key, file_mime, file_bytes)
  values (u, now() + (public.cfg('days_if_unreviewed') || ' days')::interval, 'certs/' || gen_random_uuid()::text, p_mime, p_bytes) returning id into rid;
  return rid;
end $$;

-- 2) the Worker asks (with the member's sign-in): may this person upload the file for this request?
create or replace function public.cert_may_upload(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); r public.verification_requests;
begin
  select * into r from public.verification_requests where id = p_request;
  if not found or r.applicant_id <> u or r.status <> 'pending' or r.object_key is null or r.file_uploaded_at is not null then raise exception 'not_allowed'; end if;
  return jsonb_build_object('key', r.object_key, 'mime', r.file_mime, 'max_bytes', public.cfg('max_certificate_bytes')::int);
end $$;

-- 3) the Worker confirms the file is stored (needs the shared secret, so a member cannot claim an upload that never happened)
create or replace function public.cert_uploaded(p_secret text, p_request uuid, p_bytes int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.cert_secret_ok(p_secret) then raise exception 'not_allowed'; end if;
  update public.verification_requests set file_uploaded_at = now(), file_bytes = p_bytes
   where id = p_request and object_key is not null and file_uploaded_at is null and status = 'pending';
  if not found then raise exception 'not_found'; end if;
end $$;

-- 4) the Worker asks (with the person's sign-in): may they see this file? Same rules as the database version.
create or replace function public.cert_may_view(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); r public.verification_requests;
begin
  select * into r from public.verification_requests where id = p_request;
  if not found then raise exception 'not_found'; end if;
  if r.applicant_id = u then null;
  elsif public.admin_can('verify') then null;
  elsif exists (select 1 from public.profiles where id = u and is_volunteer and status = 'active') and r.status = 'pending' then null;
  else raise exception 'not_allowed'; end if;
  if r.object_key is null or r.file_uploaded_at is null then raise exception 'file_deleted'; end if;
  return jsonb_build_object('key', r.object_key, 'mime', r.file_mime);
end $$;

-- the old viewing functions now point the browser at the Worker when the file is in R2
create or replace function public.get_certificate(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); f public.certificate_files; r public.verification_requests;
begin
  select * into r from public.verification_requests where id = p_request;
  if not found then raise exception 'not_found'; end if;
  if r.applicant_id = u then
    null; -- the applicant may see their own file
  elsif not (exists (select 1 from public.profiles where id = u and is_volunteer and status = 'active') and r.status = 'pending') then
    raise exception 'not_allowed';
  end if;
  select * into f from public.certificate_files where request_id = p_request;
  if found then return jsonb_build_object('mime', f.mime, 'data', encode(f.data, 'base64')); end if;
  if r.object_key is not null and r.file_uploaded_at is not null then return jsonb_build_object('r2', true, 'mime', r.file_mime); end if;
  raise exception 'file_deleted';
end $$;

create or replace function public.admin_get_certificate(p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.certificate_files; r public.verification_requests;
begin
  perform public.need_perm('verify');
  select * into f from public.certificate_files where request_id = p_request;
  if found then return jsonb_build_object('mime', f.mime, 'data', encode(f.data, 'base64')); end if;
  select * into r from public.verification_requests where id = p_request;
  if found and r.object_key is not null and r.file_uploaded_at is not null then return jsonb_build_object('r2', true, 'mime', r.file_mime); end if;
  raise exception 'file_deleted';
end $$;

-- the admin list says "has file" for R2 files too (edits the existing function in place, so nothing else in it changes)
do $$ declare d text; begin
  select pg_get_functiondef('public.admin_list_verification(text)'::regprocedure) into d;
  if d not like '%file_uploaded_at%' then
    d := replace(d, 'exists (select 1 from public.certificate_files f where f.request_id = r.id)',
                    '(exists (select 1 from public.certificate_files f where f.request_id = r.id) or (r.object_key is not null and r.file_uploaded_at is not null))');
    execute d;
  end if;
end $$;

-- daily clean-up: certificates past their deadline are deleted from the database and queued for deletion from R2
create or replace function public.daily_cleanup() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare files int; codes int; refs int;
begin
  with due as (
    select id, object_key from public.verification_requests where delete_after <= now() and file_deleted_at is null
  ), queued as (
    insert into public.cert_purge (key) select object_key from due where object_key is not null on conflict do nothing returning 1
  ), gone as (
    delete from public.certificate_files f using due where f.request_id = due.id returning f.request_id
  )
  -- a request nobody reviewed in time is closed as rejected, so the person can upload again instead of being stuck on "pending"
  update public.verification_requests r set file_deleted_at = now(), object_key = null,
    status = case when r.status = 'pending' then 'rejected' else r.status end,
    reject_reason = case when r.status = 'pending' then 'other' else r.reject_reason end,
    reject_note = case when r.status = 'pending' then 'Not reviewed in time. The file was deleted, so please upload it again.' else r.reject_note end,
    decided_at = case when r.status = 'pending' then now() else r.decided_at end
  from due where r.id = due.id;
  get diagnostics files = row_count;
  delete from public.email_verifications where expires_at < now() - interval '1 day';
  get diagnostics codes = row_count;
  update public.referrals set status = 'expired' where status = 'pending' and expires_at <= now();
  get diagnostics refs = row_count;
  delete from public.referral_attempts where at < now() - interval '1 day';
  return jsonb_build_object('certificates_deleted', files, 'old_codes_removed', codes, 'referrals_expired', refs);
end $$;

-- the Worker's schedule: which files must go from R2, then confirm they are gone
create or replace function public.cert_purge_list(p_secret text) returns setof text
language plpgsql security definer set search_path = '' as $$
begin
  if not public.cert_secret_ok(p_secret) then raise exception 'not_allowed'; end if;
  return query select key from public.cert_purge order by queued_at limit 500;
end $$;
create or replace function public.cert_purge_done(p_secret text, p_keys text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.cert_secret_ok(p_secret) then raise exception 'not_allowed'; end if;
  delete from public.cert_purge where key = any(p_keys);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.submit_certificate_start(text,int), public.cert_may_upload(uuid), public.cert_may_view(uuid),
  public.cert_uploaded(text,uuid,int), public.cert_purge_list(text), public.cert_purge_done(text,text[]) from public, anon, authenticated;
grant execute on function public.submit_certificate_start(text,int), public.cert_may_upload(uuid), public.cert_may_view(uuid) to authenticated;
grant execute on function public.cert_uploaded(text,uuid,int), public.cert_purge_list(text), public.cert_purge_done(text,text[]) to anon, authenticated;
