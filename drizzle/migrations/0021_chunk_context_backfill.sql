-- Phase 5: contextual chunk headers, backfilled without re-extracting files.
--
-- New ingests prepend "Customer: X | Industry: Y | Document: Z | Slide: N" to
-- document_chunks.content, which is also the text the generated tsv indexes.
-- This migration adds the only write path an existing library needs: update a
-- batch of chunk rows with a new contextual text and its matching embedding.
--
-- It is additive and idempotent. Apply after 0020 (or after 0019 if entity
-- matching was never applied). Rollback at the bottom, commented out.
set search_path = public, extensions;

create or replace function public.worker_update_chunk_context(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_updated integer := 0;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'At most 200 rows per backfill batch';
  end if;

  update public.document_chunks c
     set content = r.content,
         embedding = r.embedding,
         embedding_model = r.embedding_model
    from (
      select
        (row ->> 'id')::uuid as id,
        row ->> 'content' as content,
        (row -> 'embedding')::text::vector as embedding,
        coalesce(nullif(row ->> 'embedding_model', ''), 'qwen/qwen3-embedding-8b') as embedding_model
      from jsonb_array_elements(p_rows) as row
      where nullif(row ->> 'id', '') is not null
        and nullif(row ->> 'content', '') is not null
        and row ? 'embedding'
    ) r
   where c.id = r.id;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.worker_update_chunk_context(jsonb) is
  'Backfills contextual chunk text and its embedding for an ingestion worker. Restricted by is_ingestion_worker().';

revoke all on function public.worker_update_chunk_context(jsonb) from public, anon, authenticated;
grant execute on function public.worker_update_chunk_context(jsonb) to authenticated, service_role;

reset search_path;

-- Rollback:
-- revoke all on function public.worker_update_chunk_context(jsonb) from authenticated, service_role;
-- drop function if exists public.worker_update_chunk_context(jsonb);
