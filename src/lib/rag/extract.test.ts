import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractDocument, isLowText, slideXmlToText } from "./extract";

const SLIDE_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function zip(parts: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(parts).map(([path, text]) => [path, strToU8(text)])),
  );
}

// A deck shaped like the known-bad library files: valid slide XML, broken image rels.
const brokenDeck = zip({
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  "ppt/slides/slide1.xml": `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>
    <a:p><a:r><a:t>Acme Energy &amp; Utilities</a:t></a:r></a:p>
    <a:p><a:r><a:t>Q3 pipeline review</a:t></a:r></a:p>
  </p:spTree></p:cSld></p:sld>`,
  "ppt/slides/_rels/slide1.xml.rels": '<Relationships><Relationship Target="../media/image1.png"',
  "ppt/slides/slide2.xml": `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>
    <a:p><a:r><a:t>Roadmap</a:t></a:r></a:p>
  </p:spTree></p:cSld></p:sld>`,
  "ppt/slides/slide3.xml": `<p:sld ${SLIDE_NS}><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>`,
  "ppt/notesSlides/notesSlide1.xml": `<p:notes ${SLIDE_NS}>
    <a:p><a:r><a:t>Mention the new logo.</a:t></a:r></a:p>
  </p:notes>`,
  "ppt/notesSlides/_rels/notesSlide1.xml.rels":
    '<Relationships><Relationship Target="../slides/slide2.xml"/></Relationships>',
});

const docx = zip({
  "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  </Types>`,
  "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  </Relationships>`,
  "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  </Relationships>`,
  "word/styles.xml": `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
    <w:style w:type="paragraph" w:styleId="SectionHeading"><w:name w:val="Section Heading"/></w:style>
  </w:styles>`,
  "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pricing</w:t></w:r></w:p>
      <w:p><w:r><w:t>Enterprise plan costs $50k.</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Timeline</w:t></w:r></w:p>
      <w:p><w:r><w:t>Six weeks from kickoff.</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="SectionHeading"/></w:pPr><w:r><w:t>Appendix</w:t></w:r></w:p>
      <w:p><w:r><w:t>Extra details are in the appendix.</w:t></w:r></w:p>
    </w:body>
  </w:document>`,
});

describe("extractDocument", () => {
  it("extracts PPTX text while ignoring a broken image relationship", async () => {
    const result = await extractDocument("known-broken.pptx", "", brokenDeck);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sections.map((section) => section.pageOrSlide)).toEqual([1, 2, 3]);
    expect(result.document.sections[0]?.text).toBe("Acme Energy & Utilities\nQ3 pipeline review");
    expect(result.document.sections[1]?.text).toBe("Roadmap\n\nNotes: Mention the new logo.");
    expect(result.document.emptyUnits).toEqual([{ pageOrSlide: 3, heading: null }]);
    expect(result.document.warnings).toEqual([]);
  });

  it("keeps DOCX headings as section boundaries", async () => {
    const result = await extractDocument("proposal.docx", "", docx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sections).toEqual([
      { text: "Enterprise plan costs $50k.", pageOrSlide: null, heading: "Pricing" },
      { text: "Six weeks from kickoff.", pageOrSlide: null, heading: "Timeline" },
      { text: "Extra details are in the appendix.", pageOrSlide: null, heading: "Appendix" },
    ]);
    expect(result.document.emptyUnits).toEqual([]);
  });

  it("reports a corrupt PowerPoint instead of throwing", async () => {
    const result = await extractDocument("broken.pptx", "", strToU8("not a zip"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.format).toBe("pptx");
    expect(result.error).toBeTruthy();
  });

  it("marks video and images unsupported rather than failed", async () => {
    await expect(extractDocument("demo.mp4", "video/mp4", new Uint8Array())).resolves.toEqual({
      ok: false,
      format: "video",
      error: "Unsupported format: video",
    });
    await expect(extractDocument("scan.png", "image/png", new Uint8Array())).resolves.toEqual({
      ok: false,
      format: "image",
      error: "Unsupported format: image",
    });
  });
});

describe("slideXmlToText", () => {
  it("decodes XML entities in text runs", () => {
    expect(slideXmlToText("<a:p><a:r><a:t>R&amp;D &#8212; &#x2713;</a:t></a:r></a:p>")).toBe(
      "R&D — ✓",
    );
  });

  it("joins multiple runs inside one paragraph", () => {
    expect(
      slideXmlToText("<a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>"),
    ).toBe("Hello world");
  });
});

describe("isLowText", () => {
  it("flags blank and nearly blank pages", () => {
    expect(isLowText("   \n\n ")).toBe(true);
    expect(isLowText("short")).toBe(true);
    expect(isLowText("This page has enough text to embed.")).toBe(false);
  });
});
