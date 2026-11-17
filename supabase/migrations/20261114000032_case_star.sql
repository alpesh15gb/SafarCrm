-- Starred cases (owner, after a client visit, 2026-11-18): the boss stars the important cases and they stay at the
-- top of the case list for everyone. Only the boss can star or unstar. Additive.
alter table public.cases add column if not exists starred boolean not null default false;
alter table public.cases add column if not exists starred_at timestamptz;
create index if not exists cases_starred_idx on public.cases (starred desc, travel_start);

create or replace function private.guard_case_star() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.starred is distinct from old.starred then
    -- auth.uid() is null for the database itself (migrations, cron): allowed
    if auth.uid() is not null and not public.is_boss() then
      raise exception 'star_boss_only: only the boss can star a case' using errcode = '42501';
    end if;
    new.starred_at := case when new.starred then now() end;
  end if;
  return new;
end $$;

drop trigger if exists t_case_star on public.cases;
create trigger t_case_star before update of starred on public.cases for each row execute function private.guard_case_star();
