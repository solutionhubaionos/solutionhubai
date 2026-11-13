/**
 * Pure, runtime-agnostic chunker shared by the extraction spike and the
 * ingestion worker. No imports on purpose: keep it portable.
 *
 * Phase 1: chunks carry a kind. Prose is split on sentence boundaries that
 * respect abbreviations, tables keep their header with every piece, and
 * headings are no longer pasted into every chunk body (the heading column and
 * the embed-time context prefix carry it instead).
 */

export type ChunkKind = "text" | "table" | "figure";

export type ChunkableSection = {
  text: string;
  pageOrSlide?: number | null;
  heading?: string | null;
  kind?: ChunkKind;
  metadata?: Record<string, unknown>;
};

export type Chunk = {
  chunkIndex: number;
  content: string;
  pageOrSlide: number | null;
  heading: string | null;
  sourceFile: string;
  estimatedTokens: number;
  kind: ChunkKind;
  metadata: Record<string, unknown>;
};

export type ChunkOptions = {
  sourceFile: string;
  targetTokens?: number;
  overlapTokens?: number;
  /** Chunks smaller than this are merged into their predecessor. */
  minChars?: number;
};

// Approximate token count. Good enough for chunk sizing; embeddings do the rest.
const CHARS_PER_TOKEN = 4;
const DEFAULT_MIN_CHARS = 40;

export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / CHARS_PER_TOKEN);
}

type Base = Omit<Chunk, "chunkIndex" | "content" | "estimatedTokens">;
type Limits = { targetChars: number; overlapChars: number; minChars: number };

/**
 * Splits sections (pages, slides or heading blocks) into ~targetTokens chunks.
 * Sections are never merged, so page/slide numbers stay accurate. Prose is
 * split on sentence/line boundaries with ~overlapTokens of repeated text;
 * tabular text is split by row with the header repeated in every piece.
 */
export function chunkSections(
  sections: readonly ChunkableSection[],
  options: ChunkOptions,
): Chunk[] {
  const limits: Limits = {
    targetChars: Math.max(1, Math.round((options.targetTokens ?? 600) * CHARS_PER_TOKEN)),
    overlapChars: Math.max(0, Math.round((options.overlapTokens ?? 80) * CHARS_PER_TOKEN)),
    minChars: Math.max(0, options.minChars ?? DEFAULT_MIN_CHARS),
  };
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const text = normalizeText(section.text);
    if (!text) continue;

    const base: Base = {
      pageOrSlide: section.pageOrSlide ?? null,
      heading: section.heading?.trim() || null,
      sourceFile: options.sourceFile,
      kind: section.kind ?? "text",
      metadata: section.metadata ?? {},
    };

    if (base.kind === "text") pushProse(text, base, limits, chunks);
    else pushRows(text, base, limits, chunks);
  }

  return chunks;
}

function push(chunks: Chunk[], base: Base, body: string): void {
  chunks.push({
    ...base,
    chunkIndex: chunks.length,
    content: body,
    estimatedTokens: Math.max(estimateTokens(body), 1),
  });
}

function pushProse(text: string, base: Base, limits: Limits, chunks: Chunk[]): void {
  const units = splitUnits(text).flatMap((unit) =>
    splitOversizedUnit(unit, limits.targetChars, limits.overlapChars),
  );
  const firstIndex = chunks.length;
  let current: string[] = [];
  let currentChars = 0;

  const flush = () => {
    const body = current.join("\n").trim();
    current = [];
    currentChars = 0;
    if (!body) return;

    // A stub ("Notes:", a stray bullet) is noise as its own vector; append it
    // to the previous chunk of the same section instead of embedding it alone.
    if (body.length < limits.minChars && chunks.length > firstIndex) {
      const previous = chunks[chunks.length - 1]!;
      previous.content = `${previous.content}\n${body}`;
      previous.estimatedTokens = Math.max(estimateTokens(previous.content), 1);
      return;
    }
    push(chunks, base, body);
  };

  for (const unit of units) {
    const separator = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentChars + separator + unit.length > limits.targetChars) {
      // Seed the next chunk with the tail of this one so context carries over.
      const seed = trailingText(current, limits.overlapChars);
      flush();
      if (seed && seed.length + 1 + unit.length <= limits.targetChars) {
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

/**
 * Tables and figures are line-oriented: a row must never be cut in half, and a
 * continuation chunk restates the header row so its values stay interpretable
 * when the chunk is retrieved on its own.
 */
function pushRows(text: string, base: Base, limits: Limits, chunks: Chunk[]): void {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;

  if (base.kind === "figure") {
    push(chunks, base, lines.join("\n"));
    return;
  }

  const header = lines.length > 1 ? lines[0]! : null;
  const body = header ? lines.slice(1) : lines;
  const prefix = header ? `${header}\n` : "";
  let current: string[] = [];
  let currentChars = prefix.length;

  const flush = () => {
    if (current.length === 0) return;
    const content = `${prefix}${current.join("\n")}`.trim();
    current = [];
    currentChars = prefix.length;
    if (content) push(chunks, base, content);
  };

  for (const line of body) {
    const separator = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentChars + separator + line.length > limits.targetChars) {
      flush();
    }
    current.push(line);
    currentChars += (current.length > 1 ? 1 : 0) + line.length;
  }
  flush();
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sentence terminators, minus the periods that belong to abbreviations.
 * Without this "U.S. funding" and "Inc. revenue" were split *and* the space
 * after the period was swallowed, corrupting the stored text.
 */
const ABBREVIATIONS = [
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "approx.",
  "Inc.",
  "Ltd.",
  "Pvt.",
  "Co.",
  "No.",
  "Fig.",
  "Dr.",
  "Mr.",
  "Ms.",
  "cf.",
  "al.",
];

const DOT = "\u0001";

function splitUnits(text: string): string[] {
  let protectedText = text
    // Initialisms: U.S., U.K., B.V.
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (match) => match.split(".").join(DOT))
    // A lone initial: "J. Smith".
    .replace(/(^|\s)([A-Z])\./g, `$1$2${DOT}`);
  for (const abbreviation of ABBREVIATIONS) {
    if (!protectedText.includes(abbreviation)) continue;
    protectedText = protectedText.split(abbreviation).join(abbreviation.split(".").join(DOT));
  }

  return protectedText
    .replace(/([.!?])\s+|\n+/g, (_match: string, punctuation?: string) =>
      punctuation ? `${punctuation}\n` : "\n",
    )
    .split("\n")
    .map((unit) => unit.split(DOT).join(".").trim())
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
