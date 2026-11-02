/**
 * Standalone ingestion worker. Claims one queued job at a time, downloads the
 * private file, extracts text, chunks, embeds and replaces the document's
 * passages atomically.
 *
 * Usage:
 *   bun scripts/ingest-worker.ts                 # drain the due queue, then exit
 *   bun scripts/ingest-worker.ts --watch         # poll until interrupted
 *   bun scripts/ingest-worker.ts --cron          # one scheduled tick (see below)
 *   bun scripts/ingest-worker.ts --limit 5       # stop after five jobs
 *   bun scripts/ingest-worker.ts --local-dir spike-input
 *   bun scripts/ingest-worker.ts --backfill     # queue library items missing a job
 *
 * Jobs are not claimable the moment they are queued: the trigger in
 * drizzle/migrations/0015_ingestion_delay.sql sets not_before to the upload time
 * plus 120 seconds. This worker honours that deadline and sleeps until it rather
 * than polling past it, so --cron under a one-minute cron (scripts/install-ingest-cron.sh)
 * still starts each file exactly 120 seconds after it was uploaded.
 *
 * File bytes come from the private "content" bucket, authenticated with the
 * service role key when present, otherwise a member session. --local-dir reads
 * the same files from disk instead, for local pipeline checks without Storage.
 *
 * Never print document text or credentials from here: logs carry counts only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import postgres from "postgres";
import type { Database } from "../src/integrations/supabase/types";
import { documentFormat } from "../src/lib/document-format";
import { extractDocument } from "../src/lib/rag/extract";
import {
  buildChunkRows,
  embedTexts,
  hashChunkContents,
  type EmbeddedChunk,
} from "../src/lib/rag/ingest";

const BUCKET = "content";
const MAX_ATTEMPTS = 3;
const SUPPORTED = new Set(["pdf", "docx", "pptx"]);

type Job = {
  id: string;
  content_id: string;
  attempts: number;
  content_hash: string | null;
  chunk_count: number;
  file_path: string;
  file_name: string;
  mime_type: string | null;
};

type Counters = { claimed: number; ready: number; empty: number; skipped: number; failed: number };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const watch = flag("--watch");
/** Scheduled tick: wait out the current minute at most, then exit for cron to rerun. */
const cron = flag("--cron");
const backfill = flag("--backfill");
const limit = Number(value("--limit") ?? 0) || Number.POSITIVE_INFINITY;
const localDir = value("--local-dir") ? resolve(value("--local-dir")!) : null;

/** Longest this invocation sleeps for a job that is not due yet. */
const MAX_WAIT_MS = watch ? 60_000 : cron ? 59_000 : 0;
const IDLE_POLL_MS = 5_000;
/** Cushion past the database deadline so the claim query sees the job as due. */
const DUE_MARGIN_MS = 50;

if (!process.env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is missing from .env");
  process.exit(1);
}
if (!process.env.TOKENFACTORY_API_BASE || !process.env.TOKENFACTORY_API_KEY) {
  console.error("TOKENFACTORY_API_BASE / TOKENFACTORY_API_KEY are missing from .env");
  process.exit(1);
}

const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 2 });
const embedConfig = {
  apiKey: process.env.TOKENFACTORY_API_KEY,
  baseUrl: process.env.TOKENFACTORY_API_BASE,
};

let storage: SupabaseClient<Database> | null = null;
let localFiles: Map<string, string> | null = null;

async function createStorageClient(): Promise<SupabaseClient<Database>> {
  const url = process.env.SUPABASE_URL;
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.LIBRARY_USER_EMAIL;
  const password = process.env.LIBRARY_USER_PASSWORD;

  if (!url) throw new Error("SUPABASE_URL is missing");
  const options = { auth: { persistSession: false, autoRefreshToken: false } };

  if (serviceKey) {
    return createClient<Database>(url, serviceKey, options);
  }
  if (publishable && email && password) {
    const client = createClient<Database>(url, publishable, options);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(
        `No usable Storage credential: set SUPABASE_SERVICE_ROLE_KEY, or a valid LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD (member sign-in failed: ${error.message})`,
      );
    }
    return client;
  }
  throw new Error(
    "Set SUPABASE_SERVICE_ROLE_KEY, or LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD, or pass --local-dir",
  );
}

function findLocalFile(fileName: string): string {
  if (!localFiles) {
    const dir = localDir!;
    localFiles = new Map();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      localFiles.set(entry, path);
      // Spike downloads are prefixed with a content id: "<id8>-<file name>".
      const suffix = entry.indexOf("-");
      if (suffix > 0) localFiles.set(entry.slice(suffix + 1), path);
    }
  }
  const match = localFiles.get(fileName) ?? localFiles.get(basename(fileName));
  if (!match) throw new Error(`No local file matching ${fileName} in ${localDir}`);
  return match;
}

async function readBytes(job: Job): Promise<Uint8Array> {
  if (localDir) {
    return new Uint8Array(readFileSync(findLocalFile(job.file_name)));
  }
  storage ??= await createStorageClient();
  const { data, error } = await storage.storage.from(BUCKET).download(job.file_path);
  if (error || !data) throw new Error(`Download failed: ${error?.message ?? "empty response"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Claims a single job, so two workers never pick the same one. */
async function claimJob(): Promise<Job | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<Job[]>`
      select j.id, j.content_id, j.attempts, j.content_hash, j.chunk_count,
             ci.file_path, ci.file_name, ci.mime_type
      from public.ingestion_jobs j
      join public.content_items ci on ci.id = j.content_id
      where j.status = 'queued'
        and j.not_before <= now()
      order by j.not_before, j.created_at
      limit 1
      for update of j skip locked
    `;
    const job = rows[0];
    if (!job) return null;

    const [updated] = await tx<{ attempts: number }[]>`
      update public.ingestion_jobs
         set status = 'running', attempts = attempts + 1, started_at = now(), updated_at = now()
       where id = ${job.id}
       returning attempts
    `;
    return { ...job, attempts: updated.attempts };
  });
}

/**
 * Milliseconds until the earliest queued job becomes claimable, measured on the
 * database clock; null when nothing is queued. Waiting on this instead of a
 * fixed poll interval is what keeps the 120s delay exact.
 */
async function nextDueInMs(): Promise<number | null> {
  const [row] = await sql<{ seconds: number | null }[]>`
    select extract(epoch from (min(not_before) - clock_timestamp()))::float8 as seconds
      from public.ingestion_jobs
     where status = 'queued'
  `;
  if (!row || row.seconds === null || Number.isNaN(row.seconds)) return null;
  return Math.max(0, Math.round(row.seconds * 1000));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function finish(
  job: Job,
  status: "ready" | "empty" | "skipped",
  patch: { chunkCount: number; contentHash?: string | null; warnings: string[] },
) {
  await sql`
    update public.ingestion_jobs
       set status = ${status},
           chunk_count = ${patch.chunkCount},
           content_hash = ${patch.contentHash ?? null},
           warnings = ${sql.json(patch.warnings)},
           error = null,
           finished_at = now(),
           updated_at = now()
     where id = ${job.id}
  `;
}

/** Records the failure; retries until MAX_ATTEMPTS, then stays failed. */
async function fail(job: Job, message: string): Promise<"queued" | "failed"> {
  const status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
  await sql`
    update public.ingestion_jobs
       set status = ${status},
           error = ${message.slice(0, 500)},
           finished_at = ${status === "failed" ? sql`now()` : null},
           updated_at = now()
     where id = ${job.id}
  `;
  return status;
}

function lowTextWarning(emptyUnits: number): string[] {
  return emptyUnits > 0
    ? [`${emptyUnits} page(s) or slide(s) had almost no extractable text (possible scan)`]
    : [];
}

async function processJob(job: Job, counters: Counters) {
  const startedAt = Date.now();
  const label = `${job.file_name}`;
  const format = documentFormat(job.file_name, job.mime_type ?? "");

  if (!SUPPORTED.has(format)) {
    await finish(job, "skipped", { chunkCount: 0, warnings: [`Format not extracted: ${format}`] });
    counters.skipped += 1;
    console.log(`job ${job.id} ${label} -> skipped (${format})`);
    return;
  }

  const bytes = await readBytes(job);
  const extracted = await extractDocument(job.file_name, job.mime_type ?? "", bytes);
  if (!extracted.ok) throw new Error(extracted.error);

  const rows = buildChunkRows(
    extracted.document.format,
    extracted.document.sections,
    job.file_name,
  );
  const warnings = [
    ...extracted.document.warnings,
    ...lowTextWarning(extracted.document.emptyUnits.length),
  ];

  if (rows.length === 0) {
    await sql`select public.replace_document_chunks(${job.content_id}, ${sql.json([])}, null, 'empty', ${sql.json(warnings)})`;
    counters.empty += 1;
    console.log(`job ${job.id} ${label} -> empty (no extractable text)`);
    return;
  }

  const contentHash = hashChunkContents(rows.map((row) => row.content));
  if (contentHash === job.content_hash && job.chunk_count > 0) {
    // Text unchanged (a move, or a re-run): keep the existing vectors.
    await finish(job, "ready", {
      chunkCount: job.chunk_count,
      contentHash,
      warnings: [...warnings, "Text unchanged; embeddings reused"],
    });
    counters.ready += 1;
    console.log(`job ${job.id} ${label} -> ready (unchanged, ${job.chunk_count} chunks kept)`);
    return;
  }

  const embedded = await embedTexts(
    rows.map((row) => row.content),
    embedConfig,
  );
  const payload: EmbeddedChunk[] = rows.map((row, index) => ({
    ...row,
    embedding: embedded.embeddings[index],
  }));

  const [replaced] = await sql<{ n: number }[]>`
    select public.replace_document_chunks(
      ${job.content_id}, ${sql.json(payload)}, ${contentHash}, 'ready', ${sql.json(warnings)}
    ) as n
  `;

  counters.ready += 1;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const cost =
    embedded.costUsd === null
      ? "n/a"
      : `${embedded.costEstimated ? "~$" : "$"}${embedded.costUsd.toFixed(6)}`;
  console.log(
    `job ${job.id} ${label} -> ready (${replaced.n} chunks, ${embedded.promptTokens ?? "?"} tokens, ${cost}, ${seconds}s)`,
  );
}

async function run() {
  const counters: Counters = { claimed: 0, ready: 0, empty: 0, skipped: 0, failed: 0 };

  // The 120s delay is enforced by the database; without this column the claim
  // query would fail, so fail early with the migration to apply.
  const [delayColumn] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'ingestion_jobs'
         and column_name = 'not_before'
    ) as ok
  `;
  if (!delayColumn?.ok) {
    throw new Error("Apply drizzle/migrations/0015_ingestion_delay.sql before running ingestion");
  }

  // A worker that died mid-job leaves the row in 'running' with no owner.
  const reclaimed = await sql<{ id: string }[]>`
    update public.ingestion_jobs
       set status = 'queued', updated_at = now()
     where status = 'running' and started_at < now() - interval '15 minutes'
    returning id`;
  if (reclaimed.length > 0) console.log(`reclaimed ${reclaimed.length} stale job(s)`);

  if (backfill) {
    const queued = await sql<{ content_id: string }[]>`
      insert into public.ingestion_jobs (content_id)
      select ci.id from public.content_items ci
       where not exists (
         select 1 from public.ingestion_jobs j where j.content_id = ci.id
       )
      on conflict (content_id) do nothing
      returning content_id`;
    console.log(`backfilled ${queued.length} item(s) with no ingestion job`);
  }

  for (;;) {
    const job = await claimJob();
    if (!job) {
      const dueInMs = await nextDueInMs();
      if (dueInMs === null) {
        // Nothing queued at all.
        if (!watch) break;
        await sleep(IDLE_POLL_MS);
        continue;
      }
      if (dueInMs > MAX_WAIT_MS) {
        // Due in a later run: a cron tick waits out its own minute, then exits.
        if (!watch) break;
        await sleep(IDLE_POLL_MS);
        continue;
      }
      if (dueInMs > 1_000) {
        console.log(`next job due in ${Math.ceil(dueInMs / 1000)}s; waiting`);
      }
      // Land just past the deadline; the claim query re-checks it in the database.
      await sleep(Math.max(dueInMs, 250) + DUE_MARGIN_MS);
      continue;
    }

    counters.claimed += 1;
    try {
      await processJob(job, counters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = await fail(job, message);
      if (status === "failed") counters.failed += 1;
      console.error(`job ${job.id} ${job.file_name} -> ${status}: ${message}`);
    }

    if (counters.claimed >= limit) break;
  }

  console.log(
    `\nclaimed ${counters.claimed}, ready ${counters.ready}, empty ${counters.empty}, ` +
      `skipped ${counters.skipped}, failed ${counters.failed}`,
  );
  if (counters.claimed === 0) console.log("Queue is empty.");
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
