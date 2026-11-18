/**
 * The evidence pack: the deck's passages grouped by party, plus the code-owned
 * claim registry. Retrieval itself lives in `documents/retrieval.ts`; this
 * module only partitions what came back, so a party with no passage becomes an
 * explicit gap instead of quietly disappearing from the deck.
 */
import type { RetrievedChunk } from "../../rag/search";
import type { Claim, ClaimRegistry } from "./types";
import { claimsFromChunks } from "./claims";
import { entityForChunk, normaliseEntityName } from "./entities";
import type { EntityFact } from "./enrichment";

export type EvidenceParty = {
  name: string;
  chunks: RetrievedChunk[];
  claims: Claim[];
  /** Sourced public facts for a party the library does not cover. */
  facts: EntityFact[];
  gap: boolean;
};

export type EvidenceImage = { id: string; caption: string; chunkId: string };

/** A party's chunks as retrieval found them, before metadata grouping. */
export type EvidenceGroup = {
  name: string;
  matchedName?: string | null;
  chunkIds: readonly string[];
  gap?: boolean;
};

export type EvidencePack = {
  parties: EvidenceParty[];
  /** The client the deck addresses, when the conversation named one. */
  targetClient: string | null;
  /** Library customers behind the peer passages; references, never parties. */
  referenceCustomers: string[];
  /** Facts that filled a gap, keyed by party name. */
  facts: Record<string, EntityFact[]>;
  genericChunks: RetrievedChunk[];
  /** All chunks, parties first, then generic evidence. */
  chunks: RetrievedChunk[];
  claims: ClaimRegistry;
  gaps: string[];
  images: EvidenceImage[];
};

const PER_PARTY_CHUNKS = 3;
const PER_PARTY_CLAIMS = 4;
const MAX_GENERIC = 10;

export function buildEvidencePack(
  chunks: readonly RetrievedChunk[],
  parties: readonly string[],
  options: {
    claims?: ClaimRegistry;
    /** Per-entity retrieval groups; metadata grouping is the fallback. */
    groups?: readonly EvidenceGroup[];
    /** Curated or public facts that fill a party's gap. */
    facts?: Record<string, readonly EntityFact[]>;
    /** The pitched client, so peer passages can be attributed distinctly. */
    targetClient?: string | null;
  } = {},
): EvidencePack {
  const claims =
    options.claims && Object.keys(options.claims).length > 0
      ? options.claims
      : claimsFromChunks(chunks);
  const byChunk = new Map<string, string>();
  const grouped = new Map<string, RetrievedChunk[]>(parties.map((party) => [party, []]));
  const generic: RetrievedChunk[] = [];

  const groupParty = new Map<string, string>();
  for (const group of options.groups ?? []) {
    const keys = [group.name, group.matchedName ?? ""].map(normaliseEntityName).filter(Boolean);
    const party = parties.find((candidate) => {
      const key = normaliseEntityName(candidate);
      return (
        key.length > 2 &&
        keys.some(
          (groupKey) => groupKey === key || groupKey.includes(key) || key.includes(groupKey),
        )
      );
    });
    if (!party) continue;
    for (const chunkId of group.chunkIds) groupParty.set(chunkId, party);
  }

  for (const chunk of chunks) {
    const entity = groupParty.get(chunk.chunkId) ?? entityForChunk(chunk, parties);
    if (entity) {
      byChunk.set(chunk.chunkId, entity);
      grouped.get(entity)?.push(chunk);
    } else {
      generic.push(chunk);
    }
  }

  const gaps: string[] = [];
  const evidenceParties: EvidenceParty[] = parties.map((name) => {
    const own = (grouped.get(name) ?? [])
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_PARTY_CHUNKS);
    const ownIds = new Set(own.map((chunk) => chunk.chunkId));
    const ownClaims = Object.values(claims)
      .filter((claim) => {
        if (!claim.chunkId) return false;
        if (ownIds.has(claim.chunkId)) return true;
        const owner = byChunk.get(claim.chunkId);
        return owner ? owner === name : false;
      })
      .slice(0, PER_PARTY_CLAIMS);
    // Public facts are claims too, but they never count as library evidence: the
    // party keeps its gap and its PROPOSED badge, and each number prints with an
    // asterisk pointing at the source footnote.
    const facts = [...(options.facts?.[name] ?? [])];
    const publicClaims = Object.values(claims).filter(
      (claim) =>
        claim.origin === "public" &&
        normaliseEntityName(claim.entityName ?? "") === normaliseEntityName(name),
    );
    const partyClaims = [...ownClaims, ...publicClaims].slice(0, PER_PARTY_CLAIMS);
    if (own.length === 0)
      gaps.push(
        facts.length > 0
          ? `No library passage names ${name}; its role is proposed from public facts.`
          : `No library passage names ${name}; its role is proposed.`,
      );
    return { name, chunks: own, claims: partyClaims, facts, gap: own.length === 0 };
  });

  const ordered = [
    ...evidenceParties.flatMap((party) => party.chunks),
    ...generic.slice(0, MAX_GENERIC),
  ];
  const seen = new Set<string>();
  const unique = ordered.filter((chunk) => {
    if (seen.has(chunk.chunkId)) return false;
    seen.add(chunk.chunkId);
    return true;
  });

  const targetClient = options.targetClient?.trim() || null;
  const referenceCustomers = [
    ...new Set(
      chunks
        .map((chunk) => chunk.customerName?.trim())
        .filter((name): name is string => Boolean(name))
        .filter((name) => !targetClient || name.toLowerCase() !== targetClient.toLowerCase()),
    ),
  ].sort();

  return {
    parties: evidenceParties,
    targetClient,
    referenceCustomers,
    facts: Object.fromEntries(
      evidenceParties
        .filter((party) => party.facts.length > 0)
        .map((party) => [party.name, party.facts]),
    ),
    genericChunks: generic.slice(0, MAX_GENERIC),
    chunks: unique,
    claims,
    gaps,
    // Multimodal ingest is not wired yet; the planner is told images are absent.
    images: [],
  };
}

/** Compact evidence block for the planner prompt. */
export function evidenceForPlanner(pack: EvidencePack, maxCharsPerChunk = 900): string {
  const lines: string[] = [];
  for (const party of pack.parties) {
    lines.push(
      `PARTY: ${party.name}${
        party.gap
          ? party.facts.length > 0
            ? " (no library passage; sourced public facts below)"
            : " (no direct passage; propose its role)"
          : ""
      }`,
    );
    for (const claim of party.claims.filter((entry) => entry.origin === "public")) {
      lines.push(`Public fact ${claim.id}: ${claim.context.slice(0, 220)}`);
    }
    for (const chunk of party.chunks) {
      lines.push(
        `[${chunk.chunkId}] ${chunk.title}${chunk.heading ? ` · ${chunk.heading}` : ""}\n${chunk.content.slice(0, maxCharsPerChunk)}`,
      );
    }
    if (party.claims.length > 0) {
      lines.push(
        `Claims: ${party.claims.map((claim) => `${claim.id} ${claim.valueText}`).join("; ")}`,
      );
    }
    lines.push("");
  }
  if (pack.genericChunks.length > 0) {
    lines.push("GENERAL EVIDENCE:");
    for (const chunk of pack.genericChunks) {
      lines.push(
        `[${chunk.chunkId}] ${chunk.title}${chunk.heading ? ` · ${chunk.heading}` : ""}\n${chunk.content.slice(0, maxCharsPerChunk)}`,
      );
    }
  }
  return lines.join("\n").trim();
}

/** The claim registry as the writer sees it: ids, exact values and sources. */
export function claimsForPrompt(pack: EvidencePack, limit = 40): string {
  const claims = Object.values(pack.claims).slice(0, limit);
  if (claims.length === 0) return "No numeric claims were extracted. Do not write any number.";
  return claims
    .map(
      (claim) =>
        `${claim.id}${claim.origin === "public" ? "*" : ""} | ${claim.valueText} | ${claim.metric} | ${claim.sourceTitle}${claim.sourceYear ? `, ${claim.sourceYear}` : ""} | ${claim.context.slice(0, 160)}`,
    )
    .join("\n");
}

/** Chunks cited by a slide's claims, used for the Sources section and trace. */
export function chunkIdsForClaims(claimIds: readonly string[], claims: ClaimRegistry): string[] {
  return [
    ...new Set(claimIds.map((id) => claims[id]?.chunkId).filter((id): id is string => Boolean(id))),
  ];
}
