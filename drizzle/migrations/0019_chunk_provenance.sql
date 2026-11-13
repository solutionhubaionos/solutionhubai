-- Phase 1 extraction provenance.
--
-- The new extractor separates ordinary prose from tables and figures, and may
-- describe a chart or image-only slide with a vision model. Those chunks need a
-- kind so retrieval and diagnostics can tell them apart, plus a small metadata
-- object for provenance (source image, model, table shape). Document text never
-- goes in metadata; `content` remains the only searchable copy.
--
-- Each ingestion job also records which extractor produced its current chunks.
-- `worker_requeue_all()` then requeues only files that have not been through the
-- current pipeline, without deleting their existing chunks until the new run
-- commits.
--
-- Apply after 0018. Idempotent: safe to re-run.
set search_path = public, extensions;

-- Chunk provenance ---------------------------------------------------------

alter table public.document_chunks
  add column if not exists chunk_kind text,
  add column if not exists metadata jsonb;

update public.document_chunks set chunk_kind = 'text' where chunk_kind is null;
update public.document_chunks set metadata = '{}'::jsonb where metadata is null;

alter table public.document_chunks
  alter column chunk_kind set default 'text',
  alter column chunk_kind set not null,
  alter column metadata set default '{}'::jsonb,
  alter column metadata set not null;

alter table public.document_chunks
  drop constraint if exists document_chunks_chunk_kind_check;
alter table public.document_chunks
  add constraint document_chunks_chunk_kind_check
  check (chunk_kind in ('text', 'table', 'figure'));

alter table public.document_chunks
  drop constraint if exists document_chunks_metadata_object_check;
alter table public.document_chunks
  add constraint document_chunks_metadata_object_check
  check (jsonb_typeof(metadata) = 'object');

comment on column public.document_chunks.chunk_kind is
  'text: prose; table: extracted table rows; figure: chart, diagram or image description.';
comment on column public.document_chunks.metadata is
  'Extraction provenance, e.g. {"source":"vision","image":"ppt/media/image41.png","model":"..."}. Never document text.';

alter table public.ingestion_chunk_staging
  add column if not exists chunk_kind text,
  add column if not exists metadata jsonb;

update public.ingestion_chunk_staging set chunk_kind = 'text' where chunk_kind is null;
update public.ingestion_chunk_staging set metadata = '{}'::jsonb where metadata is null;

alter table public.ingestion_chunk_staging
  alter column chunk_kind set default 'text',
  alter column chunk_kind set not null,
  alter column metadata set default '{}'::jsonb,
  alter column metadata set not null;

alter table public.ingestion_chunk_staging
  drop constraint if exists ingestion_chunk_staging_chunk_kind_check;
alter table public.ingestion_chunk_staging
  add constraint ingestion_chunk_staging_chunk_kind_check
  check (chunk_kind in ('text', 'table', 'figure'));

alter table public.ingestion_chunk_staging
  drop constraint if exists ingestion_chunk_staging_metadata_object_check;
alter table public.ingestion_chunk_staging
  add constraint ingestion_chunk_staging_metadata_object_check
  check (jsonb_typeof(metadata) = 'object');

-- Extractor version --------------------------------------------------------

alter table public.ingestion_jobs
  add column if not exists extractor_version text;

comment on column public.ingestion_jobs.extractor_version is
  'Version of the extraction/chunking pipeline that produced the current chunks. Null means pre-0019 or not yet processed.';

-- Replace the chunk-writing functions. Adding a parameter changes the
-- signature, so the old overloads are dropped first; callers that use the
-- previous argument list still resolve through the defaults.

drop function if exists public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb);
drop function if exists public.replace_document_chunks(uuid, jsonb, text, text, jsonb);
drop function if exists public.worker_finish_job(uuid, text, integer, text, jsonb);
drop function if exists public.worker_commit_staging(uuid, text, text, jsonb);

create or replace function public.replace_document_chunks(
  p_content_id uuid,
  p_chunks jsonb,
  p_content_hash text default null,
  p_status text default 'ready',
  p_warnings jsonb default '[]'::jsonb,
  p_extractor_version text default null
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
    embedding_model,
    chunk_kind,
    metadata
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
    coalesce(nullif(chunk ->> 'embedding_model', ''), 'qwen/qwen3-embedding-8b'),
    coalesce(nullif(chunk ->> 'chunk_kind', ''), 'text'),
    case
      when jsonb_typeof(chunk -> 'metadata') = 'object' then chunk -> 'metadata'
      else '{}'::jsonb
    end
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
         extractor_version = coalesce(nullif(p_extractor_version, ''), extractor_version),
         finished_at = now(),
         updated_at = now()
   where content_id = p_content_id;

  return v_chunk_count;
end;
$$;

revoke all on function public.replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  to service_role;
alter function public.replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  set statement_timeout = '60s';

create or replace function public.worker_replace_document_chunks(
  p_content_id uuid,
  p_chunks jsonb,
  p_content_hash text default null,
  p_status text default 'ready',
  p_warnings jsonb default '[]'::jsonb,
  p_extractor_version text default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if p_status not in ('ready', 'empty', 'skipped') then
    raise exception 'p_status must be ready, empty or skipped, got %', p_status;
  end if;
  if not exists (
    select 1
    from public.ingestion_jobs
    where content_id = p_content_id
      and status = 'running'
  ) then
    raise exception 'No running ingestion job for content %', p_content_id;
  end if;

  if p_status = 'skipped' then
    delete from public.document_chunks where content_id = p_content_id;
    update public.ingestion_jobs
       set status = 'skipped',
           chunk_count = 0,
           content_hash = null,
           warnings = coalesce(p_warnings, '[]'::jsonb),
           error = null,
           extractor_version = coalesce(nullif(p_extractor_version, ''), extractor_version),
           heartbeat_at = null,
           finished_at = now(),
           updated_at = now()
     where content_id = p_content_id;
    return 0;
  end if;

  return public.replace_document_chunks(
    p_content_id,
    p_chunks,
    p_content_hash,
    p_status,
    p_warnings,
    p_extractor_version
  );
end;
$$;

revoke all on function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  from public, anon;
grant execute on function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  to authenticated, service_role;
alter function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb, text)
  set statement_timeout = '60s';

create or replace function public.worker_finish_job(
  p_job_id uuid,
  p_status text,
  p_chunk_count integer,
  p_content_hash text default null,
  p_warnings jsonb default '[]'::jsonb,
  p_extractor_version text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if p_status <> 'ready' then
    raise exception 'p_status must be ready, got %', p_status;
  end if;

  update public.ingestion_jobs
     set status = p_status,
         chunk_count = greatest(coalesce(p_chunk_count, 0), 0),
         content_hash = p_content_hash,
         warnings = coalesce(p_warnings, '[]'::jsonb),
         error = null,
         extractor_version = coalesce(nullif(p_extractor_version, ''), extractor_version),
         heartbeat_at = null,
         finished_at = now(),
         updated_at = now()
   where id = p_job_id
     and status = 'running';

  if not found then
    raise exception 'Job % is not running', p_job_id;
  end if;

  delete from public.ingestion_chunk_staging where job_id = p_job_id;
end;
$$;

revoke all on function public.worker_finish_job(uuid, text, integer, text, jsonb, text)
  from public, anon;
grant execute on function public.worker_finish_job(uuid, text, integer, text, jsonb, text)
  to authenticated, service_role;

create or replace function public.worker_commit_staging(
  p_job_id uuid,
  p_content_hash text,
  p_status text default 'ready',
  p_warnings jsonb default '[]'::jsonb,
  p_extractor_version text default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_content_id uuid;
  v_count integer;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if p_status not in ('ready', 'empty') then
    raise exception 'p_status must be ready or empty, got %', p_status;
  end if;

  select content_id into v_content_id
  from public.ingestion_jobs
  where id = p_job_id
    and status = 'running'
  for update;

  if not found then
    raise exception 'Job % is not running', p_job_id;
  end if;

  if p_status = 'ready' and not exists (
    select 1 from public.ingestion_chunk_staging where job_id = p_job_id
  ) then
    raise exception 'No staged chunks for job %', p_job_id;
  end if;

  delete from public.document_chunks where content_id = v_content_id;

  insert into public.document_chunks (
    content_id,
    chunk_index,
    content,
    estimated_tokens,
    page,
    slide,
    heading,
    embedding,
    embedding_model,
    chunk_kind,
    metadata
  )
  select
    v_content_id,
    s.chunk_index,
    s.content,
    s.estimated_tokens,
    s.page,
    s.slide,
    s.heading,
    s.embedding,
    s.embedding_model,
    s.chunk_kind,
    s.metadata
  from public.ingestion_chunk_staging s
  where s.job_id = p_job_id
  order by s.chunk_index;

  select count(*) into v_count
  from public.document_chunks
  where content_id = v_content_id;

  update public.ingestion_jobs
     set status = p_status,
         chunk_count = v_count,
         content_hash = p_content_hash,
         warnings = coalesce(p_warnings, '[]'::jsonb),
         error = null,
         extractor_version = coalesce(nullif(p_extractor_version, ''), extractor_version),
         heartbeat_at = null,
         finished_at = now(),
         updated_at = now()
   where id = p_job_id;

  delete from public.ingestion_chunk_staging where job_id = p_job_id;
  return v_count;
end;
$$;

revoke all on function public.worker_commit_staging(uuid, text, text, jsonb, text)
  from public, anon;
grant execute on function public.worker_commit_staging(uuid, text, text, jsonb, text)
  to authenticated, service_role;
alter function public.worker_commit_staging(uuid, text, text, jsonb, text)
  set statement_timeout = '60s';

create or replace function public.worker_stage_chunks(p_job_id uuid, p_chunks jsonb)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'p_chunks must be a JSON array';
  end if;
  if not exists (
    select 1 from public.ingestion_jobs where id = p_job_id and status = 'running'
  ) then
    raise exception 'Job % is not running', p_job_id;
  end if;

  insert into public.ingestion_chunk_staging (
    job_id,
    chunk_index,
    content,
    estimated_tokens,
    page,
    slide,
    heading,
    embedding,
    embedding_model,
    chunk_kind,
    metadata
  )
  select
    p_job_id,
    (chunk ->> 'chunk_index')::integer,
    chunk ->> 'content',
    greatest(coalesce((chunk ->> 'estimated_tokens')::integer, 1), 1),
    nullif(chunk ->> 'page', '')::integer,
    nullif(chunk ->> 'slide', '')::integer,
    nullif(chunk ->> 'heading', ''),
    (chunk -> 'embedding')::text::vector,
    coalesce(nullif(chunk ->> 'embedding_model', ''), 'qwen/qwen3-embedding-8b'),
    coalesce(nullif(chunk ->> 'chunk_kind', ''), 'text'),
    case
      when jsonb_typeof(chunk -> 'metadata') = 'object' then chunk -> 'metadata'
      else '{}'::jsonb
    end
  from jsonb_array_elements(p_chunks) as chunk
  on conflict (job_id, chunk_index) do update
    set content = excluded.content,
        estimated_tokens = excluded.estimated_tokens,
        page = excluded.page,
        slide = excluded.slide,
        heading = excluded.heading,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        chunk_kind = excluded.chunk_kind,
        metadata = excluded.metadata;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.worker_stage_chunks(uuid, jsonb) from public, anon;
grant execute on function public.worker_stage_chunks(uuid, jsonb) to authenticated, service_role;
alter function public.worker_stage_chunks(uuid, jsonb)
  set statement_timeout = '60s';

-- Re-ingest ----------------------------------------------------------------
--
-- One admin call queues every file that has not been through the current
-- extractor, plus any failed or empty result. Existing chunks stay in place
-- until the new run commits, so search keeps working during a re-ingest.
--
-- After deploying the Phase 1 worker, run in the SQL editor:
--
--   select public.worker_requeue_all('2026-11-10.1');
--
-- The string must match the worker's EXTRACTOR_VERSION constant. SQL editor
-- requests have no auth.uid(), so they pass the check as the database owner;
-- a signed-in caller must be in public.ingestion_worker_users.
create or replace function public.worker_requeue_all(p_extractor_version text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_extractor_version is null or btrim(p_extractor_version) = '' then
    raise exception 'p_extractor_version is required';
  end if;
  if auth.uid() is not null and not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  insert into public.ingestion_jobs (content_id, status, not_before)
  select ci.id, 'queued', now()
  from public.content_items ci
  where not exists (
    select 1 from public.ingestion_jobs j where j.content_id = ci.id
  )
  on conflict (content_id) do nothing;

  update public.ingestion_jobs j
     set status = 'queued',
         attempts = 0,
         error = null,
         heartbeat_at = null,
         started_at = null,
         finished_at = null,
         not_before = now(),
         content_hash = null,
         extractor_version = null,
         updated_at = now()
   where j.status <> 'running'
     and (
       j.status = 'failed'
       or (j.status = 'ready' and j.chunk_count = 0)
       or coalesce(j.extractor_version, '') <> p_extractor_version
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.worker_requeue_all(text) from public, anon;
grant execute on function public.worker_requeue_all(text) to authenticated, service_role;

-- A re-upload or move must forget the old extractor version, otherwise a later
-- requeue-all could mistake the new bytes for already-processed content.
create or replace function public.enqueue_ingestion_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ingestion_jobs (content_id, status, not_before)
  values (new.id, 'queued', now() + interval '120 seconds')
  on conflict (content_id) do update
     set status = 'queued',
         attempts = 0,
         error = null,
         started_at = null,
         finished_at = null,
         heartbeat_at = null,
         not_before = now() + interval '120 seconds',
         extractor_version = null,
         updated_at = now();
  return new;
end;
$$;

revoke all on function public.enqueue_ingestion_job() from public, anon, authenticated;

reset search_path;
