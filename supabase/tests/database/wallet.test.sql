-- Prepaid wallet suppliers: top up first, confirmed bookings draw from the wallet on their own.
-- Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(19);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000007b1', 'boss@wallet.local', '{"role":"boss","full_name":"Wallet Boss"}');
insert into public.customers (id, customer_type, first_name, last_name, mobile) values
  ('00000000-0000-0000-0000-00000007c001', 'individual', 'Wallet', 'Tester', '+919000007001');
insert into public.suppliers (id, name, terms) values
  ('00000000-0000-0000-0000-00000007d001', 'Test Wallet Portal', 'wallet'),
  ('00000000-0000-0000-0000-00000007d002', 'Test Pay On Booking', 'prepaid');
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000007ca5e1', '00000000-0000-0000-0000-00000007c001', 'Wallet A', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007b1', 'confirmed'),
  ('00000000-0000-0000-0000-0000007ca5e2', '00000000-0000-0000-0000-00000007c001', 'Wallet B', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007b1', 'confirmed'),
  ('00000000-0000-0000-0000-0000007ca5e3', '00000000-0000-0000-0000-00000007c001', 'Wallet Q', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007b1', 'quoted');

create function pg_temp.drawn(p_case text, p_sup text default '00000000-0000-0000-0000-00000007d001') returns numeric language sql as $$
  select coalesce(sum(a.amount), 0) from public.payment_allocations a join public.payments p on p.id = a.payment_id
   where a.case_id = p_case::uuid and p.supplier_id = p_sup::uuid
$$;
create function pg_temp.bal() returns numeric language sql as $$ select private.wallet_balance('00000000-0000-0000-0000-00000007d001') $$;

-- ---------------------------------------------------------------- 1. top up 10,000, book 6,000 on A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}';
insert into r select 'pay1', public.record_supplier_payment('00000000-0000-0000-0000-00000007d001', current_date, 10000, 'bank')::text;
reset role; reset request.jwt.claims;
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000007b0001', '00000000-0000-0000-0000-0000007ca5e1', 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000007d001', 6000, 7000, 0, '{"title":"A ticket"}');
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e1'), 6000.00, 'a confirmed booking draws its cost from the wallet');
select is(private.case_supplier_due('00000000-0000-0000-0000-0000007ca5e1'), 0.00, 'nothing shows as due to the supplier on that case');

-- ---------------------------------------------------------------- 2. book 7,000 on B: the wallet runs 3,000 short
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000007b0002', '00000000-0000-0000-0000-0000007ca5e2', 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000007d001', 7000, 8000, 0, '{"title":"B ticket"}');
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e2'), 4000.00, 'a booking draws only what is left in the wallet');
select is(pg_temp.bal(), -3000.00, 'the wallet shows 3,000 short');

-- ---------------------------------------------------------------- 3. a 5,000 top-up covers B first
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}';
select public.record_supplier_payment('00000000-0000-0000-0000-00000007d001', current_date, 5000, 'bank');
reset role; reset request.jwt.claims;
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e2'), 7000.00, 'a top-up covers the booking the wallet was short for');
select is(pg_temp.bal(), 2000.00, 'the rest stays as wallet balance');

-- ---------------------------------------------------------------- 4. a quote does not touch the wallet
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000007b0003', '00000000-0000-0000-0000-0000007ca5e3', 'other', 'pending', '{}', '00000000-0000-0000-0000-00000007d001', 1000, 1500, 0, '{"title":"Q hotel"}');
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e3'), 0.00, 'a booking on a quote draws nothing');
select is(pg_temp.bal(), 2000.00, 'and does not lower the wallet balance');

-- ---------------------------------------------------------------- 5. A is cancelled with a full refund from the supplier
update public.booking_lines set status = 'cancelled', refund_from_supplier = 6000 where id = '00000000-0000-0000-0000-0000007b0001';
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e1'), 0.00, 'a refunded cancellation gives its money back to the wallet');
select is(pg_temp.bal(), 8000.00, 'the wallet balance goes back up');

-- ---------------------------------------------------------------- 6. the quote is confirmed
update public.cases set status = 'confirmed' where id = '00000000-0000-0000-0000-0000007ca5e3';
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e3'), 1000.00, 'confirming the case draws its bookings from the wallet');

-- ---------------------------------------------------------------- 7. low-balance reminder
update public.suppliers set wallet_alert_below = 9000 where id = '00000000-0000-0000-0000-00000007d001';
select ok(exists (select 1 from public.tasks where auto_key like 'walletlow:00000000-0000-0000-0000-00000007d001:%' and status <> 'done'),
  'a wallet under its alert amount gets a "Top up" reminder');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}';
select public.record_supplier_payment('00000000-0000-0000-0000-00000007d001', current_date, 3000, 'bank');
reset role; reset request.jwt.claims;
select ok(not exists (select 1 from public.tasks where auto_key like 'walletlow:00000000-0000-0000-0000-00000007d001:%' and status <> 'done'),
  'topping up above the alert closes the reminder');
update public.suppliers set wallet_alert_below = 20000 where id = '00000000-0000-0000-0000-00000007d001';
select ok(exists (select 1 from public.tasks where auto_key like 'walletlow:00000000-0000-0000-0000-00000007d001:%' and status <> 'done'),
  'dropping below the alert again the same day brings the reminder back');

-- ---------------------------------------------------------------- 8. pay-on-booking suppliers are unchanged until switched to wallet
insert into public.payments (direction, supplier_id, amount, mode) values ('out', '00000000-0000-0000-0000-00000007d002', 5000, 'bank');
insert into public.booking_lines (case_id, service, status, traveller_ids, supplier_id, supplier_cost, selling_price, gst, details) values
  ('00000000-0000-0000-0000-0000007ca5e2', 'other', 'confirmed', '{}', '00000000-0000-0000-0000-00000007d002', 2000, 2500, 0, '{"title":"B extra"}');
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e2', '00000000-0000-0000-0000-00000007d002'), 0.00, 'a pay-on-booking supplier advance is still used by hand');
update public.suppliers set terms = 'wallet' where id = '00000000-0000-0000-0000-00000007d002';
select is(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e2', '00000000-0000-0000-0000-00000007d002'), 2000.00, 'switching the supplier to wallet draws for its open bookings');

-- ---------------------------------------------------------------- 9. a deleted top-up: the cases draw again from what is left
delete from public.payments where id = (select v::uuid from r where k = 'pay1');
select ok(pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e2') = 7000 and pg_temp.drawn('00000000-0000-0000-0000-0000007ca5e3') = 1000,
  'after a top-up is deleted, the remaining top-ups cover the bookings again');

-- ---------------------------------------------------------------- 10. opening balance
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}';
select public.record_supplier_payment('00000000-0000-0000-0000-00000007d001', current_date - 30, 4000, 'opening');
reset role; reset request.jwt.claims;
select is(pg_temp.bal(), 4000.00, 'an opening balance adds to the wallet');
select throws_ok($$ insert into public.payments (direction, case_id, amount, mode) values ('in', '00000000-0000-0000-0000-0000007ca5e1', 100, 'opening') $$,
  '23514', null, 'a client payment cannot be an opening balance');

select * from finish();
rollback;
