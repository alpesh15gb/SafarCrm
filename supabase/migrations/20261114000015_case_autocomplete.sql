-- A case completes by itself once it is booked and fully paid (owner's rule, 2026-11-13).
-- Before: nothing ever completed a case; staff had to pick Completed and the screen didn't say what was missing.
--
-- Complete when ALL of these hold:
--   * at least one booking, every live booking Confirmed (none Pending) and priced
--   * the client owes nothing and has no credit waiting to be refunded; suppliers are paid
--   * no ticket import waiting for review; passports on file for an international trip
--   * no open task that is real work (tasks people made, stage tasks, waiting follow-ups). Automatic reminders
--     (check-in before travel, expiry, birthday…) don't hold a case open, and still go out after it completes.
-- Checked whenever something that matters changes: a booking, a payment, a supplier payment, a task, an import.
-- The rule can be switched off in Settings → Reminders ("auto_complete"). Additive; no existing case is changed
-- until something happens on it, then it completes if it qualifies.

update public.settings
   set auto_reminders = auto_reminders || case when auto_reminders ? 'auto_complete' then '{}'::jsonb else '{"auto_complete":true}'::jsonb end
 where id = 1;

-- what still stands between a case and Completed, as a list the case page shows (and the rule below uses)
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

-- the case page reads the list through this (only for a case the user may open)
create or replace function public.case_finish_items(p_case uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.can_see_case(p_case) then private.case_finish_items(p_case) else '[]'::jsonb end
$$;
revoke execute on function public.case_finish_items(uuid) from public, anon;
grant execute on function public.case_finish_items(uuid) to authenticated;

-- complete the case when every item is done. Never fails the change that called it.
create or replace function private.try_complete_case(p_case uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare c public.cases; items jsonb;
begin
  if p_case is null then return false; end if;
  if not coalesce((select (auto_reminders ->> 'auto_complete')::boolean from public.settings where id = 1), true) then return false; end if;
  select * into c from public.cases where id = p_case;
  if c.id is null or c.status in ('completed', 'cancelled') then return false; end if;
  items := private.case_finish_items(p_case);
  if exists (select 1 from jsonb_array_elements(items) x where not (x ->> 'ok')::boolean) then return false; end if;
  begin
    perform set_config('safar.case_completion', 'on', true);
    update public.cases set status = 'completed' where id = p_case and status not in ('completed', 'cancelled');
    perform set_config('safar.case_completion', '', true);
    perform private.log_event('complete', 'case', p_case, p_case, c.customer_id,
      c.max_id || ' completed automatically: booked and fully paid, nothing left to do');
    return true;
  exception when others then
    perform set_config('safar.case_completion', '', true);
    return false;
  end;
end $$;

-- ============================================================ stage tasks close when their job is done
-- e.g. a first payment moves the case to Confirmed, which used to create "Collect the advance payment" right after
-- the advance was paid; "Make the bookings" stayed open after every booking was confirmed.
alter table public.stage_tasks add column if not exists done_when text
  check (done_when in ('client_paid_any', 'client_paid_full', 'bookings_confirmed'));
update public.stage_tasks set done_when = 'client_paid_any' where stage = 'confirmed' and title = 'Collect the advance payment' and done_when is null;
update public.stage_tasks set done_when = 'bookings_confirmed' where stage = 'confirmed' and title = 'Make the bookings and issue tickets' and done_when is null;
-- the tickets go to the customer as soon as they are issued (the check-in reminder still comes 2 days before travel)
update public.stage_tasks set title = 'Send the tickets and vouchers to the customer', due_days = 0, due_from = 'stage'
 where stage = 'booked' and title = 'Send travel documents to the customer';
update public.tasks t set title = 'Send the tickets and vouchers to the customer'
  from public.stage_tasks s
 where t.auto_key like 'stage:%:' || s.id and s.stage = 'booked' and t.status <> 'done' and t.title = 'Send travel documents to the customer';

create or replace function private.close_met_stage_tasks(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare received numeric; due numeric; pending int; live int;
begin
  if p_case is null then return; end if;
  select coalesce(m.received, 0), coalesce(m.due, 0) into received, due from public.v_case_money m where m.case_id = p_case;
  select count(*) filter (where status = 'pending'), count(*) filter (where status <> 'cancelled') into pending, live
    from public.booking_lines where case_id = p_case;
  update public.tasks t
     set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: done.'
    from public.stage_tasks s
   where t.case_id = p_case and t.status <> 'done' and t.auto_key = 'stage:' || p_case || ':' || s.id
     and ((s.done_when = 'client_paid_any' and received > 0)
          or (s.done_when = 'client_paid_full' and due <= 0.009 and received > 0)
          or (s.done_when = 'bookings_confirmed' and live > 0 and pending = 0));
end $$;

-- ============================================================ when to check
create or replace function private.autocomplete_from_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.close_met_stage_tasks(case when tg_op = 'DELETE' then old.case_id else new.case_id end);
  perform private.try_complete_case(case when tg_op = 'DELETE' then old.case_id else new.case_id end);
  return null;
end $$;
drop trigger if exists t_zz_autocomplete on public.booking_lines;
create trigger t_zz_autocomplete after insert or update or delete on public.booking_lines
  for each row execute function private.autocomplete_from_line();

create or replace function private.autocomplete_from_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.close_met_stage_tasks(case when tg_op = 'DELETE' then old.case_id else new.case_id end);
  perform private.try_complete_case(case when tg_op = 'DELETE' then old.case_id else new.case_id end);
  return null;
end $$;
drop trigger if exists t_zz_autocomplete on public.payments;
create trigger t_zz_autocomplete after insert or update or delete on public.payments
  for each row execute function private.autocomplete_from_payment();
drop trigger if exists t_zz_autocomplete on public.payment_allocations;
create trigger t_zz_autocomplete after insert or update or delete on public.payment_allocations
  for each row execute function private.autocomplete_from_payment();

create or replace function private.autocomplete_from_task() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then perform private.try_complete_case(new.case_id); end if;
  return null;
end $$;
drop trigger if exists t_zz_autocomplete on public.tasks;
create trigger t_zz_autocomplete after update of status on public.tasks
  for each row execute function private.autocomplete_from_task();

create or replace function private.autocomplete_from_import() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('confirmed', 'rejected', 'duplicate') then
    perform private.try_complete_case(new.case_id);
  end if;
  return null;
end $$;
drop trigger if exists t_zz_autocomplete on public.ticket_imports;
create trigger t_zz_autocomplete after update of status on public.ticket_imports
  for each row execute function private.autocomplete_from_import();

-- ============================================================ stage tasks follow the booked dates
-- A case made from a task or a ticket often has no dates of its own; its bookings do. "Send travel documents"
-- (3 days before travel) and "Welcome back" (the day after) now use the bookings' dates first.
create or replace function private.apply_stage_tasks(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases; s public.stage_tasks; today date := (now() at time zone 'Asia/Kolkata')::date; base date; first_day date; last_day date;
begin
  if not coalesce((select (auto_reminders ->> 'stage_tasks')::boolean from public.settings where id = 1), true) then return; end if;
  select * into c from public.cases where id = p_case;
  if c.id is null then return; end if;
  select min(service_date), max(service_date) into first_day, last_day
    from public.booking_lines where case_id = p_case and status <> 'cancelled' and service_date is not null;
  first_day := coalesce(first_day, c.travel_start);
  last_day := coalesce(c.travel_end, last_day, first_day);
  for s in select * from public.stage_tasks where stage = c.status and active order by sort, created_at loop
    base := case s.due_from when 'travel_start' then first_day when 'travel_end' then last_day else today end;
    insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, blocking, auto_key, created_by)
    values (c.id, c.customer_id, s.title, private.case_owner(c.id),
            private.auto_due(case when base is null then today + 1 else base + s.due_days end),
            'normal', 'due', s.blocking, 'stage:' || c.id || ':' || s.id, null)
    on conflict (auto_key) do nothing;
  end loop;
end $$;

-- ============================================================ a completed case still gets its travel reminders
do $$
declare def text;
begin
  -- check-in reminder: also for completed cases whose trip is still ahead
  def := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
  if position('where c.status in (''confirmed'',''booked'') loop' in def) > 0 then
    execute replace(def, 'where c.status in (''confirmed'',''booked'') loop', 'where c.status in (''confirmed'',''booked'',''completed'') loop');
  end if;
  -- a completed case keeps its check-in, ticket-name and passport reminders; only a cancelled one loses them
  def := pg_get_functiondef('private.close_resolved_auto_tasks()'::regprocedure);
  if position('(c.status in (''completed'', ''cancelled'') and (t.auto_key like ''trip:%''' in def) > 0 then
    execute replace(def,
      '(c.status in (''completed'', ''cancelled'') and (t.auto_key like ''trip:%'' or t.auto_key like ''tktname:%'' or t.auto_key like ''missingdoc:%'' or t.auto_key like ''waitfollow:%''))',
      '(c.status = ''completed'' and t.auto_key like ''waitfollow:%'')');
  end if;
  -- entering a stage closes its tasks that are already done (e.g. Confirmed by a payment: the advance is in)
  def := pg_get_functiondef('private.case_stage_changed()'::regprocedure);
  if position('close_met_stage_tasks' in def) = 0 then
    execute replace(def, 'perform private.apply_stage_tasks(new.id);',
                         'perform private.apply_stage_tasks(new.id); perform private.close_met_stage_tasks(new.id);');
  end if;
  -- the ticket-name check runs for upcoming flights on completed cases too
  def := pg_get_functiondef('public.run_workflow_checks()'::regprocedure);
  if position('where l.service = ''flight'' and l.status <> ''cancelled'' and c.status not in (''cancelled'', ''completed'')' in def) > 0 then
    execute replace(def, 'where l.service = ''flight'' and l.status <> ''cancelled'' and c.status not in (''cancelled'', ''completed'')',
                         'where l.service = ''flight'' and l.status <> ''cancelled'' and c.status <> ''cancelled''');
  end if;
end $$;

-- existing open cases: close stage tasks that are already done, then complete the ones that qualify today
select private.close_met_stage_tasks(id) from public.cases where status in ('enquiry', 'quoted', 'confirmed', 'booked');
select private.try_complete_case(id) from public.cases where status in ('enquiry', 'quoted', 'confirmed', 'booked');

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
