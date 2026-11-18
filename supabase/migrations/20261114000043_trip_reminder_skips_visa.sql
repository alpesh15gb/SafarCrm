-- The trip reminder took its date from the first booking on or after today, including a visa, whose date is the day
-- it was applied for. MAX-1001 (flying 20-12) got "Trip on 18-11-2026: send the final documents" the day its visa
-- was submitted. Visas no longer set the trip day. Additive; the rest of run_auto_reminders is unchanged.
do $$
declare
  def text := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
  p_old text := $x$where l.case_id = c.id and l.status <> 'cancelled' and l.service_date >= today), c.travel_start) as trip_day$x$;
  p_new text := $x$where l.case_id = c.id and l.status <> 'cancelled' and l.service <> 'visa' and l.service_date >= today), c.travel_start) as trip_day$x$;
begin
  if position(p_old in def) = 0 then
    raise exception 'run_auto_reminders trip day does not look as expected; not changed';
  end if;
  execute replace(def, p_old, p_new);
end $$;

-- close trip reminders already made from a visa date (the right one is made by the next run, two days before travel)
update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: that date was a visa application, not travel.'
 where t.status <> 'done' and t.auto_key ~ '^trip:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$'
   and exists (select 1 from public.booking_lines l
               where l.case_id = split_part(t.auto_key, ':', 2)::uuid and l.service = 'visa' and l.status <> 'cancelled'
                 and l.service_date = split_part(t.auto_key, ':', 3)::date)
   and not exists (select 1 from public.booking_lines l
                   where l.case_id = split_part(t.auto_key, ':', 2)::uuid and l.service <> 'visa' and l.status <> 'cancelled'
                     and l.service_date = split_part(t.auto_key, ':', 3)::date);
