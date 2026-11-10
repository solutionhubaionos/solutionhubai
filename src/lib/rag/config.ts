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
/** Long enough for a full answer over several sources; 700 cut answers mid-sentence. */
export const ANSWER_MAX_TOKENS = 2_400;
/** Wall-clock cap on one answer completion. */
export const ANSWER_TIMEOUT_MS = 90_000;
/** One continuation is enough for a normal answer; more hides a runaway model. */
export const ANSWER_MAX_CONTINUATIONS = 1;

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

/**
 * Relevance control after RRF. The database returns a fixed candidate set; chat
 * keeps only what clears the score floor and never pads to a fixed 8.
 */

/** Candidates fetched before filtering (the SQL function caps at 50). */
export const RETRIEVAL_CANDIDATES = 24;
/** Chunks kept when enough relevant passages exist. */
export const RETRIEVAL_MIN_K = 3;
export const RETRIEVAL_MAX_K = 8;
/** A chunk must score at least this share of the best fused score. */
export const RELEVANCE_SCORE_RATIO = 0.5;
/** One deck, or one slide split into chunks, may not crowd out the rest. */
export const MAX_CHUNKS_PER_DOCUMENT = 3;
export const MAX_CHUNKS_PER_SLIDE = 2;

/**
 * Follow-up rewriting. A small completion turns "and for Zurich?" into a
 * standalone query; any failure falls back to the raw message.
 */
export const QUERY_REWRITE_MODEL = "deepseek/deepseek-v4.1-flash";
export const QUERY_REWRITE_MAX_TOKENS = 80;
export const QUERY_REWRITE_TIMEOUT_MS = 2_500;
export const QUERY_REWRITE_HISTORY_MESSAGES = 4;

/**
 * Customer entity matching via pg_trgm. similarity() >= threshold is a soft
 * boost; at or above the filter threshold the customer is used as a scope.
 */
export const ENTITY_SIMILARITY_THRESHOLD = 0.4;
export const ENTITY_FILTER_THRESHOLD = 0.86;
export const ENTITY_MAX_CANDIDATES = 40;
