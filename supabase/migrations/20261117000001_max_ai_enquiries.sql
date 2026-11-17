-- Website enquiries are isolated from customer/case/booking/payment records.
-- No existing data is updated, no case/traveller/task triggers are invoked.
create table public.max_ai_enquiries (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'MAXTRAVEL' check (source = 'MAXTRAVEL'),
  source_environment text not null check (source_environment in ('test','live')),
  source_enquiry_id uuid not null unique,
  event_id uuid not null unique,
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  reference text not null unique check (reference ~ '^ME-[A-F0-9]{12}$'),
  service text not null check (service in ('VISA','INSURANCE','HOLIDAY','CRUISE')),
  draft jsonb not null check (jsonb_typeof(draft) = 'object' and not draft ?| array['budgetRupees','budgetBasis']),
  contact jsonb not null check (jsonb_typeof(contact) = 'object'),
  contact_verified boolean not null default false check (contact_verified = false),
  consent_at timestamptz not null,
  source_created_at timestamptz not null,
  status text not null default 'NEW' check (status in ('NEW','CONTACTED','QUOTED','CLOSED')),
  assigned_to uuid references public.profiles(id) on delete set null,
  internal_note text not null default '' check (length(internal_note) <= 2000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index max_ai_enquiries_register on public.max_ai_enquiries(source_environment, status, created_at desc);
create index max_ai_enquiries_assignee on public.max_ai_enquiries(assigned_to, created_at desc);

create table private.max_ai_enquiry_financial (
  enquiry_id uuid primary key references public.max_ai_enquiries(id),
  amount_rupees numeric not null check (amount_rupees > 0 and amount_rupees <= 100000000),
  basis text not null check (basis in ('TOTAL','PER_PERSON'))
);
create table private.max_ai_enquiry_audit (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.max_ai_enquiries(id),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('received','updated')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.max_ai_enquiries enable row level security;
alter table private.max_ai_enquiry_financial enable row level security;
alter table private.max_ai_enquiry_audit enable row level security;
revoke all on public.max_ai_enquiries from public, anon, authenticated, service_role;
revoke all on private.max_ai_enquiry_financial, private.max_ai_enquiry_audit from public, anon, authenticated, service_role;

create function public.can_see_max_ai_enquiry_row(p_assigned uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_team()
    and not exists(select 1 from public.profiles where id = auth.uid() and must_change_password)
    and (public.is_boss() or (p_assigned is not null and public.can_see_case_row(p_assigned, null)))
$$;
revoke all on function public.can_see_max_ai_enquiry_row(uuid) from public, anon;
grant execute on function public.can_see_max_ai_enquiry_row(uuid) to authenticated;
create policy max_ai_enquiries_read on public.max_ai_enquiries for select to authenticated
  using (public.can_see_max_ai_enquiry_row(assigned_to));
grant select on public.max_ai_enquiries to authenticated;

create function private.max_ai_enquiry_json(e public.max_ai_enquiries) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id',e.id,'reference',e.reference,'service',e.service,'status',e.status,'environment',e.source_environment,
    'draft',e.draft,'contact',e.contact,'contactVerified',false,'consentAt',e.consent_at,
    'createdAt',e.created_at,'updatedAt',e.updated_at,'version',e.version,
    'assignedTo',e.assigned_to,'internalNote',e.internal_note,
    'requestedBudget',case when public.can_see_profit() then
      (select jsonb_build_object('amountRupees',f.amount_rupees,'basis',f.basis)
       from private.max_ai_enquiry_financial f where f.enquiry_id=e.id) else null end)
$$;
revoke all on function private.max_ai_enquiry_json(public.max_ai_enquiries) from public, anon, authenticated, service_role;

-- The signed HTTP receiver is the sole service-role caller. No team/anon RPC access.
create function public.receive_max_ai_enquiry(p_event jsonb, p_body_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb := p_event->'payload'; e public.max_ai_enquiries; eid uuid; source_id uuid; ref text;
begin
  if jsonb_typeof(p_event) is distinct from 'object' or p_event->>'eventType' is distinct from 'enquiry.created'
     or p_event->>'schemaVersion' is distinct from '2' or p_event->>'revision' is distinct from '1'
     or coalesce(p_event->>'environment','') not in ('test','live')
     or jsonb_typeof(p) is distinct from 'object' or p->>'contactVerified' is distinct from 'false'
     or p_event->>'aggregateId' is distinct from p->>'enquiryId'
     or p->>'service' is distinct from p->'draft'->>'service'
     or coalesce(p_body_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_enquiry' using errcode='22023';
  end if;
  eid := (p_event->>'eventId')::uuid; source_id := (p->>'enquiryId')::uuid; ref := p->>'reference';
  if eid is null or source_id is null then raise exception 'invalid_enquiry' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('max_ai_enquiry:' || source_id,0));
  select * into e from public.max_ai_enquiries where event_id=eid or source_enquiry_id=source_id;
  if found then
    if e.event_id is distinct from eid or e.source_enquiry_id is distinct from source_id or e.body_hash is distinct from p_body_hash or e.source_environment is distinct from p_event->>'environment' then
      raise exception 'enquiry_conflict' using errcode='23505';
    end if;
    return jsonb_build_object('accepted',true,'receiver','safar','enquiryId',e.source_enquiry_id,'recordId',e.id,'reference',e.reference,'environment',e.source_environment);
  end if;
  if (p->'draft' ? 'budgetRupees') is distinct from (p->'draft' ? 'budgetBasis') then
    raise exception 'invalid_enquiry' using errcode='22023';
  end if;
  insert into public.max_ai_enquiries(source_enquiry_id,event_id,body_hash,reference,service,draft,contact,consent_at,source_created_at,source_environment)
    values(source_id,eid,p_body_hash,ref,p->>'service',(p->'draft')-'budgetRupees'-'budgetBasis',p->'contact',
      (p->>'consentAt')::timestamptz,(p->>'createdAt')::timestamptz,p_event->>'environment') returning * into e;
  if p->'draft' ? 'budgetRupees' then
    insert into private.max_ai_enquiry_financial(enquiry_id,amount_rupees,basis)
      values(e.id,(p->'draft'->>'budgetRupees')::numeric,p->'draft'->>'budgetBasis');
  end if;
  insert into private.max_ai_enquiry_audit(enquiry_id,action) values(e.id,'received');
  return jsonb_build_object('accepted',true,'receiver','safar','enquiryId',e.source_enquiry_id,'recordId',e.id,'reference',e.reference,'environment',e.source_environment);
end $$;
revoke all on function public.receive_max_ai_enquiry(jsonb,text) from public, anon, authenticated;
grant execute on function public.receive_max_ai_enquiry(jsonb,text) to service_role;

create function public.max_ai_enquiry_list(p_q text default '',p_status text default null,p_service text default null,p_page integer default 1,p_id uuid default null,p_environment text default 'live')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb; total bigint; rows jsonb;
begin
  if not public.is_team() or exists(select 1 from public.profiles where id=auth.uid() and must_change_password) then
    raise exception 'enquiry_forbidden' using errcode='42501';
  end if;
  if p_environment is null or p_environment not in ('test','live') or p_page is null or p_page < 1 or p_page > 10000 or length(coalesce(p_q,'')) > 100
    or (p_status is not null and p_status not in ('NEW','CONTACTED','QUOTED','CLOSED'))
    or (p_service is not null and p_service not in ('VISA','INSURANCE','HOLIDAY','CRUISE')) then
    raise exception 'invalid_enquiry_filter' using errcode='22023';
  end if;
  if p_id is not null then
    select private.max_ai_enquiry_json(e) into result from public.max_ai_enquiries e
      where e.id=p_id and e.source_environment=p_environment and public.can_see_max_ai_enquiry_row(e.assigned_to);
    return jsonb_build_object('enquiry',result);
  end if;
  with filtered as (
    select e.* from public.max_ai_enquiries e where e.source_environment=p_environment and public.can_see_max_ai_enquiry_row(e.assigned_to)
      and (p_status is null or e.status=p_status) and (p_service is null or e.service=p_service)
      and (coalesce(p_q,'')='' or strpos(lower(concat_ws(' ',e.reference,e.draft->>'destination',e.contact->>'name',e.contact->>'email',e.contact->>'phone')),lower(p_q)) > 0)
  ), paged as (select * from filtered order by created_at desc,id desc offset (p_page-1)*25 limit 25)
  select (select count(*) from filtered),coalesce((select jsonb_agg(private.max_ai_enquiry_json(paged::public.max_ai_enquiries) order by created_at desc,id desc) from paged),'[]') into total,rows;
  return jsonb_build_object('rows',rows,'total',total,'page',p_page,'hasMore',total>p_page*25);
end $$;
revoke all on function public.max_ai_enquiry_list(text,text,text,integer,uuid,text) from public, anon;
grant execute on function public.max_ai_enquiry_list(text,text,text,integer,uuid,text) to authenticated;

create function public.update_max_ai_enquiry(p_id uuid,p_version integer,p_status text,p_internal_note text,p_assign boolean default false,p_assigned_to uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.max_ai_enquiries; old_assignee uuid; old_note text;
begin
  select * into e from public.max_ai_enquiries where id=p_id for update;
  if not found or not public.can_see_max_ai_enquiry_row(e.assigned_to) then raise exception 'enquiry_forbidden' using errcode='42501'; end if;
  if e.version is distinct from p_version then raise exception 'enquiry_conflict' using errcode='40001'; end if;
  if p_status is null or p_status not in ('NEW','CONTACTED','QUOTED','CLOSED') or p_internal_note is null or length(p_internal_note)>2000 then
    raise exception 'invalid_enquiry' using errcode='22023';
  end if;
  if p_assign is null then raise exception 'invalid_enquiry' using errcode='22023'; end if;
  if p_assign then
    if not public.is_boss() then raise exception 'enquiry_assignment_forbidden' using errcode='42501'; end if;
    if p_assigned_to is not null and not exists(select 1 from public.profiles where id=p_assigned_to and active and role in ('boss','staff')) then
      raise exception 'invalid_enquiry_assignee' using errcode='22023';
    end if;
  end if;
  old_assignee := e.assigned_to; old_note := e.internal_note;
  update public.max_ai_enquiries set status=p_status,internal_note=p_internal_note,
    assigned_to=case when p_assign then p_assigned_to else assigned_to end,version=version+1,updated_at=now()
    where id=p_id returning * into e;
  insert into private.max_ai_enquiry_audit(enquiry_id,actor_id,action,detail)
    values(e.id,auth.uid(),'updated',jsonb_build_object('status',e.status,'assignmentChanged',e.assigned_to is distinct from old_assignee,'noteChanged',e.internal_note is distinct from old_note));
  return private.max_ai_enquiry_json(e);
end $$;
revoke all on function public.update_max_ai_enquiry(uuid,integer,text,text,boolean,uuid) from public, anon;
grant execute on function public.update_max_ai_enquiry(uuid,integer,text,text,boolean,uuid) to authenticated;
