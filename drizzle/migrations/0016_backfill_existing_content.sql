-- Queue every library item that has no ingestion job, so content uploaded
-- before the RAG tables existed is chunked and embedded without a manual
-- backfill run. New uploads are queued by the trigger in 0015.
--
-- Existing files older than 120 seconds are due immediately; a file uploaded
-- less than 120 seconds ago keeps the same delay as a new upload. Failed jobs
-- are re-queued because the usual cause is a missing credential or a provider
-- outage, not a bad file.
set search_path = public, extensions;

insert into public.ingestion_jobs (content_id, status, not_before)
select
  ci.id,
  'queued',
  greatest(ci.created_at + interval '120 seconds', now())
from public.content_items ci
where not exists (
  select 1 from public.ingestion_jobs j where j.content_id = ci.id
)
on conflict (content_id) do nothing;

update public.ingestion_jobs
   set status = 'queued',
       attempts = 0,
       error = null,
       started_at = null,
       finished_at = null,
       not_before = now(),
       updated_at = now()
 where status = 'failed'
    or (status = 'ready' and chunk_count = 0);

reset search_path;
