-- Guards added after the function reviews: a case with money can't be deleted; "required" on a task and other
-- people's tasks are protected. Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(5);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000003b1', 'boss@fix.local',   '{"role":"boss","full_name":"Fix Boss"}'),
  ('00000000-0000-0000-0000-0000000003a1', 'staffa@fix.local', '{"role":"staff","full_name":"Fix A"}'),
  ('00000000-0000-0000-0000-0000000003a2', 'staffb@fix.local', '{"role":"staff","full_name":"Fix B"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile) values
  ('00000000-0000-0000-0000-00000003c001', 'individual', 'Fix', 'Tester', '+919000003001');
update public.settings set auto_reminders = auto_reminders || '{"auto_stage":false,"stage_tasks":false}'::jsonb where id = 1;
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000003ca5e1', '00000000-0000-0000-0000-00000003c001', 'Paid trip',  '00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000003a1', 'confirmed'),
  ('00000000-0000-0000-0000-0000003ca5e2', '00000000-0000-0000-0000-00000003c001', 'Empty trip', '00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000003a1', 'enquiry');
insert into public.payments (direction, case_id, amount, mode) values ('in', '00000000-0000-0000-0000-0000003ca5e1', 1000, 'cash');
insert into public.tasks (id, title, case_id, assigned_to, created_by, blocking) values
  ('00000000-0000-0000-0000-00000003f001', 'Required by boss, for A', '00000000-0000-0000-0000-0000003ca5e1', '00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000003b1', true),
  ('00000000-0000-0000-0000-00000003f002', 'For B on A''s case',      '00000000-0000-0000-0000-0000003ca5e1', '00000000-0000-0000-0000-0000000003a2', '00000000-0000-0000-0000-0000000003b1', false);

-- ---------------------------------------------------------------- the boss cannot delete a case that has money on it
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000003b1","role":"authenticated"}';
do $$ begin
  delete from public.cases where id = '00000000-0000-0000-0000-0000003ca5e1';
  insert into r values ('del_paid', 'deleted');
exception when others then insert into r values ('del_paid', sqlerrm); end $$;
delete from public.cases where id = '00000000-0000-0000-0000-0000003ca5e2';
reset role; reset request.jwt.claims;
select ok((select v from r where k = 'del_paid') like '%case_has_money%', 'a case with a payment cannot be deleted');
select is((select count(*)::int from public.payments where case_id = '00000000-0000-0000-0000-0000003ca5e1'), 1, 'its payment is still there');
select is((select count(*)::int from public.cases where id = '00000000-0000-0000-0000-0000003ca5e2'), 0, 'a case with no money can still be deleted');

-- ---------------------------------------------------------------- staff cannot un-require a boss's task, or change a colleague's task
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000003a1","role":"authenticated"}';
do $$ begin
  update public.tasks set blocking = false where id = '00000000-0000-0000-0000-00000003f001';
  insert into r values ('unrequire', 'changed');
exception when others then insert into r values ('unrequire', sqlerrm); end $$;
update public.tasks set status = 'done' where id = '00000000-0000-0000-0000-00000003f002';
reset role; reset request.jwt.claims;
select ok((select v from r where k = 'unrequire') like '%task_required_locked%', 'staff cannot switch off "required" on a task the boss created');
select is((select status from public.tasks where id = '00000000-0000-0000-0000-00000003f002'), 'todo', 'staff cannot close a task that belongs to a colleague');

select * from finish();
rollback;
