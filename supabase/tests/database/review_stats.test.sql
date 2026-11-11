-- Review statistics compare what was read with what was confirmed, by path, without storing values. Rolled back.
begin;
create extension if not exists pgtap;
select plan(6);

select is(
  (select count(*)::int from private.draft_values('{"issue_date":{"value":"2026-11-01"},"segments":[{"key":"s1","from":{"value":"MUM"},"to":{"value":"DEL"}}],"airline_pnrs":[{"value":"ABC123","page":1}],"masked":{"mobile":1}}'::jsonb)),
  4, 'every value leaf is found, keys and mask counts are not');

select is(
  (select string_agg(path, ',' order by path) from private.draft_values('{"segments":[{"from":{"value":"MUM"}}],"passengers":[{"tickets":[{"number":{"value":"1"}}]}]}'::jsonb)),
  'passengers.0.tickets.0.number,segments.0.from', 'paths are dotted with array positions');

select is(
  private.import_review_stats(
    '{"segments":[{"from":{"value":"MUM"},"to":{"value":"DEL"},"dep_time":{"value":""}}],"read_from":"pdf text layer"}'::jsonb,
    '{"segments":[{"from":{"value":"BOM"},"to":{"value":"DEL"},"dep_time":{"value":"09:05"}}]}'::jsonb, null) - 'seconds_read_to_confirm',
  '{"fields_read":2,"fields_final":3,"fields_changed":2,"filled_by_hand":1,"changed_paths":["segments.0.dep_time","segments.0.from"],"read_from":"pdf text layer"}'::jsonb,
  'a corrected airport and a time filled by hand are both counted');

select is(
  (private.import_review_stats('{"issue_date":{"value":"x"}}'::jsonb, '{"issue_date":{"value":"x"}}'::jsonb, null) ->> 'fields_changed')::int,
  0, 'an untouched draft has no changes');

select ok(
  (private.import_review_stats('{"a":{"value":"x"}}'::jsonb, '{"a":{"value":"y"}}'::jsonb, now() - interval '5 minutes') ->> 'seconds_read_to_confirm')::int between 299 and 301,
  'time from reading to confirming is recorded');

select is(
  (select regexp_replace('passengers.0.tickets.12.number', '\.\d+(\.|$)', '.*\1', 'g')),
  'passengers.*.tickets.*.number', 'field grouping removes positions');

select * from finish();
rollback;
