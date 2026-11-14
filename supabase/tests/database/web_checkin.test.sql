-- Web check-in tasks: one per booked flight, due 48 hours before departure, following the booking as it changes.
-- Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(10);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000008b1', 'boss@wci.local', '{"role":"boss","full_name":"Checkin Boss"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile) values
  ('00000000-0000-0000-0000-00000008c001', 'individual', 'Checkin', 'Tester', '+919000008001');
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000008ca5e1', '00000000-0000-0000-0000-00000008c001', 'Checkin trip', '00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008b1', 'booked');
insert into public.case_travellers values ('00000000-0000-0000-0000-0000008ca5e1', '00000000-0000-0000-0000-00000008c001');

-- a return trip ten days out: HYD 07:45 (India time) and DXB 23:40 (Dubai time)
create function pg_temp.sectors(p_back_dep text default '23:40') returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('from', 'HYD', 'to', 'DXB', 'date', to_char(current_date + 10, 'YYYY-MM-DD'), 'dep', '07:45', 'arr_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'arr', '10:20',
                       'flight_no', '6E 1465', 'dep_tz', 'Asia/Kolkata', 'arr_tz', 'Asia/Dubai'),
    jsonb_build_object('from', 'DXB', 'to', 'HYD', 'date', to_char(current_date + 15, 'YYYY-MM-DD'), 'dep', p_back_dep, 'arr_date', to_char(current_date + 16, 'YYYY-MM-DD'), 'arr', '04:50',
                       'flight_no', '6E 1408', 'dep_tz', 'Asia/Dubai', 'arr_tz', 'Asia/Kolkata'))
$$;
create function pg_temp.open_tasks(p_line text) returns int language sql as $$
  select count(*)::int from public.tasks where auto_key like 'webcheckin:' || p_line || ':%' and status <> 'done'
$$;

-- a pending itinerary gets nothing
insert into public.booking_lines (id, case_id, service, status, traveller_ids, details) values
  ('00000000-0000-0000-0000-0000008b0001', '00000000-0000-0000-0000-0000008ca5e1', 'flight', 'pending', '{00000000-0000-0000-0000-00000008c001}',
   jsonb_build_object('trip_type', 'return', 'sectors', pg_temp.sectors(), 'pnr', 'WCI001'));
select is(pg_temp.open_tasks('00000000-0000-0000-0000-0000008b0001'), 0, 'an itinerary that is not ticketed gets no check-in task');

-- ticket issued: one task per flight, 48 hours before departure in local time, for the case owner
update public.booking_lines set status = 'confirmed' where id = '00000000-0000-0000-0000-0000008b0001';
select is(pg_temp.open_tasks('00000000-0000-0000-0000-0000008b0001'), 2, 'a confirmed booking gets a check-in task for each flight');
select is((select due_at from public.tasks where auto_key like 'webcheckin:00000000-0000-0000-0000-0000008b0001:HYD-DXB:%'),
          ((current_date + 10)::text || ' 07:45')::timestamp at time zone 'Asia/Kolkata' - interval '48 hours', 'due 48 hours before departure from India');
select is((select due_at from public.tasks where auto_key like 'webcheckin:00000000-0000-0000-0000-0000008b0001:DXB-HYD:%' and status <> 'done'),
          ((current_date + 15)::text || ' 23:40')::timestamp at time zone 'Asia/Dubai' - interval '48 hours', 'the return is timed in Dubai local time');
select results_eq($$ select assigned_to::text, title, notes like '%Checkin Tester%' and notes like '%WCI001%' from public.tasks
                     where auto_key like 'webcheckin:00000000-0000-0000-0000-0000008b0001:HYD-DXB:%' $$,
  $$ values ('00000000-0000-0000-0000-0000000008b1'::text, 'Web check-in: 6E 1465 HYD→DXB ' || to_char(current_date + 10, 'DD-MM-YYYY') || ' 07:45', true) $$,
  'for the case owner, with flight, route, time, travellers and PNR');

-- the return flight is retimed: its old task closes, a new one is made; the outbound task is untouched
update public.booking_lines set details = jsonb_set(details, '{sectors}', pg_temp.sectors('21:10')) where id = '00000000-0000-0000-0000-0000008b0001';
select is(pg_temp.open_tasks('00000000-0000-0000-0000-0000008b0001'), 2, 'a changed flight still has exactly one open task per flight');
select ok((select notes from public.tasks where auto_key like 'webcheckin:00000000-0000-0000-0000-0000008b0001:DXB-HYD:%:23:40:%') like '%Closed automatically%',
  'the task for the old time is closed with a note');

-- cancelled: everything closes
update public.booking_lines set status = 'cancelled', cancel_reason = 'test', cancelled_at = now() where id = '00000000-0000-0000-0000-0000008b0001';
select is(pg_temp.open_tasks('00000000-0000-0000-0000-0000008b0001'), 0, 'a cancelled booking closes its check-in tasks');

-- booked inside 48 hours: due straight away
insert into public.booking_lines (id, case_id, service, status, traveller_ids, details) values
  ('00000000-0000-0000-0000-0000008b0002', '00000000-0000-0000-0000-0000008ca5e1', 'flight', 'confirmed', '{00000000-0000-0000-0000-00000008c001}',
   jsonb_build_object('trip_type', 'one-way', 'sectors', jsonb_build_array(jsonb_build_object('from', 'HYD', 'to', 'DEL',
     'date', to_char((now() + interval '30 hours') at time zone 'Asia/Kolkata', 'YYYY-MM-DD'), 'dep', to_char((now() + interval '30 hours') at time zone 'Asia/Kolkata', 'HH24:MI'),
     'flight_no', 'AI 1', 'dep_tz', 'Asia/Kolkata'))));
select ok((select due_at from public.tasks where auto_key like 'webcheckin:00000000-0000-0000-0000-0000008b0002:%') <= now(), 'a flight booked inside 48 hours is due now');

-- switched off in Settings: no new tasks
update public.settings set auto_reminders = auto_reminders || '{"web_checkin": false}' where id = 1;
insert into public.booking_lines (id, case_id, service, status, traveller_ids, details) values
  ('00000000-0000-0000-0000-0000008b0003', '00000000-0000-0000-0000-0000008ca5e1', 'flight', 'confirmed', '{00000000-0000-0000-0000-00000008c001}',
   jsonb_build_object('trip_type', 'return', 'sectors', pg_temp.sectors(), 'pnr', 'WCI003'));
select is(pg_temp.open_tasks('00000000-0000-0000-0000-0000008b0003'), 0, 'switched off in Settings, no check-in tasks are made');

select * from finish();
rollback;
