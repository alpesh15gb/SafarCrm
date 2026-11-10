-- Supporting flows (slice A). Additive: no column is dropped, no existing row loses data.
--   A1 customer case history covers payer, traveller or both
--   A2 a payer change leaves travellers alone; a company is never a passenger (enforced in the database)
--   A3 explicit arrival dates and airport time zones (no more "arrival < departure means +1")
--   A4 the name a ticket was issued in never changes; replaced tickets and changed sectors are kept as history
--   A7 travellers, case creation and case cancellation each happen in one transaction
--   A8 commission: a missing base fare falls back to the supplier cost, a zero base fare means zero, text is refused

-- ============================================================ A1 customer case history
create or replace function public.customer_case_history(p_customer uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  -- row-level security on cases applies: staff only see the cases they may open
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'max_id', c.max_id, 'title', c.title, 'status', c.status,
           'travel_start', c.travel_start, 'travel_end', c.travel_end, 'created_at', c.created_at,
           'relationship', case when c.customer_id = p_customer and t.customer_id is not null then 'payer_and_traveller'
                                when c.customer_id = p_customer then 'payer' else 'traveller' end)
         order by c.created_at desc), '[]'::jsonb)
  from public.cases c
  left join public.case_travellers t on t.case_id = c.id and t.customer_id = p_customer
  where c.customer_id = p_customer or t.customer_id is not null
$$;

-- ============================================================ A2 passengers
create or replace function private.guard_passengers() returns trigger
language plpgsql security definer set search_path = public as $$
declare prev uuid[];
begin
  if tg_table_name = 'case_travellers' then
    if exists (select 1 from public.customers c where c.id = new.customer_id and c.customer_type = 'corporate') then
      raise exception 'corporate_not_passenger: a company can pay for a trip but cannot travel on it' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- booking_lines: only people on the case can be on its bookings, and never a company
  if tg_op = 'UPDATE' and new.traveller_ids is not distinct from old.traveller_ids then return new; end if;
  prev := case when tg_op = 'UPDATE' then old.traveller_ids else '{}'::uuid[] end;
  if exists (select 1 from unnest(new.traveller_ids) x join public.customers c on c.id = x where c.customer_type = 'corporate') then
    raise exception 'corporate_not_passenger: a company can pay for a trip but cannot travel on it' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(new.traveller_ids) x
             where not (x = any(prev))
               and not exists (select 1 from public.case_travellers t where t.case_id = new.case_id and t.customer_id = x)) then
    raise exception 'traveller_not_on_case: add the person to the case travellers first' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_passengers on public.case_travellers;
create trigger t_guard_passengers before insert or update on public.case_travellers
  for each row execute function private.guard_passengers();
drop trigger if exists t_guard_passengers on public.booking_lines;
create trigger t_guard_passengers before insert or update of traveller_ids on public.booking_lines
  for each row execute function private.guard_passengers();

-- One transaction: travellers on the case, and anyone removed also comes off every booking (their tickets move to history).
create or replace function public.set_case_travellers(p_case uuid, p_ids uuid[])
returns int language plpgsql security invoker set search_path = public as $$
declare
  l record; keep uuid[]; gone uuid[]; gone_names text[]; tk jsonb; touched int := 0;
begin
  if not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  p_ids := array(select distinct x from unnest(coalesce(p_ids, '{}'::uuid[])) x where x is not null);
  perform 1 from public.cases where id = p_case for update;
  delete from public.case_travellers where case_id = p_case and not (customer_id = any(p_ids));
  insert into public.case_travellers (case_id, customer_id) select p_case, x from unnest(p_ids) x on conflict do nothing;
  for l in select b.id, b.traveller_ids, b.details from public.booking_lines b
           where b.case_id = p_case and not (b.traveller_ids <@ p_ids) loop
    keep := array(select x from unnest(l.traveller_ids) x where x = any(p_ids));
    gone := array(select x from unnest(l.traveller_ids) x where not (x = any(p_ids)));
    gone_names := array(select c.full_name from public.customers c where c.id = any(gone));
    tk := l.details -> 'tickets';
    if jsonb_typeof(tk) = 'array' then
      tk := (select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(tk) t
             where case when coalesce(t ->> 'customer_id', '') ~ '^[0-9a-f-]{36}$'
                        then not ((t ->> 'customer_id')::uuid = any(gone))
                        else not (coalesce(t ->> 'passenger', '') = any(gone_names)) end);
      update public.booking_lines set traveller_ids = keep, details = jsonb_set(details, '{tickets}', tk) where id = l.id;
    else
      update public.booking_lines set traveller_ids = keep where id = l.id;
    end if;
    touched := touched + 1;
  end loop;
  return touched;
end $$;

-- ============================================================ A7 case creation, idempotent
-- A double click or a retry with the same request key returns the case made the first time (no second MAX ID).
create table if not exists public.case_requests (
  request_key text primary key check (length(request_key) between 8 and 100),
  case_id uuid not null references public.cases (id) on delete cascade,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.case_requests enable row level security;
drop policy if exists case_requests_select on public.case_requests;
create policy case_requests_select on public.case_requests for select to authenticated using (public.can_see_case(case_id));
drop policy if exists case_requests_insert on public.case_requests;
create policy case_requests_insert on public.case_requests for insert to authenticated
  with check (public.is_team() and created_by = auth.uid() and public.can_see_case(case_id));

create or replace function public.create_case(p jsonb, p_travellers uuid[] default '{}', p_request_key text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare cid uuid; mx text; tags text[];
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'case_title_required' using errcode = 'P0001'; end if;
  if nullif(p ->> 'customer_id', '') is null then raise exception 'case_customer_required' using errcode = 'P0001'; end if;
  if p_request_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('case_request:' || p_request_key, 0));
    select r.case_id into cid from public.case_requests r where r.request_key = p_request_key;
    if cid is not null then
      select c.max_id into mx from public.cases c where c.id = cid;
      return jsonb_build_object('id', cid, 'max_id', mx, 'existing', true);
    end if;
  end if;
  tags := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p -> 'tags') = 'array' then p -> 'tags' else '[]'::jsonb end)), '{}');
  insert into public.cases (customer_id, title, travel_start, travel_end, destination, lead_source, assigned_to, status, notes, tags)
  values ((p ->> 'customer_id')::uuid, trim(p ->> 'title'), nullif(p ->> 'travel_start', '')::date, nullif(p ->> 'travel_end', '')::date,
          nullif(trim(coalesce(p ->> 'destination', '')), ''), nullif(trim(coalesce(p ->> 'lead_source', '')), ''),
          nullif(p ->> 'assigned_to', '')::uuid, coalesce(nullif(p ->> 'status', ''), 'enquiry'),
          nullif(trim(coalesce(p ->> 'notes', '')), ''), tags)
  returning id, max_id into cid, mx;
  insert into public.case_travellers (case_id, customer_id)
  select distinct cid, x from unnest(coalesce(p_travellers, '{}'::uuid[])) x where x is not null
  on conflict do nothing;
  if p_request_key is not null then
    insert into public.case_requests (request_key, case_id) values (p_request_key, cid);
  end if;
  return jsonb_build_object('id', cid, 'max_id', mx, 'existing', false);
end $$;

-- ============================================================ A7 case cancellation, one transaction
create or replace function public.cancel_case(p_case uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare b jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'cancel_needs_reason' using errcode = 'P0001'; end if;
  if not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  perform 1 from public.cases where id = p_case for update;
  b := public.case_cancel_blockers(p_case);
  if (b ->> 'confirmed_lines')::int > 0 then
    raise exception 'cancel_blocked_confirmed: % confirmed booking(s)', b ->> 'confirmed_lines' using errcode = 'P0001';
  end if;
  if (b ->> 'pending_lines')::int > 0 and (b ->> 'supplier_paid')::numeric <> 0 then
    raise exception 'cancel_blocked_supplier_paid' using errcode = 'P0001';
  end if;
  update public.cases set status = 'cancelled', cancel_reason = trim(p_reason) where id = p_case;
  -- pending bookings were never bought: they close at zero, and any advance shows as a client credit
  update public.booking_lines
     set status = 'cancelled', cancel_reason = 'Case cancelled before booking', refund_to_client = selling_price, refund_from_supplier = supplier_cost
   where case_id = p_case and status = 'pending';
  return b;
end $$;

-- ============================================================ A3 airport time zones (only where the zone is certain)
update public.lookups set extra = extra || '{"tz":"Asia/Kolkata"}'::jsonb
 where kind = 'airport' and extra ->> 'country' = 'IN' and not (extra ? 'tz');
update public.lookups l set extra = l.extra || jsonb_build_object('tz', z.tz)
from (values ('DXB','Asia/Dubai'),('AUH','Asia/Dubai'),('SHJ','Asia/Dubai'),('DOH','Asia/Qatar'),('MCT','Asia/Muscat'),
             ('BAH','Asia/Bahrain'),('KWI','Asia/Kuwait'),('RUH','Asia/Riyadh'),('JED','Asia/Riyadh'),('SIN','Asia/Singapore'),
             ('BKK','Asia/Bangkok'),('HKT','Asia/Bangkok'),('KUL','Asia/Kuala_Lumpur'),('CMB','Asia/Colombo'),('MLE','Indian/Maldives'),
             ('KTM','Asia/Kathmandu'),('DAC','Asia/Dhaka'),('HKG','Asia/Hong_Kong'),('DPS','Asia/Makassar'),('SGN','Asia/Ho_Chi_Minh'),
             ('HAN','Asia/Bangkok'),('LHR','Europe/London'),('CDG','Europe/Paris'),('FRA','Europe/Berlin'),('AMS','Europe/Amsterdam'),
             ('ZRH','Europe/Zurich'),('IST','Europe/Istanbul'),('JFK','America/New_York'),('EWR','America/New_York'),
             ('SFO','America/Los_Angeles'),('ORD','America/Chicago'),('YYZ','America/Toronto'),('SYD','Australia/Sydney'),
             ('MEL','Australia/Melbourne'),('NRT','Asia/Tokyo')) z(code, tz)
where l.kind = 'airport' and l.value = z.code and not (l.extra ? 'tz');
-- HAN is in Vietnam (UTC+7, no daylight saving), the same offset as Asia/Bangkok; prefer the Vietnamese zone name when present
update public.lookups set extra = extra || '{"tz":"Asia/Ho_Chi_Minh"}'::jsonb
 where kind = 'airport' and value = 'HAN' and exists (select 1 from pg_timezone_names where name = 'Asia/Ho_Chi_Minh');

-- ============================================================ A4 issued ticket identity + A3 sector checks
-- Backfill first, without firing the activity log or reminder triggers: every ticket that already has a number keeps
-- the name currently stored beside it as the issued name. (Older versions rewrote that name on profile edits, so for
-- tickets edited before this migration it is the best record available, not proof of the issued spelling.)
alter table public.booking_lines disable trigger user;
update public.booking_lines l
set details = jsonb_set(l.details, '{tickets}', (
  select coalesce(jsonb_agg(
    case when coalesce(t ->> 'number', '') <> '' and coalesce(t ->> 'name_as_issued', '') = '' and coalesce(t ->> 'passenger', '') <> ''
         then t || jsonb_build_object('name_as_issued', t ->> 'passenger', 'source', 'manual', 'issued_name_backfilled', true)
         else t end), '[]'::jsonb)
  from jsonb_array_elements(l.details -> 'tickets') t))
where l.service = 'flight' and jsonb_typeof(l.details -> 'tickets') = 'array' and jsonb_array_length(l.details -> 'tickets') > 0;
alter table public.booking_lines enable trigger user;

create or replace function private.ticket_digits(p text) returns text
language sql immutable as $$ select regexp_replace(coalesce(p, ''), '\D', '', 'g') $$;

create or replace function private.flight_identity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.details, '{}'::jsonb);
  od jsonb := case when tg_op = 'UPDATE' then coalesce(old.details, '{}'::jsonb) else '{}'::jsonb end;
  hist jsonb := case when jsonb_typeof(od -> 'ticket_history') = 'array' then od -> 'ticket_history' else '[]'::jsonb end;
  shist jsonb := case when jsonb_typeof(od -> 'sector_history') = 'array' then od -> 'sector_history' else '[]'::jsonb end;
  old_by jsonb := '{}'::jsonb;
  newt jsonb := '[]'::jsonb;
  t jsonb; o jsonb; s jsonb; num text; dep date; arr date; had_issued boolean := false; i int := 0;
begin
  if new.service <> 'flight' then return new; end if;

  -- sectors: explicit arrival date and time zones are checked, never invented
  for s in select value from jsonb_array_elements(case when jsonb_typeof(d -> 'sectors') = 'array' then d -> 'sectors' else '[]'::jsonb end) loop
    i := i + 1;
    if coalesce(s ->> 'arr_date', '') <> '' then
      begin
        arr := (s ->> 'arr_date')::date;
      exception when others then
        raise exception 'sector_arrival_date: sector % has an arrival date that is not a date', i using errcode = 'P0001';
      end;
      dep := nullif(s ->> 'date', '')::date;
      -- crossing the date line westwards can land the calendar day before; nothing scheduled lands 4+ days later
      if dep is not null and (arr < dep - 1 or arr > dep + 3) then
        raise exception 'sector_arrival_date: sector % arrives % but departs %', i, arr, dep using errcode = 'P0001';
      end if;
    end if;
    if coalesce(s ->> 'dep_tz', '') <> '' and not exists (select 1 from pg_timezone_names where name = s ->> 'dep_tz') then
      raise exception 'sector_timezone: sector % has an unknown departure time zone', i using errcode = 'P0001';
    end if;
    if coalesce(s ->> 'arr_tz', '') <> '' and not exists (select 1 from pg_timezone_names where name = s ->> 'arr_tz') then
      raise exception 'sector_timezone: sector % has an unknown arrival time zone', i using errcode = 'P0001';
    end if;
  end loop;

  -- tickets: the issued name and its source stay with the ticket number for good
  for o in select value from jsonb_array_elements(case when jsonb_typeof(od -> 'tickets') = 'array' then od -> 'tickets' else '[]'::jsonb end) loop
    num := private.ticket_digits(o ->> 'number');
    if num <> '' then old_by := old_by || jsonb_build_object(num, o); had_issued := true; end if;
  end loop;
  for t in select value from jsonb_array_elements(case when jsonb_typeof(d -> 'tickets') = 'array' then d -> 'tickets' else '[]'::jsonb end) loop
    num := private.ticket_digits(t ->> 'number');
    if num <> '' then
      o := old_by -> num;
      if o is not null and coalesce(o ->> 'name_as_issued', '') <> '' then
        t := t || jsonb_build_object('name_as_issued', o -> 'name_as_issued');
        t := t || jsonb_strip_nulls(jsonb_build_object('source', o -> 'source', 'import_id', o -> 'import_id',
                                                       'issued_name_backfilled', o -> 'issued_name_backfilled'));
      elsif coalesce(t ->> 'name_as_issued', '') = '' and coalesce(t ->> 'passenger', '') <> '' then
        t := t || jsonb_build_object('name_as_issued', t ->> 'passenger');
      end if;
      if coalesce(t ->> 'source', '') = '' then t := t || '{"source":"manual"}'::jsonb; end if;
      if o is not null then old_by := old_by - num; end if;
    end if;
    newt := newt || jsonb_build_array(t);
  end loop;
  -- a ticket that disappeared (removed, or replaced by a reissue under a new number) is kept, never lost
  for o in select value from jsonb_each(old_by) loop
    hist := hist || jsonb_build_array(o || jsonb_build_object('superseded_at', now(), 'superseded_by', auth.uid()));
  end loop;
  -- once tickets exist, any change to the flights themselves keeps the previous itinerary
  if tg_op = 'UPDATE' and had_issued and
     (select coalesce(jsonb_agg(jsonb_build_array(x ->> 'from', x ->> 'to', x ->> 'date', x ->> 'flight_no', x ->> 'dep', x ->> 'arr', x ->> 'arr_date')), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(od -> 'sectors') = 'array' then od -> 'sectors' else '[]'::jsonb end) x)
     is distinct from
     (select coalesce(jsonb_agg(jsonb_build_array(x ->> 'from', x ->> 'to', x ->> 'date', x ->> 'flight_no', x ->> 'dep', x ->> 'arr', x ->> 'arr_date')), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(d -> 'sectors') = 'array' then d -> 'sectors' else '[]'::jsonb end) x) then
    shist := shist || jsonb_build_array(jsonb_build_object('superseded_at', now(), 'superseded_by', auth.uid(), 'sectors', od -> 'sectors'));
  end if;

  if d ? 'tickets' or jsonb_array_length(newt) > 0 then d := jsonb_set(d, '{tickets}', newt); end if;
  -- history is written only here: whatever a caller sent for it is ignored
  d := d - 'ticket_history' - 'sector_history';
  if jsonb_array_length(hist) > 0 then d := d || jsonb_build_object('ticket_history', hist); end if;
  if jsonb_array_length(shist) > 0 then d := d || jsonb_build_object('sector_history', shist); end if;
  new.details := d;
  return new;
end $$;
drop trigger if exists t_flight_identity on public.booking_lines;
create trigger t_flight_identity before insert or update on public.booking_lines
  for each row execute function private.flight_identity();

-- profile edits change the display name only; the issued name is never touched
create or replace function private.rename_in_tickets() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.full_name is distinct from old.full_name then
    update public.booking_lines l
    set details = jsonb_set(l.details, '{tickets}', (
      select jsonb_agg(case when t ->> 'customer_id' = new.id::text then t || jsonb_build_object('passenger', new.full_name) else t end)
      from jsonb_array_elements(l.details -> 'tickets') t))
    where new.id = any(l.traveller_ids) and jsonb_typeof(l.details -> 'tickets') = 'array' and jsonb_array_length(l.details -> 'tickets') > 0;
  end if;
  return null;
end $$;

-- the client sees the issued name next to each ticket, and explicit arrival dates
create or replace function private.portal_details(svc text, d jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(case svc
    when 'flight' then jsonb_build_object('trip_type', d -> 'trip_type', 'cabin', d -> 'cabin', 'pnr', d -> 'pnr',
         'baggage', d -> 'baggage', 'refundable', d -> 'refundable',
         'sectors', (select jsonb_agg(jsonb_build_object('from', s -> 'from', 'to', s -> 'to', 'date', s -> 'date', 'airline', s -> 'airline',
                       'flight_no', s -> 'flight_no', 'dep', s -> 'dep', 'arr', s -> 'arr', 'arr_date', s -> 'arr_date',
                       'cabin', s -> 'cabin', 'baggage', s -> 'baggage'))
                     from jsonb_array_elements(coalesce(d -> 'sectors', '[]')) s),
         'tickets', (select jsonb_agg(jsonb_build_object('passenger', coalesce(t -> 'name_as_issued', t -> 'passenger'), 'number', t -> 'number'))
                     from jsonb_array_elements(coalesce(d -> 'tickets', '[]')) t))
    when 'hotel' then jsonb_build_object('hotel_name', d -> 'hotel_name', 'city', d -> 'city', 'check_in', d -> 'check_in',
         'check_out', d -> 'check_out', 'nights', d -> 'nights', 'rooms', d -> 'rooms', 'room_type', d -> 'room_type',
         'meal_plan', d -> 'meal_plan', 'adults', d -> 'adults', 'children', d -> 'children',
         'confirmation_no', d -> 'confirmation_no', 'free_cancel_until', d -> 'free_cancel_until')
    when 'insurance' then jsonb_build_object('insurer', d -> 'insurer', 'plan', d -> 'plan', 'policy_no', d -> 'policy_no',
         'start_date', d -> 'start_date', 'end_date', d -> 'end_date', 'sum_insured', d -> 'sum_insured', 'region', d -> 'region')
    when 'rail' then jsonb_build_object('train_no', d -> 'train_no', 'train_name', d -> 'train_name', 'from', d -> 'from', 'to', d -> 'to',
         'date', d -> 'date', 'class', d -> 'class', 'quota', d -> 'quota', 'pnr', d -> 'pnr', 'coach', d -> 'coach',
         'berth', d -> 'berth', 'rail_status', d -> 'rail_status')
    when 'bus' then jsonb_build_object('operator', d -> 'operator', 'from', d -> 'from', 'to', d -> 'to', 'date', d -> 'date',
         'boarding_point', d -> 'boarding_point', 'boarding_time', d -> 'boarding_time', 'drop_point', d -> 'drop_point',
         'bus_type', d -> 'bus_type', 'seats', d -> 'seats', 'ticket_no', d -> 'ticket_no')
    when 'visa' then jsonb_build_object('country', d -> 'country', 'visa_type', d -> 'visa_type', 'mode', d -> 'mode',
         'entry', d -> 'entry', 'application_status', d -> 'application_status', 'appointment_date', d -> 'appointment_date',
         'appointment_time', d -> 'appointment_time', 'appointment_center', d -> 'appointment_center', 'applied_on', d -> 'applied_on',
         'expected_by', d -> 'expected_by', 'application_no', d -> 'application_no', 'visa_number', d -> 'visa_number',
         'valid_from', d -> 'valid_from', 'valid_to', d -> 'valid_to', 'stay_days', d -> 'stay_days', 'documents', d -> 'documents',
         'checklist', d -> 'checklist', 'passport_with_us', d -> 'passport_with_us', 'refusal_reason', d -> 'refusal_reason')
    else jsonb_build_object('title', d -> 'title', 'description', d -> 'description') end)
$$;

-- ============================================================ A8 money
-- 'entered' = someone typed the prices (zero included); 'not_entered' = nobody has priced it yet (e.g. made from an import).
alter table public.booking_lines add column if not exists pricing_state text not null default 'entered'
  check (pricing_state in ('entered', 'not_entered'));

create or replace function private.line_compute() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.details, '{}'::jsonb);
  n int;
  codes text;
  credit int;
  is_credit boolean;
  bf text;
begin
  -- airline commission is paid on the base fare. Missing base fare: use the supplier cost. Zero: zero. Text: refused.
  bf := nullif(trim(coalesce(d ->> 'base_fare', '')), '');
  if bf is not null and bf !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception 'invalid_amount: the base fare "%" is not a number', left(bf, 30) using errcode = 'P0001';
  end if;
  new.commission_amount := case when new.commission_type = 'percent'
                                then round(coalesce(bf::numeric, new.supplier_cost) * new.commission_value / 100, 2)
                                else new.commission_value end;

  if new.service = 'flight' then
    n := jsonb_array_length(coalesce(d -> 'sectors', '[]'::jsonb));
    if n > 0 then
      new.service_date := nullif(d -> 'sectors' -> 0 ->> 'date', '')::date;
      if d ->> 'trip_type' = 'return' and n = 2 then
        codes := upper(coalesce(d -> 'sectors' -> 0 ->> 'from', '')) || ' ⇄ ' || upper(coalesce(d -> 'sectors' -> 0 ->> 'to', ''));
      else
        select string_agg(upper(coalesce(s ->> 'from', '')), ' → ' order by o) || ' → ' || upper(coalesce(d -> 'sectors' -> (n - 1) ->> 'to', ''))
          into codes from jsonb_array_elements(d -> 'sectors') with ordinality t(s, o);
      end if;
      new.summary := codes;
    end if;
  elsif new.service = 'hotel' then
    if coalesce(d ->> 'check_in', '') <> '' and coalesce(d ->> 'check_out', '') <> '' then
      d := jsonb_set(d, '{nights}', to_jsonb((d ->> 'check_out')::date - (d ->> 'check_in')::date));
    end if;
    new.service_date := nullif(d ->> 'check_in', '')::date;
    new.summary := concat_ws(', ', nullif(d ->> 'hotel_name', ''), nullif(d ->> 'city', ''));
  elsif new.service = 'insurance' then
    new.service_date := nullif(d ->> 'start_date', '')::date;
    new.summary := concat_ws(' ', nullif(d ->> 'insurer', ''), nullif(d ->> 'plan', ''));
  elsif new.service in ('rail', 'bus') then
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := concat_ws(' ', nullif(coalesce(d ->> 'train_no', d ->> 'operator'), ''),
                     nullif(upper(coalesce(d ->> 'from', '')) || ' → ' || upper(coalesce(d ->> 'to', '')), ' → '));
  elsif new.service = 'visa' then
    new.service_date := coalesce(nullif(d ->> 'appointment_date', '')::date, nullif(d ->> 'applied_on', '')::date);
    new.summary := concat_ws(' ', nullif(d ->> 'country', ''), nullif(d ->> 'visa_type', ''), 'visa');
    if new.status <> 'cancelled' then
      new.status := case when d ->> 'application_status' in ('Approved', 'Passport collected') then 'confirmed' else 'pending' end;
    end if;
  else
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := nullif(d ->> 'title', '');
  end if;
  new.details := d;

  -- references are strings; airline PNR, supplier/GDS reference and every ticket number are all searchable
  new.search_refs := upper(concat_ws(' ', new.reference, d ->> 'pnr', d ->> 'supplier_ref', d ->> 'gds_pnr', d ->> 'policy_no',
                      d ->> 'confirmation_no', d ->> 'ticket_no', d ->> 'application_no', d ->> 'visa_number',
                      (select string_agg(t ->> 'number', ' ') from jsonb_array_elements(coalesce(d -> 'tickets', '[]'::jsonb)) t)));

  if new.supplier_due_date is null and new.supplier_id is not null then
    select terms = 'credit', credit_days into is_credit, credit from public.suppliers where id = new.supplier_id;
    new.supplier_due_date := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date + case when is_credit then coalesce(credit, 0) else 0 end;
  end if;

  if new.status = 'cancelled' then
    new.cancellation_charge := greatest(new.supplier_cost - coalesce(new.refund_from_supplier, 0), 0);
  end if;
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end $$;

-- ============================================================ grants
revoke execute on function public.customer_case_history(uuid) from public, anon;
revoke execute on function public.set_case_travellers(uuid, uuid[]) from public, anon;
revoke execute on function public.create_case(jsonb, uuid[], text) from public, anon;
revoke execute on function public.cancel_case(uuid, text) from public, anon;
grant execute on function public.customer_case_history(uuid) to authenticated;
grant execute on function public.set_case_travellers(uuid, uuid[]) to authenticated;
grant execute on function public.create_case(jsonb, uuid[], text) to authenticated;
grant execute on function public.cancel_case(uuid, text) to authenticated;
grant select, insert on public.case_requests to authenticated;
revoke all on public.case_requests from anon;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
