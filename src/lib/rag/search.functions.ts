/**
 * Authenticated library search. Retrieval runs with the caller's JWT through
 * requireSupabaseAuth, so RLS decides which files are visible; the service role
 * is never used here. Only the query embedding leaves the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_MATCH_COUNT } from "./config";
import { embedQuery } from "./embeddings";
import { searchLibraryChunks, type RetrievedChunk } from "./search";

export type SearchLibraryResult =
  { ok: true; chunks: RetrievedChunk[] } | { ok: false; error: string };

function createQueryEmbedder():
  { ok: true; embed: (query: string) => Promise<number[]> } | { ok: false; error: string } {
  const apiKey = process.env["TOKENFACTORY_API_KEY"];
  const baseUrl = process.env["TOKENFACTORY_API_BASE"];
  if (!apiKey || !baseUrl) {
    console.error("[RAG] Embedding provider credentials are not configured");
    return { ok: false, error: "Library search is not configured yet." };
  }
  return { ok: true, embed: (query: string) => embedQuery(query, { apiKey, baseUrl }) };
}

export const searchLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        query: z.string().trim().min(2).max(500),
        industry: z.string().trim().max(64).optional(),
        customer: z.string().trim().max(120).optional(),
        matchCount: z.number().int().min(1).max(50).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<SearchLibraryResult> => {
    const embedder = createQueryEmbedder();
    if (!embedder.ok) return { ok: false, error: embedder.error };

    try {
      const chunks = await searchLibraryChunks(
        context.supabase,
        data.query,
        { industry: data.industry, customer: data.customer },
        data.matchCount ?? DEFAULT_MATCH_COUNT,
        embedder.embed,
      );
      return { ok: true, chunks };
    } catch (error) {
      // Provider or database detail stays in the server log, not the response.
      console.error("[RAG] search failed", error instanceof Error ? error.message : error);
      return { ok: false, error: "Library search failed. Please try again." };
    }
  });
