-- Opening balance for supplier wallets (owner, 2026-11-13). Additive.
-- Money already sitting in a supplier wallet before the agency started using the CRM is entered once as an
-- "Opening balance": a supplier payment with mode 'opening', so it is not mistaken for money paid out that day.
-- Only for payments to suppliers; a client payment can't use it.
alter table public.payments drop constraint if exists payments_mode_check;
alter table public.payments add constraint payments_mode_check check (mode in ('cash', 'upi', 'bank', 'card', 'cheque', 'opening'));
alter table public.payments drop constraint if exists payments_opening_out_only;
alter table public.payments add constraint payments_opening_out_only check (mode <> 'opening' or (direction = 'out' and amount > 0));
