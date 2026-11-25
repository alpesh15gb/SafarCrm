-- Save the case, its travellers and initial bookings together. Keep the booking IDs
-- with the request so a retried create can still attach files to the original rows.
alter table public.case_requests add column initial_bookings jsonb not null default '[]'::jsonb;

create or replace function public.create_case(p jsonb, p_travellers uuid[] default '{}', p_request_key text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  cid uuid; mx text; tags text[]; pax uuid[]; initial jsonb;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'case_title_required' using errcode = 'P0001'; end if;
  if nullif(p ->> 'customer_id', '') is null then raise exception 'case_customer_required' using errcode = 'P0001'; end if;
  if p_request_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('case_request:' || p_request_key, 0));
    select r.case_id, r.initial_bookings into cid, initial from public.case_requests r where r.request_key = p_request_key;
    if cid is not null then
      select c.max_id into mx from public.cases c where c.id = cid;
      return jsonb_build_object('id', cid, 'max_id', mx, 'existing', true, 'bookings', initial);
    end if;
  end if;
  tags := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p -> 'tags') = 'array' then p -> 'tags' else '[]'::jsonb end)), '{}');
  insert into public.cases (customer_id, title, travel_start, travel_end, destination, lead_source, assigned_to, status, notes, tags)
  values ((p ->> 'customer_id')::uuid, trim(p ->> 'title'), nullif(p ->> 'travel_start', '')::date, nullif(p ->> 'travel_end', '')::date,
          nullif(trim(coalesce(p ->> 'destination', '')), ''), nullif(trim(coalesce(p ->> 'lead_source', '')), ''),
          nullif(p ->> 'assigned_to', '')::uuid, coalesce(nullif(p ->> 'status', ''), 'enquiry'),
          nullif(trim(coalesce(p ->> 'notes', '')), ''), tags)
  returning id, max_id into cid, mx;
  insert into public.case_travellers (case_id, customer_id)
  select distinct cid, x from unnest(coalesce(p_travellers, '{}'::uuid[])) x where x is not null
  on conflict do nothing;
  select array(select c.customer_id from public.case_travellers c where c.case_id = cid order by c.customer_id) into pax;

  with added as (
    insert into public.booking_lines (case_id, service, status, pricing_state, traveller_ids, details, sort)
    select cid, b.value ->> 'service', 'pending', 'not_entered', per_line.ids,
           coalesce(b.value -> 'details', '{}'::jsonb), row_number() over (order by b.position, per_line.ids) - 1
    from jsonb_array_elements(coalesce(p -> 'bookings', '[]'::jsonb)) with ordinality b(value, position)
    cross join lateral (
      select array[person] as ids from unnest(pax) person where b.value ->> 'service' = 'visa' and cardinality(pax) > 1
      union all
      select pax where b.value ->> 'service' <> 'visa' or cardinality(pax) <= 1
    ) per_line
    returning id, service, sort
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'service', service) order by sort), '[]'::jsonb) into initial from added;

  if p_request_key is not null then
    insert into public.case_requests (request_key, case_id, initial_bookings) values (p_request_key, cid, initial);
  end if;
  return jsonb_build_object('id', cid, 'max_id', mx, 'existing', false, 'bookings', initial);
end $$;
