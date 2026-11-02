-- Phase 1 reconciliation. 0010 created the passage index and RLS but left out
-- three things Phase 2/3 depend on: the full-text index, a content hash for
-- idempotent re-ingestion, and an atomic chunk replacement RPC.
--
-- Status values stay as applied in 0010 (queued/running/ready/empty/skipped/
-- failed); they carry more meaning than a single 'unsupported': 'empty' means a
-- supported format yielded no usable text (probable scan), 'skipped' means the
-- format is not extracted. Images/videos land in 'skipped'.
set search_path = public, extensions;

-- Full-text half of hybrid retrieval. An explicit regconfig keeps the
-- expression immutable, which generated columns require.
alter table public.document_chunks
  add column tsv tsvector generated always as (to_tsvector('english', content)) stored;

create index document_chunks_tsv_idx
  on public.document_chunks using gin (tsv);

-- Hash of the extracted text, so a retry can skip embedding unchanged content.
alter table public.ingestion_jobs
  add column content_hash text;

-- Claim query filters on status and orders oldest first.
create index ingestion_jobs_claim_idx
  on public.ingestion_jobs (status, created_at);

-- Replaces every chunk for one item in a single statement set, so a retry can
-- never duplicate passages and a failure leaves the previous chunks intact.
-- Callable by the trusted ingestion worker only; user sessions never write here.
create or replace function public.replace_document_chunks(
  p_content_id uuid,
  p_chunks jsonb,
  p_content_hash text default null,
  p_status text default 'ready',
  p_warnings jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_chunk_count integer;
begin
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'p_chunks must be a JSON array';
  end if;
  if p_status not in ('ready', 'empty') then
    raise exception 'p_status must be ready or empty, got %', p_status;
  end if;
  if p_warnings is null or jsonb_typeof(p_warnings) <> 'array' then
    raise exception 'p_warnings must be a JSON array';
  end if;
  if not exists (select 1 from public.content_items ci where ci.id = p_content_id) then
    raise exception 'content item % not found', p_content_id;
  end if;

  delete from public.document_chunks where content_id = p_content_id;

  insert into public.document_chunks (
    content_id,
    chunk_index,
    content,
    estimated_tokens,
    page,
    slide,
    heading,
    embedding,
    embedding_model
  )
  select
    p_content_id,
    (chunk ->> 'chunk_index')::integer,
    chunk ->> 'content',
    greatest(coalesce((chunk ->> 'estimated_tokens')::integer, 1), 1),
    nullif(chunk ->> 'page', '')::integer,
    nullif(chunk ->> 'slide', '')::integer,
    nullif(chunk ->> 'heading', ''),
    (chunk -> 'embedding')::text::vector,
    coalesce(nullif(chunk ->> 'embedding_model', ''), 'qwen/qwen3-embedding-8b')
  from jsonb_array_elements(p_chunks) as chunk;

  select count(*) into v_chunk_count
  from public.document_chunks
  where content_id = p_content_id;

  update public.ingestion_jobs
     set status = p_status,
         chunk_count = v_chunk_count,
         content_hash = coalesce(p_content_hash, content_hash),
         warnings = p_warnings,
         error = null,
         finished_at = now(),
         updated_at = now()
   where content_id = p_content_id;

  return v_chunk_count;
end;
$$;

revoke all on function public.replace_document_chunks(uuid, jsonb, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_document_chunks(uuid, jsonb, text, text, jsonb)
  to service_role;

reset search_path;
