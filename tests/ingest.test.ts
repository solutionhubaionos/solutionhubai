/**
 * Ingest context: a passage must know whose deck it came from. The header is
 * stored in `content` (so the generated tsv indexes it) and is the text that is
 * embedded — no second, richer copy that retrieval never sees.
 */
import { describe, expect, test } from "bun:test";
import { buildChunkRows, chunkContextHeader, embeddingTexts } from "../src/lib/rag/ingest";

const FILE = "250317_ZRH_Airport_AIonOS_v1.0.pptx";

describe("contextual chunk headers", () => {
  test("builds the header from customer, industry, document and slide", () => {
    expect(
      chunkContextHeader(
        { slide: 4 },
        {
          title: "Zurich Airport AI on OS",
          customerName: "Zurich Airport",
          industry: "airports",
        },
      ),
    ).toBe(
      "Customer: Zurich Airport | Industry: airports | Document: Zurich Airport AI on OS | Slide: 4",
    );
  });

  test("stores the header at the top of the passage", () => {
    const rows = buildChunkRows(
      "pptx",
      [
        {
          text: "The airport reports a single view of turnarounds across three terminals and 41 gates.",
          pageOrSlide: 4,
          heading: "Operating layer",
        },
      ],
      FILE,
      { title: "Zurich Airport AI on OS", customerName: "Zurich Airport", industry: "airports" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toStartWith(
      "Customer: Zurich Airport | Industry: airports | Document: Zurich Airport AI on OS | Slide: 4",
    );
    expect(rows[0]?.content).toContain("single view of turnarounds");
  });

  test("embeds the same contextual text without a duplicate file prefix", () => {
    const rows = buildChunkRows(
      "pptx",
      [{ text: "A passage long enough to survive the minimum chunk size check.", pageOrSlide: 7 }],
      FILE,
      { title: "250317_ZRH_Airport_AIonOS_v1.0", customerName: "Zurich Airport" },
    );
    const [text] = embeddingTexts(rows, FILE);

    expect(text).toBe(rows[0]?.content);
    // The document name appears once, in the contextual header, not again as a
    // synthetic "file · slide" prefix.
    expect(text?.split("250317_ZRH")).toHaveLength(2);
  });

  test("leaves chunks without provenance unchanged", () => {
    const rows = buildChunkRows(
      "pdf",
      [{ text: "Plain passage with no known customer.", pageOrSlide: 2 }],
      "unknown.pdf",
    );
    expect(rows[0]?.content).toBe("Plain passage with no known customer.");
  });
});
