-- Admin invites: an admin types an email, picks a college, and Bridges.directory emails a one-time referral code.
-- The person signs in with Google, picks the same college and enters the code, and is verified and listed.
-- Same code table as member referrals (public.referrals), so expiry, attempts limit and the log all behave the same.

alter table public.referrals alter column referrer_id drop not null;
alter table public.referrals add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.referrals add column if not exists kind text not null default 'alum' check (kind in ('student','alum'));

-- the member-referral log line only applies to codes sent by a member; admin codes log themselves
create or replace function public.trg_log_referral() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  if new.referrer_id is null then return new; end if;
  select short into s from public.institutes where id = new.institute_id;
  perform public.write_log('verify', 'Sent a referral code', null, null, 'To an alum of ' || coalesce(s, new.institute_id), null, new.referrer_id);
  return new;
end $$;

-- a member code works for alums only (unchanged); an admin code works for the kind the admin chose
create or replace function public.redeem_referral(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); me public.profiles; r public.referrals;
begin
  select * into me from public.profiles where id = u;
  if not found or me.verified then raise exception 'alums_only'; end if;
  if (select count(*) from public.referral_attempts where user_id = u and at > now() - interval '1 hour') >= 10 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_attempts (user_id) values (u);
  select * into r from public.referrals
   where code_hash = public.hash_code(btrim(p_code)) and status = 'pending' and expires_at > now() for update;
  if not found or r.institute_id <> me.institute_id then return false; end if;
  if r.referrer_id is not null and me.kind <> 'alum' then raise exception 'alums_only'; end if;
  if r.referrer_id is null and r.kind <> me.kind then return false; end if;
  update public.referrals set status = 'joined', used_by = u where id = r.id;
  update public.profiles set verified = true, listed = true, verify_method = 'referral', verified_at = now() where id = u;
  return true;
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
    || '<p>Your one-time code is <b style="font-size:20px;letter-spacing:3px">' || code || '</b></p>'
    || '<p>Sign up with Google at https://bridges.directory, choose ' || public.esc_html(inst.short) || ' and enter this code when asked. It expires in ' || days || ' days.</p>');
end $$;

create or replace function public.admin_list_referrals(p_limit int default 100)
returns table (id uuid, email text, institute_id text, institute text, kind text, status text, sent_by text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.need_perm('verify');
  return query
    select r.id, r.invitee_email, r.institute_id, i.short, r.kind,
           case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end,
           case when r.referrer_id is null then 'Admin' else 'Member' end,
           r.created_at, r.expires_at
    from public.referrals r join public.institutes i on i.id = r.institute_id
    order by r.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

create or replace function public.admin_cancel_referral(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  perform public.need_perm('verify');
  select * into r from public.referrals where id = p_id and status = 'pending' and expires_at > now();
  if not found then raise exception 'not_found'; end if;
  update public.referrals set status = 'expired' where id = p_id;
  perform public.write_log('verify', 'Cancelled an invite code', r.invitee_email, null, null);
end $$;

revoke all on function public.admin_create_referral(text,text,text), public.admin_list_referrals(int), public.admin_cancel_referral(uuid) from public, anon;
grant execute on function public.admin_create_referral(text,text,text), public.admin_list_referrals(int), public.admin_cancel_referral(uuid) to authenticated;
