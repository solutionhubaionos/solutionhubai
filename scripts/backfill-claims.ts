/**
 * Resumable backfill for the structured facts added in migration 0023.
 *
 * Reads existing chunks and writes entity links plus claims through
 * worker_attach_chunk_facts. It never re-extracts a file, never changes chunk
 * text or embeddings, and re-running is safe: the RPC replaces one document's
 * claim/link rows in a single statement.
 *
 * Usage:
 *   bun scripts/backfill-claims.ts                 # every document
 *   bun scripts/backfill-claims.ts --limit 25      # first 25 documents
 *   bun scripts/backfill-claims.ts --resume <id>   # continue after a document id
 *   bun scripts/backfill-claims.ts --content <id>  # one document
 *
 * Never print document text or credentials: logs carry counts only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractChunkFacts, type FactEntityType, type KnownEntity } from "../src/lib/rag/facts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const limitArg = Number(value("--limit") ?? 0) || Number.POSITIVE_INFINITY;
const resume = value("--resume");
const onlyContent = value("--content");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const email = process.env.LIBRARY_USER_EMAIL;
const password = process.env.LIBRARY_USER_PASSWORD;

if (!url) {
  console.error("SUPABASE_URL is missing from .env");
  process.exit(1);
}
if (!serviceKey && (!publishable || !email || !password)) {
  console.error(
    "Set SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_PUBLISHABLE_KEY + LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD",
  );
  process.exit(1);
}

async function getClient(): Promise<SupabaseClient> {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  if (serviceKey) return createClient(url!, serviceKey, options);
  const client = createClient(url!, publishable!, options);
  const { error } = await client.auth.signInWithPassword({ email: email!, password: password! });
  if (error) throw new Error(`Member sign-in failed: ${error.message}`);
  return client;
}

async function knownEntities(client: SupabaseClient): Promise<KnownEntity[]> {
  const { data, error } = await client.from("entities").select("name, entity_type").limit(2_000);
  if (error) {
    throw new Error(`Could not read entities (apply 0023 first): ${error.message}`);
  }
  return (data ?? []).flatMap((row) => {
    const type = (row as { entity_type: string }).entity_type;
    if (type !== "company" && type !== "airport" && type !== "concept") return [];
    return [{ name: (row as { name: string }).name, type: type as FactEntityType }];
  });
}

type Doc = { id: string; title: string; customer_name: string | null };

async function backfillDoc(
  client: SupabaseClient,
  doc: Doc,
  known: readonly KnownEntity[],
): Promise<{ chunks: number; claims: number }> {
  const { data, error } = await client
    .from("document_chunks")
    .select("chunk_index, content")
    .eq("content_id", doc.id)
    .order("chunk_index", { ascending: true });
  if (error) throw new Error(`chunks for ${doc.id}: ${error.message}`);
  const chunks = (data ?? []) as { chunk_index: number; content: string }[];
  if (chunks.length === 0) return { chunks: 0, claims: 0 };

  const facts = chunks.map((chunk) =>
    extractChunkFacts({
      chunkIndex: chunk.chunk_index,
      text: chunk.content,
      knownEntities: known,
      sourceTitle: doc.title,
      customerName: doc.customer_name,
    }),
  );
  const { data: result, error: attachError } = await client.rpc("worker_attach_chunk_facts", {
    p_content_id: doc.id,
    p_facts: facts,
  });
  if (attachError) throw new Error(`attach facts for ${doc.id}: ${attachError.message}`);
  const claims =
    result && typeof result === "object" && "claims" in result
      ? Number((result as { claims: unknown }).claims ?? 0)
      : 0;
  return { chunks: chunks.length, claims };
}

async function main() {
  const client = await getClient();
  const { data: worker, error: workerError } = await client.rpc("is_ingestion_worker");
  if (workerError) {
    throw new Error(
      workerError.code === "PGRST202"
        ? "Apply migration 0023 before backfilling facts"
        : `Worker access check failed: ${workerError.message}`,
    );
  }
  if (!worker) throw new Error("This account is not an ingestion worker");

  if (onlyContent) {
    const { data: doc, error } = await client
      .from("content_items")
      .select("id, title, customer_name")
      .eq("id", onlyContent)
      .maybeSingle();
    if (error || !doc) throw new Error(error?.message ?? "Document not found");
    const known = await knownEntities(client);
    const result = await backfillDoc(client, doc as Doc, known);
    console.log(`${onlyContent}: ${result.chunks} chunks, ${result.claims} claims`);
    return;
  }

  const known = await knownEntities(client);
  let processed = 0;
  let totalChunks = 0;
  let totalClaims = 0;
  let cursor: string | null = resume ?? null;

  while (processed < limitArg) {
    let query = client
      .from("content_items")
      .select("id, title, customer_name")
      .order("id", { ascending: true })
      .limit(Math.min(50, limitArg - processed));
    if (cursor) query = query.gt("id", cursor);
    const { data: docs, error } = await query;
    if (error) throw new Error(`content list: ${error.message}`);
    if (!docs || docs.length === 0) break;

    for (const doc of docs as Doc[]) {
      const result = await backfillDoc(client, doc, known);
      totalChunks += result.chunks;
      totalClaims += result.claims;
      processed += 1;
      cursor = doc.id;
      if (processed >= limitArg) break;
      if (processed % 10 === 0) {
        console.log(
          `backfilled ${processed} documents, ${totalChunks} chunks, ${totalClaims} claims`,
        );
      }
    }
    if (docs.length < 50) break;
  }

  console.log(
    `done: ${processed} documents, ${totalChunks} chunks, ${totalClaims} claims${cursor ? ` (resume after ${cursor})` : ""}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
