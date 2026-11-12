-- Restricted staff (no "can see all cases") see and export only their own customers (owner's decision, 2026-11-13).
-- Before: every staff member could list, open and export every customer, with documents and ID numbers.
--
-- "Their own" customer: assigned to them, created by them, paying for or travelling on a case they can open, or the
-- subject of a task they hold. The boss and staff with "can see all cases" are unchanged.
-- So nobody makes a duplicate, the customer search in forms still finds any customer by name, code or mobile, but
-- shows only the name, code and a masked mobile for customers who are not theirs (customer_picker below). Picking one
-- for a new case makes them theirs. Family members are listed by name when choosing travellers. Additive.

create or replace function public.can_see_customer_row(p_id uuid, p_assigned uuid, p_created uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and private.session_ok() and p.role in ('boss', 'staff')
      and (p.role = 'boss' or p.can_see_all_cases or p_assigned = p.id or p_created = p.id
           or exists (select 1 from public.cases c where c.customer_id = p_id and (c.assigned_to = p.id or c.created_by = p.id))
           or exists (select 1 from public.case_travellers t join public.cases c on c.id = t.case_id
                      where t.customer_id = p_id and (c.assigned_to = p.id or c.created_by = p.id))
           or exists (select 1 from public.tasks k where k.customer_id = p_id and (k.assigned_to = p.id or k.created_by = p.id)))
  )
$$;

create or replace function public.can_see_customer(p_customer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.can_see_customer_row(c.id, c.assigned_to, c.created_by) from public.customers c where c.id = p_customer), false)
$$;
revoke execute on function public.can_see_customer_row(uuid, uuid, uuid) from public, anon;
revoke execute on function public.can_see_customer(uuid) from public, anon;
grant execute on function public.can_see_customer_row(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_see_customer(uuid) to authenticated;

-- the row's own columns are used (not a lookup of the row), so a customer just created is visible to its creator
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (public.is_team() and public.can_see_customer_row(id, assigned_to, created_by));
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update to authenticated
  using (public.is_team() and public.can_see_customer_row(id, assigned_to, created_by)) with check (public.is_team());

drop policy if exists cdocs_select on public.customer_documents;
create policy cdocs_select on public.customer_documents for select to authenticated
  using (public.is_team() and public.can_see_customer(customer_id));
drop policy if exists cdocs_update on public.customer_documents;
create policy cdocs_update on public.customer_documents for update to authenticated
  using (public.is_team() and public.can_see_customer(customer_id)) with check (public.is_team());

-- ID numbers and document numbers: only for customers the user may see
do $$
declare fn text; def text;
begin
  foreach fn in array array['public.get_customer_ids(uuid)', 'public.set_customer_ids(uuid,text,text,text)', 'public.document_numbers(uuid)'] loop
    def := pg_get_functiondef(fn::regprocedure);
    if position('can_see_customer' in def) = 0 then
      def := regexp_replace(def, 'if not \(?public\.is_team\(\)\)? then raise exception ''Not allowed''',
                            'if not (public.is_team() and public.can_see_customer(p_customer)) then raise exception ''Not allowed''');
      execute def;
    end if;
  end loop;
end $$;

-- ============================================================ customer search for forms
-- Finds any customer, so nobody adds a duplicate. Someone else's customer shows with a masked mobile.
create or replace function public.customer_picker(q text)
returns table (id uuid, code text, full_name text, mobile text, family_id uuid, customer_type text)
language plpgsql stable security definer set search_path = public as $$
declare t text := trim(coalesce(q, '')); digits text := regexp_replace(coalesce(q, ''), '\D', '', 'g');
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  return query
    select c.id, c.code, c.full_name,
           case when public.can_see_customer_row(c.id, c.assigned_to, c.created_by) then c.mobile
                else '•••• ' || right(regexp_replace(c.mobile, '\D', '', 'g'), 4) end,
           c.family_id, c.customer_type
    from public.customers c
    where t = ''
       or c.full_name ilike '%' || t || '%'
       or c.code ilike t || '%'
       or (length(digits) >= 4 and regexp_replace(c.mobile, '\D', '', 'g') like '%' || digits || '%')
    order by c.full_name
    limit 12;
end $$;
revoke execute on function public.customer_picker(text) from public, anon;
grant execute on function public.customer_picker(text) to authenticated;

-- travellers to choose from on a case: the customer's family or a company's employees, by name only
create or replace function public.customer_family(p_customer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_team() then null else jsonb_build_object(
    'last_name', c.last_name,
    'corporate', c.customer_type = 'corporate',
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'dob', m.dob, 'relation', m.relation, 'designation', m.designation) order by m.dob nulls last, m.full_name)
      from public.customers m
      where m.id <> c.id and ((c.family_id is not null and m.family_id = c.family_id) or (c.customer_type = 'corporate' and m.company_id = c.id))), '[]'::jsonb)) end
  from public.customers c where c.id = p_customer
$$;
revoke execute on function public.customer_family(uuid) from public, anon;
grant execute on function public.customer_family(uuid) to authenticated;

-- a task with a new case for a customer found in search (not yet this user's own): the name for the case title is
-- read with the database's own rights, as the rest of case creation already is
create or replace function private.customer_label(p_customer uuid) returns text
language sql stable security definer set search_path = public as $$
  select full_name from public.customers where id = p_customer
$$;
do $$
declare def text := pg_get_functiondef('public.create_task_with_case(jsonb, jsonb, uuid[], text)'::regprocedure);
begin
  if position('select full_name into cname from public.customers where id = cust;' in def) > 0 then
    execute replace(def, 'select full_name into cname from public.customers where id = cust;', 'cname := private.customer_label(cust);');
  end if;
end $$;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
grant execute on function private.customer_label(uuid) to authenticated;
