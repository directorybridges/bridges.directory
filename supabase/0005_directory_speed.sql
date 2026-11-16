-- Directory speed. The member site loads the whole directory once, then filters it in the browser.
-- 1) An index on name, so loading it in name order does not re-sort the whole table for every page.
-- 2) A cheap "version" check, so the site re-downloads the directory only when something in it changed
--    (before, it re-downloaded everyone every time it was older than a minute).

alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- updated_at moves only when something people can see changes (not when last_seen moves on every sign-in)
create or replace function public.trg_profiles_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'last_seen' - 'updated_at') is distinct from (to_jsonb(old) - 'last_seen' - 'updated_at') then
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;
drop trigger if exists profiles_a_touch on public.profiles;
create trigger profiles_a_touch before update on public.profiles for each row execute function public.trg_profiles_touch();

create index if not exists profiles_dir_name_idx on public.profiles (name, id) where listed and verified and status = 'active';

-- how many people the directory shows, and when it last changed. Runs as the signed-in member, so only what they may see is counted.
create or replace function public.directory_version() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('n', count(*), 'at', max(updated_at))
  from public.profiles where listed and verified and status = 'active';
$$;
revoke all on function public.directory_version() from public, anon;
grant execute on function public.directory_version() to authenticated;
