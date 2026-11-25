-- 0015: (a) nobody can open a new account with an email and password; only Google sign-in creates members.
--       (b) the referral-code check has a limit per caller, so one bot cannot block everyone's referral links.

-- (a) Supabase's "email" sign-up is open by default: anyone can call the sign-up address directly and get an account without Google.
-- This blocks it at the database, whatever the dashboard settings say. It only stops the sign-in service itself (role supabase_auth_admin)
-- from creating an "email" user. Google sign-ups, and faculty accounts made by the admin function (which runs as the database owner), are not affected.
create or replace function public.block_email_signups() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'supabase_auth_admin' and coalesce(new.raw_app_meta_data ->> 'provider', 'email') = 'email' then
    raise exception 'email_signup_closed';
  end if;
  return new;
end $$;

drop trigger if exists block_email_signups on auth.users;
create trigger block_email_signups before insert on auth.users for each row execute function public.block_email_signups();

-- (b) referral check: per caller (hashed network address, never stored raw) 20 a minute, plus a high ceiling for everyone together.
alter table public.referral_checks add column if not exists who text;

create or replace function public.check_referral(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c text := public.norm_code(p_code); r public.referrals; inst public.institutes; byname text; byfull text; byav jsonb;
        hdr json; ip text; me text;
begin
  if length(c) < 4 or length(c) > 15 then return jsonb_build_object('ok', false); end if;
  begin hdr := nullif(current_setting('request.headers', true), '')::json; exception when others then hdr := null; end;
  ip := nullif(btrim(split_part(coalesce(hdr ->> 'cf-connecting-ip', hdr ->> 'x-forwarded-for', ''), ',', 1)), '');
  me := coalesce(md5('bridges-ref:' || ip), '-');
  delete from public.referral_checks where at < now() - interval '1 hour';
  if (select count(*) from public.referral_checks where at > now() - interval '1 minute' and who = me) >= 20 then raise exception 'too_many_attempts'; end if;
  if (select count(*) from public.referral_checks where at > now() - interval '1 minute') >= 600 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_checks (who) values (me);
  select * into r from public.referrals where code_hash = public.hash_code(c) and status = 'pending' and expires_at > now();
  if not found then return jsonb_build_object('ok', false); end if;
  select * into inst from public.institutes where id = r.institute_id;
  if r.referrer_id is not null then
    select split_part(btrim(name), ' ', 1), btrim(name), avatar into byname, byfull, byav from public.profiles where id = r.referrer_id;
  end if;
  return jsonb_build_object('ok', true, 'kind', r.kind, 'institute_id', r.institute_id, 'institute_name', inst.name, 'institute_short', inst.short,
                            'by', byname, 'by_full', byfull, 'by_avatar', byav);
end $$;

grant execute on function public.check_referral(text) to anon, authenticated;
