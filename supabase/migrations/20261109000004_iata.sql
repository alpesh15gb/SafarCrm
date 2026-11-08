-- IATA conventions: airline designator codes, base-fare commission.

update public.lookups set value = 'Turkish Airlines' where kind = 'airline' and value = 'Turkish Airways';
update public.lookups l set extra = l.extra || jsonb_build_object('code', c.code)
from (values ('IndiGo','6E'),('Air India','AI'),('Air India Express','IX'),('Akasa Air','QP'),('SpiceJet','SG'),('Alliance Air','9I'),
             ('Star Air','S5'),('Fly91','IC'),('Emirates','EK'),('Qatar Airways','QR'),('Etihad Airways','EY'),('Singapore Airlines','SQ'),
             ('Thai Airways','TG'),('Lufthansa','LH'),('British Airways','BA'),('Air Arabia','G9'),('flydubai','FZ'),('Oman Air','WY'),
             ('Saudia','SV'),('Malaysia Airlines','MH'),('Cathay Pacific','CX'),('Vietnam Airlines','VN'),('Turkish Airlines','TK'),
             ('Air France','AF'),('KLM','KL'),('Virgin Atlantic','VS'),('United Airlines','UA'),('American Airlines','AA')) c(name, code)
where l.kind = 'airline' and l.value = c.name;
insert into public.lookups (kind, value, extra, sort)
select 'airline', v.name, jsonb_build_object('code', v.code), 100 + v.o
from (values ('Gulf Air','GF',1),('SriLankan Airlines','UL',2),('AirAsia','AK',3),('Kuwait Airways','KU',4),('Batik Air','OD',5)) v(name, code, o)
where not exists (select 1 from public.lookups x where x.kind = 'airline' and x.value = v.name);

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

  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end $$;
