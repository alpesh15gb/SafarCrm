-- Keep optional pricing in the same transaction as the case and its initial bookings.
create or replace function public.create_case(p jsonb, p_travellers uuid[] default '{}', p_request_key text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  cid uuid; mx text; tags text[]; pax uuid[]; initial jsonb; trip_date date;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  commission_allowed boolean;
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
  returning id, max_id, travel_start into cid, mx, trip_date;
  insert into public.case_travellers (case_id, customer_id)
  select distinct cid, x from unnest(coalesce(p_travellers, '{}'::uuid[])) x where x is not null
  on conflict do nothing;
  select array(select c.customer_id from public.case_travellers c where c.case_id = cid order by c.customer_id) into pax;

  commission_allowed := public.can_see_profit();
  with added as (
    insert into public.booking_lines (case_id, service, status, pricing_state, traveller_ids, details, sort,
                                      supplier_cost, selling_price, commission_type, commission_value, gst)
    select cid, b.value ->> 'service', 'pending',
           case when price.supplier_cost is null and price.selling_price is null then 'not_entered' else 'entered' end,
           per_line.ids, coalesce(b.value -> 'details', '{}'::jsonb), row_number() over (order by b.position, per_line.ids) - 1,
           coalesce(price.supplier_cost, 0), coalesce(price.selling_price, 0),
           case when commission_allowed and b.value ->> 'service' <> 'visa' and price.commission_type = 'percent' then 'percent' else 'amount' end,
           case when commission_allowed and b.value ->> 'service' <> 'visa' then coalesce(price.commission_value, 0) else 0 end,
           coalesce(price.gst, 0)
    from jsonb_array_elements(coalesce(p -> 'bookings', '[]'::jsonb)) with ordinality b(value, position)
    cross join lateral jsonb_to_record(coalesce(nullif(b.value -> 'pricing', 'null'::jsonb), '{}'::jsonb))
      price(supplier_cost numeric, selling_price numeric, commission_type text, commission_value numeric, gst numeric)
    cross join lateral (
      select array[person] as ids from unnest(pax) person where b.value ->> 'service' = 'visa' and cardinality(pax) > 1
      union all
      select pax where b.value ->> 'service' <> 'visa' or cardinality(pax) <= 1
    ) per_line
    returning id, service, sort
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'service', service) order by sort), '[]'::jsonb) into initial from added;

  -- The insert triggers calculate service_date from the booking details.
  update public.booking_lines l
  set payment_due_date = case when coalesce(l.service_date, trip_date) is null then today + 3
                              else greatest(today, coalesce(l.service_date, trip_date) - 7) end
  where l.case_id = cid and l.selling_price > 0 and l.payment_due_date is null;

  if p_request_key is not null then
    insert into public.case_requests (request_key, case_id, initial_bookings) values (p_request_key, cid, initial);
  end if;
  return jsonb_build_object('id', cid, 'max_id', mx, 'existing', false, 'bookings', initial);
end $$;
