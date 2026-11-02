import { describe, expect, it, vi } from "vitest";
import { buildChunkRows, embedTexts, hashChunkContents } from "./ingest";

const section = (text: string, pageOrSlide: number | null = 1) => ({
  text,
  pageOrSlide,
  heading: null,
});

function fakeEmbeddingProvider(dimensions = 1536) {
  const calls: Array<{ model: string; dimensions: number | undefined; inputs: string[] }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      model: string;
      input: string[];
      dimensions?: number;
    };
    calls.push({ model: body.model, dimensions: body.dimensions, inputs: body.input });
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: new Array(dimensions).fill(text.length),
        })),
        usage: { prompt_tokens: body.input.length, cost: 0.001 },
      }),
      { status: 200 },
    );
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("buildChunkRows", () => {
  it("maps PDF pages into the page column", () => {
    const rows = buildChunkRows("pdf", [section("Alpha beta gamma.", 3)], "a.pdf");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.page).toBe(3);
    expect(rows[0]?.slide).toBeNull();
    expect(rows[0]?.chunk_index).toBe(0);
    expect(rows[0]?.content).toContain("Alpha beta gamma.");
  });

  it("maps PowerPoint slides into the slide column", () => {
    const rows = buildChunkRows("pptx", [section("Slide body text.", 7)], "a.pptx");
    expect(rows[0]?.slide).toBe(7);
    expect(rows[0]?.page).toBeNull();
  });

  it("leaves both columns empty for Word documents", () => {
    const rows = buildChunkRows("docx", [section("Word body text.")], "a.docx");
    expect(rows[0]?.page).toBeNull();
    expect(rows[0]?.slide).toBeNull();
  });

  it("numbers chunks consecutively across sections", () => {
    const rows = buildChunkRows(
      "pdf",
      [section("First page text.", 1), section("Second page text.", 2)],
      "a.pdf",
    );
    expect(rows.map((row) => row.chunk_index)).toEqual([0, 1]);
    expect(rows.map((row) => row.estimated_tokens)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(rows.every((row) => row.estimated_tokens > 0)).toBe(true);
  });

  it("drops empty sections instead of writing blank chunks", () => {
    const rows = buildChunkRows("pdf", [section("   ", 1), section("Real text.", 2)], "a.pdf");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.page).toBe(2);
  });
});

describe("hashChunkContents", () => {
  it("is stable for identical text", () => {
    expect(hashChunkContents(["a", "b"])).toBe(hashChunkContents(["a", "b"]));
  });

  it("changes when text changes", () => {
    expect(hashChunkContents(["a", "b"])).not.toBe(hashChunkContents(["a", "c"]));
  });

  it("is order sensitive", () => {
    expect(hashChunkContents(["a", "b"])).not.toBe(hashChunkContents(["b", "a"]));
  });
});

describe("embedTexts", () => {
  it("batches at the provider limit and preserves order", async () => {
    const { calls, fetchImpl } = fakeEmbeddingProvider();
    const texts = Array.from({ length: 250 }, (_, index) => "x".repeat(index + 1));
    const result = await embedTexts(texts, {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/",
      fetchImpl,
    });

    expect(calls.map((call) => call.inputs.length)).toEqual([100, 100, 50]);
    expect(calls[0]?.model).toBe("qwen/qwen3-embedding-8b");
    expect(calls[0]?.dimensions).toBe(1536);
    expect(result.embeddings).toHaveLength(250);
    // Fake vectors encode input length, so order is observable.
    expect(result.embeddings[0]?.[0]).toBe(1);
    expect(result.embeddings[249]?.[0]).toBe(250);
  });

  it("never exceeds 100 inputs per call even when asked to", async () => {
    const { calls, fetchImpl } = fakeEmbeddingProvider();
    await embedTexts(["a", "b", "c"], {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      batchSize: 500,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inputs).toHaveLength(3);
  });

  it("rejects vectors of the wrong dimension", async () => {
    const { fetchImpl } = fakeEmbeddingProvider(8);
    await expect(
      embedTexts(["a"], {
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        dimensions: 1536,
        fetchImpl,
      }),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it("surfaces provider errors with their status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], { apiKey: "test-key", baseUrl: "https://example.test/v1", fetchImpl }),
    ).rejects.toThrow(/429.*rate limited/);
  });

  it("estimates cost when batched responses omit it", async () => {
    // Verified provider behaviour: 100-input responses carry usage without cost.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((_text, index) => ({ index, embedding: new Array(1536).fill(0) })),
          usage: { prompt_tokens: 2000 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await embedTexts(["a", "b"], {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      fetchImpl,
    });
    expect(result.costEstimated).toBe(true);
    expect(result.costUsd).toBeCloseTo(2000 * 1e-7, 12);
  });

  it("rejects malformed provider payloads", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], { apiKey: "test-key", baseUrl: "https://example.test/v1", fetchImpl }),
    ).rejects.toThrow(/non-JSON/i);
  });

  it("aggregates token and cost usage across batches", async () => {
    const { fetchImpl } = fakeEmbeddingProvider();
    const result = await embedTexts(["a", "b", "c"], {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      batchSize: 2,
      fetchImpl,
    });
    expect(result.promptTokens).toBe(3);
    expect(result.costUsd).toBeCloseTo(0.002, 6);
    expect(result.costEstimated).toBe(false);
  });
});
