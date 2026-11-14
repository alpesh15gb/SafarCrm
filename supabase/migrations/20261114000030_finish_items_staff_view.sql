-- "Completes by itself when" for staff who may not see profit (found walking a staff confirm, MAX-1029, 2026-11-15).
-- Additive; only the wording of one line in private.case_finish_items changes. Whether it is done ('ok') and so
-- auto-complete are unchanged.
-- "Enter the price on 1 booking" asked them for the supplier cost they are not allowed to enter. They now read
-- "The boss adds the cost on 1 booking".
do $$
declare
  def text := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
  p_old text := $x$else 'Enter the price on ' || n || ' booking' || case when n = 1 then '' else 's' end end);$x$;
  p_new text := $x$when public.can_see_profit() then 'Enter the price on ' || n || ' booking' || case when n = 1 then '' else 's' end
                 else 'The boss adds the cost on ' || n || ' booking' || case when n = 1 then '' else 's' end end);$x$;
begin
  if position(p_old in def) = 0 then
    raise exception 'case_finish_items does not look as expected; not changed';
  end if;
  execute replace(def, p_old, p_new);
end $$;
