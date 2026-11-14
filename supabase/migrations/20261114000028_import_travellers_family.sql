-- Ticket import: travellers on one ticket can be linked as one family (owner, 2026-11-15). Additive.
-- With "family": true in the confirmation and two or more travellers:
--   - if any traveller is already in a family (the payer's first), that family is used; otherwise a new family is
--     created, named after the paying traveller's surname (or the first traveller's);
--   - every traveller not yet in a family joins it; someone already in another family is left where they are;
--   - in a newly created family the paying traveller (or the first) is marked "Head of family".
-- Companies are never family members. Only confirm_ticket_import changes (two small insertions).
do $$
declare
  def text := pg_get_functiondef('public.confirm_ticket_import(uuid, int, text, jsonb)'::regprocedure);
  decl_anchor text := $x$sup uuid; cost numeric;$x$;
  body_anchor text := $x$  -- ---------------------------------------------------------- sectors from the reviewed segments$x$;
  family_block text := $x$  -- travellers on one ticket as one family, when the reviewer asked for it
  if coalesce((p ->> 'family')::boolean, false) and array_length(people, 1) >= 2 then
    fam_head := case when payer = any(people) then payer else people[1] end;
    select c.family_id into fam from public.customers c
     where c.id = any(people) and c.family_id is not null
     order by (c.id = fam_head) desc, array_position(people, c.id) limit 1;
    if fam is null then
      insert into public.families (name)
      values (coalesce((select nullif(trim(coalesce(last_name, '')), '') from public.customers where id = fam_head),
                       (select full_name from public.customers where id = fam_head)))
      returning id into fam;
      update public.customers set relation = 'Head of family' where id = fam_head and relation is null;
    end if;
    update public.customers set family_id = fam
     where id = any(people) and family_id is null and customer_type <> 'corporate';
  end if;

$x$;
begin
  if position(decl_anchor in def) = 0 or position(body_anchor in def) = 0 then
    raise exception 'confirm_ticket_import does not look as expected; not changed';
  end if;
  def := replace(def, decl_anchor, decl_anchor || ' fam uuid; fam_head uuid;');
  def := replace(def, body_anchor, family_block || body_anchor);
  execute def;
end $$;
