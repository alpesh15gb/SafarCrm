-- Fixes from the function reviews of 2026-11-12 (bookings and access control). Additive; no data is removed.

-- ============================================================ bookings
-- 1. "International" follows the live flights. It used to be switched on by any foreign or mistyped airport and
--    could never be switched off, leaving passport blockers and reminders no screen could clear.
-- 2. A visa appointment reminder closes when the appointment is moved or the visa line is cancelled or deleted.
create or replace function private.line_followups() returns trigger
language plpgsql security definer set search_path = public as $$
declare cid uuid; lid uuid; appt text;
begin
  if tg_op = 'DELETE' then cid := old.case_id; lid := old.id; else cid := new.case_id; lid := new.id; end if;

  update public.cases c set is_international = x.intl
    from (select exists (select 1 from public.booking_lines l
                         where l.case_id = cid and l.service = 'flight' and l.status <> 'cancelled' and private.is_intl_flight(l.details)) as intl) x
   where c.id = cid and c.is_international is distinct from x.intl;

  if tg_op = 'DELETE' then
    if old.service = 'visa' then
      update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the visa booking was removed.'
       where status <> 'done' and auto_key like 'visaappt:' || lid || ':%';
    end if;
  elsif new.service = 'visa' then
    appt := coalesce(new.details ->> 'appointment_date', '');
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: the appointment was changed or cancelled.'
     where status <> 'done' and auto_key like 'visaappt:' || lid || ':%'
       and (new.status = 'cancelled' or appt = '' or (appt ~ '^\d{4}-\d{2}-\d{2}$' and auto_key <> 'visaappt:' || lid || ':' || appt));
  end if;
  return null;
end $$;
drop trigger if exists t_line_followups on public.booking_lines;
create trigger t_line_followups after insert or update or delete on public.booking_lines
  for each row execute function private.line_followups();

-- existing cases: recompute once (open cases only; closed ones are history)
update public.cases c set is_international = x.intl
  from (select c2.id, exists (select 1 from public.booking_lines l
                              where l.case_id = c2.id and l.service = 'flight' and l.status <> 'cancelled' and private.is_intl_flight(l.details)) as intl
        from public.cases c2 where c2.status not in ('completed', 'cancelled')) x
 where c.id = x.id and c.is_international is distinct from x.intl;

-- 3. visa appointment reminders whose day has passed close with the other automatic tasks
do $$
declare def text := pg_get_functiondef('private.close_resolved_auto_tasks()'::regprocedure);
begin
  if position('visaappt' in def) = 0 and position('  return total;' in def) > 0 then
    execute replace(def, '  return total;',
      '  update public.tasks t set status = ''done'', notes = coalesce(t.notes || chr(10), '''') || ''Closed automatically: the appointment day has passed.''
   where t.status <> ''done'' and t.auto_key ~ ''^visaappt:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$''
     and split_part(t.auto_key, '':'', 3)::date < today;
  get diagnostics n = row_count; total := total + n;
  return total;');
  end if;
end $$;

-- 4. A passport copy changes the profile's passport expiry only once it is reviewed (a client upload waits for review),
--    and the profile follows the reviewed copies, so a corrected date can go down as well as up.
create or replace function private.sync_passport_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
declare latest date;
begin
  if new.doc_type ilike 'passport%' and new.status = 'ok' then
    select max(d.expiry) into latest from public.customer_documents d
     where d.customer_id = new.customer_id and d.doc_type ilike 'passport%' and d.status = 'ok' and d.expiry is not null;
    if latest is not null then
      update public.customers set passport_expiry = latest where id = new.customer_id and passport_expiry is distinct from latest;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_sync_passport_expiry on public.customer_documents;
create trigger t_sync_passport_expiry after insert or update of expiry, doc_type, status on public.customer_documents
  for each row execute function private.sync_passport_expiry();

-- ============================================================ access control
-- 5. Share links: staff see and make links only for files on cases they can open; a link lasts at most 7 days;
--    the boss can delete one. (Before: any staff member could read every link and make one for any file.)
drop policy if exists share_select on public.share_links;
create policy share_select on public.share_links for select to authenticated
  using (public.is_team() and (public.is_boss() or created_by = auth.uid()));
drop policy if exists share_insert on public.share_links;
create policy share_insert on public.share_links for insert to authenticated
  with check (public.is_team() and created_by = auth.uid() and expires_at <= now() + interval '7 days 1 hour'
              and exists (select 1 from public.files f where f.id = file_id and (f.case_id is null or public.can_see_case(f.case_id))));
drop policy if exists share_delete on public.share_links;
create policy share_delete on public.share_links for delete to authenticated using (public.is_boss());

-- 6. The type of a document with a stored number can't be changed by staff. (Renaming an Aadhaar document to
--    something else showed its full number, getting around the boss-only, logged reveal.)
create or replace function private.guard_doc_type() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.number_enc is not null and new.doc_type is distinct from old.doc_type and auth.uid() is not null and not public.is_boss() then
    raise exception 'doc_type_locked' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_doc_type on public.customer_documents;
create trigger t_guard_doc_type before update of doc_type on public.customer_documents
  for each row execute function private.guard_doc_type();

-- 7. A case with money on it can't be deleted. (Deleting silently removed its payments, receipts and expenses.)
create or replace function private.guard_case_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and (
       exists (select 1 from public.payments p where p.case_id = old.id)
       or exists (select 1 from public.payment_allocations a where a.case_id = old.id)
       or exists (select 1 from public.expenses e where e.case_id = old.id)
       or exists (select 1 from public.invoices i where i.case_id = old.id and i.status = 'issued')) then
    raise exception 'case_has_money' using errcode = 'P0001';
  end if;
  return old;
end $$;
drop trigger if exists t_guard_case_delete on public.cases;
create trigger t_guard_case_delete before delete on public.cases for each row execute function private.guard_case_delete();

-- 8. Only the boss can change where a file points or what it replaces. (Staff could rewrite these fields and undo
--    the rule that the boss publishes imported and replacement files.)
create or replace function private.guard_file_links() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_boss() and (
       new.import_id is distinct from old.import_id or new.replaces_id is distinct from old.replaces_id
       or new.superseded_at is distinct from old.superseded_at or new.storage_path is distinct from old.storage_path
       or new.case_id is distinct from old.case_id or new.mime is distinct from old.mime) then
    raise exception 'file_locked' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_file_links on public.files;
create trigger t_guard_file_links before update on public.files for each row execute function private.guard_file_links();

-- 9. Tasks: staff can still see every task on their cases, but change only tasks that are theirs, and only the boss
--    or the person who created a task can switch "required" on or off. (The wider rule added with the pipeline let
--    staff reassign other people's tasks and un-require a boss's required task.)
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid())))
  with check (public.is_boss() or (public.is_team() and assigned_to = auth.uid()));

create or replace function private.guard_task_required() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.blocking is distinct from old.blocking and auth.uid() is not null and not public.is_boss()
     and old.created_by is distinct from auth.uid() then
    raise exception 'task_required_locked' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_task_required on public.tasks;
create trigger t_guard_task_required before update of blocking on public.tasks
  for each row execute function private.guard_task_required();

-- 10. A ticket import can only point at a file in the imports folder
do $$ begin
  alter table public.ticket_imports add constraint ticket_imports_path check (storage_path like 'imports/%') not valid;
exception when duplicate_object then null; end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
