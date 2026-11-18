-- Agency logo (owner, 2026-11-18): uploaded by the boss in Settings, printed on estimates, invoices and receipts.
-- The file lives in the private "files" bucket; the path is kept here. Additive.
alter table public.settings add column if not exists logo_path text;
