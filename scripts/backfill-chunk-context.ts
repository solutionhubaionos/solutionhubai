/**
 * Backfills contextual chunk headers for an already-ingested library.
 *
 * New ingests store "Customer: X | Industry: Y | Document: Z | Slide: N" at the
 * top of document_chunks.content, which the generated tsv also indexes. This
 * script adds the header only to chunks that do not have one, re-embeds just
 * those chunks, and writes them back through worker_update_chunk_context()
 * (migration 0021). It is resumable: stop it at any point and run it again; the
 * next pass skips everything already prefixed.
 *
 * Usage:
 *   bun scripts/backfill-chunk-context.ts --dry-run
 *   bun scripts/backfill-chunk-context.ts --batch 50 --limit 500
 *   bun scripts/backfill-chunk-context.ts --sleep 200
 *
 * Auth is the same as the ingest worker: SUPABASE_SERVICE_ROLE_KEY, or
 * SUPABASE_PUBLISHABLE_KEY + LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD for an
 * account listed in public.ingestion_worker_users. Logs carry counts only, never
 * document text or credentials.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/integrations/supabase/types";
import { chunkContextHeader, embedTexts } from "../src/lib/rag/ingest";
import { EMBEDDING_MODEL } from "../src/lib/rag/config";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = flag("--dry-run");
const batchSize = Math.min(Math.max(Number(value("--batch") ?? 50) || 50, 1), 200);
const limit = Number(value("--limit") ?? 0) || Number.POSITIVE_INFINITY;
const sleepMs = Math.max(Number(value("--sleep") ?? 0) || 0, 0);

const url = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const publishable = process.env["SUPABASE_PUBLISHABLE_KEY"];
const email = process.env["LIBRARY_USER_EMAIL"];
const password = process.env["LIBRARY_USER_PASSWORD"];

if (!url || (!serviceKey && (!publishable || !email || !password))) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_PUBLISHABLE_KEY + LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD",
  );
  process.exit(1);
}

const client = createClient<Database>(url, serviceKey ?? publishable!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (!serviceKey) {
  const { error } = await client.auth.signInWithPassword({ email: email!, password: password! });
  if (error) {
    console.error(`Could not sign in as the library worker account: ${error.message}`);
    process.exit(1);
  }
}

type ChunkToBackfill = {
  id: string;
  content: string;
  page: number | null;
  slide: number | null;
  content_items: {
    title: string | null;
    customer_name: string | null;
    industry: string | null;
  } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let updated = 0;
let scanned = 0;

for (;;) {
  if (scanned >= limit) break;

  const { data, error } = await client
    .from("document_chunks")
    .select("id, content, page, slide, content_items(title, customer_name, industry)")
    .not("content", "like", "Document:%")
    .order("content_id", { ascending: true })
    .order("chunk_index", { ascending: true })
    .limit(batchSize);

  if (error) {
    console.error(`Could not read chunks: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as unknown as ChunkToBackfill[];
  if (rows.length === 0) break;

  scanned += rows.length;

  const payload = rows.flatMap((row) => {
    const item = row.content_items;
    if (!item) return [];
    const header = chunkContextHeader(
      { page: row.page, slide: row.slide },
      {
        title: item.title,
        customerName: item.customer_name,
        industry: item.industry,
      },
    );
    if (!header) return [];
    return [{ id: row.id, content: `${header}\n\n${row.content}` }];
  });

  if (payload.length === 0) {
    if (rows.length < batchSize) break;
    continue;
  }

  if (dryRun) {
    console.log(`would backfill ${payload.length} of ${rows.length} chunk(s) (dry run)`);
    if (rows.length < batchSize) break;
    continue;
  }

  const { embeddings, costUsd } = await embedTexts(
    payload.map((row) => row.content),
    {
      apiKey: process.env["TOKENFACTORY_API_KEY"] ?? "",
      baseUrl: process.env["TOKENFACTORY_API_BASE"] ?? "",
    },
  );

  // The RPC is added by migration 0021, after the generated Database types.
  const writeBackfill = client.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: number | null; error: { message: string } | null }>;
  const { data: written, error: writeError } = await writeBackfill("worker_update_chunk_context", {
    p_rows: payload.map((row, index) => ({
      id: row.id,
      content: row.content,
      embedding: embeddings[index],
      embedding_model: EMBEDDING_MODEL,
    })),
  });

  if (writeError) {
    console.error(`Could not write backfill batch: ${writeError.message}`);
    process.exit(1);
  }

  updated += Number(written ?? 0);
  console.log(
    `backfilled ${payload.length} chunk(s); ${updated} written so far (${costUsd === null ? "cost n/a" : `~$${costUsd.toFixed(6)}`})`,
  );

  if (rows.length < batchSize) break;
  if (sleepMs > 0) await sleep(sleepMs);
}

console.log(
  dryRun
    ? `dry run complete: scanned ${scanned} chunk(s)`
    : `done: scanned ${scanned}, updated ${updated} chunk(s)`,
);
