-- "Last active" in the admin showed "Never" for members who come back with a saved sign-in,
-- because last_seen only moved on a brand-new Google sign-in. This moves it quietly (no log line),
-- at most once every ten minutes per member.

create or replace function public.touch_last_seen() returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then return; end if;
  update public.profiles set last_seen = now()
   where id = u and (last_seen is null or last_seen < now() - interval '10 minutes');
end $$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- members who already signed in before this fix: use their latest sign-in in the activity log
update public.profiles p set last_seen = l.at
  from (select who_id, max(at) at from public.admin_log where type = 'auth' and act = 'Signed in with Google' group by who_id) l
 where p.id = l.who_id and p.last_seen is null;

-- the member CSV names the new ways of being verified
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
           case p.verify_method when 'institute_email' then 'Institute email code' when 'certificate' then 'Certificate' when 'referral' then 'Referral code' when 'alumni_email' then 'Alumni email code' when 'admin' then 'Admin' else '' end,
           p.status, p.listed, public.contact_limit_for(p.id), p.created_at, p.last_seen
    from public.profiles p join auth.users u on u.id = p.id
    left join public.profile_private pp on pp.id = p.id left join public.institutes i on i.id = p.institute_id
    where p.kind in ('student','alum') order by p.created_at desc;
end $$;
