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
import { ENTITY_MAX_CANDIDATES, ENTITY_MAX_ENTITIES, ENTITY_SIMILARITY_THRESHOLD } from "./config";

export type EntityMatchRow = {
  canonical: string;
  matched_name: string;
  score: number;
  /** Every known spelling of the customer, including the matched one. */
  spellings?: string[];
};

export type ValidatedEntity = {
  id: string;
  /** Canonical name from the entities table. */
  name: string;
  type: "company" | "airport" | "concept";
  industry: string | null;
  score: number;
  /** Canonical plus aliases, for metadata matching. */
  spellings: string[];
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
 * legal/venue/sector suffixes dropped. "InterGlobe Hotels, Ltd." -> "interglobe".
 */
const GENERIC_ENTITY_TOKENS = new Set([
  "airline",
  "airlines",
  "airways",
  "airport",
  "airports",
  "aviation",
  "group",
  "holding",
  "holdings",
  "hotel",
  "hotels",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "llc",
  "llp",
  "plc",
  "gmbh",
  "pvt",
  "private",
  "international",
  "service",
  "services",
  "pitch",
  "pitching",
  "deck",
  "decks",
  "proposal",
  "proposals",
]);

const IGNORED_SUFFIXES = new RegExp(`\\b(?:${[...GENERIC_ENTITY_TOKENS].join("|")})\\b`, "g");

export function normalizeEntityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(IGNORED_SUFFIXES, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenKey(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Lowercase words without dropping sector/legal tokens, for exact containment. */
function plainKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The part of a name that identifies it: "Ethiopian Airlines" -> "Ethiopian",
 * "airlines" -> "". Empty means the mention is only a generic word and must
 * never be matched against a customer.
 */
export function distinctiveEntityName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((token) => token && !GENERIC_ENTITY_TOKENS.has(tokenKey(token)))
    .join(" ")
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

  const distinctive = new Set<string>();
  for (const span of spans) {
    const text = distinctiveEntityName(span.join(" "));
    if (text.length >= MIN_CANDIDATE_CHARS) distinctive.add(text);
  }

  return [...distinctive]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, ENTITY_MAX_CANDIDATES);
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
 * Splits a question that names several organisations into one span per entity:
 * "What about Zurich airport and Interglobe hotels?" -> ["Zurich airport",
 * "Interglobe hotels"]. A single-name question returns [] so the caller falls
 * back to whole-query resolution. Deliberately deterministic: no extra model
 * call, no latency, and the same split every time.
 */
export function splitEntityMentions(query: string): string[] {
  const cleaned = query
    .replace(/[?!.]+\s*$/g, " ")
    .replace(/^\s*(?:what|how|tell me|show me|compare)\b[^a-z0-9]*/i, "")
    .replace(/\b(?:about|between|for|regarding|on)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const parts = cleaned
    .split(/\s*(?:,|&|\band\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i)
    .map((part) => part.replace(/^\s*(?:the|our)\s+/i, "").trim())
    .filter((part) => part.length >= 3 && part.split(/\s+/).length <= 6);

  // Only a multi-entity question is split; otherwise the whole query is better
  // than an arbitrary fragment of it.
  return parts.length > 1 ? parts : [];
}

/** Stable identity for a resolved entity: alias spellings share one key. */
function entityKey(entity: { canonical: string; matchedName: string }): string {
  return normalizeEntityKey(entity.canonical) || normalizeEntityKey(entity.matchedName);
}

/**
 * Resolves every organisation a question names, not just the best one. Each
 * mention is matched separately, then the results are merged by canonical name,
 * so "Zurich airport and Interglobe hotels" keeps both instead of silently
 * narrowing to whichever scored higher.
 */
export async function resolveLibraryEntities(
  client: SupabaseClient<Database>,
  query: string,
  options: { mentions?: string[]; threshold?: number; limit?: number } = {},
): Promise<ResolvedEntity[]> {
  const mentions = options.mentions ?? splitEntityMentions(query);
  const attempts = [...new Set([...mentions, query].map((value) => value.trim()).filter(Boolean))];

  const resolved = await Promise.all(
    attempts.slice(0, 6).map((mention) => {
      // Never send a generic span ("airlines", "pitch deck") to similarity():
      // it would match every customer in the sector. The raw mention is only
      // kept when it has a distinctive remainder.
      const candidates = [
        ...new Set([distinctiveEntityName(mention), ...entityCandidates(mention)].filter(Boolean)),
      ].slice(0, 12);
      if (candidates.length === 0) return Promise.resolve(null);
      return resolveLibraryEntity(client, mention, {
        candidates,
        mention,
        ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      });
    }),
  );

  const best = new Map<string, ResolvedEntity>();
  for (const entity of resolved) {
    if (!entity) continue;
    const key = entityKey(entity);
    if (!key) continue;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, entity);
      continue;
    }
    const spellings = [...new Set([...existing.spellings, ...entity.spellings])];
    if (entity.score > existing.score) {
      best.set(key, { ...entity, spellings });
    } else {
      existing.spellings = spellings;
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(options.limit ?? ENTITY_MAX_ENTITIES, 6)));
}

/**
 * Resolves brief names against the canonical `entities` table (migration 0023).
 * This is the authority for whether a string is a company, an airport or a
 * concept; deck parties must never be concepts. Before the migration is
 * applied the RPC is missing, so callers fall back to metadata resolution
 * instead of failing the export.
 */
export type EntityLookup = {
  /** True when the entities table answered, so absence from `entities` is meaningful. */
  available: boolean;
  entities: ValidatedEntity[];
};

export async function loadValidatedEntities(
  client: SupabaseClient<Database>,
  names: readonly string[],
  options: { threshold?: number; limit?: number } = {},
): Promise<EntityLookup> {
  const candidates = [
    ...new Set(
      [...names.map(distinctiveEntityName), ...entityCandidates(names.join(" "), 5)]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 24);
  if (candidates.length === 0) return { available: true, entities: [] };

  const { data, error } = await client.rpc("match_entities", {
    p_candidates: candidates,
    p_threshold: options.threshold ?? 0.4,
    p_limit: options.limit ?? 8,
  });
  if (error) {
    // 0023 may not be applied yet; ambiguity here must not block a deck.
    console.warn("[RAG] entity lookup failed", error.message);
    return { available: false, entities: [] };
  }

  const fullKeys = names.map(plainKey).filter(Boolean);
  const entities: ValidatedEntity[] = (data ?? []).flatMap((row) => {
    const type = row.entity_type;
    if (type !== "company" && type !== "airport" && type !== "concept") return [];
    // `spellings` from the RPC also carries `matched_name`, the brief span that
    // happened to score best. For a near neighbour that span can be another
    // company's name ("Adani Power" matched against "Adani Airports"), so it
    // must not be treated as a spelling of this row.
    const matched = normalizeEntityKey(row.matched_name ?? "");
    const spellings = (row.spellings ?? [row.name]).filter(
      (spelling) =>
        normalizeEntityKey(spelling) === normalizeEntityKey(row.name) ||
        normalizeEntityKey(spelling) !== matched,
    );
    const nameKey = plainKey(row.name ?? "");
    const named = Boolean(
      nameKey &&
      fullKeys.some((key) => key === nameKey || key.includes(nameKey) || nameKey.includes(key)),
    );
    return [
      {
        id: row.id,
        name: row.name,
        type,
        industry: row.industry,
        score: named ? Math.max(row.score, 0.99) : row.score,
        spellings: spellings.length > 0 ? spellings : [row.name],
      },
    ];
  });
  return { available: true, entities };
}

/**
 * Asks the database for the closest known customer. A missing function
 * (migration not applied) or an RLS error is not fatal: retrieval simply runs
 * without an entity hint.
 */
export async function resolveLibraryEntity(
  client: SupabaseClient<Database>,
  query: string,
  options: { candidates?: string[]; threshold?: number; mention?: string } = {},
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

  // The candidate is the distinctive remainder ("Zurich"), so several sector
  // names can tie. When the full mention names one of them ("Zurich airport"),
  // that row wins over a same-surname neighbour ("Zurich Insurance").
  const mention = plainKey(options.mention ?? query);
  const rows = (data ?? []).map((row) => {
    const name = plainKey(row.matched_name ?? "");
    const named = Boolean(mention && name && (mention.includes(name) || name.includes(mention)));
    return {
      canonical: row.canonical,
      matched_name: row.matched_name,
      score: named ? Math.max(row.score, 0.99) : row.score,
      spellings: row.spellings ?? [row.canonical],
    };
  });
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
