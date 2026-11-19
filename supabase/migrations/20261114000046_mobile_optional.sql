-- A customer's mobile number is optional (owner, 2026-11-19). Customers can be saved with just a name; the number can
-- be added later. A blank number is stored as null, never '' (so the duplicate check never matches blanks).
alter table public.customers alter column mobile drop not null;
update public.customers set mobile = null where trim(coalesce(mobile, '')) = '';

-- adding a passenger while reviewing a ticket import needs only a first name now
do $do$
declare src text := pg_get_functiondef('public.confirm_ticket_import(uuid, int, text, jsonb)'::regprocedure);
        old_check text := $o$if coalesce(trim(m #>> '{create,first_name}'), '') = '' or coalesce(trim(m #>> '{create,mobile}'), '') = '' then
        raise exception 'import_incomplete: passenger % needs a first name and a mobile to be added', k using errcode = 'P0001';$o$;
        new_check text := $n$if coalesce(trim(m #>> '{create,first_name}'), '') = '' then
        raise exception 'import_incomplete: passenger % needs a first name to be added', k using errcode = 'P0001';$n$;
        old_val text := $o$trim(m #>> '{create,mobile}'),$o$;
        new_val text := $n$nullif(trim(coalesce(m #>> '{create,mobile}', '')), ''),$n$;
begin
  if position(old_check in src) = 0 then raise exception 'confirm_ticket_import: mobile check not found'; end if;
  if position(old_val in src) = 0 then raise exception 'confirm_ticket_import: mobile value not found'; end if;
  execute replace(replace(src, old_check, new_check), old_val, new_val);
end $do$;
