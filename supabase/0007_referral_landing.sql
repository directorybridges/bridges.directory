-- Referral landing page.
-- 1. check_referral(code): a visitor who is not signed in yet can see whether a code works, and who vouched, before choosing Google.
--    It shows only the first name of the referrer and the institute. Checks are rate-limited for everyone together.
-- 2. Codes ignore spaces, dashes and case, so a code typed as "ab12 cd34" still works.
-- 3. The referral and invite emails link to the landing page with the code already in the link.

create table if not exists public.referral_checks (at timestamptz not null default now());
alter table public.referral_checks enable row level security;

create or replace function public.norm_code(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create or replace function public.check_referral(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c text := public.norm_code(p_code); r public.referrals; inst public.institutes; byname text;
begin
  if length(c) < 4 or length(c) > 15 then return jsonb_build_object('ok', false); end if;
  delete from public.referral_checks where at < now() - interval '1 hour';
  if (select count(*) from public.referral_checks where at > now() - interval '1 minute') >= 60 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_checks default values;
  select * into r from public.referrals where code_hash = public.hash_code(c) and status = 'pending' and expires_at > now();
  if not found then return jsonb_build_object('ok', false); end if;
  select * into inst from public.institutes where id = r.institute_id;
  if r.referrer_id is not null then select split_part(btrim(name), ' ', 1) into byname from public.profiles where id = r.referrer_id; end if;
  return jsonb_build_object('ok', true, 'kind', r.kind, 'institute_id', r.institute_id, 'institute_name', inst.name, 'institute_short', inst.short, 'by', byname);
end $$;

create or replace function public.redeem_referral(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; r public.referrals;
begin
  select * into me from public.profiles where id = u;
  if not found or me.verified then raise exception 'alums_only'; end if;
  if (select count(*) from public.referral_attempts where user_id = u and at > now() - interval '1 hour') >= 10 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_attempts (user_id) values (u);
  select * into r from public.referrals
   where code_hash = public.hash_code(public.norm_code(p_code)) and status = 'pending' and expires_at > now() for update;
  if not found or r.institute_id <> me.institute_id then return false; end if;
  if r.referrer_id is not null and me.kind <> 'alum' then raise exception 'alums_only'; end if;
  if r.referrer_id is null and r.kind <> me.kind then return false; end if;
  update public.referrals set status = 'joined', used_by = u where id = r.id;
  update public.profiles set verified = true, listed = true, verify_method = 'referral', verified_at = now() where id = u;
  return true;
end $$;

create or replace function public.create_referral(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; code text; em text := lower(btrim(p_email)); days text := public.cfg('referral_days');
begin
  select * into me from public.profiles where id = u;
  if not found or me.kind <> 'alum' or not me.verified then raise exception 'verified_alums_only'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if (select count(*) from public.referrals where referrer_id = u and created_at > now() - interval '1 day') >= 20 then raise exception 'too_many_requests'; end if;
  code := public.new_code(8, false);
  insert into public.referrals (referrer_id, institute_id, invitee_email, code_hash, expires_at)
  values (u, me.institute_id, em, public.hash_code(code), now() + (days || ' days')::interval);
  perform public.send_email(em, 'You have been invited to Bridges.directory',
    '<p>' || public.esc_html(split_part(btrim(me.name), ' ', 1)) || ', a verified alum from your institute, vouched for you.</p>'
    || '<p><a href="https://bridges.directory/#join/referral/' || code || '" style="display:inline-block;background:#16150F;color:#ffffff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">Join Bridges.directory</a></p>'
    || '<p>The link opens with your code already filled in. If it does not, your one-time code is <b style="font-size:18px;letter-spacing:3px">' || code || '</b>.</p>'
    || '<p>It expires in ' || days || ' days.</p>');
end $$;

create or replace function public.admin_create_referral(p_email text, p_institute text, p_kind text default 'alum') returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('verify'); em text := lower(btrim(coalesce(p_email, ''))); inst public.institutes; code text; days text := public.cfg('referral_days');
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if p_kind not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into inst from public.institutes where id = p_institute;
  if not found then raise exception 'bad_campus'; end if;
  if (select count(*) from public.referrals where created_by = me and created_at > now() - interval '1 day') >= 100 then raise exception 'too_many_requests'; end if;
  -- an unused code for the same person and college is replaced, so only the newest email works
  update public.referrals set status = 'expired' where lower(invitee_email) = em and institute_id = inst.id and status = 'pending';
  code := public.new_code(8, false);
  insert into public.referrals (referrer_id, created_by, institute_id, invitee_email, kind, code_hash, expires_at)
  values (null, me, inst.id, em, p_kind, public.hash_code(code), now() + (days || ' days')::interval);
  perform public.write_log('verify', 'Sent an invite code', em, null, initcap(p_kind) || ' · ' || inst.short);
  perform public.send_email(em, 'You have been invited to Bridges.directory',
    '<p>The Bridges.directory team invited you to join as ' || case p_kind when 'alum' then 'an alum' else 'a student' end || ' of <b>' || public.esc_html(inst.name) || '</b>.</p>'
    || '<p><a href="https://bridges.directory/#join/referral/' || code || '" style="display:inline-block;background:#16150F;color:#ffffff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">Join Bridges.directory</a></p>'
    || '<p>The link opens with your code already filled in. If it does not, your one-time code is <b style="font-size:18px;letter-spacing:3px">' || code || '</b>.</p>'
    || '<p>It expires in ' || days || ' days.</p>');
end $$;

revoke all on function public.check_referral(text), public.norm_code(text) from public;
grant execute on function public.check_referral(text) to anon, authenticated;
grant execute on function public.norm_code(text) to authenticated;
