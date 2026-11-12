-- Remaining gaps from the function review (2026-11-12). Additive.
--   1. A refused visa is a finished service (the fees are spent): its booking counts as done, not Pending, so the case
--      can complete and cancelling the case doesn't refund it in full as if it had never been applied for.
--   2. The supplier of a booking can't be changed once that supplier has been paid for it on the case (the money would
--      show as owed twice). Record a refund from them first, or let the boss remove the payment.
--   3. A case is cancelled only through "Cancel case" (with its checks and reason), never by writing the stage directly;
--      a case can't be created already Completed or Cancelled.
--   4. "Change your password" can't be skipped: the flag is cleared only by the server after the new password is saved.

-- ============================================================ 1. refused visa
do $$
declare def text := pg_get_functiondef('private.line_compute()'::regprocedure);
begin
  if position('in (''Approved'', ''Passport collected'') then ''confirmed''' in def) > 0 then
    execute replace(def, 'in (''Approved'', ''Passport collected'') then ''confirmed''',
                         'in (''Approved'', ''Passport collected'', ''Rejected'') then ''confirmed''');
  end if;
end $$;
-- existing refused visas: recompute
update public.booking_lines set details = details
 where service = 'visa' and status = 'pending' and details ->> 'application_status' = 'Rejected';

-- ============================================================ 2. supplier change on a paid booking
create or replace function private.guard_supplier_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare paid numeric; still_owed numeric;
begin
  if old.supplier_id is null or new.supplier_id is not distinct from old.supplier_id or auth.uid() is null then return new; end if;
  select coalesce(sum(a.amount), 0) into paid
    from public.payment_allocations a join public.payments p on p.id = a.payment_id
   where a.case_id = old.case_id and p.supplier_id = old.supplier_id;
  if paid <= 0.009 then return new; end if;
  select coalesce(sum(public.line_cost(l)), 0) into still_owed
    from public.booking_lines l where l.case_id = old.case_id and l.supplier_id = old.supplier_id and l.id <> old.id;
  if paid > still_owed + 0.009 then raise exception 'supplier_change_paid' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger if exists t_guard_supplier_change on public.booking_lines;
create trigger t_guard_supplier_change before update of supplier_id on public.booking_lines
  for each row execute function private.guard_supplier_change();

-- ============================================================ 3. cancel only through cancel_case; no closed cases at birth
create or replace function private.guard_case_cancel() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' and new.status in ('completed', 'cancelled') then
    raise exception 'case_new_closed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled'
     and coalesce(current_setting('safar.case_cancel', true), '') <> 'on' then
    raise exception 'case_cancel_direct' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_case_cancel on public.cases;
create trigger t_guard_case_cancel before insert or update of status on public.cases
  for each row execute function private.guard_case_cancel();

do $$
declare def text := pg_get_functiondef('public.cancel_case(uuid, text)'::regprocedure);
begin
  if position('safar.case_cancel' in def) = 0 then
    execute replace(def, 'update public.cases set status = ''cancelled'', cancel_reason = trim(p_reason) where id = p_case;',
      'perform set_config(''safar.case_cancel'', ''on'', true);
  update public.cases set status = ''cancelled'', cancel_reason = trim(p_reason) where id = p_case;
  perform set_config(''safar.case_cancel'', '''', true);');
  end if;
end $$;

-- ============================================================ 4. password change can't be skipped
revoke execute on function public.password_changed() from public, anon, authenticated;
