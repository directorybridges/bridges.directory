-- Members with more than one institute (Aman's Masters / PhD case). Safe to run again.
--
-- A member has one main institute (the one on the profile, as before). Each EXTRA institute is its own
-- row with its own status (student or alum there), its own branch and year, and its own verification.
-- Examples from the client chat:  NIFT alum + NID student,  NIFT alum + NID alum + IIT student (PhD).
--
-- Rules, kept simple and strict:
--  * Only a verified member can add an institute. Up to 5 extra institutes each.
--  * An extra institute is shown in the directory (and counted) ONLY once it is verified, the same three
--    ways as the first one: institute email code, certificate checked by volunteers, or a referral code.
--  * A verified alum of an institute (main or extra) may refer people to THAT institute.
--  * Everything else (contact limit, listing, reports) stays one per person, on the main profile.

create table if not exists public.profile_institutes (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  institute_id  text not null references public.institutes(id),
  campus        text not null default '',
  branch        text not null default '' check (char_length(branch) between 1 and 80),
  year          int,
  kind          text not null check (kind in ('student','alum')),
  verified      boolean not null default false,
  verify_method text check (verify_method in ('institute_email','certificate','referral')),
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (profile_id, institute_id, campus)
);
create index if not exists profile_institutes_dir_idx on public.profile_institutes (institute_id, kind) where verified;
alter table public.profile_institutes enable row level security;
revoke all on public.profile_institutes from anon, authenticated;     -- functions only

alter table public.verification_requests add column if not exists link_id uuid references public.profile_institutes(id) on delete cascade;
alter table public.email_verifications  add column if not exists link_id uuid references public.profile_institutes(id) on delete cascade;

-- a change to a member's extra institutes moves the directory "version", so open sites reload the list
create or replace function public.trg_pi_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pid uuid := coalesce(new.profile_id, old.profile_id);
begin
  update public.profiles set updated_at = clock_timestamp() where id = pid;
  return null;
end $$;
drop trigger if exists profile_institutes_touch on public.profile_institutes;
create trigger profile_institutes_touch after insert or update or delete on public.profile_institutes for each row execute function public.trg_pi_touch();

-- the activity log notes it when an extra institute is verified
create or replace function public.trg_pi_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s text; nm text;
begin
  if new.verified and not old.verified then
    select short into s from public.institutes where id = new.institute_id;
    select name into nm from public.profiles where id = new.profile_id;
    perform public.write_log('verify', 'Verified another institute', nm, new.profile_id,
      initcap(new.kind) || ' · ' || coalesce(s, new.institute_id) || ' · ' || replace(new.verify_method, '_', ' '), null, new.profile_id);
  end if;
  return null;
end $$;
drop trigger if exists profile_institutes_log on public.profile_institutes;
create trigger profile_institutes_log after update of verified on public.profile_institutes for each row execute function public.trg_pi_log();

-- ================================================================ add, remove, list
create or replace function public.add_my_institute(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; inst public.institutes; k text := p->>'kind'; c text := coalesce(p->>'campus','');
        b text := btrim(coalesce(p->>'branch','')); yr int := nullif(p->>'year','')::int; nid uuid;
begin
  select * into me from public.profiles where profiles.id = u;
  if not found or me.kind not in ('student','alum') then raise exception 'no_profile'; end if;
  if not me.verified then raise exception 'verify_first'; end if;
  if k not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into inst from public.institutes where institutes.id = p->>'institute_id';
  if not found then raise exception 'bad_institute'; end if;
  if c <> '' and not (c = any (inst.campuses)) then raise exception 'bad_campus'; end if;
  if b = '' or char_length(b) > 80 then raise exception 'bad_branch'; end if;
  if yr is null or yr < 1950 or yr > 2100 then raise exception 'bad_year'; end if;
  if inst.id = me.institute_id and c = me.campus then raise exception 'already_added'; end if;
  if (select count(*) from public.profile_institutes where profile_id = u) >= 5 then raise exception 'too_many_institutes'; end if;
  begin
    insert into public.profile_institutes (profile_id, institute_id, campus, branch, year, kind) values (u, inst.id, c, b, yr, k) returning profile_institutes.id into nid;
  exception when unique_violation then raise exception 'already_added';
  end;
  return nid;
end $$;

create or replace function public.remove_my_institute(p_link uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  delete from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.my_institutes()
returns table (id uuid, institute_id text, campus text, branch text, year int, kind text, verified boolean, verify_method text, request_status text, request_reason text, requested_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.id, l.institute_id, l.campus, l.branch, l.year, l.kind, l.verified, l.verify_method, r.status, r.reject_reason, r.created_at
  from public.profile_institutes l
  left join lateral (select * from public.verification_requests v where v.link_id = l.id order by v.created_at desc limit 1) r on true
  where l.profile_id = auth.uid()
  order by l.created_at;
$$;

-- verified extra institutes of everyone the directory lists (the site merges them onto each person)
create or replace function public.directory_institutes()
returns table (profile_id uuid, institute_id text, campus text, branch text, year int, kind text)
language sql stable security definer set search_path = '' as $$
  select l.profile_id, l.institute_id, l.campus, l.branch, l.year, l.kind
  from public.profile_institutes l join public.profiles p on p.id = l.profile_id
  where auth.uid() is not null and l.verified and p.listed and p.verified and p.status = 'active';
$$;

-- people per institute: main institute and verified extra ones both count
create or replace function public.institute_counts()
returns table (institute_id text, alums bigint, students bigint)
language sql stable security definer set search_path = '' as $$
  select i.id, count(*) filter (where x.kind = 'alum'), count(*) filter (where x.kind = 'student')
  from public.institutes i
  left join (
    select p.institute_id as iid, p.kind from public.profiles p where p.listed and p.verified and p.status = 'active'
    union all
    select l.institute_id, l.kind from public.profile_institutes l join public.profiles p on p.id = l.profile_id
     where l.verified and p.listed and p.verified and p.status = 'active'
  ) x on x.iid = i.id
  where auth.uid() is not null
  group by i.id;
$$;

-- ================================================================ verify an extra institute: institute email
create or replace function public.trg_codes_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.institutes i
             where i.id = (case when new.link_id is not null then (select l.institute_id from public.profile_institutes l where l.id = new.link_id)
                                else (select p.institute_id from public.profiles p where p.id = new.user_id) end)
               and not i.codes_enabled) then
    raise exception 'codes_off';
  end if;
  return new;
end $$;

-- the first-institute code must never be satisfied by a code meant for an extra institute
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
  update public.profiles set verified = true, listed = true, verify_method = 'institute_email', verified_at = now() where id = u;
  update public.profile_private set email_institute = v.email where id = u;
  return true;
end $$;

create or replace function public.request_link_code(p_link uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); l public.profile_institutes; dom text; code text; em text := lower(btrim(p_email));
begin
  select * into l from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
  if l.verified then raise exception 'already_verified'; end if;
  select email_domain into dom from public.institutes where id = l.institute_id;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or not (split_part(em,'@',2) = dom or split_part(em,'@',2) like '%.' || dom) then
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

create or replace function public.confirm_link_code(p_link uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); v public.email_verifications;
begin
  if not exists (select 1 from public.profile_institutes where id = p_link and profile_id = u) then raise exception 'not_found'; end if;
  select * into v from public.email_verifications
   where user_id = u and link_id = p_link and not used and expires_at > now() order by created_at desc limit 1;
  if not found then raise exception 'no_active_code'; end if;
  if v.attempts >= 5 then raise exception 'too_many_attempts'; end if;
  if v.code_hash <> public.hash_code(btrim(p_code)) then
    update public.email_verifications set attempts = attempts + 1 where id = v.id;
    return false;
  end if;
  update public.email_verifications set used = true where id = v.id;
  update public.profile_institutes set verified = true, verify_method = 'institute_email', verified_at = now() where id = p_link;
  return true;
end $$;

-- ================================================================ verify an extra institute: referral code
create or replace function public.redeem_link_referral(p_link uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); l public.profile_institutes; r public.referrals;
begin
  select * into l from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
  if l.verified then raise exception 'already_verified'; end if;
  if (select count(*) from public.referral_attempts where user_id = u and at > now() - interval '1 hour') >= 10 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_attempts (user_id) values (u);
  select * into r from public.referrals
   where code_hash = public.hash_code(public.norm_code(p_code)) and status = 'pending' and expires_at > now() for update;
  if not found or r.institute_id <> l.institute_id then return false; end if;
  if r.referrer_id is not null and l.kind <> 'alum' then raise exception 'alums_only'; end if;
  if r.referrer_id is null and r.kind <> l.kind then return false; end if;
  update public.referrals set status = 'joined', used_by = u where id = r.id;
  update public.profile_institutes set verified = true, verify_method = 'referral', verified_at = now() where id = p_link;
  return true;
end $$;

-- refer someone to an institute where you are a verified ALUM (main or extra). create_referral(text) stays as it was.
create or replace function public.create_referral_for(p_email text, p_institute text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; inst text; code text; em text := lower(btrim(p_email)); days text := public.cfg('referral_days');
begin
  select * into me from public.profiles where id = u;
  if not found or not me.verified then raise exception 'verified_alums_only'; end if;
  inst := coalesce(nullif(btrim(p_institute), ''), me.institute_id);
  if not ((me.kind = 'alum' and inst = me.institute_id)
          or exists (select 1 from public.profile_institutes l where l.profile_id = u and l.institute_id = inst and l.kind = 'alum' and l.verified)) then
    raise exception 'verified_alums_only';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if (select count(*) from public.referrals where referrer_id = u and created_at > now() - interval '1 day') >= 20 then raise exception 'too_many_requests'; end if;
  code := public.new_code(8, false);
  insert into public.referrals (referrer_id, institute_id, invitee_email, code_hash, expires_at)
  values (u, inst, em, public.hash_code(code), now() + (days || ' days')::interval);
  perform public.send_email(em, 'You have been invited to Bridges.directory',
    '<p>' || public.esc_html(split_part(btrim(me.name), ' ', 1)) || ', a verified alum from your institute, vouched for you.</p>'
    || '<p><a href="https://bridges.directory/#join/referral/' || code || '" style="display:inline-block;background:#16150F;color:#ffffff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">Join Bridges.directory</a></p>'
    || '<p>The link opens with your code already filled in. If it does not, your one-time code is <b style="font-size:18px;letter-spacing:3px">' || code || '</b>.</p>'
    || '<p>It expires in ' || days || ' days.</p>');
end $$;

-- ================================================================ verify an extra institute: certificate
-- a request row now says what it is for; this shows the volunteer / admin the institute, kind, branch and year being proved
create or replace function public.vr_profile(r public.verification_requests) returns public.profiles
language sql stable security definer set search_path = '' as $$
  select jsonb_populate_record(null::public.profiles,
           to_jsonb(p) || coalesce(
             (select jsonb_build_object('kind', l.kind, 'institute_id', l.institute_id, 'campus', l.campus, 'branch', l.branch, 'year', l.year)
                from public.profile_institutes l where l.id = r.link_id), '{}'::jsonb))
  from public.profiles p where p.id = r.applicant_id;
$$;

do $$ declare d text; f text; begin
  foreach f in array array['public.volunteer_queue()', 'public.volunteer_queue_details()', 'public.admin_list_verification(text)'] loop
    select pg_get_functiondef(f::regprocedure) into d;
    if d not like '%vr_profile%' then
      if d not like '%join public.profiles p on p.id = r.applicant_id%' then raise exception 'cannot patch %', f; end if;
      execute replace(d, 'join public.profiles p on p.id = r.applicant_id', 'cross join lateral public.vr_profile(r) p');
    end if;
  end loop;
  foreach f in array array['public.review_certificate(uuid,text,text)', 'public.admin_decide_verification(uuid,text,text,text)'] loop
    select pg_get_functiondef(f::regprocedure) into d;
    if d not like '%profile_institutes%' then
      if d not like '%update public.profiles set verified = true, listed = true, verify_method = ''certificate'', verified_at = now() where id = r.applicant_id;%' then raise exception 'cannot patch %', f; end if;
      execute replace(d, 'update public.profiles set verified = true, listed = true, verify_method = ''certificate'', verified_at = now() where id = r.applicant_id;',
        'if r.link_id is not null then update public.profile_institutes set verified = true, verify_method = ''certificate'', verified_at = now() where id = r.link_id; '
        || 'else update public.profiles set verified = true, listed = true, verify_method = ''certificate'', verified_at = now() where id = r.applicant_id; end if;');
    end if;
  end loop;
end $$;

-- "my certificate status" is about the main profile only; extra institutes report through my_institutes()
create or replace function public.my_request_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_build_object('status', r.status, 'reason', r.reject_reason, 'submitted_at', r.created_at), '{}'::jsonb)
  from (select 1) x
  left join lateral (select * from public.verification_requests where applicant_id = auth.uid() and link_id is null order by created_at desc limit 1) r on true;
$$;

create or replace function public.submit_link_certificate(p_link uuid, p_mime text, p_data_base64 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); l public.profile_institutes; rid uuid; bytes bytea;
begin
  select * into l from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
  if l.verified then raise exception 'already_verified'; end if;
  if exists (select 1 from public.verification_requests where applicant_id = u and status = 'pending') then raise exception 'request_pending'; end if;
  bytes := decode(p_data_base64, 'base64');
  if octet_length(bytes) = 0 or octet_length(bytes) > public.cfg('max_certificate_bytes')::int then raise exception 'bad_file_size'; end if;
  insert into public.verification_requests (applicant_id, link_id, delete_after)
  values (u, p_link, now() + (public.cfg('days_if_unreviewed') || ' days')::interval) returning id into rid;
  insert into public.certificate_files (request_id, mime, data) values (rid, p_mime, bytes);
  return rid;
end $$;

create or replace function public.submit_link_certificate_start(p_link uuid, p_mime text, p_bytes int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); l public.profile_institutes; rid uuid;
begin
  select * into l from public.profile_institutes where id = p_link and profile_id = u;
  if not found then raise exception 'not_found'; end if;
  if l.verified then raise exception 'already_verified'; end if;
  if p_mime is null or p_mime not in ('image/jpeg','image/png','image/webp') then raise exception 'bad_type'; end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > public.cfg('max_certificate_bytes')::int then raise exception 'bad_file_size'; end if;
  delete from public.verification_requests v
   where v.applicant_id = u and v.status = 'pending' and v.file_uploaded_at is null and not exists (select 1 from public.certificate_files f where f.request_id = v.id);
  if exists (select 1 from public.verification_requests where applicant_id = u and status = 'pending') then raise exception 'request_pending'; end if;
  insert into public.verification_requests (applicant_id, link_id, delete_after, object_key, file_mime, file_bytes)
  values (u, p_link, now() + (public.cfg('days_if_unreviewed') || ' days')::interval, 'certs/' || gen_random_uuid()::text, p_mime, p_bytes) returning id into rid;
  return rid;
end $$;

-- ================================================================ my data export includes the extra institutes
do $$ declare d text; begin
  select pg_get_functiondef('public.export_my_data()'::regprocedure) into d;
  if d not like '%institutes%' then
    execute replace(d, '''exported_at'', now()',
      '''institutes'', coalesce((select jsonb_agg(to_jsonb(l) - ''profile_id'') from public.profile_institutes l where l.profile_id = u), ''[]''::jsonb), ''exported_at'', now()');
  end if;
end $$;

-- ================================================================ who may call what
revoke all on function public.add_my_institute(jsonb), public.remove_my_institute(uuid), public.my_institutes(), public.directory_institutes(),
  public.request_link_code(uuid, text), public.confirm_link_code(uuid, text), public.redeem_link_referral(uuid, text), public.create_referral_for(text, text),
  public.submit_link_certificate(uuid, text, text), public.submit_link_certificate_start(uuid, text, int), public.vr_profile(public.verification_requests),
  public.trg_pi_touch(), public.trg_pi_log() from public, anon, authenticated;
grant execute on function
  public.add_my_institute(jsonb), public.remove_my_institute(uuid), public.my_institutes(), public.directory_institutes(),
  public.request_link_code(uuid, text), public.confirm_link_code(uuid, text), public.redeem_link_referral(uuid, text), public.create_referral_for(text, text),
  public.submit_link_certificate(uuid, text, text), public.submit_link_certificate_start(uuid, text, int)
to authenticated;
