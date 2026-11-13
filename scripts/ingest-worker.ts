/**
 * Standalone ingestion worker. Claims one queued job at a time through the
 * worker_* RPCs, downloads the private file, extracts text, chunks, embeds and
 * replaces the document's passages atomically.
 *
 * Lovable Cloud does not expose a Postgres URL or service-role key, so the
 * worker signs in as the library member and calls authenticated RPCs added by
 * drizzle/migrations/0017_worker_rpc.sql. The account must be listed in
 * public.ingestion_worker_users. A service-role key still works when present.
 *
 * Usage:
 *   bun scripts/ingest-worker.ts                 # drain the due queue, then exit
 *   bun scripts/ingest-worker.ts --watch         # poll until interrupted
 *   bun scripts/ingest-worker.ts --cron          # one scheduled tick (see below)
 *   bun scripts/ingest-worker.ts --limit 5       # stop after five jobs
 *   bun scripts/ingest-worker.ts --local-dir spike-input
 *   bun scripts/ingest-worker.ts --backfill      # queue library items missing a job
 *   bun scripts/ingest-worker.ts --workers 5     # five workers, each a separate process
 *
 * --workers runs several workers at once. worker_claim_job() takes a job with
 * `for update skip locked`, so two workers can never claim the same file; a
 * second worker always moves on to the next queued one.
 *
 * A claimed job is leased: the worker refreshes ingestion_jobs.heartbeat_at every
 * minute, and the database only takes a job back once its heartbeat has stopped
 * for five minutes. A slow document therefore keeps its lease, and only a worker
 * that actually died loses one.
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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { documentFormat } from "../src/lib/document-format";
import { EXTRACTOR_VERSION } from "../src/lib/rag/config";
import { extractDocument, readMediaFiles } from "../src/lib/rag/extract";
import {
  buildChunkRows,
  embedTexts,
  embeddingTexts,
  hashIngest,
  type EmbeddedChunk,
} from "../src/lib/rag/ingest";
import { describeImage } from "../src/lib/rag/vision";

const BUCKET = "content";
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

/**
 * Parallel workers. Each runs as its own OS process, so extraction runs on its
 * own core instead of blocking a shared event loop. INGEST_WORKER_CHILD marks a
 * spawned child so it never spawns again.
 */
const requestedWorkers = Math.trunc(Number(value("--workers") ?? 1)) || 1;
const workerCount =
  process.env.INGEST_WORKER_CHILD === "1" ? 1 : Math.min(Math.max(requestedWorkers, 1), 16);

/** Longest this invocation sleeps for a job that is not due yet. */
const MAX_WAIT_MS = watch ? 60_000 : cron ? 59_000 : 0;
const IDLE_POLL_MS = 5_000;
/** Cushion past the database deadline so the claim query sees the job as due. */
const DUE_MARGIN_MS = 50;
/**
 * How often a running job's lease is refreshed. 0017 reclaims a job whose
 * heartbeat is older than five minutes, so five beats may be missed before a
 * file is handed to another worker.
 */
const HEARTBEAT_MS = 60_000;

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const libraryEmail = process.env.LIBRARY_USER_EMAIL;
const libraryPassword = process.env.LIBRARY_USER_PASSWORD;

if (!process.env.SUPABASE_URL) {
  console.error("SUPABASE_URL is missing from .env");
  process.exit(1);
}
if (!serviceKey && (!process.env.SUPABASE_PUBLISHABLE_KEY || !libraryEmail || !libraryPassword)) {
  console.error(
    "Set SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_PUBLISHABLE_KEY + LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD",
  );
  process.exit(1);
}
if (!process.env.TOKENFACTORY_API_BASE || !process.env.TOKENFACTORY_API_KEY) {
  console.error("TOKENFACTORY_API_BASE / TOKENFACTORY_API_KEY are missing from .env");
  process.exit(1);
}

const embedConfig = {
  apiKey: process.env.TOKENFACTORY_API_KEY!,
  baseUrl: process.env.TOKENFACTORY_API_BASE!,
};

/**
 * Vision is opt-in. Slides whose only content is a picture need a model that can
 * read it; without one they stay text-only rather than guessed at.
 */
const visionEnabled = process.env.RAG_VISION === "1";
const visionModel = process.env.RAG_VISION_MODEL ?? "google/gemma-4-31b-it";
/** Cost guard: a deck with forty screenshots gets its first eight described. */
const VISION_MAX_IMAGES = 8;

let supabase: SupabaseClient | null = null;
let localFiles: Map<string, string> | null = null;

async function getClient(): Promise<SupabaseClient> {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL!;
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };

  if (serviceKey) {
    supabase = createClient(url, serviceKey, options);
    return supabase;
  }

  const next = createClient(url, publishable!, options);
  const { error } = await next.auth.signInWithPassword({
    email: libraryEmail!,
    password: libraryPassword!,
  });
  if (error) throw new Error(`Member sign-in failed: ${error.message}`);
  supabase = next;
  return supabase;
}

/** Fails fast with the exact SQL when 0017 has not been applied or the account is not listed. */
async function checkWorkerAccess() {
  const client = await getClient();
  const { data, error } = await client.rpc("is_ingestion_worker");
  if (error) {
    if (error.code === "PGRST202") {
      throw new Error("Apply drizzle/migrations/0017_worker_rpc.sql before running ingestion");
    }
    throw new Error(`Worker access check failed: ${error.message}`);
  }
  if (!data) {
    const email = libraryEmail ?? "<worker email>";
    throw new Error(
      "This account is not an ingestion worker. Add it in the Lovable SQL editor:\n" +
        "insert into public.ingestion_worker_users (user_id)\n" +
        `select id from auth.users where lower(email) = lower('${email}')\n` +
        "on conflict do nothing;",
    );
  }
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
  const client = await getClient();
  const { data, error } = await client.storage.from(BUCKET).download(job.file_path);
  if (error || !data) throw new Error(`Download failed: ${error?.message ?? "empty response"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Claims a single job in one database function, so two workers never pick the same one. */
async function claimJob(): Promise<Job | null> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_claim_job");
  if (error) throw new Error(`Could not claim a job: ${error.message}`);
  const rows = (data as Job[] | null) ?? [];
  return rows[0] ?? null;
}

/**
 * Milliseconds until the earliest queued job becomes claimable, measured on the
 * database clock; null when nothing is queued. Waiting on this instead of a
 * fixed poll interval is what keeps the 120s delay exact.
 */
async function nextDueInMs(): Promise<number | null> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_next_due_seconds");
  if (error) throw new Error(`Could not read the queue deadline: ${error.message}`);
  if (data === null || data === undefined) return null;
  const seconds = Number(data);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.round(seconds * 1000));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function finish(
  job: Job,
  patch: { chunkCount: number; contentHash?: string | null; warnings: string[] },
) {
  const client = await getClient();
  const { error } = await client.rpc("worker_finish_job", {
    p_job_id: job.id,
    p_status: "ready",
    p_chunk_count: patch.chunkCount,
    p_content_hash: patch.contentHash ?? null,
    p_warnings: patch.warnings,
    p_extractor_version: EXTRACTOR_VERSION,
  });
  if (error) throw new Error(`Could not finish job ${job.id}: ${error.message}`);
}

const STAGING_BATCH = 10;

async function beginStaging(jobId: string) {
  const client = await getClient();
  const { error } = await client.rpc("worker_begin_staging", { p_job_id: jobId });
  if (error) throw new Error(`Could not start staging: ${error.message}`);
}

async function stageChunks(jobId: string, chunks: readonly EmbeddedChunk[]) {
  const client = await getClient();
  const { error } = await client.rpc("worker_stage_chunks", {
    p_job_id: jobId,
    p_chunks: chunks,
  });
  if (error) throw new Error(`Could not stage chunks: ${error.message}`);
}

async function commitStaging(jobId: string, contentHash: string, warnings: string[]) {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_commit_staging", {
    p_job_id: jobId,
    p_content_hash: contentHash,
    p_status: "ready",
    p_warnings: warnings,
    p_extractor_version: EXTRACTOR_VERSION,
  });
  if (error) throw new Error(`Could not commit chunks: ${error.message}`);
  return Number(data ?? 0);
}

async function replaceChunks(
  job: Job,
  chunks: readonly EmbeddedChunk[],
  contentHash: string | null,
  status: "ready" | "empty" | "skipped",
  warnings: string[],
): Promise<number> {
  if (status === "ready" && chunks.length > 0) {
    if (!contentHash) throw new Error("Ready chunks need a content hash");
    // The Data API has a request-size limit; stage in small batches, then
    // copy the whole set into document_chunks in one atomic RPC.
    await beginStaging(job.id);
    for (let index = 0; index < chunks.length; index += STAGING_BATCH) {
      await stageChunks(job.id, chunks.slice(index, index + STAGING_BATCH));
    }
    return commitStaging(job.id, contentHash, warnings);
  }

  const client = await getClient();
  const { data, error } = await client.rpc("worker_replace_document_chunks", {
    p_content_id: job.content_id,
    p_chunks: chunks,
    p_content_hash: contentHash,
    p_status: status,
    p_warnings: warnings,
    p_extractor_version: EXTRACTOR_VERSION,
  });
  if (error) throw new Error(`Could not replace chunks: ${error.message}`);
  return Number(data ?? 0);
}

/** Records the failure; retries until the database's three-attempt limit, then stays failed. */
async function fail(job: Job, message: string): Promise<"queued" | "failed"> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_fail_job", {
    p_job_id: job.id,
    p_error: message.slice(0, 500),
  });
  if (error) throw new Error(`Could not record failure for job ${job.id}: ${error.message}`);
  return data === "failed" ? "failed" : "queued";
}

async function reclaimStale(): Promise<number> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_reclaim_stale");
  if (error) throw new Error(`Could not reclaim stale jobs: ${error.message}`);
  return Number(data ?? 0);
}

/** True while this worker still owns the job; false once another worker took it. */
async function heartbeat(job: Job): Promise<boolean> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_heartbeat", { p_job_id: job.id });
  if (error) throw new Error(`Could not heartbeat job ${job.id}: ${error.message}`);
  return data === true;
}

/**
 * Refreshes the lease while a job is processed, so a legitimately slow document
 * is never mistaken for a dead worker and handed to a second process.
 */
function startHeartbeat(job: Job): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    heartbeat(job)
      .then((owned) => {
        if (!owned && !stopped) {
          stopped = true;
          clearInterval(timer);
          console.warn(`job ${job.id} lease lost: another worker owns it now`);
        }
      })
      .catch((error) => {
        // Not fatal: the job only has to finish inside the five-minute window.
        console.error(
          `job ${job.id} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function backfillJobs(): Promise<number> {
  const client = await getClient();
  const { data, error } = await client.rpc("worker_backfill");
  if (error) throw new Error(`Could not backfill jobs: ${error.message}`);
  return Number(data ?? 0);
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
    // Clear old chunks too, in case a previously indexed file was replaced by an unsupported one.
    await replaceChunks(job, [], null, "skipped", [`Format not extracted: ${format}`]);
    counters.skipped += 1;
    console.log(`job ${job.id} ${label} -> skipped (${format})`);
    return;
  }

  const bytes = await readBytes(job);
  const extracted = await extractDocument(job.file_name, job.mime_type ?? "", bytes);
  if (!extracted.ok) throw new Error(extracted.error);

  const sections = [...extracted.document.sections];
  const warnings = [
    ...extracted.document.warnings,
    ...lowTextWarning(extracted.document.emptyUnits.length),
  ];

  // Pictures that carry content but no text: describe them only when a vision
  // model is configured, and mark the result as approximate.
  const images = extracted.document.images.slice(0, VISION_MAX_IMAGES);
  if (images.length > 0) {
    if (!visionEnabled) {
      warnings.push(
        `${images.length} slide(s) hold content only as a picture; set RAG_VISION=1 to describe them`,
      );
    } else {
      const media = readMediaFiles(
        bytes,
        images.map((image) => image.path),
      );
      let described = 0;
      for (const image of images) {
        const data = media.get(image.path);
        if (!data || data.byteLength === 0) continue;
        try {
          const description = await describeImage(data, image.mimeType, {
            ...embedConfig,
            model: visionModel,
          });
          sections.push({
            text: description,
            pageOrSlide: image.pageOrSlide,
            heading: image.altText,
            kind: "figure",
            metadata: {
              source: "vision",
              image: image.path,
              model: visionModel,
              approximate: true,
            },
          });
          described += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`vision failed on ${image.path}: ${message.slice(0, 120)}`);
        }
      }
      if (described > 0) {
        warnings.push(
          `${described} picture(s) described by ${visionModel}; their numbers are approximate`,
        );
      }
    }
  }

  // Provenance is written into every chunk (and therefore into the full-text
  // index) so a passage can be found by customer, industry or document name
  // even when its body never repeats them.
  const client = await getClient();
  const metadata = await client
    .from("content_items")
    .select("title, customer_name, industry")
    .eq("id", job.content_id)
    .maybeSingle();
  const context = {
    title: metadata.data?.title ?? job.file_name.replace(/\.[^.]+$/, ""),
    customerName: metadata.data?.customer_name ?? null,
    industry: metadata.data?.industry ?? null,
  };

  const rows = buildChunkRows(extracted.document.format, sections, job.file_name, context);

  if (rows.length === 0) {
    await replaceChunks(job, [], null, "empty", warnings);
    counters.empty += 1;
    console.log(`job ${job.id} ${label} -> empty (no extractable text)`);
    return;
  }

  const contentHash = hashIngest(rows);
  if (contentHash === job.content_hash && job.chunk_count > 0) {
    // Text unchanged (a move, or a re-run): keep the existing vectors.
    await finish(job, {
      chunkCount: job.chunk_count,
      contentHash,
      warnings: [...warnings, "Text unchanged; embeddings reused"],
    });
    counters.ready += 1;
    console.log(`job ${job.id} ${label} -> ready (unchanged, ${job.chunk_count} chunks kept)`);
    return;
  }

  const embedded = await embedTexts(embeddingTexts(rows, job.file_name), embedConfig);
  const payload: EmbeddedChunk[] = rows.map((row, index) => ({
    ...row,
    embedding: embedded.embeddings[index],
  }));

  const replacedCount = await replaceChunks(job, payload, contentHash, "ready", warnings);

  counters.ready += 1;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const cost =
    embedded.costUsd === null
      ? "n/a"
      : `${embedded.costEstimated ? "~$" : "$"}${embedded.costUsd.toFixed(6)}`;
  console.log(
    `job ${job.id} ${label} -> ready (${replacedCount} chunks, ${embedded.promptTokens ?? "?"} tokens, ${cost}, ${seconds}s)`,
  );
}

async function run() {
  const counters: Counters = { claimed: 0, ready: 0, empty: 0, skipped: 0, failed: 0 };

  await checkWorkerAccess();

  // A worker that died mid-job stops heartbeating; its job is requeued after
  // five minutes, while a slow but live worker keeps its own job.
  const reclaimed = await reclaimStale();
  if (reclaimed > 0) console.log(`reclaimed ${reclaimed} stale job(s)`);

  if (backfill) {
    const queued = await backfillJobs();
    console.log(`backfilled ${queued} item(s) with no ingestion job`);
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
      // Land just past the deadline; the claim function re-checks it in the database.
      await sleep(Math.max(dueInMs, 250) + DUE_MARGIN_MS);
      continue;
    }

    counters.claimed += 1;
    const stopHeartbeat = startHeartbeat(job);
    try {
      await processJob(job, counters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const status = await fail(job, message);
        if (status === "failed") counters.failed += 1;
        console.error(`job ${job.id} ${job.file_name} -> ${status}: ${message}`);
      } catch (failError) {
        // The job stays running and is reclaimed once its heartbeat goes stale;
        // keep the loop alive.
        console.error(
          `job ${job.id} ${job.file_name} -> could not record failure: ${
            failError instanceof Error ? failError.message : String(failError)
          } (original: ${message})`,
        );
      }
    } finally {
      stopHeartbeat();
    }

    if (counters.claimed >= limit) break;
  }

  console.log(
    `\nclaimed ${counters.claimed}, ready ${counters.ready}, empty ${counters.empty}, ` +
      `skipped ${counters.skipped}, failed ${counters.failed}`,
  );
  if (counters.claimed === 0) console.log("Queue is empty.");
}

/**
 * Runs several workers in parallel, one process each.
 *
 * No extra locking is needed: worker_claim_job() (0017) claims with
 * `for update skip locked`, so two workers cannot take the same content, and
 * document_chunks are replaced through a per-job staging table keyed by job id.
 *
 * The parent checks the queue before spawning, so an idle cron tick costs one
 * sign-in rather than one per worker.
 */
async function runWorkers() {
  // Fail on bad credentials or a missing allowlist once, with one clear error.
  await checkWorkerAccess();

  if (backfill) {
    const queued = await backfillJobs();
    console.log(`backfilled ${queued} item(s) with no ingestion job`);
  }

  if (!watch) {
    const dueInMs = await nextDueInMs();
    if (dueInMs === null) {
      console.log("Queue is empty.");
      return;
    }
    if (dueInMs > MAX_WAIT_MS) {
      console.log(`next job due in ${Math.ceil(dueInMs / 1000)}s; a later run will pick it up`);
      return;
    }
  }

  // Everything except --workers and --backfill: the parent already backfilled.
  const childArgs: string[] = [];
  const rawArgs = process.argv.slice(2);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--workers") {
      index += 1;
      continue;
    }
    if (arg === "--backfill") continue;
    childArgs.push(arg);
  }

  console.log(`starting ${workerCount} workers`);
  // fileURLToPath rather than argv[1]: the script path is absolute and correct
  // whether it was run as `bun scripts/...`, `bun run ingest`, or from cron.
  const scriptPath = fileURLToPath(import.meta.url);
  const children = Array.from({ length: workerCount }, () =>
    spawn(process.execPath, [scriptPath, ...childArgs], {
      stdio: "inherit",
      env: { ...process.env, INGEST_WORKER_CHILD: "1" },
    }),
  );
  const codes = await Promise.all(
    children.map(
      (child) =>
        new Promise<number>((resolve) => {
          child.on("exit", (code) => resolve(code ?? 1));
        }),
    ),
  );

  const failed = codes.filter((code) => code !== 0).length;
  if (failed > 0) {
    console.error(`${failed} of ${workerCount} workers exited with an error`);
    process.exitCode = 1;
  }
}

try {
  if (workerCount > 1) await runWorkers();
  else await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
