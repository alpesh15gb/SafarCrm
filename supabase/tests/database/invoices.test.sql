-- Invoices: numbered per financial year, a fixed copy of what was billed, one live invoice per booking,
-- cancel with a reason then issue again. Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(13);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000002b1', 'boss@inv.local',   '{"role":"boss","full_name":"Inv Boss"}'),
  ('00000000-0000-0000-0000-0000000002a1', 'staffa@inv.local', '{"role":"staff","full_name":"Inv A"}'),
  ('00000000-0000-0000-0000-0000000002a2', 'staffb@inv.local', '{"role":"staff","full_name":"Inv B"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile, city) values
  ('00000000-0000-0000-0000-00000002c001', 'individual', 'Invoice', 'Tester', '+919000002001', 'Hyderabad');
update public.settings set invoice_prefix = 'TST', auto_reminders = auto_reminders || '{"auto_stage":false}'::jsonb where id = 1;
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000002ca5e1', '00000000-0000-0000-0000-00000002c001', 'Invoice trip', '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000002a1', 'confirmed');
insert into public.booking_lines (id, case_id, service, status, traveller_ids, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002ca5e1', 'other', 'confirmed', '{}', 10000, 500, '{"title":"Package"}'),
  ('00000000-0000-0000-0000-0000002b0002', '00000000-0000-0000-0000-0000002ca5e1', 'other', 'pending',   '{}', 0,     0,   '{"title":"Not priced"}');

select is(private.fy_of('2026-11-12'), '26-27', 'November 2026 is in financial year 26-27');
select is(private.fy_of('2027-03-31'), '26-27', 'March 2027 is still 26-27');
select is(private.fy_of('2027-04-01'), '27-28', 'April 2027 starts 27-28');

-- ---------------------------------------------------------------- issue, repeat, nothing left to bill
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000002a1","role":"authenticated"}';
insert into r select 'inv1', public.issue_invoice('00000000-0000-0000-0000-0000002ca5e1', 'inv-key-0001') ->> 'number';
insert into r select 'inv1_again', public.issue_invoice('00000000-0000-0000-0000-0000002ca5e1', 'inv-key-0001') ->> 'number';
do $$ begin
  perform public.issue_invoice('00000000-0000-0000-0000-0000002ca5e1', 'inv-key-0002');
  insert into r values ('inv_second', 'issued');
exception when others then insert into r values ('inv_second', sqlerrm); end $$;
insert into r select 'inv_visible', count(*)::text from public.invoices where case_id = '00000000-0000-0000-0000-0000002ca5e1';
do $$ begin
  perform public.cancel_invoice((select id from public.invoices where request_key = 'inv-key-0001'), '  ');
  insert into r values ('cancel_noreason', 'cancelled');
exception when others then insert into r values ('cancel_noreason', sqlerrm); end $$;
reset role; reset request.jwt.claims;

select ok((select v from r where k = 'inv1') ~ '^TST/\d\d-\d\d/\d{4}$', 'the number is prefix / financial year / four digits');
select is((select v from r where k = 'inv1_again'), (select v from r where k = 'inv1'), 'a repeated request returns the same invoice');
select ok((select v from r where k = 'inv_second') like '%invoice_nothing_to_bill%', 'a booking cannot be invoiced twice');
select is((select v from r where k = 'inv_visible'), '1', 'the case owner sees the invoice');
select is((select total from public.invoices where request_key = 'inv-key-0001'), 10500.00::numeric, 'the total is the selling price plus GST of priced bookings only');
select is((select jsonb_array_length(lines) from public.invoices where request_key = 'inv-key-0001'), 1, 'the unpriced booking is not on the invoice');
select ok((select v from r where k = 'cancel_noreason') like '%invoice_cancel_reason%', 'cancelling needs a reason');

-- ---------------------------------------------------------------- someone who cannot open the case cannot invoice it
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000002a2","role":"authenticated"}';
do $$ begin
  perform public.issue_invoice('00000000-0000-0000-0000-0000002ca5e1', 'inv-key-0003');
  insert into r values ('inv_other', 'issued');
exception when others then insert into r values ('inv_other', sqlerrm); end $$;
reset role; reset request.jwt.claims;
select ok((select v from r where k = 'inv_other') like '%Not allowed%', 'staff who cannot open the case cannot invoice it');

-- ---------------------------------------------------------------- the invoice is a fixed copy; cancel, then issue again with the next number
update public.booking_lines set selling_price = 12000 where id = '00000000-0000-0000-0000-0000002b0001';
select is((select total from public.invoices where request_key = 'inv-key-0001'), 10500.00::numeric, 'changing the booking does not change the issued invoice');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000002a1","role":"authenticated"}';
select public.cancel_invoice((select id from public.invoices where request_key = 'inv-key-0001'), 'Price changed');
insert into r select 'inv2_id', public.issue_invoice('00000000-0000-0000-0000-0000002ca5e1', 'inv-key-0004') ->> 'id';
insert into r select 'inv2_total', total::text from public.invoices where id = (select v::uuid from r where k = 'inv2_id');
reset role; reset request.jwt.claims;
select is((select v from r where k = 'inv2_total'), '12500.00', 'after cancelling, a new invoice carries the new price');

select * from finish();
rollback;
