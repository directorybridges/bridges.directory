-- Admin can see and manage a member's extra institutes (Master's, PhD, a second degree) from the member editor.
--  admin_member_institutes(member)               the list, with status, branch, year, how each was verified
--  admin_set_member_institute(member, link, p)   add (link null) or change one; "verified" can be set by an admin
--  admin_remove_member_institute(link)           remove one
-- Every change goes to the activity log and moves the directory version, so open sites reload.

alter table public.profile_institutes drop constraint if exists profile_institutes_verify_method_check;
alter table public.profile_institutes add constraint profile_institutes_verify_method_check check (verify_method in ('institute_email','certificate','referral','alumni_email','admin'));

create or replace function public.admin_member_institutes(p_id uuid)
returns table (id uuid, institute_id text, short text, campus text, branch text, year int, kind text, verified boolean, verify_method text, verified_at timestamptz, request_status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.need_perm('edit');
  return query
    select l.id, l.institute_id, i.short, l.campus, l.branch, l.year, l.kind, l.verified, l.verify_method, l.verified_at, r.status, l.created_at
    from public.profile_institutes l join public.institutes i on i.id = l.institute_id
    left join lateral (select * from public.verification_requests v where v.link_id = l.id order by v.created_at desc limit 1) r on true
    where l.profile_id = p_id order by l.created_at;
end $$;

create or replace function public.admin_set_member_institute(p_id uuid, p_link uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('edit'); m public.profiles; l public.profile_institutes; inst public.institutes;
        n_inst text; n_campus text; n_branch text; n_year int; n_kind text; n_ver boolean; out_id uuid;
begin
  select * into m from public.profiles where profiles.id = p_id;
  if not found or m.kind not in ('student','alum') then raise exception 'not_found'; end if;
  if p_link is not null then
    select * into l from public.profile_institutes where profile_institutes.id = p_link and profile_id = p_id;
    if not found then raise exception 'not_found'; end if;
  end if;
  n_inst   := coalesce(p->>'institute_id', l.institute_id);
  n_campus := case when p ? 'campus' then coalesce(p->>'campus', '') else coalesce(l.campus, '') end;
  n_branch := btrim(coalesce(case when p ? 'branch' then p->>'branch' else l.branch end, ''));
  n_year   := case when p ? 'year' then nullif(p->>'year', '')::int else l.year end;
  n_kind   := coalesce(p->>'kind', l.kind);
  n_ver    := case when p ? 'verified' then (p->>'verified')::boolean else coalesce(l.verified, true) end;   -- an admin adding one counts as having checked it
  if n_kind not in ('student','alum') then raise exception 'bad_kind'; end if;
  select * into inst from public.institutes where institutes.id = n_inst;
  if not found then raise exception 'bad_institute'; end if;
  if n_campus <> '' and not (n_campus = any (inst.campuses)) then raise exception 'bad_campus'; end if;
  if n_branch = '' or char_length(n_branch) > 80 then raise exception 'bad_branch'; end if;
  if n_year is null or n_year < 1950 or n_year > 2100 then raise exception 'bad_year'; end if;
  if inst.id = m.institute_id and n_campus = m.campus then raise exception 'already_added'; end if;
  begin
    if p_link is null then
      if (select count(*) from public.profile_institutes where profile_id = p_id) >= 5 then raise exception 'too_many_institutes'; end if;
      insert into public.profile_institutes (profile_id, institute_id, campus, branch, year, kind, verified, verify_method, verified_at)
      values (p_id, inst.id, n_campus, n_branch, n_year, n_kind, n_ver, case when n_ver then 'admin' end, case when n_ver then now() end)
      returning profile_institutes.id into out_id;
    else
      update public.profile_institutes set institute_id = inst.id, campus = n_campus, branch = n_branch, year = n_year, kind = n_kind,
             verified = n_ver,
             verify_method = case when n_ver and not l.verified then 'admin' when n_ver then l.verify_method else null end,
             verified_at   = case when n_ver and not l.verified then now() when n_ver then l.verified_at else null end
       where profile_institutes.id = p_link;
      out_id := p_link;
    end if;
  exception when unique_violation then raise exception 'already_added';
  end;
  perform public.write_log('admin', case when p_link is null then 'Added an institute to a member' else 'Changed a member''s institute' end, m.name, p_id,
    inst.short || ' · ' || initcap(n_kind) || ' · ' || case when n_ver then 'verified' else 'not verified' end);
  return out_id;
end $$;

create or replace function public.admin_remove_member_institute(p_link uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.need_perm('edit'); l public.profile_institutes; nm text; sh text;
begin
  select * into l from public.profile_institutes where id = p_link;
  if not found then raise exception 'not_found'; end if;
  select name into nm from public.profiles where profiles.id = l.profile_id;
  select short into sh from public.institutes where institutes.id = l.institute_id;
  delete from public.profile_institutes where id = p_link;
  perform public.write_log('admin', 'Removed an institute from a member', nm, l.profile_id, sh || ' · ' || initcap(l.kind));
end $$;

revoke all on function public.admin_member_institutes(uuid), public.admin_set_member_institute(uuid, uuid, jsonb), public.admin_remove_member_institute(uuid) from public, anon, authenticated;
grant execute on function public.admin_member_institutes(uuid), public.admin_set_member_institute(uuid, uuid, jsonb), public.admin_remove_member_institute(uuid) to authenticated;
