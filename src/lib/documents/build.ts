/**
 * Export orchestrator: brief from the conversation, the confirmed slide plan as
 * the contract, one evidence pass shared by every slide, ONE deck call, ONE
 * verification call, then a gate that refuses only a document with no evidence
 * or fewer than four usable slides.
 *
 * The trace records what the brief said, the queries the evidence pass used and
 * the chunk ids behind each slide, so every claim can be audited.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { embedQuery } from "../rag/embeddings";
import type { RetrievedChunk } from "../rag/search";
import { buildExportBrief, resolveConversationParties, type ExportHistoryMessage } from "./brief";
import { buildAssumptionModel } from "./assumptions";
import { verifyDeckClaims } from "./verify";
import { gatherDeckEvidence } from "./retrieval";
import { generateDeck } from "./deck";
import { normalizeDeck, fallbackSlide, assumptionTable } from "./slides";
import { mustIncludeItems, plansFromOutline, type SectionPlan } from "./outline";
import { sectionSourceIds } from "./generate";
import { sourceRecords, validateModel } from "./validate";
import { failureReasonOf } from "./provider";
import { coverDate } from "./theme";
import type {
  Block,
  DocumentBuildResult,
  SectionFailure,
  DocumentDraft,
  DocumentGate,
  DocumentModel,
  DocumentSection,
  DocumentTraceSection,
  SourceRecord,
} from "./types";

export type BuildDocumentInput = {
  draft: DocumentDraft;
  history: readonly ExportHistoryMessage[];
  client: SupabaseClient<Database>;
  provider: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch };
  now?: Date;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * Maps a raw failure to the one reason the gate and the UI report. Provider
 * errors and schema errors used to collapse into "generation did not produce
 * usable content", which told the user nothing actionable.
 */
export function classifySectionFailure(error: unknown): SectionFailure {
  return failureReasonOf(error);
}

/** Metadata for the Sources section; best-effort, RLS still applies. */
async function enrichSources(
  client: SupabaseClient<Database>,
  records: SourceRecord[],
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<SourceRecord[]> {
  const contentIds = [...new Set(records.map((record) => record.contentId))];
  if (contentIds.length === 0) return records;
  try {
    const { data, error } = await client
      .from("content_items")
      .select("id, content_type, created_at")
      .in("id", contentIds);
    if (error || !data) throw error ?? new Error("no content rows returned");
    const rows = data as { id: string; content_type: string; created_at: string }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return records.map((record) => {
      const row = byId.get(record.contentId);
      if (!row) return record;
      return {
        ...record,
        contentType: row.content_type,
        date: row.created_at.slice(0, 10),
      };
    });
  } catch (error) {
    log("source metadata unavailable", { error: String(error) });
    return records;
  }
}

function toSourceRecord(chunk: RetrievedChunk): SourceRecord {
  return {
    chunkId: chunk.chunkId,
    contentId: chunk.contentId,
    title: chunk.title,
    fileName: chunk.fileName,
    filePath: chunk.filePath,
    industry: chunk.industry,
    customerName: chunk.customerName,
    page: chunk.page,
    slide: chunk.slide,
    heading: chunk.heading,
  };
}

/**
 * Deck gate: only zero evidence or fewer than four usable slides blocks. A
 * missing or thin slide becomes an Open item, never a reason to refuse the file.
 */
function deckGateFor(
  plans: readonly SectionPlan[],
  sections: readonly DocumentSection[],
  chunks: readonly RetrievedChunk[],
): DocumentGate {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const gateSections = plans.map((plan) => {
    const section = byId.get(plan.id);
    const passages = section ? sectionSourceIds(section).length : 0;
    const generated = Boolean(section && section.blocks.some((block) => block.type !== "heading"));
    const illustrative = Boolean(
      section?.blocks.some((block) => block.type === "chart" && block.illustrative),
    );
    const reason: SectionFailure | null =
      chunks.length === 0
        ? "no_passages"
        : !section
          ? "schema_invalid"
          : passages === 0 && !illustrative
            ? "no_passages"
            : null;
    return {
      id: plan.id,
      title: section?.title ?? plan.title,
      passages,
      generated,
      reason,
      detail: !section ? "The deck returned no content for this slide." : null,
    };
  });
  const usable = sections.filter((section) =>
    section.blocks.some((block) => block.type !== "heading"),
  );
  const blocked = chunks.length === 0 || usable.length < 4;
  return {
    coverage: plans.length > 0 ? usable.length / plans.length : 0,
    blocked,
    sections: gateSections,
    message:
      chunks.length === 0
        ? "No library passages were found for this request, so no document was written."
        : blocked
          ? `Only ${usable.length} usable slides survived; at least four are needed to write this document.`
          : "",
  };
}

function assumptionSection(
  plan: SectionPlan,
  model: ReturnType<typeof buildAssumptionModel>,
): DocumentSection {
  const illustrative = plan.layout === "chart" || plan.kind === "economics";
  const blocks: Block[] = illustrative
    ? [
        { type: "chart", chart: model.chart, sources: [], illustrative: true },
        {
          type: "paragraph",
          text: "Illustrative — replace with actuals. These figures are computed from the declared planning assumptions, not from the library.",
          sources: [],
        },
      ]
    : [assumptionTable(model.rows)];
  return {
    id: plan.id,
    kind: plan.kind,
    title: plan.title,
    layout: plan.layout ?? (illustrative ? "chart" : "table"),
    blocks,
    speakerNotes:
      "The assumptions are planning defaults, computed in code and clearly labelled; confirm them with the client before sharing.",
    flagged: false,
    warnings: ["Computed from the labelled assumptions model, not from library passages."],
  };
}

export async function buildDocument(input: BuildDocumentInput): Promise<DocumentBuildResult> {
  const log = input.log ?? (() => undefined);
  const now = input.now ?? new Date();
  const brief = await buildExportBrief(input.draft, input.history, {
    ...input.provider,
    client: input.client,
    log,
  });

  // The confirmed outline is the plan. Nothing regenerates, reorders or pads it
  // at build time; titles, order and layouts were fixed on the confirm screen.
  const plans = plansFromOutline(input.draft, brief);

  // Entities are the union of the brief, the conversation resolver and the
  // wizard selection, so a party the brief missed still gets its own search.
  const conversationParties = await resolveConversationParties(
    input.client,
    input.history,
    input.draft,
  ).catch(() => []);
  const entityNames = [
    ...new Set(
      [
        ...conversationParties,
        ...(brief.partiesInvolved ?? []),
        ...(brief.keyEntities ?? []),
        ...(input.draft.client ? [input.draft.client] : []),
      ]
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  log("export entities union", { entities: entityNames });

  const evidence = await gatherDeckEvidence({
    client: input.client,
    brief,
    plans,
    entityNames,
    industrySlug: input.draft.industrySlug,
    history: input.history,
    embed: (query) => embedQuery(query, input.provider),
    log,
  });

  const chunksById = new Map<string, string>();
  const chunkMeta = new Map<string, SourceRecord>();
  for (const chunk of evidence.chunks) {
    chunksById.set(chunk.chunkId, chunk.content);
    chunkMeta.set(chunk.chunkId, toSourceRecord(chunk));
  }

  const include = mustIncludeItems(brief.request);
  const assumptionsNeeded =
    include.some((item) => item === "numbers" || item === "charts" || item === "assumptions") ||
    plans.some(
      (plan) => plan.kind === "assumptions" || plan.kind === "economics" || plan.layout === "chart",
    );
  const assumptions = assumptionsNeeded ? buildAssumptionModel() : null;

  let deckWarnings: string[] = [];
  let normalized: ReturnType<typeof normalizeDeck> = {
    sections: [],
    missing: [...plans],
    warnings: [],
  };

  if (evidence.chunks.length > 0) {
    const deck = await generateDeck(plans, brief, evidence.chunks, assumptions, {
      ...input.provider,
      log,
    });
    deckWarnings = deck.warnings;
    normalized = normalizeDeck(
      deck.rawSlides,
      plans,
      evidence.chunks,
      brief,
      new Set(assumptions?.values ?? []),
    );

    // At most one extra call, and only for slides the first call left empty.
    if (normalized.missing.length > 0) {
      const missingPlans = normalized.missing;
      try {
        const extra = await generateDeck(missingPlans, brief, evidence.chunks, assumptions, {
          ...input.provider,
          log,
        });
        const extraNormalized = normalizeDeck(
          extra.rawSlides,
          missingPlans,
          evidence.chunks,
          brief,
          new Set(assumptions?.values ?? []),
        );
        const byId = new Map(
          [...normalized.sections, ...extraNormalized.sections].map((section) => [
            section.id,
            section,
          ]),
        );
        normalized = {
          sections: [...byId.values()],
          missing: extraNormalized.missing,
          warnings: [...normalized.warnings, ...extraNormalized.warnings],
        };
        deckWarnings = [...deckWarnings, ...extra.warnings];
      } catch (error) {
        log("missing slide regeneration failed", {
          reason: failureReasonOf(error),
          error: String(error).slice(0, 240),
        });
      }
    }
  }

  const sectionById = new Map(normalized.sections.map((section) => [section.id, section]));
  // No evidence at all means no document: even the assumptions deck needs the
  // library to identify the parties and the offer. The gate refuses it below.
  if (evidence.chunks.length > 0) {
    for (const plan of normalized.missing) {
      const fallback =
        assumptions && (plan.kind === "assumptions" || plan.kind === "economics")
          ? assumptionSection(plan, assumptions)
          : fallbackSlide(plan, evidence.chunks);
      if (fallback) {
        sectionById.set(plan.id, fallback);
        deckWarnings.push(`Recovered "${plan.title}" from cited passages.`);
      } else {
        deckWarnings.push(`"${plan.title}" had no usable content and was left out.`);
      }
    }
  }

  const ordered = plans
    .map((plan) => sectionById.get(plan.id))
    .filter((section): section is DocumentSection => Boolean(section));

  const verification = await verifyDeckClaims(
    ordered,
    evidence.chunks,
    { ...input.provider, log },
    log,
  );
  const sections = verification.sections;

  const gate = deckGateFor(plans, sections, evidence.chunks);
  const openItems = [
    ...brief.openItems,
    ...(assumptions?.openItems ?? []),
    ...verification.unsupported.map((entry) => `Review: "${entry.claim}" on slide ${entry.slide}.`),
    // Slide-level normaliser warnings include "No passage cited" for any slide
    // the model wrote without a reference, so they reach the reader.
    ...normalized.warnings,
    ...evidence.warnings,
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  const dedupedOpenItems = [...new Set(openItems)].slice(0, 20);

  const records = sourceRecords(sections, chunksById, chunkMeta);
  const sources = await enrichSources(input.client, records, log);

  const warnings = [
    ...new Set([
      ...evidence.warnings,
      ...deckWarnings,
      ...normalized.warnings,
      ...verification.warnings,
      ...(gate.blocked ? [gate.message] : []),
    ]),
  ];

  const model: DocumentModel = {
    mode: input.draft.mode,
    format: input.draft.type,
    cover: {
      title: brief.documentTitle || input.draft.title,
      subtitle: input.draft.subtitle,
      client: brief.client,
      industry: brief.industry,
      date: coverDate(now),
      request: brief.request || input.draft.prompt,
    },
    sections,
    sources,
    openItems: dedupedOpenItems,
    warnings,
  };

  const final = validateModel(model, chunksById);
  if (final.errors.length > 0) {
    log("document validation warnings", { errors: final.errors.slice(0, 8) });
    model.warnings = [...model.warnings, ...final.errors.map((error) => `Validation: ${error}`)];
  }
  model.warnings = [...new Set([...model.warnings, ...final.warnings])];

  const traceSections: DocumentTraceSection[] = plans.map((plan) => {
    const section = sections.find((candidate) => candidate.id === plan.id);
    return {
      id: plan.id,
      kind: plan.kind,
      title: section?.title ?? plan.title,
      query: evidence.queries.join(" | "),
      chunkIds: section ? sectionSourceIds(section) : [],
      labels: [],
      topScore: evidence.chunks[0]?.score ?? null,
      weak: !section || sectionSourceIds(section).length === 0,
      warnings: section?.warnings ?? [],
    };
  });

  const usedChunkIds = [...new Set(traceSections.flatMap((section) => section.chunkIds))];

  log("document built", {
    mode: input.draft.mode,
    format: input.draft.type,
    slides: sections.length,
    confirmedSlides: plans.length,
    flagged: sections.filter((section) => section.flagged).length,
    coverage: Number(gate.coverage.toFixed(2)),
    blocked: gate.blocked,
    chunks: usedChunkIds.length,
    openItems: dedupedOpenItems.length,
    llm_calls: 3 + (normalized.missing.length > 0 ? 1 : 0),
  });

  return {
    model,
    trace: {
      generatedAt: now.toISOString(),
      brief,
      sections: traceSections,
      usedChunkIds,
      openItems: dedupedOpenItems,
      warnings: model.warnings,
    },
    usedFallback: normalized.missing.length > 0,
    gate,
  };
}
