-- Safar CRM: roles, helper functions, encryption and row-level security

-- ---------------------------------------------------------------- role helpers
-- A user with two-step login switched on only counts as logged in after the second step (aal2).
create or replace function private.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active and private.session_ok()
$$;

create or replace function public.is_boss() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'boss' from public.profiles where id = auth.uid() and active and private.session_ok()), false)
$$;

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('boss','staff') from public.profiles where id = auth.uid() and active and private.session_ok()), false)
$$;

create or replace function public.can_see_profit() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'boss' or (role = 'staff' and can_see_profit)
                   from public.profiles where id = auth.uid() and active and private.session_ok()), false)
$$;

create or replace function public.my_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select customer_id from public.profiles where id = auth.uid() and active and private.session_ok() and role = 'client'
$$;

create or replace function public.can_see_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p, public.cases c
    where p.id = auth.uid() and p.active and private.session_ok() and c.id = p_case
      and (p.role = 'boss'
           or (p.role = 'staff' and (p.can_see_all_cases or c.assigned_to = p.id or c.created_by = p.id)))
  )
$$;

-- Row-based variant used by the cases policy itself (works for INSERT ... RETURNING).
create or replace function public.can_see_case_row(p_assigned uuid, p_created uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and private.session_ok()
      and (p.role = 'boss' or (p.role = 'staff' and (p.can_see_all_cases or p_assigned = p.id or p_created = p.id)))
  )
$$;

create or replace function public.first_boss() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where role = 'boss' and active order by created_at limit 1
$$;

-- ---------------------------------------------------------------- encryption
create or replace function private.enc(p text) returns bytea
language sql stable security definer set search_path = public, extensions as $$
  select case when coalesce(trim(p), '') = '' then null
              else extensions.pgp_sym_encrypt(trim(p), (select enc_key from private.app_secret)) end
$$;

create or replace function private.dec(p bytea) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when p is null then null
              else extensions.pgp_sym_decrypt(p, (select enc_key from private.app_secret)) end
$$;

create or replace function private.hash_id(p text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when coalesce(trim(p), '') = '' then null
              else encode(extensions.hmac(upper(regexp_replace(p, '\s', '', 'g')), (select enc_key from private.app_secret), 'sha256'), 'hex') end
$$;

-- Set encrypted ID numbers on a customer. NULL leaves a value unchanged, '' clears it.
create or replace function public.set_customer_ids(p_customer uuid, p_aadhaar text default null, p_pan text default null, p_passport text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_team()) then raise exception 'Not allowed'; end if;
  if p_aadhaar is not null then
    p_aadhaar := regexp_replace(p_aadhaar, '\D', '', 'g');
    update public.customers set aadhaar_enc = private.enc(p_aadhaar),
      aadhaar_last4 = nullif(right(p_aadhaar, 4), ''), aadhaar_hash = private.hash_id(p_aadhaar)
      where id = p_customer;
  end if;
  if p_pan is not null then
    update public.customers set pan_enc = private.enc(upper(p_pan)), pan_hash = private.hash_id(p_pan) where id = p_customer;
  end if;
  if p_passport is not null then
    update public.customers set passport_enc = private.enc(upper(p_passport)), passport_hash = private.hash_id(p_passport) where id = p_customer;
  end if;
end $$;

-- Read ID numbers for staff: PAN and passport in clear, Aadhaar masked.
create or replace function public.get_customer_ids(p_customer uuid)
returns table (aadhaar_masked text, pan text, passport text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_team() then raise exception 'Not allowed'; end if;
  return query
    select case when c.aadhaar_last4 is null then null else 'XXXX XXXX ' || c.aadhaar_last4 end,
           private.dec(c.pan_enc), private.dec(c.passport_enc)
    from public.customers c where c.id = p_customer;
end $$;

-- Only the boss can reveal Aadhaar; every reveal is logged.
create or replace function public.reveal_aadhaar(p_customer uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.is_boss() then raise exception 'Only the boss can reveal Aadhaar'; end if;
  select private.dec(aadhaar_enc) into v from public.customers where id = p_customer;
  insert into public.activity_log (actor, actor_name, action, entity, entity_id, customer_id, summary)
  values (auth.uid(), (select full_name from public.profiles where id = auth.uid()), 'reveal', 'customer', p_customer, p_customer, 'Revealed Aadhaar number');
  if v is null then return null; end if;
  return substr(v,1,4) || ' ' || substr(v,5,4) || ' ' || substr(v,9);
end $$;

-- Duplicate check on mobile, Aadhaar or passport.
create or replace function public.find_duplicates(p_mobile text, p_aadhaar text default null, p_passport text default null, p_exclude uuid default null)
returns table (id uuid, code text, full_name text, mobile text, matched text)
language plpgsql stable security definer set search_path = public as $$
declare m text := right(regexp_replace(coalesce(p_mobile,''), '\D', '', 'g'), 10);
begin
  if not public.is_team() then raise exception 'Not allowed'; end if;
  return query
    select c.id, c.code, c.full_name, c.mobile,
      concat_ws(', ',
        case when m <> '' and right(regexp_replace(c.mobile, '\D', '', 'g'), 10) = m then 'mobile' end,
        case when coalesce(p_aadhaar,'') <> '' and c.aadhaar_hash = private.hash_id(regexp_replace(p_aadhaar, '\D', '', 'g')) then 'Aadhaar' end,
        case when coalesce(p_passport,'') <> '' and c.passport_hash = private.hash_id(p_passport) then 'passport' end)
    from public.customers c
    where (p_exclude is null or c.id <> p_exclude)
      and ((m <> '' and right(regexp_replace(c.mobile, '\D', '', 'g'), 10) = m)
        or (coalesce(p_aadhaar,'') <> '' and c.aadhaar_hash = private.hash_id(regexp_replace(p_aadhaar, '\D', '', 'g')))
        or (coalesce(p_passport,'') <> '' and c.passport_hash = private.hash_id(p_passport)))
    limit 5;
end $$;

-- Document numbers (encrypted). Aadhaar always masked.
create or replace function public.set_document_number(p_doc uuid, p_number text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_team() and not exists (
    select 1 from public.customer_documents d where d.id = p_doc and d.customer_id = public.my_customer_id()) then
    raise exception 'Not allowed';
  end if;
  update public.customer_documents
     set number_enc = private.enc(p_number), number_last4 = nullif(right(regexp_replace(coalesce(p_number,''), '\s', '', 'g'), 4), '')
   where id = p_doc;
end $$;

create or replace function public.document_numbers(p_customer uuid)
returns table (id uuid, number text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_team() then raise exception 'Not allowed'; end if;
  return query
    select d.id, case when d.doc_type ilike 'aadhaar%' then
                   case when d.number_last4 is null then null else 'XXXX XXXX ' || d.number_last4 end
                 else private.dec(d.number_enc) end
    from public.customer_documents d where d.customer_id = p_customer;
end $$;

-- ---------------------------------------------------------------- profiles on signup
-- Role comes from app_metadata, which only the service role can set. GoTrue may write
-- app_metadata after the initial insert, so we react to both insert and update.
create or replace function private.handle_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := new.raw_app_meta_data;
begin
  if not (m ? 'role') or (m ->> 'role') not in ('boss','staff','client') then return new; end if;
  insert into public.profiles (id, role, full_name, email, phone, customer_id, must_change_password)
  values (new.id, m ->> 'role', coalesce(m ->> 'full_name', split_part(new.email, '@', 1)), new.email, m ->> 'phone',
          nullif(m ->> 'customer_id', '')::uuid, coalesce((m ->> 'must_change_password')::boolean, false))
  on conflict (id) do update set
    role = excluded.role,
    full_name = case when m ? 'full_name' then excluded.full_name else profiles.full_name end,
    email = excluded.email,
    customer_id = coalesce(excluded.customer_id, profiles.customer_id),
    must_change_password = excluded.must_change_password;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function private.handle_auth_user();
create trigger on_auth_user_meta after update of raw_app_meta_data, email on auth.users
for each row when (old.raw_app_meta_data is distinct from new.raw_app_meta_data or old.email is distinct from new.email)
execute function private.handle_auth_user();

create or replace function public.password_changed() returns void
language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where id = auth.uid()
$$;

-- Deactivate a staff login: open cases and tasks move to the boss.
create or replace function public.deactivate_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b uuid := auth.uid();
begin
  if not public.is_boss() then raise exception 'Only the boss can deactivate users'; end if;
  if p_user = b then raise exception 'You cannot deactivate yourself'; end if;
  update public.profiles set active = false where id = p_user;
  update public.cases set assigned_to = b
   where assigned_to = p_user and status not in ('completed','cancelled');
  update public.tasks set assigned_to = b where assigned_to = p_user and status <> 'done';
  update public.customers set assigned_to = b where assigned_to = p_user;
end $$;

-- MAX ID start number: can only move forward, so numbers are never reused.
create or replace function public.next_max_no() returns bigint
language sql stable security definer set search_path = public as $$
  select case when is_called then last_value + 1 else last_value end from public.max_seq
$$;

create or replace function public.set_max_start(p_start bigint) returns void
language plpgsql security definer set search_path = public as $$
declare cur bigint;
begin
  if not public.is_boss() then raise exception 'Only the boss can change this'; end if;
  select greatest(public.next_max_no(), coalesce((select max(max_no) + 1 from public.cases), 1)) into cur;
  if p_start < cur then raise exception 'Start number must be % or higher (MAX IDs are never reused)', cur; end if;
  perform setval('public.max_seq', p_start, false);
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.lookups enable row level security;
alter table public.families enable row level security;
alter table public.customers enable row level security;
alter table public.customer_documents enable row level security;
alter table public.suppliers enable row level security;
alter table public.cases enable row level security;
alter table public.case_travellers enable row level security;
alter table public.booking_lines enable row level security;
alter table public.expenses enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.files enable row level security;
alter table public.share_links enable row level security;
alter table public.tasks enable row level security;
alter table public.task_comments enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_log enable row level security;

-- profiles: team sees team; everyone sees self; only boss edits.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (public.is_team() and role in ('boss','staff')) or (public.is_boss()));
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_boss()) with check (public.is_boss());

create policy settings_select on public.settings for select to authenticated using (public.is_team());
create policy settings_update on public.settings for update to authenticated using (public.is_boss()) with check (public.is_boss());

create policy lookups_select on public.lookups for select to authenticated using (public.is_team());
create policy lookups_write on public.lookups for all to authenticated using (public.is_boss()) with check (public.is_boss());

create policy families_select on public.families for select to authenticated using (public.is_team());
create policy families_insert on public.families for insert to authenticated with check (public.is_team());
create policy families_update on public.families for update to authenticated using (public.is_team()) with check (public.is_team());
create policy families_delete on public.families for delete to authenticated using (public.is_boss());

-- customers: team only. Clients use the portal_* functions.
create policy customers_select on public.customers for select to authenticated using (public.is_team());
create policy customers_insert on public.customers for insert to authenticated with check (public.is_team());
create policy customers_update on public.customers for update to authenticated using (public.is_team()) with check (public.is_team());
create policy customers_delete on public.customers for delete to authenticated using (public.is_boss());

create policy cdocs_select on public.customer_documents for select to authenticated using (public.is_team());
create policy cdocs_insert on public.customer_documents for insert to authenticated with check (public.is_team());
create policy cdocs_update on public.customer_documents for update to authenticated using (public.is_team()) with check (public.is_team());
create policy cdocs_delete on public.customer_documents for delete to authenticated using (public.is_boss());

create policy suppliers_select on public.suppliers for select to authenticated using (public.is_team());
create policy suppliers_insert on public.suppliers for insert to authenticated with check (public.is_team());
create policy suppliers_update on public.suppliers for update to authenticated using (public.is_team()) with check (public.is_team());
create policy suppliers_delete on public.suppliers for delete to authenticated using (public.is_boss());

create policy cases_select on public.cases for select to authenticated using (public.can_see_case_row(assigned_to, created_by));
create policy cases_insert on public.cases for insert to authenticated with check (public.is_team());
create policy cases_update on public.cases for update to authenticated using (public.can_see_case_row(assigned_to, created_by)) with check (public.is_team());
create policy cases_delete on public.cases for delete to authenticated using (public.is_boss());

create policy ctrav_all on public.case_travellers for all to authenticated
  using (public.can_see_case(case_id)) with check (public.can_see_case(case_id));

create policy lines_select on public.booking_lines for select to authenticated using (public.can_see_case(case_id));
create policy lines_insert on public.booking_lines for insert to authenticated with check (public.can_see_case(case_id));
create policy lines_update on public.booking_lines for update to authenticated using (public.can_see_case(case_id)) with check (public.can_see_case(case_id));
create policy lines_delete on public.booking_lines for delete to authenticated using (public.is_boss());

create policy exp_select on public.expenses for select to authenticated using (public.can_see_case(case_id));
create policy exp_insert on public.expenses for insert to authenticated with check (public.can_see_case(case_id));
create policy exp_update on public.expenses for update to authenticated using (public.can_see_case(case_id)) with check (public.can_see_case(case_id));
create policy exp_delete on public.expenses for delete to authenticated using (public.is_boss());

create policy pay_select on public.payments for select to authenticated
  using ((direction = 'in' and public.can_see_case(case_id)) or (direction = 'out' and public.is_team()));
create policy pay_insert on public.payments for insert to authenticated
  with check ((direction = 'in' and public.can_see_case(case_id)) or (direction = 'out' and public.is_team()));
create policy pay_update on public.payments for update to authenticated using (public.is_boss()) with check (public.is_boss());
create policy pay_delete on public.payments for delete to authenticated using (public.is_boss());

create policy alloc_select on public.payment_allocations for select to authenticated using (public.is_team());
create policy alloc_insert on public.payment_allocations for insert to authenticated with check (public.is_team());
create policy alloc_delete on public.payment_allocations for delete to authenticated using (public.is_boss());

create policy files_select on public.files for select to authenticated
  using (case when case_id is not null then public.can_see_case(case_id) else public.is_team() end);
create policy files_insert on public.files for insert to authenticated
  with check (case when case_id is not null then public.can_see_case(case_id) else public.is_team() end);
create policy files_update on public.files for update to authenticated
  using (case when case_id is not null then public.can_see_case(case_id) else public.is_team() end)
  with check (public.is_team());
create policy files_delete on public.files for delete to authenticated using (public.is_boss());

create policy share_select on public.share_links for select to authenticated using (public.is_team());
create policy share_insert on public.share_links for insert to authenticated with check (public.is_team());

-- tasks: boss sees and assigns all; staff see own and assign to self only.
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid())));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_boss() or (public.is_team() and assigned_to = auth.uid()));
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid())))
  with check (public.is_boss() or (public.is_team() and assigned_to = auth.uid()));
create policy tasks_delete on public.tasks for delete to authenticated using (public.is_boss());

create policy tcom_select on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id));
create policy tcom_insert on public.task_comments for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id));

create policy notif_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy act_select on public.activity_log for select to authenticated
  using (public.is_team() and (case_id is null or public.can_see_case(case_id)));

-- ---------------------------------------------------------------- grants
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;

-- Encrypted columns can only be written through set_customer_ids() (runs as owner).
create or replace function private.guard_encrypted() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and (
       (tg_op = 'INSERT' and (new.aadhaar_enc is not null or new.pan_enc is not null or new.passport_enc is not null
                              or new.aadhaar_hash is not null or new.passport_hash is not null or new.pan_hash is not null))
    or (tg_op = 'UPDATE' and (new.aadhaar_enc is distinct from old.aadhaar_enc or new.pan_enc is distinct from old.pan_enc
                              or new.passport_enc is distinct from old.passport_enc or new.aadhaar_last4 is distinct from old.aadhaar_last4
                              or new.aadhaar_hash is distinct from old.aadhaar_hash or new.passport_hash is distinct from old.passport_hash
                              or new.pan_hash is distinct from old.pan_hash))) then
    raise exception 'ID numbers must be set with set_customer_ids()';
  end if;
  return new;
end $$;
create trigger customers_guard_encrypted before insert or update on public.customers
for each row execute function private.guard_encrypted();
