import { describe, expect, test } from "bun:test";
import type { Block, DocumentSection, ExportBrief } from "../src/lib/documents/types";
import type { SectionPlan } from "../src/lib/documents/outline";
import { sanitizeSection, validateModel, validateSection } from "../src/lib/documents/validate";

const chunks = new Map<string, string>([
  [
    "chunk-1",
    "Onboarding time fell from 14 to 6 days, and manual rework dropped by 38% across 12 markets.",
  ],
  ["chunk-2", "The programme covered 2,400 assessors and ran for eight weeks."],
]);

const plan: SectionPlan = {
  id: "proof",
  kind: "proof",
  title: "Proof",
  goal: "Show outcomes.",
  query: "proof outcomes",
  minChars: 40,
  wantsNumbers: true,
};

const brief: ExportBrief = {
  documentTitle: "Proposal",
  request: "Build a proposal",
  mode: "proposal",
  client: "Zurich Insurance",
  industry: "insurance",
  sector: null,
  audience: null,
  problem: null,
  goals: [],
  constraints: [],
  budget: null,
  timeline: null,
  tone: "professional",
  include: [],
  exclude: [],
  decisions: [],
  citedDocuments: [],
  chatFigures: ["99%"],
  openItems: [],
};

function section(blocks: Block[]): DocumentSection {
  return {
    id: "proof",
    kind: "proof",
    title: "Proof",
    blocks,
    speakerNotes: "",
    flagged: false,
    warnings: [],
  };
}

const paragraph: Block = {
  type: "paragraph",
  text: "Onboarding time fell from 14 to 6 days across 12 markets.",
  sources: ["chunk-1"],
};

describe("section validation", () => {
  test("accepts grounded content", () => {
    const check = validateSection(plan, section([paragraph]), chunks, brief);
    expect(check.errors).toEqual([]);
  });

  test("rejects a metric whose value is not in the cited passage", () => {
    const metric: Block = {
      type: "metrics",
      items: [{ label: "Saving", value: "42", unit: "%", source: "chunk-1" }],
      sources: ["chunk-1"],
    };
    const check = validateSection(plan, section([paragraph, metric]), chunks, brief);
    expect(check.errors.join(" ")).toContain("not in its cited passage");
  });

  test("flags a chat figure that the source does not support", () => {
    const inflated: Block = {
      type: "paragraph",
      text: "The programme improved efficiency by 99%.",
      sources: ["chunk-1"],
    };
    const check = validateSection(plan, section([paragraph, inflated]), chunks, brief);
    expect(check.errors.join(" ")).toContain("99%");
    expect(check.conflicts).toContain("99%");
  });

  test("rejects a quote that is not verbatim", () => {
    const quote: Block = {
      type: "quote",
      text: "This sentence never appeared in the source document at all.",
      attribution: "Zurich claims transformation",
      source: "chunk-1",
    };
    const check = validateSection(plan, section([paragraph, quote]), chunks, brief);
    expect(check.errors.join(" ")).toContain("not verbatim");
  });

  test("rejects a table with a mismatched row", () => {
    const table: Block = {
      type: "table",
      headers: ["Metric", "Before", "After"],
      rows: [["Cycle time", "14 days"]],
      sources: ["chunk-1"],
    };
    const check = validateSection(plan, section([paragraph, table]), chunks, brief);
    expect(check.errors.join(" ")).toContain("column count");
  });

  test("rejects a section made only of headings", () => {
    const check = validateSection(
      plan,
      section([{ type: "heading", level: 2, text: "Subsection" }]),
      chunks,
      brief,
    );
    expect(check.errors.join(" ")).toContain("no content blocks");
  });

  test("sanitises unsupported metrics but keeps grounded prose", () => {
    const metric: Block = {
      type: "metrics",
      items: [{ label: "Saving", value: "42", unit: "%", source: "chunk-1" }],
      sources: ["chunk-1"],
    };
    const result = sanitizeSection(plan, section([paragraph, metric]), chunks, brief);
    expect(result.section.blocks).toHaveLength(1);
    expect(result.section.blocks[0]).toMatchObject({ type: "paragraph" });
    expect(result.removed).toBe(1);
  });

  test("replaces a wholly unsupported section with a marked placeholder", () => {
    const bad: Block = {
      type: "paragraph",
      text: "Invented claim with 77% improvement.",
      sources: ["chunk-1"],
    };
    const result = sanitizeSection(plan, section([bad]), chunks, brief);
    expect(result.section.flagged).toBe(true);
    expect(result.section.blocks[0]).toMatchObject({ type: "callout" });
    expect(JSON.stringify(result.section.blocks)).toContain("[To be confirmed]");
  });
});

describe("document validation", () => {
  const base: DocumentSection = {
    ...section([paragraph]),
    id: "one",
    kind: "proof",
    title: "Proof",
  };

  test("detects duplicate section headings", () => {
    const model = {
      mode: "proposal" as const,
      format: "docx" as const,
      cover: {
        title: "T",
        subtitle: "S",
        client: null,
        industry: null,
        date: "2026-11-11",
        request: "",
      },
      sections: [base, { ...base, id: "two" }],
      sources: [
        {
          chunkId: "chunk-1",
          contentId: "doc",
          title: "Doc",
          fileName: "doc.pdf",
          filePath: "doc.pdf",
          industry: "insurance",
          customerName: null,
          page: 1,
          slide: null,
          heading: null,
        },
      ],
      openItems: [],
      warnings: [],
    };
    const result = validateModel(model, chunks);
    expect(result.errors.join(" ")).toContain("duplicate section heading");
  });
});
