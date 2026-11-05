-- Supabase caps the `authenticated` role at an 8 second statement_timeout. The
-- worker's commit path deletes and re-inserts every chunk for one file and writes
-- those vectors into the HNSW index in a single statement. On a large deck that
-- can exceed 8 seconds, and it does so reliably when several workers commit at
-- the same time:
--
--   canceling statement due to statement timeout
--
-- The write is atomic, so a timeout never leaves partial chunks behind: the job
-- requeues and burns an attempt. Raising the limit on only these functions keeps
-- the guard everywhere else and stops large files from failing.
--
-- ALTER FUNCTION ... SET changes one setting and leaves the function's own
-- `search_path` alone, so no body is duplicated here and re-running is harmless.
-- A nested call inherits the caller's setting, which is why
-- replace_document_chunks gets its own entry: it is also callable directly by
-- the service role.

alter function public.worker_stage_chunks(uuid, jsonb)
  set statement_timeout = '60s';

alter function public.worker_commit_staging(uuid, text, text, jsonb)
  set statement_timeout = '60s';

alter function public.worker_replace_document_chunks(uuid, jsonb, text, text, jsonb)
  set statement_timeout = '60s';

alter function public.replace_document_chunks(uuid, jsonb, text, text, jsonb)
  set statement_timeout = '60s';

-- Check it landed (proconfig should contain statement_timeout=60s):
--
--   select p.proname, p.proconfig
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and (p.proname like 'worker_%' or p.proname = 'replace_document_chunks')
--    order by p.proname;
