/**
 * Customer entity resolution. Metadata carries customer names as typed by
 * whoever uploaded the file, so "Interglobe", "InterGlode" and "InterGlobe
 * Hotels" must all reach the same documents.
 *
 * Matching is generic: candidate n-grams from the query are compared with every
 * known customer name and alias in the database using pg_trgm `similarity()`
 * (migration 0020). Nothing here knows a specific company.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { ENTITY_MAX_CANDIDATES, ENTITY_SIMILARITY_THRESHOLD } from "./config";

export type EntityMatchRow = {
  canonical: string;
  matched_name: string;
  score: number;
  /** Every known spelling of the customer, including the matched one. */
  spellings?: string[];
};

export type ResolvedEntity = {
  canonical: string;
  matchedName: string;
  score: number;
  candidates: string[];
  /** Canonical plus aliases: what the retrieval filter must accept. */
  spellings: string[];
};

/**
 * Comparison key: lowercase, "&" as "and", punctuation as space, and common
 * legal/venue suffixes dropped. "InterGlobe Hotels, Ltd." -> "interglobe".
 */
const IGNORED_SUFFIXES =
  /\b(ltd|limited|inc|incorporated|corp|corporation|co|company|llc|llp|plc|gmbh|pvt|private|group|holdings?|hotels?|airports?|airlines?|airways?|international)\b/g;

export function normalizeEntityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(IGNORED_SUFFIXES, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words too common to be part of a company name in a question. */
const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "case",
  "cases",
  "deck",
  "decks",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "library",
  "me",
  "of",
  "on",
  "or",
  "our",
  "please",
  "proposal",
  "proposals",
  "proposed",
  "show",
  "study",
  "tell",
  "the",
  "their",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

/** Shortest span worth sending to similarity(); "it" is never an entity. */
const MIN_CANDIDATE_CHARS = 3;

/**
 * Every 1..4 word span that does not start or end on a stopword. Long spans are
 * kept first so "hotel procurement marketplace" is tried before its parts.
 */
export function entityCandidates(query: string, maxWords = 4): string[] {
  const words = query
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const spans: string[][] = [];

  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= maxWords && start + size <= words.length; size += 1) {
      const span = words.slice(start, start + size);
      const first = (span[0] ?? "").toLowerCase();
      const last = (span[span.length - 1] ?? "").toLowerCase();
      if (STOPWORDS.has(first) || STOPWORDS.has(last)) continue;
      const text = span.join(" ");
      if (text.length < MIN_CANDIDATE_CHARS) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(span);
    }
  }

  return spans
    .sort((a, b) => b.length - a.length || a.join(" ").localeCompare(b.join(" ")))
    .slice(0, ENTITY_MAX_CANDIDATES)
    .map((span) => span.join(" "));
}

/** Best row above the threshold, or null. Rows are expected best-first. */
export function pickEntityMatch(
  rows: readonly EntityMatchRow[],
  threshold = ENTITY_SIMILARITY_THRESHOLD,
): EntityMatchRow | null {
  let best: EntityMatchRow | null = null;
  for (const row of rows) {
    if (!row.canonical || !Number.isFinite(row.score)) continue;
    if (row.score < threshold) continue;
    if (!best || row.score > best.score) best = row;
  }
  return best;
}

/** True when the question is explicitly comparative, so scope must stay open. */
export function isComparativeQuestion(question: string): boolean {
  return /\b(compare|compared|comparison|versus|vs\.?|difference|differences|both|across|between)\b/i.test(
    question,
  );
}

/**
 * Asks the database for the closest known customer. A missing function
 * (migration not applied) or an RLS error is not fatal: retrieval simply runs
 * without an entity hint.
 */
export async function resolveLibraryEntity(
  client: SupabaseClient<Database>,
  query: string,
  options: { candidates?: string[]; threshold?: number } = {},
): Promise<ResolvedEntity | null> {
  const candidates = options.candidates ?? entityCandidates(query);
  if (candidates.length === 0) return null;

  const { data, error } = await client.rpc("match_customer_entities", {
    p_candidates: candidates,
    p_threshold: options.threshold ?? ENTITY_SIMILARITY_THRESHOLD,
    p_limit: 3,
  });
  if (error) {
    console.warn("[RAG] customer entity lookup failed", error.message);
    return null;
  }

  const rows = (data ?? []).map((row) => ({
    canonical: row.canonical,
    matched_name: row.matched_name,
    score: row.score,
    spellings: row.spellings ?? [row.canonical],
  }));
  const best = pickEntityMatch(rows, options.threshold ?? ENTITY_SIMILARITY_THRESHOLD);
  if (!best) return null;
  const spellings = [best.canonical];
  for (const spelling of best.spellings ?? []) {
    if (spelling && !spellings.includes(spelling)) spellings.push(spelling);
  }
  if (best.matched_name && !spellings.includes(best.matched_name)) {
    spellings.push(best.matched_name);
  }
  return {
    canonical: best.canonical,
    matchedName: best.matched_name,
    score: best.score,
    candidates,
    spellings,
  };
}
