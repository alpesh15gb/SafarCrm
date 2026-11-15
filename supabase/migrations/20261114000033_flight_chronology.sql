-- Validate the actual instants for complete flight sectors on every write path,
-- including confirmed imports. Missing arrival information remains unknown.
create or replace function private.guard_flight_chronology() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s jsonb; i int := 0;
  departure_zone text; arrival_zone text;
  departure_at timestamptz; arrival_at timestamptz;
begin
  -- A legacy error must not prevent cancellation, but reactivating it validates again.
  if new.service <> 'flight' or new.status = 'cancelled' then return new; end if;
  for s in select value from jsonb_array_elements(
    case when jsonb_typeof(new.details -> 'sectors') = 'array' then new.details -> 'sectors' else '[]'::jsonb end
  ) loop
    i := i + 1;
    -- Older bookings often have only arrival time. Do not assume an arrival date.
    if coalesce(s ->> 'date', '') = '' or coalesce(s ->> 'arr_date', '') = ''
       or coalesce(s ->> 'dep', '') = '' or coalesce(s ->> 'arr', '') = '' then continue; end if;

    departure_zone := coalesce(nullif(s ->> 'dep_tz', ''),
      (select extra ->> 'tz' from public.lookups where kind = 'airport' and value = upper(s ->> 'from')));
    arrival_zone := coalesce(nullif(s ->> 'arr_tz', ''),
      (select extra ->> 'tz' from public.lookups where kind = 'airport' and value = upper(s ->> 'to')));
    -- Unknown zones cannot establish chronology. Explicit invalid zones are
    -- already rejected by the existing flight identity trigger.
    if not exists (select 1 from pg_timezone_names where name = departure_zone)
       or not exists (select 1 from pg_timezone_names where name = arrival_zone) then continue; end if;

    departure_at := ((s ->> 'date')::date + (s ->> 'dep')::time) at time zone departure_zone;
    arrival_at := ((s ->> 'arr_date')::date + (s ->> 'arr')::time) at time zone arrival_zone;
    if arrival_at <= departure_at then
      raise exception 'sector_chronology: Sector % arrival must be after departure. Check the dates, times and time zones.', i using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists t_guard_flight_chronology on public.booking_lines;
create trigger t_guard_flight_chronology before insert or update of details, service, status on public.booking_lines
  for each row execute function private.guard_flight_chronology();

revoke execute on function private.guard_flight_chronology() from public, anon, authenticated;
