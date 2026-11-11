-- Review guards found in the agency audit (2026-11-11). Redefines confirm_ticket_import with three extra checks:
--   1. a probable duplicate (same ticket number, or same PNR on the same flight date) must be resolved: update that
--      booking, or give a reason for creating another one
--   2. a reissue needs at least one ticket number the booking doesn't already have
--   3. "Confirmed (ticket issued)" with no ticket number on the document needs an explicit acknowledgment
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
  -- ticketed without a ticket number: only with an explicit acknowledgment (some carriers use the booking reference)
  if line_status = 'confirmed' and jsonb_array_length(tickets) = 0 and not coalesce((p ->> 'no_ticket_number_ack')::boolean, false) then
    raise exception 'no_ticket_number_ack: the document shows no ticket number; tick that the ticket is issued anyway' using errcode = 'P0001';
  end if;

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
  -- a probable duplicate must be resolved before another booking is made
  if coalesce(trim(p ->> 'duplicate_override_reason'), '') = '' and exists (
      select 1 from public.booking_lines l
      where l.service = 'flight' and l.status <> 'cancelled' and l.id is distinct from nullif(p #>> '{booking,line_id}', '')::uuid
        and public.can_see_case(l.case_id)
        and (exists (select 1 from jsonb_array_elements(case when jsonb_typeof(l.details -> 'tickets') = 'array' then l.details -> 'tickets' else '[]'::jsonb end) t,
                          jsonb_array_elements(tickets) x
                     where upper(regexp_replace(coalesce(t ->> 'number', ''), '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(coalesce(x ->> 'number', ''), '[^A-Za-z0-9]', '', 'g'))
                       and length(regexp_replace(coalesce(x ->> 'number', ''), '[^A-Za-z0-9]', '', 'g')) >= 6)
             or (pnr is not null and upper(trim(coalesce(l.details ->> 'pnr', ''))) = any(string_to_array(pnr, ' '))
                 and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(l.details -> 'sectors') = 'array' then l.details -> 'sectors' else '[]'::jsonb end) s,
                                   jsonb_array_elements(sectors) y where s ->> 'date' = y ->> 'date')))) then
    raise exception 'duplicate_unresolved: this ticket matches an existing booking; update that booking, or give a reason for a separate one' using errcode = 'P0001';
  end if;
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
    -- a reissue replaces tickets: the document must carry at least one ticket number the booking doesn't already have
    if bmode = 'reissue' and not exists (
        select 1 from jsonb_array_elements(tickets) x
        where upper(regexp_replace(coalesce(x ->> 'number', ''), '[^A-Za-z0-9]', '', 'g')) not in (
          select upper(regexp_replace(coalesce(t ->> 'number', ''), '[^A-Za-z0-9]', '', 'g'))
          from jsonb_array_elements(coalesce(existing.details -> 'tickets', '[]'::jsonb)) t)) then
      raise exception 'reissue_needs_new_ticket: a reissue needs a new ticket number; use Update for the same tickets' using errcode = 'P0001';
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
         result = jsonb_build_object('case_id', cid, 'max_id', mx, 'booking_line_id', lid, 'file_id', fid, 'traveller_ids', to_jsonb(people), 'mode', bmode,
                         'duplicate_override_reason', nullif(trim(coalesce(p ->> 'duplicate_override_reason', '')), ''))
   where id = p_id;
  perform private.log_event('confirm', 'ticket_import', p_id, cid, payer,
    'Ticket ' || i.file_name || ' reviewed and ' || case bmode when 'new' then 'added as a new booking' when 'reissue' then 'recorded as a reissue' else 'used to update a booking' end
    || ' (' || booked_by || '-booked)');
  return jsonb_build_object('case_id', cid, 'max_id', mx, 'booking_line_id', lid, 'file_id', fid, 'already_confirmed', false);
end $$;

revoke execute on function public.confirm_ticket_import(uuid, int, text, jsonb) from public, anon;
grant execute on function public.confirm_ticket_import(uuid, int, text, jsonb) to authenticated, service_role;
