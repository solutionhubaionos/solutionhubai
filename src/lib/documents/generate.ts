/**
 * Step 3: one section at a time. The model receives the export brief, the
 * section goal and the passages retrieved for that section, and returns strict
 * JSON blocks with source labels. Prose is never accepted without a source.
 */
import { sectionOutputSchema, blockLabels, resolveBlocks } from "./blocks";
import type { Block, DocumentSection, ExportBrief } from "./types";
import type { SectionPlan } from "./outline";
import type { RetrievedChunk } from "../rag/search";
import { completeText, type ProviderOptions } from "./provider";

export type SectionGeneration = {
  section: DocumentSection;
  openItems: string[];
  droppedBlocks: number;
  rawCharacters: number;
};

const SECTION_SYSTEM = [
  "You write one section of a client-ready sales document for Solution Hub.",
  "Return JSON only, no markdown fences.",
  'Shape: {"blocks":[block...],"speakerNotes":string,"openItems":string[]}.',
  "Allowed blocks: heading, paragraph, bullet_list, numbered_list, table, metrics, callout, quote, timeline, comparison.",
  "Every factual block must carry sources: short labels (S1, S2) supplied with the passages. Metrics items and quotes need their own source. Headings need no source.",
  "Use ONLY the numbered passages and the brief. Never invent clients, numbers, outcomes, dates, quotes or product names.",
  "Specific beats vague: use a figure with its unit, baseline and timeframe only when a passage states it. If it does not, omit the claim.",
  'If the passages cannot support the section, write one callout with text starting "[To be confirmed]" and list the gap in openItems. Do not pad.',
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

function userPrompt(
  plan: SectionPlan,
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  previousErrors: readonly string[],
): string {
  const modeRules =
    brief.mode === "proposal"
      ? "Mode: proposal. Write complete, substantive prose. Headings only if this section has two or more distinct subsections."
      : "Mode: pitch deck slide. One idea only, a headline that states the takeaway, at most 5 short bullets (under 14 words each). Prefer a metrics or table block when data exists. Speaker notes carry the detail.";

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
    "- Every paragraph, list, table, callout and metric cites the S-labels that support it.",
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

/**
 * Generates one section; throws on unparseable output so the caller can retry
 * with the validator's complaints.
 */
export async function generateSection(
  plan: SectionPlan,
  brief: ExportBrief,
  chunks: readonly RetrievedChunk[],
  options: ProviderOptions,
  previousErrors: readonly string[] = [],
): Promise<SectionGeneration> {
  const raw = await completeText(
    [
      { role: "system", content: SECTION_SYSTEM },
      { role: "user", content: userPrompt(plan, brief, chunks, previousErrors) },
    ],
    options,
    brief.mode === "proposal" ? 2300 : 1500,
    0.25,
  );

  let parsed: ReturnType<typeof sectionOutputSchema.parse>;
  try {
    parsed = sectionOutputSchema.parse(
      JSON.parse(
        raw
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```$/, ""),
      ),
    );
  } catch (error) {
    // A fenced or chatty response still gets one chance via the tolerant reader.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("section response contained no JSON");
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new Error(`section response was not valid JSON: ${String(error)}`);
    }
    parsed = sectionOutputSchema.parse(value);
  }

  const labelToChunk = new Map<string, string>(
    chunks.map((chunk, index) => [`S${index + 1}`, chunk.chunkId]),
  );

  // Reject labels the server did not issue rather than letting them through.
  const unknownLabels = new Set<string>();
  for (const block of parsed.blocks) {
    for (const label of blockLabels(block)) {
      if (!labelToChunk.has(label)) unknownLabels.add(label);
    }
  }
  if (unknownLabels.size > 0) {
    throw new Error(`section cited unknown sources: ${[...unknownLabels].join(", ")}`);
  }

  const resolved = resolveBlocks(parsed.blocks, labelToChunk);
  if (resolved.blocks.length === 0) throw new Error("section cited no usable blocks");

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
