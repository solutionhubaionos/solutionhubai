/**
 * PowerPoint writer. A real deck needs a theme, a master and a layout before a
 * single slide is valid, so those three static parts come from the generated
 * skeleton; this module only writes what changes — the presentation part, one
 * slide part per section plus a cover, and their relationships.
 *
 * Layout is a fixed 16:9 grid of text boxes: every paragraph is positioned by
 * EMU, which is why no slide depends on the template's placeholders.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import type { DocumentOutline } from "../types";
import { DECK_SKELETON_BASE64 } from "../templates/deckSkeleton";
import { APP_XML, coreXml, escapeXml, XML_HEADER } from "./ooxml";
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type Box = { x: number; y: number; w: number; h: number };

function textBox(id: number, name: string, box: Box, paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function run(text: string, size: number, bold: boolean, bullet: boolean): string {
  const paragraphProps = bullet
    ? '<a:pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buChar char="&#8226;"/></a:pPr>'
    : "<a:pPr/>";
  const sizeAttr = Math.round(size * 100);
  return (
    `<a:p>${paragraphProps}<a:r><a:rPr lang="en-GB" sz="${sizeAttr}"${bold ? ' b="1"' : ""} dirty="0"/>` +
    `<a:t>${escapeXml(text)}</a:t></a:r></a:p>`
  );
}

function slideXml(shapes: string): string {
  return (
    `${XML_HEADER}<p:sld ${NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function coverSlide(outline: DocumentOutline): string {
  const title = textBox(
    2,
    "Title",
    { x: 762000, y: 1905000, w: SLIDE_WIDTH - 1524000, h: 1600200 },
    run(outline.title, 40, true, false),
  );
  const subtitle = outline.subtitle
    ? textBox(
        3,
        "Subtitle",
        { x: 762000, y: 3657600, w: SLIDE_WIDTH - 1524000, h: 1100000 },
        run(outline.subtitle, 18, false, false),
      )
    : "";
  return slideXml(`${title}${subtitle}`);
}

function contentSlide(heading: string, bullets: readonly string[]): string {
  const title = textBox(
    2,
    "Title",
    { x: 609600, y: 457200, w: SLIDE_WIDTH - 1219200, h: 914400 },
    run(heading, 30, true, false),
  );
  const body = textBox(
    3,
    "Body",
    { x: 609600, y: 1524000, w: SLIDE_WIDTH - 1219200, h: SLIDE_HEIGHT - 2100000 },
    bullets.map((bullet) => run(bullet, 18, false, true)).join(""),
  );
  return slideXml(`${title}${body}`);
}

function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");
  return (
    `${XML_HEADER}<p:presentation ${NS}>` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`
  );
}

function presentationRels(slideCount: number): string {
  const rels = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `${rels}</Relationships>`
  );
}

function slideRels(): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `</Relationships>`
  );
}

function contentTypes(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `${slides}` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

const PACKAGE_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

export function renderPptx(outline: DocumentOutline): { bytes: Uint8Array; pages: number } {
  const slides = [coverSlide(outline)];
  for (const section of outline.sections) {
    slides.push(contentSlide(section.heading, section.bullets));
  }

  const parts: Record<string, Uint8Array> = { ...unzipSync(base64ToBytes(DECK_SKELETON_BASE64)) };
  parts["[Content_Types].xml"] = strToU8(contentTypes(slides.length));
  parts["_rels/.rels"] = strToU8(PACKAGE_RELS);
  parts["ppt/presentation.xml"] = strToU8(presentationXml(slides.length));
  parts["ppt/_rels/presentation.xml.rels"] = strToU8(presentationRels(slides.length));
  parts["docProps/core.xml"] = strToU8(coreXml(outline.title));
  parts["docProps/app.xml"] = strToU8(APP_XML);

  slides.forEach((slide, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(slideRels());
  });

  return { bytes: zipSync(parts, { level: 6 }), pages: slides.length };
}
