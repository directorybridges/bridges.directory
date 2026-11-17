-- 0010: the "code accepted" card shows who vouched (full name and avatar), like the referral design.
-- Only someone holding a valid code sees this, and only for that code's referrer.
create or replace function public.check_referral(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c text := public.norm_code(p_code); r public.referrals; inst public.institutes; byname text; byfull text; byav jsonb;
begin
  if length(c) < 4 or length(c) > 15 then return jsonb_build_object('ok', false); end if;
  delete from public.referral_checks where at < now() - interval '1 hour';
  if (select count(*) from public.referral_checks where at > now() - interval '1 minute') >= 60 then raise exception 'too_many_attempts'; end if;
  insert into public.referral_checks default values;
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
