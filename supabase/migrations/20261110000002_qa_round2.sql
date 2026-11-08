-- QA round 2 (2026-11-09)

-- 1. a refund can never take the client's net payments below zero
create or replace function private.guard_refund() returns trigger
language plpgsql security definer set search_path = public as $$
declare paid numeric; r public.payments;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  if r.direction <> 'in' then return case when tg_op = 'DELETE' then old else new end; end if;
  -- what the client will have paid on this case after this change
  select coalesce(sum(amount), 0) into paid from public.payments where case_id = r.case_id and direction = 'in' and id <> r.id;
  if tg_op <> 'DELETE' then paid := paid + new.amount; end if;
  if paid < 0 and (tg_op = 'DELETE' or new.amount < 0) then
    if tg_op = 'DELETE' then
      raise exception 'refund_exceeds_received: deleting this receipt leaves more refunded than received; delete the refund first (only % would remain)', greatest(paid + 0, 0) using errcode = 'P0001';
    end if;
    raise exception 'refund_exceeds_received: only % can be refunded on this case', paid - new.amount using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists t_guard_refund on public.payments;
create trigger t_guard_refund before insert or update or delete on public.payments for each row execute function private.guard_refund();

-- 2. what is still open on a case (used before marking it Completed)
create or replace function public.case_open_items(p_case uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'pending_lines', (select count(*) from public.booking_lines l where l.case_id = p_case and l.status = 'pending'),
    'client_due', greatest(coalesce(m.due, 0), 0),
    'client_credit', greatest(-coalesce(m.due, 0), 0),
    'supplier_due', greatest(coalesce(m.supplier_due, 0), 0))
  from (select 1) x left join public.v_case_money m on m.case_id = p_case
$$;

-- 3. client credits (client paid more than billed, or a refund is owed)
create or replace function public.report_client_credits(p_staff uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, customer text, mobile text, staff text, status text, billed numeric, received numeric, credit numeric)
language sql stable set search_path = public as $$
  select c.id, c.max_id, cu.full_name, cu.mobile, pr.full_name, c.status::text, m.billed, m.received, -m.due
  from public.cases c
  join public.v_case_money m on m.case_id = c.id
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  where m.due < 0 and (p_staff is null or c.assigned_to = p_staff) and (p_customer is null or c.customer_id = p_customer)
  order by m.due
$$;

-- 4. upcoming travel: also trips that only have case dates (no dated booking in the period yet)
create or replace function public.report_upcoming(p_from date, p_to date, p_service text default null, p_staff uuid default null,
                                                  p_supplier uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, customer text, mobile text, service text, summary text, service_date date, line_status text, staff text)
language sql stable set search_path = public as $$
  select u.case_id, u.max_id, u.customer, u.mobile, u.service, u.summary, u.service_date, u.line_status, u.staff from (
    select c.id, c.max_id, cu.full_name, cu.mobile, l.service, l.summary, l.service_date, l.status, pr.full_name, c.max_no
    from public.booking_lines l
    join public.cases c on c.id = l.case_id
    join public.customers cu on cu.id = c.customer_id
    left join public.profiles pr on pr.id = c.assigned_to
    where l.service_date between p_from and p_to and l.status <> 'cancelled' and c.status <> 'cancelled'
      and (p_service is null or l.service = p_service) and (p_staff is null or c.assigned_to = p_staff)
      and (p_supplier is null or l.supplier_id = p_supplier) and (p_customer is null or c.customer_id = p_customer)
    union all
    select c.id, c.max_id, cu.full_name, cu.mobile, 'trip', 'Trip starts (from the case dates; no dated booking yet)', c.travel_start, c.status::text, pr.full_name, c.max_no
    from public.cases c
    join public.customers cu on cu.id = c.customer_id
    left join public.profiles pr on pr.id = c.assigned_to
    where c.travel_start between p_from and p_to and c.status not in ('cancelled', 'completed')
      and p_service is null and p_supplier is null
      and (p_staff is null or c.assigned_to = p_staff) and (p_customer is null or c.customer_id = p_customer)
      and not exists (select 1 from public.booking_lines l where l.case_id = c.id and l.status <> 'cancelled'
                        and l.service_date between p_from and p_to)
  ) u (case_id, max_id, customer, mobile, service, summary, service_date, line_status, staff, max_no)
  order by u.service_date, u.max_no
$$;

-- 5. never show a half-filled booking to the client
create or replace function private.line_incomplete(svc text, d jsonb) returns boolean
language sql immutable as $$
  select case svc
    when 'flight' then not exists (select 1 from jsonb_array_elements(coalesce(d -> 'sectors', '[]')) s
                                   where upper(coalesce(s ->> 'from', '')) ~ '^[A-Z]{3}$' and upper(coalesce(s ->> 'to', '')) ~ '^[A-Z]{3}$')
    when 'hotel' then coalesce(trim(d ->> 'hotel_name'), '') = ''
    when 'visa' then coalesce(trim(d ->> 'country'), '') = ''
    when 'insurance' then coalesce(trim(d ->> 'insurer'), '') = ''
    when 'rail' then coalesce(trim(d ->> 'train_no'), '') = ''
    when 'bus' then coalesce(trim(d ->> 'operator'), '') = ''
    else coalesce(trim(d ->> 'title'), '') = '' end
$$;

create or replace function private.build_portal_trip(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.cases; cv jsonb; res jsonb; m record;
begin
  select * into c from public.cases where id = p_case;
  if not found then return null; end if;
  cv := coalesce(c.client_view, (select portal_defaults from public.settings where id = 1));
  res := jsonb_build_object(
    'id', c.id, 'max_id', c.max_id, 'title', c.title, 'status', c.status, 'travel_start', c.travel_start,
    'travel_end', c.travel_end, 'destination', c.destination,
    'visible', private.portal_case_visible(c),
    'travellers', (select coalesce(jsonb_agg(cu.full_name order by cu.full_name), '[]') from public.case_travellers t
                   join public.customers cu on cu.id = t.customer_id where t.case_id = c.id),
    'agency', (select jsonb_build_object('name', agency_name, 'phone', agency_phone, 'email', agency_email) from public.settings where id = 1),
    'show', cv);
  if coalesce((cv ->> 'show_bookings')::boolean, true) then
    res := res || jsonb_build_object('bookings', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'service', l.service, 'status', l.status, 'summary', l.summary, 'date', l.service_date,
        'details', private.portal_details(l.service, l.details),
        'travellers', (select coalesce(jsonb_agg(cu.full_name), '[]') from public.customers cu where cu.id = any(l.traveller_ids)),
        'price', case when coalesce((cv ->> 'show_line_prices')::boolean, false) then public.line_billed(l) end)
        order by l.service_date nulls last, l.sort, l.created_at), '[]')
      from public.booking_lines l where l.case_id = c.id and l.visible_to_client
        and not private.line_incomplete(l.service, l.details)));
  end if;
  if coalesce((cv ->> 'show_files')::boolean, true) then
    res := res || jsonb_build_object('files', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'file_name', f.file_name, 'kind', f.kind, 'created_at', f.created_at) order by f.created_at), '[]')
      from public.files f left join public.booking_lines l on l.id = f.booking_line_id
      where f.case_id = c.id and f.visible_to_client and f.superseded_at is null
        and (l.id is null or l.visible_to_client)));
  end if;
  if coalesce((cv ->> 'show_payments')::boolean, true) then
    select coalesce(sum(public.line_billed(x)), 0) billed into m from public.booking_lines x where x.case_id = c.id;
    res := res || jsonb_build_object('payments', jsonb_build_object(
      'billed', m.billed,
      'paid', coalesce((select sum(amount) from public.payments p where p.case_id = c.id and p.direction = 'in'), 0),
      'due', m.billed - coalesce((select sum(amount) from public.payments p where p.case_id = c.id and p.direction = 'in'), 0)));
  end if;
  return res;
end $$;

revoke execute on function public.report_client_credits(uuid, uuid) from public, anon;
grant execute on function public.report_client_credits(uuid, uuid) to authenticated;
revoke execute on function public.case_open_items(uuid) from public, anon;
grant execute on function public.case_open_items(uuid) to authenticated;
