/**
 * Structured facts for ingest: which canonical entities a passage mentions and
 * which figures it states, keyed by chunk index.
 *
 * Deterministic on purpose. It runs for every chunk during ingestion (and in
 * the resumable backfill) without a model call, so a deck has a claim registry
 * even before any enrichment is configured. The figures keep their exact
 * wording; the deck never rounds or invents from them.
 */

export type FactEntityType = "company" | "airport" | "concept";

export type FactEntity = { name: string; type: FactEntityType };

export type FactClaim = {
  metric: string | null;
  value_text: string;
  value_min: number | null;
  value_max: number | null;
  unit: string | null;
  context: string;
  source_title: string | null;
  source_year: string | null;
  entity_name: string | null;
};

export type ChunkFacts = {
  chunk_index: number;
  entities: FactEntity[];
  claims: FactClaim[];
};

export type KnownEntity = { name: string; type: FactEntityType };

const CURRENCY = /[£$€]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:bn|b|m|k|million|billion|thousand))?/gi;
const PERCENT = /\d[\d,]*(?:\.\d+)?\s?%/g;
const RANGE = /\d[\d,]*(?:\.\d+)?\s?(?:-|–|—|to)\s?\d[\d,]*(?:\.\d+)?\s?%/gi;
const COUNT =
  /\b\d[\d,]*(?:\.\d+)?\s+(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?|markets?|countr(?:y|ies)|stores?|bases?|crew|assessors?|handlers?|files?|passengers?|rooms?|hotels?|aircraft|people|customers?|claims?|staff|fte|employees?|partners?|routes?|cities|airports?|agents?|suppliers?|reviews?|percentage points?|points?|times|x)\b/gi;

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "from",
  "by",
  "with",
  "and",
  "or",
  "at",
  "as",
  "after",
  "before",
  "across",
  "over",
  "under",
  "within",
  "up",
  "down",
]);

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normaliseFactText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numeric(value: string): number | null {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function rangeOf(valueText: string): { min: number | null; max: number | null } {
  const range = /(\d[\d,]*(?:\.\d+)?)\s?(?:-|–|—|to)\s?(\d[\d,]*(?:\.\d+)?)/i.exec(valueText);
  if (range) {
    const first = numeric(range[1] ?? "");
    const second = numeric(range[2] ?? "");
    if (first !== null && second !== null) {
      return { min: Math.min(first, second), max: Math.max(first, second) };
    }
  }
  const single = numeric(valueText);
  return { min: single, max: single };
}

function unitOf(valueText: string): string | null {
  const match = /([a-zA-Z%]+)$/.exec(valueText.trim());
  if (!match) return null;
  return match[1]!.toLowerCase() || null;
}

function sentenceAround(text: string, index: number, length: number): string {
  const before = text.slice(0, index);
  const after = text.slice(index + length);
  const start = Math.max(
    before.lastIndexOf(". "),
    before.lastIndexOf("! "),
    before.lastIndexOf("? "),
    before.lastIndexOf("\n"),
  );
  const end = after.search(/[.!?\n]/);
  const context = text
    .slice(
      start + 1,
      end === -1 ? Math.min(text.length, index + length + 220) : index + length + end + 1,
    )
    .trim();
  return clean(context).slice(0, 240);
}

function metricFrom(context: string, valueText: string): string | null {
  const position = context.indexOf(valueText);
  const before = position >= 0 ? context.slice(0, position) : context;
  const words = before
    .replace(/[^a-zA-Z0-9%/£$€.-]+/g, " ")
    .split(" ")
    .filter((word) => word && !STOP.has(word.toLowerCase()) && !/\d/.test(word));
  const tail = words
    .slice(-4)
    .join(" ")
    .replace(/[.,;:]$/, "");
  return tail.length >= 3 ? tail : null;
}

function yearOf(text: string): string | null {
  return /\b(19|20)\d{2}\b/.exec(text)?.[0] ?? null;
}

function valueMatches(text: string): { index: number; text: string }[] {
  const matches: { index: number; text: string }[] = [];
  const taken: { start: number; end: number }[] = [];
  const collect = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (taken.some((range) => start < range.end && end > range.start)) continue;
      taken.push({ start, end });
      matches.push({ index: start, text: clean(match[0]) });
    }
  };
  collect(RANGE);
  collect(CURRENCY);
  collect(PERCENT);
  collect(COUNT);
  return matches.sort((a, b) => a.index - b.index);
}

/**
 * One chunk's entities and claims. Known names are matched as whole phrases
 * after normalisation; an unknown company is not invented here — the worker
 * may still attach a canonical customer name from the file's metadata.
 */
export function extractChunkFacts(input: {
  chunkIndex: number;
  text: string;
  knownEntities: readonly KnownEntity[];
  sourceTitle?: string | null;
  customerName?: string | null;
}): ChunkFacts {
  const text = input.text.replace(/\s+/g, " ").trim();
  const normalised = normaliseFactText(text);
  const entities = new Map<string, FactEntity>();

  const add = (name: string, type: FactEntityType) => {
    const value = clean(name);
    if (!value) return;
    const key = normaliseFactText(value);
    if (!key) return;
    const existing = entities.get(key);
    // A company/airport beats an industry concept with the same spelling.
    if (!existing || (existing.type === "concept" && type !== "concept")) {
      entities.set(key, { name: value, type });
    }
  };

  for (const entity of input.knownEntities) {
    const key = normaliseFactText(entity.name);
    if (key.length < 3 || !normalised.includes(key)) continue;
    add(entity.name, entity.type);
  }
  if (input.customerName) add(input.customerName, "company");

  const claims: FactClaim[] = [];
  const seen = new Set<string>();
  for (const match of valueMatches(text)) {
    const valueText = match.text.replace(/^[^\d£$€]+/, "").trim();
    if (!/\d/.test(valueText)) continue;
    const context = sentenceAround(text, match.index, match.text.length);
    const key = `${normaliseFactText(valueText)}|${normaliseFactText(context).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const range = rangeOf(valueText);
    claims.push({
      metric: metricFrom(context, match.text),
      value_text: valueText,
      value_min: range.min,
      value_max: range.max,
      unit: unitOf(valueText),
      context,
      source_title: input.sourceTitle ?? null,
      source_year: yearOf(text),
      entity_name: input.customerName ?? null,
    });
  }

  return {
    chunk_index: input.chunkIndex,
    entities: [...entities.values()],
    claims,
  };
}
