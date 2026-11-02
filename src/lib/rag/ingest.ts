/**
 * Ingestion building blocks shared by the worker and tests: chunk shaping,
 * content hashing and batched embedding. Runs in Node/Bun; the worker is the
 * only caller of the provider.
 */
import { createHash } from "node:crypto";
import { chunkSections, type ChunkableSection } from "./chunk";
import { EMBEDDING_MODEL } from "./config";

export { embedTexts } from "./embeddings";
export type { EmbedOptions, EmbeddingResult } from "./embeddings";

export type ChunkRow = {
  chunk_index: number;
  content: string;
  estimated_tokens: number;
  page: number | null;
  slide: number | null;
  heading: string | null;
  embedding_model: string;
};

export type EmbeddedChunk = ChunkRow & { embedding: number[] };

/**
 * Turns extracted sections into database rows. PDF page numbers land in `page`,
 * slide numbers in `slide`; DOCX has neither and keeps only its heading.
 */
export function buildChunkRows(
  format: string,
  sections: readonly ChunkableSection[],
  sourceFile: string,
): ChunkRow[] {
  return chunkSections(sections, { sourceFile }).map((chunk) => ({
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    estimated_tokens: Math.max(chunk.estimatedTokens, 1),
    page: format === "pdf" ? chunk.pageOrSlide : null,
    slide: format === "pptx" ? chunk.pageOrSlide : null,
    heading: chunk.heading,
    embedding_model: EMBEDDING_MODEL,
  }));
}

/** Stable fingerprint of the extracted text, used to skip unchanged documents. */
export function hashChunkContents(contents: readonly string[]): string {
  return createHash("sha256").update(contents.join("\u0000")).digest("hex");
}
