-- A case completes by itself once it is booked and fully paid with no task left (owner's rule, 2026-11-13).
-- Walks the owner's own flow: task with a new case → book the ticket → mark the task done → payments.
-- Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(14);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000004b1', 'boss@done.local',   '{"role":"boss","full_name":"Done Boss"}'),
  ('00000000-0000-0000-0000-0000000004a1', 'staffa@done.local', '{"role":"staff","full_name":"Done A"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile) values
  ('00000000-0000-0000-0000-00000004c001', 'individual', 'Done', 'Tester', '+919000004001');
insert into public.suppliers (id, name) values ('00000000-0000-0000-0000-00000004d001', 'Test Air Supplier');
update public.settings set auto_reminders = auto_reminders || '{"stage_tasks":true,"auto_stage":true,"auto_complete":true}'::jsonb where id = 1;

-- ---------------------------------------------------------------- 1. a task with a new case, then the ticket is booked
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000004a1","role":"authenticated"}';
insert into r select 'case', public.create_task_with_case('{"title":"Book Delhi ticket"}', '{"customer_id":"00000000-0000-0000-0000-00000004c001"}', '{}', 'done-key-0001') ->> 'id';
insert into public.booking_lines (case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details)
select v::uuid, 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000004d001', 8000, 10000, 0, '{"title":"Delhi ticket"}' from r where k = 'case';
insert into r select 'after_booking', status from public.cases where id = (select v::uuid from r where k = 'case');
insert into r select 'left_after_booking', (select string_agg(x ->> 'key', ',' order by x ->> 'key') from jsonb_array_elements(public.case_finish_items((select v::uuid from r where k = 'case'))) x where not (x ->> 'ok')::boolean);
-- 2. the task is marked done: still not complete, the client hasn't paid
update public.tasks set status = 'done' where case_id = (select v::uuid from r where k = 'case') and auto_key is null;
insert into r select 'after_task', status from public.cases where id = (select v::uuid from r where k = 'case');
reset role; reset request.jwt.claims;

select is((select v from r where k = 'after_booking'), 'booked', 'a confirmed booking moves the case to Booked');
select is((select v from r where k = 'left_after_booking'), 'client,supplier,tasks', 'the case lists what is left: client payment, supplier payment, tasks');
select is((select v from r where k = 'after_task'), 'booked', 'with money still due, finishing the task does not complete the case');
select is((select title from public.tasks where case_id = (select v::uuid from r where k = 'case') and auto_key like 'stage:%' and status <> 'done'),
  'Send the tickets and vouchers to the customer', 'Booked adds one step: send the tickets');

-- ---------------------------------------------------------------- 3. the money comes in, the tickets are sent
insert into public.payments (direction, case_id, amount, mode) select 'in', v::uuid, 10000, 'upi' from r where k = 'case';
insert into public.payments (id, direction, supplier_id, amount, mode) values ('00000000-0000-0000-0000-00000004e001', 'out', '00000000-0000-0000-0000-00000004d001', 8000, 'bank');
select private.add_auto_task('noins:' || v, 'Offer insurance', v::uuid, null, '00000000-0000-0000-0000-0000000004a1') from r where k = 'case';
insert into public.payment_allocations (payment_id, case_id, amount) select '00000000-0000-0000-0000-00000004e001', v::uuid, 8000 from r where k = 'case';
select is((select status from public.cases where id = (select v::uuid from r where k = 'case')), 'booked', 'still open while "send the tickets" is not done');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000004a1","role":"authenticated"}';
update public.tasks set status = 'done' where case_id = (select v::uuid from r where k = 'case') and auto_key like 'stage:%' and status <> 'done';
reset role; reset request.jwt.claims;
select is((select status from public.cases where id = (select v::uuid from r where k = 'case')), 'completed', 'booked, fully paid, no task left: the case completes by itself');
select is((select status from public.tasks where auto_key = 'noins:' || (select v from r where k = 'case')), 'todo', 'an automatic suggestion does not hold the case open, and is not thrown away');
select ok(exists (select 1 from public.activity_log where case_id = (select v::uuid from r where k = 'case') and action = 'complete'), 'the automatic completion is recorded');

-- ---------------------------------------------------------------- 4. payment first: Confirmed tasks close when their job is done
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000004ca5e2', '00000000-0000-0000-0000-00000004c001', 'Advance first', '00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004a1', 'enquiry');
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000004b0002', '00000000-0000-0000-0000-0000004ca5e2', 'other', 'pending', '{}', 0, 5000, 0, '{"title":"Hotel"}');
insert into public.payments (direction, case_id, amount, mode) values ('in', '00000000-0000-0000-0000-0000004ca5e2', 2000, 'cash');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000004ca5e2'), 'confirmed', 'an advance moves the case to Confirmed');
select is((select status from public.tasks t join public.stage_tasks s on t.auto_key = 'stage:' || t.case_id || ':' || s.id
            where t.case_id = '00000000-0000-0000-0000-0000004ca5e2' and s.done_when = 'client_paid_any'), 'done',
  '"Collect the advance payment" is already done when the advance moved the case to Confirmed');
update public.booking_lines set status = 'confirmed' where id = '00000000-0000-0000-0000-0000004b0002';
select is((select status from public.tasks t join public.stage_tasks s on t.auto_key = 'stage:' || t.case_id || ':' || s.id
            where t.case_id = '00000000-0000-0000-0000-0000004ca5e2' and s.done_when = 'bookings_confirmed'), 'done',
  '"Make the bookings" closes once every booking is confirmed');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000004ca5e2'), 'booked', 'with ₹3,000 still due it stays Booked');

-- ---------------------------------------------------------------- 5. a pending booking keeps the case open; the switch turns the rule off
insert into public.payments (direction, case_id, amount, mode) values ('in', '00000000-0000-0000-0000-0000004ca5e2', 3000, 'cash');
update public.tasks set status = 'done' where case_id = '00000000-0000-0000-0000-0000004ca5e2' and status <> 'done';
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000004ca5e2'), 'completed', 'paid in full and tasks done: completed');

update public.settings set auto_reminders = auto_reminders || '{"auto_complete":false}'::jsonb where id = 1;
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000004ca5e3', '00000000-0000-0000-0000-00000004c001', 'Rule off', '00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004a1', 'booked');
update public.tasks set status = 'done' where case_id = '00000000-0000-0000-0000-0000004ca5e3';
insert into public.booking_lines (case_id, service, status, traveller_ids, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000004ca5e3', 'other', 'confirmed', '{}', 0, 0, 0, '{"title":"Free"}');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000004ca5e3'), 'booked', 'with the setting off, nothing completes by itself');

select * from finish();
rollback;
