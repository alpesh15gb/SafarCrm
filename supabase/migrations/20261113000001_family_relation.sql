-- Family members: remember how each member is related (Wife, Son, Mother...).
-- Only adds a nullable column; existing rows are untouched.
alter table public.customers add column if not exists relation text;
