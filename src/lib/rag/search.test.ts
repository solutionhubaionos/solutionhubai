import { describe, expect, it, vi } from "vitest";
import {
  clampMatchCount,
  formatVectorLiteral,
  mapSearchRows,
  normalizeScope,
  retrieve,
  searchLibraryChunks,
  type RetrievedChunk,
  type SearchInput,
} from "./search";

const vector = new Array<number>(1536).fill(0.5);

const row = {
  chunk_id: "chunk-1",
  content_id: "content-1",
  content: "Overlap content",
  page: 3,
  slide: null,
  heading: "Pricing",
  title: "Proposal",
  file_name: "proposal.pdf",
  file_path: "airlines/proposal.pdf",
  industry: "airlines",
  customer_name: null,
  vector_rank: 1,
  text_rank: 4,
  score: 0.0325,
};

const hit: RetrievedChunk = {
  chunkId: "chunk-1",
  contentId: "content-1",
  content: "Overlap content",
  page: 3,
  slide: null,
  heading: "Pricing",
  title: "Proposal",
  fileName: "proposal.pdf",
  filePath: "airlines/proposal.pdf",
  industry: "airlines",
  customerName: null,
  vectorRank: 1,
  textRank: 4,
  score: 0.0325,
};

describe("normalizeScope", () => {
  it("defaults to no filters", () => {
    expect(normalizeScope()).toEqual({ industry: null, customer: null });
  });

  it("treats blank and whitespace values as no filter", () => {
    expect(normalizeScope({ industry: "  ", customer: "" })).toEqual({
      industry: null,
      customer: null,
    });
  });

  it("trims the values it keeps", () => {
    expect(normalizeScope({ industry: " airlines ", customer: "IndiGo" })).toEqual({
      industry: "airlines",
      customer: "IndiGo",
    });
  });
});

describe("clampMatchCount", () => {
  it("defaults to eight results", () => {
    expect(clampMatchCount()).toBe(8);
    expect(clampMatchCount(Number.NaN)).toBe(8);
  });

  it("keeps requests inside the database limit", () => {
    expect(clampMatchCount(0)).toBe(1);
    expect(clampMatchCount(999)).toBe(50);
    expect(clampMatchCount(12)).toBe(12);
  });
});

describe("formatVectorLiteral", () => {
  it("renders the text form PostgREST sends for a vector argument", () => {
    const literal = formatVectorLiteral([0.1, -0.25, 3, ...vector.slice(3)]);
    expect(literal.startsWith("[0.1,-0.25,3,")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal.split(",")).toHaveLength(1536);
  });

  it("rejects a vector of the wrong dimension", () => {
    expect(() => formatVectorLiteral([0.1, 0.2])).toThrow(/expected 1536/);
  });

  it("rejects non-numeric values", () => {
    const broken = [...vector];
    broken[7] = Number.NaN;
    expect(() => formatVectorLiteral(broken)).toThrow(/non-finite/);
  });
});

describe("mapSearchRows", () => {
  it("maps database columns and keeps null page or slide", () => {
    expect(mapSearchRows([row])).toEqual([hit]);
    expect(mapSearchRows([{ ...row, page: null, slide: 9 }])[0]).toMatchObject({
      page: null,
      slide: 9,
    });
  });
});

describe("retrieve", () => {
  it("returns nothing for a blank query without calling the provider", async () => {
    const embedQuery = vi.fn();
    const search = vi.fn();
    await expect(retrieve("   ", {}, 8, { embedQuery, search })).resolves.toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("embeds the trimmed query once and asks for the clamped count", async () => {
    const embedQuery = vi.fn(async () => vector);
    const search = vi.fn(async () => [hit]);

    const result = await retrieve("  churn dashboard  ", {}, 500, { embedQuery, search });

    expect(result).toEqual([hit]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith("churn dashboard");
    expect(search).toHaveBeenCalledWith({
      embedding: vector,
      queryText: "churn dashboard",
      scope: { industry: null, customer: null },
      matchCount: 50,
    });
  });

  it("passes a normalized scope to the search stage", async () => {
    const search = vi.fn(async (_input: SearchInput) => []);
    await retrieve("pricing", { industry: " airlines ", customer: "" }, 5, {
      embedQuery: async () => vector,
      search,
    });
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      scope: { industry: "airlines", customer: null },
      matchCount: 5,
    });
  });

  it("propagates provider failures instead of returning empty results", async () => {
    await expect(
      retrieve("pricing", {}, 8, {
        embedQuery: async () => {
          throw new Error("Embedding provider failed (429)");
        },
        search: async () => [],
      }),
    ).rejects.toThrow(/429/);
  });
});

describe("searchLibraryChunks", () => {
  it("sends the caller's filters and a vector literal to search_chunks", async () => {
    const rpc = vi.fn(async () => ({ data: [row], error: null }));
    const client = { rpc } as unknown as Parameters<typeof searchLibraryChunks>[0];

    const result = await searchLibraryChunks(
      client,
      "churn",
      { industry: "airlines", customer: "IndiGo" },
      6,
      async () => vector,
    );

    expect(result).toEqual([hit]);
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe("search_chunks");
    expect(args).toMatchObject({
      query_text: "churn",
      filter_industry: "airlines",
      filter_customer: "IndiGo",
      match_count: 6,
    });
    expect(String(args["query_embedding"]).startsWith("[0.5,0.5,")).toBe(true);
  });

  it("surfaces a database error instead of an empty result set", async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: "permission denied" } }),
    } as unknown as Parameters<typeof searchLibraryChunks>[0];

    await expect(searchLibraryChunks(client, "churn", {}, 8, async () => vector)).rejects.toThrow(
      /permission denied/,
    );
  });
});
