-- Visa made simple: status drives the booking status, tick-box checklist in the portal,
-- and three plain-language reminders.

create or replace function private.line_compute() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.details, '{}'::jsonb);
  n int;
  codes text;
  credit int;
  is_credit boolean;
begin
  new.commission_amount := case when new.commission_type = 'percent'
                                then round(new.supplier_cost * new.commission_value / 100, 2)
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
    -- one status for beginners: the booking is confirmed once the visa is approved
    if new.status <> 'cancelled' then
      new.status := case when d ->> 'application_status' in ('Approved', 'Passport collected') then 'confirmed' else 'pending' end;
    end if;
  else
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := nullif(d ->> 'title', '');
  end if;
  new.details := d;

  new.search_refs := upper(concat_ws(' ', new.reference, d ->> 'pnr', d ->> 'supplier_ref', d ->> 'policy_no',
                      d ->> 'confirmation_no', d ->> 'ticket_no', d ->> 'application_no', d ->> 'visa_number',
                      (select string_agg(t ->> 'number', ' ') from jsonb_array_elements(coalesce(d -> 'tickets', '[]'::jsonb)) t)));

  if new.supplier_due_date is null and new.supplier_id is not null then
    select terms = 'credit', credit_days into is_credit, credit from public.suppliers where id = new.supplier_id;
    new.supplier_due_date := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date + case when is_credit then coalesce(credit, 0) else 0 end;
  end if;

  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end $$;

create or replace function private.portal_details(svc text, d jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(case svc
    when 'flight' then jsonb_build_object('trip_type', d -> 'trip_type', 'cabin', d -> 'cabin', 'pnr', d -> 'pnr',
         'baggage', d -> 'baggage', 'refundable', d -> 'refundable',
         'sectors', (select jsonb_agg(jsonb_build_object('from', s -> 'from', 'to', s -> 'to', 'date', s -> 'date', 'airline', s -> 'airline',
                       'flight_no', s -> 'flight_no', 'dep', s -> 'dep', 'arr', s -> 'arr')) from jsonb_array_elements(coalesce(d -> 'sectors', '[]')) s),
         'tickets', (select jsonb_agg(jsonb_build_object('passenger', t -> 'passenger', 'number', t -> 'number'))
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

create or replace function public.run_visa_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare r record; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not coalesce((select (auto_reminders ->> 'passport_visa')::boolean from public.settings where id = 1), true) then return; end if;
  for r in
    select l.id, l.case_id, l.details d, c.travel_start, cu.full_name
    from public.booking_lines l join public.cases c on c.id = l.case_id
    left join public.customers cu on cu.id = l.traveller_ids[1]
    where l.service = 'visa' and l.status <> 'cancelled' and c.status <> 'cancelled'
  loop
    -- documents still missing close to travel
    if coalesce(r.d ->> 'application_status', 'Documents pending') = 'Documents pending'
       and r.travel_start between today and today + 21 then
      perform private.add_auto_task('visadocs:' || r.id, 'Collect visa documents: ' || coalesce(r.full_name, '') || ' travels ' || to_char(r.travel_start, 'DD-MM-YYYY'),
        r.case_id, null, private.case_owner(r.case_id));
    end if;
    -- decision date has passed
    if r.d ->> 'application_status' in ('Applied', 'Appointment booked', 'Biometrics done', 'Under process')
       and nullif(r.d ->> 'expected_by', '')::date < today then
      perform private.add_auto_task('visalate:' || r.id || ':' || (r.d ->> 'expected_by'), 'Check visa status with the embassy: ' || coalesce(r.full_name, ''),
        r.case_id, null, private.case_owner(r.case_id));
    end if;
    -- we still hold the passport and the trip is a week away
    if coalesce((r.d ->> 'passport_with_us')::boolean, false) and r.travel_start between today and today + 7 then
      perform private.add_auto_task('visapp:' || r.id, 'Return passport to ' || coalesce(r.full_name, 'the client') || ' before the trip on ' || to_char(r.travel_start, 'DD-MM-YYYY'),
        r.case_id, null, private.case_owner(r.case_id));
    end if;
  end loop;
end $$;

revoke execute on function public.run_visa_reminders() from public, anon;
grant execute on function public.run_visa_reminders() to authenticated;
select cron.schedule('safar-visa-reminders', '35 0 * * *', 'select public.run_visa_reminders()');

-- existing visa lines: text checklist -> tick boxes, recompute status/summary
update public.booking_lines
   set details = details - 'documents'
       || jsonb_build_object('checklist', (select coalesce(jsonb_agg(jsonb_build_object('item', btrim(x), 'done', false)), '[]')
                                            from regexp_split_to_table(coalesce(details ->> 'documents', ''), '\n+') x where btrim(x) <> ''))
       || case when details ->> 'mode' = 'e-Visa' then '{"mode":"Online (e-Visa)"}'::jsonb
               when details ->> 'mode' = 'Embassy / sticker' then '{"mode":"Appointment at VFS / embassy"}'::jsonb else '{}'::jsonb end
 where service = 'visa' and details ? 'documents' and not details ? 'checklist';
