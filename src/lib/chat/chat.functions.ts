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
import { ENTITY_FILTER_THRESHOLD, RETRIEVAL_CANDIDATES } from "../rag/config";
import { resolveLibraryEntity, isComparativeQuestion, normalizeEntityKey } from "../rag/entities";
import { embedQuery } from "../rag/embeddings";
import { selectRelevantChunks } from "../rag/relevance";
import { searchLibraryChunksAcrossScopes } from "../rag/search";
import {
  buildContext,
  buildMessages,
  finalizeAnswer,
  generateAnswer,
  noPassagesAnswer,
  type ChatSource,
} from "./answer";
import { rewriteQuery } from "./rewrite";
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
    const requestId = crypto.randomUUID();
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
      // A follow-up is rewritten into a standalone query before it is embedded;
      // both forms go to the log so a bad rewrite can be traced.
      const rewrite = await rewriteQuery(data.question, data.history ?? [], {
        apiKey,
        baseUrl,
        log: (event, meta) => console.log(`[CHAT] ${event}`, { requestId, ...meta }),
      });

      // Resolve the customer the question names, tolerating typos and partial
      // names. A confident match also becomes a retrieval scope, so misspelled
      // metadata still surfaces the right documents.
      const entity = await resolveLibraryEntity(context.supabase, rewrite.query);
      if (entity) {
        console.log("[CHAT] customer entity", {
          requestId,
          canonical: entity.canonical,
          matchedName: entity.matchedName,
          score: Number(entity.score.toFixed(3)),
        });
      }

      const scopes = retrievalScopes(ctx);
      if (
        entity &&
        entity.score >= ENTITY_FILTER_THRESHOLD &&
        !isComparativeQuestion(data.question)
      ) {
        scopes.push({ customer: entity.canonical });
      }

      const searchText = entity
        ? `${buildRetrievalQuery(rewrite.query, ctx)}\nCustomer: ${entity.canonical}`
        : buildRetrievalQuery(rewrite.query, ctx);

      // One scoped search per selected industry/company pair, embedded once and
      // merged, so every pick contributes rather than only the first.
      const candidates = await searchLibraryChunksAcrossScopes(
        context.supabase,
        searchText,
        scopes,
        RETRIEVAL_CANDIDATES,
        (query) => embedQuery(query, { apiKey, baseUrl }),
      );

      // Retrieval hands back a fixed candidate list; only passages that clear
      // the score floor (and the resolved customer) are worth prompting with.
      const chunks = selectRelevantChunks(candidates, {
        entityKeys: (entity?.spellings ?? []).map(normalizeEntityKey),
        comparative: isComparativeQuestion(data.question),
      });
      console.log("[CHAT] retrieval", {
        requestId,
        candidates: candidates.length,
        selected: chunks.length,
        documents: [...new Set(chunks.map((chunk) => chunk.contentId))].length,
      });

      if (chunks.length === 0) {
        return { ok: true, answer: noPassagesAnswer(), sources: [], grounded: false };
      }

      const built = buildContext(chunks);
      const messages = buildMessages(data.question, built, data.history ?? []);
      const raw = await generateAnswer(messages, { apiKey, baseUrl, requestId });
      const final = finalizeAnswer(raw.answer, built);

      // Measure how often the model still narrates its own retrieval; never block.
      if (final.metaPhrases.length > 0) {
        console.warn("[CHAT] answer described its context", {
          requestId,
          question: data.question,
          phrases: final.metaPhrases,
        });
      }
      if (final.invalidMarkers.length > 0) {
        console.warn("[CHAT] dropped citation markers", {
          requestId,
          invalidMarkers: final.invalidMarkers,
        });
      }

      return { ok: true, answer: final.answer, sources: final.sources, grounded: true };
    } catch (error) {
      console.error("[CHAT] turn failed", error instanceof Error ? error.message : error);
      return { ok: false, error: "AI Search could not answer that. Please try again." };
    }
  });
