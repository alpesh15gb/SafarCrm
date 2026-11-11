-- Measures how well ticket reading works, so the agency can see whether it saves time (AI research, step 1).
-- When an import is confirmed, the values the model read (extraction) are compared with what the reviewer confirmed
-- (draft). Only field paths and counts are stored, never the values themselves. Additive; nothing else changes.

alter table public.ticket_imports add column if not exists review_stats jsonb;

-- every { "value": ... } leaf in a draft, by path (segments.0.from, passengers.1.tickets.0.number, airline_pnrs.0, ...)
create or replace function private.draft_values(j jsonb) returns table (path text, val text)
language sql immutable as $$
  with recursive t(path, v) as (
    select ''::text, j
    union all
    select case when t.path = '' then x.k else t.path || '.' || x.k end, x.c
    from t, lateral (
      select e.key as k, e.value as c from jsonb_each(case when jsonb_typeof(t.v) = 'object' then t.v else '{}'::jsonb end) e
      union all
      select (a.ord - 1)::text, a.value from jsonb_array_elements(case when jsonb_typeof(t.v) = 'array' then t.v else '[]'::jsonb end) with ordinality a(value, ord)
    ) x
    where not (jsonb_typeof(t.v) = 'object' and t.v ? 'value')
  )
  select t.path, coalesce(trim(t.v ->> 'value'), '')
  from t
  where jsonb_typeof(t.v) = 'object' and t.v ? 'value' and jsonb_typeof(t.v -> 'value') not in ('object', 'array')
    and t.path not like 'masked.%'
$$;

create or replace function private.import_review_stats(p_read jsonb, p_final jsonb, p_read_at timestamptz) returns jsonb
language sql stable as $$
  with a as (select path, val from private.draft_values(p_read)),
       b as (select path, val from private.draft_values(p_final)),
       j as (select coalesce(a.path, b.path) as path, coalesce(a.val, '') as was, coalesce(b.val, '') as got
             from a full join b on a.path = b.path)
  select jsonb_build_object(
    'fields_read', (select count(*) from j where was <> ''),
    'fields_final', (select count(*) from j where got <> ''),
    'fields_changed', (select count(*) from j where was is distinct from got),
    'filled_by_hand', (select count(*) from j where was = '' and got <> ''),
    'changed_paths', coalesce((select jsonb_agg(path order by path) from j where was is distinct from got), '[]'::jsonb),
    'read_from', p_read ->> 'read_from',
    'seconds_read_to_confirm', case when p_read_at is null then null else extract(epoch from now() - p_read_at)::int end
  )
$$;

create or replace function private.import_review_stats_on_confirm() returns trigger
language plpgsql as $$
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' and new.extraction is not null then
    new.review_stats := private.import_review_stats(new.extraction, new.draft, new.extracted_at);
  end if;
  return new;
end $$;
drop trigger if exists t_import_review_stats on public.ticket_imports;
create trigger t_import_review_stats before update on public.ticket_imports
  for each row execute function private.import_review_stats_on_confirm();

-- imports confirmed before this migration (time to confirm is unknown for them)
update public.ticket_imports
   set review_stats = private.import_review_stats(extraction, draft, null)
 where status = 'confirmed' and review_stats is null and extraction is not null;

-- Accuracy over the last p_days, for imports the caller can see (row security applies: security invoker).
-- field groups indices away: segments.*.from, passengers.*.tickets.*.number
create or replace function public.import_accuracy(p_days int default 30) returns jsonb
language sql stable security invoker set search_path = public as $$
  with i as (
    select review_stats s from public.ticket_imports
    where status = 'confirmed' and review_stats is not null and reviewed_at >= now() - make_interval(days => greatest(p_days, 1))
  ),
  f as (
    select regexp_replace(p #>> '{}', '\.\d+(\.|$)', '.*\1', 'g') as field, count(*) as n
    from i, jsonb_array_elements(i.s -> 'changed_paths') p group by 1
  )
  select jsonb_build_object(
    'imports', (select count(*) from i),
    'untouched', (select count(*) from i where (s ->> 'fields_changed')::int = 0),
    'fields_read', (select coalesce(sum((s ->> 'fields_read')::int), 0) from i),
    'fields_changed', (select coalesce(sum((s ->> 'fields_changed')::int), 0) from i),
    'median_minutes_to_confirm', (select round((percentile_cont(0.5) within group (order by (s ->> 'seconds_read_to_confirm')::numeric) / 60)::numeric, 1)
                                  from i where s ? 'seconds_read_to_confirm' and s ->> 'seconds_read_to_confirm' is not null),
    'most_corrected', coalesce((select jsonb_agg(jsonb_build_object('field', field, 'times', n) order by n desc, field)
                                from (select * from f order by n desc, field limit 8) top), '[]'::jsonb)
  )
$$;
revoke execute on function public.import_accuracy(int) from public, anon;
grant execute on function public.import_accuracy(int) to authenticated;
