/**
 * The failure these tests cover: "What about Zurich airport and Interglobe
 * hotels?" answered "There's nothing in the library on Zurich Airport", even
 * though 250317_ZRH_Airport_AIonOS_v1.0 exists. Retrieval resolved a single
 * customer, filtered everything else out, and only a follow-up naming Zurich
 * alone found the file.
 */
import { describe, expect, test } from "bun:test";
import { noPassagesAnswer } from "../src/lib/chat/answer";
import {
  distinctiveEntityName,
  entityCandidates,
  resolveLibraryEntities,
  splitEntityMentions,
} from "../src/lib/rag/entities";
import {
  metadataFallbackChunks,
  searchLibraryChunksForEntities,
  type RetrievedChunk,
} from "../src/lib/rag/search";
import { CHUNKS, createMockSupabase } from "./fixtures";

const QUESTION = "What about Zurich airport and Interglobe hotels?";

function embed(): Promise<number[]> {
  return Promise.resolve(Array.from({ length: 1536 }, () => 0.001));
}

function contentIds(chunks: readonly RetrievedChunk[]): Set<string> {
  return new Set(chunks.map((chunk) => chunk.contentId));
}

describe("multi-entity retrieval", () => {
  test("splits a question that names two organisations", () => {
    expect(splitEntityMentions(QUESTION)).toEqual(["Zurich airport", "Interglobe hotels"]);
    // A single-name question is not split into arbitrary fragments.
    expect(splitEntityMentions("What is the Zurich Airport story?")).toEqual([]);
  });

  test("resolves both named customers, not just the best match", async () => {
    const client = createMockSupabase(CHUNKS, []);
    const entities = await resolveLibraryEntities(client, QUESTION);

    expect(entities.map((entity) => entity.canonical)).toEqual(
      expect.arrayContaining(["Zurich Airport", "InterGlobe Hotels"]),
    );
  });

  test("the query returns passages from both document families", async () => {
    const client = createMockSupabase(CHUNKS, []);
    const entities = await resolveLibraryEntities(client, QUESTION);
    const chunks = await searchLibraryChunksForEntities(
      client,
      QUESTION,
      entities,
      [{}],
      12,
      embed,
    );

    const ids = contentIds(chunks);
    expect(ids.has("doc-zhr")).toBe(true);
    expect(ids.has("doc-igl-hotel")).toBe(true);
    expect(chunks.some((chunk) => chunk.title.includes("250317_ZRH_Airport"))).toBe(true);
  });

  test("metadata fallback surfaces a named customer when ranking finds nothing", async () => {
    const client = createMockSupabase(CHUNKS, []);
    const chunks = await metadataFallbackChunks(client, ["Zurich Airport"], 4);

    expect(chunks.length).toBeGreaterThan(0);
    expect(contentIds(chunks)).toEqual(new Set(["doc-zhr"]));
    expect(chunks[0]?.customerName).toBe("Zurich Airport");
  });

  test("the not-found answer never claims the library has nothing on a named entity", () => {
    const named = noPassagesAnswer(["Zurich Airport"]);
    expect(named).toContain("Zurich Airport");
    expect(named.toLowerCase()).not.toContain("nothing in the library");
    expect(noPassagesAnswer()).not.toContain("nothing in the library");
  });
});

describe("distinctive entity matching", () => {
  test("strips sector and document words before matching", () => {
    expect(distinctiveEntityName("Ethiopian Airlines")).toBe("Ethiopian");
    expect(distinctiveEntityName("airlines")).toBe("");
    expect(distinctiveEntityName("pitch deck proposal")).toBe("");
    expect(distinctiveEntityName("IndiGo")).toBe("IndiGo");
    expect(entityCandidates("airlines")).toEqual([]);
    expect(entityCandidates("Ethiopian Airlines")).toContain("Ethiopian");
    expect(entityCandidates("Ethiopian Airlines")).not.toContain("Airlines");
  });

  test("a generic sector word never resolves to a customer", async () => {
    const client = createMockSupabase(CHUNKS, []);
    expect(await resolveLibraryEntities(client, "airlines")).toEqual([]);
    expect(await resolveLibraryEntities(client, "Ethiopian Airlines")).toEqual([]);
  });

  test("DFW stays DFW rather than collapsing to a near code", () => {
    expect(entityCandidates("DFW")).toEqual(["DFW"]);
    expect(entityCandidates("DFW")).not.toContain("DTW");
  });
});
