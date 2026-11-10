/**
 * RAG provider settings. Shared by the ingestion worker, query embedding and
 * retrieval. EMBEDDING_DIMENSIONS must match document_chunks.embedding
 * (vector(1536)) in drizzle/migrations/0010_rag.sql; changing one without the
 * other silently breaks retrieval, so change them together.
 */
export const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_DIMENSIONS = 1536;

/** Provider limit is 100 input texts per embeddings call. */
export const EMBEDDING_BATCH_SIZE = 100;

/**
 * Provider price per embedding token, derived from reported usage
 * (859 tokens cost $0.0000859). Only used when a batched response omits cost,
 * which this provider does above a few inputs.
 */
export const EMBEDDING_USD_PER_TOKEN = 1e-7;

/**
 * Pipeline versions. Either one changes the content hash, so bumping it makes
 * every file look new, and `worker_requeue_all('<version>')`
 * (drizzle/migrations/0019) queues the whole library for re-ingestion.
 * EXTRACTOR_VERSION must match the string passed to that function.
 */
export const EXTRACTOR_VERSION = "2026-11-10.1";
export const CHUNKER_VERSION = "2026-11-10.1";

/** Stub chunks below this size are merged into their predecessor, not embedded. */
export const MIN_CHUNK_CHARS = 40;

/**
 * Retrieval defaults. public.search_chunks (drizzle/migrations/0014) merges a
 * pgvector top-50 with a full-text top-50 using reciprocal rank fusion k=60, so
 * retrieve() only has to ask for the final result count.
 */
export const DEFAULT_MATCH_COUNT = 8;
export const MAX_MATCH_COUNT = 50;

/**
 * Qwen3-Embedding expects an instruction on the query side only. Documents
 * stay un-prefixed. Kept here so retrieval and the eval can A/B it with one
 * switch; production turns it on in Phase 2.
 */
export const QUERY_INSTRUCT_PREFIX =
  "Instruct: Given a question from a sales team, retrieve slides and passages from AIonOS case studies, proposals and decks that answer it\nQuery: ";

/**
 * Chat answer generation. Same gateway and key as embeddings, a text model
 * instead; kept here so the model can be switched in one place.
 */
export const ANSWER_MODEL = "deepseek/deepseek-v4.1-flash";
export const ANSWER_MAX_TOKENS = 700;

/**
 * Chat context and prompt budget. One place for the knobs the answer quality
 * depends on, so they can be tuned without touching retrieval or citation code.
 */

/** Characters of a chunk sent to the model; the full chunk stays for the UI. */
export const MAX_CONTEXT_CHARS = 1400;

/** Turns of conversation history sent with the answer request. */
export const MAX_HISTORY_MESSAGES = 6;

/** At or below this many meaningful tokens a chunk is treated as a title slide. */
export const TITLE_ONLY_MAX_TOKENS = 25;
