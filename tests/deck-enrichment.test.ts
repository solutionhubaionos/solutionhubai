/**
 * Gap handling: a party the library does not cover stays PROPOSED, and any
 * sourced public fact that fills the gap becomes an asterisked claim with its
 * own footnote — never a silent library figure. With no provider configured,
 * nothing is invented and no query leaves the process.
 */
import { describe, expect, test } from "bun:test";
import {
  claimsFromFacts,
  enrichEntityFacts,
  factPublisher,
  factSourceNote,
  factsForParties,
  ENTITY_FACT_TOPIC,
  type EntityFact,
  type EntityFactQuery,
} from "../src/lib/documents/deck/enrichment";
import { claimValue, resolveClaimTokens } from "../src/lib/documents/deck/claims";
import {
  buildEvidencePack,
  claimsForPrompt,
  evidenceForPlanner,
} from "../src/lib/documents/deck/evidence";
import { slideSourceNote } from "../src/lib/documents/deck/build";
import type { ClaimRegistry } from "../src/lib/documents/deck/types";

const FACTS: EntityFact[] = [
  {
    entityName: "NK Proteins",
    factType: "scale",
    text: "NK Proteins sells edible oil into 40 countries from three plants.",
    sourceUrl: "https://www.nkproteins.com/about",
    fetchedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    entityName: "NK Proteins",
    factType: "strategy",
    text: "NK Proteins is expanding its branded retail range.",
    sourceUrl: "https://www.nkproteins.com/about",
    fetchedAt: "2026-10-01T00:00:00.000Z",
  },
];

describe("enrichment facts", () => {
  test("a public fact becomes a claim numbered after the library registry", () => {
    const existing: ClaimRegistry = {
      "CL-1": {
        id: "CL-1",
        metric: "time",
        valueText: "20%",
        valueMin: 20,
        valueMax: 20,
        unit: "%",
        context: "A library claim.",
        sourceTitle: "Library deck",
        sourceYear: "2025",
        chunkId: "chunk-1",
        entityName: "Adani Airports",
      },
    };
    const registry = claimsFromFacts({ "NK Proteins": FACTS }, existing);
    const ids = Object.keys(registry);
    expect(ids.every((id) => Number(id.replace("CL-", "")) > 1)).toBe(true);
    expect(Object.values(registry).every((claim) => claim.origin === "public")).toBe(true);
    expect(Object.values(registry).some((claim) => claim.valueText === "40 countries")).toBe(true);
    // A fact with no number is still citable, so it can be footnoted.
    expect(
      Object.values(registry).some((claim) => claim.valueText.includes("branded retail")),
    ).toBe(true);
  });

  test("public claim values print with an asterisk and a matching footnote", () => {
    const registry = claimsFromFacts({ "NK Proteins": FACTS });
    const id = Object.values(registry).find((claim) => claim.valueText === "40 countries")!.id;
    expect(resolveClaimTokens(`Sells into {{${id}}} today.`, registry)).toBe(
      "Sells into 40 countries* today.",
    );
    expect(claimValue(registry[id]!)).toBe("40 countries*");
    expect(factSourceNote(registry[id]!)).toBe("* Public source: nkproteins.com, 2026");
    expect(factPublisher({ sourceUrl: "not a url" })).toBe("public source");
  });

  test("the footnote names the public source, and a mixed slide carries both", () => {
    const facts = claimsFromFacts({ "NK Proteins": FACTS });
    const publicId = Object.values(facts).find((claim) => claim.valueText === "40 countries")!.id;
    const library: ClaimRegistry = {
      "CL-90": {
        id: "CL-90",
        metric: "time",
        valueText: "20%",
        valueMin: 20,
        valueMax: 20,
        unit: "%",
        context: "A library claim.",
        sourceTitle: "Library deck",
        sourceYear: "2025",
        chunkId: "chunk-1",
        entityName: "Adani Airports",
      },
    };
    const claims = { ...library, ...facts };
    expect(slideSourceNote([publicId], claims)).toBe("* Public source: nkproteins.com, 2026");
    expect(slideSourceNote([publicId, "CL-90"], claims)).toBe(
      "* Public source: nkproteins.com, 2026; Source: Library deck",
    );
    expect(slideSourceNote([], claims)).toBe("");
  });

  test("a gap party keeps its gap and its PROPOSED badge while carrying facts", () => {
    const facts = { "NK Proteins": FACTS };
    const registry = claimsFromFacts(facts);
    const pack = buildEvidencePack([], ["NK Proteins"], { claims: registry, facts });

    expect(pack.parties[0]!.gap).toBe(true);
    expect(pack.parties[0]!.facts).toHaveLength(2);
    expect(pack.parties[0]!.claims.every((claim) => claim.origin === "public")).toBe(true);
    expect(pack.gaps[0]).toContain("proposed from public facts");
    expect(evidenceForPlanner(pack)).toContain("sourced public facts below");
    expect(claimsForPrompt(pack)).toContain("*");
  });

  test("with no provider, nothing is queried and no fact is invented", async () => {
    const facts = await enrichEntityFacts("NK Proteins");
    expect(facts).toEqual([]);
    expect(await factsForParties({} as never, ["NK Proteins"])).toEqual({});
  });

  test("a provider only receives the entity name and a fixed generic topic", async () => {
    const queries: EntityFactQuery[] = [];
    const found = await enrichEntityFacts("NK Proteins", {
      provider: {
        name: "stub",
        search: async (query) => {
          queries.push(query);
          return [
            { ...FACTS[0]!, entityName: "Some Other Company" },
            { ...FACTS[0]!, entityName: "NK Proteins" },
          ];
        },
      },
      now: new Date("2026-11-17T00:00:00.000Z"),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.entity).toBe("NK Proteins");
    expect(queries[0]!.topic).toBe(ENTITY_FACT_TOPIC);
    // Facts naming a different company are dropped rather than attributed.
    expect(found).toHaveLength(1);
    expect(found[0]!.entityName).toBe("NK Proteins");
  });

  test("a failing provider leaves the gap instead of throwing", async () => {
    const found = await enrichEntityFacts("NK Proteins", {
      provider: {
        name: "stub",
        search: async () => {
          throw new Error("429 Too Many Requests");
        },
      },
    });
    expect(found).toEqual([]);
  });
});
