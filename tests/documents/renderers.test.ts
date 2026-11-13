import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";
import type { DocumentModel, SourceRecord } from "../../src/lib/documents/types";
import { renderDocx } from "../../src/lib/documents/render/docx";
import { renderPdf } from "../../src/lib/documents/render/pdf";
import { renderPptx } from "../../src/lib/documents/render/pptx";

const source = (
  id: string,
  title: string,
  page: number,
  slide: number | null,
  client: string,
): SourceRecord => ({
  chunkId: id,
  contentId: `doc-${id}`,
  title,
  fileName: `${title.toLowerCase().replace(/\s+/g, "-")}.pdf`,
  filePath: `library/${id}.pdf`,
  industry: "insurance",
  customerName: client,
  page,
  slide,
  heading: "Outcomes",
  contentType: "pdf",
  date: "2026-10-02",
});

const SOURCES = [
  source("chunk-1", "Zurich claims transformation", 3, null, "Zurich Insurance"),
  source("chunk-2", "Zurich claims transformation", null, 6, "Zurich Insurance"),
];

function proposalModel(): DocumentModel {
  return {
    mode: "proposal",
    format: "docx",
    cover: {
      title: "Zurich Insurance — Claims transformation",
      subtitle: "A proposal built from measured outcomes",
      client: "Zurich Insurance",
      industry: "Insurance",
      date: "11 November 2026",
      request: "Create a proposal for Zurich Insurance focused on claims cycle time.",
    },
    sections: [
      {
        id: "executive_summary",
        kind: "executive_summary",
        title: "Executive summary",
        blocks: [
          {
            type: "paragraph",
            text: "Claims assessment time fell from 14 days to 6 days across 12 markets after an AI triage workflow was deployed [1].",
            sources: ["chunk-1"],
          },
          {
            type: "bullet_list",
            items: [
              {
                text: "Manual rework dropped by 38% across the same period.",
                sources: ["chunk-1"],
              },
              {
                text: "Straight-through processing reached 61% of personal lines claims.",
                sources: ["chunk-1"],
              },
            ],
            sources: ["chunk-1"],
          },
          {
            type: "metrics",
            items: [
              {
                label: "Assessment time",
                value: "6",
                unit: "days",
                context: "Down from 14 days across 12 markets",
                source: "chunk-1",
              },
            ],
            sources: ["chunk-1"],
          },
        ],
        speakerNotes:
          "Lead with the measured cycle-time reduction and ask what the client's current baseline is.",
        flagged: false,
        warnings: [],
      },
      {
        id: "proof",
        kind: "proof",
        title: "Proof: measured outcomes",
        blocks: [
          {
            type: "table",
            caption: "Before and after the triage programme",
            headers: ["Metric", "Before", "After"],
            rows: [
              ["Assessment time", "14 days", "6 days"],
              ["Manual rework", "38%", "12%"],
            ],
            sources: ["chunk-1"],
          },
          {
            type: "quote",
            text: "Straight-through processing rose to 61% of personal lines claims within two quarters.",
            attribution: "Zurich claims transformation, page 3",
            source: "chunk-1",
          },
          {
            type: "callout",
            tone: "info",
            text: "The same operating model was designed to protect regulatory traceability in every market.",
            sources: ["chunk-1"],
          },
        ],
        speakerNotes:
          "Use the table to compare before and after, then invite the client to challenge the baseline.",
        flagged: false,
        warnings: [],
      },
      {
        id: "timeline",
        kind: "timeline",
        title: "Indicative timeline",
        blocks: [
          {
            type: "timeline",
            items: [
              {
                label: "Intake and triage",
                timeframe: "Weeks 1-8",
                detail: "Document intake, triage and the assessor dashboard go live.",
                sources: ["chunk-2"],
              },
              {
                label: "Fraud signals",
                timeframe: "Weeks 9-18",
                detail: "Fraud signals and supplier integration are added.",
                sources: ["chunk-2"],
              },
            ],
            sources: ["chunk-2"],
          },
          {
            type: "comparison",
            criteria: ["Time to first value", "Coverage"],
            options: [
              { name: "Pilot", values: ["8 weeks", "One market"] },
              { name: "Programme", values: ["18 weeks", "Twelve markets"] },
            ],
            sources: ["chunk-2"],
          },
        ],
        speakerNotes:
          "Walk through the two phases and the pilot option, then confirm the target go-live.",
        flagged: false,
        warnings: [],
      },
      {
        id: "solution",
        kind: "solution",
        title: "What we propose",
        blocks: [
          {
            type: "paragraph",
            text: "Move document intake into a shared service and give assessors one queue, while preserving market-level regulatory traceability [1].",
            sources: ["chunk-1"],
          },
          {
            type: "bullet_list",
            items: [
              { text: "One intake and triage queue for every market.", sources: ["chunk-1"] },
              { text: "A weekly quality review owned by operations.", sources: ["chunk-1"] },
            ],
            sources: ["chunk-1"],
          },
          {
            type: "callout",
            tone: "success",
            text: "Assessors keep the regulatory trail while handling more claims in the same day.",
            sources: ["chunk-1"],
          },
        ],
        speakerNotes:
          "Explain the operating-model change in plain language, then show where the client keeps control.",
        flagged: false,
        warnings: [],
      },
      {
        id: "deliverables",
        kind: "deliverables",
        title: "What you receive",
        blocks: [
          {
            type: "numbered_list",
            items: [
              {
                text: "A signed-off operating model and market rollout list.",
                sources: ["chunk-2"],
              },
              { text: "A working triage queue and assessor dashboard.", sources: ["chunk-2"] },
              { text: "A benefit tracker with a named owner.", sources: ["chunk-2"] },
            ],
            sources: ["chunk-2"],
          },
          {
            type: "paragraph",
            text: "Each output is reviewed with the client operations director before the next phase starts [2].",
            sources: ["chunk-2"],
          },
        ],
        speakerNotes: "Name each deliverable and the person who owns its sign-off.",
        flagged: false,
        warnings: [],
      },
    ],
    sources: SOURCES,
    openItems: ["Budget range"],
    warnings: [],
  };
}

function pitchModel(): DocumentModel {
  return {
    ...proposalModel(),
    mode: "pitch",
    format: "pptx",
    sections: proposalModel().sections.slice(0, 2),
  };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Every OOXML part must be well-formed XML, not merely contain expected strings. */
function expectWellFormed(bytes: Uint8Array): void {
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const result = XMLValidator.validate(decode(data));
    expect(result, `${name}: ${JSON.stringify(result)}`).toBe(true);
  }
}

describe("PDF renderer", () => {
  test("produces a multi-page PDF with a contents page for proposals", async () => {
    const { bytes, pages } = await renderPdf(proposalModel());
    expect(decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(bytes.byteLength).toBeGreaterThan(5000);
  });

  test("produces a landscape deck PDF for pitch mode", async () => {
    const { pages } = await renderPdf(pitchModel());
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});

describe("DOCX renderer", () => {
  const { bytes } = renderDocx(proposalModel());
  const parts = unzipSync(bytes);
  const documentXml = decode(parts["word/document.xml"] ?? new Uint8Array());

  test("writes real tables, lists and callouts", () => {
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("w:cantSplit");
    expect(documentXml).toContain("tblHeader");
  });

  test("writes a TOC field, header, footer and page fields", () => {
    expect(documentXml).toContain("TOC");
    expect(documentXml).toContain("w:headerReference");
    expect(documentXml).toContain("w:footerReference");
    const footer = decode(parts["word/footer1.xml"] ?? new Uint8Array());
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
  });

  test("packages numbering, settings and styles", () => {
    expect(parts["word/numbering.xml"]).toBeDefined();
    expect(parts["word/settings.xml"]).toBeDefined();
    expect(parts["word/styles.xml"]).toBeDefined();
    expect(decode(parts["word/settings.xml"] ?? new Uint8Array())).toContain("updateFields");
  });
});

describe("PPTX renderer", () => {
  const { bytes, pages } = renderPptx(pitchModel());
  const parts = unzipSync(bytes);
  const slideNames = Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));

  test("writes one slide per section plus cover and sources, with notes", () => {
    expect(slideNames.length).toBe(pages);
    expect(pages).toBeGreaterThanOrEqual(4);
    const coverNotes = decode(parts["ppt/notesSlides/notesSlide1.xml"] ?? new Uint8Array());
    expect(coverNotes).toContain("Open with the outcome");
    const sectionNotes = decode(parts["ppt/notesSlides/notesSlide2.xml"] ?? new Uint8Array());
    expect(sectionNotes).toContain("measured cycle-time reduction");
    expect(parts["ppt/notesMasters/notesMaster1.xml"]).toBeDefined();
  });

  test("writes a native table and a source footnote", () => {
    const allSlides = slideNames.map((name) => decode(parts[name] ?? new Uint8Array())).join("\n");
    expect(allSlides).toContain("<a:tbl>");
    expect(allSlides).toContain("Source:");
    expect(allSlides).toContain("Zurich claims transformation");
  });

  test("every PPTX XML part is well-formed", () => {
    expectWellFormed(bytes);
  });
});

describe("DOCX package", () => {
  test("every DOCX XML part is well-formed", () => {
    expectWellFormed(renderDocx(proposalModel()).bytes);
  });
});
