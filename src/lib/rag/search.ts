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
import { DEFAULT_MATCH_COUNT, EMBEDDING_DIMENSIONS, MAX_MATCH_COUNT } from "./config";

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
