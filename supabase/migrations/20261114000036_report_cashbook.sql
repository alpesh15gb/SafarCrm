-- Cash and bank book (owner, 2026-11-18): for a period, each money account's opening balance, money in, money out
-- and closing balance, and every receipt and payment that moved through it. Payments recorded without an account
-- (before accounts existed, or by mode only) are shown grouped by mode, so the total still adds up.
-- Boss and staff who may see profit only, like the account balances. Additive.

create or replace function public.report_cashbook_summary(p_from date, p_to date)
returns table (account_id uuid, name text, kind text, last4 text, opening numeric, money_in numeric, money_out numeric, closing numeric, entries bigint)
language sql stable security definer set search_path = public as $$
  with acc as (
    select a.id, a.name, a.kind, a.last4, a.opening_balance, a.opening_date, a.sort, a.active from public.money_accounts a
  ), moved as (
    select p.account_id, p.mode, p.direction, p.amount, p.pay_date from public.payments p
    where p.mode <> 'opening'   -- a supplier wallet's opening balance is not money that moved
  )
  select a.id, a.name, a.kind, a.last4,
         a.opening_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end) from moved m
                                       where m.account_id = a.id and m.pay_date >= a.opening_date and m.pay_date < p_from), 0),
         coalesce((select sum(case when m.direction = 'in' then greatest(m.amount, 0) else greatest(-m.amount, 0) end) from moved m
                   where m.account_id = a.id and m.pay_date >= greatest(p_from, a.opening_date) and m.pay_date <= p_to), 0),
         coalesce((select sum(case when m.direction = 'out' then greatest(m.amount, 0) else greatest(-m.amount, 0) end) from moved m
                   where m.account_id = a.id and m.pay_date >= greatest(p_from, a.opening_date) and m.pay_date <= p_to), 0),
         a.opening_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end) from moved m
                                       where m.account_id = a.id and m.pay_date >= a.opening_date and m.pay_date <= p_to), 0),
         (select count(*) from moved m where m.account_id = a.id and m.pay_date >= greatest(p_from, a.opening_date) and m.pay_date <= p_to)
  from acc a
  where (public.is_boss() or public.can_see_profit())
    and (a.active or exists (select 1 from moved m where m.account_id = a.id and m.pay_date between p_from and p_to))
  union all
  -- payments in the period with no account, by mode
  select null, 'No account chosen · ' || m.mode, m.mode, null, null,
         sum(case when m.direction = 'in' then greatest(m.amount, 0) else greatest(-m.amount, 0) end),
         sum(case when m.direction = 'out' then greatest(m.amount, 0) else greatest(-m.amount, 0) end),
         null, count(*)
  from moved m
  where (public.is_boss() or public.can_see_profit()) and m.account_id is null and m.pay_date between p_from and p_to
  group by m.mode
$$;

create or replace function public.report_cashbook_lines(p_from date, p_to date, p_account uuid default null)
returns table (pay_date date, account text, received numeric, paid numeric, party text, max_id text, case_id uuid, supplier_id uuid, reference text, kind text)
language sql stable security definer set search_path = public as $$
  select p.pay_date,
         coalesce(a.name || coalesce(' ••' || a.last4, ''), 'No account · ' || p.mode),
         case when p.direction = 'in' then greatest(p.amount, 0) else greatest(-p.amount, 0) end,
         case when p.direction = 'out' then greatest(p.amount, 0) else greatest(-p.amount, 0) end,
         case when p.direction = 'in' then cu.full_name else s.name end,
         c.max_id, p.case_id, p.supplier_id, p.reference,
         case when p.direction = 'in' and p.amount > 0 then 'Client payment' when p.direction = 'in' then 'Refund to client'
              when p.amount > 0 then 'Supplier payment' else 'Refund from supplier' end
  from public.payments p
  left join public.money_accounts a on a.id = p.account_id
  left join public.cases c on c.id = p.case_id
  left join public.customers cu on cu.id = c.customer_id
  left join public.suppliers s on s.id = p.supplier_id
  where (public.is_boss() or public.can_see_profit())
    and p.mode <> 'opening' and p.pay_date between p_from and p_to
    and (p_account is null or p.account_id = p_account)
    and (a.id is null or p.pay_date >= a.opening_date)
  order by p.pay_date, p.created_at
$$;

revoke execute on function public.report_cashbook_summary(date, date) from public, anon;
grant execute on function public.report_cashbook_summary(date, date) to authenticated;
revoke execute on function public.report_cashbook_lines(date, date, uuid) from public, anon;
grant execute on function public.report_cashbook_lines(date, date, uuid) to authenticated;
