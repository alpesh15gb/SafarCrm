-- Ticket import confirm with supplier, incoming and client price, a traveller as payer, and frequent flyer numbers.
-- Synthetic data only. One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(18);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000009b1', 'boss@imp.local',  '{"role":"boss","full_name":"Import Boss"}'),
  ('00000000-0000-0000-0000-0000000009a1', 'staff@imp.local', '{"role":"staff","full_name":"Import Staff"}');
update public.profiles set can_see_profit = false where id = '00000000-0000-0000-0000-0000000009a1';
insert into public.suppliers (id, name, services) values ('00000000-0000-0000-0000-00000009d001', 'Test Portal Supplier', '{flight}');

-- a ticket for two people nobody has on file yet; the first has a frequent flyer number
create function pg_temp.draft(p_pnr text, p_ticket text, p_date text, p_name1 text, p_ff text) returns jsonb language sql as $$
  select jsonb_build_object('schema_version', 'ticket-extract/1', 'source', 'provider', 'document_kind', 'e_ticket', 'issue_date', jsonb_build_object('value', ''),
    'passengers', jsonb_build_array(
      jsonb_build_object('key', 'p1', 'name_as_issued', jsonb_build_object('value', p_name1), 'pax_type', jsonb_build_object('value', 'ADT'),
        'tickets', jsonb_build_array(jsonb_build_object('number', jsonb_build_object('value', p_ticket), 'segments', '["s1"]'::jsonb)),
        'ff', jsonb_build_array(jsonb_build_object('airline', 'EK', 'number', p_ff))),
      jsonb_build_object('key', 'p2', 'name_as_issued', jsonb_build_object('value', 'MS TESTA SECONDPAX'), 'pax_type', jsonb_build_object('value', 'ADT'),
        'tickets', '[]'::jsonb)),
    'segments', jsonb_build_array(jsonb_build_object('key', 's1', 'from', jsonb_build_object('value', 'HYD'), 'to', jsonb_build_object('value', 'DXB'),
        'dep_date', jsonb_build_object('value', p_date), 'dep_time', jsonb_build_object('value', '10:00'), 'arr_date', jsonb_build_object('value', p_date),
        'arr_time', jsonb_build_object('value', '12:25'), 'airline', jsonb_build_object('value', 'Test Air'), 'flight_no', jsonb_build_object('value', 'TA 527'),
        'cabin', jsonb_build_object('value', ''), 'baggage', jsonb_build_object('value', ''), 'fare_basis', jsonb_build_object('value', ''))),
    'airline_pnrs', jsonb_build_array(jsonb_build_object('value', p_pnr)), 'supplier_refs', '[]'::jsonb, 'amounts', '[]'::jsonb)
$$;
insert into public.ticket_imports (id, status, channel, storage_path, file_name, mime, size, sha256, uploaded_by, draft, draft_version) values
  ('00000000-0000-0000-0000-0000000009f1', 'needs_review', 'staff', 'imports/imp-1.pdf', 'one.pdf', 'application/pdf', 100, repeat('1', 64),
   '00000000-0000-0000-0000-0000000009a1', pg_temp.draft('IMPA01', '176-0000000001', '2026-12-10', 'MR TESTA FIRSTPAX', '200000001'), 1),
  ('00000000-0000-0000-0000-0000000009f2', 'needs_review', 'staff', 'imports/imp-2.pdf', 'two.pdf', 'application/pdf', 100, repeat('2', 64),
   '00000000-0000-0000-0000-0000000009b1', pg_temp.draft('IMPA02', '176-0000000002', '2026-12-20', 'MR TESTA FIRSTPAX', '300000003'), 1),
  ('00000000-0000-0000-0000-0000000009f3', 'needs_review', 'staff', 'imports/imp-3.pdf', 'three.pdf', 'application/pdf', 100, repeat('3', 64),
   '00000000-0000-0000-0000-0000000009b1', pg_temp.draft('IMPA03', '176-0000000003', '2027-01-05', 'MR TESTA FIRSTPAX', '300000003'), 1);

-- ---------------------------------------------------------------- 1. staff without profit rights: a traveller pays; their cost is ignored
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009a1","role":"authenticated"}';
insert into r select 'staff', public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f1', 1, 'key-imp-0001', '{
  "payer_customer_id":null,"payer_passenger":0,"family":true,"case":{"mode":"new","title":"","stage":"booked"},"booking":{"mode":"new"},
  "booked_by":"agency","line_status":"confirmed",
  "pricing":{"supplier_id":"00000000-0000-0000-0000-00000009d001","supplier_cost":"9000","selling_price":"15,000"},
  "passengers":[{"create":{"first_name":"Testa","last_name":"Firstpax","mobile":"+919000009001","title":"Mr","gender":"Male"}},
                {"create":{"first_name":"Testa","last_name":"Secondpax","mobile":"+919000009001","title":"Ms","gender":"Female"}}]}')::text;
reset role; reset request.jwt.claims;

select results_eq($$ select l.supplier_id::text, l.selling_price, l.supplier_cost, l.pricing_state, l.payment_due_date is not null
                     from public.booking_lines l where l.import_id = '00000000-0000-0000-0000-0000000009f1' $$,
  $$ values ('00000000-0000-0000-0000-00000009d001'::text, 15000::numeric, 0::numeric, 'not_entered'::text, true) $$,
  'staff without profit rights: supplier and client price saved, their cost ignored, left "not priced" for the boss');
select is((select c.customer_id from public.cases c where c.id = ((select v from r where k = 'staff')::jsonb ->> 'case_id')::uuid),
          (select id from public.customers where last_name = 'Firstpax'), 'the first traveller is the customer on the new MAX ID');
select results_eq($$ select title, gender, loyalty -> 0 ->> 'name', loyalty -> 0 ->> 'number', jsonb_array_length(loyalty) from public.customers where last_name = 'Firstpax' $$,
  $$ values ('Mr'::text, 'Male'::text, 'EK'::text, '200000001'::text, 1) $$, 'the new traveller gets title, gender and the frequent flyer number from the ticket');
select is((select jsonb_array_length(loyalty) from public.customers where last_name = 'Secondpax'), 0, 'no frequent flyer number, none invented');
select is((select details -> 'tickets' -> 0 ->> 'ff' from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000009f1'), 'EK 200000001',
  'the ticket entry keeps the frequent flyer number');
select is((select count(*)::int from public.case_travellers where case_id = ((select v from r where k = 'staff')::jsonb ->> 'case_id')::uuid), 2, 'both travellers are on the case');
select results_eq($$ select f.name, count(*)::int from public.customers c join public.families f on f.id = c.family_id
                     where c.last_name in ('Firstpax', 'Secondpax') group by f.name $$,
  $$ values ('Firstpax'::text, 2) $$, 'both travellers are linked as one family named after the paying traveller');
select is((select relation from public.customers where last_name = 'Firstpax'), 'Head of family', 'the paying traveller heads the new family');
select is((select title from public.cases where id = ((select v from r where k = 'staff')::jsonb ->> 'case_id')::uuid), 'Flight HYD → DXB', 'one-way title is unchanged');

-- ---------------------------------------------------------------- 2. the boss: a loss-making price, an existing traveller gets a new FF number
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009b1","role":"authenticated"}';
do $$ begin
  perform public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f2', 1, 'key-imp-0002', jsonb_build_object(
    'payer_passenger', 0, 'case', '{"mode":"new","stage":"booked"}'::jsonb, 'booking', '{"mode":"new"}'::jsonb, 'booked_by', 'agency', 'line_status', 'confirmed',
    'pricing', '{"supplier_id":null,"supplier_cost":"","selling_price":"5000"}'::jsonb,
    'passengers', jsonb_build_array(jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Firstpax')),
                                    jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Secondpax')))));
  insert into r values ('no_cost', 'ok');
exception when others then insert into r values ('no_cost', sqlerrm); end $$;
do $$ begin
  perform public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f2', 1, 'key-imp-0003', jsonb_build_object(
    'payer_passenger', 0, 'case', '{"mode":"new","stage":"booked"}'::jsonb, 'booking', '{"mode":"new"}'::jsonb, 'booked_by', 'agency', 'line_status', 'confirmed',
    'pricing', '{"supplier_id":null,"supplier_cost":"12k","selling_price":"5000"}'::jsonb,
    'passengers', jsonb_build_array(jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Firstpax')),
                                    jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Secondpax')))));
  insert into r values ('bad_amount', 'ok');
exception when others then insert into r values ('bad_amount', sqlerrm); end $$;
do $$ begin
  perform public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f2', 1, 'key-imp-0004', jsonb_build_object(
    'payer_passenger', 5, 'case', '{"mode":"new","stage":"booked"}'::jsonb, 'booking', '{"mode":"new"}'::jsonb, 'booked_by', 'agency', 'line_status', 'confirmed',
    'passengers', jsonb_build_array(jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Firstpax')),
                                    jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Secondpax')))));
  insert into r values ('bad_payer', 'ok');
exception when others then insert into r values ('bad_payer', sqlerrm); end $$;
insert into r select 'boss', public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f2', 1, 'key-imp-0005', jsonb_build_object(
    'payer_passenger', 0, 'case', '{"mode":"new","stage":"booked"}'::jsonb, 'booking', '{"mode":"new"}'::jsonb, 'booked_by', 'agency', 'line_status', 'confirmed',
    'pricing', '{"supplier_id":"00000000-0000-0000-0000-00000009d001","supplier_cost":"12,000","selling_price":"₹ 11000"}'::jsonb,
    'passengers', jsonb_build_array(jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Firstpax')),
                                    jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Secondpax')))))::text;
insert into r select 'loss', (select profit::text from public.v_line_money where line_id = (select id from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000009f2'));
reset role; reset request.jwt.claims;

select ok((select v from r where k = 'no_cost') like '%incoming price%', 'a client price without the incoming price is refused for someone who sees profit');
select ok((select v from r where k = 'bad_amount') like '%invalid_amount%', 'an unreadable price is refused, not saved as zero');
select ok((select v from r where k = 'bad_payer') like '%paying traveller%', 'a paying traveller who is not on the ticket is refused');
select results_eq($$ select selling_price, supplier_cost, pricing_state from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000009f2' $$,
  $$ values (11000::numeric, 12000::numeric, 'entered'::text) $$, 'the boss saves both prices; the booking is priced');
select is((select v from r where k = 'loss'), '-1000.00', 'the loss shows as negative profit');
select is((select jsonb_array_length(loyalty) from public.customers where last_name = 'Firstpax'), 2, 'a traveller on file gets the new frequent flyer number added');
select is((select count(*)::int from public.customers where last_name = 'Firstpax'), 1, 'matching an existing traveller creates nobody new');

-- ---------------------------------------------------------------- 3. the same number again is not added twice; customer-booked is unchanged
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009b1","role":"authenticated"}';
insert into r select 'cust', public.confirm_ticket_import('00000000-0000-0000-0000-0000000009f3', 1, 'key-imp-0006', jsonb_build_object(
    'payer_passenger', 0, 'case', '{"mode":"new","stage":"booked"}'::jsonb, 'booking', '{"mode":"new"}'::jsonb, 'booked_by', 'customer', 'line_status', 'confirmed',
    'pricing', '{"supplier_id":"00000000-0000-0000-0000-00000009d001","supplier_cost":"1","selling_price":"2"}'::jsonb,
    'passengers', jsonb_build_array(jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Firstpax')),
                                    jsonb_build_object('customer_id', (select id from public.customers where last_name = 'Secondpax')))))::text;
reset role; reset request.jwt.claims;
select is((select jsonb_array_length(loyalty) from public.customers where last_name = 'Firstpax'), 2, 'a frequent flyer number already on the profile is not added again');
select results_eq($$ select supplier_id, selling_price, supplier_cost, pricing_state from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000009f3' $$,
  $$ values (null::uuid, 0::numeric, 0::numeric, 'not_entered'::text) $$, 'a customer-booked ticket takes no supplier or prices');

select * from finish();
rollback;
