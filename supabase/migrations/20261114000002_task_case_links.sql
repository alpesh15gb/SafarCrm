-- Tasks to cases (slice B). Additive.
-- A task stays an individual action. It may carry a customer (context) and link to one case (the MAX ID travel job)
-- through the existing tasks.case_id; many tasks can share one case; office tasks keep both empty.
-- Converting a task to a case is idempotent per task; linking never completes the task; relinking needs a reason and is logged.

-- ============================================================ audit helper (activity_log has no insert policy for API roles)
create or replace function private.log_event(p_action text, p_entity text, p_entity_id uuid, p_case uuid, p_customer uuid,
                                             p_summary text, p_changes jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.activity_log (actor, actor_name, action, entity, entity_id, case_id, customer_id, summary, changes)
  values (auth.uid(), (select full_name from public.profiles where id = auth.uid()), p_action, p_entity, p_entity_id, p_case, p_customer,
          left(p_summary, 500), p_changes)
$$;

-- ============================================================ tasks
-- blocking = required before the case can be completed; everything else is an optional follow-up
alter table public.tasks add column if not exists blocking boolean not null default false;
create index if not exists tasks_customer_id_idx on public.tasks (customer_id);

-- Only a case the user may open can be linked, and moving a linked task to another case goes through link_task_to_case.
create or replace function private.guard_task_case() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- service role and scheduled jobs
  if new.case_id is not null and (tg_op = 'INSERT' or new.case_id is distinct from old.case_id) and not public.can_see_case(new.case_id) then
    raise exception 'Not allowed: you cannot link to that case' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.case_id is not null and new.case_id is distinct from old.case_id
     and coalesce(current_setting('safar.task_relink', true), '') <> 'on' then
    raise exception 'relink_needs_reason: use link_task_to_case to move a linked task' using errcode = 'P0001';
  end if;
  if new.customer_id is not null and (tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id)
     and not exists (select 1 from public.customers c where c.id = new.customer_id) then
    raise exception 'Customer not found' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_task_case on public.tasks;
create trigger t_guard_task_case before insert or update of case_id, customer_id on public.tasks
  for each row execute function private.guard_task_case();

-- ============================================================ create a case from a task (one transaction, one MAX ID per task)
create or replace function public.create_case_from_task(p_task uuid, p_case jsonb, p_travellers uuid[] default '{}')
returns jsonb language plpgsql security invoker set search_path = public as $$
declare t public.tasks; cid uuid; mx text; r jsonb; key text := 'task:' || p_task::text;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  -- the row lock serialises double clicks and retries of the same task
  select * into t from public.tasks where id = p_task for update;
  if not found then raise exception 'Task not found or not yours' using errcode = '42501'; end if;
  select r2.case_id into cid from public.case_requests r2 where r2.request_key = key;
  if cid is not null then
    select c.max_id into mx from public.cases c where c.id = cid;
    return jsonb_build_object('id', cid, 'max_id', mx, 'existing', true, 'task_id', p_task);
  end if;
  if t.case_id is not null then
    raise exception 'task_already_linked: this task is already linked to a MAX ID' using errcode = 'P0001';
  end if;
  r := public.create_case(
         jsonb_build_object('customer_id', coalesce(nullif(p_case ->> 'customer_id', ''), t.customer_id::text),
                            'title', coalesce(nullif(trim(coalesce(p_case ->> 'title', '')), ''), t.title))
         || (p_case - 'customer_id' - 'title'),
         p_travellers, key);
  cid := (r ->> 'id')::uuid;
  -- only the link changes: owner, due time, priority, notes, status and comments stay as they were
  perform set_config('safar.task_relink', 'on', true);
  update public.tasks set case_id = cid, customer_id = coalesce(customer_id, (select customer_id from public.cases where id = cid)) where id = p_task;
  perform set_config('safar.task_relink', '', true);
  perform private.log_event('convert', 'task', p_task, cid, t.customer_id, 'Case ' || (r ->> 'max_id') || ' created from task: ' || t.title);
  return r || jsonb_build_object('task_id', p_task);
end $$;

-- ============================================================ link an existing task to an existing case
create or replace function public.link_task_to_case(p_task uuid, p_case uuid, p_reason text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare t public.tasks; mx text; old_mx text;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into t from public.tasks where id = p_task for update;
  if not found then raise exception 'Task not found or not yours' using errcode = '42501'; end if;
  if not public.can_see_case(p_case) then raise exception 'Not allowed: you cannot link to that case' using errcode = '42501'; end if;
  select max_id into mx from public.cases where id = p_case;
  if t.case_id = p_case then return jsonb_build_object('case_id', p_case, 'max_id', mx, 'unchanged', true); end if;
  if t.case_id is not null then
    if coalesce(trim(p_reason), '') = '' then raise exception 'relink_needs_reason' using errcode = 'P0001'; end if;
    -- moving work off a job needs access to that job as well
    if not public.can_see_case(t.case_id) then raise exception 'Not allowed: you cannot see the case this task is on' using errcode = '42501'; end if;
    select max_id into old_mx from public.cases where id = t.case_id;
  end if;
  perform set_config('safar.task_relink', 'on', true);
  update public.tasks set case_id = p_case, customer_id = coalesce(customer_id, (select customer_id from public.cases where id = p_case)) where id = p_task;
  perform set_config('safar.task_relink', '', true);
  perform private.log_event(case when t.case_id is null then 'link' else 'relink' end, 'task', p_task, p_case, t.customer_id,
    case when t.case_id is null then 'Task linked to ' || mx || ': ' || t.title
         else 'Task moved from ' || old_mx || ' to ' || mx || ': ' || t.title || ' (reason: ' || trim(p_reason) || ')' end,
    jsonb_build_object('case_id', jsonb_build_object('from', t.case_id, 'to', p_case), 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  if t.case_id is not null then
    perform private.log_event('relink', 'task', p_task, t.case_id, t.customer_id, 'Task moved to ' || mx || ': ' || t.title || ' (reason: ' || trim(p_reason) || ')');
  end if;
  return jsonb_build_object('case_id', p_case, 'max_id', mx, 'unchanged', false);
end $$;

-- ============================================================ suggest existing cases before making another MAX ID
-- Runs as the caller: row-level security limits suggestions to cases the user may open.
create or replace function public.suggest_cases(p_customer uuid, p_limit int default 8)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'rank', x ->> 'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', c.id, 'max_id', c.max_id, 'title', c.title, 'status', c.status,
             'travel_start', c.travel_start, 'created_at', c.created_at,
             'relationship', case when c.customer_id = p_customer and t.customer_id is not null then 'payer_and_traveller'
                                  when c.customer_id = p_customer then 'payer' else 'traveller' end,
             'rank', case when c.status in ('completed', 'cancelled') then '2' else '1' end) x
    from public.cases c
    left join public.case_travellers t on t.case_id = c.id and t.customer_id = p_customer
    where p_customer is not null and (c.customer_id = p_customer or t.customer_id is not null)
      and (c.status not in ('completed', 'cancelled') or c.created_at > now() - interval '90 days')
    order by c.created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 25))
  ) s
$$;

-- ============================================================ work summary (separate from the booking stage)
alter table public.cases add column if not exists work_state text not null default 'new';
alter table public.cases add column if not exists waiting_reason text;
alter table public.cases add column if not exists waiting_follow_up_at timestamptz;
alter table public.cases add column if not exists work_state_at timestamptz;
do $$ begin
  alter table public.cases add constraint cases_work_state_check
    check (work_state in ('new', 'in_progress', 'waiting_customer', 'waiting_supplier'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.cases add constraint waiting_needs_reason
    check (work_state not in ('waiting_customer', 'waiting_supplier')
           or (coalesce(trim(waiting_reason), '') <> '' and waiting_follow_up_at is not null));
exception when duplicate_object then null; end $$;
-- existing jobs that already have bookings or moved past enquiry are being worked on, not new
update public.cases c set work_state = 'in_progress'
 where work_state = 'new' and (c.status <> 'enquiry' or exists (select 1 from public.booking_lines l where l.case_id = c.id));

create or replace function public.set_case_work_state(p_case uuid, p_state text, p_reason text default null, p_follow_up_at timestamptz default null)
returns void language plpgsql security invoker set search_path = public as $$
declare prev text;
begin
  if not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_state not in ('new', 'in_progress', 'waiting_customer', 'waiting_supplier') then
    raise exception 'Unknown work status (up to date is worked out from the open work, not set by hand)' using errcode = 'P0001';
  end if;
  if p_state like 'waiting%' and (coalesce(trim(p_reason), '') = '' or p_follow_up_at is null) then
    raise exception 'waiting_needs_reason' using errcode = 'P0001';
  end if;
  select work_state into prev from public.cases where id = p_case for update;
  update public.cases
     set work_state = p_state, work_state_at = now(),
         waiting_reason = case when p_state like 'waiting%' then trim(p_reason) end,
         waiting_follow_up_at = case when p_state like 'waiting%' then p_follow_up_at end
   where id = p_case;
end $$;

-- ============================================================ grants
revoke execute on function public.create_case_from_task(uuid, jsonb, uuid[]) from public, anon;
revoke execute on function public.link_task_to_case(uuid, uuid, text) from public, anon;
revoke execute on function public.suggest_cases(uuid, int) from public, anon;
revoke execute on function public.set_case_work_state(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.create_case_from_task(uuid, jsonb, uuid[]) to authenticated;
grant execute on function public.link_task_to_case(uuid, uuid, text) to authenticated;
grant execute on function public.suggest_cases(uuid, int) to authenticated;
grant execute on function public.set_case_work_state(uuid, text, text, timestamptz) to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
-- invoker functions above write the audit trail through this one helper (the private schema is not exposed over the API)
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
