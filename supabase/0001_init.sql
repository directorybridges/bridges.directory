-- Bridges.directory: database, locks (RLS) and rules.
-- Safe to re-run. Applied with supabase/apply.js. Owner of the project: Aman's Supabase org.
--
-- Rules baked in (from the contract schedule):
--   * Certificates are deleted automatically: 15 days after approval, 30 days after rejection,
--     30 days if never reviewed. Only the verified flag and the date are kept.
--   * A certificate needs 2 volunteer approvals. Nobody reviews their own, nobody reviews twice.
--     Approvers are never shown to anyone.
--   * A member opens 5 contacts a week (resets Monday 00:00 IST). Opened contacts stay visible.
--   * Admin portal can only: approve/reject volunteers, view/remove volunteers, view contributions.
--   * Contributions are written only by the payment backend (service role), never by the browser.
--   * Certificate images live in the database (table certificate_files), so a delete is a real delete.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- settings
create table if not exists public.settings (
  key   text primary key,
  value text not null,
  note  text
);
insert into public.settings(key, value, note) values
  ('approvals_needed',   '2',        'volunteer approvals needed for a certificate'),
  ('weekly_contacts',    '5',        'contacts a member can open per week'),
  ('days_after_approval','15',       'certificate deleted this many days after approval'),
  ('days_after_rejection','30',      'certificate deleted this many days after rejection'),
  ('days_if_unreviewed', '30',       'default: same as rejection (open decision, Aman to confirm)'),
  ('referral_days',      '14',       'referral code lifetime (prototype value)'),
  ('max_certificate_bytes','8000000','largest redacted image accepted'),
  ('min_contribution_paise','1000',  'prototype value, Aman to confirm'),
  ('yearly_target_paise','1000000',  'prototype value (about INR 10,000 a year), Aman to confirm')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- institutes
create table if not exists public.institutes (
  id           text primary key,
  short        text not null,
  name         text not null,
  grp          text not null,
  email_domain text not null,
  campuses     text[] not null default '{}',
  branches     text[] not null default '{}'
);

-- ---------------------------------------------------------------- people
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('student','alum','faculty')),
  name         text not null check (char_length(name) between 1 and 80),
  institute_id text references public.institutes(id),
  campus       text not null default '',
  branch       text not null default '' check (char_length(branch) <= 80),
  year         int,
  helps        int[] not null default '{}',
  avatar       jsonb not null default '{}'::jsonb,
  experiences  jsonb not null default '[]'::jsonb check (jsonb_typeof(experiences) = 'array'),
  listed       boolean not null default false,
  verified     boolean not null default false,
  verify_method text check (verify_method in ('institute_email','certificate','referral')),
  verified_at  timestamptz,
  is_volunteer boolean not null default false,
  status       text not null default 'active' check (status in ('active','hidden','suspended')),
  created_at   timestamptz not null default now()
);
create index if not exists profiles_dir_idx on public.profiles (institute_id, kind) where listed and verified and status = 'active';

-- contact details: shown only through reveal_contact()
create table if not exists public.profile_private (
  id             uuid primary key references public.profiles(id) on delete cascade,
  email_institute text,
  email_personal  text,
  links          jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  vol_phone      text
);

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- verification
create table if not exists public.email_verifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  used       boolean not null default false,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);

create table if not exists public.verification_requests (
  id             uuid primary key default gen_random_uuid(),
  applicant_id   uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  reject_reason  text check (reject_reason in ('name_mismatch','unreadable','not_a_certificate','institute_mismatch','other')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  delete_after   timestamptz not null,
  file_deleted_at timestamptz
);
create index if not exists vr_pending_idx on public.verification_requests (created_at) where status = 'pending';
create index if not exists vr_delete_idx  on public.verification_requests (delete_after) where file_deleted_at is null;

create table if not exists public.certificate_files (
  request_id uuid primary key references public.verification_requests(id) on delete cascade,
  mime       text not null check (mime in ('image/jpeg','image/png','image/webp')),
  data       bytea not null
);

create table if not exists public.verification_reviews (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.verification_requests(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision    text not null check (decision in ('approve','reject')),
  created_at  timestamptz not null default now(),
  unique (request_id, reviewer_id)
);

-- ---------------------------------------------------------------- volunteers
create table if not exists public.volunteer_applications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references public.profiles(id) on delete cascade,
  phone       text not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  consent     boolean not null check (consent),
  status      text not null default 'pending' check (status in ('pending','approved','rejected','stepped_down','removed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- growth
create table if not exists public.referrals (
  id            uuid primary key default gen_random_uuid(),
  referrer_id   uuid not null references public.profiles(id) on delete cascade,
  institute_id  text not null references public.institutes(id),
  invitee_email text not null,
  code_hash     text not null unique,
  status        text not null default 'pending' check (status in ('pending','joined','expired')),
  used_by       uuid references auth.users(id) on delete set null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create table if not exists public.referral_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now()
);
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique,
  email      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- contacts and reports
create table if not exists public.contact_reveals (
  user_id    uuid not null references auth.users(id) on delete cascade,
  target_id  uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_id)
);
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  target_id   uuid not null references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('wrong_details','spam','harassment','other')),
  note        text check (char_length(note) <= 500),
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- money
create table if not exists public.contributions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete set null,
  display_name        text not null default 'Anonymous',
  anonymous           boolean not null default false,
  amount_paise        bigint not null check (amount_paise > 0),
  status              text not null default 'created' check (status in ('created','paid','failed')),
  razorpay_order_id   text unique,
  razorpay_payment_id text unique,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

-- ================================================================ helpers
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.cfg(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select value from public.settings where key = p_key;
$$;

create or replace function public.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public.hash_code(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(upper(p), 'sha256'), 'hex');
$$;

create or replace function public.new_code(n int, digits_only boolean) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare alphabet text := case when digits_only then '0123456789' else 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' end;
        out text := ''; b bytea := extensions.gen_random_bytes(n); i int;
begin
  for i in 0..n-1 loop
    out := out || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  return out;
end $$;

-- sends mail through Resend (key lives in Supabase Vault, in Aman's project)
create or replace function public.send_email(p_to text, p_subject text, p_html text) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if current_setting('app.skip_email', true) = 'on' then return; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'resend_api_key';
  if k is null then raise exception 'email_not_configured'; end if;
  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || k, 'Content-Type', 'application/json'),
    body    := jsonb_build_object('from', 'Bridges.directory <no-reply@bridges.directory>',
                                  'to', jsonb_build_array(p_to), 'subject', p_subject, 'html', p_html));
end $$;

-- ================================================================ profile
create or replace function public.create_my_profile(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); inst public.institutes; k text := p->>'kind'; c text := coalesce(p->>'campus','');
begin
  if exists (select 1 from public.profiles where id = u) then raise exception 'profile_exists'; end if;
  if k not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into inst from public.institutes where id = p->>'institute_id';
  if not found then raise exception 'bad_institute'; end if;
  if c <> '' and not (c = any (inst.campuses)) then raise exception 'bad_campus'; end if;
  insert into public.profiles (id, kind, name, institute_id, campus, branch, year, helps, avatar, experiences)
  values (u, k, btrim(p->>'name'), inst.id, c, coalesce(p->>'branch',''), nullif(p->>'year','')::int,
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'helps','[]'::jsonb))::int), '{}'),
          coalesce(p->'avatar','{}'::jsonb), coalesce(p->'experiences','[]'::jsonb));
  insert into public.profile_private (id, email_personal, links)
  values (u, nullif(btrim(coalesce(p->>'email_personal','')),''), coalesce(p->'links','[]'::jsonb));
  return u;
end $$;

create or replace function public.institute_counts()
returns table (institute_id text, alums bigint, students bigint)
language sql stable security definer set search_path = '' as $$
  select i.id,
         count(*) filter (where p.kind = 'alum'),
         count(*) filter (where p.kind = 'student')
  from public.institutes i
  left join public.profiles p on p.institute_id = i.id and p.listed and p.verified and p.status = 'active'
  where auth.uid() is not null
  group by i.id;
$$;

-- ================================================================ verification: institute email
create or replace function public.request_email_code(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; dom text; code text; em text := lower(btrim(p_email));
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'student' then raise exception 'students_only'; end if;
  if me.verified then raise exception 'already_verified'; end if;
  select email_domain into dom from public.institutes where id = me.institute_id;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or not (split_part(em,'@',2) = dom or split_part(em,'@',2) like '%.' || dom) then
    raise exception 'email_domain_mismatch';
  end if;
  if (select count(*) from public.email_verifications where user_id = u and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many_requests';
  end if;
  code := public.new_code(6, true);
  insert into public.email_verifications (user_id, email, code_hash) values (u, em, public.hash_code(code));
  perform public.send_email(em, 'Your Bridges.directory code',
    '<p>Your code is <b style="font-size:20px;letter-spacing:3px">' || code || '</b></p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>');
end $$;

create or replace function public.confirm_email_code(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); v public.email_verifications;
begin
  select * into v from public.email_verifications
   where user_id = u and not used and expires_at > now() order by created_at desc limit 1;
  if not found then raise exception 'no_active_code'; end if;
  if v.attempts >= 5 then raise exception 'too_many_attempts'; end if;
  if v.code_hash <> public.hash_code(btrim(p_code)) then
    update public.email_verifications set attempts = attempts + 1 where id = v.id;
    return false;
  end if;
  update public.email_verifications set used = true where id = v.id;
  update public.profiles set verified = true, listed = true, verify_method = 'institute_email', verified_at = now() where id = u;
  update public.profile_private set email_institute = v.email where id = u;
  return true;
end $$;

-- ================================================================ verification: certificate
create or replace function public.submit_certificate(p_mime text, p_data_base64 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; rid uuid; bytes bytea;
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind not in ('student','alum') then raise exception 'no_profile'; end if;
  if me.verified then raise exception 'already_verified'; end if;
  if exists (select 1 from public.verification_requests where applicant_id = u and status = 'pending') then
    raise exception 'request_pending';
  end if;
  bytes := decode(p_data_base64, 'base64');
  if octet_length(bytes) = 0 or octet_length(bytes) > public.cfg('max_certificate_bytes')::int then raise exception 'bad_file_size'; end if;
  insert into public.verification_requests (applicant_id, delete_after)
  values (u, now() + (public.cfg('days_if_unreviewed') || ' days')::interval) returning id into rid;
  insert into public.certificate_files (request_id, mime, data) values (rid, p_mime, bytes);
  return rid;
end $$;

create or replace function public.volunteer_queue()
returns table (request_id uuid, institute_id text, submitted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  if not exists (select 1 from public.profiles where id = u and is_volunteer and status = 'active') then raise exception 'volunteers_only'; end if;
  return query
    select r.id, p.institute_id, r.created_at
    from public.verification_requests r join public.profiles p on p.id = r.applicant_id
    where r.status = 'pending' and r.applicant_id <> u
      and not exists (select 1 from public.verification_reviews v where v.request_id = r.id and v.reviewer_id = u)
    order by r.created_at;
end $$;

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
  if not found then raise exception 'file_deleted'; end if;
  return jsonb_build_object('mime', f.mime, 'data', encode(f.data, 'base64'));
end $$;

create or replace function public.review_certificate(p_request uuid, p_decision text, p_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); r public.verification_requests; approvals int;
begin
  if p_decision not in ('approve','reject') then raise exception 'bad_decision'; end if;
  if not exists (select 1 from public.profiles where id = u and is_volunteer and status = 'active') then raise exception 'volunteers_only'; end if;
  select * into r from public.verification_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'not_pending'; end if;
  if r.applicant_id = u then raise exception 'own_application'; end if;
  if p_decision = 'reject' and (p_reason is null or p_reason not in ('name_mismatch','unreadable','not_a_certificate','institute_mismatch','other')) then
    raise exception 'reason_required';
  end if;
  begin
    insert into public.verification_reviews (request_id, reviewer_id, decision) values (p_request, u, p_decision);
  exception when unique_violation then raise exception 'already_reviewed';
  end;
  if p_decision = 'reject' then
    update public.verification_requests
       set status = 'rejected', reject_reason = p_reason, decided_at = now(),
           delete_after = now() + (public.cfg('days_after_rejection') || ' days')::interval
     where id = p_request;
    return 'rejected';
  end if;
  select count(*) into approvals from public.verification_reviews where request_id = p_request and decision = 'approve';
  if approvals >= public.cfg('approvals_needed')::int then
    update public.verification_requests
       set status = 'approved', decided_at = now(),
           delete_after = now() + (public.cfg('days_after_approval') || ' days')::interval
     where id = p_request;
    update public.profiles set verified = true, listed = true, verify_method = 'certificate', verified_at = now() where id = r.applicant_id;
    return 'approved';
  end if;
  return 'waiting';
end $$;

create or replace function public.my_request_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_build_object('status', r.status, 'reason', r.reject_reason, 'submitted_at', r.created_at), '{}'::jsonb)
  from (select 1) x
  left join lateral (select * from public.verification_requests where applicant_id = auth.uid() order by created_at desc limit 1) r on true;
$$;

-- ================================================================ referrals and invites
create or replace function public.create_referral(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; code text; em text := lower(btrim(p_email));
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'alum' or not me.verified then raise exception 'verified_alums_only'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if (select count(*) from public.referrals where referrer_id = u and created_at > now() - interval '1 day') >= 20 then raise exception 'too_many_requests'; end if;
  code := public.new_code(8, false);
  insert into public.referrals (referrer_id, institute_id, invitee_email, code_hash, expires_at)
  values (u, me.institute_id, em, public.hash_code(code), now() + (public.cfg('referral_days') || ' days')::interval);
  perform public.send_email(em, 'You have been invited to Bridges.directory',
    '<p>A verified alum from your institute invited you. Your one-time code is <b>' || code || '</b>.</p><p>Sign up at https://bridges.directory and enter it when asked. It expires in ' || public.cfg('referral_days') || ' days.</p>');
end $$;

create or replace function public.redeem_referral(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; r public.referrals;
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'alum' or me.verified then raise exception 'alums_only'; end if;
  if (select count(*) from public.referral_attempts where user_id = u and at > now() - interval '1 hour') >= 10 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_attempts (user_id) values (u);
  select * into r from public.referrals
   where code_hash = public.hash_code(btrim(p_code)) and status = 'pending' and expires_at > now() for update;
  if not found or r.institute_id <> me.institute_id then return false; end if;
  update public.referrals set status = 'joined', used_by = u where id = r.id;
  update public.profiles set verified = true, listed = true, verify_method = 'referral', verified_at = now() where id = u;
  return true;
end $$;

create or replace function public.my_referrals() returns table (invitee_email text, status text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select invitee_email,
         case when status = 'pending' and expires_at <= now() then 'expired' else status end,
         created_at, expires_at
  from public.referrals where referrer_id = auth.uid() order by created_at desc;
$$;

create or replace function public.create_invite(p_email text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); t text := lower(public.new_code(10, false));
begin
  if not exists (select 1 from public.profiles where id = u and verified) then raise exception 'verified_only'; end if;
  insert into public.invites (inviter_id, token, email) values (u, t, nullif(lower(btrim(coalesce(p_email,''))),''));
  return t;
end $$;

-- ================================================================ contacts, reports
create or replace function public.contacts_left() returns int
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); wk date := (date_trunc('week', now() at time zone 'Asia/Kolkata'))::date;
begin
  return greatest(0, public.cfg('weekly_contacts')::int
    - (select count(*) from public.contact_reveals where user_id = u and week_start = wk)::int);
end $$;

create or replace function public.reveal_contact(p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); wk date := (date_trunc('week', now() at time zone 'Asia/Kolkata'))::date;
        t public.profiles; pr public.profile_private; used int;
begin
  if not exists (select 1 from public.profiles where id = u and status = 'active' and (verified or kind = 'faculty')) then raise exception 'verified_only'; end if;
  if p_target = u then raise exception 'own_contact'; end if;
  select * into t from public.profiles where id = p_target and listed and verified and status = 'active';
  if not found then raise exception 'not_found'; end if;
  if not exists (select 1 from public.contact_reveals where user_id = u and target_id = p_target) then
    select count(*) into used from public.contact_reveals where user_id = u and week_start = wk;
    if used >= public.cfg('weekly_contacts')::int then raise exception 'limit_reached'; end if;
    insert into public.contact_reveals (user_id, target_id, week_start) values (u, p_target, wk);
  end if;
  select * into pr from public.profile_private where id = p_target;
  return jsonb_build_object('name', t.name, 'email', coalesce(pr.email_personal, pr.email_institute), 'links', pr.links);
end $$;

create or replace function public.my_contacts() returns table (target_id uuid, name text, email text, links jsonb)
language sql stable security definer set search_path = '' as $$
  select r.target_id, p.name, coalesce(pp.email_personal, pp.email_institute), pp.links
  from public.contact_reveals r
  join public.profiles p on p.id = r.target_id and p.listed and p.verified and p.status = 'active'
  join public.profile_private pp on pp.id = r.target_id
  where r.user_id = auth.uid() order by r.created_at desc;
$$;

create or replace function public.send_report(p_target uuid, p_reason text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  if p_target = u then raise exception 'own_listing'; end if;
  if not exists (select 1 from public.profiles where id = p_target) then raise exception 'not_found'; end if;
  insert into public.reports (reporter_id, target_id, reason, note) values (u, p_target, p_reason, left(p_note, 500));
end $$;

-- ================================================================ volunteers
create or replace function public.apply_volunteer(p_phone text, p_consent boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles;
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'student' or not me.verified then raise exception 'verified_students_only'; end if;
  if not coalesce(p_consent, false) then raise exception 'consent_required'; end if;
  insert into public.volunteer_applications (user_id, phone, consent) values (u, btrim(p_phone), true)
  on conflict (user_id) do update
     set phone = excluded.phone, consent = true, status = 'pending', reviewed_by = null, reviewed_at = null, created_at = now()
   where public.volunteer_applications.status in ('rejected','stepped_down','removed');
  if not found then raise exception 'application_exists'; end if;
end $$;

create or replace function public.step_down_volunteer(p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); a public.volunteer_applications;
begin
  select * into a from public.volunteer_applications where user_id = u and status = 'approved';
  if not found then raise exception 'not_a_volunteer'; end if;
  if btrim(p_phone) <> a.phone then raise exception 'number_mismatch'; end if;
  update public.volunteer_applications set status = 'stepped_down' where id = a.id;
  update public.profiles set is_volunteer = false where id = u;
  update public.profile_private set vol_phone = null where id = u;
end $$;

-- ================================================================ admin portal (three jobs only)
create or replace function public.admin_list_applications(p_status text default 'pending')
returns table (application_id uuid, user_id uuid, name text, institute_id text, branch text, year int, phone text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query select a.id, a.user_id, p.name, p.institute_id, p.branch, p.year, a.phone, a.status, a.created_at
               from public.volunteer_applications a join public.profiles p on p.id = a.user_id
               where a.status = p_status order by a.created_at;
end $$;

create or replace function public.admin_review_application(p_application uuid, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.volunteer_applications;
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  if p_decision not in ('approve','reject') then raise exception 'bad_decision'; end if;
  select * into a from public.volunteer_applications where id = p_application and status = 'pending' for update;
  if not found then raise exception 'not_pending'; end if;
  update public.volunteer_applications
     set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = a.id;
  if p_decision = 'approve' then
    update public.profiles set is_volunteer = true where id = a.user_id;
    update public.profile_private set vol_phone = a.phone where id = a.user_id;
  end if;
end $$;

create or replace function public.admin_list_volunteers()
returns table (user_id uuid, name text, institute_id text, phone text, since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query select p.id, p.name, p.institute_id, a.phone, a.reviewed_at
               from public.profiles p join public.volunteer_applications a on a.user_id = p.id
               where p.is_volunteer and a.status = 'approved' order by a.reviewed_at;
end $$;

create or replace function public.admin_remove_volunteer(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  update public.profiles set is_volunteer = false where id = p_user and is_volunteer;
  if not found then raise exception 'not_a_volunteer'; end if;
  update public.volunteer_applications set status = 'removed', reviewed_by = auth.uid(), reviewed_at = now() where user_id = p_user;
  update public.profile_private set vol_phone = null where id = p_user;
end $$;

create or replace function public.admin_list_contributions(p_limit int default 50, p_offset int default 0)
returns table (id uuid, display_name text, anonymous boolean, amount_paise bigint, status text, paid_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query select c.id, c.display_name, c.anonymous, c.amount_paise, c.status, c.paid_at, c.created_at
               from public.contributions c order by c.created_at desc limit least(p_limit, 200) offset greatest(p_offset, 0);
end $$;

-- ================================================================ contributions
create or replace function public.start_contribution(p_amount_paise bigint, p_anonymous boolean, p_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; cid uuid;
begin
  select * into me from public.profiles where id = u;
  if not found then raise exception 'no_profile'; end if;
  if p_amount_paise < public.cfg('min_contribution_paise')::bigint then raise exception 'amount_too_small'; end if;
  insert into public.contributions (user_id, anonymous, display_name, amount_paise)
  values (u, coalesce(p_anonymous, false),
          case when coalesce(p_anonymous, false) then 'Anonymous' else coalesce(nullif(btrim(p_name),''), me.name) end,
          p_amount_paise) returning id into cid;
  return cid;
end $$;

-- called only by the payment backend (service role) after Razorpay confirms
create or replace function public.mark_contribution_paid(p_contribution uuid, p_order text, p_payment text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.contributions
     set status = 'paid', paid_at = now(), razorpay_order_id = p_order, razorpay_payment_id = p_payment
   where id = p_contribution and status = 'created';
  if not found then raise exception 'not_open'; end if;
end $$;

create or replace function public.recent_contributions(p_limit int default 10)
returns table (name text, amount_paise bigint, paid_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select case when anonymous then 'Anonymous' else display_name end, amount_paise, paid_at
  from public.contributions where status = 'paid' and auth.uid() is not null
  order by paid_at desc limit least(p_limit, 50);
$$;

create or replace function public.contribution_progress()
returns table (year_start date, target_paise bigint, raised_paise bigint)
language sql stable security definer set search_path = '' as $$
  with fy as (
    select (case when extract(month from now() at time zone 'Asia/Kolkata') >= 4
                 then make_date(extract(year from now() at time zone 'Asia/Kolkata')::int, 4, 1)
                 else make_date(extract(year from now() at time zone 'Asia/Kolkata')::int - 1, 4, 1) end) as s)
  select fy.s, public.cfg('yearly_target_paise')::bigint,
         coalesce((select sum(amount_paise) from public.contributions c where c.status = 'paid' and c.paid_at >= fy.s), 0)::bigint
  from fy where auth.uid() is not null;
$$;

-- ================================================================ my data
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  return jsonb_build_object(
    'profile',  (select to_jsonb(p) from public.profiles p where p.id = u),
    'private',  (select to_jsonb(x) from public.profile_private x where x.id = u),
    'volunteer',(select to_jsonb(a) from public.volunteer_applications a where a.user_id = u),
    'contacts_opened', coalesce((select jsonb_agg(jsonb_build_object('target', r.target_id, 'at', r.created_at)) from public.contact_reveals r where r.user_id = u), '[]'::jsonb),
    'contributions', coalesce((select jsonb_agg(jsonb_build_object('amount_paise', c.amount_paise, 'status', c.status, 'at', c.created_at)) from public.contributions c where c.user_id = u), '[]'::jsonb),
    'exported_at', now());
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  delete from auth.users where id = u;   -- cascades to profile, files, reviews, reveals
end $$;

-- ================================================================ daily clean-up
create or replace function public.daily_cleanup() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare files int; codes int; refs int;
begin
  with due as (
    select id from public.verification_requests where delete_after <= now() and file_deleted_at is null
  ), gone as (
    delete from public.certificate_files f using due where f.request_id = due.id returning f.request_id
  )
  update public.verification_requests r set file_deleted_at = now() from due where r.id = due.id;
  get diagnostics files = row_count;
  delete from public.email_verifications where expires_at < now() - interval '1 day';
  get diagnostics codes = row_count;
  update public.referrals set status = 'expired' where status = 'pending' and expires_at <= now();
  get diagnostics refs = row_count;
  delete from public.referral_attempts where at < now() - interval '1 day';
  return jsonb_build_object('certificates_deleted', files, 'old_codes_removed', codes, 'referrals_expired', refs);
end $$;

-- ================================================================ locks (RLS) and grants
alter table public.settings              enable row level security;
alter table public.institutes            enable row level security;
alter table public.profiles              enable row level security;
alter table public.profile_private       enable row level security;
alter table public.admins                enable row level security;
alter table public.email_verifications   enable row level security;
alter table public.verification_requests enable row level security;
alter table public.certificate_files     enable row level security;
alter table public.verification_reviews  enable row level security;
alter table public.volunteer_applications enable row level security;
alter table public.referrals             enable row level security;
alter table public.referral_attempts     enable row level security;
alter table public.invites               enable row level security;
alter table public.contact_reveals       enable row level security;
alter table public.reports               enable row level security;
alter table public.contributions         enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- read-only reference data
grant select on public.institutes to anon, authenticated;
grant select on public.settings   to authenticated;
drop policy if exists institutes_read on public.institutes;
create policy institutes_read on public.institutes for select to anon, authenticated using (true);
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);

-- profiles: members see listed, verified, active people and themselves
grant select on public.profiles to authenticated;
grant update (name, campus, branch, year, helps, avatar, experiences) on public.profiles to authenticated;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or (listed and verified and status = 'active'));
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- private contact details: owner only
grant select on public.profile_private to authenticated;
grant update (email_personal, links) on public.profile_private to authenticated;
drop policy if exists pp_read_own on public.profile_private;
create policy pp_read_own on public.profile_private for select to authenticated using (id = auth.uid());
drop policy if exists pp_update_own on public.profile_private;
create policy pp_update_own on public.profile_private for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- the applicant can see their own request row (never the reviews, never the reviewers)
grant select (id, applicant_id, status, reject_reason, created_at, decided_at) on public.verification_requests to authenticated;
drop policy if exists vr_read_own on public.verification_requests;
create policy vr_read_own on public.verification_requests for select to authenticated using (applicant_id = auth.uid());

-- volunteers read their own application; everything else goes through functions
grant select on public.volunteer_applications to authenticated;
drop policy if exists va_read_own on public.volunteer_applications;
create policy va_read_own on public.volunteer_applications for select to authenticated using (user_id = auth.uid());

-- all other tables have no direct access: functions only (RLS on, no policy = closed)

-- what the browser may call
grant execute on function
  public.create_my_profile(jsonb), public.institute_counts(),
  public.request_email_code(text), public.confirm_email_code(text),
  public.submit_certificate(text, text), public.volunteer_queue(), public.get_certificate(uuid),
  public.review_certificate(uuid, text, text), public.my_request_status(),
  public.create_referral(text), public.redeem_referral(text), public.my_referrals(), public.create_invite(text),
  public.contacts_left(), public.reveal_contact(uuid), public.my_contacts(), public.send_report(uuid, text, text),
  public.apply_volunteer(text, boolean), public.step_down_volunteer(text),
  public.admin_list_applications(text), public.admin_review_application(uuid, text), public.admin_list_volunteers(),
  public.admin_remove_volunteer(uuid), public.admin_list_contributions(int, int),
  public.start_contribution(bigint, boolean, text), public.recent_contributions(int), public.contribution_progress(),
  public.export_my_data(), public.delete_my_account(), public.is_admin()
to authenticated;
-- payment backend only
grant execute on function public.mark_contribution_paid(uuid, text, text) to service_role;
grant execute on function public.daily_cleanup() to service_role;
