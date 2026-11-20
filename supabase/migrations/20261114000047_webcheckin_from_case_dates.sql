-- Web check-in alerts from the case dates (owner, 2026-11-20).
-- Bookings are now just the ticket + prices, with no flight legs typed, so the per-flight web check-in alert (made
-- from the typed legs) stopped coming. A ticketed flight booking with no typed legs now gets one alert for the case's
-- From date ("departure") and one for its To date ("return", when it is another day), due at 09:00 IST two days
-- before (web check-in opens 48 hours before the flight; the flight time is on the ticket). It closes by itself on the
-- travel day (the 48-hour rule from 20261114000034). Bookings that do have typed legs work exactly as before.
-- One case gets one set of these alerts even with several flight bookings: they hang on the case's first ticketed
-- flight booking with no typed legs. Changing the case dates moves them.

create or replace function private.webcheckin_sync(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  l public.booking_lines;
  c public.cases;
  s jsonb; k text; keys text[] := '{}';
  tz text; dep_at timestamptz; names text; fno text;
  v record; first_line uuid;
  on_ boolean := coalesce(((select auto_reminders from public.settings where id = 1) ->> 'web_checkin')::boolean, true);
  typed boolean;
begin
  select * into l from public.booking_lines where id = p_line;
  if found then select * into c from public.cases where id = l.case_id; end if;

  if found and on_ and l.service = 'flight' and l.status = 'confirmed' and c.status <> 'cancelled' then
    names := (select string_agg(x.full_name, ', ' order by x.full_name) from public.customers x where x.id = any(l.traveller_ids));
    typed := jsonb_typeof(l.details -> 'sectors') = 'array'
             and exists (select 1 from jsonb_array_elements(l.details -> 'sectors') e where coalesce(e ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$');
    if typed then
      -- as before: one alert per typed flight, 48 hours before it leaves (departure airport's local time)
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
    else
      -- no legs typed: the case dates, once per case (on its first ticketed flight booking without typed legs)
      select x.id into first_line from public.booking_lines x
       where x.case_id = l.case_id and x.service = 'flight' and x.status = 'confirmed'
         and not (jsonb_typeof(x.details -> 'sectors') = 'array'
                  and exists (select 1 from jsonb_array_elements(x.details -> 'sectors') e where coalesce(e ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'))
       order by x.created_at, x.id limit 1;
      if first_line = l.id then
        if names is null then
          names := (select string_agg(x.full_name, ', ' order by x.full_name) from public.case_travellers t join public.customers x on x.id = t.customer_id where t.case_id = c.id);
        end if;
        for v in select * from (values (c.travel_start, 'departure'),
                                       (case when c.travel_end is distinct from c.travel_start then c.travel_end end, 'return')) d(day, what)
                  where day is not null loop
          continue when v.day < (now() at time zone 'Asia/Kolkata')::date;   -- already travelled
          k := 'webcheckin:' || l.id || ':case-' || v.what || ':' || v.day;
          keys := keys || k;
          insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
          values (l.case_id, c.customer_id,
                  'Web check-in: ' || v.what || ' ' || to_char(v.day, 'DD-MM-YYYY'),
                  private.case_owner(l.case_id), greatest(((v.day - 2) + time '09:00') at time zone 'Asia/Kolkata', now()), 'high', 'due',
                  'Web check-in opens 48 hours before the flight; the flight time is on the ticket.'
                    || coalesce(chr(10) || 'Travellers: ' || names, ''),
                  k, null)
          on conflict (auto_key) do nothing;
        end loop;
      end if;
    end if;
  end if;

  -- whatever this booking no longer needs (flight or dates changed, cancelled, deleted, switched off) is closed with a note
  update public.tasks
     set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the flight or the travel dates changed, or the booking is no longer confirmed.'
   where auto_key like 'webcheckin:' || p_line || ':%' and status <> 'done' and not (auto_key = any(keys));
end $$;

-- a booking change can move the case-date alerts to another flight booking of the same case: sync them all
create or replace function private.webcheckin_from_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare x uuid;
begin
  perform private.webcheckin_sync(case when tg_op = 'DELETE' then old.id else new.id end);
  for x in select id from public.booking_lines
            where case_id in (case when tg_op = 'INSERT' then null else old.case_id end, case when tg_op = 'DELETE' then null else new.case_id end)
              and service = 'flight' and id <> (case when tg_op = 'DELETE' then old.id else new.id end) loop
    perform private.webcheckin_sync(x);
  end loop;
  return null;
end $$;

-- the case's status (cancelled / reopened) or its travel dates changed: its flight bookings' alerts follow
create or replace function private.webcheckin_from_case() returns trigger
language plpgsql security definer set search_path = public as $$
declare x uuid;
begin
  if (new.status is distinct from old.status and (new.status = 'cancelled' or old.status = 'cancelled'))
     or new.travel_start is distinct from old.travel_start or new.travel_end is distinct from old.travel_end then
    for x in select id from public.booking_lines where case_id = new.id and service = 'flight' loop
      perform private.webcheckin_sync(x);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists t_webcheckin on public.cases;
create trigger t_webcheckin after update of status, travel_start, travel_end on public.cases for each row execute function private.webcheckin_from_case();

-- ticketed flights already in the CRM get their alerts now
do $$ declare x uuid; begin
  for x in select id from public.booking_lines where service = 'flight' and status = 'confirmed' loop
    perform private.webcheckin_sync(x);
  end loop;
end $$;
