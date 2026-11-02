-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated. Keep the RAG tables to their intended privileges.
revoke all on public.document_chunks from anon, authenticated;
grant select on public.document_chunks to authenticated;

revoke all on public.ingestion_jobs from anon, authenticated;
grant select on public.ingestion_jobs to authenticated;

revoke all on public.chat_threads from anon, authenticated;
grant select, insert, update, delete on public.chat_threads to authenticated;

revoke all on public.chat_messages from anon, authenticated;
grant select, insert on public.chat_messages to authenticated;
