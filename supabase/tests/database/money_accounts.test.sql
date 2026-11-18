-- Money accounts: set up by the boss, picked on payments, balances worked out. Synthetic data, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(11);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-00000000ab01', 'boss@acc.local',  '{"role":"boss","full_name":"Acc Boss"}'),
  ('00000000-0000-0000-0000-00000000ab02', 'staff@acc.local', '{"role":"staff","full_name":"Acc Staff"}');
update public.profiles set can_see_profit = false, can_see_all_cases = true where id = '00000000-0000-0000-0000-00000000ab02';
insert into public.customers (id, first_name, last_name, mobile) values ('00000000-0000-0000-0000-00000000ac01', 'Acc', 'Client', '+919000000101');
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-00000000ad01', '00000000-0000-0000-0000-00000000ac01', 'Acc trip', '00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-00000000ab02', 'confirmed');
insert into public.suppliers (id, name) values ('00000000-0000-0000-0000-00000000ae01', 'Acc Supplier');

-- the boss sets up a bank account and a credit card
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"authenticated"}';
insert into public.money_accounts (id, name, kind, last4, opening_balance, opening_date) values
  ('00000000-0000-0000-0000-00000000af01', 'Test HDFC current', 'bank', '1234', 100000, current_date - 1),
  ('00000000-0000-0000-0000-00000000af02', 'Test ICICI card', 'card', '7003', -5000, current_date - 1);
reset role; reset request.jwt.claims;

-- staff cannot add one, but can record a client payment into the bank account
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ab02","role":"authenticated"}';
do $$ begin
  insert into public.money_accounts (name, kind) values ('Sneaky', 'cash');
  insert into r values ('staff_add', 'ok');
exception when others then insert into r values ('staff_add', 'refused'); end $$;
insert into public.payments (direction, case_id, pay_date, amount, mode, account_id)
values ('in', '00000000-0000-0000-0000-00000000ad01', current_date, 20000, 'upi', '00000000-0000-0000-0000-00000000af01');
reset role; reset request.jwt.claims;

-- the boss pays the supplier with the card
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"authenticated"}';
insert into r select 'pid', public.record_supplier_payment('00000000-0000-0000-0000-00000000ae01', current_date, 8000, 'bank', null, null, '[]'::jsonb)::text;
select public.set_payment_account((select v from r where k = 'pid')::uuid, '00000000-0000-0000-0000-00000000af02');
create temp table bal as select * from public.money_account_balances();
create temp table cb as select * from public.report_cashbook_summary(current_date, current_date);
create temp table cbl as select * from public.report_cashbook_lines(current_date, current_date, '00000000-0000-0000-0000-00000000af01');
reset role; reset request.jwt.claims;

select is((select v from r where k = 'staff_add'), 'refused', 'only the boss can add an account');
select is((select mode from public.payments where account_id = '00000000-0000-0000-0000-00000000af01'), 'bank', 'a payment into a bank account is recorded as bank, whatever mode was sent');
select is((select account_id::text from public.payments where id = (select v from r where k = 'pid')::uuid), '00000000-0000-0000-0000-00000000af02', 'a supplier payment gets the account it was paid from');
select is((select mode from public.payments where id = (select v from r where k = 'pid')::uuid), 'card', 'and its mode follows the card');
select is((select balance from bal where id = '00000000-0000-0000-0000-00000000af01'), 120000.00, 'bank balance = opening + money received');
select is((select balance from bal where id = '00000000-0000-0000-0000-00000000af02'), -13000.00, 'card balance = what is owed on it, growing with each payment made on it');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ab02","role":"authenticated"}';
insert into r select 'staff_bal', count(*)::text from public.money_account_balances();
reset role; reset request.jwt.claims;
select is((select v from r where k = 'staff_bal'), '0', 'staff without profit rights see no balances');

select results_eq($$ select opening, money_in, money_out, closing from cb where account_id = '00000000-0000-0000-0000-00000000af01' $$,
  $$ values (100000.00, 20000.00, 0.00, 120000.00) $$, 'cash and bank book: the bank account opens, takes the receipt and closes');
select is((select closing from cb where account_id = '00000000-0000-0000-0000-00000000af02'), -13000.00, 'the card closes at what is owed on it');
select results_eq($$ select received, paid, party, kind from cbl $$, $$ values (20000.00, 0.00, 'Acc Client'::text, 'Client payment'::text) $$,
  'one account chosen: its entries, with the client and what it was');
-- a refund to the client from the bank account is money out, not less money in (QA, 2026-11-18)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ab01","role":"authenticated"}';
insert into public.payments (direction, case_id, pay_date, amount, mode, account_id)
values ('in', '00000000-0000-0000-0000-00000000ad01', current_date, -5000, 'bank', '00000000-0000-0000-0000-00000000af01');
create temp table bal2 as select * from public.money_account_balances();
reset role; reset request.jwt.claims;
select results_eq($$ select money_in, money_out, balance from bal2 where id = '00000000-0000-0000-0000-00000000af01' $$,
  $$ values (20000.00, 5000.00, 115000.00) $$, 'Accounts: receipts in, the refund out, like the cash book');
select * from finish();
rollback;
