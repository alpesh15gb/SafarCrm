-- Go-live review fixes (2026-11-09)

-- 1. A supplier payment and its MAX ID allocations are saved together or not at all,
--    so a failed save can never leave a payment without allocations (and a retry can't double it).
--    Runs as the caller: row-level security still applies.
create or replace function public.record_supplier_payment(
  p_supplier uuid, p_date date, p_amount numeric, p_mode text, p_reference text default null, p_notes text default null,
  p_allocations jsonb default '[]')
returns uuid language plpgsql security invoker set search_path = public as $$
declare pid uuid; total numeric;
begin
  select coalesce(sum((a ->> 'amount')::numeric), 0) into total from jsonb_array_elements(coalesce(p_allocations, '[]')) a;
  if jsonb_array_length(coalesce(p_allocations, '[]')) > 0 and abs(total - p_amount) > 0.009 then
    raise exception 'The MAX ID amounts add up to %, not %', total, p_amount;
  end if;
  insert into public.payments (direction, supplier_id, pay_date, amount, mode, reference, notes)
  values ('out', p_supplier, coalesce(p_date, current_date), p_amount, p_mode, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''))
  returning id into pid;
  -- the same MAX ID listed twice is added up instead of failing
  insert into public.payment_allocations (payment_id, case_id, amount)
  select pid, (a ->> 'case_id')::uuid, sum((a ->> 'amount')::numeric)
  from jsonb_array_elements(coalesce(p_allocations, '[]')) a
  where coalesce((a ->> 'amount')::numeric, 0) <> 0
  group by (a ->> 'case_id')::uuid;
  return pid;
end $$;
revoke execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) from public, anon;
grant execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) to authenticated;

-- 1b. Staff can only allocate a supplier payment to cases they can see (before: any case).
drop policy if exists alloc_insert on public.payment_allocations;
create policy alloc_insert on public.payment_allocations for insert to authenticated with check (public.can_see_case(case_id));

-- 2. What is still active on a case, checked before the case is cancelled.
create or replace function public.case_cancel_blockers(p_case uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'confirmed_lines', (select count(*) from public.booking_lines l where l.case_id = p_case and l.status = 'confirmed'),
    'pending_lines', (select count(*) from public.booking_lines l where l.case_id = p_case and l.status = 'pending'),
    'received', coalesce((select sum(amount) from public.payments p where p.case_id = p_case and p.direction = 'in'), 0),
    'supplier_paid', coalesce((select sum(amount) from public.payment_allocations a where a.case_id = p_case), 0))
$$;
revoke execute on function public.case_cancel_blockers(uuid) from public, anon;
grant execute on function public.case_cancel_blockers(uuid) to authenticated;
