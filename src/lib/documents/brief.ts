/**
 * Step 3-pre (1): the export brief. Reads the whole conversation, not just the
 * last message, and extracts the client, industry, problem, goals, constraints,
 * budget/timeline hints, explicit includes/excludes and decisions already made.
 *
 * The brief never supplies facts. It supplies framing and priorities; every
 * figure in the document must still come from retrieved chunks. Missing key
 * inputs become Open items instead of guesses.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { entityCandidates, resolveLibraryEntity, splitEntityMentions } from "../rag/entities";
import type { DocumentDraft, ExportBrief } from "./types";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type ProviderOptions,
} from "./provider";
import { llmBudget } from "./llm-budget";

export type ExportHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  /** Sources cited by this answer, passed from the transcript. */
  sources?:
    | {
        title: string;
        contentId?: string | null | undefined;
        chunkId?: string | null | undefined;
      }[]
    | undefined;
};

export type BriefOptions = ProviderOptions & {
  /** Used to canonicalise parties when the brief model fails. */
  client?: SupabaseClient<Database>;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

const MAX_TRANSCRIPT_CHARS = 16_000;

/**
 * An over-long array is a formatting slip, not a failed brief. Rejecting the
 * whole payload used to throw away a perfectly good brief (and produced a junk
 * fallback title), so arrays are trimmed to their documented size instead.
 */
function capped<T extends z.ZodTypeAny>(item: T, limit: number) {
  return z
    .array(item)
    .default([])
    .transform((values) => values.slice(0, limit));
}

const briefSchema = z.object({
  title: z.string().trim().max(140).nullish(),
  subject: z.string().trim().max(200).nullish(),
  partiesInvolved: capped(z.string().trim().max(80), 8),
  keyTopics: capped(z.string().trim().max(80), 10),
  keyEntities: capped(z.string().trim().max(80), 12),
  client: z.string().trim().max(120).nullish(),
  industry: z.string().trim().max(80).nullish(),
  sector: z.string().trim().max(80).nullish(),
  audience: z.string().trim().max(80).nullish(),
  problem: z.string().trim().max(600).nullish(),
  goals: capped(z.string().trim().max(300), 8),
  constraints: capped(z.string().trim().max(300), 8),
  budget: z.string().trim().max(160).nullish(),
  timeline: z.string().trim().max(160).nullish(),
  tone: z.string().trim().max(80).nullish(),
  include: capped(z.string().trim().max(200), 8),
  exclude: capped(z.string().trim().max(200), 8),
  decisions: capped(z.string().trim().max(300), 8),
  citedDocuments: capped(z.object({ title: z.string().trim().max(200) }), 12),
  openItems: capped(z.string().trim().max(220), 10),
});

/** Instruction fragments that are never a party name ("Use numbers", "tables"). */
const INSTRUCTION_START =
  /^(use|include|exclude|add|cover|make|keep|write|build|create|show|avoid|no|without|with|and|or|numbers?|tables?|charts?|bullets?|slides?|deck|proposal|pitch|please|can|could|would|assume|assumed|footfall)\b/i;

function plausibleParty(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 80) return false;
  if (text.split(" ").length > 5) return false;
  if (INSTRUCTION_START.test(text)) return false;
  return !/\b(assum\w*|footfall|numbers?|tables?|charts?|bullet|slides?)\b/i.test(text);
}

/** De-duplicated, instruction-free party names, in the order first seen. */
export function cleanPartyMentions(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!plausibleParty(text) || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
  }
  return cleaned;
}

/** Numbers the user wrote in chat. Used to flag conflicts, never to justify output. */
export function figuresInChat(history: readonly ExportHistoryMessage[]): string[] {
  const pattern =
    /(?:[£$€]\s?\d[\d,.]*\s?(?:bn|m|k)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|days?|weeks?|months?|years?|hours?|x|times|bn|fTE)\b|\b\d{1,3}(?:,\d{3})+\b)/gi;
  const found = new Set<string>();
  for (const message of history) {
    if (message.role !== "user") continue;
    for (const match of message.content.matchAll(pattern)) {
      const value = match[0]?.replace(/\s+/g, " ").trim();
      if (value) found.add(value);
    }
  }
  return [...found].slice(0, 20);
}

/** Compact transcript: every turn, with cited documents attached to answers. */
export function transcriptOf(history: readonly ExportHistoryMessage[]): string {
  return history
    .filter((message) => message.content.trim().length > 0)
    .map((message) => {
      const who = message.role === "user" ? "User" : "Assistant";
      const limit = message.role === "user" ? 1600 : 1100;
      const body = message.content.replace(/\s+/g, " ").trim().slice(0, limit);
      const cites =
        message.sources && message.sources.length > 0
          ? ` [cites: ${[...new Set(message.sources.map((source) => source.title))].slice(0, 5).join(" | ")}]`
          : "";
      return `${who}: ${body}${cites}`;
    })
    .join("\n\n");
}

export function citedDocumentsFromHistory(
  history: readonly ExportHistoryMessage[],
): { contentId: string | null; title: string }[] {
  const seen = new Set<string>();
  const documents: { contentId: string | null; title: string }[] = [];
  for (const message of history) {
    for (const source of message.sources ?? []) {
      const key = source.contentId ?? source.title;
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({ contentId: source.contentId ?? null, title: source.title });
    }
  }
  return documents.slice(0, 12);
}

/**
 * Deterministic parties for the fallback brief. Every organisation named
 * anywhere in the conversation is canonicalised through the same pg_trgm
 * resolver the chat uses, so a failed brief still says "IndiGo Airlines",
 * "InterGlobe Hotels" and "Movin" rather than the wizard's single client.
 */
export async function resolveConversationParties(
  client: SupabaseClient<Database>,
  history: readonly ExportHistoryMessage[],
  draft: DocumentDraft,
): Promise<string[]> {
  const texts = [
    ...history.filter((message) => message.role === "user").map((message) => message.content),
    draft.prompt,
  ].filter((text) => text.trim().length > 0);

  const mentions: string[] = [];
  for (const text of texts) {
    const parts = splitEntityMentions(text).filter(plausibleParty);
    for (const part of parts) {
      for (const candidate of entityCandidates(part, 3)) {
        if (!plausibleParty(candidate)) continue;
        if (!mentions.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) {
          mentions.push(candidate);
        }
      }
    }
  }

  const resolved = await Promise.all(
    mentions.slice(0, 16).map((mention) =>
      resolveLibraryEntity(client, mention, {
        candidates: [mention, ...entityCandidates(mention)],
        threshold: 0.4,
      }).catch(() => null),
    ),
  );

  const best = new Map<string, { name: string; score: number }>();
  for (const entity of resolved) {
    if (!entity) continue;
    const key = entity.canonical.toLowerCase();
    const existing = best.get(key);
    if (!existing || entity.score > existing.score) {
      best.set(key, { name: entity.canonical, score: entity.score });
    }
  }

  return cleanPartyMentions(
    [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.name),
  );
}

export function fallbackBrief(
  draft: DocumentDraft,
  history: readonly ExportHistoryMessage[],
  resolvedParties: readonly string[] = [],
): ExportBrief {
  const firstUser =
    history.find((message) => message.role === "user")?.content.trim() ?? draft.prompt;
  const request = lastUserMessage(history) ?? (draft.prompt || firstUser);
  const cited = citedDocumentsFromHistory(history);
  // Resolved parties win; otherwise name every organisation the request
  // mentions rather than falling back to the wizard's single client.
  const mentioned = cleanPartyMentions(resolvedParties);
  if (mentioned.length === 0) mentioned.push(...cleanPartyMentions(splitEntityMentions(request)));
  const parties = [
    ...new Set([...mentioned, draft.client].filter((value): value is string => Boolean(value))),
  ].slice(0, 8);
  const brief: ExportBrief = {
    documentTitle:
      mentioned.length > 1
        ? `${mentioned.join(" x ")} — ${draft.mode === "pitch" ? "pitch deck" : "proposal"}`
        : draft.title,
    request,
    subject: mentioned.length > 0 ? mentioned.join(" x ") : (draft.client ?? null),
    partiesInvolved: parties,
    keyTopics: [],
    keyEntities: [
      ...new Set(
        [...parties, ...cited.map((document) => document.title)].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ],
    mode: draft.mode,
    client: draft.client,
    industry: draft.industry,
    sector: draft.sector,
    audience: draft.audience,
    problem: firstUser.slice(0, 500) || null,
    goals: [],
    constraints: [],
    budget: null,
    timeline: null,
    tone: "professional, confident, concise",
    include: [],
    exclude: [],
    decisions: [],
    citedDocuments: cited,
    chatFigures: figuresInChat(history),
    openItems: [],
  };
  return { ...brief, openItems: openItemsFor(brief) };
}

/** Missing inputs the document needs but the conversation never supplied. */
export function openItemsFor(brief: ExportBrief): string[] {
  const items: string[] = [];
  if (!brief.client) items.push("Client or prospect name");
  if (!brief.industry) items.push("Client industry");
  if (brief.goals.length === 0) items.push("Success measures the client cares about");
  if (!brief.timeline) items.push("Target timeline or required go-live date");
  if (!brief.budget) items.push("Budget range or commercial constraint");
  return [...new Set([...items, ...brief.openItems])].slice(0, 14);
}

function limitTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  // Keep the opening request and the most recent turns; the middle is summarized.
  const head = transcript.slice(0, 4000);
  const tail = transcript.slice(-9000);
  return `${head}\n\n[...middle of conversation omitted...]\n\n${tail}`;
}

async function summarizeHistory(transcript: string, options: BriefOptions): Promise<string> {
  const outcome = await completeWithBudget(
    [
      {
        role: "system",
        content:
          "Summarise a sales conversation for a document writer. Keep every number, client name, date, constraint and explicit instruction verbatim. Do not add facts. Use at most 350 words, as short lines.",
      },
      { role: "user", content: transcript },
    ],
    options,
    llmBudget("BRIEF"),
    0.1,
    { label: "conversation summary" },
  );
  return outcome.content;
}

function lastUserMessage(history: readonly ExportHistoryMessage[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === "user" && message.content.trim()) return message.content.trim();
  }
  return null;
}

export const BRIEF_SYSTEM = [
  "You extract a document brief from a sales conversation. You do not write the document.",
  "Return JSON only, no markdown fences.",
  "Keys: title, subject, partiesInvolved, keyTopics, keyEntities, client, industry, sector, audience, problem, goals, constraints, budget, timeline, tone, include, exclude, decisions, citedDocuments, openItems.",
  "subject is what the document is actually about, in one line, named exactly as the conversation names it (for example 'InterGlobe x IndiGo partnership'). title is the document title derived from that subject.",
  "partiesInvolved, keyTopics and keyEntities are arrays of short strings drawn from the conversation: organisations, people, products, programmes and themes. Include every party the conversation treats as part of the story.",
  "goals, constraints, include, exclude, decisions are arrays of short strings. citedDocuments is an array of {title}.",
  "Keep figures, names and explicit instructions verbatim. Never guess a client, industry, budget or date.",
  "The conversation and the explicit request always override the wizard hints. If a wizard hint names a different client, industry or partner than the conversation, ignore the hint and follow the conversation.",
  "If a key input is absent, use null (or [] for arrays) and add it to openItems instead of inventing it.",
  "problem is a two-to-four sentence statement of what the client is trying to solve, using only what the conversation says.",
].join(" ");

/** The exact user turn the brief model sees; reused by the calibration script. */
export function briefUserPrompt(
  draft: DocumentDraft,
  history: readonly ExportHistoryMessage[],
  transcript: string,
): string {
  return [
    `Document type: ${draft.mode}`,
    `Format: ${draft.type}`,
    `Requested outline (confirmed by the user): ${draft.outline.join(" | ")}`,
    "",
    "Wizard hints (weak; earlier UI selections that may name the wrong client or sector):",
    draft.client ? `- selected client: ${draft.client}` : null,
    draft.industry ? `- selected industry: ${draft.industry}` : null,
    draft.audience ? `- selected audience: ${draft.audience}` : null,
    "",
    "Explicit export request:",
    lastUserMessage(history) ?? draft.prompt,
    "",
    "Conversation:",
    transcript,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * LLM brief, with a deterministic brief as the floor. A failed or unusable
 * completion must never block an export, and must never invent a fact either.
 */
export async function buildExportBrief(
  draft: DocumentDraft,
  history: readonly ExportHistoryMessage[],
  options: BriefOptions,
): Promise<ExportBrief> {
  const log = options.log ?? (() => undefined);
  const fallback = fallbackBrief(draft, history);
  if (history.length === 0) return fallback;

  const rawTranscript = transcriptOf(history);
  let transcript = limitTranscript(rawTranscript);
  if (rawTranscript.length > MAX_TRANSCRIPT_CHARS) {
    try {
      transcript = await summarizeHistory(transcript, options);
      log("brief history summarised", { chars: rawTranscript.length });
    } catch (error) {
      log("brief history summary failed", { error: String(error) });
    }
  }

  const user = briefUserPrompt(draft, history, transcript);

  try {
    const outcome = await completeWithBudget(
      [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: user },
      ],
      options,
      llmBudget("BRIEF"),
      0.1,
      { label: "export brief" },
    );
    const parsed = briefSchema.parse(parseJsonValue(outcome.content));

    const cited = citedDocumentsFromHistory(history);
    const wizardAllowed = history.length === 0;
    const noun = draft.mode === "pitch" ? "pitch deck" : "proposal";
    const brief: ExportBrief = {
      documentTitle: parsed.title ?? (parsed.subject ? `${parsed.subject} — ${noun}` : draft.title),
      request: (lastUserMessage(history) ?? draft.prompt).slice(0, 600),
      subject: parsed.subject ?? null,
      partiesInvolved: parsed.partiesInvolved,
      keyTopics: parsed.keyTopics,
      keyEntities: parsed.keyEntities,
      mode: draft.mode,
      client: parsed.client ?? (wizardAllowed ? draft.client : null),
      industry: parsed.industry ?? (wizardAllowed ? draft.industry : null),
      sector: parsed.sector ?? (wizardAllowed ? draft.sector : null),
      audience: parsed.audience ?? draft.audience,
      problem: parsed.problem ?? fallback.problem,
      goals: parsed.goals,
      constraints: parsed.constraints,
      budget: parsed.budget ?? null,
      timeline: parsed.timeline ?? null,
      tone: parsed.tone ?? fallback.tone,
      include: parsed.include,
      exclude: parsed.exclude,
      decisions: parsed.decisions,
      citedDocuments:
        cited.length > 0
          ? cited
          : parsed.citedDocuments.map((document) => ({ contentId: null, title: document.title })),
      chatFigures: figuresInChat(history),
      openItems: parsed.openItems,
    };
    return { ...brief, openItems: openItemsFor(brief) };
  } catch (error) {
    // No silent empty brief: rebuild it from entities resolved over the whole
    // conversation, exactly as chat resolves them.
    log("brief fell back", { reason: failureReasonOf(error), error: String(error) });
    const parties = options.client
      ? await resolveConversationParties(options.client, history, draft).catch(() => [])
      : [];
    if (parties.length > 0) log("brief fallback parties", { parties });
    return fallbackBrief(draft, history, parties);
  }
}

/** Used by tests and the debug view; keeps the parse rules in one place. */
export const briefJsonSchema = briefSchema;
export { parseJsonValue };
