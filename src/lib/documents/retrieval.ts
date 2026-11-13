/**
 * Per-section retrieval. Every section runs its own hybrid search (vector + FTS,
 * RRF) through the existing search seam, then neighbouring chunks are pulled
 * when a passage looks cut off mid-table or mid-list.
 *
 * Chunks are assigned to sections in outline order and deduplicated, so one
 * case study cannot fill every section. Reuse only happens when a section has
 * no fresh evidence, and the trace records it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { isTitleOnlyChunk } from "../rag/chunk-quality";
import { resolveLibraryEntities } from "../rag/entities";
import { metadataFallbackChunks, searchLibraryChunks, type RetrievedChunk } from "../rag/search";
import { searchLimiter } from "./concurrency";
import type { ExportBrief } from "./types";
import type { ExportHistoryMessage } from "./brief";
import type { SectionPlan } from "./outline";

export type Evidence = {
  plan: SectionPlan;
  chunks: RetrievedChunk[];
  topScore: number | null;
  weak: boolean;
  reused: string[];
  warnings: string[];
  /** The queries actually issued for this section, for the audit trace. */
  query: string;
  /** Retrieval error for this section, if the database call itself failed. */
  error?: string | null;
};

const PER_SECTION = 6;
const MAX_EVIDENCE_CHARS = 24_000;
const SEED_LIMIT = 3;
/** Passages reserved per named entity in a section, so every party has evidence. */
const ENTITY_QUOTA_PER_SECTION = 2;
const MAX_QUERY_WORDS = 12;
const SEARCH_RETRY_DELAY_MS = 400;

/** One short query; the raw request is never used as a search query. */
export function shortQuery(text: string, maxWords = MAX_QUERY_WORDS): string {
  return text
    .replace(/[^\p{L}\p{N}&+%.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

/** Postgres 57014 and the PostgREST wording for a statement timeout. */
export function isStatementTimeout(error: unknown): boolean {
  return /statement timeout|canceling statement|57014|timed out/i.test(String(error));
}

const NUMBER_SIGNAL =
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|days?|weeks?|months?|years?|hours?|x|times|bn|fte)\b|[£$€]\s?\d|\breduced\b|\bincreased\b|\bcut\b|\bsaved\b|\bimproved\b/gi;

export function measurableSignals(text: string): number {
  return [...text.matchAll(NUMBER_SIGNAL)].length;
}

/** Proof sections rank evidence with numbers and outcomes above prose. */
export function rankForSection(
  chunks: readonly RetrievedChunk[],
  plan: SectionPlan,
): RetrievedChunk[] {
  if (!plan.wantsNumbers) return [...chunks];
  return [...chunks].sort((a, b) => {
    const numberDelta = measurableSignals(b.content) - measurableSignals(a.content);
    if (numberDelta !== 0) return numberDelta;
    return b.score - a.score;
  });
}

export function looksTruncated(content: string): boolean {
  const text = content.trim();
  if (text.length === 0) return false;
  if (text.includes("|") && !text.trimEnd().endsWith("|")) return true;
  if (/[:;,]$/.test(text)) return true;
  return !/[.!?)\]]$/.test(text) && text.split(/\s+/).length > 12;
}

function chunkWithScore(chunk: RetrievedChunk, score: number): RetrievedChunk {
  return { ...chunk, score };
}

/**
 * Pulls the chunk before and after a cut-off passage, but only from documents
 * already in the evidence set, so retrieval stays inside RLS and stays relevant.
 */
export async function expandNeighbours(
  client: SupabaseClient<Database>,
  chunks: readonly RetrievedChunk[],
): Promise<RetrievedChunk[]> {
  const extra: RetrievedChunk[] = [];
  const seen = new Set(chunks.map((chunk) => chunk.chunkId));

  for (const chunk of chunks) {
    if (!looksTruncated(chunk.content)) continue;
    const { data, error } = await client
      .from("document_chunks")
      .select("id, content_id, content, page, slide, heading, chunk_index")
      .eq("content_id", chunk.contentId)
      .order("chunk_index", { ascending: true });
    if (error || !data) continue;

    const rows = data as {
      id: string;
      content_id: string;
      content: string;
      page: number | null;
      slide: number | null;
      heading: string | null;
      chunk_index: number;
    }[];
    const index = rows.findIndex((row) => row.id === chunk.chunkId);
    if (index === -1) continue;

    for (const offset of [-1, 1]) {
      const row = rows[index + offset];
      if (!row || seen.has(row.id) || row.content.trim().length < 20) continue;
      seen.add(row.id);
      extra.push(
        chunkWithScore(
          {
            chunkId: row.id,
            contentId: row.content_id,
            content: row.content,
            page: row.page,
            slide: row.slide,
            heading: row.heading,
            title: chunk.title,
            fileName: chunk.fileName,
            filePath: chunk.filePath,
            industry: chunk.industry,
            customerName: chunk.customerName,
            vectorRank: null,
            textRank: null,
            score: chunk.score * 0.98,
          },
          chunk.score * 0.98,
        ),
      );
    }
  }

  return extra;
}

function isUsable(chunk: RetrievedChunk): boolean {
  const text = chunk.content.trim();
  if (text.length < 40) return false;
  if (isTitleOnlyChunk(chunk)) return false;
  return true;
}

function evidenceIsWeak(chunks: readonly RetrievedChunk[], topScore: number | null): boolean {
  if (chunks.length === 0) return true;
  if (topScore !== null && topScore < 0.004) return true;
  const chars = chunks.reduce((sum, chunk) => sum + chunk.content.trim().length, 0);
  return chars < 240;
}

type SearchOutcome = { chunks: RetrievedChunk[]; error: string | null };

/**
 * Every hybrid search goes through the shared pool (DOC_SEARCH_CONCURRENCY).
 * A statement timeout is retried once after a short delay; other errors are
 * returned to the caller so the section can report them.
 */
async function searchWithRetry(
  client: GatherOptions["client"],
  query: string,
  scope: { industry?: string | null; customer?: string | null },
  k: number,
  embed: (query: string) => Promise<number[]>,
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<SearchOutcome> {
  const pool = searchLimiter();
  try {
    return {
      chunks: await pool(() => searchLibraryChunks(client, query, scope, k, embed)),
      error: null,
    };
  } catch (caught) {
    if (!isStatementTimeout(caught)) return { chunks: [], error: String(caught) };
    log("search timed out; retrying", { query, error: String(caught) });
    await new Promise((resolve) => setTimeout(resolve, SEARCH_RETRY_DELAY_MS));
    try {
      return {
        chunks: await pool(() => searchLibraryChunks(client, query, scope, k, embed)),
        error: null,
      };
    } catch (again) {
      return { chunks: [], error: String(again) };
    }
  }
}

export type GatherOptions = {
  client: SupabaseClient<Database>;
  brief: ExportBrief;
  plans: readonly SectionPlan[];
  industrySlug: string | null;
  embed: (query: string) => Promise<number[]>;
  /** Prior chat turns; their cited chunks are verified evidence for sections. */
  history?: readonly ExportHistoryMessage[];
  /** Union of brief and conversation entities, resolved before the search. */
  entityNames?: readonly string[];
  /** Set false to disable conversation seeding (tests and diagnostics). */
  allowSeeds?: boolean;
  /** Set false to skip entity resolution and its per-entity searches. */
  allowEntityScope?: boolean;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/** One passage cited by an earlier answer, plus the words used to match it. */
type Seed = { chunk: RetrievedChunk; words: Set<string> };

type SeedRow = {
  id: string;
  content_id: string;
  content: string;
  page: number | null;
  slide: number | null;
  heading: string | null;
  content_items: {
    title: string | null;
    file_name: string | null;
    file_path: string | null;
    industry: string | null;
    customer_name: string | null;
  } | null;
};

/** Loads chunks the conversation already cited, under the caller's JWT. */
async function fetchChunksByIds(
  client: SupabaseClient<Database>,
  ids: readonly string[],
): Promise<RetrievedChunk[]> {
  if (ids.length === 0) return [];
  try {
    const { data, error } = await client
      .from("document_chunks")
      .select(
        "id, content_id, content, page, slide, heading, content_items(title, file_name, file_path, industry, customer_name)",
      )
      .in("id", ids);
    if (error || !data) return [];
    return (data as unknown as SeedRow[]).flatMap((row) => {
      const item = row.content_items;
      if (!item || row.content.trim().length === 0) return [];
      return [
        {
          chunkId: row.id,
          contentId: row.content_id,
          content: row.content,
          page: row.page,
          slide: row.slide,
          heading: row.heading,
          title: item.title ?? row.heading ?? "Library document",
          fileName: item.file_name ?? "",
          filePath: item.file_path ?? "",
          industry: item.industry ?? "",
          customerName: item.customer_name,
          vectorRank: null,
          textRank: null,
          score: 0.5,
        },
      ];
    });
  } catch {
    return [];
  }
}

function keywordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((word) => word.length > 3),
  );
}

/** Verified passages from the conversation, ready to seed any matching section. */
export async function seedEvidenceFromHistory(
  client: SupabaseClient<Database>,
  history: readonly ExportHistoryMessage[],
): Promise<Seed[]> {
  const ids = [
    ...new Set(
      history.flatMap((message) =>
        (message.sources ?? []).flatMap((source) => (source.chunkId ? [source.chunkId] : [])),
      ),
    ),
  ];
  const chunks = await fetchChunksByIds(client, ids);
  return chunks.map((chunk) => ({
    chunk,
    words: keywordSet(`${chunk.title} ${chunk.heading ?? ""} ${chunk.content.slice(0, 700)}`),
  }));
}

/** Seeds whose vocabulary overlaps the section's purpose or the brief's topics. */
function seedsFor(plan: SectionPlan, brief: ExportBrief, seeds: readonly Seed[]): RetrievedChunk[] {
  if (seeds.length === 0) return [];
  const target = keywordSet(
    [plan.title, plan.goal, ...(brief.keyTopics ?? []), ...(brief.keyEntities ?? [])].join(" "),
  );
  return seeds
    .map((seed) => ({
      seed,
      score: [...target].filter((word) => seed.words.has(word)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEED_LIMIT)
    .map((entry) => entry.seed.chunk);
}

/**
 * One search per confirmed section, conversation-first. Cited passages from chat
 * are seeded in, then two or three targeted queries run through the same hybrid
 * search the chat uses; results merge, dedupe and cap per section.
 */
export async function gatherEvidence(options: GatherOptions): Promise<Evidence[]> {
  const log = options.log ?? (() => undefined);
  const scope = options.industrySlug ? { industry: options.industrySlug } : {};
  const seeds =
    options.allowSeeds === false
      ? []
      : await seedEvidenceFromHistory(options.client, options.history ?? []);
  if (seeds.length > 0) log("history evidence seeded", { chunks: seeds.length });

  // Every organisation the brief names gets its own scoped search per section,
  // so an Adani/IndiGo/InterGlobe deck can draw on all three document families
  // instead of whichever one happened to rank highest.
  const entityNames = [
    ...new Set(
      [...(options.brief.keyEntities ?? []), ...(options.brief.partiesInvolved ?? [])].filter(
        Boolean,
      ),
    ),
  ].slice(0, 6);
  const entities =
    options.allowEntityScope === false || entityNames.length === 0
      ? []
      : await resolveLibraryEntities(options.client, entityNames.join(" and "), {
          limit: 3,
          threshold: 0.5,
        });
  if (entities.length > 0) {
    log("export entities resolved", {
      entities: entities.map((entity) => entity.canonical),
    });
  }

  const batches = await Promise.all(
    options.plans.map(async (plan) => {
      // Short, entity-anchored queries only: "<entity canonical name> <section
      // topic>", never the raw request. At most three per section.
      const queries = [
        ...new Set(
          (plan.queries && plan.queries.length > 0 ? plan.queries : [plan.query])
            .map((query) => shortQuery(query))
            .filter((query) => query.split(" ").length >= 2),
        ),
      ].slice(0, 3);
      const merged = new Map<string, RetrievedChunk>();
      const entityChunkIds = new Set<string>();
      const entityQueries: string[] = [];
      const entityHits = new Map<string, RetrievedChunk[]>();
      let error: string | null = null;
      const merge = (chunks: readonly RetrievedChunk[]) => {
        for (const chunk of chunks) {
          const existing = merged.get(chunk.chunkId);
          if (!existing || chunk.score > existing.score) merged.set(chunk.chunkId, chunk);
        }
      };

      for (const query of queries) {
        const result = await searchWithRetry(
          options.client,
          query,
          scope,
          PER_SECTION,
          options.embed,
          log,
        );
        if (result.error) {
          error = result.error;
          log("section retrieval failed", { section: plan.id, query, error: result.error });
        }
        merge(result.chunks);
      }

      for (const entity of entities.slice(0, 3)) {
        const topic = shortQuery(plan.title, 5) || plan.kind.replace(/_/g, " ");
        const entityQueriesForSection = [
          shortQuery(`${entity.canonical} ${topic}`),
          shortQuery(`${entity.canonical} ${plan.kind.replace(/_/g, " ")}`),
        ]
          .filter(
            (query, index, arr) => query.split(" ").length >= 2 && arr.indexOf(query) === index,
          )
          .slice(0, 2);
        const hits: RetrievedChunk[] = [];
        for (const query of entityQueriesForSection) {
          const result = await searchWithRetry(
            options.client,
            query,
            { customer: entity.matchedName },
            3,
            options.embed,
            log,
          );
          entityQueries.push(query);
          if (result.error) {
            error = result.error;
            log("section entity retrieval failed", {
              section: plan.id,
              entity: entity.canonical,
              error: result.error,
            });
          }
          for (const chunk of result.chunks) {
            entityChunkIds.add(chunk.chunkId);
            hits.push(chunk);
          }
          merge(result.chunks);
        }
        entityHits.set(entity.canonical, hits);
      }

      // A named entity whose documents exist but rank nowhere is still a real
      // document: check metadata before declaring the section unsupported.
      if (merged.size === 0 && entities.length > 0) {
        const fallback = await metadataFallbackChunks(
          options.client,
          entities.flatMap((entity) => [entity.canonical, entity.matchedName]),
          PER_SECTION,
        );
        if (fallback.length > 0) {
          for (const chunk of fallback) entityChunkIds.add(chunk.chunkId);
          merge(fallback);
          log("section metadata fallback", { section: plan.id, chunks: fallback.length });
        }
      }

      const chunks = [...merged.values()].sort((a, b) => b.score - a.score);
      log("section retrieval", {
        section: plan.id,
        queries: [...queries, ...entityQueries],
        results: chunks.length,
        topScore: chunks[0]?.score ?? null,
      });
      return {
        plan,
        queries: [...queries, ...entityQueries],
        chunks,
        error,
        entityChunkIds,
        entityHits,
      };
    }),
  );

  const used = new Set<string>();
  const evidence: Evidence[] = [];

  for (const batch of batches) {
    const warnings: string[] = [];
    if (batch.error && batch.chunks.length === 0) {
      warnings.push("Retrieval failed for this section.");
    }

    let candidates = rankForSection(batch.chunks.filter(isUsable), batch.plan);

    if (batch.plan.wantsNumbers && candidates.length > 1) {
      const withNumbers = candidates.filter((chunk) => measurableSignals(chunk.content) > 0);
      if (withNumbers.length > 0) candidates = withNumbers;
    }

    // Per-entity quota first: every named party gets up to two passages before
    // any single document family can fill the section.
    if (batch.entityHits.size > 0) {
      const byId = new Map(candidates.map((chunk) => [chunk.chunkId, chunk]));
      const entityFirst: RetrievedChunk[] = [];
      const seenEntity = new Set<string>();
      for (const hits of batch.entityHits.values()) {
        const ranked = rankForSection(hits.filter(isUsable), batch.plan);
        // A proof/results section still gets numbers first; the entity quota
        // only decides which named party's passages those numbers come from.
        const numeric = batch.plan.wantsNumbers
          ? ranked.filter((chunk) => measurableSignals(chunk.content) > 0)
          : [];
        const pool = numeric.length > 0 ? numeric : ranked;
        for (const chunk of pool.slice(0, ENTITY_QUOTA_PER_SECTION)) {
          if (seenEntity.has(chunk.chunkId)) continue;
          seenEntity.add(chunk.chunkId);
          entityFirst.push(byId.get(chunk.chunkId) ?? chunk);
        }
      }
      candidates = [
        ...entityFirst,
        ...candidates.filter((chunk) => !seenEntity.has(chunk.chunkId)),
      ];
    }

    const truncated = candidates.filter((chunk) => looksTruncated(chunk.content));
    if (truncated.length > 0) {
      try {
        const neighbours = await expandNeighbours(options.client, truncated.slice(0, 2));
        if (neighbours.length > 0) candidates = [...candidates, ...neighbours];
      } catch (caught) {
        log("neighbour expansion failed", { section: batch.plan.id, error: String(caught) });
      }
    }

    // Conversation citations are already verified and may support several
    // sections; freshly retrieved passages stay exclusive to one section so a
    // single case study cannot fill every slide. A section that would otherwise
    // be empty reuses an already-cited passage instead of being declared
    // unsupported: the library does contain evidence, it was just spent earlier.
    const seeded = seedsFor(batch.plan, options.brief, seeds);
    const seededIds = new Set(seeded.map((chunk) => chunk.chunkId));
    const unused = candidates.filter(
      (chunk) => !seededIds.has(chunk.chunkId) && !used.has(chunk.chunkId),
    );
    // A proof slide with no fresh figures is still better off reusing a numeric
    // passage than falling back to prose that cannot support a metrics block.
    const numeric = batch.plan.wantsNumbers
      ? unused.filter((chunk) => measurableSignals(chunk.content) > 0)
      : [];
    const fresh = numeric.length > 0 ? numeric : unused;
    const chosen = [...seeded, ...fresh].slice(0, PER_SECTION);

    if (chosen.length < 2) {
      const chosenIds = new Set(chosen.map((chunk) => chunk.chunkId));
      const reused = candidates
        .filter((chunk) => !chosenIds.has(chunk.chunkId) && !seededIds.has(chunk.chunkId))
        .slice(0, PER_SECTION - chosen.length);
      if (reused.length > 0) {
        chosen.push(...reused);
        warnings.push("Reused passages already cited by earlier sections.");
      }
      if (chosen.length === 0) warnings.push("No library evidence remains for this section.");
    }

    let total = 0;
    const limited: RetrievedChunk[] = [];
    for (const chunk of chosen) {
      if (total + chunk.content.length > MAX_EVIDENCE_CHARS) break;
      limited.push(chunk);
      total += chunk.content.length;
    }

    limited.forEach((chunk) => {
      if (!seededIds.has(chunk.chunkId)) used.add(chunk.chunkId);
    });
    const topScore = limited[0]?.score ?? null;
    const weak = evidenceIsWeak(limited, topScore);
    if (weak) warnings.push("Not enough library evidence to write this section.");

    evidence.push({
      plan: batch.plan,
      chunks: limited,
      topScore,
      weak,
      reused: limited.filter((chunk) => seededIds.has(chunk.chunkId)).map((chunk) => chunk.chunkId),
      warnings,
      query: batch.queries.join(" | "),
      error: batch.error,
    });
  }

  return evidence;
}

export type DeckEvidence = {
  chunks: RetrievedChunk[];
  entities: { canonical: string; matchedName: string }[];
  queries: string[];
  warnings: string[];
  error: string | null;
};

const DECK_PASSAGES = 24;
const DECK_CHARS = 30_000;
const ENTITY_QUOTA_DECK = 3;

const TOPIC_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "our",
  "their",
  "would",
  "could",
  "should",
  "please",
  "make",
  "build",
  "create",
  "document",
  "proposal",
  "pitch",
  "deck",
  "separate",
  "table",
  "tables",
  "slide",
  "slides",
]);

function deckTopicWords(brief: ExportBrief): string[] {
  const supplied = (brief.keyTopics ?? []).join(" ");
  const source = supplied || brief.subject || brief.problem || brief.industry || "";
  const topic = source
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((word) => word.length > 3 && !TOPIC_STOPWORDS.has(word))
    .slice(0, 6)
    .join(" ");
  return topic.split(" ").filter(Boolean);
}

/**
 * One evidence pool for the whole deck: at most two short entity-anchored
 * queries per named party plus one topic query, merged with the conversation's
 * cited passages, deduped, and capped at ~24 numbered passages with a per-entity
 * quota. No section-by-section searches.
 */
export async function gatherDeckEvidence(options: GatherOptions): Promise<DeckEvidence> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const scope = options.industrySlug ? { industry: options.industrySlug } : {};
  const seeds =
    options.allowSeeds === false
      ? []
      : await seedEvidenceFromHistory(options.client, options.history ?? []);
  if (seeds.length > 0) log("history evidence seeded", { chunks: seeds.length });

  const names = [
    ...new Set(
      [
        ...(options.entityNames ?? []),
        ...(options.brief.keyEntities ?? []),
        ...(options.brief.partiesInvolved ?? []),
      ]
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, 8);

  const entities =
    options.allowEntityScope === false || names.length === 0
      ? []
      : await resolveLibraryEntities(options.client, names.join(" and "), {
          limit: 8,
          threshold: 0.4,
        }).catch(() => []);
  if (entities.length > 0) {
    log("export entities resolved", { entities: entities.map((entity) => entity.canonical) });
  }

  const topic = deckTopicWords(options.brief);
  const topicText = shortQuery(topic.join(" "), 6);
  const secondary = shortQuery(
    (options.brief.keyTopics ?? [])[1] ?? options.brief.audience ?? options.brief.industry ?? "",
    5,
  );

  const entityQueries = entities.flatMap((entity) => {
    const queries = [
      shortQuery(`${entity.canonical} ${topicText}`),
      secondary ? shortQuery(`${entity.canonical} ${secondary}`) : "",
    ]
      .filter((query) => query.split(" ").length >= 2)
      .filter((query, index, array) => array.indexOf(query) === index)
      .slice(0, 2);
    return queries.map((query) => ({ entity, query }));
  });

  const generalQueries = [topicText, secondary].filter((query) => query.split(" ").length >= 2);
  const queries = [...generalQueries, ...entityQueries.map((entry) => entry.query)].filter(
    (query, index, array) => array.indexOf(query) === index,
  );

  let error: string | null = null;
  const entityHits = new Map<string, RetrievedChunk[]>();
  const merged = new Map<string, RetrievedChunk>();
  const merge = (chunks: readonly RetrievedChunk[]) => {
    for (const chunk of chunks) {
      const existing = merged.get(chunk.chunkId);
      if (!existing || chunk.score > existing.score) merged.set(chunk.chunkId, chunk);
    }
  };

  // Concurrency is bounded by the search limiter inside searchWithRetry.
  await Promise.all(
    generalQueries.map(async (query) => {
      const result = await searchWithRetry(options.client, query, scope, 8, options.embed, log);
      if (result.error) error = result.error;
      merge(result.chunks);
    }),
  );

  await Promise.all(
    entityQueries.map(async ({ entity, query }) => {
      const result = await searchWithRetry(
        options.client,
        query,
        { customer: entity.matchedName },
        4,
        options.embed,
        log,
      );
      if (result.error) error = result.error;
      merge(result.chunks);
      const hits = entityHits.get(entity.canonical) ?? [];
      hits.push(...result.chunks);
      entityHits.set(entity.canonical, hits);
    }),
  );

  if (merged.size === 0 && entities.length > 0) {
    const fallback = await metadataFallbackChunks(
      options.client,
      entities.flatMap((entity) => [entity.canonical, entity.matchedName]),
      DECK_PASSAGES,
    );
    merge(fallback);
    if (fallback.length > 0) log("deck metadata fallback", { chunks: fallback.length });
  }

  const chosen: RetrievedChunk[] = [];
  const seen = new Set<string>();
  const push = (chunk: RetrievedChunk) => {
    if (seen.has(chunk.chunkId)) return;
    seen.add(chunk.chunkId);
    chosen.push(chunk);
  };

  for (const seed of seeds.slice(0, 6)) push(seed.chunk);
  for (const entity of entities) {
    const ranked = (entityHits.get(entity.canonical) ?? [])
      .filter(isUsable)
      .sort((a, b) => b.score - a.score)
      .slice(0, ENTITY_QUOTA_DECK);
    if (ranked.length === 0) warnings.push(`No passages found for ${entity.canonical}.`);
    ranked.forEach(push);
  }
  [...merged.values()]
    .filter(isUsable)
    .sort((a, b) => b.score - a.score)
    .forEach(push);

  let totalChars = 0;
  const limited: RetrievedChunk[] = [];
  for (const chunk of chosen.slice(0, DECK_PASSAGES)) {
    if (totalChars + chunk.content.length > DECK_CHARS) break;
    limited.push(chunk);
    totalChars += chunk.content.length;
  }

  if (limited.length === 0) warnings.push("No library evidence was found for this request.");
  log("deck retrieval", {
    queries,
    results: limited.length,
    entities: entities.map((entity) => entity.canonical),
  });

  return {
    chunks: limited,
    entities: entities.map((entity) => ({
      canonical: entity.canonical,
      matchedName: entity.matchedName,
    })),
    queries,
    warnings,
    error,
  };
}

/** Test helper: build evidence without a database. */
export function evidenceFromChunks(plan: SectionPlan, chunks: readonly RetrievedChunk[]): Evidence {
  const limited = [...chunks].slice(0, PER_SECTION);
  const topScore = limited[0]?.score ?? null;
  return {
    plan,
    chunks: limited,
    topScore,
    weak: evidenceIsWeak(limited, topScore),
    reused: [],
    warnings: [],
    query: plan.queries?.join(" | ") ?? plan.query,
  };
}
