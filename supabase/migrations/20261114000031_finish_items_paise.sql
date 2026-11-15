-- Show the paise that keep a case open in its completion checklist.
do $$
declare
  definition text := pg_get_functiondef('private.case_finish_items(uuid)'::regprocedure);
begin
  if position('''FM99,99,99,990''' in definition) = 0 then
    raise exception 'case_finish_items money format does not look as expected';
  end if;
  execute replace(definition, '''FM99,99,99,990''', '''FM99,99,99,990.00''');
end $$;
