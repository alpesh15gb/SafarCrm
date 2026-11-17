-- Tasks removed from the app; automatic reminders stay, shown as alerts on each case (owner, after a client visit,
-- 2026-11-18). The office works from cases only. Additive and reversible from Settings.
-- 1. The per-stage to-dos ("Send the quote", "Follow up", "Collect the advance", "Send the documents") were tasks
--    people worked through. They are switched off, and the ones still open are closed with a note. They stop
--    holding a case back from completing. Settings → Reminders → stage tasks can switch them on again.
-- 2. Every other automatic reminder (web check-in, client and supplier payments, passport/visa/document expiry,
--    missing passport details, ticket name check, wallet low, visa steps, hotel cancellation) keeps running and
--    appears on the case as an alert, closing itself when its reason is gone.
-- 3. The "Completes by itself when" line says "alert" instead of "task".

update public.settings set auto_reminders = auto_reminders || '{"stage_tasks": false}'::jsonb where id = 1;

update public.tasks
   set status = 'done',
       notes = coalesce(notes || chr(10), '') || 'Closed automatically: stage to-dos were switched off when Tasks were removed.'
 where status <> 'done' and auto_key like 'stage:%';

do $$
declare
  def text := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
begin
  def := replace(def, $x$n || ' task' || case when n = 1 then '' else 's' end || ' still open'$x$,
                      $x$n || ' alert' || case when n = 1 then '' else 's' end || ' still open'$x$);
  def := replace(def, $x$'No tasks left'$x$, $x$'No alerts left'$x$);
  execute def;
end $$;
