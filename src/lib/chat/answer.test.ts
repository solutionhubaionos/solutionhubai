import { describe, expect, it, vi } from "vitest";
import { buildContextBlocks, buildMessages, collectSources, generateAnswer } from "./answer";
import type { RetrievedChunk } from "../rag/search";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    contentId: "content-1",
    content: "Smart Verify cut onboarding checks from days to minutes.",
    page: null,
    slide: 4,
    heading: null,
    title: "MNC financial deck",
    fileName: "9b17a6e8-MNC_financial_040225_v1.0.pptx",
    filePath: "u/bfsi/deck.pptx",
    industry: "bfsi",
    customerName: null,
    vectorRank: 1,
    textRank: null,
    score: 0.03,
    ...overrides,
  };
}

describe("buildContextBlocks", () => {
  it("numbers passages and names the file and slide", () => {
    const blocks = buildContextBlocks([
      chunk(),
      chunk({ chunkId: "c2", contentId: "c2", slide: null, page: 7 }),
    ]);
    expect(blocks).toContain("[1] · MNC financial deck");
    expect(blocks).toContain("slide 4");
    expect(blocks).toContain("[2]");
    expect(blocks).toContain("page 7");
    expect(blocks).toContain("industry-wide");
  });
});

describe("collectSources", () => {
  it("keeps citation numbers aligned with the passage order", () => {
    const sources = collectSources([chunk(), chunk({ chunkId: "c2", contentId: "c2" })]);
    expect(sources.map((s) => s.citation)).toEqual([1, 2]);
    expect(sources[0]?.fileName).toBe("9b17a6e8-MNC_financial_040225_v1.0.pptx");
    expect(sources[0]?.snippet).toContain("Smart Verify");
  });
});

describe("buildMessages", () => {
  it("puts history between the system prompt and the grounded question", () => {
    const messages = buildMessages(
      "What did we do for MNC?",
      [chunk()],
      [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
    );
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toBe("Earlier question");
    expect(messages[2]?.content).toBe("Earlier answer");
    expect(messages[3]?.content).toContain("Library passages:");
    expect(messages[3]?.content).toContain("Question: What did we do for MNC?");
  });
});

describe("generateAnswer", () => {
  it("calls the chat endpoint with the model and returns the trimmed answer", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "  Answers in minutes [1].  " } }] }),
          { status: 200 },
        ),
    );

    const result = await generateAnswer([{ role: "user", content: "hi" }], {
      apiKey: "test-key",
      baseUrl: "https://gateway.test/v1/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.answer).toBe("Answers in minutes [1].");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://gateway.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.messages).toHaveLength(1);
  });

  it("throws when the provider returns no answer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
          status: 200,
        }),
    );
    await expect(
      generateAnswer([{ role: "user", content: "hi" }], {
        apiKey: "test-key",
        baseUrl: "https://gateway.test/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/empty answer/);
  });

  it("surfaces the provider status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      generateAnswer([{ role: "user", content: "hi" }], {
        apiKey: "test-key",
        baseUrl: "https://gateway.test/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
  });
});
