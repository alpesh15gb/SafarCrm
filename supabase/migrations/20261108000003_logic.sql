-- Safar CRM: business logic (money, triggers, reminders, portal, search, reports)

-- ---------------------------------------------------------------- money formulas
-- Profit = selling price + commission - supplier cost (GST never counted).
-- Cancelled: (selling price - refund to client) - (supplier cost - refund from supplier).
create or replace function public.line_profit(l public.booking_lines) returns numeric
language sql immutable as $$
  select case when l.status = 'cancelled'
              then (l.selling_price - l.refund_to_client) - (l.supplier_cost - l.refund_from_supplier)
              else l.selling_price + l.commission_amount - l.supplier_cost end
$$;

create or replace function public.line_sale(l public.booking_lines) returns numeric
language sql immutable as $$
  select case when l.status = 'cancelled' then l.selling_price - l.refund_to_client else l.selling_price end
$$;

create or replace function public.line_cost(l public.booking_lines) returns numeric
language sql immutable as $$
  select case when l.status = 'cancelled' then l.supplier_cost - l.refund_from_supplier else l.supplier_cost end
$$;

-- What the client is billed for a line (selling price + GST; after cancellation, what is kept).
create or replace function public.line_billed(l public.booking_lines) returns numeric
language sql immutable as $$
  select case when l.status = 'cancelled' then l.selling_price - l.refund_to_client else l.selling_price + l.gst end
$$;

-- ---------------------------------------------------------------- updated_at
create or replace function private.touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger t_touch before update on public.customers for each row execute function private.touch();
create trigger t_touch before update on public.suppliers for each row execute function private.touch();
create trigger t_touch before update on public.cases for each row execute function private.touch();
create trigger t_touch before update on public.booking_lines for each row execute function private.touch();
create trigger t_touch before update on public.tasks for each row execute function private.touch();
create trigger t_touch before update on public.settings for each row execute function private.touch();

-- ---------------------------------------------------------------- cases
create or replace function private.case_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.client_view is null then
      select portal_defaults into new.client_view from public.settings where id = 1;
    end if;
    if new.assigned_to is null then new.assigned_to := coalesce(auth.uid(), public.first_boss()); end if;
  else
    if new.max_no is distinct from old.max_no then raise exception 'MAX ID cannot be changed'; end if;
  end if;
  if new.status <> 'cancelled' then new.cancel_reason := null; end if;
  return new;
end $$;
create trigger t_case_defaults before insert or update on public.cases for each row execute function private.case_defaults();

-- the customer is always a traveller on their own case
create or replace function private.case_add_customer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.case_travellers (case_id, customer_id) values (new.id, new.customer_id) on conflict do nothing;
  return null;
end $$;
create trigger t_case_add_customer after insert on public.cases for each row execute function private.case_add_customer();

-- ---------------------------------------------------------------- booking lines
create or replace function private.is_intl_flight(d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(d -> 'sectors', '[]'::jsonb)) s,
         lateral (values (upper(trim(s ->> 'from'))), (upper(trim(s ->> 'to')))) v(code)
    where code ~ '^[A-Z]{3}$'
      and not exists (select 1 from public.lookups k where k.kind = 'airport' and k.value = code and k.extra ->> 'country' = 'IN')
  )
$$;

create or replace function private.line_compute() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.details, '{}'::jsonb);
  n int;
  codes text;
  credit int;
  is_credit boolean;
begin
  new.commission_amount := case when new.commission_type = 'percent'
                                then round(new.supplier_cost * new.commission_value / 100, 2)
                                else new.commission_value end;

  if new.service = 'flight' then
    n := jsonb_array_length(coalesce(d -> 'sectors', '[]'::jsonb));
    if n > 0 then
      new.service_date := nullif(d -> 'sectors' -> 0 ->> 'date', '')::date;
      if d ->> 'trip_type' = 'return' and n = 2 then
        codes := upper(coalesce(d -> 'sectors' -> 0 ->> 'from', '')) || ' ⇄ ' || upper(coalesce(d -> 'sectors' -> 0 ->> 'to', ''));
      else
        select string_agg(upper(coalesce(s ->> 'from', '')), ' → ' order by o) || ' → ' || upper(coalesce(d -> 'sectors' -> (n - 1) ->> 'to', ''))
          into codes from jsonb_array_elements(d -> 'sectors') with ordinality t(s, o);
      end if;
      new.summary := codes;
    end if;
  elsif new.service = 'hotel' then
    if coalesce(d ->> 'check_in', '') <> '' and coalesce(d ->> 'check_out', '') <> '' then
      d := jsonb_set(d, '{nights}', to_jsonb((d ->> 'check_out')::date - (d ->> 'check_in')::date));
    end if;
    new.service_date := nullif(d ->> 'check_in', '')::date;
    new.summary := concat_ws(', ', nullif(d ->> 'hotel_name', ''), nullif(d ->> 'city', ''));
  elsif new.service = 'insurance' then
    new.service_date := nullif(d ->> 'start_date', '')::date;
    new.summary := concat_ws(' ', nullif(d ->> 'insurer', ''), nullif(d ->> 'plan', ''));
  elsif new.service in ('rail', 'bus') then
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := concat_ws(' ', nullif(coalesce(d ->> 'train_no', d ->> 'operator'), ''),
                     nullif(upper(coalesce(d ->> 'from', '')) || ' → ' || upper(coalesce(d ->> 'to', '')), ' → '));
  else
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := nullif(d ->> 'title', '');
  end if;
  new.details := d;

  new.search_refs := upper(concat_ws(' ', new.reference, d ->> 'pnr', d ->> 'supplier_ref', d ->> 'policy_no',
                      d ->> 'confirmation_no', d ->> 'ticket_no',
                      (select string_agg(t ->> 'number', ' ') from jsonb_array_elements(coalesce(d -> 'tickets', '[]'::jsonb)) t)));

  if new.supplier_due_date is null and new.supplier_id is not null then
    select terms = 'credit', credit_days into is_credit, credit from public.suppliers where id = new.supplier_id;
    new.supplier_due_date := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date + case when is_credit then coalesce(credit, 0) else 0 end;
  end if;

  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end $$;
create trigger t_line_compute before insert or update on public.booking_lines for each row execute function private.line_compute();

-- ---------------------------------------------------------------- tasks & notifications
create or replace function private.task_compute() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.due_at is distinct from old.due_at or new.alert is distinct from old.alert
     or new.assigned_to is distinct from old.assigned_to then
    new.alert_at := case new.alert
      when 'none' then null
      when 'due' then new.due_at
      when '15m' then new.due_at - interval '15 minutes'
      when '1h' then new.due_at - interval '1 hour'
      when '1d' then new.due_at - interval '1 day' end;
    new.alerted_at := null;
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_by := auth.uid();
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_by := null;
    new.completed_at := null;
  end if;
  if new.case_id is not null and new.customer_id is null then
    select customer_id into new.customer_id from public.cases where id = new.case_id;
  end if;
  return new;
end $$;
create trigger t_task_compute before insert or update on public.tasks for each row execute function private.task_compute();

create or replace function private.task_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := (select full_name from public.profiles where id = auth.uid());
        mx text := (select max_id from public.cases where id = new.case_id);
begin
  if new.assigned_to is not null and new.assigned_to is distinct from auth.uid()
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    insert into public.notifications (user_id, title, body, link, task_id)
    values (new.assigned_to, 'New task: ' || new.title,
            concat_ws(' · ', mx, case when who is not null then 'from ' || who else 'automatic reminder' end,
                      case when new.due_at is not null then 'due ' || to_char(new.due_at, 'DD-MM-YYYY HH24:MI') end),
            '/tasks?open=' || new.id, new.id);
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status <> 'done'
     and new.created_by is not null and new.created_by is distinct from auth.uid() then
    insert into public.notifications (user_id, title, body, link, task_id)
    values (new.created_by, 'Done: ' || new.title, concat_ws(' · ', mx, 'by ' || coalesce(who, 'someone')), '/tasks?open=' || new.id, new.id);
  end if;
  return null;
end $$;
create trigger t_task_notify after insert or update on public.tasks for each row execute function private.task_notify();

-- Runs every minute: turns due alerts into bell notifications.
create or replace function public.dispatch_task_alerts() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with due as (
    update public.tasks set alerted_at = now()
     where alert_at <= now() and alerted_at is null and status <> 'done' and assigned_to is not null
     returning id, assigned_to, title, due_at, case_id
  )
  insert into public.notifications (user_id, title, body, link, task_id)
  select d.assigned_to, 'Reminder: ' || d.title,
         concat_ws(' · ', (select max_id from public.cases where id = d.case_id), 'due ' || to_char(d.due_at, 'DD-MM-YYYY HH24:MI')),
         '/tasks?open=' || d.id, d.id
  from due d;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- automatic reminders
create or replace function private.case_owner(p_case uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from public.cases c join public.profiles p on p.id = c.assigned_to and p.active and p.role <> 'client' where c.id = p_case),
    public.first_boss())
$$;

create or replace function private.customer_owner(p_customer uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from public.customers c join public.profiles p on p.id = c.assigned_to and p.active where c.id = p_customer),
    (select private.case_owner(c.id) from public.cases c where c.customer_id = p_customer order by c.created_at desc limit 1),
    public.first_boss())
$$;

create or replace function private.latest_case(p_customer uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.cases c
  left join public.case_travellers t on t.case_id = c.id
  where c.customer_id = p_customer or t.customer_id = p_customer
  order by (c.status in ('completed','cancelled')), c.created_at desc limit 1
$$;

create or replace function private.add_auto_task(p_key text, p_title text, p_case uuid, p_customer uuid, p_owner uuid, p_notes text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.tasks (case_id, customer_id, title, assigned_to, due_at, priority, alert, notes, auto_key, created_by)
  values (p_case, p_customer, p_title, p_owner,
          (current_date + time '10:00') at time zone 'Asia/Kolkata', 'normal', 'due', p_notes, p_key, null)
  on conflict (auto_key) do nothing
$$;

create or replace function public.run_auto_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := (select auto_reminders from public.settings where id = 1);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  r record;
begin
  if (cfg ->> 'passport_visa')::boolean then
    for r in select id, full_name, passport_expiry from public.customers
             where passport_expiry between today and today + interval '6 months' loop
      perform private.add_auto_task('passport:' || r.id || ':' || r.passport_expiry,
        'Passport expiring ' || to_char(r.passport_expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
    for r in select c.id, c.full_name, v ->> 'country' as country, (v ->> 'expiry')::date as expiry
             from public.customers c, jsonb_array_elements(c.visas) v
             where coalesce(v ->> 'expiry', '') <> '' and (v ->> 'expiry')::date between today and today + interval '6 months' loop
      perform private.add_auto_task('visa:' || r.id || ':' || coalesce(r.country, '') || ':' || r.expiry,
        coalesce(r.country, '') || ' visa expiring ' || to_char(r.expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
    for r in select d.id, d.customer_id, d.doc_type, d.expiry, c.full_name from public.customer_documents d
             join public.customers c on c.id = d.customer_id
             where d.expiry between today and today + interval '6 months'
               and (d.doc_type ilike 'passport%' or d.doc_type ilike 'visa%') loop
      perform private.add_auto_task('doc:' || r.id || ':' || r.expiry,
        r.doc_type || ' expiring ' || to_char(r.expiry, 'DD-MM-YYYY') || ' – ' || r.full_name,
        private.latest_case(r.customer_id), r.customer_id, private.customer_owner(r.customer_id));
    end loop;
  end if;

  if (cfg ->> 'trip_upcoming')::boolean then
    for r in select c.id, c.max_id, c.customer_id, c.travel_start from public.cases c
             where c.travel_start between today and today + 2 and c.status in ('confirmed','booked') loop
      perform private.add_auto_task('trip:' || r.id || ':' || r.travel_start,
        'Trip on ' || to_char(r.travel_start, 'DD-MM-YYYY') || ': web check-in and final documents',
        r.id, r.customer_id, private.case_owner(r.id));
    end loop;
  end if;

  if (cfg ->> 'client_due')::boolean then
    for r in select l.id, l.case_id, c.customer_id, l.payment_due_date, m.due from public.booking_lines l
             join public.cases c on c.id = l.case_id
             join lateral (
               select sum(public.line_billed(x)) - coalesce((select sum(amount) from public.payments p where p.case_id = l.case_id and p.direction = 'in'), 0) as due
               from public.booking_lines x where x.case_id = l.case_id) m on true
             where l.payment_due_date <= today and l.status <> 'cancelled' and m.due > 0
               and c.status in ('confirmed','booked','completed') loop
      perform private.add_auto_task('clientdue:' || r.case_id || ':' || r.payment_due_date,
        'Collect payment from client: ₹' || to_char(r.due, 'FM99,99,99,990'), r.case_id, r.customer_id, private.case_owner(r.case_id));
    end loop;
  end if;

  if (cfg ->> 'supplier_due')::boolean then
    for r in select l.case_id, l.supplier_id, s.name, min(l.supplier_due_date) as due_date,
                    sum(public.line_cost(l)) - coalesce((select sum(a.amount) from public.payment_allocations a
                       join public.payments p on p.id = a.payment_id
                       where a.case_id = l.case_id and p.supplier_id = l.supplier_id), 0) as due
             from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
             join public.cases cs on cs.id = l.case_id
             where l.supplier_due_date <= today and cs.status in ('confirmed','booked','completed','cancelled')
             group by l.case_id, l.supplier_id, s.name loop
      if r.due > 0 then
        perform private.add_auto_task('supdue:' || r.case_id || ':' || r.supplier_id || ':' || r.due_date,
          'Pay supplier ' || r.name || ': ₹' || to_char(r.due, 'FM99,99,99,990'), r.case_id, null, private.case_owner(r.case_id));
      end if;
    end loop;
  end if;

  if (cfg ->> 'hotel_cancel')::boolean then
    for r in select l.id, l.case_id, l.details ->> 'hotel_name' as hotel, (l.details ->> 'free_cancel_until')::date as until
             from public.booking_lines l
             where l.service = 'hotel' and l.status <> 'cancelled' and coalesce(l.details ->> 'free_cancel_until', '') <> ''
               and (l.details ->> 'free_cancel_until')::date between today and today + 1 loop
      perform private.add_auto_task('hotelcancel:' || r.id || ':' || r.until,
        'Free cancellation ends ' || to_char(r.until, 'DD-MM-YYYY') || ': ' || coalesce(r.hotel, 'hotel'),
        r.case_id, null, private.case_owner(r.case_id));
    end loop;
  end if;

  if (cfg ->> 'birthday')::boolean then
    for r in select id, full_name, 'birthday' as kind from public.customers
             where dob is not null and to_char(dob, 'MM-DD') = to_char(today, 'MM-DD')
             union all
             select id, full_name, 'anniversary' from public.customers
             where anniversary is not null and to_char(anniversary, 'MM-DD') = to_char(today, 'MM-DD') loop
      perform private.add_auto_task(r.kind || ':' || r.id || ':' || extract(year from today),
        'Wish ' || r.full_name || ' a happy ' || r.kind, private.latest_case(r.id), r.id, private.customer_owner(r.id));
    end loop;
  end if;
end $$;

-- International flight saved without insurance on the case -> reminder (immediately).
create or replace function private.line_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare intl boolean;
begin
  if new.service = 'flight' then
    intl := private.is_intl_flight(new.details);
    if intl then
      update public.cases set is_international = true where id = new.case_id and not is_international;
      if coalesce((select (auto_reminders ->> 'no_insurance')::boolean from public.settings where id = 1), true)
         and new.status <> 'cancelled'
         and not exists (select 1 from public.booking_lines x where x.case_id = new.case_id and x.service = 'insurance' and x.status <> 'cancelled') then
        perform private.add_auto_task('noins:' || new.case_id, 'International trip without travel insurance: offer a policy',
          new.case_id, null, private.case_owner(new.case_id));
      end if;
    end if;
  end if;
  return null;
end $$;
create trigger t_line_after after insert or update on public.booking_lines for each row execute function private.line_after();

-- ---------------------------------------------------------------- activity log
create or replace function private.log_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec jsonb; o jsonb; diff jsonb := '{}'; k text;
  ent text := tg_argv[0];
  skip text[] := array['updated_at','aadhaar_enc','pan_enc','passport_enc','aadhaar_hash','pan_hash','passport_hash','number_enc',
                       'search_refs','summary','alerted_at','alert_at','full_name','commission_amount','service_date','cancelled_at',
                       'completed_at','completed_by','superseded_at'];
  summ text;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
    for k in select jsonb_object_keys(rec) loop
      if k = any(skip) then continue; end if;
      if rec -> k is distinct from o -> k then
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', rec -> k));
      end if;
    end loop;
    if ent = 'customer' and ((rec ->> 'aadhaar_enc') is distinct from (o ->> 'aadhaar_enc')
        or (rec ->> 'pan_enc') is distinct from (o ->> 'pan_enc') or (rec ->> 'passport_enc') is distinct from (o ->> 'passport_enc')) then
      diff := diff || '{"id_numbers":{"to":"changed"}}';
    end if;
    if diff = '{}' then return null; end if;
  end if;
  summ := case ent
    when 'case' then (rec ->> 'max_id') || ' ' || coalesce(rec ->> 'title', '')
    when 'booking_line' then initcap(rec ->> 'service') || coalesce(' ' || (rec ->> 'summary'), '')
    when 'payment' then case rec ->> 'direction' when 'in' then 'Payment from client ₹' else 'Payment to supplier ₹' end || (rec ->> 'amount')
    when 'expense' then (rec ->> 'name') || ' ₹' || (rec ->> 'amount')
    when 'customer' then (rec ->> 'code') || ' ' || coalesce(rec ->> 'full_name', '')
    else coalesce(rec ->> 'title', rec ->> 'name', rec ->> 'file_name', rec ->> 'doc_type', '') end;
  insert into public.activity_log (actor, actor_name, action, entity, entity_id, case_id, customer_id, supplier_id, summary, changes)
  values (auth.uid(), (select full_name from public.profiles where id = auth.uid()),
          lower(tg_op), ent, (rec ->> 'id')::uuid,
          case when ent = 'case' then (rec ->> 'id')::uuid else nullif(rec ->> 'case_id', '')::uuid end,
          case when ent = 'customer' then (rec ->> 'id')::uuid else nullif(rec ->> 'customer_id', '')::uuid end,
          case when ent = 'supplier' then (rec ->> 'id')::uuid else nullif(rec ->> 'supplier_id', '')::uuid end,
          summ, case when tg_op = 'UPDATE' then diff end);
  return null;
end $$;

create trigger t_log after insert or update or delete on public.cases for each row execute function private.log_activity('case');
create trigger t_log after insert or update or delete on public.booking_lines for each row execute function private.log_activity('booking_line');
create trigger t_log after insert or update or delete on public.payments for each row execute function private.log_activity('payment');
create trigger t_log after insert or update or delete on public.expenses for each row execute function private.log_activity('expense');
create trigger t_log after insert or update or delete on public.files for each row execute function private.log_activity('file');
create trigger t_log after insert or update or delete on public.customers for each row execute function private.log_activity('customer');
create trigger t_log after insert or update or delete on public.customer_documents for each row execute function private.log_activity('document');
create trigger t_log after insert or update or delete on public.suppliers for each row execute function private.log_activity('supplier');
create trigger t_log after insert or update or delete on public.tasks for each row execute function private.log_activity('task');

-- ---------------------------------------------------------------- money views (respect RLS of the caller)
create or replace view public.v_case_money with (security_invoker = true) as
select c.id as case_id,
       coalesce(l.billed, 0) as billed,
       coalesce(r.received, 0) as received,
       coalesce(l.billed, 0) - coalesce(r.received, 0) as due,
       coalesce(l.cost, 0) as supplier_payable,
       coalesce(sp.paid, 0) as supplier_paid,
       coalesce(l.cost, 0) - coalesce(sp.paid, 0) as supplier_due,
       coalesce(l.sale, 0) as sale,
       case when public.can_see_profit() then coalesce(l.commission, 0) end as commission,
       case when public.can_see_profit() then coalesce(e.expenses, 0) end as expenses,
       case when public.can_see_profit() then coalesce(l.profit, 0) - coalesce(e.expenses, 0) end as profit,
       case when public.can_see_profit() and coalesce(l.sale, 0) > 0
            then round((coalesce(l.profit, 0) - coalesce(e.expenses, 0)) / l.sale * 100, 1) end as margin
from public.cases c
left join lateral (
  select sum(public.line_billed(x)) as billed, sum(public.line_sale(x)) as sale, sum(public.line_cost(x)) as cost,
         sum(case when x.status = 'cancelled' then 0 else x.commission_amount end) as commission,
         sum(public.line_profit(x)) as profit
  from public.booking_lines x where x.case_id = c.id) l on true
left join lateral (select sum(amount) as received from public.payments p where p.case_id = c.id and p.direction = 'in') r on true
left join lateral (select sum(a.amount) as paid from public.payment_allocations a where a.case_id = c.id) sp on true
left join lateral (select sum(amount) as expenses from public.expenses x where x.case_id = c.id) e on true;

create or replace view public.v_line_money with (security_invoker = true) as
select l.id as line_id, l.case_id,
       public.line_billed(l) as billed,
       public.line_sale(l) as sale,
       public.line_cost(l) as cost,
       case when public.can_see_profit() then public.line_profit(l) end as profit,
       case when public.can_see_profit() and public.line_sale(l) <> 0
            then round(public.line_profit(l) / public.line_sale(l) * 100, 1) end as margin
from public.booking_lines l;

create or replace view public.v_case_supplier_money with (security_invoker = true) as
select l.case_id, l.supplier_id, s.name as supplier_name,
       sum(public.line_cost(l)) as payable,
       coalesce((select sum(a.amount) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                 where a.case_id = l.case_id and p.supplier_id = l.supplier_id), 0) as paid,
       min(l.supplier_due_date) as due_date
from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
group by l.case_id, l.supplier_id, s.name;

create or replace view public.v_supplier_balance with (security_invoker = true) as
select s.id as supplier_id, s.name,
       coalesce((select sum(public.line_cost(l)) from public.booking_lines l where l.supplier_id = s.id), 0) as payable,
       coalesce((select sum(p.amount) from public.payments p where p.supplier_id = s.id and p.direction = 'out'), 0) as paid
from public.suppliers s;

-- ---------------------------------------------------------------- global search (RLS applies)
create or replace function public.global_search(q text)
returns table (kind text, id uuid, label text, sub text, href text)
language plpgsql stable set search_path = public, extensions as $$
declare t text := trim(q); digits text := regexp_replace(q, '\D', '', 'g');
begin
  if length(t) < 2 then return; end if;
  return query
  (select 'case', c.id, c.max_id || ' · ' || c.title, cu.full_name || ' · ' || initcap(c.status), '/cases/' || c.id
     from public.cases c join public.customers cu on cu.id = c.customer_id
    where c.max_id ilike '%' || t || '%' or c.max_no::text = digits or c.title ilike '%' || t || '%'
       or cu.full_name ilike '%' || t || '%'
    order by c.created_at desc limit 8)
  union all
  (select 'booking', l.case_id, c.max_id || ' · ' || initcap(l.service) || coalesce(' ' || l.summary, ''), 'Ref: ' || l.search_refs, '/cases/' || l.case_id || '?tab=bookings'
     from public.booking_lines l join public.cases c on c.id = l.case_id
    where l.search_refs like '%' || upper(t) || '%' limit 6)
  union all
  (select 'customer', cu.id, cu.full_name, cu.code || ' · ' || cu.mobile, '/customers/' || cu.id
     from public.customers cu
    where cu.full_name ilike '%' || t || '%' or cu.code ilike t || '%'
       or (length(digits) >= 4 and regexp_replace(cu.mobile, '\D', '', 'g') like '%' || digits || '%')
    limit 8)
  union all
  (select 'supplier', s.id, s.name, initcap(replace(s.supplier_type, '_', ' ')), '/suppliers/' || s.id
     from public.suppliers s where s.name ilike '%' || t || '%' limit 4);
end $$;

-- ---------------------------------------------------------------- reports (permission-checked)
create or replace function private.need_profit() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_profit() then raise exception 'You do not have access to profit reports'; end if;
end $$;

create or replace function public.report_pnl(p_from date, p_to date, p_service text default null, p_staff uuid default null,
                                             p_supplier uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, booked_on date, customer text, title text, staff text, status text,
               sale numeric, cost numeric, commission numeric, expenses numeric, profit numeric, margin numeric)
language plpgsql stable set search_path = public as $$
begin
  perform private.need_profit();
  return query
  select c.id, c.max_id, (c.created_at at time zone 'Asia/Kolkata')::date, cu.full_name, c.title, pr.full_name, c.status,
         l.sale, l.cost, l.commission, e.amt, l.profit - e.amt,
         case when l.sale <> 0 then round((l.profit - e.amt) / l.sale * 100, 1) end
  from public.cases c
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  cross join lateral (
    select coalesce(sum(public.line_sale(x)), 0) sale, coalesce(sum(public.line_cost(x)), 0) cost,
           coalesce(sum(case when x.status = 'cancelled' then 0 else x.commission_amount end), 0) commission,
           coalesce(sum(public.line_profit(x)), 0) profit
    from public.booking_lines x where x.case_id = c.id
      and (p_service is null or x.service = p_service) and (p_supplier is null or x.supplier_id = p_supplier)) l
  cross join lateral (
    select case when p_service is null and p_supplier is null then coalesce(sum(amount), 0) else 0 end amt
    from public.expenses x where x.case_id = c.id) e
  where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    and c.status not in ('enquiry','quoted')
    and (p_staff is null or c.assigned_to = p_staff)
    and (p_customer is null or c.customer_id = p_customer)
    and (p_service is null or exists (select 1 from public.booking_lines x where x.case_id = c.id and x.service = p_service))
    and (p_supplier is null or exists (select 1 from public.booking_lines x where x.case_id = c.id and x.supplier_id = p_supplier))
  order by c.created_at desc;
end $$;

create or replace function public.report_client_dues(p_staff uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, customer text, mobile text, staff text, billed numeric, received numeric, due numeric,
               due_since date, days int)
language sql stable set search_path = public as $$
  select c.id, c.max_id, cu.full_name, cu.mobile, pr.full_name, m.billed, m.received, m.due, d.since,
         ((now() at time zone 'Asia/Kolkata')::date - d.since)::int
  from public.cases c
  join public.v_case_money m on m.case_id = c.id
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  cross join lateral (select coalesce(min(payment_due_date), (c.created_at at time zone 'Asia/Kolkata')::date) since
                      from public.booking_lines where case_id = c.id and status <> 'cancelled') d
  where m.due > 0 and c.status not in ('enquiry','quoted')
    and (p_staff is null or c.assigned_to = p_staff) and (p_customer is null or c.customer_id = p_customer)
  order by d.since asc
$$;

create or replace function public.report_supplier_dues(p_supplier uuid default null)
returns table (supplier_id uuid, name text, payable numeric, paid numeric, due numeric, oldest_due date)
language sql stable set search_path = public as $$
  select b.supplier_id, b.name, b.payable, b.paid, b.payable - b.paid,
         (select min(l.supplier_due_date) from public.booking_lines l where l.supplier_id = b.supplier_id)
  from public.v_supplier_balance b
  where b.payable - b.paid <> 0 and (p_supplier is null or b.supplier_id = p_supplier)
  order by b.payable - b.paid desc
$$;

create or replace function public.report_sales(p_from date, p_to date, p_service text default null, p_staff uuid default null,
                                               p_supplier uuid default null, p_customer uuid default null)
returns table (group_kind text, group_key text, bookings bigint, sale numeric, profit numeric)
language plpgsql stable set search_path = public as $$
begin
  perform private.need_profit();
  return query
  with lines as (
    select x.service, c.assigned_to, public.line_sale(x) sale, public.line_profit(x) profit
    from public.booking_lines x join public.cases c on c.id = x.case_id
    where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
      and c.status not in ('enquiry','quoted')
      and (p_service is null or x.service = p_service) and (p_staff is null or c.assigned_to = p_staff)
      and (p_supplier is null or x.supplier_id = p_supplier) and (p_customer is null or c.customer_id = p_customer))
  select 'service', l.service, count(*), sum(l.sale), sum(l.profit) from lines l group by l.service
  union all
  select 'staff', coalesce(p.full_name, 'Unassigned'), count(*), sum(l.sale), sum(l.profit)
  from lines l left join public.profiles p on p.id = l.assigned_to group by p.full_name;
end $$;

create or replace function public.report_upcoming(p_from date, p_to date, p_service text default null, p_staff uuid default null,
                                                  p_supplier uuid default null, p_customer uuid default null)
returns table (case_id uuid, max_id text, customer text, mobile text, service text, summary text, service_date date, line_status text, staff text)
language sql stable set search_path = public as $$
  select c.id, c.max_id, cu.full_name, cu.mobile, l.service, l.summary, l.service_date, l.status, pr.full_name
  from public.booking_lines l
  join public.cases c on c.id = l.case_id
  join public.customers cu on cu.id = c.customer_id
  left join public.profiles pr on pr.id = c.assigned_to
  where l.service_date between p_from and p_to and l.status <> 'cancelled' and c.status <> 'cancelled'
    and (p_service is null or l.service = p_service) and (p_staff is null or c.assigned_to = p_staff)
    and (p_supplier is null or l.supplier_id = p_supplier) and (p_customer is null or c.customer_id = p_customer)
  order by l.service_date, c.max_no
$$;

create or replace function public.report_doc_expiry(p_months int default 6)
returns table (customer_id uuid, customer text, mobile text, document text, expiry date, days int)
language sql stable set search_path = public as $$
  with today as (select (now() at time zone 'Asia/Kolkata')::date d)
  select * from (
    select c.id, c.full_name, c.mobile, 'Passport', c.passport_expiry, (c.passport_expiry - t.d)::int
    from public.customers c, today t where c.passport_expiry is not null and c.passport_expiry <= t.d + make_interval(months => p_months)
    union all
    select c.id, c.full_name, c.mobile, 'Visa ' || coalesce(v ->> 'country', ''), (v ->> 'expiry')::date, ((v ->> 'expiry')::date - t.d)::int
    from public.customers c, today t, jsonb_array_elements(c.visas) v
    where coalesce(v ->> 'expiry', '') <> '' and (v ->> 'expiry')::date <= t.d + make_interval(months => p_months)
    union all
    select c.id, c.full_name, c.mobile, d.doc_type, d.expiry, (d.expiry - t.d)::int
    from public.customer_documents d join public.customers c on c.id = d.customer_id, today t
    where d.expiry is not null and d.expiry <= t.d + make_interval(months => p_months)
  ) x order by 5
$$;

-- ---------------------------------------------------------------- dashboard
create or replace function public.dashboard_money(p_from date, p_to date)
returns jsonb language plpgsql stable set search_path = public as $$
declare res jsonb;
begin
  perform private.need_profit();
  with cs as (
    select c.* from public.cases c
    where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to and c.status not in ('enquiry','quoted')),
  ln as (select x.service, cs.assigned_to, public.line_sale(x) sale, public.line_cost(x) cost, public.line_profit(x) profit
         from public.booking_lines x join cs on cs.id = x.case_id),
  ex as (select coalesce(sum(e.amount), 0) amt from public.expenses e join cs on cs.id = e.case_id)
  select jsonb_build_object(
    'sales', coalesce((select sum(l.sale) from ln l), 0),
    'cost', coalesce((select sum(l.cost) from ln l), 0),
    'profit', coalesce((select sum(l.profit) from ln l), 0) - (select amt from ex),
    'due_from_clients', coalesce((select sum(m.due) from public.v_case_money m join public.cases c on c.id = m.case_id
                                  where m.due > 0 and c.status not in ('enquiry','quoted')), 0),
    'by_service', coalesce((select jsonb_agg(jsonb_build_object('service', s, 'profit', p, 'sale', sl) order by s)
                   from (select l.service s, sum(l.profit) p, sum(l.sale) sl from ln l group by l.service) z), '[]'),
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name,
                      'cases', (select count(*) from cs where cs.assigned_to = pr.id),
                      'tasks_done', (select count(*) from public.tasks t where t.completed_by = pr.id
                                      and (t.completed_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
                      'profit', coalesce((select sum(l.profit) from ln l where l.assigned_to = pr.id), 0)) order by pr.role, pr.full_name)
                   from public.profiles pr where pr.role in ('boss','staff') and pr.active), '[]')
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------- client portal
create or replace function private.portal_case_visible(c public.cases) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((c.client_view ->> 'show_case')::boolean, true)
     and (not (select portal_hide_until_confirmed from public.settings where id = 1)
          or c.status in ('confirmed','booked','completed'))
$$;

create or replace function private.portal_owns_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cases c where c.id = p_case and public.my_customer_id() is not null
                   and (c.customer_id = public.my_customer_id()
                        or exists (select 1 from public.case_travellers t where t.case_id = c.id and t.customer_id = public.my_customer_id())))
$$;

-- Only fields a client may see; supplier/GDS references are never included.
create or replace function private.portal_details(svc text, d jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(case svc
    when 'flight' then jsonb_build_object('trip_type', d -> 'trip_type', 'cabin', d -> 'cabin', 'pnr', d -> 'pnr',
         'baggage', d -> 'baggage', 'refundable', d -> 'refundable',
         'sectors', (select jsonb_agg(jsonb_build_object('from', s -> 'from', 'to', s -> 'to', 'date', s -> 'date', 'airline', s -> 'airline',
                       'flight_no', s -> 'flight_no', 'dep', s -> 'dep', 'arr', s -> 'arr')) from jsonb_array_elements(coalesce(d -> 'sectors', '[]')) s),
         'tickets', (select jsonb_agg(jsonb_build_object('passenger', t -> 'passenger', 'number', t -> 'number'))
                     from jsonb_array_elements(coalesce(d -> 'tickets', '[]')) t))
    when 'hotel' then jsonb_build_object('hotel_name', d -> 'hotel_name', 'city', d -> 'city', 'check_in', d -> 'check_in',
         'check_out', d -> 'check_out', 'nights', d -> 'nights', 'rooms', d -> 'rooms', 'room_type', d -> 'room_type',
         'meal_plan', d -> 'meal_plan', 'adults', d -> 'adults', 'children', d -> 'children',
         'confirmation_no', d -> 'confirmation_no', 'free_cancel_until', d -> 'free_cancel_until')
    when 'insurance' then jsonb_build_object('insurer', d -> 'insurer', 'plan', d -> 'plan', 'policy_no', d -> 'policy_no',
         'start_date', d -> 'start_date', 'end_date', d -> 'end_date', 'sum_insured', d -> 'sum_insured', 'region', d -> 'region')
    when 'rail' then jsonb_build_object('train_no', d -> 'train_no', 'train_name', d -> 'train_name', 'from', d -> 'from', 'to', d -> 'to',
         'date', d -> 'date', 'class', d -> 'class', 'quota', d -> 'quota', 'pnr', d -> 'pnr', 'coach', d -> 'coach',
         'berth', d -> 'berth', 'rail_status', d -> 'rail_status')
    when 'bus' then jsonb_build_object('operator', d -> 'operator', 'from', d -> 'from', 'to', d -> 'to', 'date', d -> 'date',
         'boarding_point', d -> 'boarding_point', 'boarding_time', d -> 'boarding_time', 'drop_point', d -> 'drop_point',
         'bus_type', d -> 'bus_type', 'seats', d -> 'seats', 'ticket_no', d -> 'ticket_no')
    else jsonb_build_object('title', d -> 'title', 'description', d -> 'description') end)
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
      from public.booking_lines l where l.case_id = c.id and l.visible_to_client));
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

create or replace function public.portal_trips() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'client' then raise exception 'Not a portal user'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'max_id', c.max_id, 'title', c.title, 'status', c.status,
            'travel_start', c.travel_start, 'travel_end', c.travel_end, 'destination', c.destination)
            order by c.travel_start desc nulls last), '[]')
          from public.cases c where private.portal_owns_case(c.id) and private.portal_case_visible(c));
end $$;

create or replace function public.portal_trip(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.cases;
begin
  if public.my_role() is distinct from 'client' then raise exception 'Not a portal user'; end if;
  select * into c from public.cases where id = p_case;
  if not found or not private.portal_owns_case(p_case) or not private.portal_case_visible(c) then return null; end if;
  return private.build_portal_trip(p_case);
end $$;

-- "Preview as client": exactly what the client would get.
create or replace function public.portal_preview(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_case(p_case) then raise exception 'Not allowed'; end if;
  return private.build_portal_trip(p_case);
end $$;

-- Storage path for a downloadable case file, if the caller may download it.
create or replace function public.file_access(p_file uuid) returns table (storage_path text, file_name text, mime text)
language plpgsql stable security definer set search_path = public as $$
declare f public.files; c public.cases; cv jsonb;
begin
  select * into f from public.files where id = p_file;
  if not found then return; end if;
  if public.is_team() then
    if f.case_id is null or public.can_see_case(f.case_id) then
      return query select f.storage_path, f.file_name, f.mime;
    end if;
    return;
  end if;
  if public.my_role() = 'client' and f.case_id is not null and f.visible_to_client and f.superseded_at is null
     and private.portal_owns_case(f.case_id) then
    select * into c from public.cases where id = f.case_id;
    cv := coalesce(c.client_view, (select portal_defaults from public.settings where id = 1));
    if private.portal_case_visible(c) and coalesce((cv ->> 'show_files')::boolean, true)
       and (f.booking_line_id is null or (select visible_to_client from public.booking_lines where id = f.booking_line_id)) then
      return query select f.storage_path, f.file_name, f.mime;
    end if;
  end if;
end $$;

create or replace function public.document_access(p_doc uuid) returns table (storage_path text, file_name text, mime text)
language plpgsql stable security definer set search_path = public as $$
begin
  return query select d.storage_path, d.file_name, d.mime from public.customer_documents d
   where d.id = p_doc and d.storage_path is not null
     and (public.is_team() or d.customer_id = public.my_customer_id());
end $$;

create or replace function public.portal_profile() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cid uuid := public.my_customer_id();
begin
  if cid is null then raise exception 'Not a portal user'; end if;
  return (select jsonb_build_object(
    'code', c.code, 'title', c.title, 'first_name', c.first_name, 'middle_name', c.middle_name, 'last_name', c.last_name,
    'full_name', c.full_name, 'dob', c.dob, 'mobile', c.mobile, 'alt_mobile', c.alt_mobile, 'whatsapp', c.whatsapp, 'email', c.email,
    'address1', c.address1, 'address2', c.address2, 'city', c.city, 'state', c.state, 'pin', c.pin, 'country', c.country,
    'passport_expiry', c.passport_expiry, 'seat_pref', c.seat_pref, 'meal_pref', c.meal_pref, 'special_assistance', c.special_assistance,
    'emergency_name', c.emergency_name, 'emergency_relation', c.emergency_relation, 'emergency_mobile', c.emergency_mobile,
    'allow_uploads', (select portal_allow_uploads from public.settings where id = 1),
    'agency', (select jsonb_build_object('name', agency_name, 'phone', agency_phone, 'email', agency_email) from public.settings where id = 1),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'expiry', d.expiry, 'status', d.status,
                    'file_name', d.file_name, 'has_file', d.storage_path is not null, 'created_at', d.created_at) order by d.created_at desc), '[]')
                  from public.customer_documents d where d.customer_id = c.id))
    from public.customers c where c.id = cid);
end $$;

create or replace function public.portal_update_profile(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := public.my_customer_id();
begin
  if cid is null then raise exception 'Not a portal user'; end if;
  update public.customers set
    email = coalesce(p ->> 'email', email), alt_mobile = coalesce(p ->> 'alt_mobile', alt_mobile),
    whatsapp = coalesce(p ->> 'whatsapp', whatsapp), address1 = coalesce(p ->> 'address1', address1),
    address2 = coalesce(p ->> 'address2', address2), city = coalesce(p ->> 'city', city), state = coalesce(p ->> 'state', state),
    pin = coalesce(p ->> 'pin', pin), seat_pref = coalesce(p ->> 'seat_pref', seat_pref), meal_pref = coalesce(p ->> 'meal_pref', meal_pref),
    special_assistance = coalesce(p ->> 'special_assistance', special_assistance),
    emergency_name = coalesce(p ->> 'emergency_name', emergency_name), emergency_relation = coalesce(p ->> 'emergency_relation', emergency_relation),
    emergency_mobile = coalesce(p ->> 'emergency_mobile', emergency_mobile)
  where id = cid;
end $$;

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------- realtime for the bell
alter publication supabase_realtime add table public.notifications;

-- ---------------------------------------------------------------- schedules (IST)
select cron.schedule('safar-auto-reminders', '30 0 * * *', 'select public.run_auto_reminders()');  -- 06:00 IST
select cron.schedule('safar-task-alerts', '* * * * *', 'select public.dispatch_task_alerts()');

-- ---------------------------------------------------------------- grants (again, for functions created here)
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.run_auto_reminders() from authenticated;
revoke execute on function public.dispatch_task_alerts() from authenticated;
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------- only the boss controls what clients see
create or replace function private.guard_client_view() returns trigger
language plpgsql security definer set search_path = public as $$
declare changed boolean;
begin
  if auth.uid() is null or public.is_boss() then return new; end if;
  if tg_table_name = 'cases' then
    changed := to_jsonb(new) -> 'client_view' is distinct from to_jsonb(old) -> 'client_view';
  else
    changed := to_jsonb(new) -> 'visible_to_client' is distinct from to_jsonb(old) -> 'visible_to_client';
  end if;
  if changed then raise exception 'Only the boss can change what clients see'; end if;
  return new;
end $$;
create trigger t_guard_client_view before update on public.cases for each row execute function private.guard_client_view();
create trigger t_guard_client_view before update on public.booking_lines for each row execute function private.guard_client_view();
create trigger t_guard_client_view before update on public.files for each row execute function private.guard_client_view();

-- private schema: not exposed by the API; only need_profit() is callable from invoker functions
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.need_profit() to authenticated;
