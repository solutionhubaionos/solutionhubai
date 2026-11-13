/**
 * Export orchestrator: brief from chat history, outline from the brief, one
 * retrieval per section, one grounded completion per section, validation with a
 * single retry, then a source-enriched model for the renderers.
 *
 * The trace records what the brief said, the query each section used and the
 * chunk ids behind it, so every claim can be audited and a section regenerated.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { embedQuery } from "../rag/embeddings";
import type { RetrievedChunk } from "../rag/search";
import { buildExportBrief, type ExportHistoryMessage } from "./brief";
import { gatherEvidence, type Evidence } from "./retrieval";
import { planOutline, type SectionPlan } from "./outline";
import { generateSection, sectionSourceIds } from "./generate";
import { sanitizeSection, sourceRecords, validateModel, validateSection } from "./validate";
import { coverDate } from "./theme";
import type {
  Block,
  DocumentBuildResult,
  DocumentDraft,
  DocumentModel,
  DocumentSection,
  DocumentTraceSection,
  ExportBrief,
  SourceRecord,
} from "./types";

export const DOC_SECTION_CONCURRENCY = 3;

export type BuildDocumentInput = {
  draft: DocumentDraft;
  history: readonly ExportHistoryMessage[];
  client: SupabaseClient<Database>;
  provider: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch };
  now?: Date;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

function placeholderSection(plan: SectionPlan): DocumentSection {
  const reason =
    plan.kind === "pricing"
      ? "No pricing or commercial figures appear in the library passages for this request."
      : "The library did not return enough relevant evidence to write this section.";
  const block: Block = {
    type: "callout",
    tone: "warning",
    text: `[To be confirmed] ${reason} Add the missing source material before sending this document.`,
    sources: [],
  };
  return {
    id: plan.id,
    kind: plan.kind,
    title: plan.title,
    blocks: [block],
    speakerNotes:
      "This slide is intentionally marked for completion rather than filled with unsupported content.",
    flagged: true,
    warnings: [reason],
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
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

function uniqueTitles(sections: DocumentSection[]): DocumentSection[] {
  const used = new Set<string>();
  return sections.map((section, index) => {
    let title = section.title;
    if (used.has(title.toLowerCase())) title = `${title} (${index + 1})`;
    used.add(title.toLowerCase());
    return title === section.title ? section : { ...section, title };
  });
}

type BuiltSection = {
  section: DocumentSection;
  openItems: string[];
  warnings: string[];
  usedFallback: boolean;
  chunkMeta: SourceRecord[];
};

async function buildSection(
  evidence: Evidence,
  brief: ExportBrief,
  chunksById: ReadonlyMap<string, string>,
  provider: BuildDocumentInput["provider"],
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<BuiltSection> {
  const plan = evidence.plan;
  if (evidence.weak) {
    return {
      section: placeholderSection(plan),
      openItems: [`${plan.title}: no usable library evidence`],
      warnings: evidence.warnings,
      usedFallback: true,
      chunkMeta: evidence.chunks.map(toSourceRecord),
    };
  }

  try {
    let generated = await generateSection(plan, brief, evidence.chunks, provider);
    let check = validateSection(plan, generated.section, chunksById, brief);

    if (check.errors.length > 0) {
      log("section validation retry", {
        section: plan.id,
        errors: check.errors.slice(0, 6),
      });
      generated = await generateSection(plan, brief, evidence.chunks, provider, check.errors);
      check = validateSection(plan, generated.section, chunksById, brief);
    }

    const openItems = [...generated.openItems];
    if (check.conflicts.length > 0) {
      openItems.push(
        ...check.conflicts.map(
          (value) =>
            `Chat figure “${value}” is not corroborated by the library; source figures were used.`,
        ),
      );
    }

    let section = generated.section;
    let warnings = evidence.warnings;
    if (check.errors.length > 0) {
      const sanitized = sanitizeSection(plan, section, chunksById, brief);
      section = sanitized.section;
      warnings = [...warnings, ...check.errors.slice(0, 5).map((error) => `Validation: ${error}`)];
      log("section sanitized", {
        section: plan.id,
        removedBlocks: sanitized.removed,
        remaining: section.blocks.length,
      });
      if (sanitized.removed > 0) {
        openItems.push(`${plan.title}: some unsupported content was removed by validation.`);
      }
    }

    return {
      section: { ...section, warnings },
      openItems: openItems.slice(0, 5),
      warnings,
      usedFallback: section.flagged,
      chunkMeta: evidence.chunks.map(toSourceRecord),
    };
  } catch (error) {
    log("section generation failed", { section: plan.id, error: String(error) });
    return {
      section: placeholderSection(plan),
      openItems: [`${plan.title}: generation failed and needs regeneration`],
      warnings: [`Generation failed: ${String(error).slice(0, 180)}`],
      usedFallback: true,
      chunkMeta: evidence.chunks.map(toSourceRecord),
    };
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

export async function buildDocument(input: BuildDocumentInput): Promise<DocumentBuildResult> {
  const log = input.log ?? (() => undefined);
  const now = input.now ?? new Date();
  const brief = await buildExportBrief(input.draft, input.history, {
    ...input.provider,
    log,
  });

  const outline = await planOutline(brief, input.draft, { ...input.provider, log });
  const plans = outline.plans;

  const evidence = await gatherEvidence({
    client: input.client,
    brief,
    plans,
    industrySlug: input.draft.industrySlug,
    embed: (query) => embedQuery(query, input.provider),
    log,
  });

  const chunksById = new Map<string, string>();
  const chunkMeta = new Map<string, SourceRecord>();
  for (const item of evidence) {
    for (const chunk of item.chunks) {
      chunksById.set(chunk.chunkId, chunk.content);
      chunkMeta.set(chunk.chunkId, toSourceRecord(chunk));
    }
  }

  const built = await mapLimit(evidence, DOC_SECTION_CONCURRENCY, (item) =>
    buildSection(item, brief, chunksById, input.provider, log),
  );

  const sections = uniqueTitles(built.map((item) => item.section));
  const openItems = [...brief.openItems, ...built.flatMap((item) => item.openItems)]
    .map((item) => item.trim())
    .filter(Boolean);
  const dedupedOpenItems = [...new Set(openItems)].slice(0, 20);

  const records = sourceRecords(sections, chunksById, chunkMeta);
  const sources = await enrichSources(input.client, records, log);

  const warnings = [...new Set(built.flatMap((item) => item.warnings))];

  const model: DocumentModel = {
    mode: input.draft.mode,
    format: input.draft.type,
    cover: {
      title: input.draft.title,
      subtitle: input.draft.subtitle,
      client: brief.client,
      industry: brief.industry,
      date: coverDate(now),
      request: input.draft.prompt || brief.request,
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

  const traceSections: DocumentTraceSection[] = plans.map((plan, index) => {
    const item = evidence[index];
    const section = sections[index];
    return {
      id: plan.id,
      kind: plan.kind,
      title: section?.title ?? plan.title,
      query: item?.chunks[0] ? plan.query : plan.query,
      chunkIds: section
        ? sectionSourceIds(section)
        : (item?.chunks.map((chunk) => chunk.chunkId) ?? []),
      labels: (item?.chunks ?? []).map((_, chunkIndex) => `S${chunkIndex + 1}`),
      topScore: item?.topScore ?? null,
      weak: item?.weak ?? true,
      warnings: section?.warnings ?? [],
    };
  });

  const usedChunkIds = [...new Set(traceSections.flatMap((section) => section.chunkIds))];

  log("document built", {
    mode: input.draft.mode,
    format: input.draft.type,
    sections: sections.length,
    flagged: sections.filter((section) => section.flagged).length,
    chunks: usedChunkIds.length,
    openItems: dedupedOpenItems.length,
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
    usedFallback:
      outline.usedFallback ||
      built.some((item) => item.usedFallback) ||
      sections.every((section) => section.flagged),
  };
}
