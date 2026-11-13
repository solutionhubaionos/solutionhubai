/**
 * Ingestion building blocks shared by the worker and the extraction spike:
 * chunk shaping, content hashing and batched embedding. Runs in Node/Bun; the
 * worker is the only caller of the provider.
 *
 * Phase 1: rows carry their kind and provenance, the text that gets embedded
 * carries file/slide/heading context that the stored content does not repeat,
 * and the hash covers the pipeline versions so an extractor change is never
 * mistaken for unchanged content.
 */
import { createHash } from "node:crypto";
import { chunkSections, type ChunkableSection, type ChunkKind } from "./chunk";
import { CHUNKER_VERSION, EMBEDDING_MODEL, EXTRACTOR_VERSION, MIN_CHUNK_CHARS } from "./config";

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
  chunk_kind: ChunkKind;
  metadata: Record<string, unknown>;
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
  return chunkSections(sections, { sourceFile, minChars: MIN_CHUNK_CHARS }).map((chunk) => ({
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    estimated_tokens: Math.max(chunk.estimatedTokens, 1),
    page: format === "pdf" ? chunk.pageOrSlide : null,
    slide: format === "pptx" ? chunk.pageOrSlide : null,
    heading: chunk.heading,
    embedding_model: EMBEDDING_MODEL,
    chunk_kind: chunk.kind,
    metadata: chunk.metadata,
  }));
}

/**
 * The text sent to the embedding model. It adds the file, slide and heading the
 * chunk belongs to, which is exactly the context a passage loses when it is
 * cut out of a deck; `content` stays clean for citations and answers.
 */
export function embeddingTexts(rows: readonly ChunkRow[], fileName: string): string[] {
  const document = fileName.replace(/\.[^.]+$/, "").trim();
  return rows.map((row) => {
    const where = [
      row.slide !== null ? `slide ${row.slide}` : row.page !== null ? `page ${row.page}` : null,
      row.heading,
      row.chunk_kind !== "text" ? row.chunk_kind : null,
    ].filter((part): part is string => Boolean(part));
    const prefix = where.length > 0 ? `${document} · ${where.join(" · ")}` : document;
    return `${prefix}\n\n${row.content}`;
  });
}

/**
 * Stable fingerprint of what was ingested. Includes the pipeline versions,
 * chunk kinds and provenance so a changed extractor, chunker or embedding model
 * always produces a different hash — otherwise a "text unchanged, keep the old
 * vectors" shortcut would silently keep stale chunks.
 */
export function hashIngest(rows: readonly ChunkRow[]): string {
  const hash = createHash("sha256");
  hash.update(`${EXTRACTOR_VERSION}\u0000${CHUNKER_VERSION}\u0000${EMBEDDING_MODEL}\u0000`);
  for (const row of rows) {
    hash.update(`${row.chunk_kind}\u0000${row.content}\u0000`);
  }
  return hash.digest("hex");
}
