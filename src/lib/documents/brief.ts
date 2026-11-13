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
import type { DocumentDraft, ExportBrief } from "./types";
import { completeJson, completeText, parseJsonValue, type ProviderOptions } from "./provider";

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
  log?: (event: string, meta: Record<string, unknown>) => void;
};

const MAX_TRANSCRIPT_CHARS = 16_000;

const briefSchema = z.object({
  client: z.string().trim().max(120).nullish(),
  industry: z.string().trim().max(80).nullish(),
  sector: z.string().trim().max(80).nullish(),
  audience: z.string().trim().max(80).nullish(),
  problem: z.string().trim().max(600).nullish(),
  goals: z.array(z.string().trim().max(300)).max(8).default([]),
  constraints: z.array(z.string().trim().max(300)).max(8).default([]),
  budget: z.string().trim().max(160).nullish(),
  timeline: z.string().trim().max(160).nullish(),
  tone: z.string().trim().max(80).nullish(),
  include: z.array(z.string().trim().max(200)).max(8).default([]),
  exclude: z.array(z.string().trim().max(200)).max(8).default([]),
  decisions: z.array(z.string().trim().max(300)).max(8).default([]),
  citedDocuments: z
    .array(z.object({ title: z.string().trim().max(200) }))
    .max(12)
    .default([]),
  openItems: z.array(z.string().trim().max(220)).max(10).default([]),
});

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

export function fallbackBrief(
  draft: DocumentDraft,
  history: readonly ExportHistoryMessage[],
): ExportBrief {
  const firstUser =
    history.find((message) => message.role === "user")?.content.trim() ?? draft.prompt;
  const cited = citedDocumentsFromHistory(history);
  const brief: ExportBrief = {
    documentTitle: draft.title,
    request: draft.prompt || firstUser,
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
  return completeText(
    [
      {
        role: "system",
        content:
          "Summarise a sales conversation for a document writer. Keep every number, client name, date, constraint and explicit instruction verbatim. Do not add facts. Use at most 350 words, as short lines.",
      },
      { role: "user", content: transcript },
    ],
    options,
    900,
    0.1,
  );
}

const BRIEF_SYSTEM = [
  "You extract a document brief from a sales conversation. You do not write the document.",
  "Return JSON only, no markdown fences.",
  "Keys: client, industry, sector, audience, problem, goals, constraints, budget, timeline, tone, include, exclude, decisions, citedDocuments, openItems.",
  "goals, constraints, include, exclude, decisions are arrays of short strings. citedDocuments is an array of {title}.",
  "Keep figures, names and explicit instructions verbatim. Never guess a client, industry, budget or date.",
  "If a key input is absent, use null (or [] for arrays) and add it to openItems instead of inventing it.",
  "problem is a two-to-four sentence statement of what the client is trying to solve, using only what the conversation says.",
].join(" ");

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

  const user = [
    `Document type: ${draft.mode}`,
    `Format: ${draft.type}`,
    `Requested title: ${draft.title}`,
    `Requested outline: ${draft.outline.join(" | ")}`,
    draft.client ? `Selected client: ${draft.client}` : null,
    draft.industry ? `Selected industry: ${draft.industry}` : null,
    draft.audience ? `Selected audience: ${draft.audience}` : null,
    "",
    "Conversation:",
    transcript,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  try {
    const parsed = briefSchema.parse(
      await completeJson(
        [
          { role: "system", content: BRIEF_SYSTEM },
          { role: "user", content: user },
        ],
        options,
        1100,
        0.1,
      ),
    );

    const cited = citedDocumentsFromHistory(history);
    const brief: ExportBrief = {
      documentTitle: draft.title,
      request: (history.find((message) => message.role === "user")?.content ?? draft.prompt).slice(
        0,
        600,
      ),
      mode: draft.mode,
      client: parsed.client ?? draft.client,
      industry: parsed.industry ?? draft.industry,
      sector: parsed.sector ?? draft.sector,
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
    log("brief fell back", { error: String(error) });
    return fallback;
  }
}

/** Used by tests and the debug view; keeps the parse rules in one place. */
export const briefJsonSchema = briefSchema;
export { parseJsonValue };
