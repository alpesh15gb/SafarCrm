-- Money fixes from the function review (2026-11-12). Additive; no amounts are changed.
--   1. money a client still owes on a CANCELLED case (cancellation charges) stays on the Client dues report and in the
--      dashboard's "Due from clients". It used to vanish from both, while the case page still showed it as due.
--   2. a case expense must be a positive amount (a negative one silently raised profit)

-- 1. the two functions are patched in place, so the rest of their definitions stays exactly as deployed
do $$
declare def text; fn regprocedure;
begin
  foreach fn in array array['public.report_client_dues(uuid,uuid)'::regprocedure, 'public.dashboard_money(date,date)'::regprocedure] loop
    def := pg_get_functiondef(fn);
    if position('where m.due > 0 and c.status <> ''cancelled'' and (c.status not in' in def) > 0 then
      execute replace(def, 'where m.due > 0 and c.status <> ''cancelled'' and (c.status not in', 'where m.due > 0 and (c.status not in');
    end if;
  end loop;
end $$;

-- 2. new expenses only (existing rows are left alone)
do $$ begin
  alter table public.expenses add constraint expenses_amount_positive check (amount > 0) not valid;
exception when duplicate_object then null; end $$;
