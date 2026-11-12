-- Supplier money gaps from the function review (2026-11-12). Additive.
--   1. An advance paid to a supplier can be used on a case ("Use advance"). Before, it sat as an advance on the
--      supplier page while the case still showed the full amount as due, and staff were asked to pay again.
--   2. Money a supplier pays back (a refund after a cancellation) can be recorded: a payment out with a negative
--      amount, put against the case. Before, it was refused.
--   3. Allocations can never add up to more than their payment, or have the opposite sign, however they are written.
--   4. Supplier payments are for the boss and staff who may see profit (they show what suppliers cost).

-- ============================================================ 3. allocations stay inside their payment
create or replace function private.guard_allocation() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.payments; total numeric;
begin
  select * into p from public.payments where id = new.payment_id;
  if p.id is null or p.direction <> 'out' then raise exception 'allocation_bad_payment' using errcode = 'P0001'; end if;
  if sign(new.amount) <> sign(p.amount) then raise exception 'allocation_sign' using errcode = 'P0001'; end if;
  select coalesce(sum(a.amount), 0) into total from public.payment_allocations a
   where a.payment_id = new.payment_id and not (a.payment_id = new.payment_id and a.case_id = new.case_id);
  if abs(total + new.amount) > abs(p.amount) + 0.009 then raise exception 'allocation_over_payment' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger if exists t_guard_allocation on public.payment_allocations;
create trigger t_guard_allocation before insert or update on public.payment_allocations
  for each row execute function private.guard_allocation();

-- ============================================================ 2 + 4. recording a payment to (or refund from) a supplier
create or replace function public.record_supplier_payment(
  p_supplier uuid, p_date date, p_amount numeric, p_mode text, p_reference text default null, p_notes text default null,
  p_allocations jsonb default '[]')
returns uuid language plpgsql security invoker set search_path = public as $$
declare pid uuid; total numeric;
begin
  if not public.can_see_profit() then raise exception 'supplier_money_profit_only' using errcode = '42501'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'Enter an amount.' using errcode = 'P0001'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_allocations, '[]')) a
             where coalesce((a ->> 'amount')::numeric, 0) <> 0 and sign((a ->> 'amount')::numeric) <> sign(p_amount)) then
    raise exception 'allocation_sign' using errcode = 'P0001';
  end if;
  select coalesce(sum((a ->> 'amount')::numeric), 0) into total from jsonb_array_elements(coalesce(p_allocations, '[]')) a;
  if abs(total) - abs(p_amount) > 0.009 then
    raise exception 'The MAX ID amounts add up to %, more than the payment of %', total, p_amount;
  end if;
  insert into public.payments (direction, supplier_id, pay_date, amount, mode, reference, notes)
  values ('out', p_supplier, coalesce(p_date, current_date), p_amount, p_mode, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''))
  returning id into pid;
  insert into public.payment_allocations (payment_id, case_id, amount)
  select pid, (a ->> 'case_id')::uuid, sum((a ->> 'amount')::numeric)
  from jsonb_array_elements(coalesce(p_allocations, '[]')) a
  where coalesce((a ->> 'amount')::numeric, 0) <> 0
  group by (a ->> 'case_id')::uuid;
  return pid;
end $$;
revoke execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) from public, anon;
grant execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) to authenticated;

-- ============================================================ 1. advances
-- money paid to a supplier that isn't put against any case yet
create or replace function public.supplier_advance(p_supplier uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when not public.can_see_profit() then null else
    coalesce((select sum(p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0))
              from public.payments p where p.supplier_id = p_supplier and p.direction = 'out' and p.amount > 0), 0) end
$$;
revoke execute on function public.supplier_advance(uuid) from public, anon;
grant execute on function public.supplier_advance(uuid) to authenticated;

-- put up to p_amount of a supplier's advance against what the case owes that supplier, oldest payment first
create or replace function public.use_supplier_advance(p_supplier uuid, p_case uuid, p_amount numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare owed numeric; avail numeric; left_to numeric; r record; take numeric;
begin
  if not public.can_see_profit() or not public.can_see_case(p_case) then raise exception 'supplier_money_profit_only' using errcode = '42501'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount.' using errcode = 'P0001'; end if;
  select coalesce(sum(public.line_cost(l)), 0)
         - coalesce((select sum(a.amount) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                     where a.case_id = p_case and p.supplier_id = p_supplier), 0)
    into owed from public.booking_lines l where l.case_id = p_case and l.supplier_id = p_supplier;
  avail := public.supplier_advance(p_supplier);
  left_to := least(p_amount, greatest(owed, 0), greatest(avail, 0));
  if left_to <= 0.009 then raise exception 'advance_nothing_to_use' using errcode = 'P0001'; end if;
  for r in
    select p.id, p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0) as free
    from public.payments p
    where p.supplier_id = p_supplier and p.direction = 'out' and p.amount > 0
    order by p.pay_date, p.created_at
  loop
    exit when left_to <= 0.009;
    continue when r.free <= 0.009;
    take := least(r.free, left_to);
    insert into public.payment_allocations (payment_id, case_id, amount) values (r.id, p_case, take)
    on conflict (payment_id, case_id) do update set amount = public.payment_allocations.amount + excluded.amount;
    left_to := left_to - take;
  end loop;
  perform private.log_event('allocate', 'payment', null, p_case, null,
    'Supplier advance of ₹' || to_char(least(p_amount, greatest(owed, 0), greatest(avail, 0)), 'FM99,99,99,990.00') || ' used on this case');
  return least(p_amount, greatest(owed, 0), greatest(avail, 0));
end $$;
revoke execute on function public.use_supplier_advance(uuid, uuid, numeric) from public, anon;
grant execute on function public.use_supplier_advance(uuid, uuid, numeric) to authenticated;
