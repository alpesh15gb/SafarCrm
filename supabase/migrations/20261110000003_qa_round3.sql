-- QA round 3 (2026-11-09)

-- 1. cancellation: supplier charge always = supplier cost - refund from supplier (no second, conflicting number)
create or replace function private.line_compute() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.details, '{}'::jsonb);
  n int;
  codes text;
  credit int;
  is_credit boolean;
begin
  -- airline commission is paid on the base fare, not on taxes; use it when the agent has entered it
  new.commission_amount := case when new.commission_type = 'percent'
                                then round(coalesce(nullif(d ->> 'base_fare', '')::numeric, new.supplier_cost) * new.commission_value / 100, 2)
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
  elsif new.service = 'visa' then
    new.service_date := coalesce(nullif(d ->> 'appointment_date', '')::date, nullif(d ->> 'applied_on', '')::date);
    new.summary := concat_ws(' ', nullif(d ->> 'country', ''), nullif(d ->> 'visa_type', ''), 'visa');
    -- one status for beginners: the booking is confirmed once the visa is approved
    if new.status <> 'cancelled' then
      new.status := case when d ->> 'application_status' in ('Approved', 'Passport collected') then 'confirmed' else 'pending' end;
    end if;
  else
    new.service_date := nullif(d ->> 'date', '')::date;
    new.summary := nullif(d ->> 'title', '');
  end if;
  new.details := d;

  new.search_refs := upper(concat_ws(' ', new.reference, d ->> 'pnr', d ->> 'supplier_ref', d ->> 'policy_no',
                      d ->> 'confirmation_no', d ->> 'ticket_no', d ->> 'application_no', d ->> 'visa_number',
                      (select string_agg(t ->> 'number', ' ') from jsonb_array_elements(coalesce(d -> 'tickets', '[]'::jsonb)) t)));

  if new.supplier_due_date is null and new.supplier_id is not null then
    select terms = 'credit', credit_days into is_credit, credit from public.suppliers where id = new.supplier_id;
    new.supplier_due_date := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date + case when is_credit then coalesce(credit, 0) else 0 end;
  end if;

  -- one cancellation formula: the supplier charge is whatever the supplier keeps
  if new.status = 'cancelled' then
    new.cancellation_charge := greatest(new.supplier_cost - coalesce(new.refund_from_supplier, 0), 0);
  end if;
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end $$;

update public.booking_lines set status = status where status = 'cancelled';   -- recompute existing cancelled lines

-- 4. a passport copy uploaded with an expiry date keeps the profile's passport expiry in step
create or replace function private.sync_passport_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.expiry is not null and new.doc_type ilike 'passport%' then
    update public.customers set passport_expiry = new.expiry
     where id = new.customer_id and (passport_expiry is null or passport_expiry < new.expiry);
  end if;
  return new;
end $$;
drop trigger if exists t_sync_passport_expiry on public.customer_documents;
create trigger t_sync_passport_expiry after insert or update of expiry, doc_type on public.customer_documents
  for each row execute function private.sync_passport_expiry();

update public.customers c set passport_expiry = d.expiry
  from (select customer_id, max(expiry) expiry from public.customer_documents
         where doc_type ilike 'passport%' and expiry is not null group by customer_id) d
 where d.customer_id = c.id and (c.passport_expiry is null or c.passport_expiry < d.expiry);

-- refund guard: don't block a whole case being deleted (its payments go too, in any order)
create or replace function private.guard_refund() returns trigger
language plpgsql security definer set search_path = public as $$
declare paid numeric; r public.payments;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  if r.direction <> 'in' or r.case_id is null then return case when tg_op = 'DELETE' then old else new end; end if;
  -- the case itself is being deleted: nothing to protect
  if tg_op = 'DELETE' and not exists (select 1 from public.cases where id = r.case_id) then return old; end if;
  select coalesce(sum(amount), 0) into paid from public.payments where case_id = r.case_id and direction = 'in' and id <> r.id;
  if tg_op <> 'DELETE' then paid := paid + new.amount; end if;
  if paid < 0 and (tg_op = 'DELETE' or new.amount < 0) then
    if tg_op = 'DELETE' then
      raise exception 'refund_exceeds_received: deleting this receipt leaves more refunded than received; delete the refund first' using errcode = 'P0001';
    end if;
    raise exception 'refund_exceeds_received: only % can be refunded on this case', paid - new.amount using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
