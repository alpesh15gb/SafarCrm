-- Expenses belong to a case, so service/supplier filters cannot assign them to individual bookings.
-- Keep the full case expense once per matching case. A filtered P&L therefore shows matching booking
-- profit less full case expenses. Separate filtered reports must not be added together.
create or replace function public.report_pnl(p_from date, p_to date, p_service text default null, p_staff uuid default null,
                                             p_supplier uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, booked_on date, customer text, title text, staff text, status text,
               sale numeric, cost numeric, commission numeric, expenses numeric, profit numeric, margin numeric)
language plpgsql stable security invoker set search_path = public as $$
begin
  perform private.need_profit();
  return query
  select c.id, c.max_id, (c.created_at at time zone 'Asia/Kolkata')::date, cu.full_name, c.title, pr.full_name, c.status,
         l.sale, l.cost, l.commission, e.amt, l.profit - e.amt,
         case when l.sale <> 0 then round((l.profit - e.amt) / l.sale * 100, 1) end
  from public.cases c
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  cross join lateral (
    select count(*) as matching_lines,
           coalesce(sum(public.line_sale(x)), 0) sale, coalesce(sum(public.line_cost(x)), 0) cost,
           coalesce(sum(case when x.status = 'cancelled' then 0 else x.commission_amount end), 0) commission,
           coalesce(sum(public.line_profit(x)), 0) profit
    from public.booking_lines x where x.case_id = c.id
      and (p_service is null or x.service = p_service) and (p_supplier is null or x.supplier_id = p_supplier)) l
  cross join lateral (
    select coalesce(sum(x.amount), 0) amt from public.expenses x where x.case_id = c.id) e
  where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    and c.status not in ('enquiry','quoted')
    and (p_staff is null or c.assigned_to = p_staff)
    and (p_customer is null or c.customer_id = p_customer)
    and ((p_service is null and p_supplier is null) or l.matching_lines > 0)
  order by c.created_at desc;
end $$;
