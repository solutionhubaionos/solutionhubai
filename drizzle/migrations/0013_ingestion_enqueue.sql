-- Queue an ingestion job whenever content enters the library, or when its stored
-- file changes (binary replacement, move/copy). Metadata edits such as a title
-- or customer rename never re-queue, so company renames stay cheap.
set search_path = public, extensions;

create or replace function public.enqueue_ingestion_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ingestion_jobs (content_id, status)
  values (new.id, 'queued')
  on conflict (content_id) do update
     set status = 'queued',
         attempts = 0,
         error = null,
         started_at = null,
         finished_at = null,
         updated_at = now();
  return new;
end;
$$;

revoke all on function public.enqueue_ingestion_job() from public, anon, authenticated;

create trigger content_enqueue_ingestion
  after insert on public.content_items
  for each row execute function public.enqueue_ingestion_job();

create trigger content_requeue_ingestion_on_file_change
  after update of file_path, file_size on public.content_items
  for each row
  when (
    old.file_path is distinct from new.file_path
    or old.file_size is distinct from new.file_size
  )
  execute function public.enqueue_ingestion_job();

reset search_path;
