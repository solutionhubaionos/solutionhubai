-- Data fix: the customer name "InterGlode Hotels" is a typo for "InterGlobe
-- Hotels". It is metadata, not code, so it is corrected here and both spellings
-- are linked in customer_aliases for older exports.
--
-- Scope measured on 2026-11-10 before writing this file:
--   content_items: 4 rows  (Hospitality Procurement Solutions.xlsx,
--                           IGH AR Agentic AI Solution V2.pptx,
--                           InterGlobe Hotels Roadmap.pptx,
--                           POV - Hotel procurement marketplace V4.pptx)
--   customers:     0 rows
--
-- Nothing is deleted. The UPDATE only touches rows whose customer_name is still
-- the misspelled value. Rollback is at the bottom, commented out.
set search_path = public, extensions;

insert into public.customer_aliases (alias, canonical)
values ('InterGlode Hotels', 'InterGlobe Hotels')
on conflict (lower(btrim(alias))) do update
  set canonical = excluded.canonical;

do $$
declare
  v_items integer;
  v_customers integer;
begin
  select count(*) into v_items
  from public.content_items
  where customer_name = 'InterGlode Hotels';

  select count(*) into v_customers
  from public.customers
  where name = 'InterGlode Hotels';

  raise notice 'customer name fix: % content_items, % customers rows', v_items, v_customers;

  update public.content_items
     set customer_name = 'InterGlobe Hotels'
   where customer_name = 'InterGlode Hotels';

  -- customers has (industry, lower(name)) unique, so skip instead of failing if
  -- the correctly spelled row already exists for that industry.
  update public.customers c
     set name = 'InterGlobe Hotels'
   where c.name = 'InterGlode Hotels'
     and not exists (
       select 1 from public.customers x
       where x.industry = c.industry
         and lower(x.name) = lower('InterGlobe Hotels')
     );
end
$$;

reset search_path;

-- Rollback:
--
-- update public.content_items
--    set customer_name = 'InterGlode Hotels'
--  where customer_name = 'InterGlobe Hotels';
-- delete from public.customer_aliases where alias = 'InterGlode Hotels';
