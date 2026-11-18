/**
 * The retrieval seam. Everything that needs library passages (chat, document
 * generation, the debug search) comes through this module, so ranking,
 * relevance filtering, entity scoping and citation metadata cannot drift
 * between features.
 *
 * The database function is security-invoker: the caller's JWT and RLS decide
 * which chunks exist at all. This module never falls back to the service role.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { isTitleOnlyChunk } from "./chunk-quality";
import { normalizeEntityKey } from "./entities";
import {
  DEFAULT_MATCH_COUNT,
  EMBEDDING_DIMENSIONS,
  ENTITY_MAX_ENTITIES,
  ENTITY_MIN_CHUNKS,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CHUNKS_PER_SLIDE,
  MAX_MATCH_COUNT,
  METADATA_FALLBACK_CHUNKS,
  RELEVANCE_SCORE_RATIO,
  RETRIEVAL_MAX_K,
  RETRIEVAL_MIN_K,
} from "./config";

export type RetrievalScope = {
  industry?: string | null | undefined;
  customer?: string | null | undefined;
};

/** A resolved organisation and every spelling retrieval may filter by. */
export type EntityScope = {
  canonical: string;
  matchedName?: string | null | undefined;
  spellings?: readonly string[] | null | undefined;
};

export type RetrievedChunk = {
  chunkId: string;
  contentId: string;
  content: string;
  page: number | null;
  slide: number | null;
  heading: string | null;
  title: string;
  fileName: string;
  filePath: string;
  industry: string;
  customerName: string | null;
  vectorRank: number | null;
  textRank: number | null;
  score: number;
};

type NormalizedScope = { industry: string | null; customer: string | null };

type SearchInput = {
  embedding: readonly number[];
  queryText: string;
  scope: NormalizedScope;
  matchCount: number;
};

type SearchRow = Database["public"]["Functions"]["search_chunks"]["Returns"][number];

/** Blank scope values mean "no filter", never an empty-looking customer. */
function normalizeScope(scope: RetrievalScope = {}): NormalizedScope {
  const clean = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return { industry: clean(scope.industry), customer: clean(scope.customer) };
}

export function clampMatchCount(count?: number): number {
  if (count === undefined || !Number.isFinite(count)) return DEFAULT_MATCH_COUNT;
  return Math.min(Math.max(Math.trunc(count), 1), MAX_MATCH_COUNT);
}

/** PostgREST passes a `vector` argument as its text form: [0.1,0.2,...]. */
export function formatVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Query embedding has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Query embedding contains a non-finite value");
  }
  return `[${vector.join(",")}]`;
}

export function mapSearchRows(rows: readonly SearchRow[]): RetrievedChunk[] {
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    contentId: row.content_id,
    content: row.content,
    page: row.page,
    slide: row.slide,
    heading: row.heading,
    title: row.title,
    fileName: row.file_name,
    filePath: row.file_path,
    industry: row.industry,
    customerName: row.customer_name,
    vectorRank: row.vector_rank,
    textRank: row.text_rank,
    score: row.score,
  }));
}

/** Canonical name first, then aliases, de-duplicated case-insensitively. */
function entitySpellings(entity: EntityScope): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  const candidates = [entity.canonical, ...(entity.spellings ?? []), entity.matchedName ?? ""];
  for (const value of candidates) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }
  return values;
}

/**
 * Relevance control over fused retrieval results. The database returns a fixed
 * top-N regardless of whether anything is relevant; this decides what is
 * actually evidence for this question.
 *
 * Order of business: drop other-customer noise when an entity was resolved,
 * apply a score floor relative to the best hit, push title-only slides out of
 * the top slots, and cap repeats from one deck or one slide. Bounds are kept so
 * a thin query returns few sources instead of padding to a fixed 8.
 */
export type SelectionOptions = {
  /**
   * Normalized spellings of the customer this question resolved to (canonical
   * plus aliases), so a chunk whose metadata carries an older spelling of the
   * same customer is not mistaken for another customer.
   */
  entityKeys?: readonly string[];
  /** Comparative questions must keep other customers' passages. */
  comparative?: boolean;
  minK?: number;
  maxK?: number;
  scoreRatio?: number;
};

/** One slide region can legitimately split into several chunks; two is enough. */
function slideKey(chunk: RetrievedChunk): string {
  const place = chunk.slide ?? chunk.page ?? "none";
  return `${chunk.contentId}:${place}`;
}

/**
 * True when the chunk's document belongs to a different customer than the one
 * the question resolved to. Industry-wide documents (no customer) always pass.
 */
function belongsToOtherCustomer(chunk: RetrievedChunk, entityKeys: ReadonlySet<string>): boolean {
  if (!chunk.customerName) return false;
  return !entityKeys.has(normalizeEntityKey(chunk.customerName));
}

export function selectRelevantChunks(
  chunks: readonly RetrievedChunk[],
  options: SelectionOptions = {},
): RetrievedChunk[] {
  const minK = Math.max(1, options.minK ?? RETRIEVAL_MIN_K);
  const maxK = Math.max(minK, options.maxK ?? RETRIEVAL_MAX_K);
  const scoreRatio = options.scoreRatio ?? RELEVANCE_SCORE_RATIO;

  // Dedupe by chunk id (overlapping scopes can return the same passage twice).
  const unique = new Map<string, RetrievedChunk>();
  for (const chunk of chunks) {
    const existing = unique.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) unique.set(chunk.chunkId, chunk);
  }
  const ranked = [...unique.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];

  const entityKeys = new Set(
    (options.entityKeys ?? []).map((key) => normalizeEntityKey(key)).filter(Boolean),
  );
  const scoped =
    entityKeys.size > 0 && !options.comparative
      ? ranked.filter((chunk) => !belongsToOtherCustomer(chunk, entityKeys))
      : ranked;
  const pool = scoped.length > 0 ? scoped : ranked;

  const bestScore = pool[0]?.score ?? 0;
  const floor = bestScore > 0 ? bestScore * scoreRatio : 0;
  const aboveFloor = pool.filter((chunk) => chunk.score >= floor);

  // Title-only slides are never evidence next to real content; they are only
  // useful as a label for a document that already earned a slot.
  const substantive = aboveFloor.filter((chunk) => !isTitleOnlyChunk(chunk));
  const titleOnly = aboveFloor.filter((chunk) => isTitleOnlyChunk(chunk));
  const matchedDocuments = new Set(substantive.map((chunk) => chunk.contentId));

  const selected: RetrievedChunk[] = [];
  const perDocument = new Map<string, number>();
  const perSlide = new Map<string, number>();
  const deferred: RetrievedChunk[] = [];

  const tryPush = (chunk: RetrievedChunk, countRepeats: boolean): boolean => {
    if (selected.length >= maxK) return false;
    const docs = perDocument.get(chunk.contentId) ?? 0;
    if (countRepeats && docs >= MAX_CHUNKS_PER_DOCUMENT) {
      deferred.push(chunk);
      return false;
    }
    const slide = slideKey(chunk);
    const slides = perSlide.get(slide) ?? 0;
    if (countRepeats && slides >= MAX_CHUNKS_PER_SLIDE) {
      deferred.push(chunk);
      return false;
    }
    selected.push(chunk);
    perDocument.set(chunk.contentId, docs + 1);
    perSlide.set(slide, slides + 1);
    return true;
  };

  for (const chunk of substantive) tryPush(chunk, true);

  // A thin result should still reach the minimum when the pool can support it.
  if (selected.length < minK) {
    for (const chunk of substantive) {
      if (selected.length >= minK) break;
      if (!selected.includes(chunk)) tryPush(chunk, false);
    }
  }
  if (selected.length < minK) {
    for (const chunk of deferred) {
      if (selected.length >= minK) break;
      if (!selected.includes(chunk) && !isTitleOnlyChunk(chunk)) tryPush(chunk, false);
    }
  }

  // One title-only passage, at the end, and only for a document already used.
  if (selected.length < maxK) {
    const anchor = titleOnly.find(
      (chunk) => selected.length === 0 || matchedDocuments.has(chunk.contentId),
    );
    if (anchor && !selected.includes(anchor)) selected.push(anchor);
  }

  return selected;
}

async function searchScopedChunks(
  client: SupabaseClient<Database>,
  input: SearchInput,
): Promise<RetrievedChunk[]> {
  const { data, error } = await client.rpc("search_chunks", {
    query_embedding: formatVectorLiteral(input.embedding),
    query_text: input.queryText,
    filter_industry: input.scope.industry,
    filter_customer: input.scope.customer,
    match_count: input.matchCount,
  });
  if (error) throw new Error(`Library search failed: ${error.message}`);
  return mapSearchRows((data ?? []) as SearchRow[]);
}

/**
 * Merges one general result set with one batch per entity. Each entity gets a
 * reserved share of the slots first, so a single large document family cannot
 * crowd the others out; the remaining slots go to the best scores overall.
 */
function mergeEntityResults(
  base: readonly RetrievedChunk[],
  entityBatches: readonly (readonly RetrievedChunk[])[],
  matchCount: number,
): RetrievedChunk[] {
  const byId = new Map<string, RetrievedChunk>();
  const add = (chunk: RetrievedChunk) => {
    const existing = byId.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) byId.set(chunk.chunkId, chunk);
  };

  const quota = Math.max(
    ENTITY_MIN_CHUNKS,
    Math.ceil(matchCount / Math.max(1, entityBatches.length)),
  );
  for (const batch of entityBatches) {
    [...batch]
      .sort((a, b) => b.score - a.score)
      .slice(0, quota)
      .forEach(add);
  }
  [...base].sort((a, b) => b.score - a.score).forEach(add);
  for (const batch of entityBatches) {
    [...batch].sort((a, b) => b.score - a.score).forEach(add);
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, matchCount);
}

/**
 * Hybrid search with one pass per named organisation, plus the caller's own
 * scopes. The question is embedded once; each entity filters on its own known
 * spelling, so "IndiGo" can reach a file whose customer_name says
 * "InterGlobe Aviation" once entity resolution has linked the two.
 */
async function searchBatch(options: {
  client: SupabaseClient<Database>;
  embedding: readonly number[];
  queryText: string;
  scopes: readonly RetrievalScope[];
  entities: readonly EntityScope[];
  matchCount: number;
}): Promise<RetrievedChunk[]> {
  const groups = new Map<string, NormalizedScope>();
  for (const scope of options.scopes.length > 0 ? options.scopes : [{}]) {
    const normalized = normalizeScope(scope);
    groups.set(`${normalized.industry ?? ""}\u0000${normalized.customer ?? ""}`, normalized);
  }

  const named = new Map<string, EntityScope>();
  for (const entity of options.entities) {
    const key = entity.canonical.trim().toLowerCase();
    if (key && !named.has(key)) named.set(key, entity);
  }

  const [base, entityBatches] = await Promise.all([
    Promise.all(
      [...groups.values()].map((scope) =>
        searchScopedChunks(options.client, {
          embedding: options.embedding,
          queryText: options.queryText,
          scope,
          matchCount: options.matchCount,
        }),
      ),
    ),
    Promise.all(
      [...named.values()].slice(0, ENTITY_MAX_ENTITIES).map(async (entity) => {
        const batches = await Promise.all(
          entitySpellings(entity)
            .slice(0, 3)
            .map((spelling) =>
              searchScopedChunks(options.client, {
                embedding: options.embedding,
                queryText: `${options.queryText}\nCustomer: ${entity.canonical}`,
                scope: { industry: null, customer: spelling },
                matchCount: options.matchCount,
              }),
            ),
        );
        return batches.flat();
      }),
    ),
  ]);

  return mergeEntityResults(base.flat(), entityBatches, options.matchCount);
}

/**
 * Single scoped retrieval. Returns ranked passages from files the caller is
 * allowed to read; an empty list means nothing matched (an empty query is not
 * an error, it just has no results).
 */
export async function searchLibraryChunks(
  client: SupabaseClient<Database>,
  query: string,
  scope: RetrievalScope,
  k: number,
  embed: (query: string) => Promise<number[]>,
): Promise<RetrievedChunk[]> {
  const queryText = query.trim();
  if (!queryText) return [];
  return searchScopedChunks(client, {
    embedding: await embed(queryText),
    queryText,
    scope: normalizeScope(scope),
    matchCount: clampMatchCount(k),
  });
}

/** Multi-entity, multi-scope retrieval over one embedded question. */
export async function searchLibraryChunksForEntities(
  client: SupabaseClient<Database>,
  query: string,
  entities: readonly EntityScope[],
  scopes: readonly RetrievalScope[],
  k: number,
  embed: (query: string) => Promise<number[]>,
): Promise<RetrievedChunk[]> {
  const queryText = query.trim();
  if (!queryText) return [];
  return searchBatch({
    client,
    embedding: await embed(queryText),
    queryText,
    scopes,
    entities,
    matchCount: clampMatchCount(k),
  });
}

/**
 * Last resort before saying "I couldn't find it": look up documents by customer,
 * title or file name and return their opening passages. This is metadata, not a
 * semantic guess, so a named organisation that exists in the library can never
 * be reported as absent.
 */
export async function metadataFallbackChunks(
  client: SupabaseClient<Database>,
  names: readonly string[],
  limit: number = METADATA_FALLBACK_CHUNKS,
): Promise<RetrievedChunk[]> {
  const contentIds = new Set<string>();
  const seen = new Set<string>();

  // PostgREST's `or` filter is a small expression language: strip its control
  // characters so a document name can never inject another condition.
  const safe = (value: string) =>
    value
      .replace(/[%,()*]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  for (const name of names) {
    const term = safe(name);
    const key = term.toLowerCase();
    if (term.length < 3 || seen.has(key)) continue;
    seen.add(key);
    const { data, error } = await client
      .from("content_items")
      .select("id")
      .or(`customer_name.ilike.%${term}%,title.ilike.%${term}%,file_name.ilike.%${term}%`)
      .limit(6);
    if (error || !data) continue;
    for (const row of data as { id: string }[]) contentIds.add(row.id);
  }

  if (contentIds.size === 0) return [];

  type FallbackRow = {
    id: string;
    content_id: string;
    content: string;
    page: number | null;
    slide: number | null;
    heading: string | null;
    content_items: {
      title: string | null;
      file_name: string | null;
      file_path: string | null;
      industry: string | null;
      customer_name: string | null;
    } | null;
  };

  const { data, error } = await client
    .from("document_chunks")
    .select(
      "id, content_id, content, page, slide, heading, content_items(title, file_name, file_path, industry, customer_name)",
    )
    .in("content_id", [...contentIds].slice(0, 8))
    .order("chunk_index", { ascending: true })
    .limit(Math.max(limit * 4, 24));
  if (error || !data) return [];

  const perDocument = new Map<string, number>();
  const chunks: RetrievedChunk[] = [];
  for (const row of data as unknown as FallbackRow[]) {
    const item = row.content_items;
    if (!item || row.content.trim().length < 40) continue;
    const count = perDocument.get(row.content_id) ?? 0;
    if (count >= 2) continue;
    perDocument.set(row.content_id, count + 1);
    chunks.push({
      chunkId: row.id,
      contentId: row.content_id,
      content: row.content,
      page: row.page,
      slide: row.slide,
      heading: row.heading,
      title: item.title ?? row.heading ?? "Library document",
      fileName: item.file_name ?? "",
      filePath: item.file_path ?? "",
      industry: item.industry ?? "",
      customerName: item.customer_name,
      vectorRank: null,
      textRank: null,
      // Deliberately below any fused score: metadata proves the document
      // exists, not that this passage answers the question.
      score: 0.001,
    });
    if (chunks.length >= limit) break;
  }
  return chunks;
}

export type LibraryEvidence = {
  chunks: RetrievedChunk[];
  /** Raw hybrid candidates considered before relevance filtering. */
  candidates: number;
  /** The search that produced the evidence; "metadata" means ranking found none. */
  source: "scoped" | "unscoped" | "metadata";
};

export type EvidenceRequest = {
  client: SupabaseClient<Database>;
  query: string;
  /** Organisations this turn resolved; each gets its own scoped search. */
  entities?: readonly EntityScope[] | undefined;
  /** SQL filters for the selected conversation scope; one search each. */
  scopes?: readonly RetrievalScope[] | undefined;
  comparative?: boolean | undefined;
  /**
   * Search the whole library once when the scoped passes return no evidence.
   * The scope is a default, never a reason to refuse a question.
   */
  fallbackToLibrary?: boolean | undefined;
  k?: number | undefined;
  embed: (query: string) => Promise<number[]>;
};

/**
 * The whole read path in one call: search the caller's scopes plus every named
 * organisation, keep only what is evidence, then fall back to the unscoped
 * library and finally to metadata before reporting nothing found. The question
 * is embedded once and reused by every search.
 */
export async function gatherLibraryEvidence(request: EvidenceRequest): Promise<LibraryEvidence> {
  const queryText = request.query.trim();
  const entities = request.entities ?? [];
  if (!queryText) return { chunks: [], candidates: 0, source: "scoped" };

  const matchCount = clampMatchCount(request.k);
  const embedding = await request.embed(queryText);
  const entityKeys = [
    ...new Set(entities.flatMap(entitySpellings).map(normalizeEntityKey).filter(Boolean)),
  ];
  const pick = (candidates: readonly RetrievedChunk[]) =>
    selectRelevantChunks(candidates, {
      entityKeys,
      comparative: request.comparative ?? false,
    });

  const run = (scopes: readonly RetrievalScope[]) =>
    searchBatch({
      client: request.client,
      embedding,
      queryText,
      scopes,
      entities,
      matchCount,
    });

  let candidates = await run(request.scopes ?? []);
  let chunks = pick(candidates);
  let source: LibraryEvidence["source"] = "scoped";

  if (chunks.length === 0 && request.fallbackToLibrary) {
    candidates = await run([{}]);
    chunks = pick(candidates);
    source = "unscoped";
  }

  if (chunks.length === 0 && entities.length > 0) {
    chunks = await metadataFallbackChunks(
      request.client,
      entities.flatMap((entity) =>
        entity.matchedName ? [entity.canonical, entity.matchedName] : [entity.canonical],
      ),
      RETRIEVAL_MAX_K,
    );
    if (chunks.length > 0) source = "metadata";
  }

  return { chunks, candidates: candidates.length, source };
}
