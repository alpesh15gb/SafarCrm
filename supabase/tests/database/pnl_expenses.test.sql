-- Filtering bookings retains each matching case's expenses exactly once.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(11);

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000032b1', 'boss@pnl.local', '{"role":"boss","full_name":"P&L Boss"}'),
  ('00000000-0000-0000-0000-0000000032a1', 'staff@pnl.local', '{"role":"staff","full_name":"P&L Staff"}');
update public.profiles set can_see_profit = false where id = '00000000-0000-0000-0000-0000000032a1';
update public.settings set auto_reminders = auto_reminders || '{"stage_tasks":false,"auto_stage":false,"auto_complete":false}'::jsonb where id = 1;
insert into public.customers (id, customer_type, first_name, mobile) values
  ('00000000-0000-0000-0000-00000032c001', 'individual', 'P&L Tester', '+919000032001');
insert into public.suppliers (id, name) values
  ('00000000-0000-0000-0000-00000032f001', 'P&L Hotel Supplier'),
  ('00000000-0000-0000-0000-00000032f002', 'P&L Flight Supplier');
insert into public.cases (id, customer_id, title, assigned_to, status, created_at) values
  ('00000000-0000-0000-0000-00000032ca01', '00000000-0000-0000-0000-00000032c001', 'Hotel-only expense regression', '00000000-0000-0000-0000-0000000032a1', 'booked', '2026-11-16T10:00:00Z'),
  ('00000000-0000-0000-0000-00000032ca02', '00000000-0000-0000-0000-00000032c001', 'Mixed services expense regression', '00000000-0000-0000-0000-0000000032a1', 'booked', '2026-11-16T10:00:00Z');
insert into public.booking_lines (case_id, service, status, supplier_id, supplier_cost, selling_price, commission_value, details) values
  ('00000000-0000-0000-0000-00000032ca01', 'hotel', 'confirmed', '00000000-0000-0000-0000-00000032f001', 300, 1000, 36, '{}'),
  ('00000000-0000-0000-0000-00000032ca02', 'hotel', 'confirmed', '00000000-0000-0000-0000-00000032f001', 300, 1000, 36, '{}'),
  ('00000000-0000-0000-0000-00000032ca02', 'flight', 'confirmed', '00000000-0000-0000-0000-00000032f002', 400, 500, 0, '{}');
insert into public.expenses (case_id, name, amount) values
  ('00000000-0000-0000-0000-00000032ca01', 'Case expense', 20.50),
  ('00000000-0000-0000-0000-00000032ca02', 'Case expense', 20.50);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000032b1","role":"authenticated"}';
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30') where case_id = '00000000-0000-0000-0000-00000032ca01'),
  array[20.50, 715.50]::numeric[], 'unfiltered hotel-only P&L includes the case expense');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel') where case_id = '00000000-0000-0000-0000-00000032ca01'),
  array[20.50, 715.50]::numeric[], 'Hotel filter preserves expenses and profit on a hotel-only case');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_supplier => '00000000-0000-0000-0000-00000032f001') where case_id = '00000000-0000-0000-0000-00000032ca01'),
  array[20.50, 715.50]::numeric[], 'sole supplier filter preserves expenses and profit');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel', p_supplier => '00000000-0000-0000-0000-00000032f001') where case_id = '00000000-0000-0000-0000-00000032ca01'),
  array[20.50, 715.50]::numeric[], 'combined matching filters preserve expenses and profit');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30') where case_id = '00000000-0000-0000-0000-00000032ca02'),
  array[20.50, 815.50]::numeric[], 'mixed-service unfiltered P&L deducts expenses once');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel') where case_id = '00000000-0000-0000-0000-00000032ca02'),
  array[20.50, 715.50]::numeric[], 'partial service report deducts full case expenses without inventing an allocation');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'flight') where case_id = '00000000-0000-0000-0000-00000032ca02'),
  array[20.50, 79.50]::numeric[], 'the other service also displays its profit after full case expenses');
select is((select count(*)::int from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel', p_supplier => '00000000-0000-0000-0000-00000032f002', p_customer => '00000000-0000-0000-0000-00000032c001')),
  0, 'combined filters must match the same booking, so unrelated bookings cannot create phantom losses');
select is((select sum(expenses) from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel', p_customer => '00000000-0000-0000-0000-00000032c001')),
  41::numeric, 'filtered totals count each matching case expense once');
insert into public.booking_lines (case_id, service, status, supplier_id, supplier_cost, selling_price, details) values
  ('00000000-0000-0000-0000-00000032ca02', 'hotel', 'confirmed', '00000000-0000-0000-0000-00000032f001', 150, 200, '{}');
select is((select array[expenses, profit] from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel') where case_id = '00000000-0000-0000-0000-00000032ca02'),
  array[20.50, 765.50]::numeric[], 'multiple matching bookings still deduct the case expense only once');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000032a1","role":"authenticated"}';
select throws_ok($$select * from public.report_pnl('2026-11-01', '2026-11-30', p_service => 'hotel')$$,
  'P0001', 'You do not have access to profit reports', 'staff without profit rights still cannot run the filtered P&L');

select * from finish();
rollback;
