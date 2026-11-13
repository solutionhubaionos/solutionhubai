/**
 * Regression guard for the original failure mode: an "export" made of two or
 * three static headings and no content. Fails when the model has too few
 * meaningful blocks, an empty section, or a section title copied straight from
 * the old hard-coded outline.
 */
import { describe, expect, test } from "bun:test";
import { buildDocument } from "../src/lib/documents/build";
import { outlineFor } from "../src/lib/documents/intent";
import type { DocumentModel } from "../src/lib/documents/types";
import { CHUNKS, createMockFetch, createMockSupabase, deckHistory, draftFor } from "./fixtures";

const STATIC_DECK_HEADINGS = new Set(
  outlineFor("pptx", { industry: null, sector: null, audience: null }),
);
const STATIC_PROPOSAL_HEADINGS = new Set(
  outlineFor("docx", { industry: null, sector: null, audience: null }),
);

export function regressionIssues(model: DocumentModel): string[] {
  const issues: string[] = [];
  const content = model.sections.flatMap((section) =>
    section.blocks.filter((block) => block.type !== "heading"),
  );
  if (content.length < 16) issues.push(`only ${content.length} content blocks`);

  const characters = content.reduce((sum, block) => sum + JSON.stringify(block).length, 0);
  if (characters < 1500) issues.push(`only ${characters} characters of content`);

  for (const section of model.sections) {
    if (section.blocks.length === 0) issues.push(`empty section: ${section.title}`);
    if (!section.blocks.some((block) => block.type !== "heading")) {
      issues.push(`heading-only section: ${section.title}`);
    }
  }

  const staticHeadings = model.mode === "pitch" ? STATIC_DECK_HEADINGS : STATIC_PROPOSAL_HEADINGS;
  const copied = model.sections.filter((section) => staticHeadings.has(section.title));
  if (copied.length > 0) {
    issues.push(`static headings: ${copied.map((section) => section.title).join(", ")}`);
  }

  return issues;
}

describe("export regression", () => {
  test("a real export has substantive content and no hard-coded skeleton", async () => {
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: { apiKey: "test", baseUrl: "https://mock.local", fetchImpl: createMockFetch() },
    });

    expect(result.model.sections.length).toBe(draftFor().outline.length);
    expect(result.gate.blocked).toBe(false);
    expect(regressionIssues(result.model)).toEqual([]);
  });

  test("the guard rejects the old static outline", () => {
    const staticModel: DocumentModel = {
      mode: "pitch",
      format: "pptx",
      cover: {
        title: "Deck",
        subtitle: "",
        client: null,
        industry: null,
        date: "2026-11-11",
        request: "",
      },
      sections: [
        {
          id: "why",
          kind: "problem",
          title: "Why the market needs this now",
          blocks: [{ type: "heading", level: 2, text: "Why the market needs this now" }],
          speakerNotes: "",
          flagged: false,
          warnings: [],
        },
      ],
      sources: [],
      openItems: [],
      warnings: [],
    };
    expect(regressionIssues(staticModel).length).toBeGreaterThan(0);
  });
});
