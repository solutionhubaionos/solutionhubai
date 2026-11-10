# RAG pipeline — workflow and design notes

How Solution Hub turns uploaded sales material (PDF / DOCX / PPTX) into retrievable
passages, and how a question becomes a grounded, cited answer.

Everything below is read from the code as it stands: `src/lib/rag/*`, `src/lib/chat/*`,
`src/lib/documents/*`, `drizzle/migrations/0010–0018`, `scripts/*`, `evals/rag-eval.json`.

---

## 1. One-paragraph summary

Files land in the private `content` bucket; a database trigger queues an
`ingestion_jobs` row that becomes claimable **120 seconds later**. A Bun worker claims the
job, downloads the bytes, extracts text per page/slide/heading section, chunks each section
into ~600-token passages with ~80 tokens of tail overlap, embeds them with
`qwen/qwen3-embedding-8b` (1536 dims) through a single OpenAI-compatible gateway, and writes
them through allowlisted worker RPCs: ready chunks are staged and committed atomically,
while empty/skipped jobs use `public.worker_replace_document_chunks`. Storage is **Postgres with
pgvector inside Supabase** — not a separate vector DB — so row-level security and cascade
deletes apply to embeddings. At query time a TanStack server function embeds the question,
calls `public.search_chunks`, which runs a **cosine-vector top-50 and a Postgres full-text
top-50 and merges them with reciprocal rank fusion (k = 60)** under the caller's JWT, then a
chat model answers strictly from those numbered passages and returns them as citations.

---

## 2. End-to-end workflow

```mermaid
flowchart TD
  subgraph WRITE["Ingestion (async, server)"]
    U[User uploads file] --> CI[(content_items row<br/>private storage bucket)]
    CI -->|trigger: insert / file_path or file_size change| Q[(ingestion_jobs<br/>status=queued, not_before=now+120s)]
    Q -->|"claim: for update skip locked"| W[Bun worker<br/>scripts/ingest-worker.ts]
    W --> EX[extractDocument<br/>PDF: unpdf · DOCX: mammoth · PPTX: fflate+XML]
    EX --> CH[chunkSections<br/>~600 tok / 80 tok overlap / heading prefix]
    CH --> HS{sha256 of chunk texts<br/>== stored content_hash?}
    HS -->|yes| KEEP[keep existing vectors<br/>status=ready]
    HS -->|no| EM[embedTexts · batch 100<br/>qwen3-embedding-8b · 1536d]
    EM --> REPL[worker_stage_chunks batches<br/>worker_commit_staging<br/>security definer · allowlisted worker<br/>delete + insert + job update, one transaction]
    REPL --> IDX[(document_chunks<br/>HNSW cosine + tsvector GIN)]
  end

  subgraph READ["Retrieval (per request, caller's JWT)"]
    QY[Question + context chips] --> SF[server fn: askLibrary / searchLibrary<br/>requireSupabaseAuth]
    SF --> EQ[embedQuery · one input]
    EQ --> RPC[public.search_chunks<br/>security invoker → RLS applies]
    IDX --> RPC
    RPC --> V[vector top-50<br/>embedding <=> query]
    RPC --> T[FTS top-50<br/>websearch_to_tsquery + ts_rank]
    V --> RRF[RRF k=60<br/>score = Σ 1/(60+rank)]
    T --> RRF
    RRF --> K[top match_count (default 8)]
    K --> AN[generateAnswer<br/>deepseek-v4.1-flash · temp 0.2 · 700 tok]
    AN --> OUT[answer + numbered sources]
  end
```

Same retrieval seam feeds three consumers:

| Consumer                                                         | Server function                                     | Notes                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| AI Search / chat (`/_authenticated/chat`)                        | `askLibrary` (`src/lib/chat/chat.functions.ts`)     | retrieve → answer; history reaches the prompt only, never retrieval (a Phase 2 fix) |
| Retrieval debug page (`/_authenticated/rag-debug`, admin-gated)  | `searchLibrary` (`src/lib/rag/search.functions.ts`) | raw passages + score/vector/text rank, `noindex`                                    |
| Document generation (`src/lib/documents/documents.functions.ts`) | `generateDocument`                                  | retrieve from the confirmed draft, then compose an outline                          |

All three go through `retrieve()` → `searchLibraryChunks()` in `src/lib/rag/search.ts`.

---

## 3. Ingestion pipeline

### 3.1 Enqueue — database triggers (`0013`, `0015`)

- `content_enqueue_ingestion`: `after insert on content_items` → upsert a job with
  `status='queued'`, `not_before = now() + 120 seconds`.
- `content_requeue_ingestion_on_file_change`: `after update of file_path, file_size` →
  re-queue with the delay restarted. **Metadata-only edits (title, customer rename) never
  re-queue**, so a company rename stays cheap and never re-pays for embeddings.
- The delay exists so a quick re-upload/replace inside the same upload flow is parsed once,
  from the final bytes.

### 3.2 Claim and run — `scripts/ingest-worker.ts`

- Claim is a call to `public.worker_claim_job()`, a security-definer RPC that runs
  `select … where status='queued' and not_before <= now() order by not_before,
created_at limit 1 for update skip locked`, then flips the job to `running` and
  increments `attempts` — two workers can never take the same job. The worker
  authenticates as an allowlisted member, so Lovable Cloud needs no Postgres URL
  or service-role key.
- One job at a time per process; modes: default (drain due queue), `--watch`, `--cron`
  (waits out its own minute, then exits), `--limit`, `--local-dir spike-input` (parse files
  from disk, no Storage), `--backfill` (queue library items missing a job via
  `worker_backfill()`), `--workers N` (run N separate processes; the parent validates
  credentials and checks the queue once, so an idle cron tick costs one sign-in).
  `--limit` applies per worker when concurrency is on.
- Scheduling: `scripts/install-ingest-cron.sh` installs a one-minute crontab entry that runs
  `--cron`, logging to `.ingest.log`. The worker sleeps until the _exact_ `not_before`
  (measured on the DB clock via `worker_next_due_seconds()`), which is what keeps the
  120-second delay exact despite a one-minute cron granularity.
- Resilience: a claimed job is leased. The worker refreshes
  `ingestion_jobs.heartbeat_at` every minute via `worker_heartbeat()`, so a slow
  document keeps its job; `worker_reclaim_stale()` only requeues a job whose heartbeat
  has been silent for five minutes (a dead process). A reclaim keeps the attempt
  counted, so a worker that keeps crashing reaches the three-attempt limit and the file
  persists as `failed` instead of looping. Other failures re-queue immediately until
  that same limit (`worker_fail_job()`), then persist as `failed` with a truncated error.
- File bytes come from the private `content` bucket using the service-role key if present,
  otherwise a member sign-in. The account must be listed in
  `public.ingestion_worker_users`; every `worker_*` RPC checks that allowlist. Ready chunks
  are staged in `ingestion_chunk_staging` in batches of 10 and committed in one RPC, so
  large documents stay under the Data API request limit. Logs carry counts and timing only
  — never document text or credentials.

### 3.3 Extraction — `src/lib/rag/extract.ts`

One entry point, `extractDocument(fileName, mimeType, bytes)`, returning sections plus
`emptyUnits` and warnings. Supported formats are exactly **pdf, docx, pptx**; anything else
is marked `skipped` ("Format not extracted").

| Format | Engine                                                                                              | Section unit                                                                       |
| ------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PDF    | `unpdf` (PDF.js), `mergePages: false`                                                               | one section per **page**, page number kept                                         |
| DOCX   | `mammoth.convertToHtml` + custom style map (`Section Heading`, `Heading 0`, `Title` → `h1`)         | split on `<h1>…<h6>` headings, heading carried on the section                      |
| PPTX   | `fflate.unzipSync` with a filter for `ppt/slides/*.xml` + notes only (image-heavy decks stay cheap) | one section per **slide**, speaker notes appended as `Notes: …`, slide number kept |

Details worth knowing:

- PPTX text is pulled from `<a:t>` runs inside `<a:p>` paragraphs, XML entities decoded;
  broken media relationships are ignored so decks with bad links still extract.
- `isLowText()` flags pages/slides with `< 20` non-whitespace characters
  (`MIN_USEFUL_CHARS`) — probable scans — and surfaces them as a warning
  ("N page(s) or slide(s) had almost no extractable text (possible scan)").
- An extraction failure is returned as `{ ok: false, error }`, not thrown; the job then
  retries and eventually fails rather than writing garbage.
- This module is deliberately free of Node/Deno specifics: it runs in the Bun worker today
  and was written to be portable to an Edge Function.

### 3.4 Chunking — `src/lib/rag/chunk.ts`

**Method: structure-aware recursive sentence chunking** (section-preserving, with overlap).
Pure and dependency-free by design.

Parameters (defaults, overridable via `ChunkOptions`):

| Knob              | Default | Meaning                                                  |
| ----------------- | ------- | -------------------------------------------------------- |
| `targetTokens`    | **600** | target chunk size → `targetChars = 600 × 4`              |
| `overlapTokens`   | **80**  | tail text repeated into the next chunk                   |
| `CHARS_PER_TOKEN` | **4**   | approximation used by `estimateTokens()` (`ceil(len/4)`) |

Algorithm:

1. **Sections are never merged.** Pages, slides and heading blocks stay separate so
   `page` / `slide` / `heading` on a chunk are always truthful.
2. Normalize: CRLF → LF, collapse trailing spaces, collapse 3+ newlines to 2.
3. Split into units on sentence-ending punctuation followed by whitespace, and on newlines;
   drop empties.
4. Any unit longer than the target is split on **word boundaries** into pieces of at most
   `target − overlap − 1` characters (`splitOversizedUnit`).
5. Greedily pack units into a chunk; when adding the next unit would exceed the target,
   flush and **seed the new chunk with the tail of the previous one** (`trailingText`, up to
   `overlapChars`, cut at a word boundary).
6. On flush, prefix the section heading: `Heading\n\nbody` — so a heading split across a long
   section appears on **every** resulting chunk.
7. `chunkIndex` is the running index across the whole document (0-based), which is what the
   `unique (content_id, chunk_index)` constraint relies on.

What it is **not**: no semantic/embedding-based chunking, no sliding window with fixed step,
no parent-child or small-to-big chunking, no per-chunk summary metadata. That is a deliberate
trade for determinism and accurate citations.

### 3.5 Embedding — `src/lib/rag/embeddings.ts` + `config.ts`

```ts
EMBEDDING_MODEL      = "qwen/qwen3-embedding-8b"
EMBEDDING_DIMENSIONS = 1536   // must equal document_chunks.embedding vector(1536)
EMBEDDING_BATCH_SIZE = 100    // provider cap
EMBEDDING_USD_PER_TOKEN = 1e-7
ANSWER_MODEL         = "deepseek/deepseek-v4.1-flash"
ANSWER_MAX_TOKENS    = 700
DEFAULT_MATCH_COUNT  = 8      MAX_MATCH_COUNT = 50
```

- OpenAI-compatible `POST {baseUrl}/embeddings`, `Authorization: Bearer` gateway key
  (`TOKENFACTORY_API_BASE` / `TOKENFACTORY_API_KEY`), `dimensions: 1536` requested explicitly.
- Batched in provider-sized chunks (clamped to 1–100), **order restored from `data[].index`**
  in case the provider reorders, and each vector's length validated — a short/long vector is
  a hard error rather than a silently truncated row.
- Usage tracking: sums `prompt_tokens`; cost comes from `usage.cost` when the provider
  returns it, otherwise falls back to `promptTokens × 1e-7` and flags `costEstimated`, so the
  worker log distinguishes `$` from `~$`.
- `embedTexts()` is shared by ingestion, the eval runner and query embedding; `embedQuery()`
  wraps it for exactly one input and refuses an empty string.

**Idempotency:** before embedding, the worker hashes the chunk texts
(`sha256` of contents joined with `\u0000`, `hashChunkContents`). If the hash matches the
job's stored `content_hash` and `chunk_count > 0`, embeddings are reused and the job finishes
as `ready (unchanged)`. A move, copy or re-run therefore costs nothing.

---

## 4. Storage

**Choice: vectors live in Postgres (Supabase) with pgvector, not a dedicated vector DB.**
The stated reason in `0010_rag.sql`: _"Vector search stays in Postgres so RLS and cascade
deletes apply to it."_ Metadata (`title`, `industry`, `customer_name`, `file_name`,
`file_path`) is **never copied onto the chunk** — it is joined from `content_items` at query
time, so moves, copies and company renames can never leave stale values on a passage.

### 4.1 Tables

**`public.document_chunks`** (`0010`)

| Column             | Notes                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `content_id`       | `→ content_items(id) on delete cascade`                                                                |
| `chunk_index`      | `unique (content_id, chunk_index)`, `>= 0`                                                             |
| `content`          | `check (content <> '')` — empty passages cannot exist                                                  |
| `estimated_tokens` | `> 0`                                                                                                  |
| `page` / `slide`   | `check (page is null or slide is null)` and both `> 0` — mutually exclusive                            |
| `heading`          | from DOCX headings                                                                                     |
| `embedding`        | `vector(1536) not null`                                                                                |
| `embedding_model`  | default `qwen/qwen3-embedding-8b`, so a model switch is visible, not guessed                           |
| `tsv`              | **generated column** `to_tsvector('english', content)` (`0012`), explicit regconfig keeps it immutable |

Indexes:

- `document_chunks_embedding_idx` — **HNSW** on `embedding vector_cosine_ops`.
- `document_chunks_tsv_idx` — **GIN** on `tsv`.

**`public.ingestion_jobs`** — one row per content item (`content_id unique`), status
`queued | running | ready | empty | skipped | failed`, `attempts`, `chunk_count`,
`embedding_model`, `dimensions`, `warnings jsonb`, `error`, timestamps, `content_hash`
(`0012`), `not_before` (`0015`) with a partial index on `(not_before) where status='queued'`
and a claim index `(status, created_at)`. Status semantics: `empty` = supported format
yielded no usable text (probable scan), `skipped` = format not extracted.

**`public.chat_threads` / `public.chat_messages`** — owner-only chat history with a
`citations jsonb` column so answers keep their sources.

### 4.2 Atomic write — `replace_document_chunks` (`0012`, `0017`)

`replace_document_chunks` is `security definer`, `search_path` pinned, and **executed only
by `service_role`** (revoked from `public`, `anon`, `authenticated`). For one content item
it validates the payload, then in a single call: `delete from document_chunks where
content_id = …`, inserts all new rows from a `jsonb` array, counts them, and updates the
job row (status, chunk_count, content_hash, warnings, `finished_at`). A retry can never
duplicate passages, and a failure mid-way leaves the previous chunks intact because the
caller is in one transaction.

`0017` adds `worker_replace_document_chunks`, a `security definer` wrapper callable by an
allowlisted worker. It checks `is_ingestion_worker()`, requires a `running` job for the
content item, and delegates to the inner function. For `skipped` it deletes any old chunks
first, so replacing a supported file with an unsupported one cannot leave stale passages.

Large documents can produce tens of megabytes of embedding JSON, which exceeds the Data API
request limit. `0017` therefore also adds `ingestion_chunk_staging`: the worker writes
chunks there in batches of 10, then `worker_commit_staging` deletes the old passages,
copies the whole staged set into `document_chunks`, and updates the job in one transaction.
If the worker dies before the commit, the old chunks stay intact and the next attempt clears
the staging rows.

### 4.3 Security model

- `document_chunks`: RLS enabled; policy **"Allowed users read chunks"** requires
  `is_allowed_email(auth.jwt()->>'email')` **and** a visible parent `content_items` row.
  Grants: `select` to `authenticated`, `all` to `service_role`, **nothing to `anon`**.
- `ingestion_jobs`: readable by `is_content_admin()` only.
- `ingestion_worker_users`: no direct grants to `anon` or `authenticated`; only the
  security-definer worker RPCs read it. Add the library worker account there after applying
  `0017`.
- `0011_rag_grants.sql` explicitly `revoke all` from `anon, authenticated` and re-grants the
  narrow set, because Supabase's default privileges would otherwise grant `ALL` to `anon`.
- All retrieval functions are **`security invoker`**, so the caller's JWT and RLS decide what
  exists. `replace_document_chunks` is the single `security definer` exception for writes;
  `0017` exposes it to the worker through an allowlisted wrapper. Search code never falls
  back to the service role.

---

## 5. Retrieval and hybrid search

### 5.1 Query construction (before retrieval)

- `searchLibrary`: raw query, 2–500 chars, optional `industry` / `customer` / `matchCount`.
- `askLibrary` (chat): `retrievalInputs(context)` turns the context chips into
  **filters vs. hints** — exactly one industry/customer picked becomes a real SQL filter;
  multiple picks are appended to the search text instead of silently narrowing to the first.
  `buildRetrievalQuery()` then embeds `question + "\nContext: hint, hint, …"`.

  Two defects are measured by the Phase 0 eval rather than hidden: the question is
  embedded as typed, so a follow-up loses its referent, and the same hint text goes to
  the full-text arm, where `websearch_to_tsquery` ANDs the hints with the question and
  kills text recall.

- `generateDocument`: builds the query from the **confirmed draft** (title, subtitle, client,
  industry, sector, outline headings), capped at 400 chars, filtering on `industrySlug`.

Only the query embedding ever leaves the server; document text never reaches a third party.

### 5.2 `public.search_chunks` (`0014`) — the hybrid core

```
search_chunks(query_embedding vector(1536), query_text, filter_industry,
              filter_customer, match_count default 8)
  → chunk_id, content_id, content, page, slide, heading, title, file_name,
    file_path, industry, customer_name, vector_rank, text_rank, score
```

Steps:

1. **`scoped`** — `document_chunks` joined to `content_items`, applying the industry and
   customer filters (blank/whitespace filters are neutralized with
   `nullif(btrim(coalesce(...,'')),'')`, so an empty string can never mean "match nothing").
   Vector distance `embedding <=> query_embedding` computed here.
2. **`vector_hits`** — order by cosine distance, **limit 50**, `row_number()` → `rank`.
3. **`query_ts`** — `websearch_to_tsquery('english', query_text)` (handles quotes, `or`,
   `-exclusion` like a user would type it).
4. **`text_matches`** — rows where `tsv @@ query`, ranked by `ts_rank(tsv, ts)` descending,
   **limit 50**; `text_hits` converts to ranks.
5. **`merged`** — `full outer join` of the two lists (a chunk in only one list still
   survives) with **reciprocal rank fusion**:

   ```
   score = coalesce(1/(60 + vector_rank), 0) + coalesce(1/(60 + text_rank), 0)
   ```

   k = 60 is the standard RRF constant. RRF is chosen over score-weighted blending because
   cosine distances and `ts_rank` scores are not on comparable scales — ranks are.

6. **Order** by `score desc`, then `vector_rank`, then `text_rank`, then `chunk_id` (a stable
   tie-break, so pagination/evals are reproducible).
7. **Limit** `least(greatest(coalesce(match_count,8),1), 50)` — the caller can ask for
   anything; the function clamps to 1–50. TypeScript mirrors this with `clampMatchCount()`.

Returns both `vector_rank` and `text_rank` alongside the fused `score`, which is what the
debug page shows and what makes a fusion change debuggable.

### 5.3 What runs on the client/server side of the RPC

`src/lib/rag/search.ts`:

- `formatVectorLiteral()` serializes the vector to PostgREST's text form `[0.1,0.2,…]`,
  rejecting wrong dimensions or non-finite values _before_ the request.
- `mapSearchRows()` converts rows to `RetrievedChunk`.
- `normalizeScope()` trims and turns blanks into `null`.
- `retrieve(query, scope, k, deps)` is the single seam: empty query → `[]` without calling
  the provider; otherwise embed once, search once. Provider failures **propagate** rather
  than being swallowed as "no results".

### 5.4 Re-ranking — what is and isn't there

**Implemented:** RRF over two ranked lists (the fusion in step 5), plus deterministic
tie-breaking, scope filtering, and document-level dedup at the consumer
(`rankFiles()` in `eval.ts` keeps the first chunk per file).

**Not implemented:** there is **no cross-encoder / learned re-rank stage**, no LLM-based
reranking, no query expansion or HyDE, no multi-query fusion, and no score-threshold
cutoff. The eval runner says so explicitly — when recall misses the threshold it prints
_"Iterate on chunk size, fusion or add the rerank step, and report before/after"_, i.e.
reranking is a named future step, not a current one. Adding one would mean taking the
`vector_hits ∪ text_hits` candidate set (or the top ~50) and scoring it with a reranker
before the final `limit`, which is why the function already exposes both ranks.

Two related tuning notes:

- `match_document_chunks` (`0010`) is the older **vector-only** path (cosine order, cap 20,
  optional industry filter). It is still registered and covered by tests, but production
  retrieval uses `search_chunks`.
- The applied `0014` does **not** set `hnsw.ef_search` / `hnsw.iterative_scan` (an earlier
  draft did). With HNSW filtering happening after the index scan, a very narrow industry or
  customer scope can in principle starve the 50-row candidate list on a large table — worth
  revisiting if scoped queries ever underperform.

---

## 6. Answer generation (grounded generation)

`src/lib/chat/answer.ts`, called from `askLibrary`:

1. If retrieval returns **zero passages**, no model call happens at all — the canned
   `noPassagesAnswer()` is returned (`grounded: false`). There is nothing to hallucinate
   from.
2. `buildContextBlocks()` numbers each passage `[1] … [k]` in retrieval order with a header
   line `[n] · title · (file, page N) · industry: … · customer: …` and truncates the body to
   **`MAX_CONTEXT_CHARS = 1400`** (the full chunk is still kept for the UI snippet).
3. `SYSTEM_PROMPT` constrains the model: answer using **only** the numbered passages, cite
   every factual claim as `[1]` / `[2][3]` at the end of the sentence it supports, say
   plainly when the passages don't answer and name what's missing, never guess, no headings
   or tables.
4. History: last **6 messages** (`MAX_HISTORY_MESSAGES`) are passed through.
5. `generateAnswer()` → same gateway, `ANSWER_MODEL = deepseek/deepseek-v4.1-flash`,
   `max_tokens 700`, `temperature 0.2`, empty content = error.
6. `collectSources()` produces one `ChatSource` per retrieved chunk (citation number,
   chunk/content ids, title, file, industry, customer, page/slide, 320-char snippet) so every
   claim is traceable back to a file the caller's RLS already allowed.

Because retrieval runs under the user's JWT, **citations can never point at a file the user
can't read** — retrieval, not the model, decides visibility.

Document generation follows the same shape: `passagesBlock()` (1200 chars/passage),
`COMPOSE_SYSTEM_PROMPT` (JSON-only outline, no invented customers/numbers), `temperature 0.4`,
`max_tokens 1600`, and a deterministic `fallbackOutline()` derived from first sentences of
the passages when the provider fails — so a demo never dies on a bad completion. Nothing is
written to Storage.

---

## 7. Evaluation and verification

| Tool                             | What it does                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evals/rag-eval.json`            | 125 cases, `k = 8`: 46 original plus 17 `multi-turn`, 31 `chart-table`/diagram, 10 `scope-mode`, 10 `adversarial`, 11 `projection`; cases carry `turns`, `evidence`, `mustMention`, `expectation` and `scopeMode`                                                                                                                                                                         |
| `scripts/run-eval.ts`            | Runs the production query path (context hints, scope logic, optional `--prefix instruct`) and the **real** `search_chunks` as an authenticated member; uses the Supabase REST backend by default (signs in as `LIBRARY_USER_EMAIL` and calls the same RPC as the app, so RLS applies), or direct Postgres when `SUPABASE_DB_URL` is a `postgres://` URI; scores document/chunk recall@k, MRR, nDCG@k and the unanswerable false-positive rate per category; `--diagnostics`, `--json` |
| `scripts/run-answer-eval.ts`     | Generates one answer per case, then scores citation validity (LLM judge, strict rubric), numeric faithfulness (deterministic), `mustMention` completeness and refusal accuracy; `--no-judge`, `--json`, `--strict`                                                                                                                                                                        |
| `src/lib/rag/eval.ts`            | Pure retrieval scoring: `resolveCaseQuestion()`, `chunkMatchesCase()` (file + evidence), `rankFiles()`, `ndcgAtK()`, `evaluateCase()`, `summarize()` (per-category recall/MRR/nDCG and false-positive rate)                                                                                                                                                                               |
| `src/lib/rag/answer-eval.ts`     | Pure answer scoring: sentence splitting, number normalisation, `checkNumericFaithfulness()`, `checkCitations()`, `completeness()`, `isRefusal()`, judge prompt and verdict parsing                                                                                                                                                                                                        |
| `docs/rag-eval-baseline.md`      | Phase 0 metric definitions, commands, diagnostics and the baseline table every later phase reports against                                                                                                                                                                                                                                                                                |
| `scripts/verify-rag.ts`          | RLS smoke test in a single transaction that is **rolled back**: checks the HNSW index exists, `anon` has no SELECT, both functions are `security invoker`, member A reads/retrieves, industry filter includes/excludes correctly, member B and anon are denied; needs `SUPABASE_DB_URL`, so it is self-hosted only                                                                        |
| `bun run test` (`vitest`)        | Unit coverage for the chunker (split, overlap, heading repetition, page/slide mapping, token cap), search (scope normalization, clamping, vector literal, RPC args, error propagation), eval scoring, extraction, ingestion hashing                                                                                                                                                       |
| `scripts/extract-spike.ts`       | Writes per-file chunks to `spike-output/` for eyeballing extraction + chunk shape before anything is embedded                                                                                                                                                                                                                                                                             |
| `bun run ingest` / `ingest:cron` | Runs the worker; `.ingest.log` shows per-job chunk counts, tokens, cost and duration, ending in a summary line                                                                                                                                                                                                                                                                            |

---

## 8. Operating it

```bash
bun run ingest            # drain the due queue once
bun run ingest:cron       # one scheduled tick (used by scripts/install-ingest-cron.sh)
bun scripts/ingest-worker.ts --watch --limit 5
bun scripts/ingest-worker.ts --backfill          # queue library items with no job
bun scripts/extract-spike.ts                     # dry-run extraction/chunking locally
bun scripts/run-eval.ts --verbose                # recall@8 / MRR, must be >= 80%
bun scripts/verify-rag.ts                        # RLS + index + grants smoke test
```

Required env on Lovable Cloud: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`LIBRARY_USER_EMAIL` + `LIBRARY_USER_PASSWORD` (private Storage and worker RPCs), and
`TOKENFACTORY_API_BASE` + `TOKENFACTORY_API_KEY` (embeddings and answers). `SUPABASE_DB_URL`
and `SUPABASE_SERVICE_ROLE_KEY` are optional and only available on self-hosted Supabase;
`apply-sql.ts` and `verify-rag.ts` need `SUPABASE_DB_URL`. The eval runners do not: they use
Supabase REST and the library member session by default, and only use direct Postgres for
`EXPLAIN` and the pgvector version when a Postgres URI is present.

Migration order matters: `0010` (tables, HNSW, first RPC) → `0011` (grants) → `0012`
(tsvector, content hash, atomic replace) → `0013` (enqueue triggers) → `0014` (hybrid
`search_chunks`) → `0015` (120 s delay) → `0016` (queue existing content, retry failed
jobs) → `0017` (worker allowlist and RPCs) → `0018` (raises `statement_timeout` to 60 s
on the chunk-write RPCs; Supabase's 8 s cap for `authenticated` aborted large commits).
The worker refuses to start if `0017` is
missing or the account is not in `ingestion_worker_users`, and `EMBEDDING_DIMENSIONS` in
`config.ts` must stay equal to `vector(1536)` — changing one without the other silently
breaks retrieval.

---

## 9. Design decisions and gaps

**Deliberate choices**

- Vectors in Postgres over a vector DB: RLS, cascade deletes and transactional replacement
  come for free; scale does not yet justify a second system.
- RRF instead of weighted score blending: two incommensurable score scales.
- Section-preserving chunking: page/slide/heading on every chunk keeps citations exact.
- Structure-aware chunking over semantic chunking: deterministic, testable, no extra model
  calls.
- Security-invoker RPCs so authorization is enforced in one place (the database).
- Reused embeddings via content hash, and a 120 s enqueue delay, to avoid paying twice.
- Metadata joined at query time rather than denormalized onto chunks.

**Known gaps / natural next steps**

1. **No re-rank stage** — RRF only; the eval message names "add the rerank step" as the
   lever when recall falls short.
2. **No `hnsw.ef_search` / `iterative_scan` tuning** in the applied migration — scoped
   queries may starve the candidate list at scale.
3. No query expansion, HyDE, multi-query fusion, or score thresholding.
4. No chunk-level dedup or parent-child retrieval (a long answer can span two chunks of the
   same file; the UI dedups by file only).
5. Token counting is `chars / 4`, not a real tokenizer — fine for sizing, not for billing.
6. The debug route is explicitly marked _"Temporary debug surface … remove once chat ships"_.
7. The Phase 0 retrieval/answer runners use Supabase REST by default and run against
   Lovable Cloud; direct Postgres is only needed for `EXPLAIN` and the pgvector version,
   which the REST API does not expose.

## 10. Production cutover checklist

Lovable Cloud does not expose a Postgres connection string or a service-role key. The app
and worker use the same project from `.env` (`SUPABASE_URL`, the publishable key, and the
library member). Project ids are not hardcoded in application code; the local
`supabase/config.toml` is only a CLI hint.

1. Apply the migrations in the Lovable SQL editor
   (**More → Database → Manage → SQL editor**), in order `0010` → `0018`. Paste one file at
   a time. The editor asks for confirmation on destructive statements; these migrations
   are additive. If you have a self-hosted Postgres URL, you can instead dry-run the same
   list with `bun scripts/apply-sql.ts --dry-run …`, then apply it without `--dry-run`.
2. What the migrations touch: `0010`–`0015` create new tables, indexes, functions and
   policies, and add two triggers to `content_items`; they do not change existing rows or
   columns. `0016` inserts/updates only the new `ingestion_jobs` table. `0017` creates
   `ingestion_worker_users`, `ingestion_chunk_staging` and the worker RPCs; the allowlist
   insert adds one row to `ingestion_worker_users`. The worker reads `content_items` and
   Storage, and writes only `document_chunks`, `ingestion_jobs` and the short-lived staging
   table.
3. Add the worker account in the SQL editor:

   ```sql
   insert into public.ingestion_worker_users (user_id)
   select id from auth.users where lower(email) = lower('<your-library-user-email>')
   on conflict do nothing;
   ```

4. Add the server-only values to `.env`: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `LIBRARY_USER_EMAIL`, `LIBRARY_USER_PASSWORD`, `TOKENFACTORY_API_BASE`,
   `TOKENFACTORY_API_KEY`. No `SUPABASE_DB_URL` or service-role key is needed on Lovable
   Cloud.
5. Run `bun scripts/ingest-worker.ts --backfill` once, then
   `./scripts/install-ingest-cron.sh`. The cron entry runs `--cron` every minute; each tick
   waits for the exact `not_before` deadline, so a file is picked up 120 seconds after
   upload rather than on the next minute boundary.
6. Verify with `.ingest.log` and the admin debug page at `/_authenticated/rag-debug`, which
   shows raw passages and both ranks. `verify-rag.ts` requires `SUPABASE_DB_URL`; the
   eval runners use Supabase REST and run against Lovable Cloud.
