-- Phase 3: first-class entities and claims for deck planning.
--
-- Deck retrieval groups evidence by party and the writer may only use numbers
-- that exist in a cited passage. That needs two things the library did not
-- have: canonical entities (companies, airports, concepts) and a claim row per
-- extracted figure, linked to its chunk and entity.
--
-- Additive and idempotent: safe to re-run. Apply after 0022. The migration
-- seeds entities from data that already exists (customers, content metadata and
-- industries); it never seeds free-form strings from a chat brief.
--
-- Rollback is at the bottom, commented out.
set search_path = public, extensions;

create extension if not exists pg_trgm with schema extensions;

-- Entities -----------------------------------------------------------------
--
-- `entity_type` rather than `type` because `type` reads badly in generated SQL
-- and in PostgREST filters. `concept` exists for retrieval, but deck parties
-- only ever come from company/airport rows.
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  entity_type text not null default 'concept'
    check (entity_type in ('company', 'airport', 'concept')),
  aliases text[] not null default '{}'::text[],
  sector text,
  industry text,
  created_at timestamptz not null default now()
);

create unique index if not exists entities_name_uq
  on public.entities (lower(btrim(name)));

create index if not exists entities_name_trgm_idx
  on public.entities using gin (name gin_trgm_ops);

create index if not exists entities_type_idx
  on public.entities (entity_type);

comment on table public.entities is
  'Canonical organisations and concepts used for retrieval and party validation. Deck parties must be company or airport.';

-- Claims -------------------------------------------------------------------
--
-- One row per figure extracted from a chunk. `value_text` keeps the exact
-- wording ("£2.4m", "12 weeks", "5–15%") so a slide can never round or invent a
-- number; min/max let charts plot a real range without choosing a midpoint.
create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.content_items (id) on delete cascade,
  chunk_id uuid references public.document_chunks (id) on delete cascade,
  entity_id uuid references public.entities (id) on delete set null,
  metric text,
  value_text text not null check (btrim(value_text) <> ''),
  value_min numeric,
  value_max numeric,
  unit text,
  context text,
  source_title text,
  source_year integer,
  created_at timestamptz not null default now()
);

create index if not exists claims_chunk_idx on public.claims (chunk_id);
create index if not exists claims_entity_idx on public.claims (entity_id);
create index if not exists claims_doc_idx on public.claims (doc_id);
create unique index if not exists claims_chunk_value_uq
  on public.claims (
    chunk_id,
    lower(btrim(value_text)),
    coalesce(lower(btrim(metric)), '')
  );

comment on table public.claims is
  'Code-owned numeric claims extracted from a chunk. Slides reference these rows; a figure outside this table cannot be rendered.';

-- Chunk → entity links -----------------------------------------------------
create table if not exists public.chunk_entities (
  chunk_id uuid not null references public.document_chunks (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (chunk_id, entity_id)
);

create index if not exists chunk_entities_entity_idx
  on public.chunk_entities (entity_id);

comment on table public.chunk_entities is
  'Which canonical entities a passage mentions. Retrieval groups by this link, not by free-text customer metadata.';

-- Enrichment and brand assets ---------------------------------------------
create table if not exists public.entity_facts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  fact_type text not null check (fact_type in ('scale', 'strategy', 'recent', 'other')),
  text text not null check (btrim(text) <> ''),
  source_url text,
  fetched_at timestamptz not null default now()
);

create index if not exists entity_facts_entity_idx
  on public.entity_facts (entity_id, fetched_at desc);

create table if not exists public.entity_assets (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  kind text not null check (kind in ('logo', 'image')),
  path text not null check (btrim(path) <> ''),
  created_at timestamptz not null default now()
);

create unique index if not exists entity_assets_path_uq
  on public.entity_assets (kind, path);

create index if not exists entity_assets_entity_idx
  on public.entity_assets (entity_id, kind);

-- Access -------------------------------------------------------------------
-- The library is readable by allowed members; entity/claim writes happen from
-- the worker or the service role, never the browser.
alter table public.entities enable row level security;
alter table public.claims enable row level security;
alter table public.chunk_entities enable row level security;
alter table public.entity_facts enable row level security;
alter table public.entity_assets enable row level security;

grant select on public.entities to authenticated;
grant select on public.claims to authenticated;
grant select on public.chunk_entities to authenticated;
grant select on public.entity_facts to authenticated;
grant select on public.entity_assets to authenticated;
grant all on public.entities to service_role;
grant all on public.claims to service_role;
grant all on public.chunk_entities to service_role;
grant all on public.entity_facts to service_role;
grant all on public.entity_assets to service_role;

drop policy if exists "Allowed users read entities" on public.entities;
create policy "Allowed users read entities" on public.entities
  for select to authenticated
  using (public.is_allowed_email(auth.jwt() ->> 'email'));

drop policy if exists "Allowed users read claims" on public.claims;
create policy "Allowed users read claims" on public.claims
  for select to authenticated
  using (
    public.is_allowed_email(auth.jwt() ->> 'email')
    and exists (select 1 from public.content_items ci where ci.id = claims.doc_id)
  );

drop policy if exists "Allowed users read chunk entities" on public.chunk_entities;
create policy "Allowed users read chunk entities" on public.chunk_entities
  for select to authenticated
  using (
    public.is_allowed_email(auth.jwt() ->> 'email')
    and exists (select 1 from public.document_chunks dc where dc.id = chunk_entities.chunk_id)
  );

drop policy if exists "Allowed users read entity facts" on public.entity_facts;
create policy "Allowed users read entity facts" on public.entity_facts
  for select to authenticated
  using (public.is_allowed_email(auth.jwt() ->> 'email'));

drop policy if exists "Allowed users read entity assets" on public.entity_assets;
create policy "Allowed users read entity assets" on public.entity_assets
  for select to authenticated
  using (public.is_allowed_email(auth.jwt() ->> 'email'));

-- Seed from existing data --------------------------------------------------
-- Customers are companies, content metadata can carry companies that were never
-- saved as a customer row, and industries are concepts (useful for retrieval,
-- never valid deck parties). Free-form brief strings are deliberately absent.
insert into public.entities (name, entity_type, industry)
select distinct btrim(c.name), 'company', c.industry
from public.customers c
where nullif(btrim(c.name), '') is not null
  and not exists (
    select 1 from public.entities e where lower(btrim(e.name)) = lower(btrim(c.name))
  )
on conflict do nothing;

insert into public.entities (name, entity_type, industry)
select distinct btrim(ci.customer_name), 'company', ci.industry
from public.content_items ci
where nullif(btrim(coalesce(ci.customer_name, '')), '') is not null
  and not exists (
    select 1
    from public.entities e
    where lower(btrim(e.name)) = lower(btrim(ci.customer_name))
  )
on conflict do nothing;

insert into public.entities (name, entity_type, industry)
select distinct btrim(i.name), 'concept', i.slug
from public.industries i
where nullif(btrim(i.name), '') is not null
  and not exists (
    select 1 from public.entities e where lower(btrim(e.name)) = lower(btrim(i.name))
  )
on conflict do nothing;

-- An alias belongs to its canonical entity, not to a second entity row.
update public.entities e
set aliases = e.aliases || missing.aliases
from (
  select
    lower(btrim(a.canonical)) as canonical_key,
    array_agg(distinct btrim(a.alias)) as aliases
  from public.customer_aliases a
  where nullif(btrim(a.alias), '') is not null
    and lower(btrim(a.alias)) <> lower(btrim(a.canonical))
  group by lower(btrim(a.canonical))
) as missing
where lower(btrim(e.name)) = missing.canonical_key
  and not (e.aliases @> missing.aliases);

-- Matching -----------------------------------------------------------------
-- Same shape as match_customer_entities (0020), but canonical rows come from
-- entities and aliases are part of the score. Security invoker: the caller's
-- RLS still decides what is visible.
create or replace function public.match_entities(
  p_candidates text[],
  p_threshold double precision default 0.4,
  p_limit integer default 5
)
returns table (
  id uuid,
  name text,
  entity_type text,
  industry text,
  matched_name text,
  score double precision,
  spellings text[]
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with candidates as (
    select distinct btrim(cand.value) as candidate
    from unnest(coalesce(p_candidates, '{}'::text[])) as cand(value)
    where nullif(btrim(cand.value), '') is not null
  ),
  scored as (
    select
      e.id,
      e.name,
      e.entity_type,
      e.industry,
      c.candidate,
      greatest(
        similarity(e.name, c.candidate),
        coalesce((
          select max(similarity(a.alias, c.candidate))
          from unnest(e.aliases) as a(alias)
          where nullif(btrim(a.alias), '') is not null
        ), 0)
      ) as score
    from public.entities e
    cross join candidates c
  ),
  best as (
    select
      s.id,
      s.name,
      s.entity_type,
      s.industry,
      (array_agg(s.candidate order by s.score desc))[1] as matched_name,
      max(s.score) as score
    from scored s
    group by s.id, s.name, s.entity_type, s.industry
  )
  select
    b.id,
    b.name,
    b.entity_type,
    b.industry,
    b.matched_name,
    b.score,
    (
      select array_agg(distinct spelling)
      from (
        select b.name as spelling
        union all
        select b.matched_name
        union all
        select al.alias
        from public.entities e2
        cross join unnest(e2.aliases) as al(alias)
        where e2.id = b.id
      ) all_spellings
      where nullif(btrim(spelling), '') is not null
    ) as spellings
  from best b
  where b.score >= greatest(least(coalesce(p_threshold, 0.4), 1.0), 0.0)
  order by b.score desc, b.name
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

comment on function public.match_entities(text[], double precision, integer) is
  'Best pg_trgm matches between brief spans and canonical entities, including aliases. Security invoker.';

revoke all on function public.match_entities(text[], double precision, integer) from public, anon;
grant execute on function public.match_entities(text[], double precision, integer)
  to authenticated;

-- Worker attach ------------------------------------------------------------
-- The worker writes chunks in one transaction, so chunk ids do not exist in the
-- worker process until after replace_document_chunks. It then calls this RPC
-- with facts keyed by chunk_index; the function resolves the ids, upserts
-- entities and rewrites this document's claim/link rows. Re-running is safe.
create or replace function public.worker_attach_chunk_facts(
  p_content_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fact jsonb;
  entity jsonb;
  claim jsonb;
  v_chunk_id uuid;
  v_entity_id uuid;
  v_name text;
  v_entity_type text;
  v_entity_name text;
  v_claim_id uuid;
  v_links integer := 0;
  v_claims integer := 0;
begin
  if not public.is_ingestion_worker() then
    raise exception 'not authorized';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'array' then
    raise exception 'p_facts must be a JSON array';
  end if;

  delete from public.claims where doc_id = p_content_id;
  delete from public.chunk_entities ce
  using public.document_chunks dc
  where ce.chunk_id = dc.id and dc.content_id = p_content_id;

  for fact in select * from jsonb_array_elements(p_facts)
  loop
    select dc.id into v_chunk_id
    from public.document_chunks dc
    where dc.content_id = p_content_id
      and dc.chunk_index = (fact ->> 'chunk_index')::integer;
    if v_chunk_id is null then
      continue;
    end if;

    for entity in select * from jsonb_array_elements(coalesce(fact -> 'entities', '[]'::jsonb))
    loop
      v_name := btrim(coalesce(entity ->> 'name', ''));
      if v_name = '' then
        continue;
      end if;
      v_entity_type := case
        when entity ->> 'type' in ('company', 'airport', 'concept') then entity ->> 'type'
        else 'concept'
      end;

      insert into public.entities (name, entity_type)
      values (v_name, v_entity_type)
      on conflict (lower(btrim(name))) do update set
        entity_type = case
          when public.entities.entity_type = 'concept'
            and excluded.entity_type in ('company', 'airport')
          then excluded.entity_type
          else public.entities.entity_type
        end
      returning id into v_entity_id;

      insert into public.chunk_entities (chunk_id, entity_id)
      values (v_chunk_id, v_entity_id)
      on conflict do nothing;
      v_links := v_links + 1;
    end loop;

    for claim in select * from jsonb_array_elements(coalesce(fact -> 'claims', '[]'::jsonb))
    loop
      v_claim_id := null;
      v_entity_name := btrim(coalesce(claim ->> 'entity_name', ''));
      v_entity_id := null;
      if v_entity_name <> '' then
        select e.id into v_entity_id
        from public.entities e
        where lower(btrim(e.name)) = lower(v_entity_name)
        limit 1;
      end if;

      insert into public.claims (
        doc_id,
        chunk_id,
        entity_id,
        metric,
        value_text,
        value_min,
        value_max,
        unit,
        context,
        source_title,
        source_year
      )
      values (
        p_content_id,
        v_chunk_id,
        v_entity_id,
        nullif(btrim(coalesce(claim ->> 'metric', '')), ''),
        btrim(claim ->> 'value_text'),
        nullif(claim ->> 'value_min', '')::numeric,
        nullif(claim ->> 'value_max', '')::numeric,
        nullif(btrim(coalesce(claim ->> 'unit', '')), ''),
        nullif(btrim(coalesce(claim ->> 'context', '')), ''),
        nullif(btrim(coalesce(claim ->> 'source_title', '')), ''),
        nullif(claim ->> 'source_year', '')::integer
      )
      on conflict do nothing
      returning id into v_claim_id;
      if v_claim_id is not null then
        v_claims := v_claims + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('links', v_links, 'claims', v_claims);
end;
$$;

comment on function public.worker_attach_chunk_facts(uuid, jsonb) is
  'Ingestion worker: replace one document''s entity links and claims after its chunks are committed.';

revoke all on function public.worker_attach_chunk_facts(uuid, jsonb) from public, anon;
grant execute on function public.worker_attach_chunk_facts(uuid, jsonb)
  to authenticated, service_role;

reset search_path;

-- Rollback (run by hand if this migration must be undone; seeding is additive):
--
-- revoke execute on function public.worker_attach_chunk_facts(uuid, jsonb) from authenticated, service_role;
-- drop function if exists public.worker_attach_chunk_facts(uuid, jsonb);
-- revoke execute on function public.match_entities(text[], double precision, integer) from authenticated;
-- drop function if exists public.match_entities(text[], double precision, integer);
-- drop table if exists public.entity_assets;
-- drop table if exists public.entity_facts;
-- drop table if exists public.chunk_entities;
-- drop table if exists public.claims;
-- drop table if exists public.entities;
