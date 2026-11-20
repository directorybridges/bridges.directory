-- Fields students work in, alumni email verification, and admin-managed email domains.
-- Follows Atharva's 21 Nov designs (main portal and admin Settings).
--  1. profiles.fields: students pick up to 3 of 9 fields (alums' fields come from their experience).
--  2. institute_domains: extra student domains and alumni-email domains per institute, managed by the admin.
--  3. Alumni email: a 6-digit code to an alumni address (only for institutes on the admin's list, and only for batches that got one).
--  4. admin_* functions to read, add, switch and remove domains (a "new institute" is created on the spot).

-- ---------------------------------------------------------------- fields
alter table public.profiles add column if not exists fields int[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_fields_ok;
alter table public.profiles add constraint profiles_fields_ok check (cardinality(fields) <= 3 and fields <@ array[0,1,2,3,4,5,6,7,8]);
grant update (fields) on public.profiles to authenticated;

create or replace function public.create_my_profile(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); inst public.institutes; k text := p->>'kind'; c text := coalesce(p->>'campus','');
        f int[] := coalesce(array(select distinct x.v from (select jsonb_array_elements_text(coalesce(p->'fields','[]'::jsonb))::int as v) x order by x.v), '{}');
begin
  if exists (select 1 from public.profiles where id = u) then raise exception 'profile_exists'; end if;
  if k not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into inst from public.institutes where id = p->>'institute_id';
  if not found then raise exception 'bad_institute'; end if;
  if c <> '' and not (c = any (inst.campuses)) then raise exception 'bad_campus'; end if;
  if k = 'alum' then f := '{}'; end if;                                   -- alums' fields come from their experience
  if cardinality(f) > 3 or not (f <@ array[0,1,2,3,4,5,6,7,8]) then raise exception 'bad_fields'; end if;
  insert into public.profiles (id, kind, name, institute_id, campus, branch, year, helps, avatar, experiences, fields)
  values (u, k, btrim(p->>'name'), inst.id, c, coalesce(p->>'branch',''), nullif(p->>'year','')::int,
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'helps','[]'::jsonb))::int), '{}'),
          coalesce(p->'avatar','{}'::jsonb), coalesce(p->'experiences','[]'::jsonb), f);
  insert into public.profile_private (id, email_personal, links)
  values (u, nullif(btrim(coalesce(p->>'email_personal','')),''), coalesce(p->'links','[]'::jsonb));
  return u;
end $$;

-- ---------------------------------------------------------------- domains
create table if not exists public.institute_domains (
  id           uuid primary key default gen_random_uuid(),
  institute_id text not null references public.institutes(id) on delete cascade,
  kind         text not null check (kind in ('student','alumni')),
  domain       text not null check (domain = lower(domain) and char_length(domain) between 4 and 80),
  first_batch  int not null default 0,                                     -- alumni only: the first graduating batch that got an alumni email (0 = all)
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (domain)
);
alter table public.institute_domains enable row level security;
revoke all on public.institute_domains from anon, authenticated;

-- Atharva's starting list. NOT yet confirmed with the institutes: the client sends the real ones; the admin can switch, add or remove any.
insert into public.institute_domains (institute_id, kind, domain, first_batch)
select v.i, 'alumni', v.d, v.b from (values
  ('nift','alumni.nift.ac.in',2026), ('iitb','alumni.iitb.ac.in',0), ('iitd','alumni.iitd.ac.in',0), ('iitg','alumni.iitg.ac.in',0),
  ('iith','alumni.iith.ac.in',0), ('iiti','alumni.iiti.ac.in',0), ('iitj','alumni.iitj.ac.in',0), ('iitk','alumni.iitk.ac.in',0), ('iitr','alumni.iitr.ac.in',0)
) as v(i,d,b) where exists (select 1 from public.institutes x where x.id = v.i)
on conflict (domain) do nothing;

create or replace function public.student_domain_ok(p_inst text, p_domain text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (exists (select 1 from public.institutes i where i.id = p_inst and i.email_domain <> '' and (p_domain = i.email_domain or p_domain like '%.' || i.email_domain))
      or exists (select 1 from public.institute_domains d where d.institute_id = p_inst and d.kind = 'student' and d.enabled and (p_domain = d.domain or p_domain like '%.' || d.domain)))
     -- an alumni address is never a student address, even where it sits under the institute's own domain
     and not exists (select 1 from public.institute_domains a where a.kind = 'alumni' and (p_domain = a.domain or p_domain like '%.' || a.domain));
$$;

-- the site reads these (no secrets in them): extra student domains, alumni domains, and any institute the admin added
create or replace function public.extra_domains() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'student', coalesce((select jsonb_agg(jsonb_build_object('inst', institute_id, 'd', domain)) from public.institute_domains where kind = 'student' and enabled), '[]'::jsonb),
    'alumni',  coalesce((select jsonb_agg(jsonb_build_object('inst', institute_id, 'd', domain, 'from', first_batch)) from public.institute_domains where kind = 'alumni' and enabled), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------- student code: also accept admin-added student domains
alter table public.email_verifications add column if not exists purpose text not null default 'student' check (purpose in ('student','alumni'));

create or replace function public.request_email_code(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; code text; em text := lower(btrim(p_email));
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'student' then raise exception 'students_only'; end if;
  if me.verified then raise exception 'already_verified'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or not public.student_domain_ok(me.institute_id, split_part(em, '@', 2)) then
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

-- same rule for the extra-institute code
create or replace function public.request_link_code(p_link uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); l public.profile_institutes; code text; em text := lower(btrim(p_email));
begin
  select * into l from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
  if l.verified then raise exception 'already_verified'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or not public.student_domain_ok(l.institute_id, split_part(em, '@', 2)) then
    raise exception 'email_domain_mismatch';
  end if;
  if (select count(*) from public.email_verifications where user_id = u and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many_requests';
  end if;
  code := public.new_code(6, true);
  insert into public.email_verifications (user_id, email, code_hash, link_id) values (u, em, public.hash_code(code), p_link);
  perform public.send_email(em, 'Your Bridges.directory code',
    '<p>Your code is <b style="font-size:20px;letter-spacing:3px">' || code || '</b></p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>');
end $$;

-- "email codes off" for an institute only stops STUDENT codes; alumni codes have their own switch (the alumni domain list)
create or replace function public.trg_codes_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purpose = 'student' and exists (select 1 from public.institutes i
             where i.id = (case when new.link_id is not null then (select l.institute_id from public.profile_institutes l where l.id = new.link_id)
                                else (select p.institute_id from public.profiles p where p.id = new.user_id) end)
               and not i.codes_enabled) then
    raise exception 'codes_off';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- alumni email code
alter table public.profile_private add column if not exists email_alumni text;
alter table public.profiles drop constraint if exists profiles_verify_method_check;
alter table public.profiles add constraint profiles_verify_method_check check (verify_method in ('institute_email','certificate','referral','alumni_email'));

create or replace function public.request_alumni_code(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; d public.institute_domains; code text; em text := lower(btrim(p_email)); dom text;
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'alum' then raise exception 'alums_only'; end if;
  if me.verified then raise exception 'already_verified'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  dom := split_part(em, '@', 2);
  select * into d from public.institute_domains x
   where x.kind = 'alumni' and x.enabled and x.institute_id = me.institute_id and (dom = x.domain or dom like '%.' || x.domain) limit 1;
  if not found then raise exception 'alumni_domain_mismatch'; end if;
  if d.first_batch > 0 and coalesce(me.year, 0) < d.first_batch then raise exception 'alumni_batch_too_early'; end if;
  if exists (select 1 from public.profile_private pp where lower(pp.email_alumni) = em and pp.id <> u) then raise exception 'alumni_email_taken'; end if;
  if (select count(*) from public.email_verifications where user_id = u and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many_requests';
  end if;
  code := public.new_code(6, true);
  insert into public.email_verifications (user_id, email, code_hash, purpose) values (u, em, public.hash_code(code), 'alumni');
  perform public.send_email(em, 'Your Bridges.directory code',
    '<p>Your code is <b style="font-size:20px;letter-spacing:3px">' || code || '</b></p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>');
end $$;

create or replace function public.confirm_email_code(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); v public.email_verifications;
begin
  select * into v from public.email_verifications
   where user_id = u and link_id is null and not used and expires_at > now() order by created_at desc limit 1;
  if not found then raise exception 'no_active_code'; end if;
  if v.attempts >= 5 then raise exception 'too_many_attempts'; end if;
  if v.code_hash <> public.hash_code(btrim(p_code)) then
    update public.email_verifications set attempts = attempts + 1 where id = v.id;
    return false;
  end if;
  update public.email_verifications set used = true where id = v.id;
  if v.purpose = 'alumni' then
    update public.profiles set verified = true, listed = true, verify_method = 'alumni_email', verified_at = now() where id = u;
    update public.profile_private set email_alumni = v.email where id = u;
  else
    update public.profiles set verified = true, listed = true, verify_method = 'institute_email', verified_at = now() where id = u;
    update public.profile_private set email_institute = v.email where id = u;
  end if;
  return true;
end $$;

create or replace function public.trg_log_verified() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.verified and not old.verified and new.kind <> 'faculty' then
    perform public.write_log('signup', 'Got verified', null, null,
      case new.verify_method when 'institute_email' then 'Institute email code' when 'alumni_email' then 'Alumni email code' when 'certificate' then 'Certificate' when 'referral' then 'Referral code' else 'Admin' end,
      null, new.id);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- admin: list, add, switch, remove
create or replace function public.admin_domains() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('settings');
  return jsonb_build_object(
    'student', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'inst', d.institute_id, 'name', i.name, 'short', i.short, 'd', d.domain, 'on', d.enabled, 'new', i.grp = 'other') order by d.created_at)
                         from public.institute_domains d join public.institutes i on i.id = d.institute_id where d.kind = 'student'), '[]'::jsonb),
    'alumni',  coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'inst', d.institute_id, 'name', i.name, 'short', i.short, 'd', d.domain, 'from', d.first_batch, 'on', d.enabled, 'new', i.grp = 'other') order by d.created_at)
                         from public.institute_domains d join public.institutes i on i.id = d.institute_id where d.kind = 'alumni'), '[]'::jsonb));
end $$;

-- p_institute = an institute id, or 'new' with p_name to add a new institute (members can then sign up to it; its branches are typed by members until the team adds a list)
create or replace function public.admin_add_domain(p_kind text, p_institute text, p_name text, p_domain text, p_first int default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('settings'); dom text := lower(btrim(p_domain)); inst public.institutes; nm text := btrim(coalesce(p_name, '')); slug text; n int := 1; id_ text;
begin
  if p_kind not in ('student','alumni') then raise exception 'bad_kind'; end if;
  dom := regexp_replace(regexp_replace(dom, '^.*@', ''), '^https?://', ''); dom := regexp_replace(dom, '/.*$', '');
  if dom !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' or char_length(dom) > 80 then raise exception 'bad_domain'; end if;
  if dom ~ '^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton|protonmail|rediffmail)\.' then raise exception 'personal_domain'; end if;
  if exists (select 1 from public.institute_domains where domain = dom) or exists (select 1 from public.institutes where email_domain = dom) then
    raise exception 'domain_exists';       -- students and alumni need different domains, or students could verify as alumni
  end if;
  if p_kind = 'alumni' and (coalesce(p_first, 0) <> 0 and (p_first < 1950 or p_first > extract(year from now())::int + 1)) then raise exception 'bad_batch'; end if;
  if p_institute = 'new' then
    if nm = '' or char_length(nm) > 60 then raise exception 'bad_name'; end if;
    if exists (select 1 from public.institutes where lower(name) = lower(nm) or lower(short) = lower(nm)) then raise exception 'institute_exists'; end if;
    slug := left(regexp_replace(lower(nm), '[^a-z0-9]+', '', 'g'), 12); if slug = '' then slug := 'inst'; end if;
    id_ := slug; while exists (select 1 from public.institutes where id = id_) loop n := n + 1; id_ := slug || n; end loop;
    insert into public.institutes (id, short, name, grp, email_domain, campuses, branches)
    values (id_, nm, nm, 'other', case when p_kind = 'student' then dom else '' end, '{}', array['Design']);
    p_institute := id_;
  else
    select * into inst from public.institutes where id = p_institute;
    if not found then raise exception 'bad_institute'; end if;
  end if;
  insert into public.institute_domains (institute_id, kind, domain, first_batch) values (p_institute, p_kind, dom, case when p_kind = 'alumni' then coalesce(p_first, 0) else 0 end);
  perform public.write_log('admin', case when p_kind = 'student' then 'Added institute email domain' else 'Added alumni email domain' end, '@' || dom, null,
    case when nm <> '' then 'New institute: ' || nm else p_institute end);
  return jsonb_build_object('institute_id', p_institute);
end $$;

create or replace function public.admin_set_domain(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('settings'); d public.institute_domains;
begin
  update public.institute_domains set enabled = p_on where id = p_id returning * into d;
  if not found then raise exception 'not_found'; end if;
  perform public.write_log('admin', case when p_on then 'Switched a domain on' else 'Switched a domain off' end, '@' || d.domain, null, d.kind || ' · ' || d.institute_id);
end $$;

create or replace function public.admin_remove_domain(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('settings'); d public.institute_domains;
begin
  delete from public.institute_domains where id = p_id returning * into d;
  if not found then raise exception 'not_found'; end if;
  perform public.write_log('admin', 'Removed a domain', '@' || d.domain, null, d.kind || ' · ' || d.institute_id);
end $$;

-- ---------------------------------------------------------------- who may call what
revoke all on function public.student_domain_ok(text, text), public.extra_domains(), public.request_alumni_code(text),
  public.admin_domains(), public.admin_add_domain(text, text, text, text, int), public.admin_set_domain(uuid, boolean), public.admin_remove_domain(uuid)
  from public, anon, authenticated;
grant execute on function public.extra_domains() to anon, authenticated;
grant execute on function public.request_alumni_code(text) to authenticated;
grant execute on function public.admin_domains(), public.admin_add_domain(text, text, text, text, int), public.admin_set_domain(uuid, boolean), public.admin_remove_domain(uuid) to authenticated;
grant execute on function public.request_email_code(text), public.confirm_email_code(text), public.request_link_code(uuid, text), public.create_my_profile(jsonb) to authenticated;
