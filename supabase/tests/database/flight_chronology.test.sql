-- Flight chronology checks use synthetic rows and roll back all changes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(15);

select has_trigger('public', 'booking_lines', 't_guard_flight_chronology', 'booking writes enforce flight chronology');
create temp table flight_chronology_inputs (label text, service text default 'flight', status text default 'pending', details jsonb);
-- A pending booking entered before this validation existed.
insert into flight_chronology_inputs(label, details) values ('legacy', '{"sectors":[{"from":"HYD","to":"BOM","date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"09:00","arr_tz":"Asia/Kolkata"}]}');
create trigger t_guard_flight_chronology before insert or update of details, service, status on flight_chronology_inputs
  for each row execute function private.guard_flight_chronology();

-- The same function attached to booking_lines is exercised without other booking side effects.
select throws_ok($q$
  insert into flight_chronology_inputs(status, details) values ('confirmed', '{"sectors":[{"from":"HYD","to":"BOM","date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"09:00","arr_tz":"Asia/Kolkata"}]}')
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'arrival before departure is refused');

select throws_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"10:00","arr_tz":"Asia/Kolkata"}]}')
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'zero elapsed flying time is refused');

select throws_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"from":"HYD","to":"BOM","date":"2026-11-21","dep":"10:00","arr_date":"2026-11-21","arr":"09:00"}]}')
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'known airport zones cover writes that omit explicit zones');

select lives_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"09:30","arr_tz":"Asia/Dubai"}]}')
$q$, 'an earlier local arrival clock can be after departure in UTC');

select lives_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"date":"2026-11-21","dep":"23:30","dep_tz":"Asia/Kolkata","arr_date":"2026-11-22","arr":"01:15","arr_tz":"Asia/Dubai"}]}')
$q$, 'overnight flights remain valid');

select lives_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"date":"2026-11-21","dep":"00:30","dep_tz":"Asia/Tokyo","arr_date":"2026-11-20","arr":"13:00","arr_tz":"Pacific/Honolulu"}]}')
$q$, 'a date-line crossing can arrive on the previous local date');

select lives_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"from":"HYD","to":"BOM","date":"2026-11-21","dep":"23:30","arr":"01:15"}]}')
$q$, 'legacy arrivals without a date remain editable');

select lives_ok($q$
  insert into flight_chronology_inputs(details) values ('{"sectors":[{"from":"XXX","to":"ZZZ","date":"2026-11-21","dep":"10:00","arr_date":"2026-11-21","arr":"09:00"}]}')
$q$, 'unknown airport zones do not invent chronology');

select throws_ok($q$
  update flight_chronology_inputs set details = '{"sectors":[{"date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"09:00","arr_tz":"Asia/Kolkata"}]}'
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'editing an existing sector also enforces chronology');

select lives_ok($q$
  insert into flight_chronology_inputs(service, details) values ('other', '{"sectors":[{"date":"2026-11-21","dep":"10:00","dep_tz":"Asia/Kolkata","arr_date":"2026-11-21","arr":"09:00","arr_tz":"Asia/Kolkata"}]}')
$q$, 'other services are unaffected');

select throws_ok($q$
  update flight_chronology_inputs set status = 'confirmed' where label = 'legacy'
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'status-only confirmation validates old pending bookings');

select is((select status from flight_chronology_inputs where label = 'legacy'), 'pending', 'a rejected confirmation leaves the booking pending');

select lives_ok($q$
  update flight_chronology_inputs set status = 'cancelled' where label = 'legacy'
$q$, 'a legacy booking with invalid chronology can still be cancelled');

select throws_ok($q$
  update flight_chronology_inputs set status = 'pending' where label = 'legacy'
$q$, 'P0001', 'sector_chronology: Sector 1 arrival must be after departure. Check the dates, times and time zones.', 'reactivating a cancelled invalid booking validates chronology again');

select * from finish();
rollback;
