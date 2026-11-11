-- "Read again" should show the new reading. Before, a re-read kept any existing draft, even one nobody had edited,
-- so the screen kept the old values. Now a draft is replaced unless a person has saved changes to it
-- (draft_saved_by set); a reviewer's saved edits are still never overwritten.
create or replace function public.finish_ticket_import(
  p_id uuid, p_worker text, p_ok boolean, p_extraction jsonb default null, p_provider text default null,
  p_parser_version text default null, p_schema_version text default null, p_pages int default null,
  p_error_code text default null, p_error_summary text default null, p_retryable boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare i public.ticket_imports; replace_draft boolean;
begin
  select * into i from public.ticket_imports where id = p_id for update;
  if not found or i.status <> 'processing' or i.locked_by is distinct from p_worker then
    return 'lost_lease';
  end if;
  if p_ok then
    replace_draft := i.draft is null or i.draft_saved_by is null;
    update public.ticket_imports
       set status = 'needs_review', extraction = p_extraction, extracted_at = now(),
           draft = case when replace_draft then p_extraction else draft end,
           draft_version = draft_version + case when replace_draft then 1 else 0 end,
           provider = p_provider, parser_version = p_parser_version, schema_version = p_schema_version, pages = coalesce(p_pages, pages),
           locked_by = null, locked_until = null, error_code = null, error_summary = null
     where id = p_id;
    return 'needs_review';
  end if;
  if p_retryable and i.attempts < i.max_attempts then
    update public.ticket_imports
       set status = 'received', locked_by = null, locked_until = null, pages = coalesce(p_pages, pages),
           next_attempt_at = now() + make_interval(mins => power(2, i.attempts)::int),
           error_code = left(p_error_code, 40), error_summary = left(p_error_summary, 300), provider = coalesce(p_provider, provider)
     where id = p_id;
    return 'retry';
  end if;
  update public.ticket_imports
     set status = 'failed', locked_by = null, locked_until = null, pages = coalesce(p_pages, pages),
         error_code = left(p_error_code, 40), error_summary = left(p_error_summary, 300), provider = coalesce(p_provider, provider)
   where id = p_id;
  return 'failed';
end $$;

revoke execute on function public.finish_ticket_import(uuid, text, boolean, jsonb, text, text, text, int, text, text, boolean) from public, anon, authenticated;
grant execute on function public.finish_ticket_import(uuid, text, boolean, jsonb, text, text, text, int, text, text, boolean) to service_role;
