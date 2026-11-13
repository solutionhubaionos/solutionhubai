/**
 * Retrieval seam. Everything that needs library passages (chat now, deck
 * generation later) goes through retrieve(query, scope, k, deps), so ranking,
 * filtering and citation metadata stay in one place.
 *
 * The database function is security-invoker: the caller's JWT and RLS decide
 * which chunks exist at all. This module never falls back to the service role.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import {
  DEFAULT_MATCH_COUNT,
  EMBEDDING_DIMENSIONS,
  ENTITY_MAX_ENTITIES,
  ENTITY_MIN_CHUNKS,
  MAX_MATCH_COUNT,
  METADATA_FALLBACK_CHUNKS,
} from "./config";

export type RetrievalScope = {
  industry?: string | null | undefined;
  customer?: string | null | undefined;
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

export type NormalizedScope = {
  industry: string | null;
  customer: string | null;
};

export type SearchInput = {
  embedding: readonly number[];
  queryText: string;
  scope: NormalizedScope;
  matchCount: number;
};

export type RetrieveDeps = {
  embedQuery: (query: string) => Promise<number[]>;
  search: (input: SearchInput) => Promise<RetrievedChunk[]>;
};

type SearchRow = Database["public"]["Functions"]["search_chunks"]["Returns"][number];

/** Blank scope values mean "no filter", never an empty-looking customer. */
export function normalizeScope(scope: RetrievalScope = {}): NormalizedScope {
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

/**
 * Single retrieval entry point. Returns ranked passages from files the caller is
 * allowed to read; an empty list means nothing matched (an empty query is not an
 * error, it just has no results).
 */
export async function retrieve(
  query: string,
  scope: RetrievalScope = {},
  k: number = DEFAULT_MATCH_COUNT,
  deps: RetrieveDeps,
): Promise<RetrievedChunk[]> {
  const queryText = query.trim();
  if (!queryText) return [];

  const matchCount = clampMatchCount(k);
  const embedding = await deps.embedQuery(queryText);
  return deps.search({ embedding, queryText, scope: normalizeScope(scope), matchCount });
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

/** Wires retrieve() to an authenticated Supabase client and the gateway embedder. */
export async function searchLibraryChunks(
  client: SupabaseClient<Database>,
  query: string,
  scope: RetrievalScope,
  k: number,
  embed: (query: string) => Promise<number[]>,
): Promise<RetrievedChunk[]> {
  return retrieve(query, scope, k, {
    embedQuery: embed,
    search: (input) => searchScopedChunks(client, input),
  });
}

/** A resolved organisation and every spelling retrieval may filter by. */
export type EntityScope = { canonical: string; spellings?: readonly string[] | undefined };

/** Canonical name first, then aliases, de-duplicated case-insensitively. */
export function entitySpellings(entity: EntityScope): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of [entity.canonical, ...(entity.spellings ?? [])]) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }
  return values;
}

/**
 * Merges one general result set with one batch per entity. Each entity gets a
 * reserved share of the slots first, so a single large document family cannot
 * crowd the others out; the remaining slots go to the best scores overall.
 */
export function mergeEntityResults(
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

  const matchCount = clampMatchCount(k);
  const unique = new Map<string, EntityScope>();
  for (const entity of entities) {
    const key = entity.canonical.trim().toLowerCase();
    if (key && !unique.has(key)) unique.set(key, entity);
  }
  const named = [...unique.values()].slice(0, ENTITY_MAX_ENTITIES);

  const baseScopes = new Map<string, NormalizedScope>();
  for (const scope of scopes.length > 0 ? scopes : [{}]) {
    const normalized = normalizeScope(scope);
    baseScopes.set(`${normalized.industry ?? ""}\u0000${normalized.customer ?? ""}`, normalized);
  }

  const embedding = await embed(queryText);
  const [base, entityBatches] = await Promise.all([
    Promise.all(
      [...baseScopes.values()].map((scope) =>
        searchScopedChunks(client, { embedding, queryText, scope, matchCount }),
      ),
    ),
    Promise.all(
      named.map(async (entity) => {
        const spellings = entitySpellings(entity).slice(0, 3);
        const batches = await Promise.all(
          spellings.map((spelling) =>
            searchScopedChunks(client, {
              embedding,
              queryText: `${queryText}\nCustomer: ${entity.canonical}`,
              scope: { industry: null, customer: spelling },
              matchCount,
            }),
          ),
        );
        return batches.flat();
      }),
    ),
  ]);

  return mergeEntityResults(base.flat(), entityBatches, matchCount);
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
    try {
      const { data, error } = await client
        .from("content_items")
        .select("id")
        .or(`customer_name.ilike.%${term}%,title.ilike.%${term}%,file_name.ilike.%${term}%`)
        .limit(6);
      if (error || !data) continue;
      for (const row of data as { id: string }[]) contentIds.add(row.id);
    } catch {
      // Metadata lookup is best-effort; retrieval still has the hybrid results.
    }
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

  try {
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
  } catch {
    return [];
  }
}

/**
 * Runs the hybrid search once per selected scope and merges the hits. The
 * question is embedded once, each scope is filtered by the database under the
 * caller's JWT, and a passage found in overlapping scopes keeps its best score.
 */
export async function searchLibraryChunksAcrossScopes(
  client: SupabaseClient<Database>,
  query: string,
  scopes: readonly RetrievalScope[],
  k: number,
  embed: (query: string) => Promise<number[]>,
): Promise<RetrievedChunk[]> {
  const queryText = query.trim();
  if (!queryText) return [];

  const matchCount = clampMatchCount(k);
  const unique = new Map<string, NormalizedScope>();
  for (const scope of scopes.length > 0 ? scopes : [{}]) {
    const normalized = normalizeScope(scope);
    unique.set(`${normalized.industry ?? ""}\u0000${normalized.customer ?? ""}`, normalized);
  }

  const embedding = await embed(queryText);
  const batches = await Promise.all(
    [...unique.values()].map((scope) =>
      searchScopedChunks(client, { embedding, queryText, scope, matchCount }),
    ),
  );

  const best = new Map<string, RetrievedChunk>();
  for (const chunk of batches.flat()) {
    const existing = best.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) best.set(chunk.chunkId, chunk);
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, matchCount);
}
