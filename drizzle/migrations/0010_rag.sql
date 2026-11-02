-- Phase 1: passage index, ingestion state, and owner-only chat history.
-- Vector search stays in Postgres so RLS and cascade deletes apply to it.
create extension if not exists vector with schema extensions;
set search_path = public, extensions;

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (content <> ''),
  estimated_tokens integer not null check (estimated_tokens > 0),
  page integer check (page is null or page > 0),
  slide integer check (slide is null or slide > 0),
  heading text,
  embedding vector(1536) not null,
  embedding_model text not null default 'qwen/qwen3-embedding-8b',
  created_at timestamptz not null default now(),
  unique (content_id, chunk_index),
  check (page is null or slide is null)
);

create index document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null unique references public.content_items(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'ready', 'empty', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  embedding_model text not null default 'qwen/qwen3-embedding-8b',
  dimensions integer not null default 1536,
  warnings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(warnings) = 'array'),
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index chat_threads_owner_idx
  on public.chat_threads (user_id, updated_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (content <> ''),
  citations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(citations) = 'array'),
  created_at timestamptz not null default now()
);

create index chat_messages_thread_idx
  on public.chat_messages (thread_id, created_at);

grant select on public.document_chunks to authenticated;
grant all on public.document_chunks to service_role;
alter table public.document_chunks enable row level security;
create policy "Allowed users read chunks" on public.document_chunks
  for select to authenticated
  using (
    public.is_allowed_email(auth.jwt() ->> 'email')
    and exists (
      select 1 from public.content_items ci
      where ci.id = document_chunks.content_id
    )
  );

grant select on public.ingestion_jobs to authenticated;
grant all on public.ingestion_jobs to service_role;
alter table public.ingestion_jobs enable row level security;
create policy "Admins read ingestion jobs" on public.ingestion_jobs
  for select to authenticated
  using (public.is_content_admin());

grant select, insert, update, delete on public.chat_threads to authenticated;
grant all on public.chat_threads to service_role;
alter table public.chat_threads enable row level security;
create policy "Owners manage threads" on public.chat_threads
  for all to authenticated
  using (user_id = auth.uid() and public.is_allowed_email(auth.jwt() ->> 'email'))
  with check (user_id = auth.uid() and public.is_allowed_email(auth.jwt() ->> 'email'));

grant select, insert on public.chat_messages to authenticated;
grant all on public.chat_messages to service_role;
alter table public.chat_messages enable row level security;
create policy "Owners manage messages" on public.chat_messages
  for all to authenticated
  using (
    exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id and t.user_id = auth.uid()
    )
  );

grant usage on schema extensions to authenticated;

create or replace function public.match_document_chunks(
  query_embedding vector,
  match_count integer default 8,
  filter_industry text default null
)
returns table (
  chunk_id uuid,
  content_id uuid,
  content text,
  page integer,
  slide integer,
  heading text,
  title text,
  industry text,
  customer_name text,
  file_name text,
  distance double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id as chunk_id,
    c.content_id,
    c.content,
    c.page,
    c.slide,
    c.heading,
    ci.title,
    ci.industry,
    ci.customer_name,
    ci.file_name,
    c.embedding <=> query_embedding as distance
  from public.document_chunks c
  join public.content_items ci on ci.id = c.content_id
  where filter_industry is null or ci.industry = filter_industry
  order by c.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 8), 1), 20);
$$;

revoke all on function public.match_document_chunks(vector, integer, text)
  from public, anon;
grant execute on function public.match_document_chunks(vector, integer, text)
  to authenticated;

reset search_path;
