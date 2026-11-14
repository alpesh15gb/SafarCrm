-- Ticket import fixes found walking the flows as a user (2026-11-15). Additive; only confirm_ticket_import changes.
-- 1. A reissue replaced every ticket on the booking with the ones on the new document. When one traveller's ticket
--    is reissued (e.g. Anil's), the others' valid tickets (Sunita's) were moved to history as if cancelled. Now a
--    reissue replaces the tickets of the travellers who have a ticket number on the new document and keeps
--    everyone else's.
-- 2. The "possible duplicate" check applied when updating or reissuing an existing booking. It exists to stop a
--    second booking for the same ticket; an update or reissue creates none, so it now applies to new bookings only.
do $$
declare
  def text := pg_get_functiondef('public.confirm_ticket_import(uuid, int, text, jsonb)'::regprocedure);
  dup_old text := $x$  if coalesce(trim(p ->> 'duplicate_override_reason'), '') = '' and exists ($x$;
  dup_new text := $x$  if coalesce(p #>> '{booking,mode}', '') = 'new' and coalesce(trim(p ->> 'duplicate_override_reason'), '') = '' and exists ($x$;
  re_old text := $x$'tickets', case when bmode = 'reissue' then tickets$x$;
  re_new text := $x$'tickets', case when bmode = 'reissue' then (select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(coalesce(existing.details -> 'tickets', '[]'::jsonb)) t
                                                           where coalesce(t ->> 'customer_id', '') not in (select coalesce(x ->> 'customer_id', '') from jsonb_array_elements(tickets) x)) || tickets$x$;
begin
  if position(dup_old in def) = 0 or position(re_old in def) = 0 then
    raise exception 'confirm_ticket_import does not look as expected; not changed';
  end if;
  def := replace(def, dup_old, dup_new);
  def := replace(def, re_old, re_new);
  execute def;
end $$;
