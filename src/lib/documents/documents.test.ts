import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { EMPTY_CONTEXT } from "../chat/scope";
import { fallbackOutline, parseOutline } from "./compose";
import { buildDraft, detectDocumentType } from "./intent";
import { renderDocx } from "./render/docx";
import { renderPdf } from "./render/pdf";
import { renderPptx } from "./render/pptx";
import type { DocumentOutline } from "./types";

const context = {
  ...EMPTY_CONTEXT,
  industries: ["bfsi"],
  clients: ["ACLEDA Bank"],
  personas: ["CIO / CTO"],
  sectors: ["Lending"],
};

const outline: DocumentOutline = {
  title: "ACLEDA Bank — pitch deck",
  subtitle: "PowerPoint deck · for CIO / CTO",
  sections: [
    { heading: "Why now", bullets: ["Lending is digitising fast.", "Our library has proof."] },
    { heading: "Approach", bullets: ["Start with one process."] },
  ],
};

const decoder = new TextDecoder();

describe("document intent", () => {
  it("detects a format only when there is also a build verb", () => {
    expect(detectDocumentType("Create a pitch deck for ACLEDA")).toBe("pptx");
    expect(detectDocumentType("create a pdf one-pager")).toBe("pdf");
    expect(detectDocumentType("Draft a word document about lending")).toBe("docx");
    expect(detectDocumentType("What have we delivered in BFSI?")).toBeNull();
    expect(detectDocumentType("delete the pitch deck")).toBeNull();
  });

  it("builds a draft from the selected context", () => {
    const draft = buildDraft({
      prompt: "Create a pitch deck",
      type: "pptx",
      context,
      industryNames: { bfsi: "BFSI" },
    });
    expect(draft.client).toBe("ACLEDA Bank");
    expect(draft.audience).toBe("CIO / CTO");
    expect(draft.industrySlug).toBe("bfsi");
    expect(draft.title).toContain("pitch deck");
    expect(draft.outline.length).toBeGreaterThan(3);
  });
});

describe("renderers", () => {
  it("writes a PDF with a header, xref and trailer", () => {
    const { bytes, pages } = renderPdf(outline);
    const text = decoder.decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("\nxref\n");
    expect(text).toContain("startxref");
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(pages).toBeGreaterThan(0);
  });

  it("writes a DOCX package with a document part", () => {
    const { bytes } = renderDocx(outline);
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toContain("word/document.xml");
    expect(decoder.decode(zip["[Content_Types].xml"]!)).toContain("wordprocessingml");
    expect(decoder.decode(zip["word/document.xml"]!)).toContain("Why now");
  });

  it("writes a PPTX with a cover slide per document and one per section", () => {
    const { bytes, pages } = renderPptx(outline);
    const zip = unzipSync(bytes);
    const slides = Object.keys(zip).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(pages).toBe(outline.sections.length + 1);
    expect(slides).toHaveLength(pages);
    expect(decoder.decode(zip["ppt/presentation.xml"]!)).toContain("<p:sldIdLst>");
    // The skeleton's master and layout must survive the rewrite.
    expect(Object.keys(zip)).toContain("ppt/slideMasters/slideMaster1.xml");
    expect(Object.keys(zip)).toContain("ppt/slideLayouts/slideLayout1.xml");
  });
});

describe("outline composition", () => {
  const draft = buildDraft({
    prompt: "Create a pitch deck",
    type: "pptx",
    context,
    industryNames: { bfsi: "BFSI" },
  });

  it("parses JSON even when the model wraps it in fences", () => {
    const raw = `\`\`\`json\n${JSON.stringify({
      title: "ACLEDA Bank — pitch deck",
      subtitle: "for the CIO",
      sections: [{ heading: "Why now", bullets: ["Because."] }],
    })}\n\`\`\``;
    const parsed = parseOutline(raw, draft);
    expect(parsed.title).toBe("ACLEDA Bank — pitch deck");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.bullets).toEqual(["Because."]);
  });

  it("rejects output with no usable sections", () => {
    expect(() => parseOutline('{"title":"x","sections":[]}', draft)).toThrow();
  });

  it("falls back to the confirmed headings when there is nothing to quote", () => {
    const fallback = fallbackOutline(draft, []);
    expect(fallback.sections.map((section) => section.heading)).toEqual(draft.outline);
    expect(fallback.sections.every((section) => section.bullets.length > 0)).toBe(true);
  });
});
