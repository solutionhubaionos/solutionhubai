-- Phase 4: fuzzy customer entity matching.
--
-- Customer names are free text on content_items, typed by whoever uploaded the
-- file, so "InterGlobe", "Interglode" and "InterGlobe Hotels" must resolve to
-- the same customer. pg_trgm similarity handles the typo case; a small alias
-- table handles genuine renames and abbreviations.
--
-- Additive and idempotent: safe to re-run. Apply after 0019.
-- Rollback is at the bottom of this file, commented out.
set search_path = public, extensions;

create extension if not exists pg_trgm with schema extensions;

-- Trigram indexes back similarity() over the columns that carry customer names
-- and document titles, so resolution and title lookups stay index scans.
create index if not exists content_items_customer_name_trgm_idx
  on public.content_items using gin (customer_name gin_trgm_ops);

create index if not exists content_items_title_trgm_idx
  on public.content_items using gin (title gin_trgm_ops);

create index if not exists content_items_file_name_trgm_idx
  on public.content_items using gin (file_name gin_trgm_ops);

create index if not exists customers_name_trgm_idx
  on public.customers using gin (name gin_trgm_ops);

-- Aliases ------------------------------------------------------------------
--
-- Canonical names stay in content_items/customers. An alias row only records
-- another spelling that means the same customer; writes happen from the SQL
-- editor or the service role, reads are open to allowed library users.

create table if not exists public.customer_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null check (btrim(alias) <> ''),
  canonical text not null check (btrim(canonical) <> ''),
  created_at timestamptz not null default now()
);

create unique index if not exists customer_aliases_alias_uq
  on public.customer_aliases (lower(btrim(alias)));

create index if not exists customer_aliases_canonical_idx
  on public.customer_aliases (lower(btrim(canonical)));

alter table public.customer_aliases enable row level security;

grant select on public.customer_aliases to authenticated;
grant all on public.customer_aliases to service_role;

drop policy if exists "Allowed users read customer aliases" on public.customer_aliases;
create policy "Allowed users read customer aliases" on public.customer_aliases
  for select to authenticated
  using (public.is_allowed_email(auth.jwt() ->> 'email'));

comment on table public.customer_aliases is
  'Alternate spellings for a customer, e.g. a typo in an upload. Canonical names stay in content_items/customers.';

-- Matching -----------------------------------------------------------------
--
-- Security invoker: RLS on content_items and customers decides which known
-- names the caller may see. The caller passes candidate spans from its query;
-- this returns the closest known customer with the alias resolved.

create or replace function public.match_customer_entities(
  p_candidates text[],
  p_threshold double precision default 0.4,
  p_limit integer default 3
)
returns table (
  canonical text,
  matched_name text,
  score double precision,
  spellings text[]
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with known as (
    select distinct on (lower(btrim(name))) btrim(name) as name
    from (
      select ci.customer_name as name
      from public.content_items ci
      where nullif(btrim(coalesce(ci.customer_name, '')), '') is not null
      union all
      select c.name from public.customers c
      union all
      select a.canonical from public.customer_aliases a
      union all
      select a.alias from public.customer_aliases a
    ) names
    where nullif(btrim(name), '') is not null
    order by lower(btrim(name))
  ),
  scored as (
    select k.name, similarity(k.name, btrim(candidate)) as score
    from known k
    cross join unnest(coalesce(p_candidates, '{}'::text[])) as candidate
    where nullif(btrim(candidate), '') is not null
  ),
  best as (
    select s.name, max(s.score) as score
    from scored s
    group by s.name
  ),
  resolved as (
    select
      coalesce(a.canonical, b.name) as canonical,
      b.name as matched_name,
      b.score
    from best b
    left join public.customer_aliases a
      on lower(btrim(a.alias)) = lower(btrim(b.name))
    where b.score >= greatest(least(coalesce(p_threshold, 0.4), 1.0), 0.0)
  )
  select
    r.canonical,
    r.matched_name,
    r.score,
    -- Every spelling that means this customer, so the retrieval filter can
    -- recognise a chunk whose metadata still carries the old spelling.
    array(
      select distinct variant
      from (
        select r.matched_name as variant
        union all
        select r.canonical
        union all
        select al.alias
        from public.customer_aliases al
        where lower(btrim(al.canonical)) = lower(btrim(r.canonical))
        union all
        select al.canonical
        from public.customer_aliases al
        where lower(btrim(al.alias)) = lower(btrim(r.matched_name))
      ) variants
      where nullif(btrim(variant), '') is not null
    ) as spellings
  from resolved r
  order by r.score desc, r.matched_name
  limit least(greatest(coalesce(p_limit, 3), 1), 10);
$$;

comment on function public.match_customer_entities(text[], double precision, integer) is
  'Best pg_trgm matches between query candidate spans and known customer names/aliases. Security invoker.';

revoke all on function public.match_customer_entities(text[], double precision, integer)
  from public, anon;
grant execute on function public.match_customer_entities(text[], double precision, integer)
  to authenticated;

reset search_path;

-- Rollback (run by hand if this migration must be undone; no data is deleted by
-- 0020 itself):
--
-- revoke execute on function public.match_customer_entities(text[], double precision, integer)
--   from authenticated;
-- drop function if exists public.match_customer_entities(text[], double precision, integer);
-- drop policy if exists "Allowed users read customer aliases" on public.customer_aliases;
-- drop table if exists public.customer_aliases;
-- drop index if exists public.content_items_customer_name_trgm_idx;
-- drop index if exists public.content_items_title_trgm_idx;
-- drop index if exists public.content_items_file_name_trgm_idx;
-- drop index if exists public.customers_name_trgm_idx;
-- drop extension if exists pg_trgm;
