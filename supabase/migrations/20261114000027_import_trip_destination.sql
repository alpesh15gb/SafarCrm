-- Round trips confirmed from a ticket were titled "Flight HYD → HYD" (found on the live site, MAX-1015, 2026-11-15).
-- The new MAX ID's default title and the ticket file name used the first departure and the last arrival; on a
-- round trip (including an open jaw like HYD→DXB, AUH→HYD) the last arrival is home. Now, when the trip ends where it
-- started, the destination is the first flight's arrival: "Flight HYD → DXB". One-way and onward trips are unchanged.
-- Additive: only those two expressions in confirm_ticket_import change.
do $$
declare
  def text := pg_get_functiondef('public.confirm_ticket_import(uuid, int, text, jsonb)'::regprocedure);
  old_expr text := $x$(sectors -> (n - 1) ->> 'to')$x$;
  new_expr text := $x$(case when n > 1 and sectors -> (n - 1) ->> 'to' = sectors -> 0 ->> 'from' then sectors -> 0 ->> 'to' else sectors -> (n - 1) ->> 'to' end)$x$;
  hits int;
begin
  hits := (length(def) - length(replace(def, old_expr, ''))) / length(old_expr);
  if hits <> 2 then
    raise exception 'confirm_ticket_import: expected the destination expression twice, found %; not changed', hits;
  end if;
  execute replace(def, old_expr, new_expr);
end $$;
