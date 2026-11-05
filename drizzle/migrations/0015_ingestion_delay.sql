-- Ingestion waits 120 seconds after a file lands before a worker may claim it.
-- A quick re-upload, move or replace inside the same upload flow then parses the
-- final bytes once instead of parsing twice. The delay is stored per job and
-- enforced by worker_claim_job() in drizzle/migrations/0017_worker_rpc.sql,
-- which only takes rows with not_before <= now(); scripts/install-ingest-cron.sh
-- drives that worker once a minute.
set search_path = public, extensions;

alter table public.ingestion_jobs
  add column if not exists not_before timestamptz not null default now();

comment on column public.ingestion_jobs.not_before is
  'Earliest time a worker may claim the job: upload time + 120s. Retries keep the stored value so a failed job is retried immediately, not two minutes later.';

-- Partial index: the worker only ever scans queued rows that are already due.
create index if not exists ingestion_jobs_due_idx
  on public.ingestion_jobs (not_before)
  where status = 'queued';

-- Same trigger function as 0013, now stamping the delay. Re-uploading the same
-- content restarts the 120 seconds from the newest file.
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
         not_before = now() + interval '120 seconds',
         updated_at = now();
  return new;
end;
$$;

revoke all on function public.enqueue_ingestion_job() from public, anon, authenticated;

reset search_path;
