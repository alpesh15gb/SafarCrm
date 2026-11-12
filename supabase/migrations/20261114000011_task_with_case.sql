-- A task and its case in one step (staff feedback: "first I create the task, then I create a case" is a headache).
--   * create_task_with_case(): one transaction makes the case and the task on it
--   * when a case is created together with a task, that task is its first step, so the stage's own first task
--     ("Send the quote") is not added on top
--   * a case made this way defaults its traveller to the customer (not for a company) and its title to "Trip for <name>"
-- Additive.

-- the stage tasks of a brand-new case are skipped when its first step is being created with it
create or replace function private.case_stage_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare stages text[] := array['enquiry', 'quoted', 'confirmed', 'booked', 'completed'];
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('safar.first_step_given', true), '') <> 'on' then
      perform private.apply_stage_tasks(new.id);
    end if;
    return null;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'cancelled' then
      update public.tasks
         set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the case was cancelled.'
       where case_id = new.id and status <> 'done' and auto_key is not null
         and auto_key not like 'supdue:%' and auto_key not like 'clientdue:%';
    else
      update public.tasks t
         set status = 'done', notes = coalesce(t.notes || chr(10), '') || 'Closed automatically: the case moved to ' || initcap(new.status) || '.'
       where t.case_id = new.id and t.status <> 'done' and t.auto_key like 'stage:%'
         and exists (select 1 from public.stage_tasks s
                     where t.auto_key = 'stage:' || new.id || ':' || s.id and s.stage in ('enquiry', 'quoted')
                       and array_position(stages, s.stage) < coalesce(array_position(stages, new.status), 0));
      perform private.apply_stage_tasks(new.id);
    end if;
  end if;

  if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null and old.assigned_to is not null then
    update public.tasks set assigned_to = new.assigned_to
     where case_id = new.id and status <> 'done' and assigned_to = old.assigned_to;
  end if;
  return null;
end $$;

-- who travels when nobody was ticked: the customer themself, unless the customer is a company
create or replace function private.default_travellers(p_customer uuid, p_given uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when coalesce(array_length(p_given, 1), 0) > 0 then p_given
              else coalesce((select array[c.id] from public.customers c where c.id = p_customer and c.customer_type <> 'corporate'), '{}'::uuid[]) end
$$;

-- ============================================================ a new task on a new case, one transaction
-- p_task: title, assigned_to, due_at, priority, alert, notes.  p_case: customer_id (required), title, destination, dates…
-- Repeating the call with the same key (double click, retry) returns the first result.
create or replace function public.create_task_with_case(p_task jsonb, p_case jsonb, p_travellers uuid[] default '{}', p_request_key text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare r jsonb; cid uuid; tid uuid; cust uuid := nullif(p_case ->> 'customer_id', '')::uuid; cname text; ttl text := trim(coalesce(p_task ->> 'title', ''));
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if ttl = '' then raise exception 'task_title_required' using errcode = 'P0001'; end if;
  if cust is null then raise exception 'case_customer_required' using errcode = 'P0001'; end if;
  select full_name into cname from public.customers where id = cust;
  if cname is null then raise exception 'Customer not found' using errcode = 'P0001'; end if;

  perform set_config('safar.first_step_given', 'on', true);
  r := public.create_case(
         p_case || jsonb_build_object(
           'title', coalesce(nullif(trim(coalesce(p_case ->> 'title', '')), ''), 'Trip for ' || cname),
           -- the case belongs to whoever has the task, unless an owner was given
           'assigned_to', coalesce(nullif(p_case ->> 'assigned_to', ''), nullif(p_task ->> 'assigned_to', ''), auth.uid()::text)),
         private.default_travellers(cust, p_travellers), p_request_key);
  perform set_config('safar.first_step_given', '', true);
  cid := (r ->> 'id')::uuid;

  if (r ->> 'existing')::boolean then
    select t.id into tid from public.tasks t
     where t.case_id = cid and t.created_by = auth.uid() and t.title = ttl order by t.created_at limit 1;
  end if;
  if tid is null then
    insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes)
    values (cid, cust, ttl, coalesce(nullif(p_task ->> 'assigned_to', '')::uuid, auth.uid()),
            nullif(p_task ->> 'due_at', '')::timestamptz, coalesce(nullif(p_task ->> 'priority', ''), 'normal'),
            case when nullif(p_task ->> 'due_at', '') is null then 'none' else coalesce(nullif(p_task ->> 'alert', ''), 'due') end,
            nullif(trim(coalesce(p_task ->> 'notes', '')), ''))
    returning id into tid;
  end if;
  return r || jsonb_build_object('task_id', tid);
end $$;
revoke execute on function public.create_task_with_case(jsonb, jsonb, uuid[], text) from public, anon;
grant execute on function public.create_task_with_case(jsonb, jsonb, uuid[], text) to authenticated;

-- ============================================================ a case from an existing task: same rules
create or replace function public.create_case_from_task(p_task uuid, p_case jsonb, p_travellers uuid[] default '{}')
returns jsonb language plpgsql security invoker set search_path = public as $$
declare t public.tasks; cid uuid; mx text; r jsonb; key text := 'task:' || p_task::text; cust uuid;
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
  cust := coalesce(nullif(p_case ->> 'customer_id', '')::uuid, t.customer_id);
  -- the task is the new case's first step (when it is still open), so the stage's own first task is not added
  if t.status <> 'done' then perform set_config('safar.first_step_given', 'on', true); end if;
  r := public.create_case(
         jsonb_build_object('customer_id', cust::text,
                            'title', coalesce(nullif(trim(coalesce(p_case ->> 'title', '')), ''), t.title))
         || (p_case - 'customer_id' - 'title'),
         private.default_travellers(cust, p_travellers), key);
  perform set_config('safar.first_step_given', '', true);
  cid := (r ->> 'id')::uuid;
  -- only the link changes: owner, due time, priority, notes, status and comments stay as they were
  perform set_config('safar.task_relink', 'on', true);
  update public.tasks set case_id = cid, customer_id = coalesce(customer_id, (select customer_id from public.cases where id = cid)) where id = p_task;
  perform set_config('safar.task_relink', '', true);
  perform private.log_event('convert', 'task', p_task, cid, t.customer_id, 'Case ' || (r ->> 'max_id') || ' created from task: ' || t.title);
  return r || jsonb_build_object('task_id', p_task);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
