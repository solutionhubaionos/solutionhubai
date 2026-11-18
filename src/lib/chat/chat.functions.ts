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
import {
  resolveLibraryEntities,
  resolveLibraryEntity,
  isComparativeQuestion,
  normalizeEntityKey,
  type ResolvedEntity,
} from "../rag/entities";
import { embedQuery } from "../rag/embeddings";
import { gatherLibraryEvidence } from "../rag/search";
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
import {
  EMPTY_SCOPE,
  isEmptyScope,
  outsideScopeEntities,
  outsideScopeNote,
  scopeCompanyNames,
  scopePromptLine,
  scopeRetrievalScopes,
  type ConversationScope,
} from "./conversationScope";
import { readConversationScope } from "./scope.functions";

export type AskLibraryResult =
  | {
      ok: true;
      answer: string;
      sources: ChatSource[];
      grounded: boolean;
      /** Organisations reached outside the selected scope, for the Add action. */
      addedEntities?: string[];
    }
  | { ok: false; error: string };

const contextSchema = z.object({
  clients: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  personas: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  industries: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  sectors: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  website: z.string().trim().max(200).default(""),
  /** Who we are pitching: a topical hint, never a retrieval filter. */
  targetClients: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        industry: z.string().trim().max(80).nullish(),
        websiteUrl: z.string().trim().max(500).nullish(),
        description: z.string().trim().max(400).nullish(),
        includePriorWork: z.boolean().optional(),
      }),
    )
    .max(6)
    .default([]),
  anonymise: z.boolean().default(true),
});

export const askLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        question: z.string().trim().min(2).max(2000),
        /** The stored conversation whose scope this turn runs inside. */
        conversationId: z.string().uuid().optional(),
        /** Industry slug -> display name, for the scope line and the pill. */
        industryNames: z.record(z.string()).optional(),
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

    // The stored scope is the source of truth; the client's live context is only
    // merged in for conversations that predate persistence.
    const scope: ConversationScope = data.conversationId
      ? await readConversationScope(context.supabase, data.conversationId)
      : EMPTY_SCOPE;
    const scoped = !isEmptyScope(scope);

    const targetClients = data.context?.targetClients ?? [];
    const ctx = {
      clients: [...new Set([...scopeCompanyNames(scope), ...(data.context?.clients ?? [])])],
      personas: data.context?.personas ?? [],
      industries: [...new Set([...scope.industries, ...(data.context?.industries ?? [])])],
      sectors: data.context?.sectors ?? [],
      website: data.context?.website ?? "",
      targetClients: targetClients.map((target) => ({
        name: target.name,
        industry: target.industry ?? null,
        websiteUrl: target.websiteUrl ?? null,
        description: target.description ?? null,
        includePriorWork: target.includePriorWork ?? false,
      })),
      anonymise: data.context?.anonymise ?? true,
    };
    const scopeLine = scopePromptLine(scope, data.industryNames ?? {});

    // A target we are pitching is never resolved as an evidence customer; the
    // library belonging to other clients is the whole point. The opt-in toggle
    // is the only way its own material may be searched.
    const targetNames = new Set(
      targetClients
        .filter((target) => !target.includePriorWork)
        .map((target) => normalizeEntityKey(target.name))
        .filter(Boolean),
    );
    const isTarget = (entity: ResolvedEntity) => {
      const key = normalizeEntityKey(entity.canonical);
      if (!key) return false;
      for (const name of targetNames) {
        if (key === name || key.includes(name) || name.includes(key)) return true;
      }
      return false;
    };

    try {
      // A follow-up is rewritten into a standalone query before it is embedded;
      // both forms go to the log so a bad rewrite can be traced.
      const rewrite = await rewriteQuery(data.question, data.history ?? [], {
        apiKey,
        baseUrl,
        ...(scopeLine ? { scopeLine } : {}),
        log: (event, meta) => console.log(`[CHAT] ${event}`, { requestId, ...meta }),
      });

      // Resolve every organisation the question names, not just the best one.
      // A follow-up like "Zurich airport and Interglobe hotels" must reach both
      // document families; the previous single-entity filter dropped one.
      const named = (await resolveLibraryEntities(context.supabase, rewrite.query)).filter(
        (entity) => !isTarget(entity),
      );

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

      // A question may name an organisation the user did not select. It is still
      // answered (never blocked), and the answer says it was added for this turn.
      const addedEntities = scoped
        ? outsideScopeEntities(
            named.map((entity) => entity.canonical),
            scope,
          )
        : [];

      // Selected companies stay a default scope; the named entities get their
      // own searches inside gatherLibraryEvidence.
      const scopes = scoped ? scopeRetrievalScopes(scope) : retrievalScopes(ctx);
      for (const entity of selected) {
        scopes.push({ customer: entity.matchedName }, { customer: entity.canonical });
      }

      // One embedded question, one pass per named/selected organisation plus
      // the wizard scopes, relevance filtering, the unscoped fallback and the
      // metadata safety net all live behind this call.
      const evidence = await gatherLibraryEvidence({
        client: context.supabase,
        query: buildRetrievalQuery(rewrite.query, ctx),
        entities,
        scopes,
        comparative: isComparativeQuestion(data.question),
        fallbackToLibrary: scoped,
        k: RETRIEVAL_CANDIDATES,
        embed: (query) => embedQuery(query, { apiKey, baseUrl }),
      });
      const chunks = evidence.chunks;

      console.log("[CHAT] retrieval", {
        requestId,
        source: evidence.source,
        candidates: evidence.candidates,
        selected: chunks.length,
        documents: [...new Set(chunks.map((chunk) => chunk.contentId))].length,
      });

      if (chunks.length === 0) {
        return {
          ok: true,
          answer: noPassagesAnswer(
            entities.map((entity) => entity.canonical),
            targetClients.map((target) => target.name),
          ),
          sources: [],
          grounded: false,
        };
      }

      const built = buildContext(chunks);
      const messages = buildMessages(data.question, built, data.history ?? [], scopeLine);
      const raw = await generateAnswer(messages, { apiKey, baseUrl, requestId });
      const final = finalizeAnswer(raw.answer, built);

      // The scope note is server-owned: it is appended after citation cleanup so
      // the markers in it can never be renumbered.
      const note = outsideScopeNote(addedEntities);
      const answer = note ? `${final.answer}\n\n${note}` : final.answer;

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

      return {
        ok: true,
        answer,
        sources: final.sources,
        grounded: true,
        ...(addedEntities.length > 0 ? { addedEntities } : {}),
      };
    } catch (error) {
      console.error("[CHAT] turn failed", error instanceof Error ? error.message : error);
      return { ok: false, error: "AI Search could not answer that. Please try again." };
    }
  });
