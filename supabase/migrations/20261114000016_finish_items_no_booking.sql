-- "Completes by itself when" on a case with no booking yet listed "Prices entered" and "Client paid in full" as done,
-- which says nothing useful (there is nothing to price or pay). With no booking, only "Add the booking" and the
-- tasks are listed. The completion rule itself is unchanged: a case with no booking never completes.
create or replace function private.case_finish_items(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c public.cases; m record; n int; names text; items jsonb := '[]';
  today date := (now() at time zone 'Asia/Kolkata')::date;
  add_item jsonb;
begin
  select * into c from public.cases where id = p_case;
  if c.id is null then return '[]'; end if;

  select count(*) into n from public.booking_lines where case_id = p_case and status <> 'cancelled';
  items := items || jsonb_build_object('key', 'booking', 'ok', n > 0, 'text', case when n > 0 then 'Bookings added' else 'Add the booking' end);
  if n = 0 then
    select count(*) into n from public.tasks
     where case_id = p_case and status <> 'done' and (auto_key is null or auto_key like 'stage:%' or auto_key like 'waitfollow:%' or blocking);
    if n > 0 then items := items || jsonb_build_object('key', 'tasks', 'ok', false, 'text', n || ' task' || case when n = 1 then '' else 's' end || ' still open'); end if;
    return items;
  end if;

  select count(*) into n from public.booking_lines where case_id = p_case and status = 'pending';
  items := items || jsonb_build_object('key', 'confirmed', 'ok', n = 0,
    'text', case when n = 0 then 'Every booking confirmed' else n || ' booking' || case when n = 1 then ' is' else 's are' end || ' still Pending: set to Confirmed once booked' end);

  select count(*) into n from public.booking_lines where case_id = p_case and status <> 'cancelled' and pricing_state = 'not_entered';
  items := items || jsonb_build_object('key', 'priced', 'ok', n = 0,
    'text', case when n = 0 then 'Prices entered' else 'Enter the price on ' || n || ' booking' || case when n = 1 then '' else 's' end end);

  select * into m from public.v_case_money where case_id = p_case;
  items := items || jsonb_build_object('key', 'client', 'ok', abs(coalesce(m.due, 0)) < 0.01,
    'text', case when abs(coalesce(m.due, 0)) < 0.01 then 'Client paid in full'
                 when m.due > 0 then '₹' || to_char(m.due, 'FM99,99,99,990') || ' still due from the client'
                 else 'Client has a credit of ₹' || to_char(-m.due, 'FM99,99,99,990') || ' to refund or adjust' end);
  items := items || jsonb_build_object('key', 'supplier', 'ok', coalesce(m.supplier_due, 0) < 0.01,
    'text', case when coalesce(m.supplier_due, 0) < 0.01 then 'Suppliers paid'
                 else '₹' || to_char(m.supplier_due, 'FM99,99,99,990') || ' still to pay suppliers' end);

  select count(*) into n from public.ticket_imports where case_id = p_case and status in ('received', 'processing', 'needs_review', 'failed');
  if n > 0 then items := items || jsonb_build_object('key', 'imports', 'ok', false, 'text', n || ' ticket import' || case when n = 1 then '' else 's' end || ' waiting for review'); end if;

  if c.is_international then
    select count(*), string_agg(cu.full_name, ', ') into n, names
    from public.case_travellers t join public.customers cu on cu.id = t.customer_id
    where t.case_id = p_case and (cu.passport_hash is null or cu.passport_expiry is null
                                  or cu.passport_expiry < coalesce(c.travel_end, c.travel_start, today));
    if n > 0 then items := items || jsonb_build_object('key', 'passports', 'ok', false, 'text', 'Passport number or valid expiry missing for ' || names); end if;
  end if;

  select count(*) into n from public.tasks
   where case_id = p_case and status <> 'done' and (auto_key is null or auto_key like 'stage:%' or auto_key like 'waitfollow:%' or blocking);
  items := items || jsonb_build_object('key', 'tasks', 'ok', n = 0,
    'text', case when n = 0 then 'No tasks left' else n || ' task' || case when n = 1 then '' else 's' end || ' still open' end);
  return items;
end $$;

-- Departures list: "6E 2134", not "6E 6E 2134", when the flight number already starts with the airline code
do $$
declare def text := pg_get_functiondef('public.departures(date, date)'::regprocedure);
begin
  if position('nullif(concat_ws('' '', s ->> ''airline'', s ->> ''flight_no''), '''')' in def) > 0 then
    execute replace(def, 'nullif(concat_ws('' '', s ->> ''airline'', s ->> ''flight_no''), '''')',
      'nullif(case when upper(regexp_replace(coalesce(s ->> ''flight_no'', ''''), ''[\s-]'', '''', ''g'')) like upper(regexp_replace(coalesce(nullif(s ->> ''airline'', ''''), ''-''), ''[\s-]'', '''', ''g'')) || ''%''
                   then s ->> ''flight_no'' else concat_ws('' '', s ->> ''airline'', s ->> ''flight_no'') end, '''')');
  end if;
end $$;
