-- 0014: security hardening (26 Nov 2026), after a review against common attacks on AI-built apps.
-- Safe to run again.
--  1. A member's avatar can only hold the values the avatar maker produces. A crafted value (a negative number, an unknown
--     preset) used to make the avatar drawing fail for everybody who looked at that member.
--  2. Size caps on every free-form field a member can write, so one account cannot bloat what everybody downloads.
--  3. Daily and hourly limits on reports, invites and contribution starts, so one account cannot flood the admin lists.

-- ---- 1. avatar shape
create or replace function public.avatar_num_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric between 0 and 40 else false end
$$;

create or replace function public.avatar_ok(a jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select a is not null and jsonb_typeof(a) = 'object' and length(a::text) <= 400
    and not exists (
      select 1 from jsonb_each(a) e
      where e.key not in ('p','f','h','g','j','b','s','bg','e','x')
         or case e.key
              when 'p' then not (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') in ('m','f','a'))
              when 'h' then not (jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') <= 12)
              when 'g' then not (public.avatar_num_ok(e.value) or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') in ('m','f')))
              when 'j' then not (jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) <= 4
                                 and not exists (select 1 from jsonb_array_elements(e.value) as x(v) where not public.avatar_num_ok(x.v)))
              else not public.avatar_num_ok(e.value)
            end
    )
$$;

-- ---- 2. size caps (the app's own limits sit well below these)
alter table public.profiles
  drop constraint if exists profiles_avatar_ok, drop constraint if exists profiles_experiences_size,
  drop constraint if exists profiles_helps_size, drop constraint if exists profiles_campus_len,
  add constraint profiles_avatar_ok check (public.avatar_ok(avatar)),
  add constraint profiles_experiences_size check (jsonb_array_length(experiences) <= 12 and length(experiences::text) <= 20000),
  add constraint profiles_helps_size check (cardinality(helps) <= 12),
  add constraint profiles_campus_len check (char_length(campus) <= 80);
alter table public.profile_institutes
  drop constraint if exists pi_campus_len, add constraint pi_campus_len check (char_length(campus) <= 80);
alter table public.profile_private
  drop constraint if exists pp_links_size, drop constraint if exists pp_email_len,
  add constraint pp_links_size check (jsonb_array_length(links) <= 6 and length(links::text) <= 8000),
  add constraint pp_email_len check (email_personal is null or char_length(email_personal) <= 254);
alter table public.contributions
  drop constraint if exists contributions_name_len, add constraint contributions_name_len check (char_length(display_name) <= 80);
alter table public.volunteer_applications
  drop constraint if exists va_phone_len, add constraint va_phone_len check (char_length(phone) <= 20);
alter table public.email_verifications
  drop constraint if exists ev_email_len, add constraint ev_email_len check (char_length(email) <= 254);
alter table public.referrals
  drop constraint if exists ref_email_len, add constraint ref_email_len check (invitee_email is null or char_length(invitee_email) <= 254);
alter table public.invites
  drop constraint if exists inv_email_len, add constraint inv_email_len check (email is null or char_length(email) <= 254);

-- ---- 3. limits
CREATE OR REPLACE FUNCTION public.send_report(p_target uuid, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u uuid := public.require_user();
begin
  if p_target = u then raise exception 'own_listing'; end if;
  if (select count(*) from public.reports where reporter_id = u and created_at > now() - interval '1 day') >= 10 then raise exception 'too_many_requests'; end if;
  if not exists (select 1 from public.profiles where id = p_target) then raise exception 'not_found'; end if;
  insert into public.reports (reporter_id, target_id, reason, note) values (u, p_target, p_reason, left(p_note, 500));
end $function$;

CREATE OR REPLACE FUNCTION public.create_invite(p_email text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u uuid := public.require_user(); t text := lower(public.new_code(10, false));
begin
  if not exists (select 1 from public.profiles where id = u and verified) then raise exception 'verified_only'; end if;
  if (select count(*) from public.invites where inviter_id = u and created_at > now() - interval '1 day') >= 20 then raise exception 'too_many_requests'; end if;
  insert into public.invites (inviter_id, token, email) values (u, t, nullif(lower(btrim(coalesce(p_email,''))),''));
  return t;
end $function$;

CREATE OR REPLACE FUNCTION public.start_contribution(p_amount_paise bigint, p_anonymous boolean, p_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u uuid := public.require_user(); me public.profiles; cid uuid;
begin
  select * into me from public.profiles where id = u;
  if not found then raise exception 'no_profile'; end if;
  if p_amount_paise < public.cfg('min_contribution_paise')::bigint then raise exception 'amount_too_small'; end if;
  if (select count(*) from public.contributions where user_id = u and created_at > now() - interval '1 hour') >= 10 then raise exception 'too_many_requests'; end if;
  insert into public.contributions (user_id, anonymous, display_name, amount_paise)
  values (u, coalesce(p_anonymous, false),
          case when coalesce(p_anonymous, false) then 'Anonymous' else left(coalesce(nullif(btrim(p_name),''), me.name), 80) end,
          p_amount_paise) returning id into cid;
  return cid;
end $function$;

-- The avatar checks run inside the profiles table's CHECK constraint, as whoever writes the row (members, the sign-up call, the admin).
-- 0001 takes every function permission away each time the migrations are re-applied, so they must be granted again here.
grant execute on function public.avatar_num_ok(jsonb), public.avatar_ok(jsonb) to anon, authenticated;
