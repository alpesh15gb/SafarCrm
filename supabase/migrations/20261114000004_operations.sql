-- Operational follow-through (slice F). Additive.
--   departures(): one row per transport departure (each flight sector, rail and bus leg), so outbound and return both count
--   service_dates(): hotel check-ins and visa appointments, shown separately, never counted as departures
--   run_workflow_checks(): ticket-name verification, missing documents, waiting follow-ups, through the existing auto-task
--   machinery (auto_key keeps them from duplicating)

-- ============================================================ departures by segment (row-level security applies)
create or replace function public.departures(p_from date, p_to date)
returns table (case_id uuid, max_id text, customer text, line_id uuid, service text, dep_date date, dep_time text,
               from_code text, to_code text, carrier text, leg int, legs int, line_status text, assigned_to uuid)
language sql stable security invoker set search_path = public as $$
  select c.id, c.max_id, cu.full_name, l.id, l.service, (s ->> 'date')::date, nullif(s ->> 'dep', ''),
         upper(s ->> 'from'), upper(s ->> 'to'), nullif(concat_ws(' ', s ->> 'airline', s ->> 'flight_no'), ''),
         o::int, jsonb_array_length(l.details -> 'sectors'), l.status, c.assigned_to
  from public.booking_lines l
  join public.cases c on c.id = l.case_id
  join public.customers cu on cu.id = c.customer_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(l.details -> 'sectors') = 'array' then l.details -> 'sectors' else '[]'::jsonb end)
    with ordinality x(s, o)
  where l.service = 'flight' and l.status <> 'cancelled' and c.status <> 'cancelled'
    and coalesce(s ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (s ->> 'date')::date between p_from and p_to
  union all
  select c.id, c.max_id, cu.full_name, l.id, l.service, (l.details ->> 'date')::date,
         nullif(coalesce(l.details ->> 'departure_time', l.details ->> 'boarding_time'), ''),
         upper(l.details ->> 'from'), upper(l.details ->> 'to'), nullif(coalesce(l.details ->> 'train_no', l.details ->> 'operator'), ''),
         1, 1, l.status, c.assigned_to
  from public.booking_lines l
  join public.cases c on c.id = l.case_id
  join public.customers cu on cu.id = c.customer_id
  where l.service in ('rail', 'bus') and l.status <> 'cancelled' and c.status <> 'cancelled'
    and coalesce(l.details ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (l.details ->> 'date')::date between p_from and p_to
$$;

create or replace function public.service_dates(p_from date, p_to date)
returns table (case_id uuid, max_id text, customer text, line_id uuid, service text, kind text, on_date date, label text)
language sql stable security invoker set search_path = public as $$
  select c.id, c.max_id, cu.full_name, l.id, l.service, k.kind, k.d, k.label
  from public.booking_lines l
  join public.cases c on c.id = l.case_id
  join public.customers cu on cu.id = c.customer_id
  cross join lateral (values
    ('check_in', case when l.service = 'hotel' and coalesce(l.details ->> 'check_in', '') ~ '^\d{4}-\d{2}-\d{2}$' then (l.details ->> 'check_in')::date end, l.details ->> 'hotel_name'),
    ('check_out', case when l.service = 'hotel' and coalesce(l.details ->> 'check_out', '') ~ '^\d{4}-\d{2}-\d{2}$' then (l.details ->> 'check_out')::date end, l.details ->> 'hotel_name'),
    ('appointment', case when l.service = 'visa' and coalesce(l.details ->> 'appointment_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (l.details ->> 'appointment_date')::date end,
       concat_ws(' ', l.details ->> 'country', 'visa appointment'))) k(kind, d, label)
  where l.status <> 'cancelled' and c.status <> 'cancelled' and k.d between p_from and p_to
$$;

-- ============================================================ configurable checks
update public.settings
   set auto_reminders = auto_reminders
       || case when auto_reminders ? 'ticket_name' then '{}'::jsonb else '{"ticket_name":true}'::jsonb end
       || case when auto_reminders ? 'missing_docs' then '{}'::jsonb else '{"missing_docs":true}'::jsonb end
       || case when auto_reminders ? 'waiting_follow_up' then '{}'::jsonb else '{"waiting_follow_up":true}'::jsonb end
 where id = 1;

create or replace function private.letters(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z]', '', 'g')) $$;

create or replace function public.run_workflow_checks() returns int
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := (select auto_reminders from public.settings where id = 1);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  r record; made int := 0; before int;
begin
  select count(*) into before from public.tasks where auto_key is not null;

  -- 1. the name a ticket was issued in must match the passport (checked for flights in the next 21 days)
  if coalesce((cfg ->> 'ticket_name')::boolean, true) then
    for r in
      select l.id line_id, l.case_id, t ->> 'number' num, t ->> 'name_as_issued' issued, cu.full_name, cu.passport_surname, cu.passport_given_name
      from public.booking_lines l
      join public.cases c on c.id = l.case_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(l.details -> 'tickets') = 'array' then l.details -> 'tickets' else '[]'::jsonb end) t
      join public.customers cu on cu.id::text = t ->> 'customer_id'
      where l.service = 'flight' and l.status <> 'cancelled' and c.status not in ('cancelled', 'completed')
        and l.service_date between today and today + 21
        and coalesce(t ->> 'name_as_issued', '') <> '' and coalesce(t ->> 'number', '') <> ''
        and (cu.passport_surname is null
             or position(private.letters(cu.passport_surname) in private.letters(t ->> 'name_as_issued')) = 0
             or (cu.passport_given_name is not null
                 and position(private.letters(split_part(cu.passport_given_name, ' ', 1)) in private.letters(t ->> 'name_as_issued')) = 0))
    loop
      perform private.add_auto_task('tktname:' || r.line_id || ':' || private.ticket_digits(r.num),
        'Check ticket name: ' || r.issued || ' (' || r.full_name || ')', r.case_id, null, private.case_owner(r.case_id),
        case when r.passport_surname is null then 'No passport name on file to compare with. Check the ticket against the passport.'
             else 'The issued name does not match the passport name on file (' || r.passport_surname || coalesce(' / ' || r.passport_given_name, '') || ').' end);
    end loop;
  end if;

  -- 2. international trips in the next 30 days with a traveller missing a passport number or a valid expiry
  if coalesce((cfg ->> 'missing_docs')::boolean, true) then
    for r in
      select c.id case_id, cu.id customer_id, cu.full_name, c.travel_start
      from public.cases c
      join public.case_travellers t on t.case_id = c.id
      join public.customers cu on cu.id = t.customer_id
      where c.is_international and c.status not in ('cancelled', 'completed') and c.travel_start between today and today + 30
        and (cu.passport_hash is null or cu.passport_expiry is null or cu.passport_expiry < coalesce(c.travel_end, c.travel_start))
    loop
      perform private.add_auto_task('missingdoc:' || r.case_id || ':' || r.customer_id,
        'Passport details needed: ' || r.full_name, r.case_id, r.customer_id, private.case_owner(r.case_id),
        'Travel starts ' || to_char(r.travel_start, 'DD-MM-YYYY') || '. Collect the passport number and a valid expiry.');
    end loop;
  end if;

  -- 3. a waiting case comes back as a task at its follow-up time (deadlines keep running regardless)
  if coalesce((cfg ->> 'waiting_follow_up')::boolean, true) then
    for r in
      select c.id case_id, c.customer_id, c.max_id, c.work_state, c.waiting_reason, c.waiting_follow_up_at
      from public.cases c
      where c.work_state in ('waiting_customer', 'waiting_supplier') and c.waiting_follow_up_at <= now() + interval '15 minutes'
        and c.status not in ('cancelled', 'completed')
    loop
      insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
      values (r.case_id, r.customer_id,
              'Follow up (' || case r.work_state when 'waiting_customer' then 'waiting for customer' else 'waiting for supplier' end || '): ' || r.max_id,
              private.case_owner(r.case_id), r.waiting_follow_up_at, 'normal', 'due', r.waiting_reason,
              'waitfollow:' || r.case_id || ':' || extract(epoch from r.waiting_follow_up_at)::bigint, null)
      on conflict (auto_key) do nothing;
    end loop;
  end if;

  select count(*) - before into made from public.tasks where auto_key is not null;
  return made;
end $$;

revoke execute on function public.run_workflow_checks() from public, anon, authenticated;
grant execute on function public.run_workflow_checks() to service_role;
revoke execute on function public.departures(date, date) from public, anon;
revoke execute on function public.service_dates(date, date) from public, anon;
grant execute on function public.departures(date, date) to authenticated;
grant execute on function public.service_dates(date, date) to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;

-- every 15 minutes (cheap; auto_key stops repeats)
select cron.schedule('safar-workflow-checks', '*/15 * * * *', 'select public.run_workflow_checks()');
