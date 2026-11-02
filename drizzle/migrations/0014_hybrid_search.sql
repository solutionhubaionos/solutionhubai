-- Phase 3: hybrid retrieval over the passage index.
--
-- One security-invoker function so RLS on document_chunks and content_items
-- applies to the caller's JWT. Vector similarity and full-text search each
-- produce a top-N list; the lists are merged with reciprocal rank fusion (k=60)
-- so an exact term match and a semantic match both survive. Industry, customer
-- and file metadata are joined from content_items at query time, never stored
-- on the chunk, so moves, copies and company renames cannot leave stale values.
set search_path = public, extensions;

create or replace function public.search_chunks(
  query_embedding vector(1536),
  query_text text default null,
  filter_industry text default null,
  filter_customer text default null,
  match_count integer default 8
)
returns table (
  chunk_id uuid,
  content_id uuid,
  content text,
  page integer,
  slide integer,
  heading text,
  title text,
  file_name text,
  file_path text,
  industry text,
  customer_name text,
  vector_rank integer,
  text_rank integer,
  score double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with scoped as (
    select
      c.id,
      c.content_id,
      c.content,
      c.page,
      c.slide,
      c.heading,
      c.tsv,
      ci.title,
      ci.file_name,
      ci.file_path,
      ci.industry,
      ci.customer_name,
      c.embedding <=> query_embedding as distance
    from public.document_chunks c
    join public.content_items ci on ci.id = c.content_id
    where (
        nullif(btrim(coalesce(filter_industry, '')), '') is null
        or ci.industry = btrim(filter_industry)
      )
      and (
        nullif(btrim(coalesce(filter_customer, '')), '') is null
        or ci.customer_name = btrim(filter_customer)
      )
  ),
  vector_hits as (
    select
      v.id,
      row_number() over (order by v.distance)::integer as rank
    from scoped v
    order by v.distance
    limit 50
  ),
  query_ts as (
    select websearch_to_tsquery('english', btrim(coalesce(query_text, ''))) as ts
  ),
  text_matches as (
    select
      s.id,
      ts_rank(s.tsv, q.ts) as rank_score
    from scoped s
    cross join query_ts q
    where nullif(btrim(coalesce(query_text, '')), '') is not null
      and s.tsv @@ q.ts
    order by rank_score desc
    limit 50
  ),
  text_hits as (
    select
      t.id,
      row_number() over (order by t.rank_score desc)::integer as rank
    from text_matches t
  ),
  merged as (
    select
      coalesce(v.id, t.id) as id,
      v.rank as vector_rank,
      t.rank as text_rank,
      coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + t.rank), 0.0) as score
    from vector_hits v
    full outer join text_hits t on t.id = v.id
  )
  select
    m.id as chunk_id,
    s.content_id,
    s.content,
    s.page,
    s.slide,
    s.heading,
    s.title,
    s.file_name,
    s.file_path,
    s.industry,
    s.customer_name,
    m.vector_rank,
    m.text_rank,
    m.score
  from merged m
  join scoped s on s.id = m.id
  order by
    m.score desc,
    coalesce(m.vector_rank, 2147483647),
    coalesce(m.text_rank, 2147483647),
    s.id
  limit least(greatest(coalesce(match_count, 8), 1), 50);
$$;

comment on function public.search_chunks(vector, text, text, text, integer) is
  'Hybrid (pgvector + full-text, RRF k=60) passage search. Security invoker: RLS on document_chunks and content_items applies.';

revoke all on function public.search_chunks(vector, text, text, text, integer)
  from public, anon;
grant execute on function public.search_chunks(vector, text, text, text, integer)
  to authenticated;

reset search_path;
