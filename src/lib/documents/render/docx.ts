/**
 * Minimal WordprocessingML writer: a title, headings and bullets, zipped with
 * fflate. Word only needs the package parts below plus a styles part, so the
 * output opens without a repair prompt and needs no extra dependency.
 */
import { strToU8, zipSync } from "fflate";
import type { DocumentOutline } from "../types";
import { APP_XML, coreXml, escapeXml, XML_HEADER } from "./ooxml";

function paragraph(text: string, style: "Title" | "Heading1" | "Normal", before = 0): string {
  const styleXml = style === "Normal" ? "" : `<w:pStyle w:val="${style}"/>`;
  return (
    `<w:p><w:pPr>${styleXml}<w:spacing w:before="${before}" w:after="80"/>` +
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:pPr>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

const STYLES_XML = `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="14233A"/><w:sz w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;

const CONTENT_TYPES = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const PACKAGE_RELS = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOCUMENT_RELS = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

export function renderDocx(outline: DocumentOutline): { bytes: Uint8Array; pages: number } {
  const body: string[] = [paragraph(outline.title, "Title")];
  if (outline.subtitle) body.push(paragraph(outline.subtitle, "Normal"));

  for (const section of outline.sections) {
    body.push(paragraph(section.heading, "Heading1", 320));
    for (const bullet of section.bullets) body.push(paragraph(`-  ${bullet}`, "Normal", 60));
  }

  const documentXml =
    `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const bytes = zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(PACKAGE_RELS),
      "word/document.xml": strToU8(documentXml),
      "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
      "word/styles.xml": strToU8(STYLES_XML),
      "docProps/core.xml": strToU8(coreXml(outline.title)),
      "docProps/app.xml": strToU8(APP_XML),
    },
    { level: 6 },
  );

  // Word repaginates on open; one page is the honest answer for a short brief.
  return { bytes, pages: 1 };
}
