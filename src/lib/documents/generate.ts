/**
 * Step 3: one section at a time. The model receives the export brief, the
 * section goal and the passages retrieved for that section, and returns strict
 * JSON blocks with source labels. Prose is never accepted without a source.
 */
import { sectionOutputSchema, blockLabels, extractJsonObject, resolveBlocks } from "./blocks";
import type { Block, DocumentSection, ExportBrief } from "./types";
import type { SectionPlan } from "./outline";
import type { RetrievedChunk } from "../rag/search";
import {
  CompletionError,
  completeWithBudget,
  failureReasonOf,
  type ProviderOptions,
} from "./provider";
import { llmBudget } from "./llm-budget";

export type SectionGeneration = {
  section: DocumentSection;
  openItems: string[];
  droppedBlocks: number;
  rawCharacters: number;
};

export const SECTION_SYSTEM = [
  "You write one section of a client-ready sales document for Solution Hub.",
  "Return JSON only, no markdown fences.",
  'Shape: {"blocks":[block...],"speakerNotes":string,"openItems":string[]}.',
  "Allowed blocks: heading, paragraph, bullet_list, numbered_list, table, metrics, callout, quote, timeline, comparison.",
  "Every factual block must carry passageRefs: the numbers of the passages it uses, for example [1,3]. A block may use sources with S-labels instead. Metrics items and quotes need their own passage reference. Headings need none.",
  "Use ONLY facts stated in the numbered passages and the brief. No outside knowledge. Never invent clients, numbers, outcomes, dates, quotes or product names.",
  "No number, count, percentage, price or date may appear unless it is stated verbatim in a cited passage, or comes from the server's labelled assumptions output. Never estimate, extrapolate or round into a new claim.",
  "Describe each company only as its own passages describe it. Do not add reputation, market position, scale or capability the passages do not state.",
  "Specific beats vague: use a figure with its unit, baseline and timeframe only when a passage states it. If it does not, omit the claim.",
  'If no passage supports any part of the section, write one callout with text starting "[To be confirmed]" and list the gap in openItems. Do not pad.',
  "When the passages describe the parties but not the exact combined offer, write about each party's documented capability and the proposed structure instead of a placeholder; never invent the combined offer's performance.",
  "A section is never only a heading: return at least one paragraph, list, table, metric or callout that carries passageRefs.",
  "Write in British English, active voice, confident and concise. No filler, no meta commentary, no reference to passages or sources in the prose.",
  "Do not write a document title, cover, contents or sources section; the server adds those.",
].join(" ");

function briefForPrompt(brief: ExportBrief): string {
  return JSON.stringify(
    {
      request: brief.request,
      client: brief.client,
      industry: brief.industry,
      audience: brief.audience,
      problem: brief.problem,
      goals: brief.goals,
      constraints: brief.constraints,
      budget: brief.budget,
      timeline: brief.timeline,
      tone: brief.tone,
      include: brief.include,
      exclude: brief.exclude,
      decisions: brief.decisions,
      previouslyCited: brief.citedDocuments.map((document) => document.title),
    },
    null,
    2,
  );
}

const KIND_FOCUS: Record<string, string> = {
  executive_summary:
    "Open with the recommendation and the value at stake. Keep it under 200 words; no bullets-heavy appendix feeling.",
  problem:
    "Make the client's current situation and cost of inaction concrete. Do not describe our solution here.",
  solution:
    "Describe the capability and the change it creates. Prefer a short paragraph plus 3-5 outcome-oriented bullets.",
  approach:
    "Explain phases, governance and client involvement. A numbered list or a table is better than prose if the passages support it.",
  proof:
    "Use 2-3 comparable cases. Each needs a named client, the problem, the intervention and a measured outcome. A metrics block with real figures is ideal; a table is good for comparing cases.",
  timeline:
    "Render phases as a timeline block with durations the passages support. Do not invent weeks.",
  deliverables:
    "List concrete artefacts the client receives. Avoid vague 'insights and recommendations' unless the source says it.",
  assumptions:
    "Be explicit about dependencies and client responsibilities. A bullet list of 3-6 items.",
  pricing:
    'Include figures ONLY if a passage states them. Otherwise a single callout beginning "[To be confirmed]" explaining that pricing is not in the library. Never estimate.',
  next_steps:
    "Recommend one specific next step with an owner and a timeframe if the sources support it.",
  why_us:
    "Use evidence-backed differentiators (named work, measurable results, credentials). No generic adjectives.",
  how_it_works:
    "Explain the mechanics in plain language: what connects to what, who does what, what the client sees.",
  results:
    "Lead with measurable outcomes. Use a metrics block for headline numbers and a table for baselines versus results.",
  ask: "State the decision requested and the immediate next action. Keep it short.",
};

function passagesForPrompt(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const where = chunk.page
        ? `page ${chunk.page}`
        : chunk.slide
          ? `slide ${chunk.slide}`
          : (chunk.heading ?? "passage");
      const customer = chunk.customerName ? ` · customer: ${chunk.customerName}` : "";
      return `[S${index + 1}] ${chunk.title} (${chunk.fileName}, ${where}) · industry: ${chunk.industry}${customer}\n${chunk.content.slice(0, 1800)}`;
    })
    .join("\n\n");
}

export function sectionUserPrompt(
  plan: SectionPlan,
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  previousErrors: readonly string[],
): string {
  const modeRules =
    brief.mode === "proposal"
      ? "Mode: proposal. Write complete, substantive prose. Headings only if this section has two or more distinct subsections."
      : "Mode: pitch deck slide. One idea only, a headline that states the takeaway, plus at least one supporting block: at most 5 short bullets (under 14 words each). Prefer a metrics or table block when data exists. Speaker notes carry the detail.";

  return [
    `Section: ${plan.title}`,
    `Section kind: ${plan.kind}`,
    `Section goal: ${plan.goal}`,
    modeRules,
    "",
    "Export brief (framing only, not a source of facts):",
    briefForPrompt(brief),
    "",
    "Passages (the only facts you may use):",
    passagesForPrompt(chunks),
    "",
    previousErrors.length > 0
      ? `The previous attempt failed validation. Fix every issue and return the whole section again:\n- ${previousErrors.join("\n- ")}`
      : "",
    "",
    "Quality rules:",
    "- Every paragraph, list, table, callout and metric cites supporting passages with passageRefs (or S-labels).",
    "- Headings alone are not a section: include at least one sourced block below the headline.",
    "- Use ONLY the numbered passages above plus the brief. No outside knowledge, no general market context.",
    "- Describe a company only as the passages do; do not add scale, reputation or capability they do not state.",
    "- A number may appear only if it appears verbatim in a cited passage. Include units and baselines.",
    "- A quote may appear only if it is verbatim from a cited passage, with attribution to the document.",
    "- No repeated point inside the section. No internal notes, no 'as an AI', no lorem ipsum.",
    "- Speaker notes: 2-4 sentences of supporting detail with the S-labels you used.",
    "",
    "Return JSON only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Normalises a block's sources to real chunk ids; used for the trace. */
export function citedChunkIds(block: Block): string[] {
  switch (block.type) {
    case "heading":
      return [];
    case "quote":
      return [block.source];
    case "metrics":
      return [...new Set([...block.sources, ...block.items.map((item) => item.source)])];
    case "timeline":
      return [...new Set([...block.sources, ...block.items.flatMap((item) => item.sources)])];
    default:
      return block.sources;
  }
}

export function sectionSourceIds(section: DocumentSection): string[] {
  const ids = section.blocks.flatMap(citedChunkIds);
  return [...new Set(ids)];
}

function deterministicNotes(section: DocumentSection, chunks: readonly RetrievedChunk[]): string {
  const used = new Set(sectionSourceIds(section));
  const cited = chunks.filter((chunk) => used.has(chunk.chunkId)).slice(0, 2);
  if (cited.length === 0) return "";
  const where = cited
    .map((chunk) => {
      const location = chunk.page
        ? `page ${chunk.page}`
        : chunk.slide
          ? `slide ${chunk.slide}`
          : null;
      return location ? `${chunk.title}, ${location}` : chunk.title;
    })
    .join("; ");
  return `Supporting detail is drawn from ${where}. Keep the discussion anchored on the measured outcomes rather than the narrative.`;
}

/** Strict parse first, then the tolerant reader for fenced or chatty output. */
function parseSectionOutput(raw: string): ReturnType<typeof sectionOutputSchema.parse> {
  try {
    return sectionOutputSchema.parse(
      JSON.parse(
        raw
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```$/, ""),
      ),
    );
  } catch {
    return sectionOutputSchema.parse(extractJsonObject(raw));
  }
}

/** A parse/zod failure is schema_invalid; provider and token failures keep theirs. */
function asSchemaFailure(error: unknown): Error {
  const reason = failureReasonOf(error);
  if (reason === "provider_error" || reason === "token_limit" || reason === "timeout") {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new CompletionError(
    "schema_invalid",
    `section output did not match the schema: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Generates one section; throws on unparseable output so the caller can retry
 * with the validator's complaints.
 */ export async function generateSection(
  plan: SectionPlan,
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  options: ProviderOptions,
  previousErrors: readonly string[] = [],
): Promise<SectionGeneration> {
  let parsed: ReturnType<typeof sectionOutputSchema.parse>;
  const budget = llmBudget("SECTION");
  const messages = [
    { role: "system" as const, content: SECTION_SYSTEM },
    { role: "user" as const, content: sectionUserPrompt(plan, brief, chunks, previousErrors) },
  ];
  const outcome = await completeWithBudget(messages, options, budget, 0.25, {
    label: plan.id,
  });
  const raw = outcome.content;
  try {
    parsed = parseSectionOutput(raw);
  } catch (error) {
    // One repair attempt: hand the invalid payload and the exact complaint back
    // to the model before failing the section. Truncated output never reaches
    // here because completeWithBudget treats a "length" finish as a failure.
    const complaint = error instanceof Error ? error.message : String(error);
    // Surface the exact rejection: a systematic schema mismatch is a bug to
    // fix, not noise, and hiding it made every section pay for a silent repair.
    options.log?.("section schema repair", {
      section: plan.id,
      error: complaint.slice(0, 400),
    });
    let repaired: string;
    try {
      const repair = await completeWithBudget(
        [
          ...messages,
          { role: "assistant", content: raw.slice(0, 4000) },
          {
            role: "user",
            content: `That JSON was rejected: ${complaint}. Return the corrected JSON object only. Keep every fact and passage reference unchanged, and do not add anything the passages do not support.`,
          },
        ],
        options,
        budget,
        0,
        { label: `${plan.id}:repair` },
      );
      repaired = repair.content;
    } catch (failure) {
      throw asSchemaFailure(failure);
    }
    try {
      parsed = parseSectionOutput(repaired);
    } catch (repairError) {
      throw asSchemaFailure(repairError);
    }
  }

  const labelToChunk = new Map<string, string>(
    chunks.map((chunk, index) => [`S${index + 1}`, chunk.chunkId]),
  );

  // Labels the server never issued are dropped by resolveBlocks below (the
  // block loses its citation and is discarded), so a stray "S16" costs one
  // block, not the whole section. It is logged because it signals drift.
  const unknownLabels = new Set<string>();
  for (const block of parsed.blocks) {
    for (const label of blockLabels(block)) {
      if (!labelToChunk.has(label)) unknownLabels.add(label);
    }
  }
  if (unknownLabels.size > 0) {
    options.log?.("section unknown labels", {
      section: plan.id,
      labels: [...unknownLabels],
      supplied: labelToChunk.size,
    });
  }

  // Zero usable blocks is a grounding failure the caller retries with the
  // validator's complaints. Throwing here used to skip that retry and turn the
  // section into a placeholder on the first attempt.
  const resolved = resolveBlocks(parsed.blocks, labelToChunk);

  const provisional: DocumentSection = {
    id: plan.id,
    kind: plan.kind,
    title: plan.title,
    blocks: resolved.blocks,
    speakerNotes: parsed.speakerNotes || "",
    flagged: false,
    warnings: [],
  };

  return {
    section: {
      ...provisional,
      speakerNotes: provisional.speakerNotes || deterministicNotes(provisional, chunks),
    },
    openItems: parsed.openItems,
    droppedBlocks: resolved.dropped,
    rawCharacters: raw.length,
  };
}

export { KIND_FOCUS };
