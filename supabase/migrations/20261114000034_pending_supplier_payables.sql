-- Pending bookings are quotations or holds. Supplier obligations begin when the booking is confirmed.
-- Cancelled bookings retain the supplier cost left after the agreed refund; recorded payments remain advances.
create or replace function public.line_supplier_payable(l public.booking_lines) returns numeric
language sql immutable set search_path = public as $$
  select case when l.status = 'pending' then 0 else public.line_cost(l) end
$$;
revoke execute on function public.line_supplier_payable(public.booking_lines) from public, anon;
grant execute on function public.line_supplier_payable(public.booking_lines) to authenticated, service_role;

create or replace function private.case_supplier_due(p_case uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(public.line_supplier_payable(l)) from public.booking_lines l where l.case_id = p_case), 0)
       - coalesce((select sum(a.amount) from public.payment_allocations a where a.case_id = p_case), 0)
$$;

create or replace view public.v_case_money with (security_invoker = true) as
select c.id as case_id,
       coalesce(l.billed, 0) as billed,
       coalesce(r.received, 0) as received,
       coalesce(l.billed, 0) - coalesce(r.received, 0) as due,
       case when public.can_see_profit() then coalesce(l.payable, 0) end as supplier_payable,
       case when public.can_see_profit() then coalesce(sp.paid, 0) end as supplier_paid,
       case when public.can_see_profit() then coalesce(l.payable, 0) - coalesce(sp.paid, 0) end as supplier_due,
       coalesce(l.sale, 0) as sale,
       case when public.can_see_profit() then coalesce(l.commission, 0) end as commission,
       case when public.can_see_profit() then coalesce(e.expenses, 0) end as expenses,
       case when public.can_see_profit() then coalesce(l.profit, 0) - coalesce(e.expenses, 0) end as profit,
       case when public.can_see_profit() and coalesce(l.sale, 0) > 0
            then round((coalesce(l.profit, 0) - coalesce(e.expenses, 0)) / l.sale * 100, 1) end as margin
from public.cases c
left join lateral (
  select sum(public.line_billed(x)) as billed, sum(public.line_sale(x)) as sale,
         sum(public.line_supplier_payable(x)) as payable,
         sum(case when x.status = 'cancelled' then 0 else x.commission_amount end) as commission,
         sum(public.line_profit(x)) as profit
  from public.booking_lines x where x.case_id = c.id) l on true
left join lateral (select sum(amount) as received from public.payments p where p.case_id = c.id and p.direction = 'in') r on true
left join lateral (select sum(a.amount) as paid from public.payment_allocations a where a.case_id = c.id) sp on true
left join lateral (select sum(amount) as expenses from public.expenses x where x.case_id = c.id) e on true;

create or replace view public.v_case_supplier_money with (security_invoker = true) as
select l.case_id, l.supplier_id, s.name as supplier_name,
       case when public.can_see_profit() then sum(public.line_supplier_payable(l)) end as payable,
       case when public.can_see_profit() then coalesce((select sum(a.amount) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                 where a.case_id = l.case_id and p.supplier_id = l.supplier_id), 0) end as paid,
       min(l.supplier_due_date) filter (where public.line_supplier_payable(l) > 0) as due_date
from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
group by l.case_id, l.supplier_id, s.name;

create or replace view public.v_supplier_balance with (security_invoker = false) as
select s.id as supplier_id, s.name,
       case when public.can_see_profit() then coalesce((select sum(public.line_supplier_payable(l)) from public.booking_lines l
                 where l.supplier_id = s.id), 0) end as payable,
       case when public.can_see_profit() then coalesce((select sum(p.amount) from public.payments p where p.supplier_id = s.id and p.direction = 'out'), 0) end as paid,
       (select min(l.supplier_due_date) from public.booking_lines l where l.supplier_id = s.id and public.line_supplier_payable(l) > 0) as oldest_due
from public.suppliers s
where public.is_team();

create or replace function private.wallet_balance(p_supplier uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(p.amount) from public.payments p where p.supplier_id = p_supplier and p.direction = 'out'), 0)
       - coalesce((select sum(public.line_supplier_payable(l)) from public.booking_lines l where l.supplier_id = p_supplier), 0)
$$;

-- Use the same obligation in allocations, wallet movements and reminders. Estimated costs and profit keep line_cost().
do $$
declare fn regprocedure; definition text;
begin
  foreach fn in array array[
    'public.use_supplier_advance(uuid,uuid,numeric)'::regprocedure,
    'private.guard_supplier_change()'::regprocedure,
    'private.wallet_from_line()'::regprocedure,
    'private.close_resolved_auto_tasks()'::regprocedure
  ] loop
    definition := pg_get_functiondef(fn);
    if position('public.line_cost(' in definition) = 0 then
      raise exception 'Supplier cost calculation not found in %', fn;
    end if;
    execute replace(definition, 'public.line_cost(', 'public.line_supplier_payable(');
  end loop;

  definition := pg_get_functiondef('private.wallet_sync(uuid,uuid)'::regprocedure);
  if position('case when private.wallet_case_live(p_case) then coalesce(sum(public.line_cost(l)), 0) else 0 end' in definition) = 0 then
    raise exception 'wallet_sync cost calculation does not look as expected';
  end if;
  execute replace(definition,
    'case when private.wallet_case_live(p_case) then coalesce(sum(public.line_cost(l)), 0) else 0 end',
    'coalesce(sum(public.line_supplier_payable(l)), 0)');

  definition := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
  if position('public.line_cost(l)' in definition) = 0
     or position('and cs.status in (''confirmed'',''booked'',''completed'',''cancelled'')' in definition) = 0 then
    raise exception 'Supplier reminder calculation does not look as expected';
  end if;
  definition := replace(definition, 'public.line_cost(l)', 'public.line_supplier_payable(l)');
  definition := replace(definition, 'and cs.status in (''confirmed'',''booked'',''completed'',''cancelled'')', 'and l.status <> ''pending''');
  execute definition;
end $$;

-- Release any wallet allocations previously drawn for holds, then cover confirmed bookings from the remaining funds.
do $$
declare supplier record; held_case record;
begin
  for supplier in select id from public.suppliers where terms = 'wallet' loop
    for held_case in select distinct case_id from public.booking_lines where supplier_id = supplier.id and status = 'pending' loop
      perform private.wallet_sync(supplier.id, held_case.case_id);
    end loop;
    perform private.wallet_sync_supplier(supplier.id);
  end loop;
end $$;
