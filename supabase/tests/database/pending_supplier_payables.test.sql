begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(17);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000034b1', 'boss@pending.local', '{"role":"boss","full_name":"Pending Boss"}');
update public.settings set auto_reminders = auto_reminders || '{"stage_tasks":false,"auto_stage":false,"auto_complete":false}'::jsonb where id = 1;
insert into public.customers (id, first_name, mobile) values
  ('00000000-0000-0000-0000-00000034c001', 'Pending Tester', '+919000034001');
insert into public.suppliers (id, name, terms) values
  ('00000000-0000-0000-0000-00000034d001', 'Held hotel supplier', 'prepaid');
insert into public.cases (id, customer_id, title, assigned_to, status) values
  ('00000000-0000-0000-0000-00000034ca01', '00000000-0000-0000-0000-00000034c001', 'Quoted hotel', '00000000-0000-0000-0000-0000000034b1', 'enquiry');
insert into public.booking_lines (id, case_id, service, status, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-00000034b001', '00000000-0000-0000-0000-00000034ca01', 'other', 'pending', '00000000-0000-0000-0000-00000034d001', 1300.25, 2000.50, 0, '{"title":"Hotel quote"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000034b1","role":"authenticated"}';
select is((select payable from public.v_supplier_balance where supplier_id = '00000000-0000-0000-0000-00000034d001'), 0::numeric, 'a hold adds no supplier payable');
select is((select oldest_due from public.v_supplier_balance where supplier_id = '00000000-0000-0000-0000-00000034d001'), null::date, 'a hold has no supplier due date');
select is((select count(*)::int from public.report_supplier_dues('00000000-0000-0000-0000-00000034d001')), 0, 'an unpaid hold is absent from supplier dues');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), 0::numeric, 'the case also has no supplier due');
select is((select (item ->> 'ok')::boolean from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000034ca01')) item where item ->> 'key' = 'supplier'), true,
  'the completion checklist does not ask to pay a pending hold');
select is((select cost from public.v_line_money where line_id = '00000000-0000-0000-0000-00000034b001'), 1300.25, 'quoted cost remains available');
select is((select profit from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), 700.25, 'estimated profit still uses the quoted cost');

insert into public.payments (id, direction, supplier_id, amount, mode) values
  ('00000000-0000-0000-0000-00000034e001', 'out', '00000000-0000-0000-0000-00000034d001', 300.25, 'bank');
insert into public.payment_allocations (payment_id, case_id, amount) values
  ('00000000-0000-0000-0000-00000034e001', '00000000-0000-0000-0000-00000034ca01', 300.25);
select is((select paid from public.v_supplier_balance where supplier_id = '00000000-0000-0000-0000-00000034d001'), 300.25, 'money already paid is retained');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), -300.25, 'a payment against a hold remains a case advance');
select is((select due from public.report_supplier_dues('00000000-0000-0000-0000-00000034d001')), -300.25, 'the supplier report retains the actual advance');

update public.booking_lines set status = 'confirmed' where id = '00000000-0000-0000-0000-00000034b001';
select is((select payable from public.v_supplier_balance where supplier_id = '00000000-0000-0000-0000-00000034d001'), 1300.25, 'confirming the booking creates its obligation even while the case is Enquiry');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), 1000::numeric, 'the advance offsets the confirmed cost');
select is((select (item ->> 'ok')::boolean from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000034ca01')) item where item ->> 'key' = 'supplier'), false,
  'the completion checklist requires the confirmed balance to be settled');
select is((select payable - paid from public.v_case_supplier_money where case_id = '00000000-0000-0000-0000-00000034ca01'), 1000::numeric, 'the supplier case ledger agrees');

update public.booking_lines set status = 'cancelled', cancel_reason = 'Cancelled with a fee', refund_from_supplier = 1250
 where id = '00000000-0000-0000-0000-00000034b001';
select is((select payable from public.v_supplier_balance where supplier_id = '00000000-0000-0000-0000-00000034d001'), 50.25, 'the cancellation residual remains payable');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), -250::numeric, 'the unused payment is still refundable after cancellation');

insert into public.booking_lines (id, case_id, service, status, supplier_cost, selling_price, details) values
  ('00000000-0000-0000-0000-00000034b002', '00000000-0000-0000-0000-00000034ca01', 'other', 'pending', 25.50, 40, '{"title":"Unassigned quote"}');
select is((select supplier_due from public.v_case_money where case_id = '00000000-0000-0000-0000-00000034ca01'), -250::numeric, 'a pending quote without a supplier adds no obligation');

select * from finish();
rollback;
