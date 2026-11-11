-- Fix: staff uploads failed with a row-level security error.
-- The select policy called can_see_import(id), which looks the row up again; during INSERT ... RETURNING the new
-- row isn't visible to that lookup yet, so the insert was refused. Like cases (can_see_case_row), the policy now
-- decides from the row's own columns.
create or replace function public.can_see_import_row(p_uploaded_by uuid, p_case uuid, p_customer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_team()
     and (public.is_boss()
          or p_uploaded_by = auth.uid()
          or (p_case is not null and public.can_see_case(p_case))
          or (p_case is null and exists (select 1 from public.customers c where c.id = p_customer and c.assigned_to = auth.uid())))
$$;

drop policy if exists imports_select on public.ticket_imports;
create policy imports_select on public.ticket_imports for select to authenticated
  using (public.can_see_import_row(uploaded_by, case_id, customer_id));

revoke execute on function public.can_see_import_row(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_see_import_row(uuid, uuid, uuid) to authenticated, service_role;
