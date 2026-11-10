-- Booked-ticket imports (slices C, D, E) plus case readiness (A6) and the case work summary (B).
-- Additive. Nothing here creates money: no selling price, supplier cost, payable, GST, commission, receipt or refund
-- is ever derived from a document. Amounts found on a ticket are kept as evidence on the import and the booking only.

-- ============================================================ table
create table if not exists public.ticket_imports (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'received'
    check (status in ('received', 'processing', 'needs_review', 'confirmed', 'failed', 'duplicate', 'rejected')),
  channel text not null default 'staff' check (channel in ('staff', 'portal')),
  -- private source file (bucket "files", path imports/...), never published by itself
  storage_path text not null,
  file_name text not null,
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  size int not null check (size > 0),
  pages int,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- authorized scope the upload was made in
  customer_id uuid references public.customers (id) on delete set null,
  case_id uuid references public.cases (id) on delete set null,
  booking_line_id uuid references public.booking_lines (id) on delete set null,
  uploaded_by uuid default auth.uid() references public.profiles (id) on delete set null,
  -- job bookkeeping
  provider text,
  parser_version text,
  schema_version text,
  attempts int not null default 0,
  max_attempts int not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  error_code text,
  error_summary text,          -- short, never document contents
  -- extraction evidence (as the provider returned it, after validation) and the reviewer's working copy
  extraction jsonb,
  extracted_at timestamptz,
  draft jsonb,
  draft_version int not null default 0,
  draft_saved_by uuid references public.profiles (id) on delete set null,
  draft_saved_at timestamptz,
  -- review and result
  reviewer_id uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  confirm_key text unique,
  result jsonb,
  duplicate_of uuid references public.ticket_imports (id) on delete set null,
  replaces_id uuid references public.ticket_imports (id) on delete set null,
  replaced_by uuid references public.ticket_imports (id) on delete set null,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ticket_imports_status_idx on public.ticket_imports (status, next_attempt_at);
create index if not exists ticket_imports_case_idx on public.ticket_imports (case_id);
create index if not exists ticket_imports_customer_idx on public.ticket_imports (customer_id);
create index if not exists ticket_imports_sha_idx on public.ticket_imports (sha256);
-- the same person sending the same file twice (double click, retry) gets the first import back
create unique index if not exists ticket_imports_same_file_once
  on public.ticket_imports (sha256, uploaded_by) where status not in ('rejected', 'failed', 'duplicate');
create trigger t_touch before update on public.ticket_imports for each row execute function private.touch();

-- ============================================================ who may see an import
create or replace function public.can_see_import(p_import uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ticket_imports i
    where i.id = p_import and public.is_team()
      and (public.is_boss()
           or i.uploaded_by = auth.uid()
           or (i.case_id is not null and public.can_see_case(i.case_id))
           or (i.case_id is null and exists (select 1 from public.customers c where c.id = i.customer_id and c.assigned_to = auth.uid())))
  )
$$;

alter table public.ticket_imports enable row level security;
drop policy if exists imports_select on public.ticket_imports;
create policy imports_select on public.ticket_imports for select to authenticated using (public.can_see_import(id));
drop policy if exists imports_insert on public.ticket_imports;
create policy imports_insert on public.ticket_imports for insert to authenticated
  with check (public.is_team() and uploaded_by = auth.uid() and status = 'received' and channel = 'staff'
              and (case_id is null or public.can_see_case(case_id)));
-- no update or delete policy: every change goes through the checked functions below
revoke all on public.ticket_imports from anon;
grant select, insert on public.ticket_imports to authenticated;

-- ============================================================ state machine (every writer, workers included)
create or replace function private.import_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    if old.status in ('confirmed', 'rejected', 'duplicate') and
       (new.draft is distinct from old.draft or new.extraction is distinct from old.extraction or new.result is distinct from old.result) then
      raise exception 'import_not_reviewable: a % import cannot be changed', old.status using errcode = 'P0001';
    end if;
    return new;
  end if;
  if not ((old.status, new.status) in (
      ('received', 'processing'), ('received', 'needs_review'), ('received', 'failed'), ('received', 'rejected'),
      ('processing', 'needs_review'), ('processing', 'failed'), ('processing', 'received'),
      ('failed', 'received'), ('failed', 'needs_review'), ('failed', 'rejected'),
      ('needs_review', 'received'), ('needs_review', 'confirmed'), ('needs_review', 'rejected'), ('needs_review', 'duplicate'))) then
    raise exception 'import_not_reviewable: % → % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  if new.status = 'confirmed' and (new.result is null or new.confirm_key is null or new.reviewer_id is null) then
    raise exception 'import_not_reviewable: confirmation needs a result, a key and a reviewer' using errcode = 'P0001';
  end if;
  -- the extraction is evidence: once written by the worker it is only replaced by a new worker run
  if new.extraction is distinct from old.extraction and new.status not in ('needs_review') then
    raise exception 'import_not_reviewable: extraction can only be written when it moves to review' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_import_transition on public.ticket_imports;
create trigger t_import_transition before update on public.ticket_imports for each row execute function private.import_transition();

-- ============================================================ durable jobs (service role only)
-- Claim work with a lease. A crashed or timed-out worker's lease runs out and the job is claimed again,
-- until max_attempts; then it fails with a clear error and the manual review path stays open.
create or replace function public.claim_ticket_imports(p_worker text, p_limit int default 2, p_lease_seconds int default 180)
returns setof public.ticket_imports language plpgsql security definer set search_path = public as $$
begin
  update public.ticket_imports
     set status = 'failed', locked_by = null, locked_until = null,
         error_code = 'timeout', error_summary = 'Extraction did not finish after ' || attempts || ' attempts. Retry, or enter the details by hand.'
   where status = 'processing' and locked_until < now() and attempts >= max_attempts;
  return query
  update public.ticket_imports t
     set status = 'processing', attempts = t.attempts + 1, locked_by = p_worker,
         locked_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))), error_code = null, error_summary = null
   where t.id in (
     select i.id from public.ticket_imports i
      where ((i.status = 'received' and i.next_attempt_at <= now())
             or (i.status = 'processing' and i.locked_until < now()))
        and i.attempts < i.max_attempts
      order by i.created_at
      for update skip locked
      limit greatest(1, least(p_limit, 10)))
  returning t.*;
end $$;

create or replace function public.finish_ticket_import(
  p_id uuid, p_worker text, p_ok boolean, p_extraction jsonb default null, p_provider text default null,
  p_parser_version text default null, p_schema_version text default null, p_pages int default null,
  p_error_code text default null, p_error_summary text default null, p_retryable boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports;
begin
  select * into i from public.ticket_imports where id = p_id for update;
  if not found or i.status <> 'processing' or i.locked_by is distinct from p_worker then
    return 'lost_lease';   -- someone else owns it now; drop this result
  end if;
  if p_ok then
    update public.ticket_imports
       set status = 'needs_review', extraction = p_extraction, extracted_at = now(),
           -- keep a reviewer's earlier draft (retry or replacement) rather than overwriting their work
           draft = coalesce(draft, p_extraction), draft_version = case when draft is null then draft_version + 1 else draft_version end,
           provider = p_provider, parser_version = p_parser_version, schema_version = p_schema_version, pages = coalesce(p_pages, pages),
           locked_by = null, locked_until = null, error_code = null, error_summary = null
     where id = p_id;
    return 'needs_review';
  end if;
  if p_retryable and i.attempts < i.max_attempts then
    update public.ticket_imports
       set status = 'received', locked_by = null, locked_until = null, pages = coalesce(p_pages, pages),
           next_attempt_at = now() + make_interval(mins => power(2, i.attempts)::int),
           error_code = left(p_error_code, 40), error_summary = left(p_error_summary, 300), provider = coalesce(p_provider, provider)
     where id = p_id;
    return 'retry';
  end if;
  update public.ticket_imports
     set status = 'failed', locked_by = null, locked_until = null, pages = coalesce(p_pages, pages),
         error_code = left(p_error_code, 40), error_summary = left(p_error_summary, 300), provider = coalesce(p_provider, provider)
   where id = p_id;
  return 'failed';
end $$;

-- ============================================================ review functions (team, scoped)
create or replace function private.need_import(p_id uuid) returns public.ticket_imports
language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports;
begin
  if not public.can_see_import(p_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into i from public.ticket_imports where id = p_id for update;
  return i;
end $$;

-- Save the reviewer's working copy. The version stops two people (or two tabs) overwriting each other.
create or replace function public.save_import_draft(p_id uuid, p_expected_version int, p_draft jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports;
begin
  i := private.need_import(p_id);
  if i.status not in ('needs_review', 'failed', 'received') then
    raise exception 'import_not_reviewable: this import is %', i.status using errcode = 'P0001';
  end if;
  if i.draft_version <> p_expected_version then
    raise exception 'import_version_conflict: saved version is %, you had %', i.draft_version, p_expected_version using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_draft) <> 'object' or octet_length(p_draft::text) > 200000 then
    raise exception 'import_not_reviewable: the draft is not valid' using errcode = 'P0001';
  end if;
  -- a failed or still-queued import becomes a manual entry as soon as someone starts typing
  update public.ticket_imports
     set draft = p_draft, draft_version = draft_version + 1, draft_saved_by = auth.uid(), draft_saved_at = now(),
         status = case when status in ('failed', 'received') then 'needs_review' else status end,
         locked_by = null, locked_until = null
   where id = p_id;
  return i.draft_version + 1;
end $$;

create or replace function public.retry_ticket_import(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports;
begin
  i := private.need_import(p_id);
  if i.status not in ('failed', 'needs_review') then raise exception 'import_not_reviewable: this import is %', i.status using errcode = 'P0001'; end if;
  -- the draft stays; only the extraction is run again
  update public.ticket_imports set status = 'received', attempts = 0, next_attempt_at = now(), error_code = null, error_summary = null where id = p_id;
  perform private.log_event('review', 'ticket_import', p_id, i.case_id, i.customer_id, 'Extraction retried: ' || i.file_name);
end $$;

create or replace function public.reject_ticket_import(p_id uuid, p_reason text, p_duplicate_of uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports;
begin
  i := private.need_import(p_id);
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason' using errcode = 'P0001'; end if;
  if p_duplicate_of is not null and not public.can_see_import(p_duplicate_of) then raise exception 'Not allowed' using errcode = '42501'; end if;
  update public.ticket_imports
     set status = case when p_duplicate_of is not null then 'duplicate' else 'rejected' end,
         duplicate_of = p_duplicate_of, reject_reason = trim(p_reason), reviewer_id = auth.uid(), reviewed_at = now(),
         locked_by = null, locked_until = null
   where id = p_id;
  perform private.log_event('reject', 'ticket_import', p_id, i.case_id, i.customer_id, i.file_name || ': ' || trim(p_reason));
end $$;

-- A replacement upload takes over the work: the old import is closed and its draft becomes the new one's starting point.
create or replace function public.replace_ticket_import(p_old uuid, p_new uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.ticket_imports; n public.ticket_imports;
begin
  o := private.need_import(p_old);
  n := private.need_import(p_new);
  if o.status in ('confirmed', 'rejected', 'duplicate') then raise exception 'import_not_reviewable: the old import is %', o.status using errcode = 'P0001'; end if;
  update public.ticket_imports
     set replaces_id = p_old, case_id = coalesce(case_id, o.case_id), customer_id = coalesce(customer_id, o.customer_id),
         booking_line_id = coalesce(booking_line_id, o.booking_line_id),
         draft = coalesce(o.draft, draft), draft_version = draft_version + case when o.draft is not null then 1 else 0 end
   where id = p_new;
  update public.ticket_imports set status = 'rejected', replaced_by = p_new, reject_reason = 'Replaced by a new upload',
         reviewer_id = auth.uid(), reviewed_at = now(), locked_by = null, locked_until = null
   where id = p_old;
end $$;

-- Exact duplicates of a file within what the caller may see (runs as the caller: row-level security applies).
create or replace function public.find_import_by_checksum(p_sha256 text)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'status', i.status, 'file_name', i.file_name, 'created_at', i.created_at)
                            order by i.created_at), '[]'::jsonb)
  from public.ticket_imports i where i.sha256 = p_sha256 and i.status not in ('rejected', 'failed')
$$;

-- Bookings that probably are this one, within cases the caller may open: the same ticket number (strong), or the
-- same airline PNR on the same departure date (PNRs are reused across airlines and years, so never PNR alone).
create or replace function public.probable_booking_duplicates(p_ticket_numbers text[], p_pnr text, p_dates date[])
returns jsonb language sql stable security invoker set search_path = public as $$
  with tn as (select distinct private.ticket_digits(x) d from unnest(coalesce(p_ticket_numbers, '{}'::text[])) x where length(private.ticket_digits(x)) >= 10)
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'case_id', l.case_id, 'max_id', c.max_id, 'summary', l.summary,
                                               'service_date', l.service_date, 'status', l.status, 'reason', m.reason)), '[]'::jsonb)
  from public.booking_lines l
  join public.cases c on c.id = l.case_id
  cross join lateral (
    select case
      when exists (select 1 from jsonb_array_elements(case when jsonb_typeof(l.details -> 'tickets') = 'array' then l.details -> 'tickets' else '[]'::jsonb end) t
                   where private.ticket_digits(t ->> 'number') in (select d from tn)) then 'same ticket number'
      when coalesce(trim(p_pnr), '') <> '' and upper(trim(l.details ->> 'pnr')) = upper(trim(p_pnr))
           and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(l.details -> 'sectors') = 'array' then l.details -> 'sectors' else '[]'::jsonb end) s
                       where nullif(s ->> 'date', '')::date = any(coalesce(p_dates, '{}'::date[]))) then 'same PNR and flight date'
    end as reason) m
  where l.service = 'flight' and m.reason is not null
$$;

-- ============================================================ confirm: one idempotent transaction
-- p: { payer_customer_id, case: {mode:'existing', id, stage?} | {mode:'new', title, stage, destination?},
--      booking: {mode:'new'|'update'|'reissue', line_id?, comparison_reviewed?}, booked_by: 'agency'|'customer',
--      line_status: 'pending'|'confirmed',
--      passengers: [{ index, customer_id? , create?: {first_name, last_name, mobile, gender?, dob?} }],
--      agency_charge?: { amount, confirmed } }
-- The flight data itself comes from the saved draft at p_expected_version, never from this payload.
create or replace function public.confirm_ticket_import(p_id uuid, p_expected_version int, p_key text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  i public.ticket_imports;
  d jsonb; pax jsonb; seg jsonb; m jsonb; cr jsonb;
  payer uuid; cid uuid; mx text; lid uuid; fid uuid; stage text; line_status text; booked_by text;
  people uuid[] := '{}'; who uuid; pax_name text;
  sectors jsonb := '[]'; tickets jsonb := '[]'; problems text[] := '{}';
  existing public.booking_lines; bmode text; n int; k int;
  charge numeric; charge_txt text; trip text; first_date date; cust public.customers;
  pnr text; ext text; seg_from text; seg_to text;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if coalesce(length(p_key), 0) < 8 then raise exception 'import_incomplete: missing confirmation key' using errcode = 'P0001'; end if;
  i := private.need_import(p_id);

  -- repeats (double click, retry, a second tab) get the first result back
  if i.status = 'confirmed' then
    return i.result || jsonb_build_object('already_confirmed', true, 'same_request', i.confirm_key = p_key);
  end if;
  if i.status <> 'needs_review' then raise exception 'import_not_reviewable: this import is %', i.status using errcode = 'P0001'; end if;
  if i.draft_version <> p_expected_version then
    raise exception 'import_version_conflict: saved version is %, you confirmed %', i.draft_version, p_expected_version using errcode = 'P0001';
  end if;
  d := i.draft;
  if d is null then raise exception 'import_incomplete: nothing has been entered or extracted yet' using errcode = 'P0001'; end if;

  -- ---------------------------------------------------------- what the reviewed document must contain
  if jsonb_typeof(d -> 'segments') <> 'array' or jsonb_array_length(d -> 'segments') = 0 then problems := problems || 'at least one flight'::text; end if;
  if jsonb_typeof(d -> 'passengers') <> 'array' or jsonb_array_length(d -> 'passengers') = 0 then problems := problems || 'at least one passenger'::text; end if;
  k := 0;
  for seg in select value from jsonb_array_elements(case when jsonb_typeof(d -> 'segments') = 'array' then d -> 'segments' else '[]'::jsonb end) loop
    k := k + 1;
    seg_from := upper(coalesce(seg #>> '{from,value}', '')); seg_to := upper(coalesce(seg #>> '{to,value}', ''));
    if seg_from !~ '^[A-Z]{3}$' or seg_to !~ '^[A-Z]{3}$' then problems := problems || ('flight ' || k || ' airports'); end if;
    if coalesce(seg #>> '{dep_date,value}', '') !~ '^\d{4}-\d{2}-\d{2}$' then problems := problems || ('flight ' || k || ' departure date'); end if;
    if coalesce(seg #>> '{arr_date,value}', '') <> '' and (seg #>> '{arr_date,value}') !~ '^\d{4}-\d{2}-\d{2}$' then
      problems := problems || ('flight ' || k || ' arrival date'); end if;
  end loop;
  k := 0;
  for pax in select value from jsonb_array_elements(case when jsonb_typeof(d -> 'passengers') = 'array' then d -> 'passengers' else '[]'::jsonb end) loop
    k := k + 1;
    if coalesce(trim(pax #>> '{name_as_issued,value}'), '') = '' then problems := problems || ('passenger ' || k || ' name as issued'); end if;
  end loop;
  if array_length(problems, 1) > 0 then
    raise exception 'import_incomplete: %', array_to_string(problems, ', ') using errcode = 'P0001';
  end if;

  booked_by := coalesce(p ->> 'booked_by', '');
  if booked_by not in ('agency', 'customer') then raise exception 'import_incomplete: choose agency-booked or customer-booked' using errcode = 'P0001'; end if;
  line_status := coalesce(p ->> 'line_status', '');
  if line_status not in ('pending', 'confirmed') then raise exception 'import_incomplete: choose the booking status' using errcode = 'P0001'; end if;
  payer := nullif(p ->> 'payer_customer_id', '')::uuid;

  -- ---------------------------------------------------------- travellers: explicit match or explicit creation, one per passenger
  if jsonb_typeof(p -> 'passengers') <> 'array' or jsonb_array_length(p -> 'passengers') <> jsonb_array_length(d -> 'passengers') then
    raise exception 'import_incomplete: match every passenger (existing person or new)' using errcode = 'P0001';
  end if;
  k := 0;
  for m in select value from jsonb_array_elements(p -> 'passengers') loop
    pax := d -> 'passengers' -> k;
    k := k + 1;
    if nullif(m ->> 'customer_id', '') is not null then
      select * into cust from public.customers where id = (m ->> 'customer_id')::uuid;
      if not found then raise exception 'import_incomplete: passenger % matches someone who no longer exists', k using errcode = 'P0001'; end if;
      if cust.customer_type = 'corporate' then raise exception 'corporate_not_passenger' using errcode = 'P0001'; end if;
      who := cust.id; pax_name := cust.full_name;
    elsif jsonb_typeof(m -> 'create') = 'object' then
      if coalesce(trim(m #>> '{create,first_name}'), '') = '' or coalesce(trim(m #>> '{create,mobile}'), '') = '' then
        raise exception 'import_incomplete: passenger % needs a first name and a mobile to be added', k using errcode = 'P0001';
      end if;
      insert into public.customers (first_name, last_name, mobile, gender, dob, passport_surname, passport_given_name, notes)
      values (trim(m #>> '{create,first_name}'), nullif(trim(coalesce(m #>> '{create,last_name}', '')), ''), trim(m #>> '{create,mobile}'),
              nullif(m #>> '{create,gender}', ''), nullif(m #>> '{create,dob}', '')::date,
              nullif(trim(coalesce(m #>> '{create,passport_surname}', '')), ''), nullif(trim(coalesce(m #>> '{create,passport_given_name}', '')), ''),
              'Added while reviewing ticket import ' || i.file_name)
      returning id, full_name into who, pax_name;
    else
      raise exception 'import_incomplete: passenger % is not matched', k using errcode = 'P0001';
    end if;
    if who = any(people) then raise exception 'import_incomplete: the same person is matched to two passengers' using errcode = 'P0001'; end if;
    people := people || who;
    -- one ticket entry per ticket number; the issued name and its evidence travel with it
    for n in 0 .. greatest(jsonb_array_length(coalesce(pax -> 'tickets', '[]'::jsonb)) - 1, -1) loop
      tickets := tickets || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'customer_id', who, 'passenger', pax_name, 'name_as_issued', trim(pax #>> '{name_as_issued,value}'),
        'number', trim(pax -> 'tickets' -> n #>> '{number,value}'), 'source', 'import', 'import_id', i.id,
        'segments', pax -> 'tickets' -> n -> 'segments', 'pax_type', nullif(pax #>> '{pax_type,value}', ''))));
    end loop;
    if jsonb_array_length(coalesce(pax -> 'tickets', '[]'::jsonb)) = 0 then
      -- a passenger without a ticket number on the document stays a traveller; nothing is invented
      null;
    end if;
  end loop;
  tickets := (select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(tickets) t where coalesce(t ->> 'number', '') <> '');

  -- ---------------------------------------------------------- sectors from the reviewed segments (explicit dates only)
  for seg in select value from jsonb_array_elements(d -> 'segments') loop
    seg_from := upper(seg #>> '{from,value}'); seg_to := upper(seg #>> '{to,value}');
    sectors := sectors || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'from', seg_from, 'to', seg_to,
      'date', seg #>> '{dep_date,value}', 'dep', nullif(seg #>> '{dep_time,value}', ''),
      'arr_date', nullif(seg #>> '{arr_date,value}', ''), 'arr', nullif(seg #>> '{arr_time,value}', ''),
      'airline', nullif(seg #>> '{airline,value}', ''), 'flight_no', nullif(upper(seg #>> '{flight_no,value}'), ''),
      'cabin', nullif(seg #>> '{cabin,value}', ''), 'baggage', nullif(seg #>> '{baggage,value}', ''),
      'dep_tz', (select extra ->> 'tz' from public.lookups where kind = 'airport' and value = seg_from),
      'arr_tz', (select extra ->> 'tz' from public.lookups where kind = 'airport' and value = seg_to),
      'segment_key', seg ->> 'key', 'source', 'import', 'import_id', i.id)));
  end loop;
  n := jsonb_array_length(sectors);
  trip := case when n = 1 then 'one-way'
               when n = 2 and sectors -> 1 ->> 'from' = sectors -> 0 ->> 'to' and sectors -> 1 ->> 'to' = sectors -> 0 ->> 'from' then 'return'
               else 'multi-city' end;
  first_date := (sectors -> 0 ->> 'date')::date;
  pnr := nullif(trim(coalesce((select string_agg(distinct upper(trim(r #>> '{value}')), ' ') from jsonb_array_elements(coalesce(d -> 'airline_pnrs', '[]'::jsonb)) r where coalesce(trim(r #>> '{value}'), '') <> ''), '')), '');

  -- ---------------------------------------------------------- the case (existing MAX ID or a new one)
  cr := p -> 'case';
  if cr ->> 'mode' = 'existing' then
    cid := nullif(cr ->> 'id', '')::uuid;
    if cid is null or not public.can_see_case(cid) then raise exception 'Not allowed: you cannot add to that case' using errcode = '42501'; end if;
    perform 1 from public.cases where id = cid for update;
    -- a stage change only when the reviewer chose one explicitly
    stage := nullif(cr ->> 'stage', '');
    if stage is not null then
      if stage not in ('enquiry', 'quoted', 'confirmed', 'booked') then raise exception 'import_incomplete: unknown stage' using errcode = 'P0001'; end if;
      update public.cases set status = stage where id = cid and status not in ('completed', 'cancelled');
    end if;
  elsif cr ->> 'mode' = 'new' then
    if payer is null then raise exception 'import_incomplete: choose who pays (the customer on the MAX ID)' using errcode = 'P0001'; end if;
    stage := nullif(cr ->> 'stage', '');
    if stage is null or stage not in ('enquiry', 'quoted', 'confirmed', 'booked') then
      raise exception 'import_incomplete: choose the stage for the new MAX ID' using errcode = 'P0001';
    end if;
    insert into public.cases (customer_id, title, travel_start, destination, status, notes)
    values (payer, coalesce(nullif(trim(coalesce(cr ->> 'title', '')), ''), 'Flight ' || (sectors -> 0 ->> 'from') || ' → ' || (sectors -> (n - 1) ->> 'to')),
            first_date, nullif(trim(coalesce(cr ->> 'destination', '')), ''), stage,
            'Created from a reviewed ticket (' || i.file_name || '). No earlier enquiry or quotation was recorded.')
    returning id into cid;
    insert into public.case_requests (request_key, case_id) values ('import:' || i.id::text, cid);
  else
    raise exception 'import_incomplete: choose an existing MAX ID or a new one' using errcode = 'P0001';
  end if;
  select max_id into mx from public.cases where id = cid;
  insert into public.case_travellers (case_id, customer_id) select cid, x from unnest(people) x on conflict do nothing;

  -- ---------------------------------------------------------- the booking (new, update of an existing one, or a reissue)
  bmode := coalesce(p #>> '{booking,mode}', '');
  if bmode = 'new' then
    -- only a separately confirmed agency charge is billed on a customer-booked ticket; nothing else becomes money
    charge := null;
    if booked_by = 'customer' and coalesce((p #>> '{agency_charge,confirmed}')::boolean, false) then
      charge_txt := regexp_replace(coalesce(p #>> '{agency_charge,amount}', ''), '[,\s₹]', '', 'g');
      if charge_txt !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'invalid_amount: "%"', left(charge_txt, 20) using errcode = 'P0001'; end if;
      charge := charge_txt::numeric;
    end if;
    insert into public.booking_lines (case_id, service, status, traveller_ids, supplier_cost, selling_price, pricing_state, visible_to_client,
                                      details, notes, import_id)
    values (cid, 'flight', line_status, people, 0, coalesce(charge, 0),
            case when charge is not null then 'entered' else 'not_entered' end, false,
            jsonb_strip_nulls(jsonb_build_object(
              'trip_type', trip, 'sectors', sectors, 'tickets', tickets, 'pnr', pnr,
              'supplier_ref', nullif(trim(coalesce((select string_agg(distinct trim(r #>> '{value}'), ' ') from jsonb_array_elements(coalesce(d -> 'supplier_refs', '[]'::jsonb)) r where coalesce(trim(r #>> '{value}'), '') <> ''), '')), ''),
              'booked_by', booked_by, 'agency_charge_confirmed', case when charge is not null then true end,
              'document_amounts', d -> 'amounts', 'import_id', i.id)),
            case when booked_by = 'customer' then 'Booked by the customer. Imported for servicing only.' else 'Imported from a reviewed ticket.' end
              || ' Prices were not taken from the document.',
            i.id)
    returning id into lid;
  elsif bmode in ('update', 'reissue') then
    select * into existing from public.booking_lines where id = nullif(p #>> '{booking,line_id}', '')::uuid for update;
    if not found or existing.case_id <> cid or existing.service <> 'flight' then
      raise exception 'import_incomplete: pick a flight booking on this MAX ID to update' using errcode = 'P0001';
    end if;
    -- changing a booking that already has tickets or flights needs the field-by-field comparison to have been reviewed
    if (jsonb_array_length(coalesce(existing.details -> 'tickets', '[]'::jsonb)) > 0 or jsonb_array_length(coalesce(existing.details -> 'sectors', '[]'::jsonb)) > 0)
       and not coalesce((p #>> '{booking,comparison_reviewed}')::boolean, false) then
      raise exception 'comparison_required' using errcode = 'P0001';
    end if;
    -- previous tickets and sectors move to history through the booking trigger; money is left exactly as it was (no new sale)
    update public.booking_lines
       set traveller_ids = array(select distinct x from unnest(existing.traveller_ids || people) x),
           status = case when existing.status = 'cancelled' then existing.status else line_status end,
           details = existing.details || jsonb_strip_nulls(jsonb_build_object(
             'trip_type', trip, 'sectors', sectors,
             'tickets', case when bmode = 'reissue' then tickets
                             else (select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(coalesce(existing.details -> 'tickets', '[]'::jsonb)) t
                                    where private.ticket_digits(t ->> 'number') not in (select private.ticket_digits(x ->> 'number') from jsonb_array_elements(tickets) x)) || tickets end,
             'pnr', coalesce(pnr, existing.details ->> 'pnr'), 'document_amounts', d -> 'amounts', 'import_id', i.id,
             'reissued_at', case when bmode = 'reissue' then to_jsonb(now()) end)),
           import_id = i.id
     where id = existing.id;
    lid := existing.id;
  else
    raise exception 'import_incomplete: choose new booking, update or reissue' using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------- the ticket file joins the case, private until the boss publishes it
  ext := case i.mime when 'application/pdf' then 'pdf' when 'image/png' then 'png' else 'jpg' end;
  insert into public.files (case_id, booking_line_id, storage_path, file_name, original_name, mime, size, kind, visible_to_client, import_id, uploaded_by)
  values (cid, lid, i.storage_path,
          mx || '_Ticket_' || (sectors -> 0 ->> 'from') || '-' || (sectors -> (n - 1) ->> 'to') || '_' || to_char(first_date, 'DD-MM-YYYY')
             || case when bmode = 'reissue' then '_reissue' else '' end || '_' || left(i.id::text, 6) || '.' || ext,
          i.file_name, i.mime, i.size, 'ticket', false, i.id, i.uploaded_by)
  returning id into fid;

  update public.ticket_imports
     set status = 'confirmed', confirm_key = p_key, reviewer_id = auth.uid(), reviewed_at = now(),
         case_id = cid, customer_id = coalesce(customer_id, payer),
         result = jsonb_build_object('case_id', cid, 'max_id', mx, 'booking_line_id', lid, 'file_id', fid, 'traveller_ids', to_jsonb(people), 'mode', bmode)
   where id = p_id;
  perform private.log_event('confirm', 'ticket_import', p_id, cid, payer,
    'Ticket ' || i.file_name || ' reviewed and ' || case bmode when 'new' then 'added as a new booking' when 'reissue' then 'recorded as a reissue' else 'used to update a booking' end
    || ' (' || booked_by || '-booked)');
  return jsonb_build_object('case_id', cid, 'max_id', mx, 'booking_line_id', lid, 'file_id', fid, 'already_confirmed', false);
end $$;

-- ============================================================ publication guards (INSERT and UPDATE)
alter table public.files add column if not exists import_id uuid references public.ticket_imports (id) on delete set null;
alter table public.files add column if not exists replaces_id uuid references public.files (id) on delete set null;
alter table public.booking_lines add column if not exists import_id uuid references public.ticket_imports (id) on delete set null;

-- Imported and replacement material is inserted private unless the boss inserts it. (Updates are already boss-only.)
create or replace function private.guard_client_view_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_boss() then return new; end if;
  if new.visible_to_client and (new.import_id is not null or (tg_table_name = 'files' and to_jsonb(new) ->> 'replaces_id' is not null)) then
    new.visible_to_client := false;
  end if;
  return new;
end $$;
drop trigger if exists t_guard_client_view_insert on public.files;
create trigger t_guard_client_view_insert before insert on public.files for each row execute function private.guard_client_view_insert();
drop trigger if exists t_guard_client_view_insert on public.booking_lines;
create trigger t_guard_client_view_insert before insert on public.booking_lines for each row execute function private.guard_client_view_insert();

-- A replacement takes over from the approved file only when it is published; until then the approved one stays.
create or replace function private.supersede_on_publish() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.visible_to_client and not old.visible_to_client and new.replaces_id is not null then
    update public.files set superseded_at = now(), superseded_by = new.id, visible_to_client = false
     where id = new.replaces_id and superseded_at is null;
  end if;
  return null;
end $$;
drop trigger if exists t_supersede_on_publish on public.files;
create trigger t_supersede_on_publish after update of visible_to_client on public.files for each row execute function private.supersede_on_publish();

-- Share links: never for an unpublished import or an unreviewed replacement (unless the boss makes it).
create or replace function private.guard_share_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare f public.files;
begin
  select * into f from public.files where id = new.file_id;
  if not found then raise exception 'File not found' using errcode = 'P0001'; end if;
  if auth.uid() is not null and not public.is_boss() and not f.visible_to_client and (f.import_id is not null or f.replaces_id is not null) then
    raise exception 'unpublished_file: this file is waiting for the boss to publish it' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_share_link on public.share_links;
create trigger t_guard_share_link before insert on public.share_links for each row execute function private.guard_share_link();

-- Private preview of an import's source: reviewers who may see the import, and the person who uploaded it.
create or replace function public.import_source_access(p_import uuid) returns table (storage_path text, file_name text, mime text)
language sql stable security definer set search_path = public as $$
  select i.storage_path, i.file_name, i.mime from public.ticket_imports i
  where i.id = p_import and (public.can_see_import(i.id) or (i.uploaded_by = auth.uid() and public.my_role() is not null))
$$;

-- Portal: a client sees only their own submissions, with a plain status and nothing extracted.
create or replace function public.portal_my_imports() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'created_at', i.created_at,
           'status', case i.status when 'confirmed' then 'added' when 'rejected' then 'not used' when 'duplicate' then 'already received' else 'with the office' end)
         order by i.created_at desc), '[]'::jsonb)
  from public.ticket_imports i
  where i.uploaded_by = auth.uid() and i.channel = 'portal' and public.my_role() = 'client'
$$;

-- ============================================================ A6 readiness: required work vs loose ends vs optional follow-ups
create or replace function public.case_readiness(p_case uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.cases; m record; n int; blockers jsonb := '[]'; loose jsonb := '[]'; optional jsonb := '[]'; names text;
begin
  if not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cases where id = p_case;

  select count(*) into n from public.tasks where case_id = p_case and status <> 'done' and blocking;
  if n > 0 then blockers := blockers || jsonb_build_object('code', 'blocking_tasks', 'count', n, 'text', n || ' required task' || case when n = 1 then ' is' else 's are' end || ' still open'); end if;

  select count(*) into n from public.ticket_imports where case_id = p_case and status in ('received', 'processing', 'needs_review', 'failed');
  if n > 0 then blockers := blockers || jsonb_build_object('code', 'pending_imports', 'count', n, 'text', n || ' ticket import' || case when n = 1 then ' is' else 's are' end || ' waiting for review'); end if;

  if c.is_international then
    select count(*), string_agg(cu.full_name, ', ') into n, names
    from public.case_travellers t join public.customers cu on cu.id = t.customer_id
    where t.case_id = p_case and (cu.passport_hash is null or cu.passport_expiry is null
                                  or cu.passport_expiry < coalesce(c.travel_end, c.travel_start, (now() at time zone 'Asia/Kolkata')::date));
    if n > 0 then blockers := blockers || jsonb_build_object('code', 'missing_documents', 'count', n,
                   'text', 'passport number or a valid expiry missing for ' || names); end if;
  end if;

  select count(*) into n from public.booking_lines where case_id = p_case and status = 'pending';
  if n > 0 then loose := loose || jsonb_build_object('code', 'pending_lines', 'count', n, 'text', n || ' booking' || case when n = 1 then ' is' else 's are' end || ' still Pending'); end if;
  select count(*) into n from public.booking_lines where case_id = p_case and status <> 'cancelled' and pricing_state = 'not_entered';
  if n > 0 then loose := loose || jsonb_build_object('code', 'not_priced', 'count', n, 'text', n || ' booking' || case when n = 1 then ' has' else 's have' end || ' no prices entered'); end if;
  select * into m from public.v_case_money where case_id = p_case;
  if coalesce(m.due, 0) > 0 then loose := loose || jsonb_build_object('code', 'client_due', 'count', 1, 'amount', m.due, 'text', 'the client still owes ₹' || to_char(m.due, 'FM99,99,99,990.00')); end if;
  if coalesce(m.due, 0) < 0 then loose := loose || jsonb_build_object('code', 'client_credit', 'count', 1, 'amount', -m.due, 'text', 'the client has a credit of ₹' || to_char(-m.due, 'FM99,99,99,990.00') || ' to refund or adjust'); end if;
  if coalesce(m.supplier_due, 0) > 0 then loose := loose || jsonb_build_object('code', 'supplier_due', 'count', 1, 'amount', m.supplier_due, 'text', '₹' || to_char(m.supplier_due, 'FM99,99,99,990.00') || ' is still to be paid to suppliers'); end if;

  select count(*) into n from public.tasks where case_id = p_case and status <> 'done' and not blocking;
  if n > 0 then optional := optional || jsonb_build_object('code', 'follow_ups', 'count', n, 'text', n || ' optional follow-up' || case when n = 1 then '' else 's' end); end if;

  return jsonb_build_object('blockers', blockers, 'loose_ends', loose, 'optional', optional);
end $$;

-- the old helper stays (other screens use it) and now reports from the same rules
create or replace function public.case_open_items(p_case uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'pending_lines', (select count(*) from public.booking_lines l where l.case_id = p_case and l.status = 'pending'),
    'client_due', greatest(coalesce(m.due, 0), 0),
    'client_credit', greatest(-coalesce(m.due, 0), 0),
    'supplier_due', greatest(coalesce(m.supplier_due, 0), 0))
  from (select 1) x left join public.v_case_money m on m.case_id = p_case
$$;

-- Completing a case: clean → done; loose ends → needs a reason; required work → only the boss, with a reason. Always recorded.
create or replace function public.complete_case(p_case uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; open_items boolean; has_blockers boolean; stamp text; c public.cases;
begin
  if not public.can_see_case(p_case) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cases where id = p_case for update;
  if c.status = 'completed' then return jsonb_build_object('completed', true, 'overridden', false, 'readiness', public.case_readiness(p_case)); end if;
  if c.status = 'cancelled' then raise exception 'A cancelled case cannot be completed' using errcode = 'P0001'; end if;
  r := public.case_readiness(p_case);
  has_blockers := jsonb_array_length(r -> 'blockers') > 0;
  open_items := has_blockers or jsonb_array_length(r -> 'loose_ends') > 0;
  if open_items then
    if coalesce(trim(p_reason), '') = '' then
      return jsonb_build_object('completed', false, 'overridden', false, 'readiness', r);
    end if;
    if has_blockers and not public.is_boss() then raise exception 'override_not_permitted' using errcode = '42501'; end if;
  end if;
  perform set_config('safar.case_completion', 'on', true);
  stamp := to_char(now() at time zone 'Asia/Kolkata', 'DD-MM-YYYY');
  update public.cases
     set status = 'completed',
         notes = case when open_items then coalesce(notes || E'\n', '') || '[' || stamp || '] Completed with open items ('
                   || (select string_agg(x ->> 'text', '; ') from jsonb_array_elements((r -> 'blockers') || (r -> 'loose_ends')) x)
                   || '). Reason: ' || trim(p_reason) else notes end
   where id = p_case;
  perform set_config('safar.case_completion', '', true);
  if open_items then
    perform private.log_event('override', 'case', p_case, p_case, c.customer_id,
      c.max_id || ' completed with open items. Reason: ' || trim(p_reason), jsonb_build_object('readiness', r, 'reason', trim(p_reason)));
  end if;
  return jsonb_build_object('completed', true, 'overridden', open_items, 'readiness', r);
end $$;

-- every write path: a case only becomes Completed through complete_case()
create or replace function private.guard_case_completion() returns trigger
language plpgsql as $$
begin
  if new.status = 'completed' and old.status <> 'completed' and auth.uid() is not null
     and coalesce(current_setting('safar.case_completion', true), '') <> 'on' then
    raise exception 'case_completion_direct' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists t_guard_case_completion on public.cases;
create trigger t_guard_case_completion before update of status on public.cases for each row execute function private.guard_case_completion();

-- ============================================================ B work summary for case cards
-- Counts cover every task on a case the viewer may open; a task's title is shown only to people who may see that task.
create or replace function public.case_work_summary(p_cases uuid[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'case_id', c.id,
    'state', case when c.work_state in ('waiting_customer', 'waiting_supplier') then c.work_state
                  when c.work_state <> 'new' and coalesce(t.blocking, 0) = 0 and coalesce(t.overdue, 0) = 0 and coalesce(im.pending, 0) = 0 then 'up_to_date'
                  else c.work_state end,
    'stored_state', c.work_state, 'waiting_reason', c.waiting_reason, 'waiting_follow_up_at', c.waiting_follow_up_at,
    'owner', (select full_name from public.profiles where id = c.assigned_to),
    'open_tasks', coalesce(t.open, 0), 'overdue_tasks', coalesce(t.overdue, 0), 'blocking_tasks', coalesce(t.blocking, 0),
    'pending_imports', coalesce(im.pending, 0),
    'next_action', nx.next,
    'blocker', case when coalesce(t.overdue, 0) > 0 then t.overdue || ' overdue task' || case when t.overdue = 1 then '' else 's' end
                    when coalesce(im.pending, 0) > 0 then 'Ticket import waiting for review'
                    when coalesce(t.blocking, 0) > 0 then 'Required task open'
                    when c.work_state like 'waiting%' then c.waiting_reason end)), '[]'::jsonb)
  from public.cases c
  left join lateral (
    select count(*) filter (where x.status <> 'done') open,
           count(*) filter (where x.status <> 'done' and x.due_at < now()) overdue,
           count(*) filter (where x.status <> 'done' and x.blocking) blocking
    from public.tasks x where x.case_id = c.id) t on true
  left join lateral (select count(*) pending from public.ticket_imports i where i.case_id = c.id and i.status in ('received', 'processing', 'needs_review', 'failed')) im on true
  left join lateral (
    select jsonb_build_object('due_at', x.due_at,
             'title', case when public.is_boss() or x.assigned_to = auth.uid() or x.created_by = auth.uid() then x.title
                           else 'Task for ' || coalesce((select full_name from public.profiles where id = x.assigned_to), 'someone') end) next
    from public.tasks x where x.case_id = c.id and x.status <> 'done'
    order by x.due_at nulls last, x.created_at limit 1) nx on true
  where c.id = any(p_cases) and public.can_see_case(c.id)
$$;

-- ============================================================ grants
revoke execute on function public.claim_ticket_imports(text, int, int) from public, anon, authenticated;
revoke execute on function public.finish_ticket_import(uuid, text, boolean, jsonb, text, text, text, int, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_ticket_imports(text, int, int) to service_role;
grant execute on function public.finish_ticket_import(uuid, text, boolean, jsonb, text, text, text, int, text, text, boolean) to service_role;
do $$ declare f text; begin
  foreach f in array array[
    'public.can_see_import(uuid)', 'public.save_import_draft(uuid, int, jsonb)', 'public.retry_ticket_import(uuid)',
    'public.reject_ticket_import(uuid, text, uuid)', 'public.replace_ticket_import(uuid, uuid)', 'public.find_import_by_checksum(text)',
    'public.probable_booking_duplicates(text[], text, date[])', 'public.confirm_ticket_import(uuid, int, text, jsonb)',
    'public.import_source_access(uuid)', 'public.portal_my_imports()', 'public.case_readiness(uuid)', 'public.complete_case(uuid, text)',
    'public.case_work_summary(uuid[])'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
-- probable_booking_duplicates runs as the caller and uses this pure helper
grant execute on function private.ticket_digits(text) to authenticated;
