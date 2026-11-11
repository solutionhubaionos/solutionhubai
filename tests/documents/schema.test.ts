import { describe, expect, test } from "bun:test";
import { resolveBlocks, sectionOutputSchema } from "../../src/lib/documents/blocks";

describe("section schemas", () => {
  test("accepts a sourced paragraph and maps S-labels to chunk ids", () => {
    const parsed = sectionOutputSchema.parse({
      blocks: [{ type: "paragraph", text: "A concrete, sourced statement.", sources: ["S1"] }],
      speakerNotes: "Two sentences of detail.",
      openItems: [],
    });
    const resolved = resolveBlocks(parsed.blocks, new Map([["S1", "chunk-1"]]));
    expect(resolved.blocks).toHaveLength(1);
    expect(resolved.blocks[0]).toMatchObject({ type: "paragraph", sources: ["chunk-1"] });
  });

  test("drops a block whose label the server never issued", () => {
    const parsed = sectionOutputSchema.parse({
      blocks: [
        { type: "paragraph", text: "Grounded statement with a real source.", sources: ["S9"] },
        { type: "paragraph", text: "Also grounded in a supplied passage.", sources: ["S2"] },
      ],
    });
    const resolved = resolveBlocks(parsed.blocks, new Map([["S2", "chunk-2"]]));
    expect(resolved.blocks).toHaveLength(1);
    expect(resolved.blocks[0]).toMatchObject({ sources: ["chunk-2"] });
    expect(resolved.dropped).toBe(1);
  });

  test("rejects a metric without a source", () => {
    const result = sectionOutputSchema.safeParse({
      blocks: [{ type: "metrics", items: [{ label: "Cycle time", value: "6" }], sources: ["S1"] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a block type outside the allowed set", () => {
    const result = sectionOutputSchema.safeParse({
      blocks: [{ type: "image", url: "https://example.com/x.png" }],
    });
    expect(result.success).toBe(false);
  });

  test("accepts a table with a caption and sources", () => {
    const result = sectionOutputSchema.safeParse({
      blocks: [
        {
          type: "table",
          caption: "Before and after",
          headers: ["Metric", "Before", "After"],
          rows: [
            ["Cycle time", "14 days", "6 days"],
            ["Rework", "38%", "12%"],
          ],
          sources: ["S1"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
