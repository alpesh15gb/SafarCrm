-- Staff work on shared customer profiles and cases. Financial records and deletes remain owner actions.
create or replace function public.can_see_profit() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_boss()
$$;

create or replace function public.can_see_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_team() and exists (select 1 from public.cases where id = p_case)
$$;

create or replace function public.can_see_case_row(p_assigned uuid, p_created uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_team()
$$;

-- Keep existing scope for identity documents and IDs. The customer record itself is shared.
alter policy customers_select on public.customers using (public.is_team());
alter policy customers_update on public.customers using (public.is_team()) with check (public.is_team());

alter policy lines_select on public.booking_lines using (public.is_boss());
alter policy lines_insert on public.booking_lines with check (public.is_boss());
alter policy lines_update on public.booking_lines using (public.is_boss()) with check (public.is_boss());
alter policy exp_select on public.expenses using (public.is_boss());
alter policy exp_insert on public.expenses with check (public.is_boss());
alter policy exp_update on public.expenses using (public.is_boss()) with check (public.is_boss());
alter policy pay_select on public.payments using (public.is_boss());
alter policy pay_insert on public.payments with check (public.is_boss());
alter policy alloc_select on public.payment_allocations using (public.is_boss());
alter policy alloc_insert on public.payment_allocations with check (public.is_boss());
alter policy invoices_select on public.invoices using (public.is_boss());
alter policy money_accounts_select on public.money_accounts using (public.is_boss());
alter policy act_select on public.activity_log using (public.is_boss());
alter policy imports_select on public.ticket_imports using (public.is_boss());
alter policy imports_insert on public.ticket_imports with check (public.is_boss());

-- Case travellers are managed through the checked RPC below. Staff cannot delete join rows directly.
drop policy ctrav_all on public.case_travellers;
create policy ctrav_select on public.case_travellers for select to authenticated using (public.can_see_case(case_id));
create policy ctrav_insert on public.case_travellers for insert to authenticated with check (public.can_see_case(case_id));
create policy ctrav_update on public.case_travellers for update to authenticated using (public.can_see_case(case_id)) with check (public.can_see_case(case_id));
create policy ctrav_delete on public.case_travellers for delete to authenticated using (public.is_boss());
alter function public.set_case_travellers(uuid, uuid[]) security definer;

-- Only fields needed by operational lists, attachments, briefings, and case filters.
create view public.v_operational_bookings with (security_barrier = true) as
  select l.id, l.case_id, l.service, l.status, l.reference, l.traveller_ids, l.supplier_id,
    l.service_date, l.summary, l.sort, l.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'application_status', l.details->'application_status', 'date', l.details->'date',
      'check_out', l.details->'check_out', 'end_date', l.details->'end_date',
      'departure_time', l.details->'departure_time', 'boarding_time', l.details->'boarding_time',
      'from', l.details->'from', 'to', l.details->'to', 'train_no', l.details->'train_no', 'operator', l.details->'operator',
      'sectors', (select jsonb_agg(jsonb_build_object('date', sector->'date', 'dep', sector->'dep',
          'from', sector->'from', 'to', sector->'to', 'airline', sector->'airline', 'flight_no', sector->'flight_no') order by position)
        from jsonb_array_elements(case when jsonb_typeof(l.details->'sectors') = 'array' then l.details->'sectors' else '[]'::jsonb end)
        with ordinality as flight(sector, position))
    )) as details
  from public.booking_lines l
  where public.is_team();
revoke all on public.v_operational_bookings from public, anon, authenticated;
grant select on public.v_operational_bookings to authenticated;

-- Maintain operational reports for staff with the same safe projection.
do $$
declare fn regprocedure;
begin
  foreach fn in array array[
    'public.departures(date,date)'::regprocedure,
    'public.service_dates(date,date)'::regprocedure,
    'public.case_trip_end(uuid)'::regprocedure,
    'public.report_upcoming(date,date,text,uuid,uuid,uuid)'::regprocedure
  ] loop
    execute replace(pg_get_functiondef(fn), 'public.booking_lines', 'public.v_operational_bookings');
  end loop;
end $$;

-- Preserve normal case creation and its initial services. Staff can create unpriced service rows.
alter function public.create_case(jsonb, uuid[], text) set schema private;
revoke all on function private.create_case(jsonb, uuid[], text) from public, anon, authenticated;
create function public.create_case(p jsonb, p_travellers uuid[] default '{}', p_request_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if not public.is_boss() then
    p := jsonb_set(p, '{bookings}', coalesce((
      select jsonb_agg(jsonb_build_object('service', booking->>'service'))
      from jsonb_array_elements(coalesce(p->'bookings', '[]'::jsonb)) as booking
    ), '[]'::jsonb));
  end if;
  return private.create_case(p, p_travellers, p_request_key);
end $$;
revoke all on function public.create_case(jsonb, uuid[], text) from public, anon;
grant execute on function public.create_case(jsonb, uuid[], text) to authenticated, service_role;

-- Retain readiness checks while removing financial values from the staff-facing response.
create or replace function public.case_finish_items(p_case uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(item order by position), '[]'::jsonb)
  from jsonb_array_elements(case when public.can_see_case(p_case) then private.case_finish_items(p_case) else '[]'::jsonb end)
    with ordinality as items(item, position)
  where public.is_boss() or item->>'key' not in ('client', 'supplier', 'priced')
$$;

alter function public.case_readiness(uuid) set schema private;
revoke all on function private.case_readiness(uuid) from public, anon, authenticated;
create function public.case_readiness(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb := private.case_readiness(p_case);
begin
  if public.is_boss() then return result; end if;
  return jsonb_set(result, '{loose_ends}', coalesce((
    select jsonb_agg(case when item ? 'amount' then
      jsonb_build_object('code', item->>'code', 'count', 1, 'text', 'The owner needs to review the financial position')
      else item end order by position)
    from jsonb_array_elements(result->'loose_ends') with ordinality as items(item, position)
  ), '[]'::jsonb));
end $$;
revoke all on function public.case_readiness(uuid) from public, anon;
grant execute on function public.case_readiness(uuid) to authenticated, service_role;

-- RPCs with owner rights must enforce the same boundary before doing any work.
do $$
declare fn regprocedure; definition text;
begin
  foreach fn in array array[
    'public.issue_invoice(uuid,text)'::regprocedure,
    'public.cancel_invoice(uuid,text)'::regprocedure,
    'public.cancel_case(uuid,text)'::regprocedure,
    'public.portal_preview(uuid)'::regprocedure,
    'public.confirm_ticket_import(uuid,integer,text,jsonb)'::regprocedure,
    'public.save_import_draft(uuid,integer,jsonb)'::regprocedure,
    'public.replace_ticket_import(uuid,uuid)'::regprocedure,
    'public.retry_ticket_import(uuid)'::regprocedure,
    'public.reject_ticket_import(uuid,text,uuid)'::regprocedure
  ] loop
    definition := pg_get_functiondef(fn);
    if position(E'\nbegin\n' in lower(definition)) = 0 then
      raise exception 'Missing function body for %', fn;
    end if;
    execute regexp_replace(definition, E'\nbegin\n', E'\nbegin\n  if not public.is_boss() then raise exception ''Owner access required'' using errcode = ''42501''; end if;\n', 'i');
  end loop;
end $$;

-- File-assisted confirmation updates the status, without returning booking financial fields.
create function public.confirm_operational_booking(p_line uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare target public.booking_lines;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select l.* into target from public.booking_lines l
    join public.cases c on c.id = l.case_id
    where l.id = p_line and c.status <> 'cancelled' for update of l;
  if target.id is null then return false; end if;
  if target.status = 'confirmed' then return true; end if;
  if target.status <> 'pending' then return false; end if;
  update public.booking_lines set status = 'confirmed' where id = target.id;
  return true;
end $$;
revoke all on function public.confirm_operational_booking(uuid) from public, anon;
grant execute on function public.confirm_operational_booking(uuid) to authenticated;

create or replace function public.can_see_import(p_import uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_boss() and exists (select 1 from public.ticket_imports where id = p_import)
$$;

-- Finance reminders contain amounts in their titles, including reminders created before this release.
alter policy tasks_select on public.tasks using (
  public.is_boss() or (public.is_team()
    and (assigned_to = auth.uid() or created_by = auth.uid() or public.can_see_case(case_id))
    and coalesce(auto_key, '') not like all (array['clientdue:%', 'supdue:%']))
);
create function public.can_see_notice_for_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_boss() or not exists (
    select 1 from public.tasks where id = p_task and auto_key like any (array['clientdue:%', 'supdue:%']))
$$;
revoke all on function public.can_see_notice_for_task(uuid) from public, anon;
grant execute on function public.can_see_notice_for_task(uuid) to authenticated;
alter policy notif_select on public.notifications using (
  user_id = auth.uid() and public.can_see_notice_for_task(task_id)
);
alter policy notif_update on public.notifications using (
  user_id = auth.uid() and public.can_see_notice_for_task(task_id)
) with check (user_id = auth.uid() and public.can_see_notice_for_task(task_id));

create or replace function private.money_owner(p_case uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from public.profiles p where p.id = private.case_owner(p_case) and p.active and p.role = 'boss'),
    public.first_boss()
  )
$$;
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
  execute replace(definition,
    $match$to_char(r.due, 'FM99,99,99,990'), r.case_id, r.customer_id, private.case_owner(r.case_id)$match$,
    $match$to_char(r.due, 'FM99,99,99,990'), r.case_id, r.customer_id, private.money_owner(r.case_id)$match$);

  definition := pg_get_functiondef('public.case_work_summary(uuid[])'::regprocedure);
  execute replace(definition,
    $match$x.auto_key like 'supdue:%' and not public.can_see_profit()$match$,
    $match$x.auto_key like any (array['clientdue:%', 'supdue:%']) and not public.can_see_profit()$match$);
end $$;
