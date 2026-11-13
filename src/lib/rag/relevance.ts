/**
 * Relevance control over fused retrieval results. The database returns a fixed
 * top-N regardless of whether anything is relevant; this module decides what is
 * actually evidence for this question.
 *
 * Order of business: drop other-customer noise when an entity was resolved,
 * apply a score floor relative to the best hit, push title-only slides out of
 * the top slots, and cap repeats from one deck or one slide. Bounds are kept so
 * a thin query returns few sources instead of padding to a fixed 8.
 */
import {
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CHUNKS_PER_SLIDE,
  RELEVANCE_SCORE_RATIO,
  RETRIEVAL_MAX_K,
  RETRIEVAL_MIN_K,
} from "./config";
import { isTitleOnlyChunk } from "./chunk-quality";
import { normalizeEntityKey } from "./entities";
import type { RetrievedChunk } from "./search";

export type SelectionOptions = {
  /**
   * Normalized spellings of the customer this question resolved to (canonical
   * plus aliases), so a chunk whose metadata carries an older spelling of the
   * same customer is not mistaken for another customer.
   */
  entityKeys?: readonly string[];
  /** Comparative questions must keep other customers' passages. */
  comparative?: boolean;
  minK?: number;
  maxK?: number;
  scoreRatio?: number;
};

/** One slide region can legitimately split into several chunks; two is enough. */
function slideKey(chunk: RetrievedChunk): string {
  const place = chunk.slide ?? chunk.page ?? "none";
  return `${chunk.contentId}:${place}`;
}

/**
 * True when the chunk's document belongs to a different customer than the one
 * the question resolved to. Industry-wide documents (no customer) always pass.
 */
function belongsToOtherCustomer(chunk: RetrievedChunk, entityKeys: ReadonlySet<string>): boolean {
  if (!chunk.customerName) return false;
  return !entityKeys.has(normalizeEntityKey(chunk.customerName));
}

export function selectRelevantChunks(
  chunks: readonly RetrievedChunk[],
  options: SelectionOptions = {},
): RetrievedChunk[] {
  const minK = Math.max(1, options.minK ?? RETRIEVAL_MIN_K);
  const maxK = Math.max(minK, options.maxK ?? RETRIEVAL_MAX_K);
  const scoreRatio = options.scoreRatio ?? RELEVANCE_SCORE_RATIO;

  // Dedupe by chunk id (overlapping scopes can return the same passage twice).
  const unique = new Map<string, RetrievedChunk>();
  for (const chunk of chunks) {
    const existing = unique.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) unique.set(chunk.chunkId, chunk);
  }
  const ranked = [...unique.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];

  const entityKeys = new Set(
    (options.entityKeys ?? []).map((key) => normalizeEntityKey(key)).filter(Boolean),
  );
  const scoped =
    entityKeys.size > 0 && !options.comparative
      ? ranked.filter((chunk) => !belongsToOtherCustomer(chunk, entityKeys))
      : ranked;
  const pool = scoped.length > 0 ? scoped : ranked;

  const bestScore = pool[0]?.score ?? 0;
  const floor = bestScore > 0 ? bestScore * scoreRatio : 0;
  const aboveFloor = pool.filter((chunk) => chunk.score >= floor);

  // Title-only slides are never evidence next to real content; they are only
  // useful as a label for a document that already earned a slot.
  const substantive = aboveFloor.filter((chunk) => !isTitleOnlyChunk(chunk));
  const titleOnly = aboveFloor.filter((chunk) => isTitleOnlyChunk(chunk));
  const matchedDocuments = new Set(substantive.map((chunk) => chunk.contentId));

  const selected: RetrievedChunk[] = [];
  const perDocument = new Map<string, number>();
  const perSlide = new Map<string, number>();
  const deferred: RetrievedChunk[] = [];

  const tryPush = (chunk: RetrievedChunk, countRepeats: boolean): boolean => {
    if (selected.length >= maxK) return false;
    const docs = perDocument.get(chunk.contentId) ?? 0;
    if (countRepeats && docs >= MAX_CHUNKS_PER_DOCUMENT) {
      deferred.push(chunk);
      return false;
    }
    const slide = slideKey(chunk);
    const slides = perSlide.get(slide) ?? 0;
    if (countRepeats && slides >= MAX_CHUNKS_PER_SLIDE) {
      deferred.push(chunk);
      return false;
    }
    selected.push(chunk);
    perDocument.set(chunk.contentId, docs + 1);
    perSlide.set(slide, slides + 1);
    return true;
  };

  for (const chunk of substantive) tryPush(chunk, true);

  // A thin result should still reach the minimum when the pool can support it.
  if (selected.length < minK) {
    for (const chunk of substantive) {
      if (selected.length >= minK) break;
      if (!selected.includes(chunk)) tryPush(chunk, false);
    }
  }
  if (selected.length < minK) {
    for (const chunk of deferred) {
      if (selected.length >= minK) break;
      if (!selected.includes(chunk) && !isTitleOnlyChunk(chunk)) tryPush(chunk, false);
    }
  }

  // One title-only passage, at the end, and only for a document already used.
  if (selected.length < maxK) {
    const anchor = titleOnly.find(
      (chunk) => selected.length === 0 || matchedDocuments.has(chunk.contentId),
    );
    if (anchor && !selected.includes(anchor)) selected.push(anchor);
  }

  return selected;
}
