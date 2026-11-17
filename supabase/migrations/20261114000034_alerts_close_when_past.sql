-- Alerts that outlive their moment (found walking the live site, 2026-11-18). Additive.
-- 1. A web check-in alert stayed open after the flight had left, and the trip reminder after the trip day; on the
--    case and the dashboard they read as overdue work. They now close by themselves once the flight has departed
--    (48 hours after check-in opened) or the trip day has passed, with a note. Checked every hour.
-- 2. The trip reminder said "web check-in and final documents", repeating the per-flight web check-in alert. It now
--    says "send the final documents to the client"; open ones are renamed.

create or replace function private.close_past_alerts() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.tasks
     set status = 'done',
         notes = coalesce(notes || chr(10), '') || 'Closed automatically: the flight or trip date has passed.'
   where status <> 'done'
     and ((auto_key like 'webcheckin:%' and due_at is not null and due_at + interval '48 hours' < now())
       or (auto_key like 'trip:%' and split_part(auto_key, ':', 3) ~ '^\d{4}-\d{2}-\d{2}$'
           and split_part(auto_key, ':', 3)::date < (now() at time zone 'Asia/Kolkata')::date));
  get diagnostics n = row_count;
  return n;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'safar-close-past-alerts';
select cron.schedule('safar-close-past-alerts', '10 * * * *', 'select private.close_past_alerts()');
select private.close_past_alerts();

do $$
declare def text := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
begin
  if position(': web check-in and final documents' in def) > 0 then
    execute replace(def, ': web check-in and final documents', ': send the final documents to the client');
  end if;
end $$;

update public.tasks set title = replace(title, ': web check-in and final documents', ': send the final documents to the client')
 where status <> 'done' and auto_key like 'trip:%' and title like '%: web check-in and final documents';
