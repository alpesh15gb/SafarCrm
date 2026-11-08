-- Safar CRM: core tables
-- All money in INR (numeric(12,2)); all dates are calendar dates in IST.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron;

alter database postgres set timezone to 'Asia/Kolkata';
set timezone to 'Asia/Kolkata';

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Encryption key for Aadhaar / PAN / passport numbers. Never exposed to API roles.
create table private.app_secret (
  id int primary key default 1 check (id = 1),
  enc_key text not null
);
insert into private.app_secret (enc_key) values (encode(extensions.gen_random_bytes(32), 'hex'));

-- ---------------------------------------------------------------- users
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('boss', 'staff', 'client')),
  full_name text not null default '',
  email text,
  phone text,
  active boolean not null default true,
  can_see_profit boolean not null default false,
  can_see_all_cases boolean not null default false,
  customer_id uuid,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- settings
create table public.settings (
  id int primary key default 1 check (id = 1),
  agency_name text not null default 'Safar Travels',
  agency_phone text,
  agency_email text,
  agency_address text,
  app_url text,
  auto_reminders jsonb not null default '{"passport_visa":true,"trip_upcoming":true,"client_due":true,"supplier_due":true,"hotel_cancel":true,"no_insurance":true,"birthday":true}',
  portal_defaults jsonb not null default '{"show_case":true,"show_bookings":true,"show_files":true,"show_payments":true,"show_line_prices":false}',
  portal_hide_until_confirmed boolean not null default false,
  portal_allow_uploads boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.settings default values;

create table public.lookups (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('airline','hotel_chain','insurer','city','airport','lead_source','document_type')),
  value text not null,
  extra jsonb not null default '{}',
  sort int not null default 100,
  active boolean not null default true,
  unique (kind, value)
);

-- ---------------------------------------------------------------- customers
create sequence public.customer_code_seq start 1;

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default ('C-' || lpad(nextval('public.customer_code_seq')::text, 4, '0')),
  customer_type text not null default 'individual' check (customer_type in ('individual','family','corporate')),
  family_id uuid references public.families (id) on delete set null,
  company_id uuid references public.customers (id) on delete set null,
  -- basic
  title text, first_name text not null, middle_name text, last_name text,
  full_name text generated always as (trim(regexp_replace(coalesce(first_name,'') || ' ' || coalesce(middle_name,'') || ' ' || coalesce(last_name,''), '\s+', ' ', 'g'))) stored,
  gender text, dob date, nationality text default 'Indian', marital_status text, anniversary date, photo_path text,
  -- contact
  mobile text not null, alt_mobile text, whatsapp text, email text,
  address1 text, address2 text, city text, state text, pin text, country text default 'India', language text,
  -- Indian IDs (encrypted)
  aadhaar_enc bytea, aadhaar_last4 text, aadhaar_hash text,
  pan_enc bytea, pan_hash text,
  voter_id text, dl_number text, dl_expiry date,
  -- passport
  passport_enc bytea, passport_hash text,
  passport_surname text, passport_given_name text, passport_issue date, passport_expiry date,
  passport_place text, passport_country text default 'India', passport_ecr text, passport_file_no text,
  -- repeating groups
  visas jsonb not null default '[]',      -- [{country,type,number,issue,expiry,entry}]
  other_ids jsonb not null default '[]',  -- [{kind,number,expiry}]
  loyalty jsonb not null default '[]',    -- [{kind:'airline'|'hotel'|'other',name,programme,number,tier}]
  -- rail & bus
  irctc_id text, senior_citizen boolean default false, berth_pref text, bus_pref text,
  -- preferences
  seat_pref text, meal_pref text, special_assistance text, preferred_airlines text, hotel_star text, room_pref text, travel_notes text,
  -- emergency
  emergency_name text, emergency_relation text, emergency_mobile text,
  -- corporate
  company_name text, gstin text, billing_address text, designation text, employee_id text,
  -- crm
  lead_source text, referred_by text, assigned_to uuid references public.profiles (id) on delete set null,
  tags text[] not null default '{}', notes text,
  -- consent
  consent_docs boolean not null default false, consent_date date, whatsapp_optin boolean not null default false,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.customers (mobile);
create index on public.customers (aadhaar_hash);
create index on public.customers (passport_hash);
create index on public.customers (family_id);
create index on public.customers using gin (to_tsvector('simple', full_name));

alter table public.profiles add constraint profiles_customer_fk foreign key (customer_id) references public.customers (id) on delete set null;

create table public.customer_documents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  doc_type text not null,
  number_enc bytea,
  number_last4 text,
  expiry date,
  note text,
  storage_path text,
  file_name text,
  mime text,
  size int,
  status text not null default 'ok' check (status in ('ok','pending_review')),
  uploaded_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.customer_documents (customer_id);

-- ---------------------------------------------------------------- suppliers
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  supplier_type text not null default 'other',
  services text[] not null default '{}',
  status text not null default 'active' check (status in ('active','inactive')),
  contact_person text, mobile text, whatsapp text, email text, address text, city text,
  gstin text, pan text, bank_account_name text, bank_account_no text, ifsc text, bank_name text, bank_branch text, upi text,
  terms text not null default 'prepaid' check (terms in ('prepaid','credit')),
  credit_days int not null default 0,
  credit_limit numeric(12,2),
  default_commission numeric(6,2) not null default 0,
  portal_url text, portal_login text,
  notes text,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- cases
create sequence public.max_seq start 1001 minvalue 1;

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  max_no bigint unique not null default nextval('public.max_seq'),
  max_id text generated always as ('MAX-' || max_no::text) stored,
  customer_id uuid not null references public.customers (id) on delete restrict,
  title text not null,
  travel_start date,
  travel_end date,
  destination text,
  lead_source text,
  assigned_to uuid references public.profiles (id) on delete set null,
  status text not null default 'enquiry' check (status in ('enquiry','quoted','confirmed','booked','completed','cancelled')),
  cancel_reason text,
  notes text,
  tags text[] not null default '{}',
  client_view jsonb,
  is_international boolean not null default false,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cancel_needs_reason check (status <> 'cancelled' or coalesce(trim(cancel_reason), '') <> '')
);
create index on public.cases (customer_id);
create index on public.cases (assigned_to);
create index on public.cases (travel_start);

create table public.case_travellers (
  case_id uuid not null references public.cases (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  primary key (case_id, customer_id)
);

-- ---------------------------------------------------------------- bookings
create table public.booking_lines (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  service text not null check (service in ('flight','hotel','insurance','rail','bus','other')),
  supplier_id uuid references public.suppliers (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  reference text,
  traveller_ids uuid[] not null default '{}',
  supplier_cost numeric(12,2) not null default 0,
  selling_price numeric(12,2) not null default 0,
  commission_type text not null default 'amount' check (commission_type in ('amount','percent')),
  commission_value numeric(12,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,  -- maintained by trigger
  gst numeric(12,2) not null default 0,
  payment_due_date date,
  supplier_due_date date,
  notes text,
  details jsonb not null default '{}',
  visible_to_client boolean not null default true,
  service_date date,      -- maintained by trigger
  summary text,           -- maintained by trigger
  search_refs text,       -- maintained by trigger (PNR, ticket, policy numbers)
  cancelled_at timestamptz,
  cancel_reason text,
  cancellation_charge numeric(12,2) not null default 0,
  refund_to_client numeric(12,2) not null default 0,
  refund_from_supplier numeric(12,2) not null default 0,
  sort int not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.booking_lines (case_id);
create index on public.booking_lines (supplier_id);
create index on public.booking_lines (service_date);
create index on public.booking_lines using gin (search_refs extensions.gin_trgm_ops);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  name text not null,
  amount numeric(12,2) not null,
  exp_date date not null default current_date,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- direction 'in' = from client (case_id required); 'out' = to supplier (supplier_id required, cases via allocations)
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('in','out')),
  case_id uuid references public.cases (id) on delete cascade,
  supplier_id uuid references public.suppliers (id) on delete restrict,
  pay_date date not null default current_date,
  amount numeric(12,2) not null check (amount <> 0),
  mode text not null check (mode in ('cash','upi','bank','card','cheque')),
  reference text,
  received_by uuid references public.profiles (id) on delete set null,
  notes text,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint pay_in_has_case check (direction <> 'in' or case_id is not null),
  constraint pay_out_has_supplier check (direction <> 'out' or supplier_id is not null)
);
create index on public.payments (case_id);
create index on public.payments (supplier_id);

create table public.payment_allocations (
  payment_id uuid not null references public.payments (id) on delete cascade,
  case_id uuid not null references public.cases (id) on delete cascade,
  amount numeric(12,2) not null,
  primary key (payment_id, case_id)
);

-- ---------------------------------------------------------------- files
create table public.files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.cases (id) on delete cascade,
  booking_line_id uuid references public.booking_lines (id) on delete set null,
  supplier_id uuid references public.suppliers (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  original_name text,
  mime text,
  size int,
  kind text not null default 'other' check (kind in ('ticket','voucher','policy','document','agreement','rate_sheet','other')),
  visible_to_client boolean not null default false,
  superseded_by uuid references public.files (id) on delete set null,
  superseded_at timestamptz,
  source_document_id uuid references public.customer_documents (id) on delete set null,
  uploaded_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint file_has_owner check (case_id is not null or supplier_id is not null)
);
create index on public.files (case_id);
create index on public.files (booking_line_id);

create table public.share_links (
  token text primary key default encode(extensions.gen_random_bytes(16), 'hex'),
  file_id uuid not null references public.files (id) on delete cascade,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.cases (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete cascade,
  title text not null,
  assigned_to uuid references public.profiles (id) on delete set null,
  due_at timestamptz,
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  alert text not null default 'due' check (alert in ('none','due','15m','1h','1d')),
  alert_at timestamptz,
  alerted_at timestamptz,
  notes text,
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  auto_key text unique,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.tasks (assigned_to, status);
create index on public.tasks (case_id);
create index on public.tasks (alert_at) where alerted_at is null;

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  author uuid default auth.uid() references public.profiles (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text,
  link text,
  task_id uuid references public.tasks (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, read_at);

-- ---------------------------------------------------------------- activity
create table public.activity_log (
  id bigint generated always as identity primary key,
  actor uuid,
  actor_name text,
  action text not null,
  entity text not null,
  entity_id uuid,
  case_id uuid,
  customer_id uuid,
  supplier_id uuid,
  summary text,
  changes jsonb,
  created_at timestamptz not null default now()
);
create index on public.activity_log (case_id, created_at desc);
create index on public.activity_log (customer_id, created_at desc);
create index on public.activity_log (supplier_id, created_at desc);
