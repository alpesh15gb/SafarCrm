-- Tasks → cases pipeline (flow audit, 2026-11-12). One idea: every open case has a visible next step, and that step
-- is a task. Additive; nothing is deleted.
--   1. automatic tasks are never born overdue, and close themselves when their reason is gone
--   2. entering a stage creates that stage's tasks (boss-editable list, on by default); quote-chasing tasks close when the
--      case moves on; cancelling closes the case's automatic tasks
--   3. the stage moves forward by itself on the first client payment and when every booking is confirmed
--   4. "waiting" is one follow-up task; finishing it ends the waiting
--   5. the work summary says "No next step" / "Overdue" / "On track" instead of a hand-set work status
--   6. a case's team sees every task on it; reassigning a case moves its open tasks

-- ============================================================ 1. due time for automatic tasks
-- 10:00 India time on the given day; if that has already passed, one hour from now (never overdue at birth)
create or replace function private.auto_due(p_day date default null) returns timestamptz
language sql stable as $$
  select greatest(
    ((coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) + time '10:00') at time zone 'Asia/Kolkata'),
    now() + interval '1 hour')
$$;

drop function if exists private.add_auto_task(text, text, uuid, uuid, uuid, text);
create or replace function private.add_auto_task(p_key text, p_title text, p_case uuid, p_customer uuid, p_owner uuid, p_notes text default null, p_day date default null)
returns void language sql security definer set search_path = public as $$
  insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
  values (p_case, p_customer, p_title, p_owner, private.auto_due(p_day), 'normal', 'due', p_notes, p_key, null)
  on conflict (auto_key) do nothing
$$;

-- customer-level reminders attach to an open case only (not to an old completed or cancelled one)
create or replace function private.latest_case(p_customer uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.cases c
  left join public.case_travellers t on t.case_id = c.id
  where (c.customer_id = p_customer or t.customer_id = p_customer) and c.status not in ('completed', 'cancelled')
  order by c.created_at desc limit 1
$$;

-- ============================================================ 2. stage tasks
create table if not exists public.stage_tasks (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('enquiry', 'quoted', 'confirmed', 'booked', 'completed', 'cancelled')),
  title text not null check (length(trim(title)) between 1 and 120),
  due_days int not null default 0 check (due_days between -60 and 60),
  due_from text not null default 'stage' check (due_from in ('stage', 'travel_start', 'travel_end')),
  blocking boolean not null default false,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.stage_tasks enable row level security;
drop policy if exists stage_tasks_select on public.stage_tasks;
create policy stage_tasks_select on public.stage_tasks for select to authenticated using (public.is_team());
drop policy if exists stage_tasks_write on public.stage_tasks;
create policy stage_tasks_write on public.stage_tasks for all to authenticated using (public.is_boss()) with check (public.is_boss());

insert into public.stage_tasks (stage, title, due_days, due_from, sort)
select * from (values
  ('enquiry',   'Send the quote',                              0, 'stage',        1),
  ('quoted',    'Follow up on the quote',                      2, 'stage',        1),
  ('confirmed', 'Collect the advance payment',                 1, 'stage',        1),
  ('confirmed', 'Make the bookings and issue tickets',         1, 'stage',        2),
  ('booked',    'Send travel documents to the customer',      -3, 'travel_start', 1),
  ('completed', 'Welcome back: ask for feedback',              1, 'travel_end',   1)
) v(stage, title, due_days, due_from, sort)
where not exists (select 1 from public.stage_tasks);

update public.settings
   set auto_reminders = auto_reminders
       || case when auto_reminders ? 'stage_tasks' then '{}'::jsonb else '{"stage_tasks":true}'::jsonb end
       || case when auto_reminders ? 'auto_stage' then '{}'::jsonb else '{"auto_stage":true}'::jsonb end
 where id = 1;

create or replace function private.apply_stage_tasks(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases; s public.stage_tasks; today date := (now() at time zone 'Asia/Kolkata')::date; base date;
begin
  if not coalesce((select (auto_reminders ->> 'stage_tasks')::boolean from public.settings where id = 1), true) then return; end if;
  select * into c from public.cases where id = p_case;
  if c.id is null then return; end if;
  for s in select * from public.stage_tasks where stage = c.status and active order by sort, created_at loop
    base := case s.due_from when 'travel_start' then c.travel_start when 'travel_end' then coalesce(c.travel_end, c.travel_start) else today end;
    insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, blocking, auto_key, created_by)
    values (c.id, c.customer_id, s.title, private.case_owner(c.id),
            private.auto_due(case when base is null then today + 1 else base + s.due_days end),
            'normal', 'due', s.blocking, 'stage:' || c.id || ':' || s.id, null)
    on conflict (auto_key) do nothing;   -- going back to a stage never repeats its tasks
  end loop;
end $$;

create or replace function private.case_stage_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare stages text[] := array['enquiry', 'quoted', 'confirmed', 'booked', 'completed'];
begin
  if tg_op = 'INSERT' then
    perform private.apply_stage_tasks(new.id);
    return null;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'cancelled' then
      -- nothing more to do on a cancelled case, except money still owed to suppliers or by the client
      update public.tasks
         set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the case was cancelled.'
       where case_id = new.id and status <> 'done' and auto_key is not null
         and auto_key not like 'supdue:%' and auto_key not like 'clientdue:%';
    else
      -- quote work is over once the case has moved past it
      update public.tasks t
         set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the case moved to ' || initcap(new.status) || '.'
       where t.case_id = new.id and t.status <> 'done' and t.auto_key like 'stage:%'
         and exists (select 1 from public.stage_tasks s
                     where t.auto_key = 'stage:' || new.id || ':' || s.id and s.stage in ('enquiry', 'quoted')
                       and array_position(stages, s.stage) < coalesce(array_position(stages, new.status), 0));
      perform private.apply_stage_tasks(new.id);
    end if;
  end if;

  -- a new owner takes over the previous owner's open tasks on the case
  if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null and old.assigned_to is not null then
    update public.tasks set assigned_to = new.assigned_to
     where case_id = new.id and status <> 'done' and assigned_to = old.assigned_to;
  end if;
  return null;
end $$;
drop trigger if exists t_case_stage_insert on public.cases;
create trigger t_case_stage_insert after insert on public.cases for each row execute function private.case_stage_changed();
drop trigger if exists t_case_stage_update on public.cases;
create trigger t_case_stage_update after update of status, assigned_to on public.cases for each row execute function private.case_stage_changed();

-- ============================================================ 3. the stage moves forward by itself (never backward)
create or replace function private.auto_stage_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'in' and new.amount > 0 and new.case_id is not null
     and coalesce((select (auto_reminders ->> 'auto_stage')::boolean from public.settings where id = 1), true) then
    update public.cases set status = 'confirmed' where id = new.case_id and status in ('enquiry', 'quoted');
  end if;
  return null;
end $$;
drop trigger if exists t_auto_stage_payment on public.payments;
create trigger t_auto_stage_payment after insert on public.payments for each row execute function private.auto_stage_on_payment();

create or replace function private.auto_stage_on_booking() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
     and coalesce((select (auto_reminders ->> 'auto_stage')::boolean from public.settings where id = 1), true)
     and not exists (select 1 from public.booking_lines l where l.case_id = new.case_id and l.status = 'pending') then
    update public.cases set status = 'booked' where id = new.case_id and status in ('enquiry', 'quoted', 'confirmed');
  end if;
  return null;
end $$;
drop trigger if exists t_auto_stage_booking on public.booking_lines;
create trigger t_auto_stage_booking after insert or update of status on public.booking_lines for each row execute function private.auto_stage_on_booking();

-- ============================================================ 4. waiting = one follow-up task
create or replace function public.set_case_work_state(p_case uuid, p_state text, p_reason text default null, p_follow_up_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.cases;
begin
  if not public.can_see_case(p_case) or not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_state not in ('new', 'in_progress', 'waiting_customer', 'waiting_supplier') then
    raise exception 'Unknown work status' using errcode = 'P0001';
  end if;
  if p_state like 'waiting%' and (coalesce(trim(p_reason), '') = '' or p_follow_up_at is null) then
    raise exception 'waiting_needs_reason' using errcode = 'P0001';
  end if;
  select * into c from public.cases where id = p_case for update;
  update public.cases
     set work_state = p_state, work_state_at = now(),
         waiting_reason = case when p_state like 'waiting%' then trim(p_reason) end,
         waiting_follow_up_at = case when p_state like 'waiting%' then p_follow_up_at end
   where id = p_case;
  if p_state like 'waiting%' then
    insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
    values (p_case, c.customer_id,
            'Follow up (waiting for ' || case p_state when 'waiting_customer' then 'customer' else 'supplier' end || '): ' || left(trim(p_reason), 80),
            private.case_owner(p_case), p_follow_up_at, 'normal', 'due', trim(p_reason), 'waitfollow:' || p_case, null)
    on conflict (auto_key) do update
      set status = 'todo', title = excluded.title, due_at = excluded.due_at, notes = excluded.notes, assigned_to = excluded.assigned_to;
  else
    update public.tasks set status = 'done'
     where case_id = p_case and status <> 'done' and auto_key like 'waitfollow:%';
  end if;
end $$;
revoke execute on function public.set_case_work_state(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.set_case_work_state(uuid, text, text, timestamptz) to authenticated;

-- finishing the follow-up ends the waiting
create or replace function private.waiting_task_done() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status <> 'done' and new.case_id is not null and new.auto_key like 'waitfollow:%' then
    update public.cases
       set work_state = 'in_progress', work_state_at = now(), waiting_reason = null, waiting_follow_up_at = null
     where id = new.case_id and work_state in ('waiting_customer', 'waiting_supplier');
  end if;
  return null;
end $$;
drop trigger if exists t_waiting_task_done on public.tasks;
create trigger t_waiting_task_done after update of status on public.tasks for each row execute function private.waiting_task_done();

-- existing data: old per-date follow-up tasks are closed; cases waiting now get their one follow-up task
update public.tasks
   set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: replaced by one follow-up task per case.'
 where status <> 'done' and auto_key ~ '^waitfollow:[0-9a-f-]{36}:';
insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
select c.id, c.customer_id,
       'Follow up (waiting for ' || case c.work_state when 'waiting_customer' then 'customer' else 'supplier' end || '): ' || left(c.waiting_reason, 80),
       private.case_owner(c.id), c.waiting_follow_up_at, 'normal', 'due', c.waiting_reason, 'waitfollow:' || c.id, null
from public.cases c
where c.work_state in ('waiting_customer', 'waiting_supplier') and c.status not in ('completed', 'cancelled')
on conflict (auto_key) do nothing;

-- ============================================================ 1b. automatic tasks close when their reason is gone
create or replace function private.close_resolved_auto_tasks() returns int
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; n int; total int := 0;
begin
  -- the client has paid
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: nothing is due from the client now.'
   where t.status <> 'done' and t.auto_key like 'clientdue:%' and t.case_id is not null
     and coalesce((select m.due from public.v_case_money m where m.case_id = t.case_id), 0) <= 0;
  get diagnostics n = row_count; total := total + n;

  -- the supplier has been paid for this case
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: this supplier is paid for the case.'
   where t.status <> 'done' and t.auto_key ~ '^supdue:[0-9a-f-]{36}:[0-9a-f-]{36}:'
     and coalesce((select sum(public.line_cost(l)) from public.booking_lines l
                   where l.case_id = t.case_id and l.supplier_id = split_part(t.auto_key, ':', 3)::uuid), 0)
       - coalesce((select sum(a.amount) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                   where a.case_id = t.case_id and p.supplier_id = split_part(t.auto_key, ':', 3)::uuid), 0) <= 0;
  get diagnostics n = row_count; total := total + n;

  -- insurance was added
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the trip now has insurance.'
   where t.status <> 'done' and t.auto_key like 'noins:%'
     and exists (select 1 from public.booking_lines x where x.case_id = t.case_id and x.service = 'insurance' and x.status <> 'cancelled');
  get diagnostics n = row_count; total := total + n;

  -- the free-cancellation date has passed, or the hotel was cancelled
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the date has passed or the booking was cancelled.'
   where t.status <> 'done' and t.auto_key ~ '^hotelcancel:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$'
     and (split_part(t.auto_key, ':', 3)::date < today
          or not exists (select 1 from public.booking_lines x where x.id = split_part(t.auto_key, ':', 2)::uuid and x.status <> 'cancelled'));
  get diagnostics n = row_count; total := total + n;

  -- visa reminders whose situation has changed
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the visa has moved on.'
   where t.status <> 'done' and t.auto_key ~ '^(visadocs|visalate|visapp):[0-9a-f-]{36}'
     and not exists (
       select 1 from public.booking_lines x
       where x.id = split_part(t.auto_key, ':', 2)::uuid and x.status <> 'cancelled'
         and case split_part(t.auto_key, ':', 1)
               when 'visadocs' then coalesce(x.details ->> 'application_status', 'Documents pending') = 'Documents pending'
               when 'visalate' then x.details ->> 'application_status' in ('Applied', 'Appointment booked', 'Biometrics done', 'Under process')
               else coalesce((x.details ->> 'passport_with_us')::boolean, false) end);
  get diagnostics n = row_count; total := total + n;

  -- the passport was renewed
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the passport expiry on file has changed.'
   where t.status <> 'done' and t.auto_key ~ '^passport:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$'
     and (select cu.passport_expiry from public.customers cu where cu.id = split_part(t.auto_key, ':', 2)::uuid)
         is distinct from split_part(t.auto_key, ':', 3)::date;
  get diagnostics n = row_count; total := total + n;

  -- greetings are only useful for a few days
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the day has passed.'
   where t.status <> 'done' and (t.auto_key like 'birthday:%' or t.auto_key like 'anniversary:%') and t.created_at < now() - interval '3 days';
  get diagnostics n = row_count; total := total + n;

  -- trip reminders and other automatic tasks on cases that are over
  update public.tasks t set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the case is ' || c.status || '.'
    from public.cases c
   where c.id = t.case_id and t.status <> 'done' and t.auto_key is not null
     and ((c.status = 'cancelled' and t.auto_key not like 'supdue:%' and t.auto_key not like 'clientdue:%')
          or (c.status in ('completed', 'cancelled') and (t.auto_key like 'trip:%' or t.auto_key like 'tktname:%' or t.auto_key like 'missingdoc:%' or t.auto_key like 'waitfollow:%')));
  get diagnostics n = row_count; total := total + n;
  return total;
end $$;

-- workflow checks: same two checks as before, each now also closes its tasks once the problem is fixed;
-- the waiting follow-up is created when waiting is set (above), so it is no longer made here
create or replace function public.run_workflow_checks() returns int
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := (select auto_reminders from public.settings where id = 1);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  r record; made int := 0; before int; keys text[];
begin
  select count(*) into before from public.tasks where auto_key is not null;

  -- 1. the name a ticket was issued in must match the passport (checked for flights in the next 21 days)
  if coalesce((cfg ->> 'ticket_name')::boolean, true) then
    keys := '{}';
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
      keys := keys || ('tktname:' || r.line_id || ':' || private.ticket_digits(r.num));
      perform private.add_auto_task('tktname:' || r.line_id || ':' || private.ticket_digits(r.num),
        'Check ticket name: ' || r.issued || ' (' || r.full_name || ')', r.case_id, null, private.case_owner(r.case_id),
        case when r.passport_surname is null then 'No passport name on file to compare with. Check the ticket against the passport.'
             else 'The issued name does not match the passport name on file (' || r.passport_surname || coalesce(' / ' || r.passport_given_name, '') || ').' end);
    end loop;
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the name now matches, or the flight is no longer upcoming.'
     where status <> 'done' and auto_key like 'tktname:%' and auto_key <> all (keys);
  end if;

  -- 2. international trips in the next 30 days with a traveller missing a passport number or a valid expiry
  if coalesce((cfg ->> 'missing_docs')::boolean, true) then
    keys := '{}';
    for r in
      select c.id case_id, cu.id customer_id, cu.full_name, c.travel_start
      from public.cases c
      join public.case_travellers t on t.case_id = c.id
      join public.customers cu on cu.id = t.customer_id
      where c.is_international and c.status not in ('cancelled', 'completed') and c.travel_start between today and today + 30
        and (cu.passport_hash is null or cu.passport_expiry is null or cu.passport_expiry < coalesce(c.travel_end, c.travel_start))
    loop
      keys := keys || ('missingdoc:' || r.case_id || ':' || r.customer_id);
      perform private.add_auto_task('missingdoc:' || r.case_id || ':' || r.customer_id,
        'Passport details needed: ' || r.full_name, r.case_id, r.customer_id, private.case_owner(r.case_id),
        'Travel starts ' || to_char(r.travel_start, 'DD-MM-YYYY') || '. Collect the passport number and a valid expiry.');
    end loop;
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the passport details are on file, or the trip is no longer upcoming.'
     where status <> 'done' and auto_key like 'missingdoc:%' and auto_key <> all (keys);
  end if;

  select count(*) - before into made from public.tasks where auto_key is not null;
  perform private.close_resolved_auto_tasks();
  return made;
end $$;
revoke execute on function public.run_workflow_checks() from public, anon, authenticated;
grant execute on function public.run_workflow_checks() to service_role;

-- the visa reminder job is for the scheduler and the boss's "Check now" (which runs as the service role)
revoke execute on function public.run_visa_reminders() from public, anon, authenticated;
grant execute on function public.run_visa_reminders() to service_role;

-- ============================================================ 6. a case's team sees every task on it
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid()
         or (case_id is not null and public.can_see_case(case_id)))));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid()
         or (case_id is not null and public.can_see_case(case_id)))))
  with check (public.is_boss() or (public.is_team() and (assigned_to = auth.uid()
         or (case_id is not null and public.can_see_case(case_id)))));

-- ============================================================ 5. work summary: the next step, or the lack of one
-- state: closed | waiting_customer | waiting_supplier | no_next_step | overdue | up_to_date ("On track")
create or replace function public.case_work_summary(p_cases uuid[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'case_id', c.id,
    'state', case when c.status in ('completed', 'cancelled') then 'closed'
                  when coalesce(t.open, 0) = 0 then 'no_next_step'
                  when coalesce(t.overdue, 0) > 0 then 'overdue'
                  when c.work_state in ('waiting_customer', 'waiting_supplier') then c.work_state
                  else 'up_to_date' end,
    'stored_state', c.work_state, 'waiting_reason', c.waiting_reason, 'waiting_follow_up_at', c.waiting_follow_up_at,
    'owner', (select full_name from public.profiles where id = c.assigned_to),
    'open_tasks', coalesce(t.open, 0), 'overdue_tasks', coalesce(t.overdue, 0), 'blocking_tasks', coalesce(t.blocking, 0),
    'pending_imports', coalesce(im.pending, 0),
    'next_action', nx.next,
    'blocker', case when coalesce(im.pending, 0) > 0 then 'Ticket import waiting for review'
                    when coalesce(t.blocking, 0) > 0 then 'Required task open'
                    when c.work_state like 'waiting%' then c.waiting_reason end)), '[]'::jsonb)
  from public.cases c
  left join lateral (
    select count(*) filter (where x.status <> 'done') open,
           count(*) filter (where x.status <> 'done' and x.due_at < now()) overdue,
           count(*) filter (where x.status <> 'done' and x.blocking) blocking
    from public.tasks x where x.case_id = c.id) t on true
  left join lateral (select count(*) pending from public.ticket_imports i where i.case_id = c.id and i.status in ('received', 'processing', 'needs_review', 'failed')) im on true
  left join lateral (
    select jsonb_build_object('id', x.id, 'due_at', x.due_at, 'title', x.title,
             'assignee', (select full_name from public.profiles where id = x.assigned_to)) next
    from public.tasks x where x.case_id = c.id and x.status <> 'done'
    order by x.due_at nulls last, x.created_at limit 1) nx on true
  where c.id = any(p_cases) and public.can_see_case(c.id)
$$;

-- open cases by what they need, for the Cases list filter and the dashboard (row security applies)
create or replace function public.cases_by_work(p_kind text) returns setof uuid
language sql stable security invoker set search_path = public as $$
  select c.id
  from public.cases c
  left join lateral (
    select count(*) filter (where x.status <> 'done') open,
           min(x.due_at) filter (where x.status <> 'done') next_due
    from public.tasks x where x.case_id = c.id) t on true
  where c.status not in ('completed', 'cancelled')
    and case p_kind
          when 'no_next' then coalesce(t.open, 0) = 0
          when 'overdue' then t.next_due < now()
          when 'waiting' then c.work_state in ('waiting_customer', 'waiting_supplier')
          when 'this_week' then t.next_due >= now() and t.next_due < now() + interval '7 days'
          else false end
  order by t.next_due nulls first, c.created_at desc
  limit 150   -- the ids travel in a request URL; the most urgent come first
$$;
revoke execute on function public.cases_by_work(text) from public, anon;
grant execute on function public.cases_by_work(text) to authenticated;

-- ============================================================ existing open cases get a first step where they have none
-- (only cases with no open task at all, so nothing is duplicated; stage tasks made here follow the same rules as new ones)
do $$
declare r record;
begin
  for r in
    select c.id from public.cases c
    where c.status not in ('completed', 'cancelled')
      and not exists (select 1 from public.tasks t where t.case_id = c.id and t.status <> 'done')
  loop
    perform private.apply_stage_tasks(r.id);
  end loop;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
