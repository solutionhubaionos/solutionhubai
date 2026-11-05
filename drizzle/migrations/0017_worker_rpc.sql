-- Ingestion worker access for Lovable Cloud, which does not expose a Postgres
-- connection string or a service-role key. The worker signs in as a normal
-- member, downloads files from Storage, and calls these security-definer RPCs.
--
-- Only accounts listed in public.ingestion_worker_users (or the service role)
-- may call worker_*.
-- Add the worker account after applying this migration:
--
--   insert into public.ingestion_worker_users (user_id)
--   select id from auth.users where lower(email) = lower('<worker-email>')
--   on conflict do nothing;
--
-- The worker still uses the existing 120-second not_before delay and the same
-- replace_document_chunks implementation. This migration adds an authenticated,
-- allowlisted entry point plus a small staging table so large documents stay
-- under the Data API request-size limit.
set search_path = public, extensions;

create table if not exists public.ingestion_worker_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.ingestion_worker_users enable row level security;
revoke all on public.ingestion_worker_users from public, anon, authenticated;
grant all on public.ingestion_worker_users to service_role;

comment on table public.ingestion_worker_users is
  'Accounts allowed to call the worker_* ingestion RPCs. Add the library worker account here.';

-- Large documents produce tens of megabytes of embedding JSON, which can exceed
-- the Data API request limit. The worker stages chunks in small batches here,
-- then one RPC copies the whole set into document_chunks atomically.
create table if not exists public.ingestion_chunk_staging (
  job_id uuid not null references public.ingestion_jobs(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (content <> ''),
  estimated_tokens integer not null check (estimated_tokens > 0),
  page integer check (page is null or page > 0),
  slide integer check (slide is null or slide > 0),
  heading text,
  embedding vector(1536) not null,
  embedding_model text not null default 'qwen/qwen3-embedding-8b',
  primary key (job_id, chunk_index),
  check (page is null or slide is null)
);

alter table public.ingestion_chunk_staging enable row level security;
revoke all on public.ingestion_chunk_staging from public, anon, authenticated;
grant all on public.ingestion_chunk_staging to service_role;

comment on table public.ingestion_chunk_staging is
  'Short-lived worker staging for one job. Cleared on begin, commit and permanent failure.';

-- A claimed job is leased to the worker holding it. The worker refreshes
-- heartbeat_at while it works, and worker_reclaim_stale() only takes back a job
-- whose heartbeat has stopped. A slow document therefore keeps its lease; only a
-- dead process loses one.
alter table public.ingestion_jobs
  add column if not exists heartbeat_at timestamptz;

comment on column public.ingestion_jobs.heartbeat_at is
  'Last lease refresh from the worker that claimed the job. Stale after five minutes, which is when worker_reclaim_stale() requeues it.';

create or replace function public.is_ingestion_worker()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role() = 'service_role', false)
      or exists (
        select 1
        from public.ingestion_worker_users w
        where w.user_id = auth.uid()
      );
$$;

revoke all on function public.is_ingestion_worker() from public, anon;
grant execute on function public.is_ingestion_worker() to authenticated, service_role;

create or replace function public.worker_claim_job()
returns table (
  id uuid,
  content_id uuid,
  attempts integer,
  content_hash text,
  chunk_count integer,
  file_path text,
  file_name text,
  mime_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ingestion_jobs%rowtype;
  v_content public.content_items%rowtype;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  select * into v_job
  from public.ingestion_jobs j
  where j.status = 'queued'
    and j.not_before <= now()
  order by j.not_before, j.created_at
  limit 1
  for update skip locked;

  if not found then
    return;
  end if;

  update public.ingestion_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         started_at = now(),
         heartbeat_at = now(),
         updated_at = now()
   where j.id = v_job.id
   returning * into v_job;

  select * into v_content
  from public.content_items ci
  where ci.id = v_job.content_id;

  return query
    select v_job.id,
           v_job.content_id,
           v_job.attempts,
           v_job.content_hash,
           v_job.chunk_count,
           v_content.file_path,
           v_content.file_name,
           v_content.mime_type;
end;
$$;

revoke all on function public.worker_claim_job() from public, anon;
grant execute on function public.worker_claim_job() to authenticated, service_role;

-- Lease refresh for the worker that owns a running job. Returns false when the
-- job is no longer running, which means another worker has taken it over.
create or replace function public.worker_heartbeat(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  update public.ingestion_jobs
     set heartbeat_at = now()
   where id = p_job_id
     and status = 'running';

  return found;
end;
$$;

revoke all on function public.worker_heartbeat(uuid) from public, anon;
grant execute on function public.worker_heartbeat(uuid) to authenticated, service_role;

create or replace function public.worker_next_due_seconds()
returns double precision
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_seconds double precision;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  select extract(epoch from (min(j.not_before) - now()))::double precision
    into v_seconds
    from public.ingestion_jobs j
   where j.status = 'queued';

  return v_seconds;
end;
$$;

revoke all on function public.worker_next_due_seconds() from public, anon;
grant execute on function public.worker_next_due_seconds() to authenticated, service_role;

create or replace function public.worker_finish_job(
  p_job_id uuid,
  p_status text,
  p_chunk_count integer,
  p_content_hash text default null,
  p_warnings jsonb default '[]'::jsonb
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

revoke all on function public.worker_finish_job(uuid, text, integer, text, jsonb)
  from public, anon;
grant execute on function public.worker_finish_job(uuid, text, integer, text, jsonb)
  to authenticated, service_role;

create or replace function public.worker_fail_job(p_job_id uuid, p_error text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_status text;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  select attempts into v_attempts
  from public.ingestion_jobs
  where id = p_job_id
    and status = 'running'
  for update;

  if not found then
    raise exception 'Job % is not running', p_job_id;
  end if;

  -- Three attempts total, matching the previous worker limit.
  v_status := case when v_attempts >= 3 then 'failed' else 'queued' end;

  update public.ingestion_jobs
     set status = v_status,
         error = left(coalesce(p_error, ''), 500),
         heartbeat_at = null,
         finished_at = case when v_status = 'failed' then now() else null end,
         updated_at = now()
   where id = p_job_id;

  if v_status = 'failed' then
    delete from public.ingestion_chunk_staging where job_id = p_job_id;
  end if;

  return v_status;
end;
$$;

revoke all on function public.worker_fail_job(uuid, text) from public, anon;
grant execute on function public.worker_fail_job(uuid, text) to authenticated, service_role;

create or replace function public.worker_reclaim_stale()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  -- Only a job whose lease stopped being refreshed is taken back. The attempt
  -- stays counted: a worker that keeps dying is a real failure, and three of
  -- those still mark the file failed so it is visible instead of looping.
  update public.ingestion_jobs
     set status = 'queued',
         heartbeat_at = null,
         updated_at = now()
   where status = 'running'
     and coalesce(heartbeat_at, started_at) < now() - interval '5 minutes';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.worker_reclaim_stale() from public, anon;
grant execute on function public.worker_reclaim_stale() to authenticated, service_role;

create or replace function public.worker_backfill()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;

  insert into public.ingestion_jobs (content_id, status, not_before)
  select ci.id,
         'queued',
         greatest(ci.created_at + interval '120 seconds', now())
    from public.content_items ci
   where not exists (
     select 1 from public.ingestion_jobs j where j.content_id = ci.id
   )
  on conflict (content_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.worker_backfill() from public, anon;
grant execute on function public.worker_backfill() to authenticated, service_role;

create or replace function public.worker_begin_staging(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_ingestion_worker() then
    raise exception 'Not an ingestion worker' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ingestion_jobs where id = p_job_id and status = 'running'
  ) then
    raise exception 'Job % is not running', p_job_id;
  end if;

  delete from public.ingestion_chunk_staging where job_id = p_job_id;
end;
$$;

revoke all on function public.worker_begin_staging(uuid) from public, anon;
grant execute on function public.worker_begin_staging(uuid) to authenticated, service_role;

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
    embedding_model
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
    coalesce(nullif(chunk ->> 'embedding_model', ''), 'qwen/qwen3-embedding-8b')
  from jsonb_array_elements(p_chunks) as chunk
  on conflict (job_id, chunk_index) do update
    set content = excluded.content,
        estimated_tokens = excluded.estimated_tokens,
        page = excluded.page,
        slide = excluded.slide,
        heading = excluded.heading,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.worker_stage_chunks(uuid, jsonb) from public, anon;
grant execute on function public.worker_stage_chunks(uuid, jsonb) to authenticated, service_role;

create or replace function public.worker_commit_staging(
  p_job_id uuid,
  p_content_hash text,
  p_status text default 'ready',
  p_warnings jsonb default '[]'::jsonb
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
    embedding_model
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
    s.embedding_model
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
         heartbeat_at = null,
         finished_at = now(),
         updated_at = now()
   where id = p_job_id;

  delete from public.ingestion_chunk_staging where job_id = p_job_id;
  return v_count;
end;
$$;

revoke all on function public.worker_commit_staging(uuid, text, text, jsonb)
  from public, anon;
grant execute on function public.worker_commit_staging(uuid, text, text, jsonb)
  to authenticated, service_role;

-- Authenticated wrapper around replace_document_chunks. The inner function
-- stays service-role-only; this one checks the worker allowlist first.
create or replace function public.worker_replace_document_chunks(
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
    p_warnings
  );
end;
$$;

revoke all on function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb)
  from public, anon;
grant execute on function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb)
  to authenticated, service_role;

reset search_path;
