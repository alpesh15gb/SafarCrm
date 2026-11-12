-- Invoices. Until now the CRM had an estimate (quotation) and payment receipts, but no invoice.
--   * an invoice is a numbered, fixed copy of what was billed on a case on the day it was issued
--   * numbers run per financial year (April to March): INV/26-27/0001, never reused, no gaps from failed attempts
--   * a booking can be on only one live invoice; to change an invoice, cancel it (with a reason) and issue a new one
--   * agency tax and payment details for the printed documents
-- Additive. Nothing here changes payments, dues or profit: an invoice is a document, not a ledger entry.

alter table public.settings add column if not exists agency_gstin text;
alter table public.settings add column if not exists agency_pan text;
alter table public.settings add column if not exists bank_details text;
alter table public.settings add column if not exists upi_id text;
alter table public.settings add column if not exists invoice_prefix text not null default 'INV';
alter table public.settings add column if not exists estimate_valid_days int not null default 2;
do $$ begin
  alter table public.settings add constraint settings_estimate_days check (estimate_valid_days between 1 and 60);
exception when duplicate_object then null; end $$;

create table if not exists public.invoice_counters (
  fy text primary key,
  next_seq int not null default 1
);
alter table public.invoice_counters enable row level security;   -- no policies: only the functions below touch it

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  fy text not null,
  seq int not null,
  case_id uuid references public.cases (id) on delete set null,       -- the invoice outlives its case
  customer_id uuid references public.customers (id) on delete set null,
  issued_on date not null,
  bill_to jsonb not null,      -- name, address, gstin, mobile as they were on the day
  case_ref jsonb not null,     -- max_id, title, travellers
  lines jsonb not null,        -- [{line_id, service, summary, service_date, travellers, amount, gst}]
  subtotal numeric(12,2) not null,
  gst numeric(12,2) not null,
  total numeric(12,2) not null,
  status text not null default 'issued' check (status in ('issued', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  request_key text unique,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (fy, seq)
);
create index if not exists invoices_case_idx on public.invoices (case_id);
alter table public.invoices enable row level security;
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated
  using (public.is_team() and (public.is_boss() or (case_id is not null and public.can_see_case(case_id))));
-- no insert / update / delete policies: invoices are written only by issue_invoice() and cancel_invoice()

-- financial year of a date, as '26-27'
create or replace function private.fy_of(d date) returns text
language sql immutable as $$
  select case when extract(month from d) >= 4
              then to_char(d, 'YY') || '-' || to_char(d + interval '1 year', 'YY')
              else to_char(d - interval '1 year', 'YY') || '-' || to_char(d, 'YY') end
$$;

-- Issue an invoice for everything on the case that is priced, not cancelled and not already on a live invoice.
create or replace function public.issue_invoice(p_case uuid, p_request_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.cases; cu public.customers; cfg public.settings; inv public.invoices;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  rows jsonb; sub numeric; tax numeric; fyear text; n int; num text; names text;
begin
  if not public.is_team() or not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cases where id = p_case for update;     -- one invoice at a time per case
  if c.id is null then raise exception 'Case not found' using errcode = 'P0001'; end if;
  if p_request_key is not null then
    select * into inv from public.invoices where request_key = p_request_key;
    if inv.id is not null then return jsonb_build_object('id', inv.id, 'number', inv.number, 'existing', true); end if;
  end if;
  if c.status = 'cancelled' then raise exception 'invoice_case_cancelled' using errcode = 'P0001'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'line_id', l.id, 'service', l.service, 'summary', l.summary, 'service_date', l.service_date,
           'travellers', (select string_agg(t.full_name, ', ') from public.customers t where t.id = any(l.traveller_ids)),
           'amount', l.selling_price, 'gst', l.gst)
           order by l.sort, l.service_date nulls last, l.created_at), '[]'::jsonb),
         coalesce(sum(l.selling_price), 0), coalesce(sum(l.gst), 0)
    into rows, sub, tax
  from public.booking_lines l
  where l.case_id = p_case and l.status <> 'cancelled' and (l.selling_price + l.gst) > 0
    and not exists (
      select 1 from public.invoices i, jsonb_array_elements(i.lines) x
      where i.case_id = p_case and i.status = 'issued' and x ->> 'line_id' = l.id::text);
  if jsonb_array_length(rows) = 0 then raise exception 'invoice_nothing_to_bill' using errcode = 'P0001'; end if;

  select * into cu from public.customers where id = c.customer_id;
  select * into cfg from public.settings where id = 1;
  select string_agg(t.full_name, ', ') into names
  from public.case_travellers ct join public.customers t on t.id = ct.customer_id where ct.case_id = p_case;

  fyear := private.fy_of(today);
  insert into public.invoice_counters (fy, next_seq) values (fyear, 2)
  on conflict (fy) do update set next_seq = public.invoice_counters.next_seq + 1
  returning next_seq - 1 into n;
  num := coalesce(nullif(trim(cfg.invoice_prefix), ''), 'INV') || '/' || fyear || '/' || lpad(n::text, 4, '0');

  insert into public.invoices (number, fy, seq, case_id, customer_id, issued_on, bill_to, case_ref, lines, subtotal, gst, total, request_key, created_by)
  values (num, fyear, n, p_case, c.customer_id, today,
          jsonb_build_object(
            'name', coalesce(nullif(trim(cu.company_name), ''), cu.full_name),
            'address', coalesce(nullif(trim(cu.billing_address), ''),
                                nullif(concat_ws(', ', nullif(trim(cu.address1), ''), nullif(trim(cu.address2), ''), nullif(trim(cu.city), ''), nullif(trim(cu.state), ''), nullif(trim(cu.pin), '')), '')),
            'gstin', nullif(trim(cu.gstin), ''), 'mobile', cu.mobile),
          jsonb_build_object('max_id', c.max_id, 'title', c.title, 'travellers', names,
                             'travel_start', c.travel_start, 'travel_end', c.travel_end, 'destination', c.destination),
          rows, sub, tax, sub + tax, p_request_key, auth.uid())
  returning * into inv;
  perform private.log_event('issue', 'invoice', inv.id, p_case, c.customer_id,
    num || ' for ₹' || to_char(inv.total, 'FM99,99,99,990.00'));
  return jsonb_build_object('id', inv.id, 'number', inv.number, 'existing', false);
end $$;

create or replace function public.cancel_invoice(p_invoice uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.invoices;
begin
  select * into inv from public.invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'Invoice not found' using errcode = 'P0001'; end if;
  if not public.is_team() or not (public.is_boss() or (inv.case_id is not null and public.can_see_case(inv.case_id))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'invoice_cancel_reason' using errcode = 'P0001'; end if;
  if inv.status = 'cancelled' then return; end if;
  update public.invoices set status = 'cancelled', cancel_reason = trim(p_reason), cancelled_at = now(), cancelled_by = auth.uid() where id = p_invoice;
  perform private.log_event('cancel', 'invoice', inv.id, inv.case_id, inv.customer_id, inv.number || '. Reason: ' || trim(p_reason));
end $$;

revoke execute on function public.issue_invoice(uuid, text) from public, anon;
revoke execute on function public.cancel_invoice(uuid, text) from public, anon;
grant execute on function public.issue_invoice(uuid, text) to authenticated;
grant execute on function public.cancel_invoice(uuid, text) to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
