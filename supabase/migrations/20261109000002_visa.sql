-- Visa processing as a service: application tracking, appointment reminders,
-- auto-copy of approved visas to traveller profiles, and a clean portal view.

alter table public.booking_lines drop constraint booking_lines_service_check;
alter table public.booking_lines add constraint booking_lines_service_check
  check (service in ('flight','hotel','insurance','rail','bus','visa','other'));

alter table public.files drop constraint files_kind_check;
alter table public.files add constraint files_kind_check
  check (kind in ('ticket','voucher','policy','visa','document','agreement','rate_sheet','other'));

alter table public.lookups drop constraint lookups_kind_check;
alter table public.lookups add constraint lookups_kind_check
  check (kind in ('airline','hotel_chain','insurer','city','airport','lead_source','document_type','country'));

insert into public.lookups (kind, value, extra, sort)
select 'country', v, '{}'::jsonb, o::int - 1 from unnest(array[
  'United Arab Emirates','Thailand','Singapore','Malaysia','Schengen (Europe)','United Kingdom','United States','Canada','Australia',
  'New Zealand','Japan','Vietnam','Indonesia (Bali)','Sri Lanka','Maldives','Turkey','Saudi Arabia','Oman','Qatar','Egypt','Azerbaijan',
  'Georgia','Kenya','South Africa','Mauritius','Hong Kong','China','South Korea','Russia','Kazakhstan','Uzbekistan','Cambodia','Philippines'
]) with ordinality t(v, o);

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
    new.summary := concat_ws(' ', nullif(d ->> 'country', ''), nullif(d ->> 'visa_type', ''), 'visa')
                   || coalesce(' · ' || nullif(d ->> 'application_status', ''), '');
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
         'valid_from', d -> 'valid_from', 'valid_to', d -> 'valid_to', 'stay_days', d -> 'stay_days', 'documents', d -> 'documents')
    else jsonb_build_object('title', d -> 'title', 'description', d -> 'description') end)
$$;

create or replace function private.line_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare intl boolean; d jsonb := coalesce(new.details, '{}'); od jsonb; appt date; t time; owner uuid; cfg jsonb;
begin
  if new.service = 'visa' and new.status <> 'cancelled' then
    od := case when tg_op = 'UPDATE' then coalesce(old.details, '{}') else '{}' end;
    cfg := (select auto_reminders from public.settings where id = 1);
    owner := private.case_owner(new.case_id);
    -- reminder the day before the VFS/embassy appointment (same day if booked for today/tomorrow)
    appt := nullif(d ->> 'appointment_date', '')::date;
    if appt is not null and appt >= (now() at time zone 'Asia/Kolkata')::date
       and coalesce((cfg ->> 'passport_visa')::boolean, true)
       and (tg_op = 'INSERT' or (d ->> 'appointment_date') is distinct from (od ->> 'appointment_date')) then
      t := coalesce(nullif(d ->> 'appointment_time', '')::time, time '10:00');
      insert into public.tasks (case_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
      values (new.case_id,
              'Visa appointment ' || to_char(appt, 'DD-MM-YYYY') || coalesce(' ' || to_char(nullif(d ->> 'appointment_time', '')::time, 'HH24:MI'), '')
                || ': ' || coalesce(d ->> 'country', '') || coalesce(' at ' || nullif(d ->> 'appointment_center', ''), ''),
              owner,
              greatest(((appt - 1) + time '10:00') at time zone 'Asia/Kolkata', now() + interval '5 minutes'),
              'high', 'due', 'Remind the client to carry the original passport and the documents on the checklist.',
              'visaappt:' || new.id || ':' || appt, null)
      on conflict (auto_key) do nothing;
    end if;
    -- once approved, copy the visa onto each traveller's profile so expiry reminders cover it
    if d ->> 'application_status' in ('Approved', 'Passport collected') and coalesce(d ->> 'valid_to', '') <> ''
       and (tg_op = 'INSERT' or (od ->> 'application_status') is distinct from (d ->> 'application_status')
            or (od ->> 'valid_to') is distinct from (d ->> 'valid_to') or (od ->> 'visa_number') is distinct from (d ->> 'visa_number')) then
      update public.customers c
         set visas = (select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(c.visas) v
                       where (v ->> 'source_line') is distinct from new.id::text)
                     || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                          'country', d ->> 'country', 'type', d ->> 'visa_type', 'number', nullif(d ->> 'visa_number', ''),
                          'issue', nullif(d ->> 'valid_from', ''), 'expiry', d ->> 'valid_to', 'entry', nullif(d ->> 'entry', ''),
                          'source_line', new.id::text)))
       where c.id = any(new.traveller_ids);
    end if;
  end if;

  if new.service = 'flight' then
    intl := private.is_intl_flight(new.details);
    if intl then
      update public.cases set is_international = true where id = new.case_id and not is_international;
      if coalesce((select (auto_reminders ->> 'no_insurance')::boolean from public.settings where id = 1), true)
         and new.status <> 'cancelled'
         and not exists (select 1 from public.booking_lines x where x.case_id = new.case_id and x.service = 'insurance' and x.status <> 'cancelled') then
        perform private.add_auto_task('noins:' || new.case_id, 'International trip without travel insurance: offer a policy',
          new.case_id, null, private.case_owner(new.case_id));
      end if;
    end if;
  end if;
  return null;
end $$;
