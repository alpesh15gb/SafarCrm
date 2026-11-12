-- Tasks → cases pipeline: stage tasks, automatic stage moves, one waiting follow-up, "no next step", task visibility.
-- Synthetic data only. One transaction, rolled back. The case summary is read as a signed-in user: it shows nothing to
-- someone who cannot open the case.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(26);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000001b1', 'boss@pipe.local',   '{"role":"boss","full_name":"Pipe Boss"}'),
  ('00000000-0000-0000-0000-0000000001a1', 'staffa@pipe.local', '{"role":"staff","full_name":"Pipe A"}'),
  ('00000000-0000-0000-0000-0000000001a2', 'staffb@pipe.local', '{"role":"staff","full_name":"Pipe B"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile) values
  ('00000000-0000-0000-0000-00000001c001', 'individual', 'Pipe', 'Tester', '+919000001001');
update public.settings set auto_reminders = auto_reminders || '{"stage_tasks":true,"auto_stage":true}'::jsonb where id = 1;

-- ---------------------------------------------------------------- a new enquiry gets its first step
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000001ca5e1', '00000000-0000-0000-0000-00000001c001', 'Pipeline trip', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001a1', 'enquiry');

select is((select string_agg(title, ',') from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' and status <> 'done'),
  'Send the quote', 'a new enquiry gets "Send the quote"');
select is((select assigned_to::text from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' limit 1),
  '00000000-0000-0000-0000-0000000001a1', 'the stage task belongs to the case owner');
select ok((select bool_and(due_at > now()) from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1'),
  'an automatic task is never created overdue');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000001a1","role":"authenticated"}';
insert into r select 'state_open', public.case_work_summary(array['00000000-0000-0000-0000-0000001ca5e1'::uuid]) -> 0 ->> 'state';
reset role; reset request.jwt.claims;
select is((select v from r where k = 'state_open'), 'up_to_date',
  'a case with an open task that is not late is on track');

-- ---------------------------------------------------------------- moving on closes quote work and adds the next step
update public.cases set status = 'quoted' where id = '00000000-0000-0000-0000-0000001ca5e1';
select is((select status from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' and title = 'Send the quote'), 'done',
  'moving to Quoted closes "Send the quote"');
select is((select string_agg(title, ',') from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' and status <> 'done'),
  'Follow up on the quote', 'Quoted creates the follow-up');

-- going back and forth never repeats a stage's tasks
update public.cases set status = 'enquiry' where id = '00000000-0000-0000-0000-0000001ca5e1';
update public.cases set status = 'quoted' where id = '00000000-0000-0000-0000-0000001ca5e1';
select is((select count(*)::int from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1'), 2,
  're-entering a stage does not create its tasks again');

-- ---------------------------------------------------------------- the first client payment confirms the case
insert into public.payments (direction, case_id, amount, mode) values ('in', '00000000-0000-0000-0000-0000001ca5e1', 5000, 'upi');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000001ca5e1'), 'confirmed',
  'a client payment moves an enquiry or quote to Confirmed');
select is((select count(*)::int from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' and status <> 'done'), 2,
  'Confirmed creates its two tasks and the quote follow-up is closed');

-- ---------------------------------------------------------------- no open task = no next step
update public.tasks set status = 'done' where case_id = '00000000-0000-0000-0000-0000001ca5e1' and status <> 'done';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000001a1","role":"authenticated"}';
insert into r select 'state_none', public.case_work_summary(array['00000000-0000-0000-0000-0000001ca5e1'::uuid]) -> 0 ->> 'state';
reset role; reset request.jwt.claims;
select is((select v from r where k = 'state_none'), 'no_next_step',
  'an open case with no open task has no next step');
select ok('00000000-0000-0000-0000-0000001ca5e1'::uuid in (select public.cases_by_work('no_next')),
  'the case is listed under "no next step"');

-- ---------------------------------------------------------------- waiting is one follow-up task
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000001a1","role":"authenticated"}';
select public.set_case_work_state('00000000-0000-0000-0000-0000001ca5e1', 'waiting_customer', 'Passport copy', now() + interval '2 days');
select public.set_case_work_state('00000000-0000-0000-0000-0000001ca5e1', 'waiting_customer', 'Passport copy and photo', now() + interval '3 days');
insert into r select 'wait_tasks', count(*)::text from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e1' and auto_key like 'waitfollow:%' and status <> 'done';
insert into r select 'wait_state', public.case_work_summary(array['00000000-0000-0000-0000-0000001ca5e1'::uuid]) -> 0 ->> 'state';
update public.tasks set status = 'done' where case_id = '00000000-0000-0000-0000-0000001ca5e1' and auto_key like 'waitfollow:%';
insert into r select 'wait_cleared', work_state from public.cases where id = '00000000-0000-0000-0000-0000001ca5e1';
reset role; reset request.jwt.claims;

select is((select v from r where k = 'wait_tasks'), '1', 'setting waiting twice keeps one follow-up task');
select is((select v from r where k = 'wait_state'), 'waiting_customer', 'the case shows as waiting');
select is((select v from r where k = 'wait_cleared'), 'in_progress', 'finishing the follow-up ends the waiting');

-- ---------------------------------------------------------------- a case's team sees its tasks; others do not
insert into public.tasks (id, title, case_id, assigned_to, created_by) values
  ('00000000-0000-0000-0000-00000001f001', 'Boss gave this to B', '00000000-0000-0000-0000-0000001ca5e1', '00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000001b1');
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000001ca5e2', '00000000-0000-0000-0000-00000001c001', 'B trip', '00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000001a2', 'booked');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000001a1","role":"authenticated"}';
insert into r select 'a_sees_b_task', count(*)::text from public.tasks where id = '00000000-0000-0000-0000-00000001f001';
insert into r select 'a_sees_b_case_tasks', count(*)::text from public.tasks where case_id = '00000000-0000-0000-0000-0000001ca5e2';
reset role; reset request.jwt.claims;
select is((select v from r where k = 'a_sees_b_task'), '1', 'the case owner sees a task given to someone else on their case');
select is((select v from r where k = 'a_sees_b_case_tasks'), '0', 'staff do not see tasks on a case they cannot open');

-- ---------------------------------------------------------------- reassigning a case moves the owner's open tasks
insert into public.tasks (id, title, case_id, assigned_to, created_by) values
  ('00000000-0000-0000-0000-00000001f002', 'Owner task', '00000000-0000-0000-0000-0000001ca5e1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001a1');
update public.cases set assigned_to = '00000000-0000-0000-0000-0000000001a2' where id = '00000000-0000-0000-0000-0000001ca5e1';
select is((select assigned_to::text from public.tasks where id = '00000000-0000-0000-0000-00000001f002'),
  '00000000-0000-0000-0000-0000000001a2', 'the new owner takes over the open tasks');

-- ---------------------------------------------------------------- automatic tasks close when their reason is gone
select private.add_auto_task('noins:00000000-0000-0000-0000-0000001ca5e1', 'No insurance', '00000000-0000-0000-0000-0000001ca5e1', null, '00000000-0000-0000-0000-0000000001a2');
select private.add_auto_task('birthday:00000000-0000-0000-0000-00000001c001:2026', 'Wish', null, '00000000-0000-0000-0000-00000001c001', '00000000-0000-0000-0000-0000000001a2');
update public.tasks set created_at = now() - interval '5 days' where auto_key = 'birthday:00000000-0000-0000-0000-00000001c001:2026';
select private.close_resolved_auto_tasks();
select is((select status from public.tasks where auto_key = 'birthday:00000000-0000-0000-0000-00000001c001:2026'), 'done', 'an old greeting reminder closes itself');
select is((select status from public.tasks where auto_key = 'noins:00000000-0000-0000-0000-0000001ca5e1'), 'todo', 'a reminder whose reason still holds stays open');

-- ---------------------------------------------------------------- a task and its case in one step
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000001a1","role":"authenticated"}';
insert into r select 'twc_case', public.create_task_with_case('{"title":"Call about Goa"}', '{"customer_id":"00000000-0000-0000-0000-00000001c001"}', '{}', 'pipe-key-0001') ->> 'id';
insert into r select 'twc_again', public.create_task_with_case('{"title":"Call about Goa"}', '{"customer_id":"00000000-0000-0000-0000-00000001c001"}', '{}', 'pipe-key-0001') ->> 'id';
reset role; reset request.jwt.claims;
select is((select v from r where k = 'twc_again'), (select v from r where k = 'twc_case'), 'a repeated request returns the same case');
select like((select title from public.cases where id = (select v::uuid from r where k = 'twc_case')), 'Trip for %', 'the new case is named after the customer');
select is((select string_agg(title, ',') from public.tasks where case_id = (select v::uuid from r where k = 'twc_case')), 'Call about Goa',
  'the task is the case''s only first step: no second "Send the quote", and no duplicate on repeat');
select is((select assigned_to::text from public.cases where id = (select v::uuid from r where k = 'twc_case')), '00000000-0000-0000-0000-0000000001a1', 'the case belongs to whoever has the task');
select is((select string_agg(customer_id::text, ',') from public.case_travellers where case_id = (select v::uuid from r where k = 'twc_case')),
  '00000000-0000-0000-0000-00000001c001', 'the customer travels by default');

-- ---------------------------------------------------------------- cancelling closes the case's automatic tasks, not the manual ones
update public.cases set status = 'cancelled', cancel_reason = 'Test' where id = '00000000-0000-0000-0000-0000001ca5e1';
select is((select status from public.tasks where auto_key = 'noins:00000000-0000-0000-0000-0000001ca5e1'), 'done', 'cancelling closes automatic tasks');
select is((select status from public.tasks where id = '00000000-0000-0000-0000-00000001f002'), 'todo', 'manual tasks are left for the owner to decide');

select * from finish();
rollback;
