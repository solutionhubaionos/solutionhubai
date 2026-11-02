import { describe, expect, it } from "vitest";
import { chunkSections, estimateTokens } from "./chunk";

describe("chunkSections", () => {
  it("keeps short sections whole and preserves page, heading, index and source", () => {
    const chunks = chunkSections(
      [
        { text: "First page.", pageOrSlide: 1 },
        { text: "Overview body.", pageOrSlide: 2, heading: "Overview" },
      ],
      { sourceFile: "deck.pptx" },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      pageOrSlide: 1,
      heading: null,
      sourceFile: "deck.pptx",
    });
    expect(chunks[1]).toMatchObject({
      chunkIndex: 1,
      pageOrSlide: 2,
      heading: "Overview",
      sourceFile: "deck.pptx",
    });
    expect(chunks[1]?.content).toBe("Overview\n\nOverview body.");
  });

  it("never merges separate pages or slides", () => {
    const chunks = chunkSections(
      [
        { text: "Page one.", pageOrSlide: 1 },
        { text: "Page two.", pageOrSlide: 2 },
        { text: "Page three.", pageOrSlide: 3 },
      ],
      { sourceFile: "report.pdf" },
    );

    expect(chunks.map((chunk) => chunk.pageOrSlide)).toEqual([1, 2, 3]);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
  });

  it("splits long text and repeats the tail of the previous chunk", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `Sentence ${index} explains the proposal in enough detail to fill space.`,
    ).join(" ");
    const chunks = chunkSections([{ text, pageOrSlide: 7 }], {
      sourceFile: "long.pdf",
      targetTokens: 150,
      overlapTokens: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.pageOrSlide === 7)).toBe(true);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));

    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const lastWords = (first?.content ?? "").split(/\s+/).slice(-3).join(" ");
    expect(second?.content).toContain(lastWords);
  });

  it("splits a single oversized paragraph without exceeding the target", () => {
    const text = Array.from({ length: 400 }, (_, index) => `token${index}`).join(" ");
    const chunks = chunkSections([{ text }], {
      sourceFile: "scan.pdf",
      targetTokens: 100,
      overlapTokens: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => estimateTokens(chunk.content) <= 100)).toBe(true);
  });

  it("keeps the heading on every chunk of a long section", () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `Pricing paragraph ${index} contains enough words to be split.`,
    ).join(" ");
    const chunks = chunkSections([{ text, pageOrSlide: 3, heading: "Pricing" }], {
      sourceFile: "proposal.docx",
      targetTokens: 100,
      overlapTokens: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.startsWith("Pricing\n\n"))).toBe(true);
  });

  it("skips sections with no extractable text", () => {
    const chunks = chunkSections(
      [{ text: "  \n\n " }, { text: "" }, { text: "Real text.", pageOrSlide: 9 }],
      { sourceFile: "mixed.pdf" },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[0]?.pageOrSlide).toBe(9);
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345")).toBe(2);
  });
});
