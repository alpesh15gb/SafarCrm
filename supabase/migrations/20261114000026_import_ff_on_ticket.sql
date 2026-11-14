-- Fix for 20261114000024 (found by import_pricing.test.sql on the server, 2026-11-15). Additive.
-- The frequent flyer number written onto the booking's ticket entry left out the airline ("200000001" instead of
-- "EK 200000001"): the loyalty entries keep the airline under "name", but the ticket line read "airline".
-- Only that one expression in confirm_ticket_import changes.
do $$
declare
  def text := pg_get_functiondef('public.confirm_ticket_import(uuid, int, text, jsonb)'::regprocedure);
  old_expr text := $x$coalesce(x ->> 'airline', '')$x$;
  new_expr text := $x$coalesce(x ->> 'name', '')$x$;
begin
  if position(old_expr in def) = 0 then
    raise exception 'confirm_ticket_import does not contain the expected frequent flyer expression; not changed';
  end if;
  execute replace(def, old_expr, new_expr);
end $$;
