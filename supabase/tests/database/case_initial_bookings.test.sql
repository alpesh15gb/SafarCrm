begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(6);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000048b1', 'boss@initial-booking.test', '{"role":"boss","full_name":"Test Owner"}');
insert into public.customers (id, first_name, mobile) values
  ('00000000-0000-0000-0000-00000048c001', 'First Traveller', '+919000048001'),
  ('00000000-0000-0000-0000-00000048c002', 'Second Traveller', '+919000048002');
create temp table created (result jsonb);
grant select, insert on created to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000048b1","role":"authenticated"}';
insert into created select public.create_case(
  '{"customer_id":"00000000-0000-0000-0000-00000048c001","title":"Case with initial bookings","bookings":[
    {"service":"flight","details":{"pnr":"DEMO12"}},{"service":"visa","details":{"country":"UAE"}},{"service":"hotel","details":{}}]}',
  '{00000000-0000-0000-0000-00000048c001,00000000-0000-0000-0000-00000048c002}', 'initial-booking-key');
select is((select jsonb_array_length(result -> 'bookings') from created), 4, 'returns flight, hotel and one visa booking per traveller');
select is((select l.details ->> 'pnr' from public.booking_lines l join created c on l.case_id = (c.result ->> 'id')::uuid where l.service = 'flight'),
  'DEMO12', 'manual flight details are saved on the booking');
select is((select array_agg(cardinality(l.traveller_ids) order by sort) from public.booking_lines l join created c on l.case_id = (c.result ->> 'id')::uuid),
  array[2,1,1,2], 'visa bookings are individual while the other bookings include the case travellers');
select is(public.create_case('{"customer_id":"00000000-0000-0000-0000-00000048c001","title":"Retried request"}', '{}', 'initial-booking-key') -> 'bookings',
  (select result -> 'bookings' from created), 'retries return the original booking IDs');
select throws_like($$select public.create_case(
  '{"customer_id":"00000000-0000-0000-0000-00000048c001","title":"Case rolled back","bookings":[{"service":"bad-service","details":{}}]}',
  '{}', 'bad-initial-booking-key')$$, '%booking_lines_service_check%', 'an invalid booking rejects creation');
select is((select count(*) from public.cases where title = 'Case rolled back'), 0::bigint, 'a failed booking leaves no case behind');

select * from finish();
rollback;
