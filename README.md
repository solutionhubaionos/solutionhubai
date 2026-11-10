# Solution Hub

Internal sales-enablement library. Teams upload case studies, decks, proposals and
POC material by industry and customer; the app previews files in the browser and
an AI assistant answers questions only from indexed passages, with numbered
citations back to the source file.

## Stack

- TanStack Start, React 19, TypeScript, Tailwind
- Supabase: Postgres, Auth, private Storage
- pgvector plus Postgres full-text search, merged with reciprocal rank fusion
- Bun worker for extraction, chunking and embeddings

## Local development

```sh
bun install
cp .env.example .env   # fill in the values
bun run dev
```

`npx tsc --noEmit` type-checks and `bun run build` produces the deployable output.

## Environment

| Variable                                             | Used by                  | Purpose                                              |
| ---------------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`           | server                   | Auth, RLS-scoped queries and worker RPCs             |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | browser                  | Same project, public keys                            |
| `LIBRARY_USER_EMAIL`, `LIBRARY_USER_PASSWORD`        | worker                   | Member login for private Storage and the worker RPCs |
| `TOKENFACTORY_API_BASE`, `TOKENFACTORY_API_KEY`      | worker, server functions | Embeddings and chat completions                      |
| `SUPABASE_SERVICE_ROLE_KEY`                          | optional                 | Bypasses RLS; Lovable Cloud does not expose it       |
| `SUPABASE_DB_URL`                                    | optional scripts         | Direct Postgres; Lovable Cloud does not expose it    |

Never put the service-role key or `SUPABASE_DB_URL` behind a `VITE_` prefix.

### Lovable Cloud

Lovable Cloud does not expose a Postgres connection string or a service-role key.
The worker therefore signs in as a normal member and calls allowlisted
security-definer RPCs. `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **not
needed** on Lovable Cloud; `LIBRARY_USER_EMAIL` and `LIBRARY_USER_PASSWORD` are.

## Lovable Cloud setup

Apply the RAG migrations in order in the Lovable SQL editor
(**More → Database → Manage → SQL editor**):

```text
drizzle/migrations/0010_rag.sql
drizzle/migrations/0011_rag_grants.sql
drizzle/migrations/0012_rag_reconcile.sql
drizzle/migrations/0013_ingestion_enqueue.sql
drizzle/migrations/0014_hybrid_search.sql
drizzle/migrations/0015_ingestion_delay.sql
drizzle/migrations/0016_backfill_existing_content.sql
drizzle/migrations/0017_worker_rpc.sql
drizzle/migrations/0018_worker_statement_timeout.sql
```

Paste one file at a time and run it. The editor asks for confirmation on
destructive statements; these migrations are additive.

Then allow your library user to run the worker RPCs:

```sql
insert into public.ingestion_worker_users (user_id)
select id from auth.users where lower(email) = lower('<your-library-user-email>')
on conflict do nothing;
```

Run the worker once, then install the one-minute cron:

```sh
bun scripts/ingest-worker.ts --backfill
./scripts/install-ingest-cron.sh
```

Check progress in `.ingest.log` (`claimed`, `ready`, `empty`, `skipped`, `failed`).
`0016` queues every existing `content_items` row, so old uploads are indexed
without a manual backfill. New uploads are queued by the database trigger with a
120-second `not_before` delay; the worker honours that deadline.

### What the migrations touch

- `0010`–`0015` create new tables, indexes, functions and policies, and add two
  triggers to `content_items`. They do **not** change any existing row or column.
- `0016` inserts or updates rows only in the new `ingestion_jobs` table; it never
  touches `content_items`.
- `0017` creates the new `ingestion_worker_users` and `ingestion_chunk_staging` tables
  and the worker RPCs. The allowlist insert above adds one row to `ingestion_worker_users`.
  Staging rows are short-lived and scoped to one job.
- `0018` only raises `statement_timeout` to 60 s on the chunk-write functions, so a
  large commit is not cut off by Supabase's 8 s cap for `authenticated`. It changes no
  table, row or privilege, and is safe to re-run.
- The worker reads `content_items` and the private Storage bucket, and writes only to the
  new `document_chunks` and `ingestion_jobs` tables plus the short-lived
  `ingestion_chunk_staging` table.

## Self-hosted Supabase (optional)

If you have a Postgres connection string, you can apply and verify migrations
with the scripts instead of the SQL editor. Dry-run first; it executes every file
inside one transaction and rolls back, so nothing is committed:

```sh
bun scripts/apply-sql.ts --dry-run \
  drizzle/migrations/0010_rag.sql \
  drizzle/migrations/0011_rag_grants.sql \
  drizzle/migrations/0012_rag_reconcile.sql \
  drizzle/migrations/0013_ingestion_enqueue.sql \
  drizzle/migrations/0014_hybrid_search.sql \
  drizzle/migrations/0015_ingestion_delay.sql \
  drizzle/migrations/0016_backfill_existing_content.sql \
  drizzle/migrations/0017_worker_rpc.sql \
  drizzle/migrations/0018_worker_statement_timeout.sql
```

Then run the same command without `--dry-run`. `verify-rag.ts` needs
`SUPABASE_DB_URL`; the eval runners use Supabase REST and run against Lovable Cloud.

## Useful scripts

| Command                                      | What it does                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `bun run ingest`                             | Drain the due ingestion queue once                                   |
| `bun run ingest:cron`                        | One scheduled tick (used by cron)                                    |
| `bun scripts/ingest-worker.ts --watch`       | Poll continuously                                                    |
| `bun scripts/ingest-worker.ts --backfill`    | Queue library items with no job                                      |
| `bun scripts/extract-spike.ts spike-input`   | Dry-run extraction/chunking to `spike-output/`                       |
| `bun scripts/download-library.ts`            | Download private library files for local checks                      |
| `bun scripts/apply-sql.ts --dry-run <files>` | Run migrations, then roll back without committing (self-hosted only) |
| `bun scripts/run-eval.ts`                    | Recall@k / MRR over `evals/rag-eval.json` (Supabase REST by default) |
| `bun scripts/run-answer-eval.ts`             | Citation, numeric and refusal scoring over the same set              |
| `bun scripts/verify-rag.ts`                  | RLS, grants, indexes and delay smoke test (needs `SUPABASE_DB_URL`)  |

`docs/rag-pipeline.md` describes the full pipeline and its design decisions.
