-- Prepaid wallet suppliers (owner, 2026-11-13). Additive.
-- Some suppliers (portals, consolidators) are paid by topping up a wallet with them first. For a supplier whose
-- payment terms are 'wallet':
--   1. Each booking's cost is drawn from the wallet on its own: the money paid ahead is put against the case,
--      oldest top-up first. No "Use advance" click, and nothing shows as due while the wallet covers it.
--   2. When a booking costs less (price cut, cancellation refund, deleted, moved), the difference goes back to the
--      wallet, newest draw first.
--   3. A top-up first covers any bookings the wallet was short for, oldest due first.
--   4. If the wallet runs short, the shortfall is a real due as before ("Pay supplier …" reminder on its due date).
--   5. Optional "alert below" amount: when the wallet balance drops under it, the boss gets a "Top up" reminder,
--      closed on its own once the wallet is topped up again.
-- Existing 'prepaid' (pay on the booking date) and 'credit' suppliers are unchanged.

alter table public.suppliers drop constraint if exists suppliers_terms_check;
alter table public.suppliers add constraint suppliers_terms_check check (terms in ('prepaid', 'credit', 'wallet'));
alter table public.suppliers add column if not exists wallet_alert_below numeric(12,2);

-- Only a case the client has said yes to draws on the wallet (same stages as the "Pay supplier" reminder);
-- bookings on an enquiry or a quote don't use up money.
create or replace function private.wallet_case_live(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status in ('confirmed', 'booked', 'completed', 'cancelled') from public.cases where id = p_case), false)
$$;

-- ============================================================ balance (never masked; used by the low-balance reminder)
create or replace function private.wallet_balance(p_supplier uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(p.amount) from public.payments p where p.supplier_id = p_supplier and p.direction = 'out'), 0)
       - coalesce((select sum(public.line_cost(l)) from public.booking_lines l
                   where l.supplier_id = p_supplier and private.wallet_case_live(l.case_id)), 0)
$$;

-- supplier totals (list, supplier page, dues report, export): a wallet supplier's payable leaves out bookings on
-- enquiries and quotes, so "paid - payable" is exactly the wallet balance
create or replace view public.v_supplier_balance with (security_invoker = false) as
select s.id as supplier_id, s.name,
       case when public.can_see_profit() then coalesce((select sum(public.line_cost(l)) from public.booking_lines l
                 where l.supplier_id = s.id and (s.terms <> 'wallet' or private.wallet_case_live(l.case_id))), 0) end as payable,
       case when public.can_see_profit() then coalesce((select sum(p.amount) from public.payments p where p.supplier_id = s.id and p.direction = 'out'), 0) end as paid,
       (select min(l.supplier_due_date) from public.booking_lines l where l.supplier_id = s.id and l.status <> 'cancelled') as oldest_due
from public.suppliers s
where public.is_team();

-- ============================================================ 1 + 2. match what one case has drawn to what it costs
create or replace function private.wallet_sync(p_supplier uuid, p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare owed numeric; drawn numeric; gap numeric; r record; take numeric;
begin
  if p_supplier is null or p_case is null then return; end if;
  if not exists (select 1 from public.suppliers where id = p_supplier and terms = 'wallet') then return; end if;
  select case when private.wallet_case_live(p_case) then coalesce(sum(public.line_cost(l)), 0) else 0 end into owed
    from public.booking_lines l where l.case_id = p_case and l.supplier_id = p_supplier;
  select coalesce(sum(a.amount), 0) into drawn
    from public.payment_allocations a join public.payments p on p.id = a.payment_id
   where a.case_id = p_case and p.supplier_id = p_supplier;
  gap := owed - drawn;

  if gap > 0.009 then                                   -- draw more, oldest top-up first
    for r in
      select p.id, p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0) as free
      from public.payments p
      where p.supplier_id = p_supplier and p.direction = 'out' and p.amount > 0
      order by p.pay_date, p.created_at
    loop
      exit when gap <= 0.009;
      continue when r.free <= 0.009;
      take := least(r.free, gap);
      insert into public.payment_allocations (payment_id, case_id, amount) values (r.id, p_case, take)
      on conflict (payment_id, case_id) do update set amount = public.payment_allocations.amount + excluded.amount;
      gap := gap - take;
    end loop;
  elsif gap < -0.009 then                               -- give back to the wallet, newest draw first
    gap := -gap;
    for r in
      select a.payment_id, a.amount
      from public.payment_allocations a join public.payments p on p.id = a.payment_id
      where a.case_id = p_case and p.supplier_id = p_supplier and a.amount > 0
      order by p.pay_date desc, p.created_at desc
    loop
      exit when gap <= 0.009;
      take := least(r.amount, gap);
      if r.amount - take <= 0.009 then
        delete from public.payment_allocations where payment_id = r.payment_id and case_id = p_case;
      else
        update public.payment_allocations set amount = amount - take where payment_id = r.payment_id and case_id = p_case;
      end if;
      gap := gap - take;
    end loop;
  end if;
end $$;

-- ============================================================ 5. low-balance reminder
create or replace function private.wallet_check_low(p_supplier uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.suppliers; bal numeric;
begin
  select * into s from public.suppliers where id = p_supplier;
  if s.id is null then return; end if;
  bal := private.wallet_balance(p_supplier);
  if s.terms = 'wallet' and s.wallet_alert_below is not null and bal < s.wallet_alert_below then
    perform private.add_auto_task('walletlow:' || s.id || ':' || (now() at time zone 'Asia/Kolkata')::date,
      'Top up ' || s.name || ' wallet: balance ₹' || to_char(bal, 'FM99,99,99,990') || ' (alert below ₹' || to_char(s.wallet_alert_below, 'FM99,99,99,990') || ')',
      null, null, public.first_boss());
  else
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: wallet topped up.'
     where auto_key like 'walletlow:' || s.id || ':%' and status <> 'done';
  end if;
end $$;

-- ============================================================ 3. cover every short case of one supplier, oldest due first
create or replace function private.wallet_sync_supplier(p_supplier uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not exists (select 1 from public.suppliers where id = p_supplier and terms = 'wallet') then
    perform private.wallet_check_low(p_supplier);
    return;
  end if;
  for r in
    select l.case_id from public.booking_lines l
    where l.supplier_id = p_supplier
    group by l.case_id
    order by min(l.supplier_due_date) nulls last, min(l.created_at)
  loop
    perform private.wallet_sync(p_supplier, r.case_id);
  end loop;
  perform private.wallet_check_low(p_supplier);
end $$;

-- A booking's supplier can't be changed once that supplier is paid for it (20261114000020), except a wallet
-- supplier: what the booking drew goes back into the wallet by itself, so nothing is owed twice.
create or replace function private.guard_supplier_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare paid numeric; still_owed numeric;
begin
  if old.supplier_id is null or new.supplier_id is not distinct from old.supplier_id or auth.uid() is null then return new; end if;
  if exists (select 1 from public.suppliers where id = old.supplier_id and terms = 'wallet') then return new; end if;
  select coalesce(sum(a.amount), 0) into paid
    from public.payment_allocations a join public.payments p on p.id = a.payment_id
   where a.case_id = old.case_id and p.supplier_id = old.supplier_id;
  if paid <= 0.009 then return new; end if;
  select coalesce(sum(public.line_cost(l)), 0) into still_owed
    from public.booking_lines l where l.case_id = old.case_id and l.supplier_id = old.supplier_id and l.id <> old.id;
  if paid > still_owed + 0.009 then raise exception 'supplier_change_paid' using errcode = 'P0001'; end if;
  return new;
end $$;

-- ============================================================ when to sync
create or replace function private.wallet_from_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.wallet_sync(old.supplier_id, old.case_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.supplier_id is distinct from old.supplier_id or new.case_id is distinct from old.case_id
                                         or public.line_cost(new) is distinct from public.line_cost(old)) then
    perform private.wallet_sync(new.supplier_id, new.case_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.supplier_id is not null then
    -- money freed on this case may cover another case the wallet was short for
    if tg_op = 'DELETE' or public.line_cost(new) < public.line_cost(old) or new.supplier_id is distinct from old.supplier_id then
      perform private.wallet_sync_supplier(old.supplier_id);
    else
      perform private.wallet_check_low(old.supplier_id);
    end if;
  end if;
  if tg_op = 'INSERT' and new.supplier_id is not null then perform private.wallet_check_low(new.supplier_id); end if;
  if tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id and new.supplier_id is not null then
    perform private.wallet_check_low(new.supplier_id);
  end if;
  return null;
end $$;
drop trigger if exists t_wallet_sync on public.booking_lines;
create trigger t_wallet_sync after insert or update or delete on public.booking_lines
  for each row execute function private.wallet_from_line();

-- a deleted top-up: the cases it covered are drawn again from what is left (allocations are already gone by cascade)
create or replace function private.wallet_from_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.direction = 'out' and old.supplier_id is not null then perform private.wallet_sync_supplier(old.supplier_id); end if;
  return null;
end $$;
drop trigger if exists t_wallet_sync on public.payments;
create trigger t_wallet_sync after delete on public.payments
  for each row execute function private.wallet_from_payment();

-- a case confirmed (draws) or sent back to enquiry/quote (gives back)
create or replace function private.wallet_from_case() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if private.wallet_case_live(new.id) is distinct from coalesce(old.status in ('confirmed', 'booked', 'completed', 'cancelled'), false) then
    for r in select distinct l.supplier_id from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
             where l.case_id = new.id and s.terms = 'wallet' loop
      perform private.wallet_sync(r.supplier_id, new.id);
      perform private.wallet_sync_supplier(r.supplier_id);
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists t_wallet_sync on public.cases;
create trigger t_wallet_sync after update of status on public.cases
  for each row execute function private.wallet_from_case();

-- a supplier switched to (or off) wallet terms, or its alert changed
create or replace function private.wallet_from_supplier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.terms is distinct from old.terms or new.wallet_alert_below is distinct from old.wallet_alert_below then
    perform private.wallet_sync_supplier(new.id);
  end if;
  return null;
end $$;
drop trigger if exists t_wallet_sync on public.suppliers;
create trigger t_wallet_sync after update on public.suppliers
  for each row execute function private.wallet_from_supplier();

-- ============================================================ a top-up covers short cases straight away
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
  perform private.wallet_sync_supplier(p_supplier);
  return pid;
end $$;
revoke execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) from public, anon;
grant execute on function public.record_supplier_payment(uuid, date, numeric, text, text, text, jsonb) to authenticated;
-- record_supplier_payment runs as the caller, who needs to reach the private sync
grant usage on schema private to authenticated;
grant execute on function private.wallet_sync_supplier(uuid) to authenticated;

-- bring wallets that exist already into line (none on install, kept for re-runs)
do $$ declare r record; begin
  for r in select id from public.suppliers where terms = 'wallet' loop perform private.wallet_sync_supplier(r.id); end loop;
end $$;
