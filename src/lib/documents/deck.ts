/**
 * One call for the whole deck. The confirmed plan is the contract: the model
 * fills content, picks no titles and reorders nothing. Reasoning is off by
 * default (env DOC_THINKING_DECK); if it is turned on the budget is 24000.
 */
import type { ExportBrief } from "./types";
import type { ExportHistoryMessage } from "./brief";
import type { SectionPlan } from "./outline";
import { mustIncludeItems } from "./outline";
import type { RetrievedChunk } from "../rag/search";
/** Optional code-computed figures for the legacy prompt. Never a source of truth. */
type AssumptionModel = { rows: unknown; chart: unknown };
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type CompletionMessage,
  type ProviderOptions,
} from "./provider";
import { llmBudget, withMaxTokens } from "./llm-budget";

export type DeckOptions = ProviderOptions & {
  /** Smaller, thinking-off call used to expand only the thin slides. */
  enrichment?: boolean;
  /** Prior assistant answers, remapped to this deck's passage numbers. */
  analysisContext?: string;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export type DeckResult = {
  rawSlides: unknown[];
  warnings: string[];
  rawCharacters: number;
};

export const DECK_SYSTEM = [
  "You write a client-ready sales deck for Aionos as JSON.",
  'Return JSON only, no fences: {"slides":[slide...]}.',
  "The plan is a contract. Return exactly one slide per plan entry, in order, with the same title, layout and section tag. Do not add, drop or reorder slides.",
  "Slide shape: {title, section, layout, text, takeaway, bullets:[{text,kind,refs}], table:{headers,rows}, kpis:[{label,value,note}], chart:{type,title,unit,categories,series:[{name,values}],basis}, flow:[{label,detail}], timeline:[{phase,when,items}], notes, refs:[passage numbers]}.",
  "Bullet kind: evidence = a fact from a numbered passage, cited in refs; implication = may connect, compare, weigh trade-offs or name a gap/open question based only on cited facts, and MUST NOT add a fact, number, entity or claim about a company the passages do not support; recommendation = our proposal (next steps, structure, pilots), which needs no citation and is rendered with a Proposed tag but must contain no invented figures and must not present itself as sourced.",
  "Text-led slides: lead with one sentence of at most 30 words, then 3-5 bullets of at most 22 words mixing the kinds, and end with a so-what takeaway. Visual slides (table, chart, kpis, flow, timeline): add a 1-2 sentence takeaway and at most 2 short bullets.",
  "A takeaway states what the evidence means for the client in one or two sentences; it is not a summary of the slide and it adds no new fact.",
  "Composition is your call per slide: a visual alone, a visual with a short text panel or bullets, or text and bullets only. Every slide must have something to show (text, bullets or a visual).",
  "Layouts: summary, text, bullets, table, comparison, kpis, chart, flow, timeline, raci. Match the plan; if the content does not fit, use the closest layout and put the detail in a table or text.",
  "Use ONLY the numbered passages and the supplied assumptions. No outside knowledge. Never invent clients, numbers, outcomes, dates, quotes or product names.",
  "Describe each company only as its own passages describe it. Do not add reputation, market position, scale, capability or a relationship the passages do not state.",
  "No number, count, percentage, price or date may appear unless it is stated verbatim in a passage you cite, or is a value in the supplied assumptions object.",
  "refs are the passage numbers a slide uses, e.g. [1,3]. Every factual slide cites at least one. Chart basis is 'sourced' only when every value appears verbatim in the cited passages; 'assumption' only for values from the supplied assumptions object. Never cite an assumption as sourced.",
  "Prefer a table for parties, collaboration pointers, shortcomings and comparisons; a chart or KPIs for economics; flow or timeline for a journey/roadmap with 1-2 sentence descriptions per step; text and bullets for the summary, context and ask.",
  "The parties slide has one row for EVERY party named in the brief. Where the passages say little about a party, write the role we propose for them in our own voice (a partner to scope with them) instead of omitting the party or announcing that evidence is missing.",
  "Each figure or passage is the primary content of ONE slide. Do not repeat the same number, quote or fact on another slide.",
  "Do not build more than two consecutive table slides, and keep tables to roughly one per three slides unless the brief explicitly asks for tables.",
  "Match the section tag to the content: never tag next steps, risks or the ask as Evidence.",
  "When analysis context is supplied, reuse and expand its reasoning rather than restating the passages; still ground every evidence item in the numbered passages. Do not copy an analysis assertion into slide copy unless the cited passages support it: keep it as an implication that adds no new fact, or move it to open questions.",
  "Highlight the single most important figure or phrase on a slide by wrapping it in **double asterisks** inside text or bullets. Never wrap a whole sentence, a title or the notes.",
  "Speaker notes: 2-4 sentences of presenter talking points only, always present. No claim ids, file names, other customers' names or audit caveats.",
  "If a requested item has no support in the passages, leave it out of the slide copy and put our recommendation or next step in its place; record the gap in the notes, never in the reader-facing copy. Do not pad or invent.",
  "Aggressive localisation is mandatory. Every heading, bullet and sentence is rewritten into the target client's voice and context; replace previous client names with the target client. Use the client's own vocabulary from the brief and passages (systems, terminals, programmes, volumes) when the evidence supplies it.",
  "Reference customers are anonymised in the passages as neutral labels. Never print a library customer's real name. Cite past work once on the proof slide, never as a repeated template sentence.",
  "A peer's systems, products, staff counts, results or numbers are reference facts, never the target's. Never title a chart or KPI with the target's name when the figures come from a reference.",
  "Do not use model memory about the target client (loyalty programme, hub, fleet, route count, size or market position). Only the brief, the user's note or the website description may supply those facts.",
  "If the evidence has no client-specific number, keep the claim qualitative and record the gap only as a plain presenter caveat; never invent a metric to look local.",
  "Never hard-code colours, logos, fonts or visual styling; the renderer applies the approved brand kit.",
  "Write in British English, active voice, concise. No meta commentary, no reference to passages in the prose.",
  'Example slide: {"title":"Partners bring distinct capabilities","layout":"table","section":"Partners","takeaway":"Each party covers a leg of the journey the others cannot sell.","table":{"headers":["Party","Capability","Evidence"],"rows":[["Delivery partner","Distribution and route network","[1]"]]},"bullets":[{"text":"The three capabilities are complementary, not overlapping","kind":"implication"}],"notes":"Rows summarise the cited passages.","refs":[1]}',
].join(" ");

function briefForPrompt(brief: ExportBrief): string {
  return JSON.stringify(
    {
      request: brief.request,
      mode: brief.mode,
      client: brief.client,
      targetClients: brief.targetClients ?? [],
      anonymiseEvidenceCustomers: brief.anonymise ?? false,
      industry: brief.industry,
      audience: brief.audience,
      problem: brief.problem,
      goals: brief.goals,
      constraints: brief.constraints,
      parties: [...new Set([...(brief.partiesInvolved ?? []), ...(brief.keyEntities ?? [])])],
      mustInclude: mustIncludeItems(brief.request),
      exclude: brief.exclude,
      openItems: brief.openItems,
    },
    null,
    1,
  );
}

function passagesForPrompt(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const where = chunk.page
        ? `page ${chunk.page}`
        : chunk.slide
          ? `slide ${chunk.slide}`
          : (chunk.heading ?? "passage");
      const customer = chunk.customerName ? ` · reference: ${chunk.customerName}` : "";
      return `[${index + 1}] ${chunk.title} (${chunk.fileName}, ${where}) · industry: ${chunk.industry}${customer}\n${chunk.content.slice(0, 1500)}`;
    })
    .join("\n\n");
}

const ANALYSIS_CHARS = 6_000;
const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Markdown is noise to the deck model; the reasoning is the signal. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The last few assistant answers, citations rewritten to this deck's passage
 * numbers. Their cited chunk ids are the only citations that can be remapped;
 * anything unknown is dropped rather than left pointing at the wrong passage.
 */
export function deckAnalysisContext(
  history: readonly ExportHistoryMessage[],
  chunks: readonly RetrievedChunk[],
): string {
  const indexByChunk = new Map(chunks.map((chunk, index) => [chunk.chunkId, index + 1]));
  const answers = history
    .filter((message) => message.role === "assistant" && message.content.trim().length > 0)
    .slice(-3);
  const blocks: string[] = [];
  let used = 0;

  for (const message of [...answers].reverse()) {
    const sources = message.sources ?? [];
    const body = stripMarkdown(message.content)
      .replace(CITATION, (_match, group: string) => {
        const mapped = group
          .split(",")
          .map((value) => sources[Number(value) - 1]?.chunkId)
          .map((id) => (id ? indexByChunk.get(id) : undefined))
          .filter((value): value is number => value !== undefined);
        return mapped.length > 0 ? `[${[...new Set(mapped)].join(",")}]` : "";
      })
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (!body) continue;
    const room = ANALYSIS_CHARS - used;
    if (room <= 200) break;
    const text = body.length > room ? `${body.slice(0, room).trimEnd()}…` : body;
    blocks.unshift(text);
    used += text.length;
  }

  return blocks.map((text, index) => `Earlier answer ${index + 1}:\n${text}`).join("\n\n");
}

function planForPrompt(plans: readonly SectionPlan[]): string {
  return JSON.stringify(
    plans.map((plan) => ({
      title: plan.title,
      layout: plan.layout ?? "text",
      section: plan.section,
    })),
    null,
    1,
  );
}

export function deckUserPrompt(
  plans: readonly SectionPlan[],
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  assumptions: AssumptionModel | null,
  analysisContext = "",
): string {
  const target = brief.client ?? brief.targetClients?.[0] ?? null;
  return [
    "Plan (contract; same titles and order):",
    planForPrompt(plans),
    "",
    "Export brief (framing only, not a source of facts):",
    briefForPrompt(brief),
    "",
    "Passages (the only sourced facts you may use):",
    passagesForPrompt(chunks),
    "",
    target
      ? `Target client: ${target}. Write TO this client; the passages are evidence from other customers and must be adapted, not copied.`
      : "Target client: not named.",
    "",
    ...(brief.anonymise
      ? [
          "Anonymise the evidence customers in every slide: describe them generically (for example 'a leading European airport operator') and never print their real names, even inside a table or a quote.",
          "",
        ]
      : []),
    assumptions
      ? `Assumptions model (code-computed, illustrative only; never cite as sourced):\n${JSON.stringify(
          { rows: assumptions.rows, chart: assumptions.chart },
          null,
          1,
        )}`
      : "Assumptions model: none. Do not invent numbers.",
    "",
    ...(analysisContext
      ? [
          "Analysis context from the conversation (reuse and expand this reasoning; every evidence item must still come from the numbered passages and its refs):",
          analysisContext,
          "",
        ]
      : []),
    "Return one slide per plan entry, with the exact title. JSON only.",
  ].join("\n");
}

function parseSlides(raw: string): unknown[] {
  const parsed = parseJsonValue(raw);
  if (Array.isArray(parsed)) return parsed;
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return Array.isArray(record["slides"]) ? (record["slides"] as unknown[]) : [];
}

/**
 * One deck call, plus at most one repair call when the response was not JSON or
 * contained no slides. The repair forces thinking off and never reuses the
 * truncated payload.
 */
export async function generateDeck(
  plans: readonly SectionPlan[],
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  assumptions: AssumptionModel | null,
  options: DeckOptions,
): Promise<DeckResult> {
  const log = options.log ?? (() => undefined);
  const messages: CompletionMessage[] = [
    { role: "system", content: DECK_SYSTEM },
    {
      role: "user",
      content: deckUserPrompt(plans, brief, chunks, assumptions, options.analysisContext),
    },
  ];
  const warnings: string[] = [];
  let raw = "";
  const budget = options.enrichment
    ? withMaxTokens(llmBudget("DECK"), 4_000, false)
    : llmBudget("DECK");

  try {
    const outcome = await completeWithBudget(messages, options, budget, 0.2, {
      label: options.enrichment ? "export deck enrichment" : "export deck",
    });
    raw = outcome.content;
    const slides = parseSlides(raw);
    if (slides.length > 0) {
      return { rawSlides: slides, warnings, rawCharacters: raw.length };
    }
    warnings.push("Deck returned no slides; repaired once.");
  } catch (error) {
    warnings.push(`Deck response was not valid JSON (${failureReasonOf(error)}); repaired once.`);
    log("deck parse failed", {
      reason: failureReasonOf(error),
      error: String(error).slice(0, 240),
    });
  }

  const repairBudget = withMaxTokens(llmBudget("DECK"), 16_000, false);
  const repairMessages: CompletionMessage[] = [
    ...messages,
    {
      role: "user",
      content:
        'Your previous response was not usable. Return the complete JSON object {\\"slides\\":[...]} now, one slide per plan entry, with no prose or fences.',
    },
  ];
  const outcome = await completeWithBudget(repairMessages, options, repairBudget, 0.1, {
    label: "export deck repair",
  });
  const slides = parseSlides(outcome.content);
  if (slides.length === 0) {
    throw new Error("deck repair returned no slides");
  }
  warnings.push("Recovered the deck with one repair call.");
  return { rawSlides: slides, warnings, rawCharacters: outcome.content.length };
}
