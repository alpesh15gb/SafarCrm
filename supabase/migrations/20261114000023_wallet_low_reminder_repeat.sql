-- Wallet "Top up" reminder could not come back the same day (found walking the live flow, 2026-11-13). Additive.
-- The reminder's key carried only the date, so once a top-up had closed it, a second drop below the alert on the same
-- day hit the closed reminder's key and created nothing. Now: an open reminder is kept and its balance refreshed;
-- if none is open, a new one is made with a key of its own.
create or replace function private.wallet_check_low(p_supplier uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.suppliers; bal numeric; msg text;
begin
  select * into s from public.suppliers where id = p_supplier;
  if s.id is null then return; end if;
  bal := private.wallet_balance(p_supplier);
  if s.terms = 'wallet' and s.wallet_alert_below is not null and bal < s.wallet_alert_below then
    msg := 'Top up ' || s.name || ' wallet: balance ₹' || to_char(bal, 'FM99,99,99,990') || ' (alert below ₹' || to_char(s.wallet_alert_below, 'FM99,99,99,990') || ')';
    update public.tasks set title = msg
     where auto_key like 'walletlow:' || s.id || ':%' and status <> 'done' and title is distinct from msg;
    if not exists (select 1 from public.tasks where auto_key like 'walletlow:' || s.id || ':%' and status <> 'done') then
      perform private.add_auto_task('walletlow:' || s.id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), msg, null, null, public.first_boss());
    end if;
  else
    update public.tasks set status = 'done', notes = coalesce(notes || chr(10), '') || 'Closed automatically: wallet topped up.'
     where auto_key like 'walletlow:' || s.id || ':%' and status <> 'done';
  end if;
end $$;
