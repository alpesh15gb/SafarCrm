-- Supplier cost is for the boss and for staff allowed to see profit (owner's decision, 2026-11-13).
-- Before, every staff member saw supplier cost and supplier dues in several places, from which profit follows.
-- Masked here (the value is null for staff without profit rights):
--   v_case_money (supplier payable / paid / due), v_line_money (cost), v_case_supplier_money, v_supplier_balance,
--   the supplier dues report, the "suppliers still to be paid" items on a case.
-- "Pay supplier ₹…" reminders go to the boss (or the case owner if they may see profit), and those reminders are
-- hidden from staff who may not. The rules that use supplier money (auto-complete, readiness) work it out directly,
-- so they are unaffected by who is looking.
-- Note: the booking records themselves still hold the cost; the app no longer shows it to these staff (see the
-- app changes in the same commit). Additive.

-- what is still owed to suppliers on a case, worked out from the bookings and allocations (never masked)
create or replace function private.case_supplier_due(p_case uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(public.line_cost(l)) from public.booking_lines l where l.case_id = p_case), 0)
       - coalesce((select sum(a.amount) from public.payment_allocations a where a.case_id = p_case), 0)
$$;

-- ============================================================ views
create or replace view public.v_case_money with (security_invoker = true) as
select c.id as case_id,
       coalesce(l.billed, 0) as billed,
       coalesce(r.received, 0) as received,
       coalesce(l.billed, 0) - coalesce(r.received, 0) as due,
       case when public.can_see_profit() then coalesce(l.cost, 0) end as supplier_payable,
       case when public.can_see_profit() then coalesce(sp.paid, 0) end as supplier_paid,
       case when public.can_see_profit() then coalesce(l.cost, 0) - coalesce(sp.paid, 0) end as supplier_due,
       coalesce(l.sale, 0) as sale,
       case when public.can_see_profit() then coalesce(l.commission, 0) end as commission,
       case when public.can_see_profit() then coalesce(e.expenses, 0) end as expenses,
       case when public.can_see_profit() then coalesce(l.profit, 0) - coalesce(e.expenses, 0) end as profit,
       case when public.can_see_profit() and coalesce(l.sale, 0) > 0
            then round((coalesce(l.profit, 0) - coalesce(e.expenses, 0)) / l.sale * 100, 1) end as margin
from public.cases c
left join lateral (
  select sum(public.line_billed(x)) as billed, sum(public.line_sale(x)) as sale, sum(public.line_cost(x)) as cost,
         sum(case when x.status = 'cancelled' then 0 else x.commission_amount end) as commission,
         sum(public.line_profit(x)) as profit
  from public.booking_lines x where x.case_id = c.id) l on true
left join lateral (select sum(amount) as received from public.payments p where p.case_id = c.id and p.direction = 'in') r on true
left join lateral (select sum(a.amount) as paid from public.payment_allocations a where a.case_id = c.id) sp on true
left join lateral (select sum(amount) as expenses from public.expenses x where x.case_id = c.id) e on true;

create or replace view public.v_line_money with (security_invoker = true) as
select l.id as line_id, l.case_id,
       public.line_billed(l) as billed,
       public.line_sale(l) as sale,
       case when public.can_see_profit() then public.line_cost(l) end as cost,
       case when public.can_see_profit() then public.line_profit(l) end as profit,
       case when public.can_see_profit() and public.line_sale(l) <> 0
            then round(public.line_profit(l) / public.line_sale(l) * 100, 1) end as margin
from public.booking_lines l;

create or replace view public.v_case_supplier_money with (security_invoker = true) as
select l.case_id, l.supplier_id, s.name as supplier_name,
       case when public.can_see_profit() then sum(public.line_cost(l)) end as payable,
       case when public.can_see_profit() then coalesce((select sum(a.amount) from public.payment_allocations a join public.payments p on p.id = a.payment_id
                 where a.case_id = l.case_id and p.supplier_id = l.supplier_id), 0) end as paid,
       min(l.supplier_due_date) as due_date
from public.booking_lines l join public.suppliers s on s.id = l.supplier_id
group by l.case_id, l.supplier_id, s.name;

create or replace view public.v_supplier_balance with (security_invoker = false) as
select s.id as supplier_id, s.name,
       case when public.can_see_profit() then coalesce((select sum(public.line_cost(l)) from public.booking_lines l where l.supplier_id = s.id), 0) end as payable,
       case when public.can_see_profit() then coalesce((select sum(p.amount) from public.payments p where p.supplier_id = s.id and p.direction = 'out'), 0) end as paid,
       (select min(l.supplier_due_date) from public.booking_lines l where l.supplier_id = s.id and l.status <> 'cancelled') as oldest_due
from public.suppliers s
where public.is_team();

create or replace function public.report_supplier_dues(p_supplier uuid default null)
returns table (supplier_id uuid, name text, payable numeric, paid numeric, due numeric, oldest_due date)
language sql stable set search_path = public as $$
  select b.supplier_id, b.name, b.payable, b.paid, b.payable - b.paid, b.oldest_due
  from public.v_supplier_balance b
  where public.can_see_profit() and b.payable - b.paid <> 0 and (p_supplier is null or b.supplier_id = p_supplier)
  order by b.payable - b.paid desc
$$;

-- ============================================================ "what's left" and readiness use the raw figure
do $$
declare def text;
begin
  def := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
  if position('coalesce(m.supplier_due, 0)' in def) > 0 then
    def := replace(def, '''ok'', coalesce(m.supplier_due, 0) < 0.01,', '''ok'', private.case_supplier_due(p_case) < 0.01,');
    def := replace(def, 'case when coalesce(m.supplier_due, 0) < 0.01 then ''Suppliers paid''',
                        'case when private.case_supplier_due(p_case) < 0.01 then ''Suppliers paid'' when not public.can_see_profit() then ''Suppliers still to be paid''');
    def := replace(def, 'to_char(m.supplier_due, ''FM99,99,99,990'')', 'to_char(private.case_supplier_due(p_case), ''FM99,99,99,990'')');
    execute def;
  end if;

  def := pg_get_functiondef('public.case_readiness(uuid)'::regprocedure);
  if position('coalesce(m.supplier_due, 0) > 0' in def) > 0 then
    execute replace(def,
      'if coalesce(m.supplier_due, 0) > 0 then loose := loose || jsonb_build_object(''code'', ''supplier_due'', ''count'', 1, ''amount'', m.supplier_due, ''text'', ''₹'' || to_char(m.supplier_due, ''FM99,99,99,990.00'') || '' is still to be paid to suppliers''); end if;',
      'if private.case_supplier_due(p_case) > 0.009 then loose := loose || jsonb_build_object(''code'', ''supplier_due'', ''count'', 1,
     ''amount'', case when public.can_see_profit() then private.case_supplier_due(p_case) end,
     ''text'', case when public.can_see_profit() then ''₹'' || to_char(private.case_supplier_due(p_case), ''FM99,99,99,990.00'') || '' is still to be paid to suppliers'' else ''suppliers are still to be paid'' end); end if;');
  end if;
end $$;

-- ============================================================ supplier-payment reminders: only for people who may see the amount
-- the case owner if they may see profit, otherwise the boss
create or replace function private.money_owner(p_case uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from public.profiles p where p.id = private.case_owner(p_case) and p.active and (p.role = 'boss' or p.can_see_profit)),
    public.first_boss())
$$;

do $$
declare def text := pg_get_functiondef('public.run_auto_reminders()'::regprocedure);
begin
  if position('''Pay supplier '' || r.name || '': ₹'' || to_char(r.due, ''FM99,99,99,990''), r.case_id, null, private.case_owner(r.case_id))' in def) > 0 then
    execute replace(def,
      '''Pay supplier '' || r.name || '': ₹'' || to_char(r.due, ''FM99,99,99,990''), r.case_id, null, private.case_owner(r.case_id))',
      '''Pay supplier '' || r.name || '': ₹'' || to_char(r.due, ''FM99,99,99,990''), r.case_id, null, private.money_owner(r.case_id))');
  end if;
end $$;

-- open supplier-payment reminders held by staff who may not see profit go to the boss
update public.tasks t set assigned_to = private.money_owner(t.case_id)
 where t.status <> 'done' and t.auto_key like 'supdue:%' and t.case_id is not null
   and t.assigned_to is distinct from private.money_owner(t.case_id);

-- staff who may not see profit don't see supplier-payment reminders on their cases either
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using ((public.is_boss() or (public.is_team() and (assigned_to = auth.uid() or created_by = auth.uid()
          or (case_id is not null and public.can_see_case(case_id)))))
         and (coalesce(auto_key, '') not like 'supdue:%' or public.can_see_profit()));

-- the next step shown on case cards never reveals a supplier amount to those staff
do $$
declare def text := pg_get_functiondef('public.case_work_summary(uuid[])'::regprocedure);
begin
  if position('''title'', x.title,' in def) > 0 then
    execute replace(def, '''title'', x.title,',
      '''title'', case when x.auto_key like ''supdue:%'' and not public.can_see_profit() then ''Supplier payment (the boss handles it)'' else x.title end,');
  end if;
end $$;

revoke all on public.v_supplier_balance from public, anon;
grant select on public.v_supplier_balance to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.need_profit() to authenticated;
grant execute on function private.log_event(text, text, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function private.ticket_digits(text) to authenticated;
grant execute on function private.default_travellers(uuid, uuid[]) to authenticated;
