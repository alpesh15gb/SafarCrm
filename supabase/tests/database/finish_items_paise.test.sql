-- The completion checklist shows fractional balances and preserves supplier confidentiality.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(8);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000031b1', 'boss@paise.local', '{"role":"boss","full_name":"Paise Boss"}'),
  ('00000000-0000-0000-0000-0000000031a1', 'staff@paise.local', '{"role":"staff","full_name":"Paise Staff"}');
update public.profiles set can_see_profit = false where id = '00000000-0000-0000-0000-0000000031a1';
update public.settings set auto_reminders = auto_reminders || '{"stage_tasks":false,"auto_stage":false,"auto_complete":false}'::jsonb where id = 1;
insert into public.customers (id, customer_type, first_name, mobile) values
  ('00000000-0000-0000-0000-00000031c001', 'individual', 'Paise Tester', '+919000031001');
insert into public.cases (id, customer_id, title, assigned_to, status) values
  ('00000000-0000-0000-0000-00000031ca01', '00000000-0000-0000-0000-00000031c001', 'Fractional balances', '00000000-0000-0000-0000-0000000031a1', 'booked');
insert into public.booking_lines (case_id, service, status, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-00000031ca01', 'other', 'confirmed', 0.20, 0.25, 0, '{"title":"Fractional booking"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000031b1","role":"authenticated"}';
select is((select x ->> 'text' from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'client'),
  '₹0.25 still due from the client', 'a 25-paise client balance is displayed exactly');
select is((select x ->> 'text' from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'supplier'),
  '₹0.20 still to pay suppliers', 'a 20-paise supplier balance is displayed exactly');
select is((select (x ->> 'ok')::boolean from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'client'),
  false, 'the fractional client balance still keeps the case open');
select is((select (x ->> 'ok')::boolean from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'supplier'),
  false, 'the fractional supplier balance still keeps the case open');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000031a1","role":"authenticated"}';
select is((select x ->> 'text' from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'client'),
  '₹0.25 still due from the client', 'staff can see the exact client balance');
select is((select x ->> 'text' from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'supplier'),
  'Suppliers still to be paid', 'staff without profit rights cannot see the supplier amount');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000031b1","role":"authenticated"}';
insert into public.payments (direction, case_id, amount, mode) values
  ('in', '00000000-0000-0000-0000-00000031ca01', 0.50, 'cash');
select is((select x ->> 'text' from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'client'),
  'Client has a credit of ₹0.25 to refund or adjust', 'a fractional overpayment is displayed exactly');
select is((select (x ->> 'ok')::boolean from jsonb_array_elements(public.case_finish_items('00000000-0000-0000-0000-00000031ca01')) x where x ->> 'key' = 'client'),
  false, 'the fractional client credit still needs resolution');

select * from finish();
rollback;
