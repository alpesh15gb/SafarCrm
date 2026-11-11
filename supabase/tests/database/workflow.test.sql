-- Workflow acceptance tests, run against a local database: `npx supabase test db`
-- Synthetic data only. Everything runs in one transaction and is rolled back.
-- Each user action runs as the `authenticated` role with that user's JWT; results are written to a scratch table,
-- then checked as the test owner (pgTAP's own tables belong to the owner).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(51);

create temp table r (k text primary key, v text);
grant all on r to authenticated;

-- ------------------------------------------------------------------ users (profiles come from the auth trigger)
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'boss@test.local',   '{"role":"boss","full_name":"Test Boss"}'),
  ('00000000-0000-0000-0000-0000000000a1', 'staffa@test.local', '{"role":"staff","full_name":"Staff A"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'staffb@test.local', '{"role":"staff","full_name":"Staff B"}');

-- customers: a company payer, an employee who travels, a parent who pays for a child, a client with a portal login, a stranger
insert into public.customers (id, customer_type, first_name, last_name, mobile, company_name) values
  ('00000000-0000-0000-0000-00000000c001', 'corporate', 'Acme', 'Testing', '+919000000001', 'Acme Testing'),
  ('00000000-0000-0000-0000-00000000c002', 'individual', 'Emp', 'Loyee', '+919000000002', null),
  ('00000000-0000-0000-0000-00000000c003', 'individual', 'Parent', 'Payer', '+919000000003', null),
  ('00000000-0000-0000-0000-00000000c004', 'individual', 'Child', 'Payer', '+919000000004', null),
  ('00000000-0000-0000-0000-00000000c005', 'individual', 'Other', 'Client', '+919000000005', null);
update public.customers set passport_surname = 'PAYER', passport_given_name = 'CHILD' where id = '00000000-0000-0000-0000-00000000c004';
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000d4', 'child@test.local', '{"role":"client","full_name":"Child Payer","customer_id":"00000000-0000-0000-0000-00000000c004"}'),
  ('00000000-0000-0000-0000-0000000000d5', 'other@test.local', '{"role":"client","full_name":"Other Client","customer_id":"00000000-0000-0000-0000-00000000c005"}');

-- cases (as the owner): A owns case 1 (company pays, employee travels) and case 2 (parent pays, child travels)
insert into public.cases (id, customer_id, title, assigned_to, created_by, status) values
  ('00000000-0000-0000-0000-0000000ca5e1', '00000000-0000-0000-0000-00000000c001', 'Corporate trip', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'confirmed'),
  ('00000000-0000-0000-0000-0000000ca5e2', '00000000-0000-0000-0000-00000000c003', 'Child trip', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'booked');
insert into public.case_travellers values
  ('00000000-0000-0000-0000-0000000ca5e1', '00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-0000000ca5e2', '00000000-0000-0000-0000-00000000c004');

-- ================================================================== A: payer and traveller history, corporate passengers
select throws_like($$ insert into public.case_travellers values ('00000000-0000-0000-0000-0000000ca5e1', '00000000-0000-0000-0000-00000000c001') $$,
  '%corporate_not_passenger%', 'a company can never become a passenger');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
insert into r select 'hist_company', public.customer_case_history('00000000-0000-0000-0000-00000000c001') -> 0 ->> 'relationship';
insert into r select 'hist_employee', public.customer_case_history('00000000-0000-0000-0000-00000000c002') -> 0 ->> 'relationship';
insert into r select 'hist_parent', public.customer_case_history('00000000-0000-0000-0000-00000000c003') -> 0 ->> 'relationship';
-- changing who pays leaves the travellers exactly as they were
update public.cases set customer_id = '00000000-0000-0000-0000-00000000c005' where id = '00000000-0000-0000-0000-0000000ca5e2';
insert into r select 'trav_after_payer', string_agg(customer_id::text, ',') from public.case_travellers where case_id = '00000000-0000-0000-0000-0000000ca5e2';
update public.cases set customer_id = '00000000-0000-0000-0000-00000000c003' where id = '00000000-0000-0000-0000-0000000ca5e2';
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over

select is((select v from r where k = 'hist_company'), 'payer', 'a non-travelling company payer sees the case as payer');
select is((select v from r where k = 'hist_employee'), 'traveller', 'the travelling employee sees it as traveller');
select is((select v from r where k = 'hist_parent'), 'payer', 'a parent paying for a child sees it as payer');
select is((select v from r where k = 'trav_after_payer'), '00000000-0000-0000-0000-00000000c004', 'changing the payer does not change the passengers');

-- ================================================================== B: task → case, idempotent; linking several tasks
insert into public.tasks (id, title, customer_id, assigned_to, created_by, due_at, priority, notes) values
  ('00000000-0000-0000-0000-00000000f001', 'Quote Goa trip', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '2026-12-01 10:00+05:30', 'high', 'Keep these notes'),
  ('00000000-0000-0000-0000-00000000f002', 'Collect passport copy', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', null, 'normal', null),
  ('00000000-0000-0000-0000-00000000f003', 'Pay electricity bill', null, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', null, 'normal', null);
insert into public.task_comments (task_id, author, body) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', 'first comment');
insert into r select 'cases_before', count(*)::text from public.cases;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
insert into r select 'conv1', public.create_case_from_task('00000000-0000-0000-0000-00000000f001', '{"title":"Goa"}', array['00000000-0000-0000-0000-00000000c004']::uuid[]) ->> 'id';
insert into r select 'conv2', public.create_case_from_task('00000000-0000-0000-0000-00000000f001', '{"title":"Goa again"}', '{}') ->> 'id';
insert into r select 'conv2_existing', public.create_case_from_task('00000000-0000-0000-0000-00000000f001', '{}', '{}') ->> 'existing';
insert into r select 'link2', public.link_task_to_case('00000000-0000-0000-0000-00000000f002', (select v::uuid from r where k = 'conv1')) ->> 'max_id';
do $$ begin
  perform public.link_task_to_case('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000ca5e2', null);
  insert into r values ('relink_noreason', 'ok');
exception when others then insert into r values ('relink_noreason', sqlerrm); end $$;
do $$ begin
  update public.tasks set case_id = '00000000-0000-0000-0000-0000000ca5e2' where id = '00000000-0000-0000-0000-00000000f002';
  insert into r values ('relink_direct', 'ok');
exception when others then insert into r values ('relink_direct', sqlerrm); end $$;
insert into r select 'relink_reason', public.link_task_to_case('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000ca5e2', 'wrong trip') ->> 'max_id';
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over

select is((select v from r where k = 'conv2'), (select v from r where k = 'conv1'), 'repeating a conversion returns the same case');
select is((select v from r where k = 'conv2_existing'), 'true', 'and says it already existed');
select is((select count(*)::text from public.cases), ((select v::int from r where k = 'cases_before') + 1)::text, 'promoting and retrying one task creates exactly one MAX ID');
select results_eq($$ select case_id::text, assigned_to::text, due_at, priority, notes, status from public.tasks where id = '00000000-0000-0000-0000-00000000f001' $$,
  $$ select (select v from r where k = 'conv1'), '00000000-0000-0000-0000-0000000000a1', '2026-12-01 10:00+05:30'::timestamptz, 'high'::text, 'Keep these notes'::text, 'todo'::text $$,
  'the task keeps its id, owner, due time, priority and notes, and is not completed');
select is((select count(*)::int from public.task_comments where task_id = '00000000-0000-0000-0000-00000000f001'), 1, 'comments stay on the task');
select is((select count(*)::int from public.case_travellers where case_id = (select v::uuid from r where k = 'conv1')), 1, 'travellers were added in the same transaction');
select ok((select v from r where k = 'link2') like 'MAX-%', 'a second task links to the same trip without a new MAX ID');
select ok((select v from r where k = 'relink_noreason') like '%relink_needs_reason%', 'moving a linked task needs a reason');
select ok((select v from r where k = 'relink_direct') like '%relink_needs_reason%', 'a direct update cannot move a linked task either');
select ok(exists (select 1 from public.activity_log where action = 'relink' and entity_id = '00000000-0000-0000-0000-00000000f002'), 'a deliberate relink is recorded');
select is((select case_id from public.tasks where id = '00000000-0000-0000-0000-00000000f003'), null, 'office tasks stay independent');

-- staff B cannot see A's cases: cannot link to them
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
insert into public.tasks (id, title, assigned_to) values ('00000000-0000-0000-0000-00000000f004', 'B task', '00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform public.link_task_to_case('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000ca5e1');
  insert into r values ('b_link', 'ok');
exception when others then insert into r values ('b_link', sqlstate); end $$;
insert into r select 'b_sees_cases', count(*)::text from public.cases where id in ('00000000-0000-0000-0000-0000000ca5e1', '00000000-0000-0000-0000-0000000ca5e2');
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over
select is((select v from r where k = 'b_link'), '42501', 'staff cannot link a task to a case they may not open');
select is((select v from r where k = 'b_sees_cases'), '0', 'and cannot see those cases at all');

-- ================================================================== E: ticket import confirm (multi-passenger return)
insert into public.ticket_imports (id, status, channel, storage_path, file_name, mime, size, sha256, customer_id, uploaded_by, draft, draft_version) values
  ('00000000-0000-0000-0000-0000000001a1', 'needs_review', 'staff', 'imports/test-1.pdf', 'ticket.pdf', 'application/pdf', 1000, repeat('a', 64),
   '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000000a1',
   '{"schema_version":"ticket-extract/1","source":"provider","document_kind":"e_ticket","issue_date":{"value":""},
     "passengers":[
       {"key":"p1","name_as_issued":{"value":"PAYER/CHILD MSTR"},"pax_type":{"value":"CHD"},"tickets":[{"number":{"value":"098-1234567890"},"segments":["s1","s2"]}]},
       {"key":"p2","name_as_issued":{"value":"NEWPERSON/TEST MR"},"pax_type":{"value":"ADT"},"tickets":[{"number":{"value":"098-1234567891"},"segments":["s1","s2"]}]}],
     "segments":[
       {"key":"s1","from":{"value":"BOM"},"to":{"value":"DXB"},"dep_date":{"value":"2026-12-20"},"dep_time":{"value":"23:30"},"arr_date":{"value":"2026-12-21"},"arr_time":{"value":"01:15"},"airline":{"value":"Test Air"},"flight_no":{"value":"TA 101"},"cabin":{"value":""},"baggage":{"value":""},"fare_basis":{"value":""}},
       {"key":"s2","from":{"value":"DXB"},"to":{"value":"BOM"},"dep_date":{"value":"2026-12-28"},"dep_time":{"value":"09:00"},"arr_date":{"value":"2026-12-28"},"arr_time":{"value":"13:45"},"airline":{"value":"Test Air"},"flight_no":{"value":"TA 102"},"cabin":{"value":""},"baggage":{"value":""},"fare_basis":{"value":""}}],
     "airline_pnrs":[{"value":"TST123"}],"supplier_refs":[{"value":"GDS-1","kind":"GDS"}],
     "amounts":[{"label":"Total","amount":{"value":"54320.00"},"currency":{"value":"INR"},"scope":"document"}]}', 3);
insert into r select 'cases_before_import', count(*)::text from public.cases;
insert into r select 'payments_before', count(*)::text from public.payments;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
-- a confirmation that fails half-way (after the new person and the new MAX ID were written, the booking to update
-- doesn't exist) leaves nothing behind
do $$ begin
  perform public.confirm_ticket_import('00000000-0000-0000-0000-0000000001a1', 3, 'key-fail-0001', '{
    "payer_customer_id":"00000000-0000-0000-0000-00000000c003","case":{"mode":"new","title":"Dubai","stage":"booked"},
    "booking":{"mode":"update","line_id":"00000000-0000-0000-0000-0000000dead1","comparison_reviewed":true},
    "booked_by":"agency","line_status":"confirmed",
    "passengers":[{"customer_id":"00000000-0000-0000-0000-00000000c004"},{"create":{"first_name":"Test","last_name":"Newperson","mobile":"+919000000009"}}]}');
  insert into r values ('partial', 'ok');
exception when others then insert into r values ('partial', sqlerrm); end $$;
-- a stale version is refused
do $$ begin
  perform public.confirm_ticket_import('00000000-0000-0000-0000-0000000001a1', 2, 'key-old-00001', '{}');
  insert into r values ('stale', 'ok');
exception when others then insert into r values ('stale', sqlerrm); end $$;
insert into r select 'confirm1', public.confirm_ticket_import('00000000-0000-0000-0000-0000000001a1', 3, 'key-good-0001', '{
    "payer_customer_id":"00000000-0000-0000-0000-00000000c003","case":{"mode":"new","title":"Dubai","stage":"booked"},"booking":{"mode":"new"},
    "booked_by":"agency","line_status":"confirmed",
    "passengers":[{"customer_id":"00000000-0000-0000-0000-00000000c004"},{"create":{"first_name":"Test","last_name":"Newperson","mobile":"+919000000009"}}]}')::text;
insert into r select 'confirm_same', public.confirm_ticket_import('00000000-0000-0000-0000-0000000001a1', 3, 'key-good-0001', '{}') ->> 'already_confirmed';
insert into r select 'confirm_other', public.confirm_ticket_import('00000000-0000-0000-0000-0000000001a1', 3, 'key-other-001', '{}') ->> 'case_id';
-- staff cannot publish the imported file, or share it
do $$ begin
  update public.files set visible_to_client = true where import_id = '00000000-0000-0000-0000-0000000001a1';
  insert into r values ('staff_publish', 'ok');
exception when others then insert into r values ('staff_publish', sqlerrm); end $$;
do $$ begin
  insert into public.share_links (file_id) select id from public.files where import_id = '00000000-0000-0000-0000-0000000001a1';
  insert into r values ('staff_share', 'ok');
exception when others then insert into r values ('staff_share', sqlerrm); end $$;
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over

select ok((select v from r where k = 'partial') like '%import_incomplete%', 'a failing confirmation reports what is missing');
select is((select count(*)::text from public.cases), ((select v::int from r where k = 'cases_before_import') + 1)::text, 'the failed attempt left no case behind (only the good one exists)');
select ok((select v from r where k = 'stale') like '%import_version_conflict%', 'confirming an older version is refused');
select is((select v from r where k = 'confirm_same'), 'true', 'repeating the same confirmation returns the first result');
select is((select v from r where k = 'confirm_other'), (select (v::jsonb) ->> 'case_id' from r where k = 'confirm1'), 'a simultaneous second confirmation gets the same result');
select is((select count(*)::int from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000001a1'), 1, 'one booking was created');
select is((select count(*)::int from public.customers where last_name = 'Newperson'), 1, 'one new traveller was created');
select results_eq($$
  select jsonb_array_length(details -> 'sectors'), jsonb_array_length(details -> 'tickets'), details ->> 'trip_type', details -> 'sectors' -> 0 ->> 'arr_date',
         (select string_agg(t ->> 'name_as_issued', '|' order by t ->> 'number') from jsonb_array_elements(details -> 'tickets') t),
         jsonb_array_length(details -> 'document_amounts')
  from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000001a1' $$,
  $$ values (2, 2, 'return'::text, '2026-12-21'::text, 'PAYER/CHILD MSTR|NEWPERSON/TEST MR'::text, 1) $$,
  'both legs, one ticket per passenger with its issued name, explicit arrival date, and one document-level fare');
select results_eq($$ select selling_price, supplier_cost, commission_amount, gst, pricing_state, visible_to_client from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000001a1' $$,
  $$ values (0::numeric, 0::numeric, 0::numeric, 0::numeric, 'not_entered'::text, false) $$, 'no sale, cost, commission or GST is created from the fare; the booking is private');
select is((select count(*)::text from public.payments), (select v from r where k = 'payments_before'), 'no receipt, payment, refund or supplier payable is created');
select ok((select v from r where k = 'staff_publish') like '%Only the boss%', 'staff cannot publish an imported file');
select ok((select v from r where k = 'staff_share') like '%unpublished_file%', 'staff cannot share an unpublished import');
select is((select count(*)::int from public.case_travellers where case_id = (select ((v::jsonb) ->> 'case_id')::uuid from r where k = 'confirm1')), 2, 'both travellers are on the new case; the payer was not added');

-- ================================================================== A4: profile edit keeps the issued name; reissue keeps history
update public.customers set first_name = 'Renamed' where id = '00000000-0000-0000-0000-00000000c004';
select is((select t ->> 'name_as_issued' from public.booking_lines l, jsonb_array_elements(l.details -> 'tickets') t
           where l.import_id = '00000000-0000-0000-0000-0000000001a1' and t ->> 'customer_id' = '00000000-0000-0000-0000-00000000c004'),
          'PAYER/CHILD MSTR', 'editing the profile does not rewrite the issued ticket name');
update public.booking_lines set details = jsonb_set(details, '{tickets,0,number}', '"098-9999999999"') where import_id = '00000000-0000-0000-0000-0000000001a1';
select ok((select jsonb_array_length(details -> 'ticket_history') from public.booking_lines where import_id = '00000000-0000-0000-0000-0000000001a1') = 1, 'a replaced ticket number is kept in history');

-- ================================================================== portal: own client vs unrelated client
update public.files set visible_to_client = false where import_id = '00000000-0000-0000-0000-0000000001a1';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}';
insert into r select 'own_trip_files', jsonb_array_length(coalesce(public.portal_trip((select ((v::jsonb) ->> 'case_id')::uuid from r where k = 'confirm1')) -> 'files', '[]'))::text;
insert into r select 'own_file_access', count(*)::text from public.file_access((select ((v::jsonb) ->> 'file_id')::uuid from r where k = 'confirm1'));
insert into r select 'own_imports_table', count(*)::text from public.ticket_imports;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d5","role":"authenticated"}';
insert into r select 'other_trip', coalesce(public.portal_trip((select ((v::jsonb) ->> 'case_id')::uuid from r where k = 'confirm1'))::text, 'null');
insert into r select 'other_source', count(*)::text from public.import_source_access('00000000-0000-0000-0000-0000000001a1');
insert into r select 'other_customers', count(*)::text from public.customers;
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over
select is((select v from r where k = 'own_trip_files'), '0', 'the traveller''s trip view does not show the unpublished ticket file');
select is((select v from r where k = 'own_file_access'), '0', 'and the traveller cannot download it before it is published');
select is((select v from r where k = 'own_imports_table'), '0', 'portal users cannot read import records directly');
select is((select v from r where k = 'other_trip'), 'null', 'an unrelated client cannot open the trip');
select is((select v from r where k = 'other_source'), '0', 'an unrelated client cannot get the source file');
select is((select v from r where k = 'other_customers'), '0', 'an unrelated client cannot list customers');

-- ================================================================== A6: required work blocks completion; overrides are recorded
insert into public.tasks (title, case_id, assigned_to, created_by, blocking) values
  ('Required check', '00000000-0000-0000-0000-0000000ca5e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
insert into r select 'complete_noreason', public.complete_case('00000000-0000-0000-0000-0000000ca5e2', null) ->> 'completed';
do $$ begin
  perform public.complete_case('00000000-0000-0000-0000-0000000ca5e2', 'done anyway');
  insert into r values ('complete_staff_override', 'ok');
exception when others then insert into r values ('complete_staff_override', sqlerrm); end $$;
do $$ begin
  update public.cases set status = 'completed' where id = '00000000-0000-0000-0000-0000000ca5e2';
  insert into r values ('complete_direct', 'ok');
exception when others then insert into r values ('complete_direct', sqlerrm); end $$;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
insert into r select 'complete_boss', public.complete_case('00000000-0000-0000-0000-0000000ca5e2', 'Client confirmed by phone') ->> 'overridden';
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over
select is((select v from r where k = 'complete_noreason'), 'false', 'a blocking task stops completion and lists what is open');
select ok((select v from r where k = 'complete_staff_override') like '%override_not_permitted%', 'staff cannot override required work');
select ok((select v from r where k = 'complete_direct') like '%case_completion_direct%', 'a direct status update cannot skip the checks');
select is((select v from r where k = 'complete_boss'), 'true', 'the boss can override with a reason');
select ok(exists (select 1 from public.activity_log where action = 'override' and case_id = '00000000-0000-0000-0000-0000000ca5e2'), 'the override is in the activity history');

-- ================================================================== F: departures by segment
insert into public.booking_lines (case_id, service, status, traveller_ids, details) values
  ('00000000-0000-0000-0000-0000000ca5e1', 'hotel', 'confirmed', '{}', '{"hotel_name":"Test Inn","check_in":"2026-12-20","check_out":"2026-12-28"}');
select is((select count(*)::int from public.departures('2026-12-01', '2026-12-31') d where d.case_id = (select ((v::jsonb) ->> 'case_id')::uuid from r where k = 'confirm1')),
  2, 'outbound and return both count as departures');
select is((select count(*)::int from public.departures('2026-12-01', '2026-12-31') where service = 'hotel'), 0, 'hotel dates never count as departures');
select is((select count(*)::int from public.service_dates('2026-12-01', '2026-12-31') where service = 'hotel'), 2, 'hotel check-in and check-out are listed separately');

-- ================================================================== A8: money in the database matches the browser rules
insert into public.booking_lines (id, case_id, service, status, traveller_ids, supplier_cost, commission_type, commission_value, details) values
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000ca5e1', 'other', 'pending', '{}', 10000, 'percent', 7, '{"title":"a","base_fare":"1234.50"}'),
  ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000ca5e1', 'other', 'pending', '{}', 10000, 'percent', 7, '{"title":"b","base_fare":""}'),
  ('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-0000000ca5e1', 'other', 'pending', '{}', 10000, 'percent', 7, '{"title":"c","base_fare":0}');
select results_eq($$ select commission_amount from public.booking_lines where id in ('00000000-0000-0000-0000-0000000b0001','00000000-0000-0000-0000-0000000b0002','00000000-0000-0000-0000-0000000b0003') order by id $$,
  $$ values (86.42::numeric), (700::numeric), (0::numeric) $$, 'base fare given, missing and zero give the same commission as the browser');
select throws_like($$ insert into public.booking_lines (case_id, service, details) values ('00000000-0000-0000-0000-0000000ca5e1', 'other', '{"title":"x","base_fare":"12a"}') $$,
  '%invalid_amount%', 'an unreadable base fare is refused, not treated as zero');

-- ================================================================== existing manual workflow still works
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
do $$ begin
  insert into public.booking_lines (case_id, service, status, traveller_ids, selling_price, supplier_cost, details)
  values ('00000000-0000-0000-0000-0000000ca5e1', 'flight', 'pending', array['00000000-0000-0000-0000-00000000c002']::uuid[], 5000, 4500,
          '{"trip_type":"one-way","sectors":[{"from":"DEL","to":"BOM","date":"2026-12-05","dep":"07:00","arr":"09:10"}],"tickets":[{"customer_id":"00000000-0000-0000-0000-00000000c002","passenger":"Emp Loyee","number":"098-1111111111"}]}');
  insert into r values ('manual_line', 'ok');
exception when others then insert into r values ('manual_line', sqlerrm); end $$;
reset role; reset request.jwt.claims;   -- back to the owner, with no user identity left over
select is((select v from r where k = 'manual_line'), 'ok', 'staff can still add a manual flight booking (legacy sector without arrival date)');
select is((select details -> 'tickets' -> 0 ->> 'name_as_issued' from public.booking_lines where details ->> 'trip_type' = 'one-way' and case_id = '00000000-0000-0000-0000-0000000ca5e1'),
  'Emp Loyee', 'a manually entered ticket records the issued name');

select * from finish();
rollback;
