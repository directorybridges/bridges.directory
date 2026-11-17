-- 0009: the contact limit is adjustable. Safe to run again.
--   * site-wide: a count, per day OR per week (any count 1 to 500)
--   * per role: Volunteers, Students, Alumni, Faculty can each have their own count
--   * per person: any count 0 to 500 (set from the member's profile in the admin)
-- The most specific one wins: the person, then their role (a volunteer counts as Volunteers), then the site.
-- Role and personal counts use the site-wide period. Day = a calendar day in India (resets at midnight IST).
-- Week = Monday 00:00 IST, as before.

insert into public.settings(key, value, note) values
  ('contact_period',          'week', 'contact limit period: week or day'),
  ('contact_limit_volunteer', '',     'contacts for volunteers; empty = same as the site limit'),
  ('contact_limit_student',   '',     'contacts for students; empty = same as the site limit'),
  ('contact_limit_alum',      '',     'contacts for alumni; empty = same as the site limit'),
  ('contact_limit_faculty',   '',     'contacts for faculty; empty = same as the site limit')
on conflict (key) do nothing;

create or replace function public.contact_period() returns text
language sql stable security definer set search_path = '' as $$
  select case when public.cfg('contact_period') = 'day' then 'day' else 'week' end;
$$;

-- start of the current window (midnight IST today, or Monday 00:00 IST)
create or replace function public.contact_window_start() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case when public.contact_period() = 'day'
              then date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
              else date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' end;
$$;

create or replace function public.contact_window_end() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select public.contact_window_start() + case when public.contact_period() = 'day' then interval '1 day' else interval '7 days' end;
$$;

create or replace function public.contact_role_limits() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'volunteer', nullif(public.cfg('contact_limit_volunteer'), '')::int,
    'student',   nullif(public.cfg('contact_limit_student'), '')::int,
    'alum',      nullif(public.cfg('contact_limit_alum'), '')::int,
    'faculty',   nullif(public.cfg('contact_limit_faculty'), '')::int);
$$;

-- what one person may open in the current window: the person, then the role, then the site
create or replace function public.contact_limit_for(p_user uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.contact_limit from public.profiles p where p.id = p_user),
    (select nullif(public.cfg('contact_limit_' || case when p.is_volunteer then 'volunteer' else p.kind end), '')::int from public.profiles p where p.id = p_user),
    nullif(public.cfg('weekly_contacts'), '')::int,
    5);
$$;

create or replace function public.contacts_used(p_user uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.contact_reveals where user_id = p_user and created_at >= public.contact_window_start();
$$;

create or replace function public.contacts_left() returns int
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  return greatest(0, public.contact_limit_for(u) - public.contacts_used(u));
end $$;

-- everything the member site needs for the counter
create or replace function public.my_contact_limit() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user(); lim int := public.contact_limit_for(u); used int := public.contacts_used(u);
begin
  return jsonb_build_object('limit', lim, 'used', used, 'left', greatest(0, lim - used), 'period', public.contact_period(),
                            'resets_at', public.contact_window_end());
end $$;

create or replace function public.reveal_contact(p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.require_user(); wk date := (date_trunc('week', now() at time zone 'Asia/Kolkata'))::date;
        t public.profiles; pr public.profile_private;
begin
  if not exists (select 1 from public.profiles where id = u and status = 'active' and (verified or kind = 'faculty')) then raise exception 'verified_only'; end if;
  if p_target = u then raise exception 'own_contact'; end if;
  select * into t from public.profiles where id = p_target and listed and verified and status = 'active';
  if not found then raise exception 'not_found'; end if;
  if not exists (select 1 from public.contact_reveals where user_id = u and target_id = p_target) then
    if public.contacts_used(u) >= public.contact_limit_for(u) then raise exception 'limit_reached'; end if;
    insert into public.contact_reveals (user_id, target_id, week_start) values (u, p_target, wk);
  end if;
  select * into pr from public.profile_private where id = p_target;
  return jsonb_build_object('name', t.name, 'email', coalesce(pr.email_personal, pr.email_institute), 'links', pr.links);
end $$;

create or replace function public.trg_log_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tn text;
begin
  select name into tn from public.profiles where id = new.target_id;
  perform public.write_log('contact', 'Opened a contact', tn, new.target_id,
    'Contact ' || public.contacts_used(new.user_id) || ' of ' || public.contact_limit_for(new.user_id) || case when public.contact_period() = 'day' then ' today' else ' this week' end, null, new.user_id);
  return new;
end $$;

-- ---------------------------------------------------------------- admin: settings
create or replace function public.admin_get_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('settings');
  return jsonb_build_object(
    'limit', public.cfg('weekly_contacts')::int,
    'period', public.contact_period(),
    'role_limits', public.contact_role_limits(),
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
declare me uuid := public.need_perm('settings'); ch text[] := '{}'; cur jsonb := public.admin_get_settings(); k text; v boolean; rk text; rv jsonb; nv text;
begin
  if p ? 'limit' then
    if (p->>'limit')::int < 1 or (p->>'limit')::int > 500 then raise exception 'bad_limit'; end if;
    if (p->>'limit')::int <> (cur->>'limit')::int then ch := array_append(ch, 'Contact limit'); update public.settings set value = (p->>'limit')::int::text where key = 'weekly_contacts'; end if;
  end if;
  if p ? 'period' then
    if p->>'period' not in ('day', 'week') then raise exception 'bad_period'; end if;
    if p->>'period' <> cur->>'period' then ch := array_append(ch, 'Contact limit period'); update public.settings set value = p->>'period' where key = 'contact_period'; end if;
  end if;
  if p ? 'role_limits' then
    if jsonb_typeof(p->'role_limits') <> 'object' then raise exception 'bad_limit'; end if;
    for rk, rv in select key, value from jsonb_each(p->'role_limits') loop
      if rk not in ('volunteer', 'student', 'alum', 'faculty') then raise exception 'bad_limit'; end if;
      if jsonb_typeof(rv) not in ('number', 'null') then raise exception 'bad_limit'; end if;
      if jsonb_typeof(rv) = 'number' and ((rv #>> '{}')::numeric <> floor((rv #>> '{}')::numeric) or (rv #>> '{}')::numeric < 0 or (rv #>> '{}')::numeric > 500) then raise exception 'bad_limit'; end if;
      nv := case when jsonb_typeof(rv) = 'null' then '' else (rv #>> '{}') end;
      if nv is distinct from coalesce(nullif(cur->'role_limits'->>rk, ''), '') then
        update public.settings set value = nv where key = 'contact_limit_' || rk;
        if not 'Contact limits by role' = any (ch) then ch := array_append(ch, 'Contact limits by role'); end if;
      end if;
    end loop;
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

-- ---------------------------------------------------------------- admin: member edit, overview, export
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
  if n_limit is not null and (n_limit < 0 or n_limit > 500) then raise exception 'bad_limit'; end if;
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
  if n_limit is distinct from r.contact_limit then edit_ch := array_append(edit_ch, 'Contact limit'); end if;
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
    'period', public.contact_period(),
    'role_limits', public.contact_role_limits(),
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
           p.status, p.listed, public.contact_limit_for(p.id), p.created_at, p.last_seen
    from public.profiles p join auth.users u on u.id = p.id
    left join public.profile_private pp on pp.id = p.id left join public.institutes i on i.id = p.institute_id
    where p.kind in ('student','alum') order by p.created_at desc;
end $$;

-- grants: helpers stay private, the member counter is callable by signed-in users
revoke all on function public.contact_period(), public.contact_window_start(), public.contact_window_end(), public.contact_role_limits(),
  public.contact_limit_for(uuid), public.contacts_used(uuid), public.trg_log_contact() from public, anon, authenticated;
revoke all on function public.contacts_left(), public.reveal_contact(uuid), public.my_contact_limit() from public, anon;
grant execute on function public.contacts_left(), public.reveal_contact(uuid), public.my_contact_limit() to authenticated;
revoke all on function public.admin_get_settings(), public.admin_save_settings(jsonb), public.admin_update_member(uuid, jsonb),
  public.admin_overview(), public.admin_export_members() from public, anon;
grant execute on function public.admin_get_settings(), public.admin_save_settings(jsonb), public.admin_update_member(uuid, jsonb),
  public.admin_overview(), public.admin_export_members() to authenticated;
