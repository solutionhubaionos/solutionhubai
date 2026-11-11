/**
 * Sourcing tests. A fixture conversation names a client and industry, a seeded
 * library supplies chunks, and a stubbed provider follows the real stage
 * prompts. The assertions are about provenance: the brief reflects chat, the
 * queries change with the chat, and every metric exists in a cited passage.
 */
import { describe, expect, test } from "bun:test";
import { buildDocument } from "../../src/lib/documents/build";
import { gatherEvidence } from "../../src/lib/documents/retrieval";
import type { ExportBrief } from "../../src/lib/documents/types";
import type { SectionPlan } from "../../src/lib/documents/outline";
import { CHUNKS, createMockFetch, createMockSupabase, deckHistory, draftFor } from "./fixtures";

function briefFor(client: string, industry: string): ExportBrief {
  return {
    documentTitle: "Deck",
    request: "Build a deck",
    mode: "pitch",
    client,
    industry,
    sector: industry,
    audience: "COO",
    problem: "Current process is the constraint.",
    goals: ["Reduce cycle time"],
    constraints: [],
    budget: null,
    timeline: null,
    tone: "professional",
    include: [],
    exclude: [],
    decisions: [],
    citedDocuments: [],
    chatFigures: [],
    openItems: [],
  };
}

const plan = (id: string): SectionPlan => ({
  id,
  kind: "proof",
  title: `Proof ${id}`,
  goal: "Show evidence.",
  query: `proof ${id} ${clientName}`,
  minChars: 70,
  wantsNumbers: false,
});

const clientName = "Zurich Insurance";

describe("export brief and outline", () => {
  test("reads the client, industry and constraints from the whole conversation", async () => {
    const queries: string[] = [];
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, queries),
      provider: {
        apiKey: "test",
        baseUrl: "https://mock.local",
        fetchImpl: createMockFetch(),
      },
      now: new Date("2026-11-11T00:00:00Z"),
    });

    expect(result.trace.brief.client).toBe("Zurich Insurance");
    expect(result.trace.brief.industry).toBe("insurance");
    expect(result.trace.brief.exclude.join(" ")).toContain("pricing");
    expect(result.trace.brief.citedDocuments[0]?.title).toBe("Zurich claims transformation");
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.some((query) => query.includes("Zurich Insurance"))).toBe(true);
  });

  test("changing the conversation changes the retrieval queries and the content", async () => {
    const zurichQueries: string[] = [];
    const interGlobeQueries: string[] = [];

    const zurich = await buildDocument({
      draft: draftFor(),
      history: deckHistory("Zurich Insurance", "insurance"),
      client: createMockSupabase(CHUNKS, zurichQueries),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });
    const interGlobe = await buildDocument({
      draft: draftFor({
        client: "InterGlobe Aviation",
        industry: "aviation",
        title: "InterGlobe Aviation — pitch deck",
      }),
      history: deckHistory("InterGlobe Aviation", "aviation"),
      client: createMockSupabase(CHUNKS, interGlobeQueries),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });

    expect(zurich.trace.brief.client).toBe("Zurich Insurance");
    expect(interGlobe.trace.brief.client).toBe("InterGlobe Aviation");
    expect(zurichQueries.join("|")).not.toBe(interGlobeQueries.join("|"));
    expect(zurich.model.sections[0]?.title).not.toBe(interGlobe.model.sections[0]?.title);
    expect(JSON.stringify(zurich.model.sections)).not.toBe(
      JSON.stringify(interGlobe.model.sections),
    );
  });
});

describe("grounding", () => {
  test("every metric value exists in a cited chunk", async () => {
    const result = await buildDocument({
      draft: draftFor(),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });

    const chunkText = new Map(CHUNKS.map((chunk) => [chunk.chunkId, chunk.content]));
    let metrics = 0;

    for (const section of result.model.sections) {
      for (const block of section.blocks) {
        if (block.type !== "metrics") continue;
        for (const item of block.items) {
          metrics += 1;
          const source = chunkText.get(item.source);
          expect(source).toBeDefined();
          const value = item.value.replace(/,/g, "");
          expect(source).toContain(value);
        }
      }
    }

    expect(metrics).toBeGreaterThan(0);
    for (const section of result.model.sections) {
      expect(section.blocks.some((block) => block.type !== "heading")).toBe(true);
    }
  });

  test("sections do not reuse evidence while fresh passages exist", async () => {
    const fixed = CHUNKS.slice(0, 12);
    const supabase = createMockSupabase(fixed, [], { fixedResult: fixed });
    const evidence = await gatherEvidence({
      client: supabase,
      brief: briefFor("Zurich Insurance", "insurance"),
      plans: [plan("one"), plan("two")],
      industrySlug: null,
      embed: async () => Array.from({ length: 1536 }, () => 0.001),
    });

    const first = new Set(evidence[0]?.chunks.map((chunk) => chunk.chunkId) ?? []);
    const second = new Set(evidence[1]?.chunks.map((chunk) => chunk.chunkId) ?? []);
    expect(first.size).toBeGreaterThan(0);
    expect(second.size).toBeGreaterThan(0);
    expect([...first].filter((id) => second.has(id))).toEqual([]);
  });

  test("marks weak evidence rather than inventing a section", async () => {
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase([], []),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });

    expect(result.model.sections.length).toBeGreaterThan(0);
    expect(result.model.sections.every((section) => section.flagged)).toBe(true);
    expect(result.model.openItems.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.model.sections)).toContain("[To be confirmed]");
  });
});

describe("trace", () => {
  test("records a retrieval query and chunk ids per section", async () => {
    const result = await buildDocument({
      draft: draftFor(),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });

    expect(result.trace.sections.length).toBe(result.model.sections.length);
    for (const section of result.trace.sections) {
      expect(section.query.length).toBeGreaterThan(0);
      expect(Array.isArray(section.chunkIds)).toBe(true);
    }
    expect(result.trace.brief.request).toContain("Zurich Insurance");
  });
});
