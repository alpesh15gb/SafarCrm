-- Audit fixes (2026-11-10)

-- 1. Travellers are chosen per case. The paying customer is no longer forced onto the trip
--    (a son can book for his parents), and a company is never a passenger.
drop trigger if exists t_case_add_customer on public.cases;
drop function if exists private.case_add_customer();

-- companies that were added as passengers by the old rule come off cases, bookings and ticket lists
update public.booking_lines l
set traveller_ids = array(select t from unnest(l.traveller_ids) t where t not in (select id from public.customers where customer_type = 'corporate'))
where exists (select 1 from unnest(l.traveller_ids) t join public.customers c on c.id = t where c.customer_type = 'corporate');
delete from public.case_travellers t using public.customers c where c.id = t.customer_id and c.customer_type = 'corporate';

-- 2. A customer who travelled on any trip can't be deleted (it used to silently erase them from that trip).
alter table public.case_travellers drop constraint case_travellers_customer_id_fkey;
alter table public.case_travellers add constraint case_travellers_customer_id_fkey
  foreign key (customer_id) references public.customers (id) on delete restrict;

-- 3. Ticket numbers belong to a person, not to a spelling of their name.
--    Existing tickets get the traveller's id by matching the name on that booking.
update public.booking_lines l
set details = jsonb_set(l.details, '{tickets}', (
  select coalesce(jsonb_agg(
    case when t ? 'customer_id' then t
         else t || coalesce((select jsonb_build_object('customer_id', c.id) from public.customers c
                             where c.id = any(l.traveller_ids) and c.full_name = t ->> 'passenger' limit 1), '{}'::jsonb) end), '[]'::jsonb)
  from jsonb_array_elements(l.details -> 'tickets') t))
where jsonb_typeof(l.details -> 'tickets') = 'array' and jsonb_array_length(l.details -> 'tickets') > 0;

-- tickets of companies removed in step 1 go too
update public.booking_lines l
set details = jsonb_set(l.details, '{tickets}', (
  select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(l.details -> 'tickets') t
  where not exists (select 1 from public.customers c where c.customer_type = 'corporate' and c.id::text = t ->> 'customer_id')))
where jsonb_typeof(l.details -> 'tickets') = 'array' and jsonb_array_length(l.details -> 'tickets') > 0;

-- correcting a name on the profile updates the name printed next to their ticket numbers
create or replace function private.rename_in_tickets() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.full_name is distinct from old.full_name then
    update public.booking_lines l
    set details = jsonb_set(l.details, '{tickets}', (
      select jsonb_agg(case when t ->> 'customer_id' = new.id::text then t || jsonb_build_object('passenger', new.full_name) else t end)
      from jsonb_array_elements(l.details -> 'tickets') t))
    where new.id = any(l.traveller_ids) and jsonb_typeof(l.details -> 'tickets') = 'array' and jsonb_array_length(l.details -> 'tickets') > 0;
  end if;
  return null;
end $$;
drop trigger if exists t_rename_in_tickets on public.customers;
create trigger t_rename_in_tickets after update of first_name, middle_name, last_name on public.customers
  for each row execute function private.rename_in_tickets();

-- 4. Portal: a client can see their family and upload documents for them.
create or replace function public.portal_family() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'full_name', c.full_name, 'relation', c.relation,
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'expiry', d.expiry, 'status', d.status) order by d.created_at desc), '[]'::jsonb)
                  from public.customer_documents d where d.customer_id = c.id)
  ) order by c.dob nulls last, c.full_name), '[]'::jsonb)
  from public.customers me
  join public.customers c on c.family_id = me.family_id and c.id <> me.id
  where me.id = public.my_customer_id() and me.family_id is not null
$$;
revoke execute on function public.portal_family() from public, anon;
grant execute on function public.portal_family() to authenticated;

-- 5. Real backup history (written by deploy/backup.sh), shown to the boss in Settings.
create table if not exists public.backup_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  db_size text,
  files_size text
);
alter table public.backup_log enable row level security;
drop policy if exists backup_log_select on public.backup_log;
create policy backup_log_select on public.backup_log for select to authenticated using (public.is_boss());

-- 6. A supplier payment may be partly for MAX IDs and partly an advance (consolidator wallet top-ups).
--    The MAX ID amounts may add up to less than the payment, never more.
create or replace function public.record_supplier_payment(
  p_supplier uuid, p_date date, p_amount numeric, p_mode text, p_reference text default null, p_notes text default null,
  p_allocations jsonb default '[]')
returns uuid language plpgsql security invoker set search_path = public as $$
declare pid uuid; total numeric;
begin
  select coalesce(sum((a ->> 'amount')::numeric), 0) into total from jsonb_array_elements(coalesce(p_allocations, '[]')) a;
  if total - p_amount > 0.009 then
    raise exception 'The MAX ID amounts add up to %, more than the payment of %', total, p_amount;
  end if;
  insert into public.payments (direction, supplier_id, pay_date, amount, mode, reference, notes)
  values ('out', p_supplier, coalesce(p_date, current_date), p_amount, p_mode, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''))
  returning id into pid;
  insert into public.payment_allocations (payment_id, case_id, amount)
  select pid, (a ->> 'case_id')::uuid, sum((a ->> 'amount')::numeric)
  from jsonb_array_elements(coalesce(p_allocations, '[]')) a
  where coalesce((a ->> 'amount')::numeric, 0) <> 0
  group by (a ->> 'case_id')::uuid;
  return pid;
end $$;

-- 7. Payment receipts: every payment received from a client gets a receipt number (R-1, R-2 ...), never reused.
alter table public.payments add column if not exists receipt_no bigint unique;
create sequence if not exists public.receipt_seq start 1;
with ordered as (
  select id, row_number() over (order by pay_date, created_at) as n from public.payments where direction = 'in' and amount > 0 and receipt_no is null
)
update public.payments p set receipt_no = o.n from ordered o where o.id = p.id;
select setval('public.receipt_seq', greatest(coalesce((select max(receipt_no) from public.payments), 0), 1), (select max(receipt_no) from public.payments) is not null);

create or replace function private.receipt_no() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'in' and new.amount > 0 and new.receipt_no is null then
    new.receipt_no := nextval('public.receipt_seq');
  end if;
  return new;
end $$;
drop trigger if exists t_receipt_no on public.payments;
create trigger t_receipt_no before insert on public.payments for each row execute function private.receipt_no();
