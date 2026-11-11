-- The trip reminder ("web check-in and final documents") took its date from the case, so it was wrong whenever the
-- case dates and the confirmed itinerary disagreed (audit: MAX-1008). Its date now comes from the first live booking
-- on or after today, falling back to the case's travel start. A reminder made for a date that no longer matches is
-- closed with a note, and the right one is created. The rest of run_auto_reminders is unchanged.
create or replace function public.run_auto_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := (select auto_reminders from public.settings where id = 1);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  r record;
begin
  if (cfg ->> 'passport_visa')::boolean then
    for r in select id, full_name, passport_expiry from public.customers
             where passport_expiry between today and today + interval '6 months' loop
      perform private.add_auto_task('passport:' || r.id || ':' || r.passport_expiry,
        'Passport expiring ' || to_char(r.passport_expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
    for r in select c.id, c.full_name, v ->> 'country' as country, (v ->> 'expiry')::date as expiry
             from public.customers c, jsonb_array_elements(c.visas) v
             where coalesce(v ->> 'expiry', '') <> '' and (v ->> 'expiry')::date between today and today + interval '6 months' loop
      perform private.add_auto_task('visa:' || r.id || ':' || coalesce(r.country, '') || ':' || r.expiry,
        coalesce(r.country, '') || ' visa expiring ' || to_char(r.expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
    for r in select d.id, d.customer_id, d.doc_type, d.expiry, c.full_name from public.customer_documents d
             join public.customers c on c.id = d.customer_id
             where d.expiry between today and today + interval '6 months'
               and (d.doc_type ilike 'passport%' or d.doc_type ilike 'visa%') loop
      perform private.add_auto_task('doc:' || r.id || ':' || r.expiry,
        r.doc_type || ' expiring ' || to_char(r.expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.customer_id), r.customer_id, private.customer_owner(r.customer_id));
    end loop;
  end if;

  if (cfg ->> 'trip_upcoming')::boolean then
    for r in select c.id, c.max_id, c.customer_id,
                    coalesce((select min(l.service_date) from public.booking_lines l
                              where l.case_id = c.id and l.status <> 'cancelled' and l.service_date >= today), c.travel_start) as trip_day
             from public.cases c where c.status in ('confirmed','booked') loop
      -- a reminder made for a date that no longer matches the itinerary is closed, with a note
      update public.tasks
         set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the trip date is now ' || coalesce(to_char(r.trip_day, 'DD-MM-YYYY'), 'unknown') || '.'
       where case_id = r.id and status <> 'done' and auto_key like 'trip:' || r.id || ':%'
         and auto_key is distinct from 'trip:' || r.id || ':' || r.trip_day;
      if r.trip_day between today and today + 2 then
        perform private.add_auto_task('trip:' || r.id || ':' || r.trip_day,
          'Trip on ' || to_char(r.trip_day, 'DD-MM-YYYY') || ': web check-in and final documents',
          r.id, r.customer_id, private.case_owner(r.id));
      end if;
    end loop;
  end if;

  if (cfg ->> 'client_due')::boolean then
    for r in select l.id, l.case_id, c.customer_id, l.payment_due_date, m.due from public.booking_lines l
             join public.cases c on c.id = l.case_id
             join lateral (
               select sum(public.line_billed(x)) - coalesce((select sum(amount) from public.payments p where p.case_id = l.case_id and p.direction = 'in'), 0) as due
               from public.booking_lines x where x.case_id = l.case_id) m on true
             where l.payment_due_date <= today and l.status <> 'cancelled' and m.due > 0
               and c.status in ('confirmed','booked','completed') loop
      perform private.add_auto_task('clientdue:' || r.case_id || ':' || r.payment_due_date,
        'Collect payment from client: ₹' || to_char(r.due, 'FM99,99,99,990'), r.case_id, r.customer_id, private.case_owner(r.case_id));
    end loop;
  end if;

  if (cfg ->> 'supplier_due')::boolean then
    for r in select l.case_id, l.supplier_id, s.name, min(l.supplier_due_date) as due_date,
                    sum(public.line_cost(l)) - coalesce((select sum(a.amount) from public.payment_allocations a
                       join public.payments p on p.id = a.payment_id
                       where a.case_id = l.case_id and p.supplier_id = l.supplier_id), 0) as due
             from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
             join public.cases cs on cs.id = l.case_id
             where l.supplier_due_date <= today and cs.status in ('confirmed','booked','completed','cancelled')
             group by l.case_id, l.supplier_id, s.name loop
      if r.due > 0 then
        perform private.add_auto_task('supdue:' || r.case_id || ':' || r.supplier_id || ':' || r.due_date,
          'Pay supplier ' || r.name || ': ₹' || to_char(r.due, 'FM99,99,99,990'), r.case_id, null, private.case_owner(r.case_id));
      end if;
    end loop;
  end if;

  if (cfg ->> 'hotel_cancel')::boolean then
    for r in select l.id, l.case_id, l.details ->> 'hotel_name' as hotel, (l.details ->> 'free_cancel_until')::date as until
             from public.booking_lines l
             where l.service = 'hotel' and l.status <> 'cancelled' and coalesce(l.details ->> 'free_cancel_until', '') <> ''
               and (l.details ->> 'free_cancel_until')::date between today and today + 1 loop
      perform private.add_auto_task('hotelcancel:' || r.id || ':' || r.until,
        'Free cancellation ends ' || to_char(r.until, 'DD-MM-YYYY') || ': ' || coalesce(r.hotel, 'hotel'),
        r.case_id, null, private.case_owner(r.case_id));
    end loop;
  end if;

  if (cfg ->> 'birthday')::boolean then
    for r in select id, full_name, 'birthday' as kind from public.customers
             where dob is not null and to_char(dob, 'MM-DD') = to_char(today, 'MM-DD')
             union all
             select id, full_name, 'anniversary' from public.customers
             where anniversary is not null and to_char(anniversary, 'MM-DD') = to_char(today, 'MM-DD') loop
      perform private.add_auto_task(r.kind || ':' || r.id || ':' || extract(year from today),
        'Wish ' || r.full_name || ' a happy ' || r.kind, private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
  end if;
end $$;

revoke execute on function public.run_auto_reminders() from public, anon, authenticated;
grant execute on function public.run_auto_reminders() to service_role;
