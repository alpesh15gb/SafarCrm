-- Dashboard extras: monthly trend (profit-gated) and pipeline (row-level security applies)

create or replace function public.dashboard_trend(p_months int default 6)
returns table (month date, sales numeric, profit numeric, cases bigint)
language plpgsql stable set search_path = public as $$
begin
  perform private.need_profit();
  return query
  with mo as (
    select generate_series(date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - make_interval(months => p_months - 1),
                           date_trunc('month', (now() at time zone 'Asia/Kolkata')::date), interval '1 month')::date m),
  cs as (
    select c.id, date_trunc('month', c.created_at at time zone 'Asia/Kolkata')::date m from public.cases c
    where c.status not in ('enquiry','quoted')
      and c.created_at >= (select min(m) from mo)::timestamp at time zone 'Asia/Kolkata'),
  ln as (select cs.m, public.line_sale(x) sale, public.line_profit(x) profit from public.booking_lines x join cs on cs.id = x.case_id),
  ex as (select cs.m, sum(e.amount) amt from public.expenses e join cs on cs.id = e.case_id group by cs.m)
  select mo.m,
         coalesce((select sum(l.sale) from ln l where l.m = mo.m), 0),
         coalesce((select sum(l.profit) from ln l where l.m = mo.m), 0) - coalesce((select ex.amt from ex where ex.m = mo.m), 0),
         (select count(*) from cs where cs.m = mo.m)
  from mo order by mo.m;
end $$;

create or replace function public.dashboard_pipeline()
returns table (status text, cases bigint, sale numeric, due numeric)
language sql stable security invoker set search_path = public as $$
  select c.status::text, count(*), coalesce(sum(m.sale), 0), coalesce(sum(greatest(m.due, 0)), 0)
  from public.cases c left join public.v_case_money m on m.case_id = c.id
  group by c.status
$$;

revoke execute on function public.dashboard_trend(int) from public, anon;
revoke execute on function public.dashboard_pipeline() from public, anon;
grant execute on function public.dashboard_trend(int) to authenticated;
grant execute on function public.dashboard_pipeline() to authenticated;
