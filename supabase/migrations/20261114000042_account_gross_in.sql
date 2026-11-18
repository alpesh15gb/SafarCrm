-- QA, 2026-11-18: Accounts showed "in ₹0 · out ₹12" for Cash in hand (two receipts of ₹12, refunded), while the
-- cash book showed ₹12 in and ₹12 out. "Money in" added up client payments including refunds (negative), which
-- were then counted again under "money out". Money in is now only receipts, as in the cash book. Balance unchanged.
create or replace function public.money_account_balances()
returns table (id uuid, name text, kind text, last4 text, active boolean, opening_balance numeric, money_in numeric, money_out numeric, balance numeric, payments bigint)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, a.kind, a.last4, a.active, a.opening_balance,
         coalesce(sum(p.amount) filter (where p.direction = 'in' and p.amount > 0), 0)
           + coalesce(-sum(p.amount) filter (where p.direction = 'out' and p.amount < 0), 0) as money_in,
         coalesce(sum(p.amount) filter (where p.direction = 'out' and p.amount > 0), 0)
           + coalesce(-sum(p.amount) filter (where p.direction = 'in' and p.amount < 0), 0) as money_out,
         a.opening_balance + coalesce(sum(case when p.direction = 'in' then p.amount else -p.amount end), 0) as balance,
         count(p.id)
  from public.money_accounts a
  left join public.payments p on p.account_id = a.id and p.pay_date >= a.opening_date and p.mode <> 'opening'
  where public.is_boss() or public.can_see_profit()
  group by a.id
  order by a.active desc, a.sort, a.name
$$;
