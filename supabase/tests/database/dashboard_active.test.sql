-- Which cases the dashboard shows (owner, 2026-11-18). Synthetic data, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(6);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000040b1', 'boss@dash.local', '{"role":"boss","full_name":"Dash Boss"}');
update public.settings set auto_reminders = auto_reminders || '{"auto_stage":false,"auto_complete":false}'::jsonb where id = 1;
insert into public.customers (id, first_name, mobile) values ('00000000-0000-0000-0000-00000040c001', 'Dash Client', '+919000040001');
insert into public.cases (id, customer_id, title, status) values
  ('00000000-0000-0000-0000-00000040ca01', '00000000-0000-0000-0000-00000040c001', 'one-way yesterday, paid', 'booked'),
  ('00000000-0000-0000-0000-00000040ca02', '00000000-0000-0000-0000-00000040c001', 'went yesterday, returns next week', 'completed'),
  ('00000000-0000-0000-0000-00000040ca03', '00000000-0000-0000-0000-00000040c001', 'trip over, money due', 'booked'),
  ('00000000-0000-0000-0000-00000040ca04', '00000000-0000-0000-0000-00000040c001', 'enquiry, no dates', 'enquiry');

-- flights dated yesterday (and a return next week on case 2); case 3 is unpaid
insert into public.booking_lines (case_id, service, status, traveller_ids, supplier_cost, selling_price, gst, details)
select id, 'flight', 'confirmed', '{}', 0, price, 0,
       jsonb_build_object('trip_type', case when ret then 'return' else 'one-way' end, 'sectors',
         case when ret then jsonb_build_array(
                jsonb_build_object('from', 'DEL', 'to', 'BOM', 'date', to_char(current_date - 1, 'YYYY-MM-DD'), 'dep', '07:00', 'arr', '09:10'),
                jsonb_build_object('from', 'BOM', 'to', 'DEL', 'date', to_char(current_date + 6, 'YYYY-MM-DD'), 'dep', '07:00', 'arr', '09:10'))
              else jsonb_build_array(
                jsonb_build_object('from', 'DEL', 'to', 'BOM', 'date', to_char(current_date - 1, 'YYYY-MM-DD'), 'dep', '07:00', 'arr', '09:10')) end)
from (values ('00000000-0000-0000-0000-00000040ca01'::uuid, false, 0::numeric), ('00000000-0000-0000-0000-00000040ca02'::uuid, true, 0::numeric),
             ('00000000-0000-0000-0000-00000040ca03'::uuid, false, 5000::numeric)) v(id, ret, price);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000040b1","role":"authenticated"}';
create temp table ids as select case_id from public.dashboard_case_ids();
select is(public.case_trip_end('00000000-0000-0000-0000-00000040ca02'), current_date + 6, 'the trip ends on the return flight');
select ok(not exists (select 1 from ids where case_id = '00000000-0000-0000-0000-00000040ca01'), 'a one-way trip that is over and paid leaves the dashboard');
select ok(exists (select 1 from ids where case_id = '00000000-0000-0000-0000-00000040ca02'), 'a trip stays on the dashboard until the return, even if the case is completed');
select ok(exists (select 1 from ids where case_id = '00000000-0000-0000-0000-00000040ca03'), 'a trip that is over stays while the client still owes money');
select ok(exists (select 1 from ids where case_id = '00000000-0000-0000-0000-00000040ca04'), 'an enquiry with no dates stays while it is open');
select ok(exists (select 1 from public.cases where id = '00000000-0000-0000-0000-00000040ca01'), 'the case itself stays in the records');
reset role; reset request.jwt.claims;

select * from finish();
rollback;
