-- Gaps closed on 2026-11-13: supplier cost only for profit, restricted staff see their own customers, supplier
-- advances and refunds, supplier change on a paid booking, cancelling only through the checks, refused visas,
-- and the password-change step. Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(17);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000005b1', 'boss@gaps.local',   '{"role":"boss","full_name":"Gaps Boss"}'),
  ('00000000-0000-0000-0000-0000000005a1', 'staffa@gaps.local', '{"role":"staff","full_name":"Gaps A"}'),
  ('00000000-0000-0000-0000-0000000005a2', 'staffb@gaps.local', '{"role":"staff","full_name":"Gaps B"}');
update public.settings set auto_reminders = auto_reminders || '{"auto_stage":false,"stage_tasks":false,"auto_complete":false}'::jsonb where id = 1;
insert into public.customers (id, customer_type, first_name, last_name, mobile, assigned_to) values
  ('00000000-0000-0000-0000-00000005c001', 'individual', 'Mine', 'Gaps', '+919000005001', '00000000-0000-0000-0000-0000000005a1'),
  ('00000000-0000-0000-0000-00000005c002', 'individual', 'Others', 'Gaps', '+919000005002', '00000000-0000-0000-0000-0000000005a2');
insert into public.suppliers (id, name) values
  ('00000000-0000-0000-0000-00000005d001', 'Gaps Air'), ('00000000-0000-0000-0000-00000005d002', 'Gaps Hotels'), ('00000000-0000-0000-0000-00000005d003', 'Gaps Wallet');
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000005ca5e1', '00000000-0000-0000-0000-00000005c001', 'Paid flight', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a1', 'booked'),
  ('00000000-0000-0000-0000-0000005ca5e2', '00000000-0000-0000-0000-00000005c001', 'To cancel',   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a1', 'enquiry'),
  ('00000000-0000-0000-0000-0000005ca5e3', '00000000-0000-0000-0000-00000005c001', 'On advance',  '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a1', 'booked');
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000005b0001', '00000000-0000-0000-0000-0000005ca5e1', 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000005d001', 5000, 6000, 0, '{"title":"Flight"}'),
  ('00000000-0000-0000-0000-0000005b0003', '00000000-0000-0000-0000-0000005ca5e3', 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000005d003', 6000, 7000, 0, '{"title":"Hotel"}');
insert into public.payments (id, direction, supplier_id, amount, mode) values
  ('00000000-0000-0000-0000-00000005e001', 'out', '00000000-0000-0000-0000-00000005d001', 5000, 'bank'),
  ('00000000-0000-0000-0000-00000005e003', 'out', '00000000-0000-0000-0000-00000005d003', 10000, 'bank');
insert into public.payment_allocations (payment_id, case_id, amount) values
  ('00000000-0000-0000-0000-00000005e001', '00000000-0000-0000-0000-0000005ca5e1', 5000);
select private.add_auto_task('supdue:00000000-0000-0000-0000-0000005ca5e1:x', 'Pay supplier Gaps Air: ₹5,000', '00000000-0000-0000-0000-0000005ca5e1', null, '00000000-0000-0000-0000-0000000005a1');

-- ---------------------------------------------------------------- staff A: no profit rights, only their own cases
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005a1","role":"authenticated"}';
insert into r select 'a_supplier_due', coalesce((select supplier_due::text from public.v_case_money where case_id = '00000000-0000-0000-0000-0000005ca5e1'), 'hidden');
insert into r select 'a_line_cost', coalesce((select cost::text from public.v_line_money where line_id = '00000000-0000-0000-0000-0000005b0001'), 'hidden');
insert into r select 'a_supdue_tasks', count(*)::text from public.tasks where auto_key like 'supdue:%';
insert into r select 'a_own_customer', count(*)::text from public.customers where id = '00000000-0000-0000-0000-00000005c001';
insert into r select 'a_other_customer', count(*)::text from public.customers where id = '00000000-0000-0000-0000-00000005c002';
insert into r select 'a_picker', mobile from public.customer_picker('Others Gaps');
do $$ begin
  update public.cases set status = 'cancelled' where id = '00000000-0000-0000-0000-0000005ca5e2';
  insert into r values ('a_cancel_direct', 'cancelled');
exception when others then insert into r values ('a_cancel_direct', sqlerrm); end $$;
insert into r select 'a_cancel_case', (public.cancel_case('00000000-0000-0000-0000-0000005ca5e2', 'Client changed plans') is not null)::text;
do $$ begin
  perform public.password_changed();
  insert into r values ('a_pw_skip', 'cleared');
exception when others then insert into r values ('a_pw_skip', sqlerrm); end $$;
reset role; reset request.jwt.claims;

select is((select v from r where k = 'a_supplier_due'), 'hidden', 'staff without profit rights do not see supplier dues on a case');
select is((select v from r where k = 'a_line_cost'), 'hidden', 'nor the cost of a booking');
select is((select v from r where k = 'a_supdue_tasks'), '0', 'nor "pay supplier" reminders, even on their own case');
select is((select v from r where k = 'a_own_customer'), '1', 'restricted staff see their own customer');
select is((select v from r where k = 'a_other_customer'), '0', 'but not a colleague''s customer');
select is((select v from r where k = 'a_picker'), '•••• 5002', 'the customer search still finds that customer, with a masked mobile');
select ok((select v from r where k = 'a_cancel_direct') like '%case_cancel_direct%', 'a case cannot be cancelled by writing the stage directly');
select is((select v from r where k = 'a_cancel_case'), 'true', '"Cancel case" (with its checks) still works');
select ok((select v from r where k = 'a_pw_skip') like '%permission denied%', 'the browser can no longer clear "must change password" by itself');

-- ---------------------------------------------------------------- the boss: supplier change, advances, refunds
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005b1","role":"authenticated"}';
do $$ begin
  update public.booking_lines set supplier_id = '00000000-0000-0000-0000-00000005d002' where id = '00000000-0000-0000-0000-0000005b0001';
  insert into r values ('b_change_supplier', 'changed');
exception when others then insert into r values ('b_change_supplier', sqlerrm); end $$;
insert into r select 'b_use_advance', public.use_supplier_advance('00000000-0000-0000-0000-00000005d003', '00000000-0000-0000-0000-0000005ca5e3', 9000)::text;
insert into r select 'b_advance_left', public.supplier_advance('00000000-0000-0000-0000-00000005d003')::text;
insert into r select 'b_refund', (public.record_supplier_payment('00000000-0000-0000-0000-00000005d001', null, -2000, 'bank', null, null,
  '[{"case_id":"00000000-0000-0000-0000-0000005ca5e1","amount":-2000}]') is not null)::text;
do $$ begin
  perform public.record_supplier_payment('00000000-0000-0000-0000-00000005d001', null, -1000, 'bank', null, null,
    '[{"case_id":"00000000-0000-0000-0000-0000005ca5e1","amount":1000}]');
  insert into r values ('b_mixed_sign', 'saved');
exception when others then insert into r values ('b_mixed_sign', sqlerrm); end $$;
reset role; reset request.jwt.claims;

select ok((select v from r where k = 'b_change_supplier') like '%supplier_change_paid%', 'the supplier of a paid booking cannot be swapped');
select is((select v from r where k = 'b_use_advance')::numeric, 6000::numeric, 'an advance is used only up to what the case owes that supplier');
select is((select v from r where k = 'b_advance_left')::numeric, 4000::numeric, 'and the rest stays as an advance');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-0000005ca5e3'), null, 'the owner session has no profit rights, so the view hides it here too');
select is(private.case_supplier_due('00000000-0000-0000-0000-0000005ca5e3'), 0::numeric, 'the case owes that supplier nothing after the advance is used');
select is((select v from r where k = 'b_refund'), 'true', 'a refund from a supplier can be recorded');
select ok((select v from r where k = 'b_mixed_sign') like '%allocation_sign%', 'a refund cannot be put against a case as a payment');

-- ---------------------------------------------------------------- a refused visa is done, not pending
insert into public.booking_lines (id, case_id, service, traveller_ids, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000005b0004', '00000000-0000-0000-0000-0000005ca5e1', 'visa', '{}', 3000, 4000, 0, '{"country":"Kenya","application_status":"Rejected"}');
select is((select status from public.booking_lines where id = '00000000-0000-0000-0000-0000005b0004'), 'confirmed', 'a refused visa counts as done (its fees are spent)');

select * from finish();
rollback;
