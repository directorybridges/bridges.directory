-- 0003: the full admin portal (all screens of the admin design) on real data.
-- Adds: roles and permissions, the activity log, members list and edits, faculty accounts,
-- verification overrides, report handling, editable page text, team, settings, overview.
-- Safe to run again. Every admin function checks the caller's role on the server.

-- ================================================================ roles and permissions
alter table public.admins add column if not exists role text not null default 'Admin';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'admins_role_check') then
    alter table public.admins add constraint admins_role_check check (role in ('Owner','Admin','Moderator','Support'));
  end if;
end $$;
-- the first people added are the owners
update public.admins set role = 'Owner' where not exists (select 1 from public.admins where role = 'Owner');

create table if not exists public.admin_perms (
  role    text not null check (role in ('Owner','Admin','Moderator','Support')),
  perm    text not null check (perm in ('logs','edit','suspend','delete','verify','reports','faculty','content','export','settings','team')),
  allowed boolean not null default false,
  primary key (role, perm)
);
insert into public.admin_perms (role, perm, allowed)
select r.role, p.perm,
  case r.role
    when 'Owner' then true
    when 'Admin' then p.perm <> 'team'
    when 'Moderator' then p.perm in ('logs','edit','suspend','verify','reports')
    else p.perm in ('logs','edit','faculty')
  end
from (values ('Owner'),('Admin'),('Moderator'),('Support')) r(role),
     (values ('logs'),('edit'),('suspend'),('delete'),('verify'),('reports'),('faculty'),('content'),('export'),('settings'),('team')) p(perm)
on conflict (role, perm) do nothing;

create table if not exists public.admin_invites (
  email      text primary key,
  name       text not null,
  role       text not null check (role in ('Admin','Moderator','Support')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.admin_can(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and (a.role = 'Owner' or exists (select 1 from public.admin_perms x where x.role = a.role and x.perm = p and x.allowed))
  );
$$;

create or replace function public.need_perm(p text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  if not public.admin_can(p) then raise exception 'no_permission'; end if;
  return auth.uid();
end $$;

-- ================================================================ activity log
create table if not exists public.admin_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  who_id    uuid,
  who       text not null,
  role      text not null,
  type      text not null check (type in ('auth','signup','profile','contact','verify','report','admin')),
  act       text not null,
  target    text,
  target_id uuid,
  detail    text,
  device    text,
  ip        text,
  sev       text
);
create index if not exists admin_log_at_idx on public.admin_log (at desc);
create index if not exists admin_log_type_idx on public.admin_log (type, at desc);
create index if not exists admin_log_target_idx on public.admin_log (target_id);
create index if not exists admin_log_who_idx on public.admin_log (who_id);

-- internal: nobody can call this from the browser
create or replace function public.write_log(p_type text, p_act text, p_target text default null, p_target_id uuid default null,
                                            p_detail text default null, p_sev text default null, p_who uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare w uuid := coalesce(p_who, auth.uid()); nm text; rl text; hdr jsonb; ip text; dev text; em text;
begin
  if w is not null then
    select a.role into rl from public.admins a where a.user_id = w;
    select p.name into nm from public.profiles p where p.id = w;
    if rl is null then
      select case when p.kind = 'faculty' then 'Faculty' when p.is_volunteer then 'Volunteer' else 'Member' end
        into rl from public.profiles p where p.id = w;
    end if;
    if nm is null then select u.email into em from auth.users u where u.id = w; nm := em; end if;
  end if;
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
  ip := nullif(btrim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'cf-connecting-ip', ''), ',', 1)), '');
  dev := nullif(left(coalesce(hdr->>'user-agent', ''), 160), '');
  insert into public.admin_log (who_id, who, role, type, act, target, target_id, detail, device, ip, sev)
  values (w, coalesce(nm, 'Visitor'), coalesce(rl, 'Visitor'), p_type, p_act, p_target, p_target_id, p_detail, dev, ip, p_sev);
end $$;
revoke all on function public.write_log(text,text,text,uuid,text,text,uuid) from public, anon, authenticated;

-- ================================================================ extra columns and settings
alter table public.profiles add column if not exists contact_limit int check (contact_limit is null or contact_limit >= 0);
alter table public.profiles add column if not exists last_seen timestamptz;
alter table public.institutes add column if not exists codes_enabled boolean not null default true;
alter table public.verification_requests add column if not exists decided_by uuid references auth.users(id) on delete set null;
alter table public.verification_requests add column if not exists reject_note text;
alter table public.verification_requests add column if not exists asked_at timestamptz;
alter table public.verification_requests add column if not exists asked_msg text;
alter table public.reports add column if not exists resolution text;
alter table public.reports add column if not exists resolved_by uuid references auth.users(id) on delete set null;
alter table public.reports add column if not exists resolved_at timestamptz;
alter table public.reports add column if not exists reporter_name text;
alter table public.reports add column if not exists target_name text;

insert into public.settings (key, value, note) values
  ('signups_open', 'true', 'false pauses new sign-ups'),
  ('signups_pause_msg', 'Sign-ups are paused for a few days while we check new listings.', 'shown when sign-ups are paused'),
  ('banner_on', 'false', 'site notice on or off'),
  ('banner_msg', '', 'site notice text')
on conflict (key) do nothing;

create table if not exists public.blocked_accounts (
  email      text primary key,
  reason     text,
  blocked_by uuid references auth.users(id) on delete set null,
  blocked_at timestamptz not null default now()
);

-- settings anyone may read (the site shows the notice and the pause message)
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'signups_open', coalesce(public.cfg('signups_open'), 'true') <> 'false',
    'pause_msg', coalesce(public.cfg('signups_pause_msg'), ''),
    'banner_on', coalesce(public.cfg('banner_on'), 'false') = 'true',
    'banner_msg', coalesce(public.cfg('banner_msg'), ''));
$$;

-- ================================================================ rules the site must follow
create or replace function public.trg_profiles_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare em text;
begin
  if new.kind <> 'faculty' then
    if coalesce(public.cfg('signups_open'), 'true') = 'false' then raise exception 'signups_paused'; end if;
    select lower(u.email) into em from auth.users u where u.id = new.id;
    if em is not null and exists (select 1 from public.blocked_accounts b where b.email = em) then raise exception 'account_blocked'; end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_before_insert on public.profiles;
create trigger profiles_before_insert before insert on public.profiles for each row execute function public.trg_profiles_before_insert();

create or replace function public.trg_codes_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p join public.institutes i on i.id = p.institute_id
             where p.id = new.user_id and not i.codes_enabled) then
    raise exception 'codes_off';
  end if;
  return new;
end $$;
drop trigger if exists email_verifications_before_insert on public.email_verifications;
create trigger email_verifications_before_insert before insert on public.email_verifications for each row execute function public.trg_codes_enabled();

-- weekly contacts: a member's own limit (if set) wins over the site default
create or replace function public.contacts_left() returns int
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); wk date := (date_trunc('week', now() at time zone 'Asia/Kolkata'))::date; lim int;
begin
  select coalesce(p.contact_limit, public.cfg('weekly_contacts')::int) into lim from public.profiles p where p.id = u;
  return greatest(0, coalesce(lim, public.cfg('weekly_contacts')::int)
    - (select count(*) from public.contact_reveals where user_id = u and week_start = wk)::int);
end $$;

create or replace function public.reveal_contact(p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); wk date := (date_trunc('week', now() at time zone 'Asia/Kolkata'))::date;
        t public.profiles; pr public.profile_private; used int; lim int;
begin
  if not exists (select 1 from public.profiles where id = u and status = 'active' and (verified or kind = 'faculty')) then raise exception 'verified_only'; end if;
  if p_target = u then raise exception 'own_contact'; end if;
  select * into t from public.profiles where id = p_target and listed and verified and status = 'active';
  if not found then raise exception 'not_found'; end if;
  if not exists (select 1 from public.contact_reveals where user_id = u and target_id = p_target) then
    select coalesce(p.contact_limit, public.cfg('weekly_contacts')::int) into lim from public.profiles p where p.id = u;
    select count(*) into used from public.contact_reveals where user_id = u and week_start = wk;
    if used >= lim then raise exception 'limit_reached'; end if;
    insert into public.contact_reveals (user_id, target_id, week_start) values (u, p_target, wk);
  end if;
  select * into pr from public.profile_private where id = p_target;
  return jsonb_build_object('name', t.name, 'email', coalesce(pr.email_personal, pr.email_institute), 'links', pr.links);
end $$;

-- ================================================================ things members do, written to the log
create or replace function public.trg_log_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'faculty' then
    perform public.write_log('signup', 'Signed up', null, null, initcap(new.kind) || ' · waiting to be verified', null, new.id);
  end if;
  return new;
end $$;
drop trigger if exists profiles_after_insert_log on public.profiles;
create trigger profiles_after_insert_log after insert on public.profiles for each row execute function public.trg_log_signup();

create or replace function public.trg_log_verified() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.verified and not old.verified and new.kind <> 'faculty' then
    perform public.write_log('signup', 'Got verified', null, null,
      case new.verify_method when 'institute_email' then 'Institute email code' when 'certificate' then 'Certificate' when 'referral' then 'Referral code' else 'Admin' end,
      null, new.id);
  end if;
  return new;
end $$;
drop trigger if exists profiles_after_update_verified on public.profiles;
create trigger profiles_after_update_verified after update of verified on public.profiles for each row execute function public.trg_log_verified();

create or replace function public.trg_log_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tn text; lim int; used int;
begin
  select name into tn from public.profiles where id = new.target_id;
  select coalesce(p.contact_limit, public.cfg('weekly_contacts')::int) into lim from public.profiles p where p.id = new.user_id;
  select count(*) into used from public.contact_reveals where user_id = new.user_id and week_start = new.week_start;
  perform public.write_log('contact', 'Opened a contact', tn, new.target_id, 'Contact ' || used || ' of ' || coalesce(lim, 5) || ' this week', null, new.user_id);
  return new;
end $$;
drop trigger if exists contact_reveals_after_insert on public.contact_reveals;
create trigger contact_reveals_after_insert after insert on public.contact_reveals for each row execute function public.trg_log_contact();

create or replace function public.trg_report_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select name into new.target_name from public.profiles where id = new.target_id;
  select name into new.reporter_name from public.profiles where id = new.reporter_id;
  return new;
end $$;
drop trigger if exists reports_before_insert on public.reports;
create trigger reports_before_insert before insert on public.reports for each row execute function public.trg_report_fill();

create or replace function public.report_reason_label(r text) returns text
language sql immutable set search_path = '' as $$
  select case r when 'wrong_details' then 'Wrong institute, branch or year' when 'spam' then 'Spam or promotion'
                when 'harassment' then 'Harassment or abuse' else 'Something else' end;
$$;

create or replace function public.trg_log_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.write_log('report', 'Reported a listing', new.target_name, new.target_id, public.report_reason_label(new.reason), null, new.reporter_id);
  return new;
end $$;
drop trigger if exists reports_after_insert on public.reports;
create trigger reports_after_insert after insert on public.reports for each row execute function public.trg_log_report();

create or replace function public.trg_log_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare an text; n int; need int;
begin
  select p.name into an from public.verification_requests r join public.profiles p on p.id = r.applicant_id where r.id = new.request_id;
  select count(*) into n from public.verification_reviews where request_id = new.request_id and decision = 'approve';
  need := public.cfg('approvals_needed')::int;
  perform public.write_log('verify', case new.decision when 'approve' then 'Approved a certificate' else 'Rejected a certificate' end,
    an, null, case new.decision when 'approve' then n || ' of ' || need || ' approvals' else null end, null, new.reviewer_id);
  return new;
end $$;
drop trigger if exists verification_reviews_after_insert on public.verification_reviews;
create trigger verification_reviews_after_insert after insert on public.verification_reviews for each row execute function public.trg_log_review();

create or replace function public.trg_log_referral() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  select short into s from public.institutes where id = new.institute_id;
  perform public.write_log('verify', 'Sent a referral code', null, null, 'To an alum of ' || coalesce(s, new.institute_id), null, new.referrer_id);
  return new;
end $$;
drop trigger if exists referrals_after_insert on public.referrals;
create trigger referrals_after_insert after insert on public.referrals for each row execute function public.trg_log_referral();

create or replace function public.trg_log_own_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ch text[] := '{}';
begin
  if auth.uid() is distinct from new.id then return new; end if;
  if new.name is distinct from old.name then ch := array_append(ch, 'Name'); end if;
  if new.institute_id is distinct from old.institute_id or new.campus is distinct from old.campus then ch := array_append(ch, 'Institute'); end if;
  if new.branch is distinct from old.branch then ch := array_append(ch, 'Branch'); end if;
  if new.year is distinct from old.year then ch := array_append(ch, 'Year'); end if;
  if new.helps is distinct from old.helps then ch := array_append(ch, 'Happy to help with'); end if;
  if new.experiences is distinct from old.experiences then ch := array_append(ch, 'Experience'); end if;
  if new.listed is distinct from old.listed then ch := array_append(ch, 'Listing'); end if;
  if array_length(ch, 1) > 0 then
    perform public.write_log('profile', 'Edited their profile', null, null, array_to_string(ch, ', '), null, new.id);
  end if;
  return new;
end $$;
drop trigger if exists profiles_after_update_own on public.profiles;
create trigger profiles_after_update_own after update on public.profiles for each row execute function public.trg_log_own_edit();

-- ================================================================ faculty accounts
create table if not exists public.faculty_accounts (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  fid         text not null unique,
  title       text not null default 'Faculty',
  dept        text not null default '',
  email       text,
  status      text not null default 'active' check (status in ('active','disabled')),
  made_by     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  pw_at       timestamptz not null default now(),
  last_signin timestamptz
);
create table if not exists public.retired_fids (fid text primary key, retired_at timestamptz not null default now());

create or replace function public.log_signin(p_faculty boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); f text; em text;
begin
  update public.profiles set last_seen = now() where id = u;
  if p_faculty then
    update public.faculty_accounts set last_signin = now() where user_id = u returning fid into f;
    if f is not null then perform public.write_log('auth', 'Signed in with faculty ID', null, null, f, null, u); end if;
  else
    select u2.email into em from auth.users u2 where u2.id = u;
    perform public.write_log('auth', 'Signed in with Google', null, null, em, null, u);
  end if;
end $$;

create or replace function public.log_signout() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.write_log('auth', 'Logged out', null, null, null, null, public.require_user());
end $$;

create or replace function public.log_faculty_failed(p_fid text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_fid is null or p_fid !~ '^[A-Za-z0-9@._-]{1,60}$' then return; end if;
  if (select count(*) from public.admin_log where act = 'Faculty sign-in failed' and at > now() - interval '1 hour') >= 100 then return; end if;
  perform public.write_log('auth', 'Faculty sign-in failed', null, null, upper(split_part(p_fid, '@', 1)) || ' · wrong ID or password', 'warn', null);
end $$;

create or replace function public.random_password() returns text
language plpgsql volatile set search_path = '' as $$
declare alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789'; pw text := ''; i int; b bytea := extensions.gen_random_bytes(12);
begin
  for i in 0..11 loop
    pw := pw || substr(alphabet, 1 + (get_byte(b, i) % length(alphabet)), 1);
    if i in (3, 7) then pw := pw || '-'; end if;
  end loop;
  return pw;
end $$;
revoke all on function public.random_password() from public, anon, authenticated;

create or replace function public.admin_list_faculty()
returns table (user_id uuid, fid text, name text, title text, dept text, institute_id text, campus text, email text,
               status text, created_at timestamptz, made_by_name text, last_signin timestamptz, pw_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('faculty');
  return query
    select f.user_id, f.fid, p.name, f.title, f.dept, p.institute_id, p.campus, f.email, f.status, f.created_at,
           (select coalesce(pp.name, au.email) from auth.users au left join public.profiles pp on pp.id = au.id where au.id = f.made_by),
           f.last_signin, f.pw_at
    from public.faculty_accounts f join public.profiles p on p.id = f.user_id
    order by f.created_at desc;
end $$;

create or replace function public.admin_create_faculty(p_name text, p_title text, p_dept text, p_institute text, p_campus text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('faculty'); uid uuid := gen_random_uuid(); f text; pw text := public.random_password();
        nm text := btrim(coalesce(p_name, '')); tries int := 0; em text := nullif(lower(btrim(coalesce(p_email, ''))), '');
        ttl text := coalesce(nullif(btrim(coalesce(p_title, '')), ''), 'Faculty'); dp text := btrim(coalesce(p_dept, ''));
begin
  if char_length(nm) < 1 or char_length(nm) > 80 then raise exception 'name_required'; end if;
  if not exists (select 1 from public.institutes where id = p_institute) then raise exception 'bad_institute'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if em is not null and (exists (select 1 from public.faculty_accounts where lower(email) = em)
                         or exists (select 1 from auth.users where lower(email) = em)) then raise exception 'email_taken'; end if;
  loop
    f := 'BRF-' || (1000 + ((get_byte(extensions.gen_random_bytes(2), 0) * 256 + get_byte(extensions.gen_random_bytes(2), 1)) % 9000));
    exit when not exists (select 1 from public.faculty_accounts where fid = f) and not exists (select 1 from public.retired_fids where fid = f);
    tries := tries + 1; if tries > 50 then raise exception 'no_free_id'; end if;
  end loop;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(f) || '@faculty.bridges.directory',
          extensions.crypt(pw, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', '', '');
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', lower(f) || '@faculty.bridges.directory', 'email_verified', true),
          'email', uid::text, now(), now(), now());
  insert into public.profiles (id, kind, name, institute_id, campus, branch, experiences, listed, verified)
  values (uid, 'faculty', nm, p_institute, coalesce(p_campus, ''), left(dp, 80),
          jsonb_build_array(jsonb_build_object('title', ttl, 'dept', dp)), false, true);
  insert into public.profile_private (id) values (uid) on conflict do nothing;
  insert into public.faculty_accounts (user_id, fid, title, dept, email, made_by) values (uid, f, ttl, dp, em, me);
  perform public.write_log('admin', 'Created a faculty account', nm, uid, f);
  return jsonb_build_object('user_id', uid, 'fid', f, 'password', pw);
end $$;

create or replace function public.admin_update_faculty(p_id uuid, p_name text, p_title text, p_dept text, p_institute text, p_campus text, p_email text, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('faculty'); fa public.faculty_accounts; nm text := btrim(coalesce(p_name, ''));
        em text := nullif(lower(btrim(coalesce(p_email, ''))), ''); ttl text := coalesce(nullif(btrim(coalesce(p_title, '')), ''), 'Faculty');
        dp text := btrim(coalesce(p_dept, '')); act text;
begin
  select * into fa from public.faculty_accounts where user_id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if char_length(nm) < 1 or char_length(nm) > 80 then raise exception 'name_required'; end if;
  if not exists (select 1 from public.institutes where id = p_institute) then raise exception 'bad_institute'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if em is not null and exists (select 1 from public.faculty_accounts where lower(email) = em and user_id <> p_id) then raise exception 'email_taken'; end if;
  update public.profiles set name = nm, institute_id = p_institute, campus = coalesce(p_campus, ''), branch = left(dp, 80),
         experiences = jsonb_build_array(jsonb_build_object('title', ttl, 'dept', dp)),
         status = case when p_active then 'active' else 'suspended' end
   where id = p_id;
  update public.faculty_accounts set title = ttl, dept = dp, email = em, status = case when p_active then 'active' else 'disabled' end where user_id = p_id;
  if p_active then
    update auth.users set banned_until = null where id = p_id;
  else
    update auth.users set banned_until = '3000-01-01'::timestamptz where id = p_id;
    delete from auth.sessions where user_id = p_id;
  end if;
  act := case when fa.status = 'active' and not p_active then 'Turned off a faculty account'
              when fa.status = 'disabled' and p_active then 'Turned a faculty account back on'
              else 'Edited a faculty profile' end;
  perform public.write_log('admin', act, nm, p_id, fa.fid);
end $$;

create or replace function public.admin_reset_faculty_password(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('faculty'); fa public.faculty_accounts; pw text := public.random_password(); nm text;
begin
  select * into fa from public.faculty_accounts where user_id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')), updated_at = now() where id = p_id;
  delete from auth.sessions where user_id = p_id;
  update public.faculty_accounts set pw_at = now() where user_id = p_id;
  select name into nm from public.profiles where id = p_id;
  perform public.write_log('admin', 'Reset a faculty password', nm, p_id, fa.fid);
  return jsonb_build_object('fid', fa.fid, 'password', pw);
end $$;

create or replace function public.admin_delete_faculty(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('faculty'); fa public.faculty_accounts; nm text;
begin
  select * into fa from public.faculty_accounts where user_id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  select name into nm from public.profiles where id = p_id;
  insert into public.retired_fids (fid) values (fa.fid) on conflict do nothing;
  delete from auth.users where id = p_id;
  perform public.write_log('admin', 'Deleted a faculty account', nm, null, fa.fid);
end $$;

-- ================================================================ members
create or replace function public.admin_list_members()
returns table (id uuid, kind text, name text, institute_id text, campus text, branch text, year int, helps int[], experiences jsonb,
               links jsonb, listed boolean, verified boolean, verify_method text, is_volunteer boolean, vol_phone text, status text,
               contact_limit int, created_at timestamptz, last_seen timestamptz, google_email text, email_institute text, email_personal text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query
    select p.id, p.kind, p.name, p.institute_id, p.campus, p.branch, p.year, p.helps, p.experiences, pp.links, p.listed, p.verified,
           p.verify_method, p.is_volunteer, pp.vol_phone, p.status, p.contact_limit, p.created_at, p.last_seen, lower(u.email),
           pp.email_institute, pp.email_personal
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.profile_private pp on pp.id = p.id
    where p.kind in ('student','alum')
    order by p.created_at desc;
end $$;

create or replace function public.admin_update_member(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.require_user(); r public.profiles; pr public.profile_private; ins public.institutes;
        edit_ch text[] := '{}'; need_edit boolean := false; need_susp boolean := false;
        n_name text; n_kind text; n_inst text; n_campus text; n_branch text; n_year int; n_links jsonb; n_helps int[]; n_exp jsonb;
        n_limit int; n_vol boolean; n_ei text; n_ep text; n_listed boolean; n_status text; dom text;
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  select * into r from public.profiles where id = p_id for update;
  if not found or r.kind = 'faculty' then raise exception 'not_found'; end if;
  select * into pr from public.profile_private where id = p_id;

  n_name := case when p ? 'name' then btrim(p->>'name') else r.name end;
  n_kind := case when p ? 'kind' then p->>'kind' else r.kind end;
  n_inst := case when p ? 'institute_id' then p->>'institute_id' else r.institute_id end;
  n_campus := case when p ? 'campus' then coalesce(p->>'campus', '') else r.campus end;
  n_branch := case when p ? 'branch' then btrim(coalesce(p->>'branch', '')) else r.branch end;
  n_year := case when p ? 'year' then nullif(p->>'year', '')::int else r.year end;
  n_links := case when p ? 'links' then p->'links' else pr.links end;
  n_helps := case when p ? 'helps' then array(select (jsonb_array_elements_text(p->'helps'))::int) else r.helps end;
  n_exp := case when p ? 'experiences' then p->'experiences' else r.experiences end;
  n_limit := case when p ? 'contact_limit' then nullif(p->>'contact_limit', '')::int else r.contact_limit end;
  n_vol := case when p ? 'is_volunteer' then (p->>'is_volunteer')::boolean else r.is_volunteer end;
  n_ei := case when p ? 'email_institute' then nullif(lower(btrim(coalesce(p->>'email_institute', ''))), '') else pr.email_institute end;
  n_ep := case when p ? 'email_personal' then nullif(lower(btrim(coalesce(p->>'email_personal', ''))), '') else pr.email_personal end;
  n_listed := case when p ? 'listed' then (p->>'listed')::boolean else r.listed end;
  n_status := case when p ? 'status' then p->>'status' else r.status end;

  if char_length(n_name) < 1 or char_length(n_name) > 80 then raise exception 'name_required'; end if;
  if n_kind not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into ins from public.institutes where id = n_inst;
  if not found then raise exception 'bad_institute'; end if;
  if char_length(n_branch) > 80 then raise exception 'bad_branch'; end if;
  if p ? 'campus' and n_campus <> '' and not (n_campus = any (ins.campuses)) then raise exception 'bad_campus'; end if;
  if p ? 'year' and n_year is not null and (n_year < 1970 or n_year > 2032) then raise exception 'bad_year'; end if;
  if p ? 'links' then
    if jsonb_typeof(n_links) <> 'array' or jsonb_array_length(n_links) > 4 then raise exception 'bad_links'; end if;
    if exists (select 1 from jsonb_array_elements(n_links) l where coalesce(l->>'url', '') !~* '^(https?://)?[^\s/:]+\.[a-z]{2,}(:[0-9]+)?([/?#][^\s]*)?$') then raise exception 'bad_links'; end if;
  end if;
  if jsonb_typeof(n_exp) <> 'array' then raise exception 'bad_experience'; end if;
  if n_limit is not null and n_limit not in (0,1,2,3,5,8,10,15,20) then raise exception 'bad_limit'; end if;
  if n_status not in ('active','suspended') then raise exception 'bad_status'; end if;
  dom := ins.email_domain;
  if n_ei is not null and not (split_part(n_ei, '@', 2) = dom or split_part(n_ei, '@', 2) like '%.' || dom) then raise exception 'email_domain_mismatch'; end if;
  if n_ep is not null and n_ep !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if n_kind = 'alum' then n_vol := false; n_ei := null; end if;
  if n_kind = 'student' then n_ep := null; end if;

  if n_name is distinct from r.name then edit_ch := array_append(edit_ch, 'Name'); end if;
  if n_kind is distinct from r.kind then edit_ch := array_append(edit_ch, 'Type'); end if;
  if n_inst is distinct from r.institute_id then edit_ch := array_append(edit_ch, 'Institute'); end if;
  if n_campus is distinct from r.campus then edit_ch := array_append(edit_ch, 'Campus'); end if;
  if n_branch is distinct from r.branch then edit_ch := array_append(edit_ch, 'Branch'); end if;
  if n_year is distinct from r.year then edit_ch := array_append(edit_ch, 'Year'); end if;
  if n_links is distinct from pr.links then edit_ch := array_append(edit_ch, 'Links'); end if;
  if n_helps is distinct from r.helps then edit_ch := array_append(edit_ch, 'Happy to help with'); end if;
  if n_limit is distinct from r.contact_limit then edit_ch := array_append(edit_ch, 'Weekly contacts'); end if;
  if n_vol is distinct from r.is_volunteer then edit_ch := array_append(edit_ch, 'Volunteer'); end if;
  if n_ei is distinct from pr.email_institute then edit_ch := array_append(edit_ch, 'Emails'); end if;
  if n_ep is distinct from pr.email_personal then edit_ch := array_append(edit_ch, 'Contact email'); end if;
  if n_exp is distinct from r.experiences then edit_ch := array_append(edit_ch, 'Experience'); end if;
  need_edit := array_length(edit_ch, 1) > 0;
  need_susp := n_listed is distinct from r.listed or n_status is distinct from r.status;
  if need_edit and not public.admin_can('edit') then raise exception 'no_permission'; end if;
  if need_susp and not public.admin_can('suspend') then raise exception 'no_permission'; end if;

  if n_vol and not r.is_volunteer and not exists (select 1 from public.volunteer_applications where user_id = p_id and status = 'approved') then
    raise exception 'no_volunteer_application';
  end if;

  update public.profiles set name = n_name, kind = n_kind, institute_id = n_inst, campus = n_campus, branch = n_branch, year = n_year,
         helps = n_helps, experiences = n_exp, contact_limit = n_limit, is_volunteer = n_vol, listed = n_listed, status = n_status
   where id = p_id;
  update public.profile_private set links = n_links, email_institute = n_ei, email_personal = n_ep,
         vol_phone = case when n_vol then vol_phone else null end where id = p_id;
  if r.is_volunteer and not n_vol then
    update public.volunteer_applications set status = 'removed', reviewed_by = me, reviewed_at = now() where user_id = p_id and status = 'approved';
  end if;
  if n_status is distinct from r.status then
    if n_status = 'suspended' then
      update auth.users set banned_until = '3000-01-01'::timestamptz where id = p_id;
      delete from auth.sessions where user_id = p_id;
    else
      update auth.users set banned_until = null where id = p_id;
    end if;
    perform public.write_log('admin', case n_status when 'suspended' then 'Suspended a member' else 'Reinstated a member' end, n_name, p_id, null);
  end if;
  if n_listed is distinct from r.listed then
    perform public.write_log('admin', case when n_listed then 'Listed a member again' else 'Hid a listing' end, n_name, p_id, null);
  end if;
  if need_edit then
    perform public.write_log('admin', 'Edited a profile', n_name, p_id, array_to_string(edit_ch, ', '));
  end if;
end $$;

create or replace function public.admin_delete_member(p_id uuid, p_reason text, p_block boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('delete'); r public.profiles; em text;
begin
  select * into r from public.profiles where id = p_id for update;
  if not found or r.kind = 'faculty' then raise exception 'not_found'; end if;
  select lower(email) into em from auth.users where id = p_id;
  update public.reports set status = 'resolved', resolution = 'Deleted the profile.', resolved_by = me, resolved_at = now(),
         target_name = coalesce(target_name, r.name)
   where target_id = p_id and status = 'open';
  if p_block and em is not null then
    insert into public.blocked_accounts (email, reason, blocked_by) values (em, left(p_reason, 200), me) on conflict (email) do nothing;
  end if;
  perform public.write_log('admin', 'Deleted a profile', r.name, null,
    coalesce(nullif(btrim(p_reason), ''), 'No reason given') || case when p_block then ' · Google account blocked' else '' end);
  delete from auth.users where id = p_id;
end $$;

create or replace function public.admin_export_members()
returns table (name text, kind text, institute text, campus text, branch text, year int, google_email text, email_institute text,
               email_personal text, links jsonb, verified_by text, status text, listed boolean, weekly_contacts int, created_at timestamptz, last_seen timestamptz)
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public.need_perm('export');
  select count(*) into n from public.profiles pf where pf.kind in ('student','alum');
  perform public.write_log('admin', 'Exported members', null, null, n || ' rows');
  return query
    select p.name, p.kind, i.short, p.campus, p.branch, p.year, lower(u.email), pp.email_institute, pp.email_personal, pp.links,
           case p.verify_method when 'institute_email' then 'Institute email code' when 'certificate' then 'Certificate' when 'referral' then 'Referral code' else '' end,
           p.status, p.listed, coalesce(p.contact_limit, public.cfg('weekly_contacts')::int), p.created_at, p.last_seen
    from public.profiles p join auth.users u on u.id = p.id
    left join public.profile_private pp on pp.id = p.id left join public.institutes i on i.id = p.institute_id
    where p.kind in ('student','alum') order by p.created_at desc;
end $$;

create or replace function public.admin_member_log(p_id uuid, p_limit int default 6)
returns setof public.admin_log
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('logs');
  return query select * from public.admin_log where who_id = p_id or target_id = p_id order by at desc limit least(greatest(p_limit, 1), 50);
end $$;

-- ================================================================ verification
create or replace function public.admin_list_verification(p_status text default 'pending')
returns table (request_id uuid, applicant_id uuid, name text, kind text, institute_id text, campus text, branch text, year int, email text,
               status text, created_at timestamptz, decided_at timestamptz, decided_by_name text, reject_reason text, reject_note text,
               asked_at timestamptz, approvals int, approvers text[], needed int, has_file boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('verify');
  return query
    select r.id, r.applicant_id, p.name, p.kind, p.institute_id, p.campus, p.branch, p.year, lower(u.email), r.status, r.created_at, r.decided_at,
           (select coalesce(dp.name, du.email) from auth.users du left join public.profiles dp on dp.id = du.id where du.id = r.decided_by),
           r.reject_reason, r.reject_note, r.asked_at,
           (select count(*)::int from public.verification_reviews v where v.request_id = r.id and v.decision = 'approve'),
           array(select coalesce(rp.name, 'Volunteer') from public.verification_reviews v left join public.profiles rp on rp.id = v.reviewer_id
                 where v.request_id = r.id and v.decision = 'approve' order by v.created_at),
           public.cfg('approvals_needed')::int,
           exists (select 1 from public.certificate_files f where f.request_id = r.id)
    from public.verification_requests r
    join public.profiles p on p.id = r.applicant_id join auth.users u on u.id = r.applicant_id
    where r.status = p_status
    order by case when p_status = 'pending' then r.created_at end asc, r.decided_at desc nulls last, r.created_at desc;
end $$;

create or replace function public.admin_get_certificate(p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.certificate_files;
begin
  perform public.need_perm('verify');
  select * into f from public.certificate_files where request_id = p_request;
  if not found then raise exception 'file_deleted'; end if;
  return jsonb_build_object('mime', f.mime, 'data', encode(f.data, 'base64'));
end $$;

create or replace function public.esc_html(t text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create or replace function public.admin_decide_verification(p_request uuid, p_decision text, p_reason text default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('verify'); r public.verification_requests; ap public.profiles; em text; n int; need int;
begin
  if p_decision not in ('approve','reject') then raise exception 'bad_decision'; end if;
  select * into r from public.verification_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'not_pending'; end if;
  select * into ap from public.profiles where id = r.applicant_id;
  select lower(email) into em from auth.users where id = r.applicant_id;
  if p_decision = 'reject' then
    if p_reason is null or p_reason not in ('name_mismatch','unreadable','not_a_certificate','institute_mismatch','other') then raise exception 'reason_required'; end if;
    update public.verification_requests
       set status = 'rejected', reject_reason = p_reason, reject_note = left(nullif(btrim(coalesce(p_note, '')), ''), 300),
           decided_at = now(), decided_by = me, delete_after = now() + (public.cfg('days_after_rejection') || ' days')::interval
     where id = p_request;
    perform public.write_log('verify', 'Rejected verification', ap.name, ap.id,
      case p_reason when 'name_mismatch' then 'The name on the certificate does not match.' when 'institute_mismatch' then 'The institute, branch or year does not match.'
                    when 'unreadable' then 'The file is unreadable.' when 'not_a_certificate' then 'It is not a valid certificate.' else 'Other' end
      || coalesce(' ' || nullif(btrim(p_note), ''), ''));
    if em is not null then
      perform public.send_email(em, 'About your Bridges.directory verification',
        '<p>We could not verify your certificate yet.</p><p>' || public.esc_html(coalesce(nullif(btrim(p_note), ''), 'Please check the details and try again with a clearer file.')) ||
        '</p><p>You can try again at https://bridges.directory</p>');
    end if;
    return;
  end if;
  select count(*)::int into n from public.verification_reviews where request_id = p_request and decision = 'approve';
  need := public.cfg('approvals_needed')::int;
  update public.verification_requests
     set status = 'approved', decided_at = now(), decided_by = me, delete_after = now() + (public.cfg('days_after_approval') || ' days')::interval
   where id = p_request;
  update public.profiles set verified = true, listed = true, verify_method = 'certificate', verified_at = now() where id = r.applicant_id;
  perform public.write_log('verify', 'Approved verification', ap.name, ap.id, n || ' of ' || need || ' volunteer approvals');
  if em is not null then
    perform public.send_email(em, 'You are verified on Bridges.directory',
      '<p>Your certificate was checked and you are now listed on Bridges.directory.</p><p>https://bridges.directory</p>');
  end if;
end $$;

create or replace function public.admin_ask_clearer_file(p_request uuid, p_msg text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('verify'); r public.verification_requests; ap public.profiles; em text; msg text := left(btrim(coalesce(p_msg, '')), 500);
begin
  select * into r from public.verification_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'not_pending'; end if;
  if msg = '' then msg := 'The file you sent is hard to read. Could you upload a clearer scan or photo?'; end if;
  select * into ap from public.profiles where id = r.applicant_id;
  select lower(email) into em from auth.users where id = r.applicant_id;
  update public.verification_requests set asked_at = now(), asked_msg = msg where id = p_request;
  perform public.write_log('verify', 'Asked for a new file', ap.name, ap.id, null);
  if em is not null then
    perform public.send_email(em, 'Please send a clearer file to Bridges.directory', '<p>' || public.esc_html(msg) || '</p><p>https://bridges.directory</p>');
  end if;
end $$;

-- ================================================================ reports
create or replace function public.admin_list_reports(p_status text default 'open')
returns table (report_id uuid, target_id uuid, target_name text, target_exists boolean, institute_id text, campus text, reason text, reason_label text,
               note text, reporter_name text, status text, created_at timestamptz, resolution text, resolved_by_name text, resolved_at timestamptz,
               target_listed boolean, target_status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('reports');
  return query
    select r.id, r.target_id, coalesce(p.name, r.target_name, 'Deleted profile'), p.id is not null, p.institute_id, p.campus, r.reason,
           public.report_reason_label(r.reason), r.note, coalesce(r.reporter_name, 'A member'), r.status, r.created_at, r.resolution,
           (select coalesce(rp.name, ru.email) from auth.users ru left join public.profiles rp on rp.id = ru.id where ru.id = r.resolved_by),
           r.resolved_at, p.listed, p.status
    from public.reports r left join public.profiles p on p.id = r.target_id
    where r.status = p_status order by r.created_at desc;
end $$;

create or replace function public.admin_close_report(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid; rp public.reports; tp public.profiles; res text; nt text := nullif(btrim(coalesce(p_note, '')), ''); st text; lbl text;
begin
  if p_action not in ('hide','suspend','resolve','dismiss') then raise exception 'bad_action'; end if;
  me := public.need_perm(case when p_action in ('hide','suspend') then 'suspend' else 'reports' end);
  select * into rp from public.reports where id = p_id and status = 'open' for update;
  if not found then raise exception 'not_open'; end if;
  select * into tp from public.profiles where id = rp.target_id;
  lbl := public.report_reason_label(rp.reason);
  if p_action = 'hide' then
    if found then update public.profiles set listed = false where id = tp.id; end if;
    res := 'Hid the listing.'; st := 'resolved';
    perform public.write_log('admin', 'Hid a listing', coalesce(tp.name, rp.target_name), tp.id, 'Report: ' || lbl);
  elsif p_action = 'suspend' then
    if found then
      update public.profiles set status = 'suspended' where id = tp.id;
      update auth.users set banned_until = '3000-01-01'::timestamptz where id = tp.id;
      delete from auth.sessions where user_id = tp.id;
    end if;
    res := 'Suspended the account.'; st := 'resolved';
    perform public.write_log('admin', 'Suspended a member', coalesce(tp.name, rp.target_name), tp.id, 'Report: ' || lbl);
  elsif p_action = 'resolve' then res := 'Handled it.'; st := 'resolved';
  else res := 'Nothing wrong found.'; st := 'dismissed';
  end if;
  update public.reports set status = st, resolution = res || coalesce(' ' || nt, ''), resolved_by = me, resolved_at = now(),
         target_name = coalesce(target_name, tp.name) where id = p_id;
  perform public.write_log('report', case st when 'dismissed' then 'Dismissed a report' else 'Resolved a report' end,
    coalesce(tp.name, rp.target_name), tp.id, lbl || ' · ' || res);
end $$;

-- ================================================================ activity log screen
create or replace function public.admin_list_log(p_range text default 'all', p_type text default 'all', p_q text default '', p_before bigint default null, p_limit int default 60)
returns setof public.admin_log
language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := case p_range when '24h' then now() - interval '24 hours' when '7d' then now() - interval '7 days'
                                   when '30d' then now() - interval '30 days' else '-infinity' end;
        q text := '%' || lower(btrim(coalesce(p_q, ''))) || '%';
begin
  perform public.need_perm('logs');
  return query
    select * from public.admin_log l
    where l.at >= since and (p_type = 'all' or l.type = p_type) and (p_before is null or l.id < p_before)
      and (btrim(coalesce(p_q, '')) = '' or lower(l.who || ' ' || l.act || ' ' || coalesce(l.target, '') || ' ' || coalesce(l.detail, '') || ' ' || l.role) like q)
    order by l.id desc limit least(greatest(p_limit, 1), 500);
end $$;

create or replace function public.admin_export_log(p_range text default 'all', p_type text default 'all', p_q text default '')
returns setof public.admin_log
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public.need_perm('export');
  perform public.need_perm('logs');
  select count(*) into n from public.admin_list_log(p_range, p_type, p_q, null, 500);
  perform public.write_log('admin', 'Exported the activity log', null, null, n || ' rows');
  return query select * from public.admin_list_log(p_range, p_type, p_q, null, 500);
end $$;

-- ================================================================ page text
create table if not exists public.content_overrides (
  page_id    text not null,
  field_key  text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (page_id, field_key)
);
create table if not exists public.content_history (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  by_name text not null,
  page_id text not null,
  n       int not null
);

create or replace function public.content_html_ok(t text) returns boolean
language sql immutable set search_path = '' as $$
  select position('<' in rest) = 0 and position('>' in rest) = 0
  from (select regexp_replace(regexp_replace(t, '</?(h3|p|ul|li|b)>', '', 'gi'),
                              '<a href="(https?://|mailto:|/|#)[^"<>]*">|</a>', '', 'gi') as rest) x;
$$;

create or replace function public.get_content() returns table (page_id text, field_key text, value text)
language sql stable security definer set search_path = '' as $$
  select page_id, field_key, value from public.content_overrides;
$$;

create or replace function public.admin_publish_content(p_page text, p_changes jsonb, p_labels text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('content'); k text; v jsonb; n int := 0; nm text;
begin
  if p_page !~ '^[a-z0-9-]{1,40}$' then raise exception 'bad_page'; end if;
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'bad_changes'; end if;
  for k, v in select * from jsonb_each(p_changes) loop
    if k !~ '^[a-z0-9_]{1,40}$' then raise exception 'bad_field'; end if;
    if jsonb_typeof(v) = 'null' then
      delete from public.content_overrides where page_id = p_page and field_key = k;
    else
      if char_length(v #>> '{}') > 20000 then raise exception 'too_long'; end if;
      if k = 'body' and not public.content_html_ok(v #>> '{}') then raise exception 'bad_html'; end if;
      insert into public.content_overrides (page_id, field_key, value, updated_by) values (p_page, k, v #>> '{}', me)
      on conflict (page_id, field_key) do update set value = excluded.value, updated_at = now(), updated_by = me;
    end if;
    n := n + 1;
  end loop;
  if n = 0 then return; end if;
  select coalesce(p.name, u.email) into nm from auth.users u left join public.profiles p on p.id = u.id where u.id = me;
  insert into public.content_history (by_name, page_id, n) values (coalesce(nm, 'Admin'), p_page, n);
  perform public.write_log('admin', 'Published text changes', p_page, null, left(p_labels, 300));
end $$;

create or replace function public.admin_content_history(p_page text) returns setof public.content_history
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('content');
  return query select * from public.content_history where page_id = p_page order by at desc limit 5;
end $$;

-- ================================================================ team, roles, permissions
create or replace function public.admin_list_team()
returns table (user_id uuid, name text, email text, role text, last_signin timestamptz, invited boolean, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query
    select a.user_id, coalesce(p.name, lower(u.email)), lower(u.email), a.role, u.last_sign_in_at, false, a.user_id = auth.uid()
    from public.admins a join auth.users u on u.id = a.user_id left join public.profiles p on p.id = a.user_id
    union all
    select null::uuid, i.name, i.email, i.role, null::timestamptz, true, false from public.admin_invites i
    order by 4, 2;
end $$;

create or replace function public.admin_get_perms() returns table (role text, perm text, allowed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  return query select x.role, x.perm, x.allowed from public.admin_perms x;
end $$;

create or replace function public.admin_my_role() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r text;
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  select role into r from public.admins where user_id = auth.uid();
  return jsonb_build_object('role', r, 'perms',
    (select coalesce(jsonb_object_agg(x.perm, x.allowed or r = 'Owner'), '{}'::jsonb) from public.admin_perms x where x.role = r));
end $$;

create or replace function public.admin_invite_teammate(p_name text, p_email text, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('team'); em text := lower(btrim(coalesce(p_email, ''))); nm text := btrim(coalesce(p_name, ''));
begin
  if nm = '' then raise exception 'name_required'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if p_role not in ('Admin','Moderator','Support') then raise exception 'bad_role'; end if;
  if exists (select 1 from auth.users u join public.admins a on a.user_id = u.id where lower(u.email) = em) then raise exception 'already_on_team'; end if;
  insert into public.admin_invites (email, name, role, invited_by) values (em, nm, p_role, me)
  on conflict (email) do update set name = excluded.name, role = excluded.role, invited_by = me, created_at = now();
  perform public.write_log('admin', 'Invited a teammate', nm, null, p_role);
  perform public.send_email(em, 'You have been added to the Bridges.directory team',
    '<p>You were invited to the Bridges.directory admin as <b>' || p_role || '</b>.</p><p>Sign in with this Google account at https://bridges.directory, then open https://bridges.directory/admin.html</p>');
end $$;

-- the admin page calls this after sign-in: an invited person becomes a teammate
create or replace function public.claim_admin_invite() returns text
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); em text := lower(coalesce(auth.jwt() ->> 'email', '')); i public.admin_invites;
begin
  if public.is_admin() then return null; end if;
  select * into i from public.admin_invites where email = em;
  if not found then return null; end if;
  insert into public.admins (user_id, role) values (u, i.role) on conflict (user_id) do nothing;
  delete from public.admin_invites where email = em;
  perform public.write_log('admin', 'Accepted a team invite', i.name, u, i.role, null, u);
  return i.role;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('team'); a public.admins; nm text;
begin
  if p_role not in ('Admin','Moderator','Support') then raise exception 'bad_role'; end if;
  select * into a from public.admins where user_id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if a.role = 'Owner' then raise exception 'owner_locked'; end if;
  update public.admins set role = p_role where user_id = p_user;
  select coalesce(p.name, u.email) into nm from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;
  perform public.write_log('admin', 'Changed a role', nm, p_user, a.role || ' → ' || p_role);
end $$;

create or replace function public.admin_remove_teammate(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('team'); a public.admins; nm text;
begin
  select * into a from public.admins where user_id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if a.role = 'Owner' then raise exception 'owner_locked'; end if;
  if p_user = me then raise exception 'not_yourself'; end if;
  select coalesce(p.name, u.email) into nm from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;
  delete from public.admins where user_id = p_user;
  perform public.write_log('admin', 'Removed a teammate', nm, p_user, a.role);
end $$;

create or replace function public.admin_cancel_invite(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('team'); i public.admin_invites;
begin
  delete from public.admin_invites where email = lower(btrim(p_email)) returning * into i;
  if found then perform public.write_log('admin', 'Cancelled an invite', i.name, null, i.role); end if;
end $$;

create or replace function public.admin_set_perm(p_role text, p_perm text, p_allowed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('team');
begin
  if p_role not in ('Admin','Moderator','Support') then raise exception 'owner_locked'; end if;
  if p_perm not in ('logs','edit','suspend','delete','verify','reports','faculty','content','export','settings','team') then raise exception 'bad_perm'; end if;
  update public.admin_perms set allowed = p_allowed where role = p_role and perm = p_perm;
  perform public.write_log('admin', 'Changed permissions', p_role, null,
    case when p_allowed then 'Can now: ' else 'Can no longer: ' end ||
    case p_perm when 'logs' then 'see the activity log' when 'edit' then 'edit profiles' when 'suspend' then 'hide and suspend members'
                when 'delete' then 'delete profiles' when 'verify' then 'review verification' when 'reports' then 'handle reports'
                when 'faculty' then 'manage faculty accounts' when 'content' then 'edit page text' when 'export' then 'export data'
                when 'settings' then 'change settings' else 'manage the team' end);
end $$;

-- ================================================================ settings
create or replace function public.admin_get_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('settings');
  return jsonb_build_object(
    'limit', public.cfg('weekly_contacts')::int,
    'approvals', public.cfg('approvals_needed')::int,
    'signups', coalesce(public.cfg('signups_open'), 'true') <> 'false',
    'pause_msg', coalesce(public.cfg('signups_pause_msg'), ''),
    'banner_on', coalesce(public.cfg('banner_on'), 'false') = 'true',
    'banner_msg', coalesce(public.cfg('banner_msg'), ''),
    'goal', (public.cfg('yearly_target_paise')::bigint / 100),
    'domains', (select jsonb_object_agg(id, codes_enabled) from public.institutes));
end $$;

create or replace function public.admin_save_settings(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('settings'); ch text[] := '{}'; cur jsonb := public.admin_get_settings(); k text; v boolean;
begin
  if p ? 'limit' then
    if (p->>'limit')::int < 1 or (p->>'limit')::int > 30 then raise exception 'bad_limit'; end if;
    if (p->>'limit')::int <> (cur->>'limit')::int then ch := array_append(ch, 'Contacts per week'); update public.settings set value = (p->>'limit')::int::text where key = 'weekly_contacts'; end if;
  end if;
  if p ? 'approvals' then
    if (p->>'approvals')::int not in (1,2,3) then raise exception 'bad_approvals'; end if;
    if (p->>'approvals')::int <> (cur->>'approvals')::int then ch := array_append(ch, 'Volunteer approvals'); update public.settings set value = (p->>'approvals')::int::text where key = 'approvals_needed'; end if;
  end if;
  if p ? 'signups' and (p->>'signups')::boolean <> (cur->>'signups')::boolean then
    ch := array_append(ch, 'Sign-ups'); update public.settings set value = (p->>'signups')::boolean::text where key = 'signups_open';
  end if;
  if p ? 'pause_msg' and p->>'pause_msg' is distinct from cur->>'pause_msg' then
    ch := array_append(ch, 'Pause message'); update public.settings set value = left(p->>'pause_msg', 300) where key = 'signups_pause_msg';
  end if;
  if p ? 'banner_on' and (p->>'banner_on')::boolean <> (cur->>'banner_on')::boolean then
    ch := array_append(ch, 'Site notice'); update public.settings set value = (p->>'banner_on')::boolean::text where key = 'banner_on';
  end if;
  if p ? 'banner_msg' and p->>'banner_msg' is distinct from cur->>'banner_msg' then
    ch := array_append(ch, 'Notice text'); update public.settings set value = left(p->>'banner_msg', 300) where key = 'banner_msg';
  end if;
  if p ? 'goal' then
    if (p->>'goal')::bigint < 0 or (p->>'goal')::bigint > 100000000 then raise exception 'bad_goal'; end if;
    if (p->>'goal')::bigint <> (cur->>'goal')::bigint then ch := array_append(ch, 'Contribution goal'); update public.settings set value = ((p->>'goal')::bigint * 100)::text where key = 'yearly_target_paise'; end if;
  end if;
  if p ? 'domains' then
    for k, v in select key, value::boolean from jsonb_each_text(p->'domains') loop
      update public.institutes set codes_enabled = v where id = k and codes_enabled is distinct from v;
      if found and not 'Institute emails' = any(ch) then ch := array_append(ch, 'Institute emails'); end if;
    end loop;
  end if;
  if array_length(ch, 1) > 0 then perform public.write_log('admin', 'Changed settings', null, null, array_to_string(ch, ', ')); end if;
end $$;

-- ================================================================ overview
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare wk timestamptz := now() - interval '7 days'; d3 timestamptz := now() - interval '3 days'; j jsonb;
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  select jsonb_build_object(
    'members', (select count(*) from public.profiles where kind in ('student','alum')),
    'students', (select count(*) from public.profiles where kind = 'student'),
    'alums', (select count(*) from public.profiles where kind = 'alum'),
    'new_week', (select count(*) from public.profiles where kind in ('student','alum') and created_at >= wk),
    'faculty', (select count(*) from public.faculty_accounts),
    'verify_pending', (select count(*) from public.verification_requests where status = 'pending'),
    'verify_oldest', (select min(created_at) from public.verification_requests where status = 'pending'),
    'verify_old_count', (select count(*) from public.verification_requests where status = 'pending' and created_at < now() - interval '2 days'),
    'reports_open', (select count(*) from public.reports where status = 'open'),
    'reports_newest', (select max(created_at) from public.reports where status = 'open'),
    'signins_week', (select count(*) from public.admin_log where type = 'auth' and act like 'Signed in%' and at >= wk),
    'contacts_week', (select count(*) from public.admin_log where act = 'Opened a contact' and at >= wk),
    'limit', public.cfg('weekly_contacts')::int,
    'faculty_failed', (select count(*) from public.admin_log where act = 'Faculty sign-in failed' and at >= d3),
    'faculty_never', (select coalesce(jsonb_agg(p.name), '[]'::jsonb) from public.faculty_accounts f join public.profiles p on p.id = f.user_id where f.status = 'active' and f.last_signin is null),
    'suspended', (select count(*) from public.profiles where status = 'suspended' and kind in ('student','alum')),
    'vol_pending', (select count(*) from public.volunteer_applications where status = 'pending'),
    'by_group', (select coalesce(jsonb_agg(jsonb_build_object('grp', g.grp, 'students', g.s, 'alums', g.a)), '[]'::jsonb)
                 from (select i.grp, count(*) filter (where p.kind = 'student') s, count(*) filter (where p.kind = 'alum') a
                       from public.institutes i left join public.profiles p on p.institute_id = i.id and p.kind in ('student','alum') group by i.grp) g)
  ) into j;
  if public.admin_can('logs') then
    j := j || jsonb_build_object('recent', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                                          from (select * from public.admin_log order by id desc limit 8) l));
  else
    j := j || jsonb_build_object('recent', '[]'::jsonb);
  end if;
  return j;
end $$;

-- ================================================================ volunteer screens now write to the log
create or replace function public.admin_review_application(p_application uuid, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.volunteer_applications; nm text;
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
  select name into nm from public.profiles where id = a.user_id;
  perform public.write_log('admin', case p_decision when 'approve' then 'Approved a volunteer' else 'Rejected a volunteer application' end, nm, a.user_id, null);
end $$;

create or replace function public.admin_remove_volunteer(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare nm text;
begin
  if not public.is_admin() then raise exception 'admins_only'; end if;
  update public.profiles set is_volunteer = false where id = p_user and is_volunteer;
  if not found then raise exception 'not_a_volunteer'; end if;
  update public.volunteer_applications set status = 'removed', reviewed_by = auth.uid(), reviewed_at = now() where user_id = p_user;
  update public.profile_private set vol_phone = null where id = p_user;
  select name into nm from public.profiles where id = p_user;
  perform public.write_log('admin', 'Removed a volunteer', nm, p_user, null);
end $$;

-- ================================================================ locks and grants
alter table public.admin_perms enable row level security;
alter table public.admin_invites enable row level security;
alter table public.admin_log enable row level security;
alter table public.faculty_accounts enable row level security;
alter table public.retired_fids enable row level security;
alter table public.blocked_accounts enable row level security;
alter table public.content_overrides enable row level security;
alter table public.content_history enable row level security;
revoke all on public.admin_perms, public.admin_invites, public.admin_log, public.faculty_accounts, public.retired_fids,
              public.blocked_accounts, public.content_overrides, public.content_history from anon, authenticated;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'admin\_%' or p.proname like 'trg\_%' or p.proname in (
             'need_perm','write_log','log_signin','log_signout','log_faculty_failed','random_password','esc_html','content_html_ok',
             'report_reason_label','public_settings','get_content','claim_admin_invite','contacts_left','reveal_contact'))
  loop execute format('revoke all on function %s from public, anon, authenticated', f.sig); end loop;
end $$;
grant execute on function
  public.public_settings(), public.get_content(), public.log_faculty_failed(text)
to anon, authenticated;
grant execute on function
  public.log_signin(boolean), public.log_signout(), public.claim_admin_invite(), public.contacts_left(), public.reveal_contact(uuid),
  public.admin_list_applications(text), public.admin_review_application(uuid, text), public.admin_list_volunteers(),
  public.admin_remove_volunteer(uuid), public.admin_list_contributions(int, int),
  public.admin_can(text), public.admin_my_role(), public.admin_overview(),
  public.admin_list_members(), public.admin_update_member(uuid, jsonb), public.admin_delete_member(uuid, text, boolean),
  public.admin_export_members(), public.admin_member_log(uuid, int),
  public.admin_list_faculty(), public.admin_create_faculty(text, text, text, text, text, text),
  public.admin_update_faculty(uuid, text, text, text, text, text, text, boolean), public.admin_reset_faculty_password(uuid), public.admin_delete_faculty(uuid),
  public.admin_list_verification(text), public.admin_get_certificate(uuid), public.admin_decide_verification(uuid, text, text, text), public.admin_ask_clearer_file(uuid, text),
  public.admin_list_reports(text), public.admin_close_report(uuid, text, text),
  public.admin_list_log(text, text, text, bigint, int), public.admin_export_log(text, text, text),
  public.admin_publish_content(text, jsonb, text), public.admin_content_history(text),
  public.admin_list_team(), public.admin_get_perms(), public.admin_invite_teammate(text, text, text), public.admin_set_role(uuid, text),
  public.admin_remove_teammate(uuid), public.admin_cancel_invite(text), public.admin_set_perm(text, text, boolean),
  public.admin_get_settings(), public.admin_save_settings(jsonb)
to authenticated;
