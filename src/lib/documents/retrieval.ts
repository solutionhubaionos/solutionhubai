/**
 * Per-section retrieval. Every section runs its own hybrid search (vector + FTS,
 * RRF) through the existing search seam, then neighbouring chunks are pulled
 * when a passage looks cut off mid-table or mid-list.
 *
 * Chunks are assigned to sections in outline order and deduplicated, so one
 * case study cannot fill every section. Reuse only happens when a section has
 * no fresh evidence, and the trace records it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { isTitleOnlyChunk } from "../rag/chunk-quality";
import { searchLibraryChunks, type RetrievedChunk } from "../rag/search";
import type { ExportBrief } from "./types";
import type { SectionPlan } from "./outline";

export type Evidence = {
  plan: SectionPlan;
  chunks: RetrievedChunk[];
  topScore: number | null;
  weak: boolean;
  reused: string[];
  warnings: string[];
};

const PER_SECTION = 4;
const MAX_EVIDENCE_CHARS = 24_000;

const NUMBER_SIGNAL =
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|days?|weeks?|months?|years?|hours?|x|times|bn|fte)\b|[£$€]\s?\d|\breduced\b|\bincreased\b|\bcut\b|\bsaved\b|\bimproved\b/gi;

export function measurableSignals(text: string): number {
  return [...text.matchAll(NUMBER_SIGNAL)].length;
}

/** Proof sections rank evidence with numbers and outcomes above prose. */
export function rankForSection(
  chunks: readonly RetrievedChunk[],
  plan: SectionPlan,
): RetrievedChunk[] {
  if (!plan.wantsNumbers) return [...chunks];
  return [...chunks].sort((a, b) => {
    const numberDelta = measurableSignals(b.content) - measurableSignals(a.content);
    if (numberDelta !== 0) return numberDelta;
    return b.score - a.score;
  });
}

export function looksTruncated(content: string): boolean {
  const text = content.trim();
  if (text.length === 0) return false;
  if (text.includes("|") && !text.trimEnd().endsWith("|")) return true;
  if (/[:;,]$/.test(text)) return true;
  return !/[.!?)\]]$/.test(text) && text.split(/\s+/).length > 12;
}

function chunkWithScore(chunk: RetrievedChunk, score: number): RetrievedChunk {
  return { ...chunk, score };
}

/**
 * Pulls the chunk before and after a cut-off passage, but only from documents
 * already in the evidence set, so retrieval stays inside RLS and stays relevant.
 */
export async function expandNeighbours(
  client: SupabaseClient<Database>,
  chunks: readonly RetrievedChunk[],
): Promise<RetrievedChunk[]> {
  const extra: RetrievedChunk[] = [];
  const seen = new Set(chunks.map((chunk) => chunk.chunkId));

  for (const chunk of chunks) {
    if (!looksTruncated(chunk.content)) continue;
    const { data, error } = await client
      .from("document_chunks")
      .select("id, content_id, content, page, slide, heading, chunk_index")
      .eq("content_id", chunk.contentId)
      .order("chunk_index", { ascending: true });
    if (error || !data) continue;

    const rows = data as {
      id: string;
      content_id: string;
      content: string;
      page: number | null;
      slide: number | null;
      heading: string | null;
      chunk_index: number;
    }[];
    const index = rows.findIndex((row) => row.id === chunk.chunkId);
    if (index === -1) continue;

    for (const offset of [-1, 1]) {
      const row = rows[index + offset];
      if (!row || seen.has(row.id) || row.content.trim().length < 20) continue;
      seen.add(row.id);
      extra.push(
        chunkWithScore(
          {
            chunkId: row.id,
            contentId: row.content_id,
            content: row.content,
            page: row.page,
            slide: row.slide,
            heading: row.heading,
            title: chunk.title,
            fileName: chunk.fileName,
            filePath: chunk.filePath,
            industry: chunk.industry,
            customerName: chunk.customerName,
            vectorRank: null,
            textRank: null,
            score: chunk.score * 0.98,
          },
          chunk.score * 0.98,
        ),
      );
    }
  }

  return extra;
}

function isUsable(chunk: RetrievedChunk): boolean {
  const text = chunk.content.trim();
  if (text.length < 40) return false;
  if (isTitleOnlyChunk(chunk)) return false;
  return true;
}

function evidenceIsWeak(chunks: readonly RetrievedChunk[], topScore: number | null): boolean {
  if (chunks.length === 0) return true;
  if (topScore !== null && topScore < 0.004) return true;
  const chars = chunks.reduce((sum, chunk) => sum + chunk.content.trim().length, 0);
  return chars < 240;
}

export type GatherOptions = {
  client: SupabaseClient<Database>;
  brief: ExportBrief;
  plans: readonly SectionPlan[];
  industrySlug: string | null;
  embed: (query: string) => Promise<number[]>;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * One search per section, in parallel; then a sequential assignment pass so
 * dedupe follows the outline order deterministically.
 */
export async function gatherEvidence(options: GatherOptions): Promise<Evidence[]> {
  const log = options.log ?? (() => undefined);
  const scope = options.industrySlug ? { industry: options.industrySlug } : {};

  const batches = await Promise.all(
    options.plans.map(async (plan) => {
      const query = [plan.query, plan.goal, options.brief.client, options.brief.industry]
        .filter((value): value is string => Boolean(value))
        .join(". ")
        .slice(0, 500);
      try {
        const chunks = await searchLibraryChunks(
          options.client,
          query,
          scope,
          PER_SECTION,
          options.embed,
        );
        log("section retrieval", {
          section: plan.id,
          query,
          results: chunks.length,
          topScore: chunks[0]?.score ?? null,
        });
        return { plan, query, chunks, error: null as string | null };
      } catch (error) {
        log("section retrieval failed", { section: plan.id, error: String(error) });
        return { plan, query, chunks: [] as RetrievedChunk[], error: String(error) };
      }
    }),
  );

  const used = new Set<string>();
  const evidence: Evidence[] = [];

  for (const batch of batches) {
    const warnings: string[] = [];
    if (batch.error) warnings.push("Retrieval failed for this section.");

    let candidates = rankForSection(batch.chunks.filter(isUsable), batch.plan);

    if (batch.plan.wantsNumbers && candidates.length > 1) {
      const withNumbers = candidates.filter((chunk) => measurableSignals(chunk.content) > 0);
      if (withNumbers.length > 0) candidates = withNumbers;
    }

    const truncated = candidates.filter((chunk) => looksTruncated(chunk.content));
    if (truncated.length > 0) {
      try {
        const neighbours = await expandNeighbours(options.client, truncated.slice(0, 2));
        if (neighbours.length > 0) candidates = [...candidates, ...neighbours];
      } catch (error) {
        log("neighbour expansion failed", { section: batch.plan.id, error: String(error) });
      }
    }

    // A passage is used by one section only. If nothing fresh remains the
    // section is marked for completion instead of repeating an earlier point.
    const chosen = candidates.filter((chunk) => !used.has(chunk.chunkId)).slice(0, PER_SECTION);
    if (chosen.length === 0) {
      warnings.push("No unused library evidence remains for this section.");
    }

    let total = 0;
    const limited: RetrievedChunk[] = [];
    for (const chunk of chosen) {
      if (total + chunk.content.length > MAX_EVIDENCE_CHARS) break;
      limited.push(chunk);
      total += chunk.content.length;
    }

    limited.forEach((chunk) => used.add(chunk.chunkId));
    const topScore = limited[0]?.score ?? null;
    const weak = evidenceIsWeak(limited, topScore);
    if (weak) warnings.push("Not enough library evidence to write this section.");

    evidence.push({
      plan: batch.plan,
      chunks: limited,
      topScore,
      weak,
      reused: [],
      warnings,
    });
  }

  return evidence;
}

/** Test helper: build evidence without a database. */
export function evidenceFromChunks(plan: SectionPlan, chunks: readonly RetrievedChunk[]): Evidence {
  const limited = [...chunks].slice(0, PER_SECTION);
  const topScore = limited[0]?.score ?? null;
  return {
    plan,
    chunks: limited,
    topScore,
    weak: evidenceIsWeak(limited, topScore),
    reused: [],
    warnings: [],
  };
}
