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
import { ENTITY_FILTER_THRESHOLD, RETRIEVAL_CANDIDATES, RETRIEVAL_MAX_K } from "../rag/config";
import {
  resolveLibraryEntities,
  resolveLibraryEntity,
  isComparativeQuestion,
  normalizeEntityKey,
  type ResolvedEntity,
} from "../rag/entities";
import { embedQuery } from "../rag/embeddings";
import { selectRelevantChunks } from "../rag/relevance";
import {
  metadataFallbackChunks,
  searchLibraryChunksForEntities,
  type EntityScope,
} from "../rag/search";
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

      // Resolve every organisation the question names, not just the best one.
      // A follow-up like "Zurich airport and Interglobe hotels" must reach both
      // document families; the previous single-entity filter dropped one.
      const named = await resolveLibraryEntities(context.supabase, rewrite.query);

      // Wizard picks are hints, but they still apply by default: resolve each
      // selected company to the spelling the library actually stored, so a pick
      // of "IndiGo" can reach a file filed under "InterGlobe Aviation".
      const selected = (
        await Promise.all(
          ctx.clients.map((name) =>
            resolveLibraryEntity(context.supabase, name, {
              candidates: [name],
              threshold: ENTITY_FILTER_THRESHOLD,
            }),
          ),
        )
      ).filter((entity): entity is ResolvedEntity => entity !== null);

      const entities: ResolvedEntity[] = [];
      const seenEntities = new Set<string>();
      for (const entity of [...named, ...selected]) {
        const key = normalizeEntityKey(entity.canonical) || normalizeEntityKey(entity.matchedName);
        if (!key || seenEntities.has(key)) continue;
        seenEntities.add(key);
        entities.push(entity);
      }
      if (entities.length > 0) {
        console.log("[CHAT] customer entities", {
          requestId,
          entities: entities.map((entity) => ({
            canonical: entity.canonical,
            matchedName: entity.matchedName,
            score: Number(entity.score.toFixed(3)),
          })),
        });
      }

      // Selected companies stay a default scope; the named entities get their
      // own searches inside searchLibraryChunksForEntities.
      const scopes = retrievalScopes(ctx);
      for (const entity of selected) {
        scopes.push({ customer: entity.matchedName }, { customer: entity.canonical });
      }

      const corpus: EntityScope[] = entities.map((entity) => ({
        canonical: entity.canonical,
        spellings: entity.spellings,
      }));
      const searchText = buildRetrievalQuery(rewrite.query, ctx);

      // One pass per named/selected organisation plus the wizard scopes, all
      // embedded once and merged with a per-entity quota, so one document family
      // cannot crowd out the others.
      const candidates = await searchLibraryChunksForEntities(
        context.supabase,
        searchText,
        corpus,
        scopes,
        RETRIEVAL_CANDIDATES,
        (query) => embedQuery(query, { apiKey, baseUrl }),
      );

      // Retrieval hands back a fixed candidate list; only passages that clear
      // the score floor (and belong to a named entity) are worth prompting with.
      let chunks = selectRelevantChunks(candidates, {
        entityKeys: entities
          .flatMap((entity) => [entity.canonical, entity.matchedName, ...entity.spellings])
          .map(normalizeEntityKey),
        comparative: isComparativeQuestion(data.question),
      });

      // Before saying nothing was found, check the metadata: a named customer or
      // file may exist even when the hybrid ranking returned no passage.
      if (chunks.length === 0 && entities.length > 0) {
        chunks = await metadataFallbackChunks(
          context.supabase,
          entities.flatMap((entity) => [entity.canonical, entity.matchedName]),
          RETRIEVAL_MAX_K,
        );
        if (chunks.length > 0) {
          console.log("[CHAT] metadata fallback", { requestId, chunks: chunks.length });
        }
      }

      console.log("[CHAT] retrieval", {
        requestId,
        candidates: candidates.length,
        selected: chunks.length,
        documents: [...new Set(chunks.map((chunk) => chunk.contentId))].length,
      });

      if (chunks.length === 0) {
        return {
          ok: true,
          answer: noPassagesAnswer(entities.map((entity) => entity.canonical)),
          sources: [],
          grounded: false,
        };
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
