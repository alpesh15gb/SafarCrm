-- Web check-in task for every booked flight (owner, 2026-11-15). Additive.
-- Airlines open web check-in 48 hours before departure. When a flight booking is confirmed (ticket issued), each of
-- its flights gets a task "Web check-in: <flight> <route> <date time>" for the case's assigned staff, due exactly
-- 48 hours before departure in the departure airport's local time (or straight away when booked inside 48 hours).
-- The travellers and PNR are in the task notes.
-- The tasks follow the booking: a changed flight closes the old task (with a note) and makes the new one; a cancelled,
-- deleted or un-confirmed booking closes its tasks. A flight already departed gets none. Tasks someone already ticked
-- off are left alone. Like other automatic reminders they never block completing a case.
-- Settings → Reminders → "Web check-in opens" switches it off (on unless switched off).

create or replace function private.webcheckin_sync(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  l public.booking_lines;
  c public.cases;
  s jsonb; k text; keys text[] := '{}';
  tz text; dep_at timestamptz; names text; fno text;
  on_ boolean := coalesce(((select auto_reminders from public.settings where id = 1) ->> 'web_checkin')::boolean, true);
begin
  select * into l from public.booking_lines where id = p_line;
  if found then select * into c from public.cases where id = l.case_id; end if;

  if found and on_ and l.service = 'flight' and l.status = 'confirmed' and c.status <> 'cancelled'
     and jsonb_typeof(l.details -> 'sectors') = 'array' then
    names := (select string_agg(x.full_name, ', ' order by x.full_name) from public.customers x where x.id = any(l.traveller_ids));
    for s in select value from jsonb_array_elements(l.details -> 'sectors') loop
      continue when coalesce(s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$';
      tz := coalesce(nullif(s ->> 'dep_tz', ''), 'Asia/Kolkata');
      if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'Asia/Kolkata'; end if;
      dep_at := ((s ->> 'date') || ' ' || case when coalesce(s ->> 'dep', '') ~ '^\d{1,2}:\d{2}$' then s ->> 'dep' else '00:00' end)::timestamp at time zone tz;
      continue when dep_at <= now();                                   -- already flown
      fno := upper(coalesce(nullif(trim(s ->> 'flight_no'), ''), ''));
      k := 'webcheckin:' || l.id || ':' || upper(coalesce(s ->> 'from', '')) || '-' || upper(coalesce(s ->> 'to', '')) || ':'
           || (s ->> 'date') || ':' || coalesce(s ->> 'dep', '') || ':' || fno;
      keys := keys || k;
      insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
      values (l.case_id, c.customer_id,
              left('Web check-in: ' || trim(fno || ' ' || upper(coalesce(s ->> 'from', '')) || '→' || upper(coalesce(s ->> 'to', '')))
                   || ' ' || to_char((s ->> 'date')::date, 'DD-MM-YYYY') || coalesce(' ' || nullif(s ->> 'dep', ''), ''), 200),
              private.case_owner(l.case_id), greatest(dep_at - interval '48 hours', now()), 'high', 'due',
              'Web check-in opens 48 hours before departure.'
                || coalesce(chr(10) || 'Travellers: ' || names, '')
                || coalesce(chr(10) || 'PNR: ' || nullif(l.details ->> 'pnr', ''), ''),
              k, null)
      on conflict (auto_key) do nothing;
    end loop;
  end if;

  -- whatever this booking no longer needs (flight changed, cancelled, deleted, switched off) is closed with a note
  update public.tasks
     set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the flight was changed or cancelled, or the booking is no longer confirmed.'
   where auto_key like 'webcheckin:' || p_line || ':%' and status <> 'done' and not (auto_key = any(keys));
end $$;

create or replace function private.webcheckin_from_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.webcheckin_sync(case when tg_op = 'DELETE' then old.id else new.id end);
  return null;
end $$;

drop trigger if exists t_webcheckin on public.booking_lines;
create trigger t_webcheckin after insert or update of status, details, traveller_ids, case_id or delete on public.booking_lines
  for each row execute function private.webcheckin_from_line();

-- a cancelled case closes its open check-in tasks; reopened, they come back. A completed case keeps them: cases
-- complete once booked and paid, which is often before the trip
create or replace function private.webcheckin_from_case() returns trigger
language plpgsql security definer set search_path = public as $$
declare x uuid;
begin
  if new.status is distinct from old.status and (new.status = 'cancelled' or old.status = 'cancelled') then
    for x in select id from public.booking_lines where case_id = new.id and service = 'flight' loop
      perform private.webcheckin_sync(x);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists t_webcheckin on public.cases;
create trigger t_webcheckin after update of status on public.cases for each row execute function private.webcheckin_from_case();

-- confirmed flights already in the CRM get their tasks now
do $$ declare x uuid; begin
  for x in select id from public.booking_lines where service = 'flight' and status = 'confirmed' loop
    perform private.webcheckin_sync(x);
  end loop;
end $$;
