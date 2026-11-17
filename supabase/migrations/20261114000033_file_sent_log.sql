-- A file sent to the client on WhatsApp or by email (owner, 2026-11-18) is recorded in the case's activity history:
-- who sent which file, how, and to which number or address. Additive.
create or replace function public.log_file_sent(p_file uuid, p_channel text, p_to text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.files; c public.cases;
begin
  if not public.is_team() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into f from public.files where id = p_file;
  if not found or f.case_id is null or not public.can_see_case(f.case_id) then return; end if;
  select * into c from public.cases where id = f.case_id;
  perform private.log_event('send', 'file', f.id, f.case_id, c.customer_id,
    f.file_name || ' sent ' || case p_channel when 'whatsapp' then 'on WhatsApp' else 'by email' end || ' to ' || left(coalesce(p_to, ''), 120));
end $$;

revoke execute on function public.log_file_sent(uuid, text, text) from public, anon;
grant execute on function public.log_file_sent(uuid, text, text) to authenticated;
