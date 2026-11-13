/**
 * End-to-end export tests for the failure that motivated this work: a wizard
 * selection ("Adani Airports / Airlines") leaked into a deck about an
 * InterGlobe/IndiGo collaboration, every section retrieved nothing and the
 * export shipped "[To be confirmed]" slides plus a blank PDF.
 *
 * The same fixture provider and chunk library drive the real pipeline, so these
 * assertions cover brief -> confirmed outline -> evidence -> generation -> gate
 * -> PPTX/PDF rendering without a database or network.
 */
import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { buildDocument, classifySectionFailure } from "../src/lib/documents/build";
import { buildExportBrief } from "../src/lib/documents/brief";
import { outlineFor } from "../src/lib/documents/intent";
import { planOutline } from "../src/lib/documents/outline";
import { sectionOutputSchema } from "../src/lib/documents/blocks";
import { completeText, completeWithBudget } from "../src/lib/documents/provider";
import type { LlmBudget } from "../src/lib/documents/llm-budget";
import { renderPdf } from "../src/lib/documents/render/pdf";
import { renderPptx } from "../src/lib/documents/render/pptx";
import type { ExportHistoryMessage } from "../src/lib/documents/brief";
import { CHUNKS, createMockFetch, createMockSupabase, deckHistory, draftFor } from "./fixtures";

const PROVIDER = {
  apiKey: "test",
  baseUrl: "https://mock.local",
  fetchImpl: createMockFetch(),
};

function indigoHistory(): ExportHistoryMessage[] {
  return [
    {
      role: "user",
      content:
        "Talk me through the InterGlobe, IndiGo and Oberoi Hotels partnership, the Fly++ SPV, and how a JV compares with a tech-partner model.",
    },
    {
      role: "assistant",
      content:
        "InterGlobe Aviation consolidated crew rosters into one control tower; roster publication moved from 48 hours to 9 hours before departure [1].",
      sources: [{ title: "InterGlobe crew operations", contentId: "doc-i", chunkId: "chunk-i1" }],
    },
    {
      role: "user",
      content: "Create a pitch deck for this collaboration between InterGlobe and IndiGo.",
    },
  ];
}

describe("export on the InterGlobe/IndiGo scenario", () => {
  const draft = draftFor({
    mode: "pitch",
    type: "pptx",
    client: "Adani Airports",
    industry: "Airlines",
    title: "Adani Airports — pitch deck",
  });

  test("the brief follows the conversation, not the wizard selections", async () => {
    const result = await buildDocument({
      draft,
      history: indigoHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
      now: new Date("2026-11-11T00:00:00Z"),
    });

    expect(result.trace.brief.subject).toContain("InterGlobe");
    expect(result.trace.brief.subject).toContain("IndiGo");
    expect(result.trace.brief.subject).not.toContain("Adani");
    expect(result.trace.brief.client).not.toBe("Adani Airports");
    expect(result.model.cover.title).not.toContain("Adani");
    // The deck is about a three-party collaboration, and Zurich is reference
    // material — not the single wizard client/industry pair.
    expect(result.trace.brief.partiesInvolved).toEqual(
      expect.arrayContaining(["Adani Airports", "IndiGo", "InterGlobe Hotels"]),
    );
    expect(result.trace.brief.keyEntities).toEqual(expect.arrayContaining(["Zurich Airport"]));
  });

  test("the confirm-card outline is planned from the conversation, not the sector template", async () => {
    const brief = await buildExportBrief(draft, indigoHistory(), PROVIDER);
    const planned = await planOutline(brief, draft, PROVIDER);
    const template = outlineFor("pptx", {
      industry: "Airlines",
      sector: "Airlines",
      audience: "COO",
    });

    const titles = planned.plans.map((plan) => plan.title);
    expect(titles).not.toEqual(template);
    expect(titles).not.toContain("Our point of view");
    expect(titles).toHaveLength(8);

    // What the card shows is what the builder uses, verbatim.
    const built = await buildDocument({
      draft: { ...draft, outline: titles },
      history: indigoHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
    });
    expect(built.model.sections.map((section) => section.title)).toEqual(titles);
  });

  test("the confirmed outline is generated exactly and no section is a placeholder", async () => {
    const result = await buildDocument({
      draft,
      history: indigoHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
    });

    expect(result.model.sections.map((section) => section.title)).toEqual(draft.outline);
    expect(result.gate.sections).toHaveLength(draft.outline.length);
    expect(result.gate.sections.every((section) => section.passages > 0)).toBe(true);
    expect(result.gate.blocked).toBe(false);
    expect(JSON.stringify(result.model.sections)).not.toContain("[To be confirmed]");
  });

  test("strips mid-sentence [To be confirmed] notes from supported sections", async () => {
    const base = createMockFetch();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init);
      const body = (await response.json()) as {
        blocks?: Record<string, unknown>[];
        speakerNotes?: string;
      };
      if (Array.isArray(body.blocks)) {
        body.blocks.push({
          type: "callout",
          text: "Commercial terms are [To be confirmed] pending pricing.",
          sources: ["S1"],
        });
        body.speakerNotes = `${body.speakerNotes ?? ""} Pricing remains [To be confirmed].`;
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await buildDocument({
      draft,
      history: indigoHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: { ...PROVIDER, fetchImpl },
    });

    expect(JSON.stringify(result.model.sections)).not.toContain("[To be confirmed]");
  });

  test("renders a real PPTX and PDF without placeholder slides", async () => {
    const result = await buildDocument({
      draft,
      history: indigoHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
    });

    const pptx = renderPptx(result.model);
    const parts = unzipSync(pptx.bytes);
    const slideText = Object.keys(parts)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => new TextDecoder().decode(parts[name]))
      .join("\n");
    expect(slideText).not.toContain("[To be confirmed]");
    // Cover plus every confirmed section; the deck carries no sources slide.
    expect(pptx.pages).toBeGreaterThanOrEqual(result.model.sections.length + 1);

    const pdf = await renderPdf(result.model);
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-");
    expect(pdf.pages).toBeGreaterThanOrEqual(result.model.sections.length + 2);
  });
});

describe("generation robustness", () => {
  test("a callout without a tone defaults to info", () => {
    const parsed = sectionOutputSchema.parse({
      blocks: [
        { type: "callout", text: "A grounded note without a tone.", sources: ["S1"] },
        { type: "callout", tone: "danger", text: "An unknown tone is coerced.", sources: ["S1"] },
      ],
    });
    expect(parsed.blocks[0]).toMatchObject({ type: "callout", tone: "info" });
    expect(parsed.blocks[1]).toMatchObject({ type: "callout", tone: "info" });
  });

  test("an empty completion is retried and recovers", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const content = calls < 3 ? "" : "recovered";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const text = await completeText(
      [{ role: "user", content: "write a section" }],
      {
        apiKey: "test",
        baseUrl: "https://mock.local",
        fetchImpl,
        attempts: 3,
        sleepImpl: async () => undefined,
      },
      32,
      0,
    );

    expect(text).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("a truncated completion retries with a larger budget and thinking off", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: bodies.length === 1 ? '{"blocks":[' : '{"blocks":[]}' },
              finish_reason: bodies.length === 1 ? "length" : "stop",
            },
          ],
          usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3900 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const budget: LlmBudget = {
      type: "SECTION",
      thinking: true,
      maxTokens: 4000,
      extraBody: {},
      timeoutMs: 1_000,
      attempts: 2,
    };
    await completeWithBudget(
      [{ role: "user", content: "write a section" }],
      {
        apiKey: "test",
        baseUrl: "https://mock.local",
        fetchImpl,
        sleepImpl: async () => undefined,
      },
      budget,
      0,
    );

    expect(bodies[0]?.max_tokens).toBe(4000);
    expect(bodies[0]?.chat_template_kwargs).toBeUndefined();
    expect(bodies[1]?.max_tokens).toBe(8000);
    expect(bodies[1]?.chat_template_kwargs).toEqual({ thinking: false });
  });

  test("a client error is not retried", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    await expect(
      completeText(
        [{ role: "user", content: "write a section" }],
        {
          apiKey: "test",
          baseUrl: "https://mock.local",
          fetchImpl,
          attempts: 3,
          sleepImpl: async () => undefined,
        },
        32,
        0,
      ),
    ).rejects.toThrow(/failed \(400\)/);
    expect(calls).toBe(1);
  });
});

describe("failure reasons", () => {
  test("separates provider failures from schema failures", () => {
    expect(classifySectionFailure(new Error("Answer provider returned an empty completion"))).toBe(
      "provider_error",
    );
    expect(classifySectionFailure(new Error("Provider failed (503)"))).toBe("provider_error");
    expect(classifySectionFailure(new Error("Invalid JSON: unexpected token"))).toBe(
      "schema_invalid",
    );
  });
});

describe("quality gate", () => {
  test("refuses an all-empty export instead of writing placeholders", async () => {
    const result = await buildDocument({
      draft: draftFor(),
      history: deckHistory(),
      client: createMockSupabase([], []),
      provider: PROVIDER,
    });

    expect(result.gate.blocked).toBe(true);
    expect(result.gate.coverage).toBe(0);
    expect(result.gate.message).toContain("No library passages");
    expect(result.model.sections).toHaveLength(0);
    expect(result.gate.sections.every((section) => section.reason === "no_passages")).toBe(true);
  });

  test("partial consent drops empty sections rather than rendering them", async () => {
    const result = await buildDocument({
      draft: { ...draftFor(), allowPartial: true },
      history: deckHistory(),
      client: createMockSupabase([], []),
      provider: PROVIDER,
    });

    expect(result.model.sections).toHaveLength(0);
    expect(result.gate.blocked).toBe(true);
    expect(JSON.stringify(result.model.sections)).not.toContain("[To be confirmed]");
  });
});
