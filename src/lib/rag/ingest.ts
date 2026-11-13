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
import { estimateTokens } from "./chunk";

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

/** Provenance every chunk should carry, whether it is embedded or searched. */
export type ChunkContext = {
  title?: string | null | undefined;
  customerName?: string | null | undefined;
  industry?: string | null | undefined;
};

/**
 * The contextual header stored with a chunk: "Customer: X | Industry: Y |
 * Document: Z | Slide: 4". It goes into `content`, which means the generated
 * `tsv` indexes it for full-text search, and the same text is embedded. A
 * passage therefore knows whose deck it came from even when the body never
 * repeats the customer name.
 */
export function chunkContextHeader(
  where: { page?: number | null | undefined; slide?: number | null | undefined },
  context: ChunkContext = {},
): string {
  const document = (context.title ?? "").trim();
  // Without any provenance, a page/slide label alone duplicates a column the
  // chunk already carries; leave the stored text untouched.
  if (!document && !context.customerName && !context.industry) return "";
  const place =
    where.slide !== null && where.slide !== undefined
      ? `Slide: ${where.slide}`
      : where.page !== null && where.page !== undefined
        ? `Page: ${where.page}`
        : null;
  return [
    context.customerName ? `Customer: ${context.customerName.trim()}` : null,
    context.industry ? `Industry: ${context.industry.trim()}` : null,
    document ? `Document: ${document}` : null,
    place,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" | ");
}

/**
 * Turns extracted sections into database rows. PDF page numbers land in `page`,
 * slide numbers in `slide`; DOCX has neither and keeps only its heading.
 * When provenance is known it is prepended, so both the embedding and the
 * full-text index carry customer, industry and document context.
 */
export function buildChunkRows(
  format: string,
  sections: readonly ChunkableSection[],
  sourceFile: string,
  context: ChunkContext = {},
): ChunkRow[] {
  return chunkSections(sections, { sourceFile, minChars: MIN_CHUNK_CHARS }).map((chunk) => {
    const page = format === "pdf" ? chunk.pageOrSlide : null;
    const slide = format === "pptx" ? chunk.pageOrSlide : null;
    const header = chunkContextHeader({ page, slide }, context);
    const content = header ? `${header}\n\n${chunk.content}` : chunk.content;
    return {
      chunk_index: chunk.chunkIndex,
      content,
      estimated_tokens: Math.max(estimateTokens(content), 1),
      page,
      slide,
      heading: chunk.heading,
      embedding_model: EMBEDDING_MODEL,
      chunk_kind: chunk.kind,
      metadata: chunk.metadata,
    };
  });
}

/**
 * The text sent to the embedding model. It adds the file, slide and heading the
 * chunk belongs to, which is exactly the context a passage loses when it is
 * cut out of a deck; `content` stays clean for citations and answers.
 */
export function embeddingTexts(rows: readonly ChunkRow[], fileName: string): string[] {
  const document = fileName.replace(/\.[^.]+$/, "").trim();
  return rows.map((row) => {
    // A row built with a contextual header already carries document and place;
    // prefixing the file name again would only dilute the vector.
    if (/^(?:Customer|Industry|Document):/m.test(row.content)) return row.content;
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
