-- QA fixes (2026-11-09 report)

-- a trip can't end before it starts (applies however a case is created or edited)
alter table public.cases add constraint trip_dates_order
  check (travel_start is null or travel_end is null or travel_end >= travel_start);

-- client dues: include enquiries/quotes once the client has paid an advance, so that money is never invisible
create or replace function public.report_client_dues(p_staff uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, customer text, mobile text, staff text, billed numeric, received numeric, due numeric,
               due_since date, days int)
language sql stable set search_path = public as $$
  select c.id, c.max_id, cu.full_name, cu.mobile, pr.full_name, m.billed, m.received, m.due, d.since,
         ((now() at time zone 'Asia/Kolkata')::date - d.since)::int
  from public.cases c
  join public.v_case_money m on m.case_id = c.id
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  cross join lateral (select coalesce(min(payment_due_date), (c.created_at at time zone 'Asia/Kolkata')::date) since
                      from public.booking_lines where case_id = c.id and status <> 'cancelled') d
  -- confirmed work, plus any enquiry/quote where the client has already paid an advance
  where m.due > 0 and c.status <> 'cancelled' and (c.status not in ('enquiry','quoted') or m.received > 0)
    and (p_staff is null or c.assigned_to = p_staff) and (p_customer is null or c.customer_id = p_customer)
  order by d.since asc
$$;

create or replace function public.dashboard_money(p_from date, p_to date)
returns jsonb language plpgsql stable set search_path = public as $$
declare res jsonb;
begin
  perform private.need_profit();
  with cs as (
    select c.* from public.cases c
    where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to and c.status not in ('enquiry','quoted')),
  ln as (select x.service, cs.assigned_to, public.line_sale(x) sale, public.line_cost(x) cost, public.line_profit(x) profit
         from public.booking_lines x join cs on cs.id = x.case_id),
  ex as (select coalesce(sum(e.amount), 0) amt from public.expenses e join cs on cs.id = e.case_id)
  select jsonb_build_object(
    'sales', coalesce((select sum(l.sale) from ln l), 0),
    'cost', coalesce((select sum(l.cost) from ln l), 0),
    'profit', coalesce((select sum(l.profit) from ln l), 0) - (select amt from ex),
    'due_from_clients', coalesce((select sum(m.due) from public.v_case_money m join public.cases c on c.id = m.case_id
                                  where m.due > 0 and c.status <> 'cancelled' and (c.status not in ('enquiry','quoted') or m.received > 0)), 0),
    'by_service', coalesce((select jsonb_agg(jsonb_build_object('service', s, 'profit', p, 'sale', sl) order by s)
                   from (select l.service s, sum(l.profit) p, sum(l.sale) sl from ln l group by l.service) z), '[]'),
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name,
                      'cases', (select count(*) from cs where cs.assigned_to = pr.id),
                      'tasks_done', (select count(*) from public.tasks t where t.completed_by = pr.id
                                      and (t.completed_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
                      'profit', coalesce((select sum(l.profit) from ln l where l.assigned_to = pr.id), 0)) order by pr.role, pr.full_name)
                   from public.profiles pr where pr.role in ('boss','staff') and pr.active), '[]')
  ) into res;
  return res;
end $$;
