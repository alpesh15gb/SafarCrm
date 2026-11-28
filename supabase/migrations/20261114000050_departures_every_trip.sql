-- Departures (dashboard, next 7 days) list every trip, not only cases with a flight/rail/bus booking (owner, 2026-11-28).
-- Users saw "No one is travelling in the next 7 days" while cases did travel this week: the list (since
-- 20261114000045) took the case dates only when the case had a live flight, rail or bus booking, so a case with just a
-- hotel or visa booking, or none yet, never showed. Now every case that is not cancelled shows on its From date
-- ("departure") and its To date ("return", when it is another day). A case with a live flight/rail/bus booking shows
-- as that service; any other case shows as "trip". Cases with typed flight legs keep showing those legs (never both).
create or replace function public.departures(p_from date, p_to date)
returns table (case_id uuid, max_id text, customer text, line_id uuid, service text, dep_date date, dep_time text,
               from_code text, to_code text, carrier text, leg int, legs int, line_status text, assigned_to uuid)
language sql stable security invoker set search_path = public as $$
  with typed as (
    select c.id, c.max_id, cu.full_name, l.id as line_id, l.service, (s ->> 'date')::date as d, nullif(s ->> 'dep', '') as t,
           upper(s ->> 'from') as fc, upper(s ->> 'to') as tc, nullif(concat_ws(' ', s ->> 'airline', s ->> 'flight_no'), '') as carrier,
           o::int as leg, jsonb_array_length(l.details -> 'sectors') as legs, l.status, c.assigned_to
    from public.booking_lines l
    join public.cases c on c.id = l.case_id
    join public.customers cu on cu.id = c.customer_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(l.details -> 'sectors') = 'array' then l.details -> 'sectors' else '[]'::jsonb end)
      with ordinality x(s, o)
    where l.service = 'flight' and l.status <> 'cancelled' and c.status <> 'cancelled'
      and coalesce(s ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    union all
    select c.id, c.max_id, cu.full_name, l.id, l.service, (l.details ->> 'date')::date,
           nullif(coalesce(l.details ->> 'departure_time', l.details ->> 'boarding_time'), ''),
           upper(l.details ->> 'from'), upper(l.details ->> 'to'), nullif(coalesce(l.details ->> 'train_no', l.details ->> 'operator'), ''),
           1, 1, l.status, c.assigned_to
    from public.booking_lines l
    join public.cases c on c.id = l.case_id
    join public.customers cu on cu.id = c.customer_id
    where l.service in ('rail', 'bus') and l.status <> 'cancelled' and c.status <> 'cancelled'
      and coalesce(l.details ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  -- every other case with a travel date: one row for the From date, one for the To date (the return) when it is another day
  from_case as (
    select c.id, c.max_id, cu.full_name, coalesce(b.line_id, c.id) as line_id, coalesce(b.service, 'trip') as service, v.d, v.leg,
           case when c.travel_end is not null and c.travel_end <> c.travel_start then 2 else 1 end as legs,
           b.status, c.assigned_to
    from public.cases c
    join public.customers cu on cu.id = c.customer_id
    left join lateral (
      select l.id as line_id, l.service, l.status from public.booking_lines l
      where l.case_id = c.id and l.service in ('flight', 'rail', 'bus') and l.status <> 'cancelled'
      order by case l.service when 'flight' then 0 when 'rail' then 1 else 2 end, l.created_at limit 1
    ) b on true
    cross join lateral (values (c.travel_start, 1), (case when c.travel_end <> c.travel_start then c.travel_end end, 2)) v(d, leg)
    where c.status <> 'cancelled' and c.travel_start is not null and v.d is not null
      and not exists (select 1 from typed t where t.id = c.id)
  )
  select id, max_id, full_name, line_id, service, d, t, fc, tc, carrier, leg, legs, status, assigned_to
  from typed where d between p_from and p_to
  union all
  select id, max_id, full_name, line_id, service, d, null, null, null, null, leg, legs, status, assigned_to
  from from_case where d between p_from and p_to
$$;
revoke execute on function public.departures(date, date) from public, anon;
grant execute on function public.departures(date, date) to authenticated;
