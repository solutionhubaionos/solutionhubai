/**
 * Gap handling for deck parties the library does not cover.
 *
 * A gap is honest: the party still appears, marked PROPOSED, with no invented
 * numbers. What this module adds is a place for **sourced** facts to fill that
 * gap when we have them — curated rows in `entity_facts` today, and a provider
 * seam for public web facts later. Nothing here fabricates: with no stored fact
 * and no provider, the party stays inferred.
 *
 * Facts that do arrive become ordinary registry claims with `origin: "public"`,
 * so they pass through `assertDeckTraceable`, and print with an asterisk and a
 * source footnote. A public figure can never be mistaken for a library one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Claim, ClaimRegistry } from "./types";
import { claimsInText, nextClaimNumber } from "./claims";

export type EntityFactType = "scale" | "strategy" | "recent" | "other";

export type EntityFact = {
  entityName: string;
  factType: EntityFactType;
  text: string;
  sourceUrl: string | null;
  /** ISO date the fact was reconciled; older facts are refreshed first. */
  fetchedAt: string;
};

/**
 * A search provider only ever receives a public entity name and a generic
 * topic. Client documents, deck briefs, claims and user messages must never be
 * concatenated into a query.
 */
export type EntityFactQuery = { entity: string; topic: string };

export type EntityFactProvider = {
  name: string;
  search(query: EntityFactQuery): Promise<EntityFact[]>;
};

/** The only topic text a provider may be asked about. */
export const ENTITY_FACT_TOPIC = "company profile scale strategy recent announcements";

export const FACT_MAX_AGE_DAYS = 90;
export const MAX_FACTS_PER_ENTITY = 4;

type FactRow = {
  text: string;
  fact_type: EntityFactType;
  source_url: string | null;
  fetched_at: string;
  entities: { name: string } | null;
};

/** Hostname for the asterisked footnote; the full URL stays in the notes. */
export function factPublisher(fact: Pick<EntityFact, "sourceUrl">): string {
  if (!fact.sourceUrl) return "public source";
  try {
    return new URL(fact.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return "public source";
  }
}

function fresh(fact: EntityFact, now: Date): boolean {
  const age = now.getTime() - new Date(fact.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < FACT_MAX_AGE_DAYS * 86_400_000;
}

/**
 * Stored facts for one party. Never throws: a missing table or a permission
 * error leaves the party a gap rather than failing the deck.
 */
export async function storedFacts(
  client: SupabaseClient,
  entity: string,
  log?: (event: string, meta: Record<string, unknown>) => void,
): Promise<EntityFact[]> {
  try {
    const { data, error } = await client
      .from("entity_facts")
      .select("text, fact_type, source_url, fetched_at, entities!inner(name)")
      .ilike("entities.name", entity)
      .order("fetched_at", { ascending: false })
      .limit(MAX_FACTS_PER_ENTITY);
    if (error) {
      log?.("entity facts unavailable; party stays a gap", { entity, error: error.message });
      return [];
    }
    return ((data ?? []) as unknown as FactRow[])
      .filter((row) => row.text.trim().length > 0)
      .map((row) => ({
        entityName: row.entities?.name ?? entity,
        factType: row.fact_type,
        text: row.text.trim(),
        sourceUrl: row.source_url,
        fetchedAt: row.fetched_at,
      }));
  } catch (error) {
    // A client that cannot answer this query (an old mock, a table that has not
    // been migrated) must not fail the deck: the party simply stays a gap.
    log?.("entity facts unavailable; party stays a gap", {
      entity,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * The injectable seam. With no provider configured this is a pure cache read,
 * which is the current state of the project: gaps stay inferred, and a curated
 * `entity_facts` row is enough to fill one.
 */
export async function enrichEntityFacts(
  entity: string,
  options: {
    client?: SupabaseClient | null;
    provider?: EntityFactProvider | null;
    persist?: ((facts: readonly EntityFact[]) => Promise<void>) | null;
    now?: Date;
    log?: (event: string, meta: Record<string, unknown>) => void;
  } = {},
): Promise<EntityFact[]> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const cached = options.client ? await storedFacts(options.client, entity, log) : [];
  if (cached.some((fact) => fresh(fact, now))) return cached;
  if (!options.provider) return cached;

  try {
    const found = await options.provider.search({ entity, topic: ENTITY_FACT_TOPIC });
    // A provider that returns another company's facts is worse than a gap.
    const named = found
      .filter((fact) => fact.text.trim().length > 0)
      .filter((fact) => fact.entityName.toLowerCase() === entity.toLowerCase())
      .slice(0, MAX_FACTS_PER_ENTITY);
    if (named.length > 0) await options.persist?.(named);
    log("entity facts fetched", { entity, provider: options.provider.name, facts: named.length });
    return named.length > 0 ? named : cached;
  } catch (error) {
    log("entity enrichment failed; party stays a gap", {
      entity,
      error: error instanceof Error ? error.message : String(error),
    });
    return cached;
  }
}

/**
 * Facts for every party, keyed by the party name the deck uses. Parties without
 * facts are omitted, so an uncovered party simply stays a gap.
 */
export async function factsForParties(
  client: SupabaseClient,
  parties: readonly string[],
  log?: (event: string, meta: Record<string, unknown>) => void,
): Promise<Record<string, EntityFact[]>> {
  const resolved = await Promise.all(
    parties.map(
      async (name) =>
        [name, await enrichEntityFacts(name, { client, ...(log ? { log } : {}) })] as const,
    ),
  );
  return Object.fromEntries(resolved.filter(([, facts]) => facts.length > 0));
}

/**
 * Facts as registry claims. Numeric facts keep their exact wording through the
 * shared extractor, so the traceability guard sees the same digits on the slide;
 * a fact with no number still becomes a citation so it can be footnoted.
 */
export function claimsFromFacts(
  facts: Record<string, readonly EntityFact[]>,
  existing: ClaimRegistry = {},
): ClaimRegistry {
  const registry: ClaimRegistry = {};
  let counter = nextClaimNumber(existing);
  for (const [entity, entityFacts] of Object.entries(facts)) {
    for (const fact of entityFacts) {
      const publisher = factPublisher(fact);
      const found = claimsInText(fact.text, {
        chunkId: null,
        sourceTitle: publisher,
        entityName: entity,
        origin: "public",
      });
      if (found.length > 0) {
        for (const claim of found) {
          counter += 1;
          registry[`CL-${counter}`] = {
            ...claim,
            id: `CL-${counter}`,
            // The sentence rarely names its year; the reconciliation date does.
            sourceYear: claim.sourceYear ?? fact.fetchedAt.slice(0, 4),
          };
        }
        continue;
      }
      counter += 1;
      const id = `CL-${counter}`;
      registry[id] = {
        id,
        metric: fact.factType,
        valueText: fact.text.slice(0, 120),
        valueMin: null,
        valueMax: null,
        unit: null,
        context: fact.text,
        sourceTitle: publisher,
        sourceYear: fact.fetchedAt.slice(0, 4),
        chunkId: null,
        entityName: entity,
        origin: "public",
      } satisfies Claim;
    }
  }
  return registry;
}

/** `* Public source: adani.com, 2026`, the footnote beside an asterisked fact. */
export function factSourceNote(claim: Claim): string {
  const year = claim.sourceYear ? `, ${claim.sourceYear}` : "";
  return `* Public source: ${claim.sourceTitle}${year}`;
}

export function publicClaimsFor(claimIds: readonly string[], claims: ClaimRegistry): Claim[] {
  return claimIds
    .map((id) => claims[id])
    .filter((claim): claim is Claim => Boolean(claim) && claim!.origin === "public");
}
