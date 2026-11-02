/**
 * Pure, runtime-agnostic chunker shared by the extraction spike and the
 * ingestion Edge Function (Deno). No imports on purpose: keep it portable.
 */

export type ChunkableSection = {
  text: string;
  pageOrSlide?: number | null;
  heading?: string | null;
};

export type Chunk = {
  chunkIndex: number;
  content: string;
  pageOrSlide: number | null;
  heading: string | null;
  sourceFile: string;
  estimatedTokens: number;
};

export type ChunkOptions = {
  sourceFile: string;
  targetTokens?: number;
  overlapTokens?: number;
};

// Approximate token count. Good enough for chunk sizing; embeddings do the rest.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / CHARS_PER_TOKEN);
}

/**
 * Splits sections (pages, slides or heading blocks) into ~targetTokens chunks.
 * Sections are never merged, so page/slide numbers stay accurate. Long sections
 * are split on sentence/line boundaries with ~overlapTokens of repeated text.
 */
export function chunkSections(
  sections: readonly ChunkableSection[],
  options: ChunkOptions,
): Chunk[] {
  const targetChars = Math.max(1, Math.round((options.targetTokens ?? 600) * CHARS_PER_TOKEN));
  const overlapChars = Math.max(0, Math.round((options.overlapTokens ?? 80) * CHARS_PER_TOKEN));
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const text = normalizeText(section.text);
    if (!text) continue;

    const heading = section.heading?.trim() || null;
    const pageOrSlide = section.pageOrSlide ?? null;
    const units = splitUnits(text).flatMap((unit) =>
      splitOversizedUnit(unit, targetChars, overlapChars),
    );

    let current: string[] = [];
    let currentChars = 0;

    const flush = () => {
      const body = current.join("\n").trim();
      if (!body) {
        current = [];
        currentChars = 0;
        return;
      }
      const content = heading ? `${heading}\n\n${body}` : body;
      chunks.push({
        chunkIndex: chunks.length,
        content,
        pageOrSlide,
        heading,
        sourceFile: options.sourceFile,
        estimatedTokens: estimateTokens(content),
      });
      current = [];
      currentChars = 0;
    };

    for (const unit of units) {
      const separator = current.length > 0 ? 1 : 0;
      if (current.length > 0 && currentChars + separator + unit.length > targetChars) {
        // Seed the next chunk with the tail of this one so context carries over.
        const seed = trailingText(current, overlapChars);
        flush();
        if (seed && seed.length + 1 + unit.length <= targetChars) {
          current = [seed];
          currentChars = seed.length;
        }
      }
      const joiner = current.length > 0 ? 1 : 0;
      current.push(unit);
      currentChars += joiner + unit.length;
    }

    flush();
  }

  return chunks;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitUnits(text: string): string[] {
  return text
    .replace(/([.!?])\s+|\n+/g, (_match: string, punctuation?: string) =>
      punctuation ? `${punctuation}\n` : "\n",
    )
    .split("\n")
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function splitOversizedUnit(unit: string, targetChars: number, overlapChars: number): string[] {
  if (unit.length <= targetChars) return [unit];

  // Leave room for the overlap seed (and its newline) the caller adds.
  const pieceLimit = Math.max(1, targetChars - overlapChars - 1);
  const words = unit.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const word of words) {
    const separator = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentChars + separator + word.length > pieceLimit) {
      pieces.push(current.join(" "));
      current = [];
      currentChars = 0;
    }
    const joiner = current.length > 0 ? 1 : 0;
    current.push(word);
    currentChars += joiner + word.length;
  }
  if (current.length > 0) pieces.push(current.join(" "));
  return pieces;
}

function trailingText(units: readonly string[], maxChars: number): string {
  if (maxChars <= 0) return "";
  const joined = units.join("\n");
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(joined.length - maxChars);
  const firstSpace = cut.search(/\s/);
  return (firstSpace === -1 ? cut : cut.slice(firstSpace + 1)).trim();
}
