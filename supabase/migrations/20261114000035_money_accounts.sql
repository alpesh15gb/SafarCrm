-- Money accounts (owner, 2026-11-18): set up the agency's bank accounts, credit cards, cash in hand and UPI, and
-- say on every payment which one the money went into or came out of. The boss sees each account's balance.
-- A first step towards the ledger in the accounting plan. Additive: old payments keep their mode, no account.

create table if not exists public.money_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('bank', 'card', 'cash', 'upi')),
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  opening_balance numeric(12,2) not null default 0,
  opening_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  active boolean not null default true,
  sort int not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.money_accounts enable row level security;
drop policy if exists money_accounts_select on public.money_accounts;
create policy money_accounts_select on public.money_accounts for select to authenticated using (public.is_team());
drop policy if exists money_accounts_write on public.money_accounts;
create policy money_accounts_write on public.money_accounts for all to authenticated using (public.is_boss()) with check (public.is_boss());

alter table public.payments add column if not exists account_id uuid references public.money_accounts (id) on delete restrict;
create index if not exists payments_account_idx on public.payments (account_id);

-- a starting point the office always has
insert into public.money_accounts (name, kind, sort)
select 'Cash in hand', 'cash', 0 where not exists (select 1 from public.money_accounts);

-- the mode a payment is recorded with follows its account (cash, bank, card, UPI); a cheque stays a cheque
create or replace function private.payment_mode_from_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if new.account_id is not null and new.mode is distinct from 'cheque' and new.mode is distinct from 'opening' then
    select kind into k from public.money_accounts where id = new.account_id;
    if k is not null then new.mode := k; end if;
  end if;
  return new;
end $$;
drop trigger if exists t_payment_mode_from_account on public.payments;
create trigger t_payment_mode_from_account before insert or update of account_id on public.payments
  for each row execute function private.payment_mode_from_account();

-- balance per account: opening + money in − money out (a card's balance is what was spent on it, as a negative)
create or replace function public.money_account_balances()
returns table (id uuid, name text, kind text, last4 text, active boolean, opening_balance numeric, money_in numeric, money_out numeric, balance numeric, payments bigint)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, a.kind, a.last4, a.active, a.opening_balance,
         coalesce(sum(p.amount) filter (where p.direction = 'in'), 0)
           + coalesce(-sum(p.amount) filter (where p.direction = 'out' and p.amount < 0), 0) as money_in,
         coalesce(sum(p.amount) filter (where p.direction = 'out' and p.amount > 0), 0)
           + coalesce(-sum(p.amount) filter (where p.direction = 'in' and p.amount < 0), 0) as money_out,
         a.opening_balance + coalesce(sum(case when p.direction = 'in' then p.amount else -p.amount end), 0) as balance,
         count(p.id)
  from public.money_accounts a
  left join public.payments p on p.account_id = a.id and p.pay_date >= a.opening_date
  where public.is_boss() or public.can_see_profit()
  group by a.id
  order by a.active desc, a.sort, a.name
$$;
revoke execute on function public.money_account_balances() from public, anon;
grant execute on function public.money_account_balances() to authenticated;

-- supplier payments go through record_supplier_payment (one transaction with its MAX ID amounts); this sets the
-- account on the payment it just made
create or replace function public.set_payment_account(p_payment uuid, p_account uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_boss() or public.can_see_profit()) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_account is not null and not exists (select 1 from public.money_accounts where id = p_account and active) then
    raise exception 'account_inactive: choose an active account' using errcode = 'P0001';
  end if;
  update public.payments set account_id = p_account
   where id = p_payment and direction = 'out' and (created_by = auth.uid() or public.is_boss());
end $$;
revoke execute on function public.set_payment_account(uuid, uuid) from public, anon;
grant execute on function public.set_payment_account(uuid, uuid) to authenticated;
