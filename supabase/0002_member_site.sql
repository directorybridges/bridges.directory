-- Member site (Fork A). Safe to run again. Adds one function; changes nothing that exists.
--
-- A volunteer has to compare a certificate with what the applicant typed (name, institute, branch,
-- year). volunteer_queue() only returned the institute, so the queue could not show the rest.
-- This returns exactly what the volunteer programme says a volunteer may see, and nothing more:
-- no email, no links, no phone, no avatar, and never who the other reviewers were.

create or replace function public.volunteer_queue_details()
returns table (request_id uuid, kind text, name text, institute_id text, campus text, branch text, year int,
               submitted_at timestamptz, approvals int)
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := public.require_user();
begin
  if not exists (select 1 from public.profiles where id = u and is_volunteer and status = 'active') then
    raise exception 'volunteers_only';
  end if;
  return query
    select r.id, p.kind, p.name, p.institute_id, p.campus, p.branch, p.year, r.created_at,
           (select count(*) from public.verification_reviews v where v.request_id = r.id and v.decision = 'approve')::int
    from public.verification_requests r join public.profiles p on p.id = r.applicant_id
    where r.status = 'pending' and r.applicant_id <> u
      and not exists (select 1 from public.verification_reviews v where v.request_id = r.id and v.reviewer_id = u)
    order by r.created_at;
end $$;

revoke all on function public.volunteer_queue_details() from public, anon, authenticated;
grant execute on function public.volunteer_queue_details() to authenticated;
