/**
 * One call for the whole deck. The confirmed plan is the contract: the model
 * fills content, picks no titles and reorders nothing. Reasoning is off by
 * default (env DOC_THINKING_DECK); if it is turned on the budget is 24000.
 */
import type { ExportBrief } from "./types";
import type { SectionPlan } from "./outline";
import { mustIncludeItems } from "./outline";
import type { RetrievedChunk } from "../rag/search";
import type { AssumptionModel } from "./assumptions";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type CompletionMessage,
  type ProviderOptions,
} from "./provider";
import { llmBudget, withMaxTokens } from "./llm-budget";

export type DeckOptions = ProviderOptions & {
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export type DeckResult = {
  rawSlides: unknown[];
  warnings: string[];
  rawCharacters: number;
};

export const DECK_SYSTEM = [
  "You write a client-ready sales deck for Solution Hub as JSON.",
  'Return JSON only, no fences: {"slides":[slide...]}.',
  "The plan is a contract. Return exactly one slide per plan entry, in order, with the same title, layout and section tag. Do not add, drop or reorder slides.",
  "Slide shape: {title, section, layout, text, bullets, table:{headers,rows}, kpis:[{label,value,note}], chart:{type,title,unit,categories,series:[{name,values}],basis}, flow:[{label,detail}], timeline:[{phase,when,items}], notes, refs:[passage numbers]}.",
  "Composition is your call per slide: a visual alone, a visual with a short text panel or bullets, or text and bullets only. Every slide must have something to show (text, bullets or a visual).",
  "Layouts: summary, text, bullets, table, comparison, kpis, chart, flow, timeline, raci. Match the plan; if the content does not fit, use the closest layout and put the detail in a table or text.",
  "Use ONLY the numbered passages and the supplied assumptions. No outside knowledge. Never invent clients, numbers, outcomes, dates, quotes or product names.",
  "Describe each company only as its own passages describe it. Do not add reputation, market position, scale, capability or a relationship the passages do not state.",
  "No number, count, percentage, price or date may appear unless it is stated verbatim in a passage you cite, or is a value in the supplied assumptions object.",
  "refs are the passage numbers a slide uses, e.g. [1,3]. Every factual slide cites at least one. Chart basis is 'sourced' only when every value appears verbatim in the cited passages; 'assumption' only for values from the supplied assumptions object. Never cite an assumption as sourced.",
  "Prefer a table for parties, collaboration pointers, shortcomings and comparisons; a chart or KPIs for economics; flow or timeline for a journey/roadmap; text and bullets for the summary, context and ask.",
  "Highlight the single most important figure or phrase on a slide by wrapping it in **double asterisks** inside text or bullets. Never wrap a whole sentence, a title or the notes.",
  "Speaker notes: 1-3 sentences of supporting detail, always present.",
  "If a requested item cannot be supported by the library, say exactly what is missing on the relevant slide and in the notes; do not pad or invent.",
  "Write in British English, active voice, concise. No meta commentary, no reference to passages in the prose.",
  'Example slide: {"title":"Partners bring distinct capabilities","layout":"table","section":"Partners","table":{"headers":["Party","Documented capability","Evidence"],"rows":[["IndiGo Airlines","Airline distribution and route network","[1]"]]},"notes":"Rows summarise the cited passages.","refs":[1]}',
].join(" ");

function briefForPrompt(brief: ExportBrief): string {
  return JSON.stringify(
    {
      request: brief.request,
      mode: brief.mode,
      client: brief.client,
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
      const customer = chunk.customerName ? ` · customer: ${chunk.customerName}` : "";
      return `[${index + 1}] ${chunk.title} (${chunk.fileName}, ${where}) · industry: ${chunk.industry}${customer}\n${chunk.content.slice(0, 1500)}`;
    })
    .join("\n\n");
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
): string {
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
    assumptions
      ? `Assumptions model (code-computed, illustrative only; never cite as sourced):\n${JSON.stringify(
          { rows: assumptions.rows, chart: assumptions.chart },
          null,
          1,
        )}`
      : "Assumptions model: none. Do not invent numbers.",
    "",
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
    { role: "user", content: deckUserPrompt(plans, brief, chunks, assumptions) },
  ];
  const warnings: string[] = [];
  let raw = "";

  try {
    const outcome = await completeWithBudget(messages, options, llmBudget("DECK"), 0.2, {
      label: "export deck",
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
