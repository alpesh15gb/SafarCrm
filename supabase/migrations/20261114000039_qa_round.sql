-- QA round (2026-11-18). Additive.
-- 1. A case with no booking could be completed by hand (Enquiry -> Completed, zero bookings). Completing now needs
--    at least one booking that is not cancelled, even with a reason; an empty case is cancelled instead.
do $$
declare
  def text := pg_get_functiondef('public.complete_case(uuid, text)'::regprocedure);
  p_old text := $x$r := public.case_readiness(p_case);$x$;
  p_new text := $x$if not exists (select 1 from public.booking_lines where case_id = p_case and status <> 'cancelled') then
    raise exception 'no_booking: a case with no booking cannot be completed; cancel it instead' using errcode = 'P0001';
  end if;
  r := public.case_readiness(p_case);$x$;
begin
  if position(p_old in def) = 0 then
    raise exception 'complete_case does not look as expected; not changed';
  end if;
  execute replace(def, p_old, p_new);
end $$;

-- 2. Billed and invoiced disagreed: an amount kept from the client on a cancelled booking (₹2,200 sold, ₹1,700
--    refunded = ₹500 kept) counts in Billed but could never go on an invoice. It is now invoiced as
--    "Cancellation charge", so the invoices add up to what is billed.
do $$
declare
  def text := pg_get_functiondef('public.issue_invoice(uuid, text)'::regprocedure);
  pairs text[][] := array[
    array[$x$'summary', l.summary,$x$,
          $x$'summary', case when l.status = 'cancelled' then 'Cancellation charge' || coalesce(' · ' || l.summary, '') else l.summary end,$x$],
    array[$x$'amount', l.selling_price, 'gst', l.gst)$x$,
          $x$'amount', case when l.status = 'cancelled' then public.line_billed(l) else l.selling_price end, 'gst', case when l.status = 'cancelled' then 0 else l.gst end)$x$],
    array[$x$coalesce(sum(l.selling_price), 0), coalesce(sum(l.gst), 0)$x$,
          $x$coalesce(sum(case when l.status = 'cancelled' then public.line_billed(l) else l.selling_price end), 0), coalesce(sum(case when l.status = 'cancelled' then 0 else l.gst end), 0)$x$],
    array[$x$l.status <> 'cancelled' and (l.selling_price + l.gst) > 0$x$,
          $x$((l.status <> 'cancelled' and (l.selling_price + l.gst) > 0) or (l.status = 'cancelled' and public.line_billed(l) > 0))$x$]];
  i int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in def) = 0 then
      raise exception 'issue_invoice does not look as expected (part %); not changed', i;
    end if;
    def := replace(def, pairs[i][1], pairs[i][2]);
  end loop;
  execute def;
end $$;
