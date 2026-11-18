-- Which cases the dashboard shows (owner, 2026-11-18). Additive; the case itself always stays in the records.
--   * A case shows while its trip is not over: until the last travel date (the return flight, hotel check-out,
--     case end date...) has passed. A one-way flight on 18-11 is gone from the dashboard on 19-11.
--   * After that it stays only while the client still owes money, until the payment is received.
--   * A case with no travel date yet shows while it is open (an enquiry still being worked on).
--   * Cancelled cases never show.

-- the last day of travel: the latest of the case dates and every booking's dates (flight sectors, hotel check-out,
-- insurance end, rail/bus date). Visas don't count: their date is the application, not travel.
create or replace function public.case_trip_end(p_case uuid) returns date
language sql stable security invoker set search_path = public as $$
  select greatest(c.travel_start, c.travel_end, (
    select max(x.d) from public.booking_lines l
    cross join lateral (
      select l.service_date as d
      union all
      select (s ->> 'date')::date from jsonb_array_elements(
        case when l.service = 'flight' and jsonb_typeof(l.details -> 'sectors') = 'array' then l.details -> 'sectors' else '[]'::jsonb end) s
      where s ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
      union all
      select (l.details ->> 'check_out')::date where l.service = 'hotel' and l.details ->> 'check_out' ~ '^\d{4}-\d{2}-\d{2}$'
      union all
      select (l.details ->> 'end_date')::date where l.service = 'insurance' and l.details ->> 'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
    ) x
    where l.case_id = c.id and l.status <> 'cancelled' and l.service <> 'visa'))
  from public.cases c where c.id = p_case
$$;

-- the cases on the dashboard (row-level security: only cases this person may see)
create or replace function public.dashboard_case_ids() returns table (case_id uuid)
language sql stable security invoker set search_path = public as $$
  select c.id
  from public.cases c
  left join public.v_case_money m on m.case_id = c.id
  cross join lateral (select public.case_trip_end(c.id) as trip_end) t
  where c.status <> 'cancelled'
    and (coalesce(m.due, 0) > 0.009
         or t.trip_end >= (now() at time zone 'Asia/Kolkata')::date
         or (t.trip_end is null and c.status <> 'completed'))
$$;

-- the stage counts on the dashboard follow the same rule
create or replace function public.dashboard_pipeline()
returns table (status text, cases bigint, sale numeric, due numeric)
language sql stable security invoker set search_path = public as $$
  select c.status::text, count(*), coalesce(sum(m.sale), 0), coalesce(sum(greatest(m.due, 0)), 0)
  from public.cases c left join public.v_case_money m on m.case_id = c.id
  where c.id in (select case_id from public.dashboard_case_ids())
  group by c.status
$$;

revoke execute on function public.case_trip_end(uuid) from public, anon;
grant execute on function public.case_trip_end(uuid) to authenticated;
revoke execute on function public.dashboard_case_ids() from public, anon;
grant execute on function public.dashboard_case_ids() to authenticated;
