/**
 * The claim registry. Every number a slide may show is extracted here, once,
 * from the cited passages: the exact text, its numeric range, the unit, the
 * surrounding sentence and the source document. The writer may only reference
 * these ids, and the renderer resolves the value from the registry, so a
 * number that is not in a passage cannot reach a slide.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../integrations/supabase/types";
import type { RetrievedChunk } from "../../rag/search";
import type { Claim, ClaimRegistry } from "./types";

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

function numeric(value: string): number | null {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
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

function metricFrom(context: string, valueText: string): string {
  const before = context.slice(0, Math.max(0, context.indexOf(valueText)));
  const words = before
    .replace(/[^a-zA-Z0-9%/£$€.-]+/g, " ")
    .split(" ")
    .filter((word) => word && !STOP.has(word.toLowerCase()) && !/\d/.test(word));
  const tail = words
    .slice(-4)
    .join(" ")
    .replace(/[.,;:]$/, "");
  if (tail.length >= 3) return tail;
  const unit = tail || "result";
  return unit;
}

function yearOf(text: string): string | null {
  const match = /\b(19|20)\d{2}\b/.exec(text);
  return match ? match[0] : null;
}

function unitOf(valueText: string): string | null {
  const match = /([a-zA-Z%]+)$/.exec(valueText.trim());
  if (!match) return null;
  const unit = match[1]!.toLowerCase();
  if (["bn", "b", "m", "k", "million", "billion", "thousand"].includes(unit)) return unit;
  return unit || null;
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

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

/**
 * Extracts every useful numeric claim from the passages. Years, page numbers
 * and bare integers with no unit are ignored: they are dates or labels, not
 * evidence a slide can argue from.
 */
/**
 * Numeric claims in one piece of text, with the source they belong to. Shared by
 * the passage extractor and the public-fact path so a reconciled fact obeys the
 * same number grammar the traceability guard checks.
 */
export function claimsInText(
  raw: string,
  source: {
    chunkId: string | null;
    sourceTitle: string;
    entityName: string | null;
    origin?: "library" | "public";
  },
): Claim[] {
  const text = raw.replace(/\s+/g, " ");
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

  matches.sort((a, b) => a.index - b.index);
  const claims: Claim[] = [];
  for (const match of matches) {
    const valueText = match.text.replace(/^[^\d£$€]+/, "").trim();
    if (!/\d/.test(valueText)) continue;
    const context = sentenceAround(text, match.index, match.text.length);
    const range = rangeOf(valueText);
    claims.push({
      id: "",
      metric: metricFrom(context, match.text),
      valueText,
      valueMin: range.min,
      valueMax: range.max,
      unit: unitOf(valueText),
      context,
      sourceTitle: source.sourceTitle,
      sourceYear: yearOf(text),
      chunkId: source.chunkId,
      entityName: source.entityName,
      ...(source.origin ? { origin: source.origin } : {}),
    });
  }
  return claims;
}

/** Next free `CL-<n>` id, so a second registry can be appended without a clash. */
export function nextClaimNumber(registry: ClaimRegistry): number {
  return Object.keys(registry).reduce((max, id) => {
    const parsed = Number(id.replace(/^CL-/, ""));
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
}

export function claimsFromChunks(chunks: readonly RetrievedChunk[]): ClaimRegistry {
  const registry: ClaimRegistry = {};
  const seen = new Set<string>();
  let counter = 0;

  for (const chunk of chunks) {
    for (const claim of claimsInText(chunk.content, {
      chunkId: chunk.chunkId,
      sourceTitle: chunk.title,
      entityName: chunk.customerName,
    })) {
      const key = `${chunk.chunkId}|${normalizeKey(claim.valueText)}|${normalizeKey(claim.context).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counter += 1;
      registry[`CL-${counter}`] = { ...claim, id: `CL-${counter}` };
    }
  }

  return registry;
}

type ClaimRow = {
  chunk_id: string | null;
  metric: string | null;
  value_text: string;
  value_min: number | null;
  value_max: number | null;
  unit: string | null;
  context: string | null;
  source_title: string | null;
  source_year: number | null;
  entities: { name: string } | null;
};

function claimKey(chunkId: string | null, valueText: string, context: string | null): string {
  return `${chunkId ?? ""}|${normalizeKey(valueText)}|${normalizeKey(context ?? "").slice(0, 80)}`;
}

/**
 * Claims from the structured ingest table (migration 0023), merged with the
 * deterministic extraction. DB rows win on an exact chunk/value/context match;
 * regex claims fill the gaps so a deck still works before the backfill lands or
 * for a chunk the worker has not processed. A missing table is not an error.
 */
export async function loadClaims(
  client: SupabaseClient<Database>,
  chunks: readonly RetrievedChunk[],
  log?: (event: string, meta: Record<string, unknown>) => void,
): Promise<ClaimRegistry> {
  const deterministic = claimsFromChunks(chunks);
  if (chunks.length === 0) return deterministic;

  const ids = chunks.map((chunk) => chunk.chunkId);
  const { data, error } = await client
    .from("claims")
    .select(
      "chunk_id, metric, value_text, value_min, value_max, unit, context, source_title, source_year, entities(name)",
    )
    .in("chunk_id", ids);
  if (error) {
    log?.("claims table unavailable; using extracted claims", { error: error.message });
    return deterministic;
  }
  const rows = (data ?? []) as unknown as ClaimRow[];
  if (rows.length === 0) return deterministic;

  const registry: ClaimRegistry = {};
  const seen = new Set<string>();
  let counter = 0;
  for (const row of rows) {
    if (!row.value_text.trim()) continue;
    const key = claimKey(row.chunk_id, row.value_text, row.context);
    if (seen.has(key)) continue;
    seen.add(key);
    counter += 1;
    const id = `CL-${counter}`;
    registry[id] = {
      id,
      metric: row.metric ?? "result",
      valueText: row.value_text,
      valueMin: row.value_min,
      valueMax: row.value_max,
      unit: row.unit,
      context: row.context ?? "",
      sourceTitle: row.source_title ?? "Library document",
      sourceYear: row.source_year === null ? null : String(row.source_year),
      chunkId: row.chunk_id,
      entityName: row.entities?.name ?? null,
    };
  }
  for (const claim of Object.values(deterministic)) {
    const key = claimKey(claim.chunkId ?? null, claim.valueText, claim.context);
    if (seen.has(key)) continue;
    seen.add(key);
    counter += 1;
    const id = `CL-${counter}`;
    registry[id] = { ...claim, id };
  }
  log?.("claims loaded", { database: rows.length, total: Object.keys(registry).length });
  return registry;
}

export function claimNumber(claim: Claim): number | null {
  return claim.valueMin ?? claim.valueMax ?? null;
}

export function claimLabel(claim: Claim): string {
  return claim.metric ? `${claim.metric}: ${claim.valueText}` : claim.valueText;
}

/** Every numeric token in some text, with its normalised digits. */
export function numbersIn(text: string): { raw: string; digits: string }[] {
  const found: { raw: string; digits: string }[] = [];
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    found.push({ raw: match[0], digits: match[0].replace(/,/g, "") });
  }
  return found;
}

export function isYearToken(raw: string): boolean {
  return /^(19|20)\d{2}$/.test(raw);
}

/** Digits a claim can support, e.g. "−65%" supports "65". */
function claimDigits(claim: Claim): Set<string> {
  const digits = new Set<string>();
  for (const token of numbersIn(claim.valueText)) digits.add(token.digits);
  if (claim.valueMin !== null) digits.add(String(claim.valueMin));
  if (claim.valueMax !== null) digits.add(String(claim.valueMax));
  return digits;
}

/**
 * Numbers in slide copy that no claim referenced by that slide can support.
 * Structural ordinals ("Phase 1", "Step 2") and four-digit years are allowed.
 */
export function untracedNumbers(
  text: string,
  claimIds: readonly string[],
  registry: ClaimRegistry,
): string[] {
  const supported = new Set<string>();
  for (const id of claimIds) {
    const claim = registry[id];
    if (!claim) continue;
    for (const digit of claimDigits(claim)) supported.add(digit);
  }
  const untraced: string[] = [];
  const structural = /(?:\b(?:phase|step|stage|slide|part)\s+)(\d{1,2})\b/gi;
  const ordinalDigits = new Set(
    [...text.matchAll(structural)].map((match) => (match[1] ?? "").replace(/,/g, "")),
  );
  for (const token of numbersIn(text)) {
    if (isYearToken(token.raw)) continue;
    if (ordinalDigits.has(token.digits)) continue;
    if (supported.has(token.digits)) continue;
    untraced.push(token.raw);
  }
  return [...new Set(untraced)];
}

/**
 * How a claim is printed. A public fact carries a trailing asterisk, matched by
 * the asterisked source footnote, so an outside figure is never read as a
 * library one.
 */
export function claimValue(claim: Claim): string {
  return claim.origin === "public" ? `${claim.valueText}*` : claim.valueText;
}

/** Replaces `{{CL-3}}` placeholders with the claim's exact value text. */
export function resolveClaimTokens(text: string, registry: ClaimRegistry): string {
  return text.replace(/\{\{\s*(CL-\d{1,4})\s*\}\}/g, (match, id: string) => {
    const claim = registry[id];
    return claim ? claimValue(claim) : match;
  });
}

/** The claims that actually belong to one entity, in registry order. */
export function claimsForEntity(registry: ClaimRegistry, entity: string): Claim[] {
  const key = normalizeKey(entity);
  return Object.values(registry).filter((claim) =>
    normalizeKey(claim.entityName ?? "").includes(key),
  );
}

export function claimIdsForChunks(registry: ClaimRegistry, chunkIds: readonly string[]): string[] {
  const ids = new Set(chunkIds);
  return Object.values(registry)
    .filter((claim) => claim.chunkId && ids.has(claim.chunkId))
    .map((claim) => claim.id);
}
