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
import { MAX_CHUNKS_PER_DOCUMENT } from "../rag/config";
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
  /**
   * The client the document is addressed to. It is searched as a hard entity so
   * target-specific passages rank first; when the library has none, the same
   * topic query still returns the closest peer evidence.
   */
  targetName?: string | null;
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

      // Same rule as the deck pass: an industry hint that matches nothing is a
      // hint, not a filter, so retry the section's queries library-wide.
      if (merged.size === 0 && scope.industry) {
        log("section retrieval: industry hint empty, retrying unscoped", { section: plan.id });
        for (const query of queries) {
          const result = await searchWithRetry(
            options.client,
            query,
            {},
            PER_SECTION,
            options.embed,
            log,
          );
          if (result.error) error = result.error;
          merge(result.chunks);
        }
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

export type DeckEvidenceGroup = {
  name: string;
  matchedName: string | null;
  chunks: RetrievedChunk[];
  /** True when the party resolved but no passage survived the evidence cap. */
  gap: boolean;
};

export type DeckEvidence = {
  chunks: RetrievedChunk[];
  entities: { canonical: string; matchedName: string }[];
  /** Per-party passages, so the deck can group by retrieval, not just metadata. */
  groups: DeckEvidenceGroup[];
  gaps: string[];
  queries: string[];
  warnings: string[];
  error: string | null;
  /** Target-client passages versus peer passages selected for adaptation. */
  target: { name: string | null; passages: number; peers: number };
};

const DECK_PASSAGES = 24;
const DECK_CHARS = 30_000;
const DECK_MIN_PASSAGES = 8;
const DECK_MIN_DOCUMENTS = 2;
/** Candidate documents are chosen from metadata before any search runs. */
const DECK_CANDIDATES = 8;
const DECK_CANDIDATE_MIN = 3;
/** Hybrid-search depth per plan section; dedupe and caps happen afterwards. */
// shortcut: slide decks contain many title-only chunks, so 25 hits is mostly
// dividers; depth 50 reaches the substantive passages. Revisit when ingestion
// stops emitting slide titles as chunks.
const DECK_SECTION_K = 50;

const PITCH_DOCUMENT_TYPES = new Set(["pitch_deck", "proposal", "case_study"]);

/**
 * What each plan section retrieves. These are section topics, never the user's
 * sentence and never the target client's name, so the same sector library is
 * searched for a new client as for the customers already in it.
 */
const DECK_SECTION_TOPICS: Record<SectionPlan["kind"], string> = {
  executive_summary: "executive summary priorities",
  problem: "industry challenges market pressure",
  solution: "solution overview what we offer",
  approach: "delivery approach implementation",
  how_it_works: "platform architecture integration",
  proof: "case study results outcomes",
  results: "results outcomes metrics",
  timeline: "implementation roadmap phases",
  deliverables: "deliverables scope",
  assumptions: "planning assumptions",
  pricing: "commercial model pricing",
  next_steps: "next steps roadmap",
  ask: "investment ask next steps",
  why_us: "credentials relevant experience",
  parties: "partnership roles responsibilities",
  pointers: "collaboration success factors",
  shortcomings: "risks limitations",
  economics: "business case economics return",
  governance: "governance operating model",
  open_questions: "open questions decisions",
  journey: "customer journey experience",
};

type DeckCandidate = {
  id: string;
  title: string;
  fileName: string;
  filePath: string;
  industry: string;
  customerName: string | null;
};

type DeckPool = {
  candidates: DeckCandidate[];
  source: "scoped" | "adjacent" | "unscoped";
  scope: { industry?: string | null };
};

/**
 * The pool is metadata-first: the newest pitch decks, proposals and case studies
 * in the target's industry. If the sector is too thin, widen to industries that
 * share a customer, then to the whole library — and say so in the trace.
 */
async function deckDocumentPool(
  client: SupabaseClient<Database>,
  industrySlug: string | null,
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<{ pool: DeckPool; warnings: string[] }> {
  const { data, error } = await client
    .from("content_items")
    .select("id, title, file_name, file_path, customer_name, industry, content_type, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    log("deck candidate documents failed", { error: error.message });
    return {
      pool: { candidates: [], source: "unscoped", scope: {} },
      warnings: ["The library metadata could not be read, so no documents were found."],
    };
  }

  const rows = (data ?? []) as {
    id: string;
    title: string | null;
    file_name: string | null;
    file_path: string | null;
    customer_name: string | null;
    industry: string;
    content_type: string;
  }[];
  // Preferred document types first, newest first inside each group (stable sort).
  const ordered = [...rows].sort(
    (a, b) =>
      Number(PITCH_DOCUMENT_TYPES.has(b.content_type)) -
      Number(PITCH_DOCUMENT_TYPES.has(a.content_type)),
  );
  const toCandidate = (row: (typeof rows)[number]): DeckCandidate => ({
    id: row.id,
    title: row.title?.trim() || row.file_name?.trim() || "Library document",
    fileName: row.file_name ?? "",
    filePath: row.file_path ?? "",
    industry: row.industry,
    customerName: row.customer_name,
  });

  // One document per customer before a second from any of them, so eight slots
  // cover the sector instead of eight files from one account.
  const diversify = (rows: typeof ordered): typeof ordered => {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = (row.customer_name ?? "").trim().toLowerCase() || "library";
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const out: typeof rows = [];
    for (let round = 0; ; round += 1) {
      let added = false;
      for (const list of groups.values()) {
        const row = list[round];
        if (!row) continue;
        out.push(row);
        added = true;
      }
      if (!added) return out;
    }
  };

  const scoped = industrySlug ? ordered.filter((row) => row.industry === industrySlug) : [];
  const warnings: string[] = [];
  let source: DeckPool["source"] = industrySlug ? "scoped" : "unscoped";
  let chosen = diversify(scoped).slice(0, DECK_CANDIDATES);

  if (industrySlug && chosen.length < DECK_CANDIDATE_MIN) {
    const customers = new Set(
      scoped.map((row) => (row.customer_name ?? "").trim().toLowerCase()).filter(Boolean),
    );
    const adjacent = ordered.filter(
      (row) =>
        row.industry !== industrySlug &&
        row.customer_name &&
        customers.has(row.customer_name.trim().toLowerCase()),
    );
    chosen = diversify([...scoped, ...adjacent]).slice(0, DECK_CANDIDATES);
    source = "adjacent";
    warnings.push(
      `Only ${scoped.length} document${scoped.length === 1 ? "" : "s"} in ${industrySlug}; widened to adjacent industries.`,
    );
  }
  if (industrySlug && chosen.length < DECK_CANDIDATE_MIN) {
    chosen = diversify(ordered).slice(0, DECK_CANDIDATES);
    source = "unscoped";
    warnings.push(`Too few documents in ${industrySlug}; widened to the whole library.`);
  }
  if (!industrySlug) chosen = diversify(ordered).slice(0, DECK_CANDIDATES);

  const candidates = [...new Map(chosen.map((row) => [row.id, toCandidate(row)])).values()];
  log("deck candidate documents", {
    source,
    documents: candidates.length,
    titles: candidates.map((document) => document.title),
  });

  return {
    pool: {
      candidates,
      source,
      scope: source === "scoped" && industrySlug ? { industry: industrySlug } : {},
    },
    warnings,
  };
}

const OVERVIEW_COPY =
  /\b(?:solution|offer|offering|approach|platform|capabilit|proposition|what we do)\b/i;

/** One candidate document's best overview passage, or its first usable chunk. */
async function deckOverviewChunk(
  client: SupabaseClient<Database>,
  document: DeckCandidate,
): Promise<RetrievedChunk | null> {
  const { data, error } = await client
    .from("document_chunks")
    .select("id, content_id, content, page, slide, heading, chunk_index")
    .eq("content_id", document.id)
    .order("chunk_index", { ascending: true })
    .limit(40);
  if (error || !data) return null;

  const chunks = (
    data as {
      id: string;
      content_id: string;
      content: string;
      page: number | null;
      slide: number | null;
      heading: string | null;
      chunk_index: number;
    }[]
  )
    .map((row): RetrievedChunk => ({
      chunkId: row.id,
      contentId: row.content_id,
      content: row.content,
      page: row.page,
      slide: row.slide,
      heading: row.heading,
      title: document.title,
      fileName: document.fileName,
      filePath: document.filePath,
      industry: document.industry,
      customerName: document.customerName,
      vectorRank: null,
      textRank: null,
      score: 0.001,
    }))
    .filter(isUsable);

  return (
    chunks.find((chunk) =>
      OVERVIEW_COPY.test(`${chunk.heading ?? ""} ${chunk.content.slice(0, 500)}`),
    ) ??
    [...chunks].sort((a, b) => b.content.trim().length - a.content.trim().length)[0] ??
    null
  );
}

/** One query per plan section, from the section topic only. */
function deckSectionQueries(plans: readonly SectionPlan[]): string[] {
  const fallback: SectionPlan["kind"][] = ["problem", "solution", "approach", "proof", "timeline"];
  const kinds = plans.length > 0 ? [...new Set(plans.map((plan) => plan.kind))] : fallback;
  return [
    ...new Set(
      kinds
        .map((kind) => shortQuery(DECK_SECTION_TOPICS[kind]))
        .filter((query) => query.split(" ").length >= 2),
    ),
  ].slice(0, 8);
}

/** Round-robin across documents, at most three passages from any one. */
function roundRobinByDocument(chunks: readonly RetrievedChunk[]): RetrievedChunk[] {
  const groups = new Map<string, RetrievedChunk[]>();
  for (const chunk of [...chunks].sort((a, b) => b.score - a.score)) {
    const list = groups.get(chunk.contentId) ?? [];
    if (list.length < MAX_CHUNKS_PER_DOCUMENT) list.push(chunk);
    groups.set(chunk.contentId, list);
  }
  const out: RetrievedChunk[] = [];
  for (let round = 0; ; round += 1) {
    let added = false;
    for (const list of groups.values()) {
      const chunk = list[round];
      if (!chunk) continue;
      out.push(chunk);
      added = true;
    }
    if (!added) return out;
  }
}

/**
 * The deck's evidence pool. Documents come from the sector's metadata; each
 * plan section contributes one topic query; results are grouped by document and
 * interleaved, then every candidate document's overview passage is added. The
 * target client is never a query term and library customers are references.
 */
export async function gatherDeckEvidence(options: GatherOptions): Promise<DeckEvidence> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const targetName = options.targetName?.trim() || null;
  const { pool, warnings: poolWarnings } = await deckDocumentPool(
    options.client,
    options.industrySlug,
    log,
  );
  warnings.push(...poolWarnings);

  const queries = deckSectionQueries(options.plans);
  const poolIndustries = new Set(pool.candidates.map((document) => document.industry));
  let error: string | null = null;

  const sections = await Promise.all(
    queries.map(async (query) => {
      const result = await searchWithRetry(
        options.client,
        query,
        pool.scope,
        DECK_SECTION_K,
        options.embed,
        log,
      );
      if (result.error) error = result.error;
      // A scoped search only returns the target sector. Adjacent pools span a
      // few industries, so keep the search inside those; unscoped is the whole
      // library by definition.
      const usable = result.chunks.filter(
        (chunk) =>
          isUsable(chunk) && (pool.source !== "adjacent" || poolIndustries.has(chunk.industry)),
      );
      log("deck section retrieval", {
        query,
        results: usable.length,
        documents: new Set(usable.map((chunk) => chunk.contentId)).size,
      });
      return roundRobinByDocument(usable);
    }),
  );

  const merged = new Map<string, RetrievedChunk>();
  for (const section of sections) {
    for (const chunk of section) {
      if (!merged.has(chunk.chunkId)) merged.set(chunk.chunkId, chunk);
    }
  }

  // Chat-cited passages stay first-class evidence; they are not entity
  // resolution and do not influence the section queries.
  const seeds =
    options.allowSeeds === false
      ? []
      : await seedEvidenceFromHistory(options.client, options.history ?? []);
  if (seeds.length > 0) log("history evidence seeded", { chunks: seeds.length });
  for (const seed of seeds.slice(0, SEED_LIMIT)) {
    const chunk = seed.chunk;
    if (isUsable(chunk) && !merged.has(chunk.chunkId)) merged.set(chunk.chunkId, chunk);
  }

  // Every candidate document contributes its overview, so a document that the
  // topic queries did not rank still reaches the evidence pack.
  const overviews = await Promise.all(
    pool.candidates.map((document) => deckOverviewChunk(options.client, document)),
  );
  for (const chunk of overviews) {
    if (chunk && !merged.has(chunk.chunkId)) merged.set(chunk.chunkId, chunk);
  }

  const chosen = [...merged.values()].sort((a, b) => b.score - a.score);
  const limited: RetrievedChunk[] = [];
  const perDocument = new Map<string, number>();
  let totalChars = 0;
  for (const chunk of chosen) {
    const used = perDocument.get(chunk.contentId) ?? 0;
    if (used >= MAX_CHUNKS_PER_DOCUMENT) continue;
    if (totalChars + chunk.content.length > DECK_CHARS) continue;
    limited.push(chunk);
    perDocument.set(chunk.contentId, used + 1);
    totalChars += chunk.content.length;
    if (limited.length >= DECK_PASSAGES) break;
  }

  const resultDocuments = new Set(limited.map((chunk) => chunk.contentId)).size;
  const matchesTarget = (chunk: RetrievedChunk): boolean => {
    if (!targetName) return false;
    const customer = (chunk.customerName ?? "").toLowerCase().trim();
    const target = targetName.toLowerCase().trim();
    if (!customer || !target) return false;
    return customer === target || customer.includes(target) || target.includes(customer);
  };
  const targetPassages = limited.filter(matchesTarget).length;
  const peers = limited.length - targetPassages;

  // The gate refuses instead of writing a deck around two passages. The caller
  // turns this into an explicit message listing the documents that were found.
  if (limited.length < DECK_MIN_PASSAGES || resultDocuments < DECK_MIN_DOCUMENTS) {
    const found = pool.candidates
      .map(
        (document) =>
          `${document.title}${document.customerName ? ` (${document.customerName})` : ""}`,
      )
      .slice(0, DECK_CANDIDATES);
    warnings.unshift(
      `Only ${limited.length} usable passage${limited.length === 1 ? "" : "s"} from ${resultDocuments} document${resultDocuments === 1 ? "" : "s"}; a deck needs ${DECK_MIN_PASSAGES} from at least ${DECK_MIN_DOCUMENTS}. Documents found: ${found.length > 0 ? found.join("; ") : "none"}.`,
    );
    log("deck retrieval gate", {
      passages: limited.length,
      documents: resultDocuments,
      pool: pool.source,
    });
    return {
      chunks: [],
      entities: [],
      groups: [],
      gaps: [],
      queries,
      warnings,
      error,
      target: { name: targetName, passages: 0, peers: 0 },
    };
  }

  if (pool.source !== "scoped") {
    warnings.push(
      `Evidence pool widened to ${pool.source} industries because ${options.industrySlug ?? "this sector"} had too few documents.`,
    );
  }
  if (targetName && targetPassages === 0 && peers > 0) {
    warnings.push(
      `No library passage names ${targetName}; the deck adapts ${peers} comparable passage${peers === 1 ? "" : "s"} from peer clients.`,
    );
  }

  log("deck retrieval", {
    pool: pool.source,
    queries,
    results: limited.length,
    documents: resultDocuments,
    target: targetName,
    targetPassages,
    peerPassages: peers,
  });

  return {
    chunks: limited,
    entities: [],
    groups: [],
    gaps: [],
    queries,
    warnings,
    error,
    target: { name: targetName, passages: targetPassages, peers },
  };
}

/**
 * Up to two short extra queries for thin slides whose topic has sparse
 * evidence. Results are appended to the deck's passages, so existing reference
 * numbers keep pointing at the same chunk.
 */
export async function topUpDeckEvidence(options: {
  client: GatherOptions["client"];
  queries: readonly string[];
  industrySlug: string | null;
  embed: (query: string) => Promise<number[]>;
  existing: ReadonlySet<string>;
  log?: (event: string, meta: Record<string, unknown>) => void;
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const log = options.log ?? (() => undefined);
  const scope = options.industrySlug ? { industry: options.industrySlug } : {};
  const queries = options.queries
    .map((query) => shortQuery(query, 8))
    .filter((query) => query.split(" ").length >= 2)
    .filter((query, index, array) => array.indexOf(query) === index)
    .slice(0, 2);
  if (queries.length === 0) return [];

  const limit = options.limit ?? 3;
  const found = new Map<string, RetrievedChunk>();
  for (const query of queries) {
    const result = await searchWithRetry(options.client, query, scope, limit, options.embed, log);
    for (const chunk of result.chunks) {
      if (options.existing.has(chunk.chunkId) || found.has(chunk.chunkId)) continue;
      if (!isUsable(chunk)) continue;
      found.set(chunk.chunkId, chunk);
    }
  }
  const chunks = [...found.values()].slice(0, limit);
  if (chunks.length > 0) log("thin topic top-up", { queries, chunks: chunks.length });
  return chunks;
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
