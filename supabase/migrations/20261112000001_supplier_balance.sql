-- Supplier balances are agency-wide (QA 2026-11-09).
-- Before: "payable" only counted the bookings the viewer may see (staff: their own cases), while "paid" counted every
-- payment to the supplier, so staff saw ₹0 payable and a false "advance". A supplier's balance is one number for the
-- agency, and staff need the true figure before paying, so the totals are now worked out over all bookings.
-- Only totals per supplier are exposed (no cases, customers, prices or profit), and only to boss and staff.
-- The view runs as its owner (security_invoker off) and filters on is_team() itself.
drop function if exists public.report_supplier_dues(uuid);
drop view if exists public.v_supplier_balance;
create view public.v_supplier_balance with (security_invoker = false) as
select s.id as supplier_id, s.name,
       coalesce((select sum(public.line_cost(l)) from public.booking_lines l where l.supplier_id = s.id), 0) as payable,
       coalesce((select sum(p.amount) from public.payments p where p.supplier_id = s.id and p.direction = 'out'), 0) as paid,
       (select min(l.supplier_due_date) from public.booking_lines l where l.supplier_id = s.id and l.status <> 'cancelled') as oldest_due
from public.suppliers s
where public.is_team();
revoke all on public.v_supplier_balance from public, anon;
grant select on public.v_supplier_balance to authenticated;

create function public.report_supplier_dues(p_supplier uuid default null)
returns table (supplier_id uuid, name text, payable numeric, paid numeric, due numeric, oldest_due date)
language sql stable set search_path = public as $$
  select b.supplier_id, b.name, b.payable, b.paid, b.payable - b.paid, b.oldest_due
  from public.v_supplier_balance b
  where b.payable - b.paid <> 0 and (p_supplier is null or b.supplier_id = p_supplier)
  order by b.payable - b.paid desc
$$;
revoke execute on function public.report_supplier_dues(uuid) from public, anon;
grant execute on function public.report_supplier_dues(uuid) to authenticated;
