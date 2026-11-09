/**
 * Authenticated chat turn: retrieve from the library with the caller's JWT,
 * then answer only from those passages.
 *
 * Retrieval (not the model) decides what the user may see, so citations can
 * never point at a file RLS hides. Provider errors stay in the server log.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_MATCH_COUNT } from "../rag/config";
import { embedQuery } from "../rag/embeddings";
import { searchLibraryChunksAcrossScopes } from "../rag/search";
import {
  buildMessages,
  collectSources,
  generateAnswer,
  noPassagesAnswer,
  type ChatSource,
} from "./answer";
import { buildRetrievalQuery, retrievalScopes } from "./scope";

export type AskLibraryResult =
  | { ok: true; answer: string; sources: ChatSource[]; grounded: boolean }
  | { ok: false; error: string };

const contextSchema = z.object({
  clients: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  personas: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  industries: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  sectors: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  website: z.string().trim().max(200).default(""),
});

export const askLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        question: z.string().trim().min(2).max(2000),
        context: contextSchema.optional(),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().trim().min(1).max(4000),
            }),
          )
          .max(10)
          .optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<AskLibraryResult> => {
    const apiKey = process.env["TOKENFACTORY_API_KEY"];
    const baseUrl = process.env["TOKENFACTORY_API_BASE"];
    if (!apiKey || !baseUrl) {
      console.error("[CHAT] Provider credentials are not configured");
      return { ok: false, error: "AI Search is not configured yet." };
    }

    const ctx = {
      clients: data.context?.clients ?? [],
      personas: data.context?.personas ?? [],
      industries: data.context?.industries ?? [],
      sectors: data.context?.sectors ?? [],
      website: data.context?.website ?? "",
    };

    try {
      // One scoped search per selected industry/company pair, embedded once and
      // merged, so every pick contributes rather than only the first.
      const chunks = await searchLibraryChunksAcrossScopes(
        context.supabase,
        buildRetrievalQuery(data.question, ctx),
        retrievalScopes(ctx),
        DEFAULT_MATCH_COUNT,
        (query) => embedQuery(query, { apiKey, baseUrl }),
      );

      if (chunks.length === 0) {
        return { ok: true, answer: noPassagesAnswer(), sources: [], grounded: false };
      }

      const messages = buildMessages(data.question, chunks, data.history ?? []);
      const { answer } = await generateAnswer(messages, { apiKey, baseUrl });
      return { ok: true, answer, sources: collectSources(chunks), grounded: true };
    } catch (error) {
      console.error("[CHAT] turn failed", error instanceof Error ? error.message : error);
      return { ok: false, error: "AI Search could not answer that. Please try again." };
    }
  });
