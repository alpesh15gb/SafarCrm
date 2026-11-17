-- Second round from the full CRM tour (2026-11-18). Additive.
-- 1. "International trip without travel insurance: offer a policy" stayed on the case after a policy was added,
--    until the scheduled check ran. It now closes the moment an insurance booking is saved.
-- 2. Cash and bank book called a wallet top-up or advance (money paid to a supplier for no MAX ID) a
--    "Supplier payment"; it now says "Advance / wallet top-up".

create or replace function private.insurance_closes_noins() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.service = 'insurance' and new.status <> 'cancelled' then
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the trip now has insurance.'
     where status <> 'done' and auto_key = 'noins:' || new.case_id;
  end if;
  return null;
end $$;

drop trigger if exists booking_lines_insurance_closes_noins on public.booking_lines;
create trigger booking_lines_insurance_closes_noins after insert or update of status, service on public.booking_lines
  for each row execute function private.insurance_closes_noins();

-- close any already open on a trip that has insurance
update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the trip now has insurance.'
 where t.status <> 'done' and t.auto_key like 'noins:%'
   and exists (select 1 from public.booking_lines x where x.case_id = t.case_id and x.service = 'insurance' and x.status <> 'cancelled');

do $$
declare
  def text := pg_get_functiondef('public.report_cashbook_lines(date, date, uuid)'::regprocedure);
  p_old text := $x$when p.amount > 0 then 'Supplier payment'$x$;
  p_new text := $x$when p.amount > 0 and exists (select 1 from public.payment_allocations pa where pa.payment_id = p.id) then 'Supplier payment'
              when p.amount > 0 then 'Advance / wallet top-up'$x$;
begin
  if position(p_old in def) = 0 then
    raise exception 'report_cashbook_lines does not look as expected; not changed';
  end if;
  execute replace(def, p_old, p_new);
end $$;

-- 3. A confirmed booking with a cost but no supplier (e.g. visa fees paid straight on the embassy site) counted as
--    "still to pay suppliers", with no supplier to pay, so the case could never complete by itself. What we owe
--    suppliers now counts only bookings that have a supplier; profit still counts every cost.
create or replace function public.line_supplier_payable(l public.booking_lines) returns numeric
language sql immutable set search_path = public as $$
  select case when l.status = 'pending' or l.supplier_id is null then 0 else public.line_cost(l) end
$$;

-- 4. "₹300.00 still to pay suppliers": the supplier amount in the completion list kept its paise (037 missed it
--    because its argument is a function call).
do $$
declare
  def text := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
  p_old text := $x$to_char(private.case_supplier_due(p_case), 'FM99,99,99,990.00')$x$;
begin
  if position(p_old in def) > 0 then
    execute replace(def, p_old, $x$regexp_replace(to_char(private.case_supplier_due(p_case), 'FM99,99,99,990.00'), '\.00$', '')$x$);
  end if;
end $$;
