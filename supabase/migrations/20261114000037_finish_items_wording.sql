-- "Completes by itself when" wording, found on the full CRM tour (2026-11-18). Additive; only text changes, not
-- whether an item is done, so auto-complete is unchanged.
-- 1. "3 bookings are still Pending: set to Confirmed once booked" counted visas too, which have no status to set:
--    a visa is confirmed by its decision. Bookings and visas are now told apart, and bookings point at the new
--    "Mark booked" button on the booking card.
-- 2. Amounts showed paise always ("₹55,000.00 still due"); now only when there are paise ("₹0.50 still due" stays).
do $$
declare
  def text := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
  p_old text := $x$n || ' booking' || case when n = 1 then ' is' else 's are' end || ' still Pending: set to Confirmed once booked'$x$;
  p_new text := $x$(select string_agg(t, '; ') from (
        select case when count(*) > 0 then count(*) || ' booking' || case when count(*) = 1 then ' is' else 's are' end || ' still Pending: press Mark booked once it is booked' end as t
          from public.booking_lines where case_id = p_case and status = 'pending' and service <> 'visa'
        union all
        select case when count(*) > 0 then count(*) || ' visa' || case when count(*) = 1 then ' is' else 's are' end || ' waiting for the decision' end
          from public.booking_lines where case_id = p_case and status = 'pending' and service = 'visa') x)$x$;
begin
  if position(p_old in def) = 0 then
    raise exception 'case_finish_items pending wording does not look as expected; not changed';
  end if;
  if position('''FM99,99,99,990.00''' in def) = 0 then
    raise exception 'case_finish_items money format does not look as expected; not changed';
  end if;
  def := replace(def, p_old, p_new);
  def := regexp_replace(def, 'to_char\(([^,()]+), ''FM99,99,99,990\.00''\)', 'regexp_replace(to_char(\1, ''FM99,99,99,990.00''), ''\\.00$'', '''')', 'g');  -- \\ in a replacement is one literal backslash
  execute def;
end $$;
