/**
 * PowerPoint renderer for pitch mode. Consumes the validated model: one idea
 * per slide, takeaway headlines, at most five short bullets, native tables and
 * charts, KPI and flow cards, speaker notes.
 *
 * The deck is client-facing and carries the argument only: no citation marks,
 * no source list and no references to the library. Provenance stays in the
 * trace and in the DOCX/PDF exports.
 *
 * The theme, master and layout come from the generated skeleton; every slide
 * body is written here so layout does not depend on template placeholders.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Block, ChartSpec, DocumentModel, DocumentSection } from "../types";
import { DOCUMENT_THEME as THEME, hexForOoxml } from "../theme";
import { sectionTagFor } from "../outline";
import { DECK_SKELETON_BASE64 } from "../templates/deckSkeleton";
import { APP_XML, coreXml, escapeXml, XML_HEADER } from "./ooxml";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const MARGIN = 685800;
const CONTENT_WIDTH = SLIDE_WIDTH - MARGIN * 2;
const TOP = 480000;
const BODY_TOP = 1920000;
const BODY_BOTTOM = 5820000;
const BODY_HEIGHT = BODY_BOTTOM - BODY_TOP;
/** Serif headlines and figures, sans body copy. */
const HEADING_FONT = THEME.fonts.deckHeading;
const BODY_FONT = THEME.fonts.deckBody;
/** Pale blue used on the dark cover and for accents over ink. */
const COVER_ACCENT = "#8FC0E4";
const COVER_MUTED = "#C9D6E2";

type Box = { x: number; y: number; w: number; h: number };

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function rgb(hex: string): string {
  return `<a:srgbClr val="${hexForOoxml(hex)}"/>`;
}

function solid(hex: string): string {
  return `<a:solidFill>${rgb(hex)}</a:solidFill>`;
}

type Run = {
  text: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
  /** Letter spacing in hundredths of a point, used by the uppercase labels. */
  spacing?: number;
};

type ParagraphOptions = {
  bullet?: boolean;
  level?: number;
  align?: "l" | "ctr" | "r";
  spaceBefore?: number;
  /** Line height as a percentage, e.g. 115 for 1.15. */
  lineSpacing?: number;
  bulletColor?: string;
};

function runXml(run: Run): string {
  const attrs = [
    `lang="en-GB"`,
    `sz="${Math.round(run.size * 100)}"`,
    run.bold ? 'b="1"' : "",
    run.italic ? 'i="1"' : "",
    run.spacing ? `spc="${run.spacing}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<a:r><a:rPr ${attrs} dirty="0">` +
    (run.color ? solid(run.color) : "") +
    `<a:latin typeface="${run.font ?? BODY_FONT}"/></a:rPr>` +
    `<a:t>${escapeXml(run.text)}</a:t></a:r>`
  );
}

/**
 * Slide copy never cites: S-labels and bracketed passage numbers are prompt
 * plumbing, so they are removed wherever they survive in the model output.
 */
function cleanCopy(text: string): string {
  return text
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * `**phrase**` becomes a bold accent run, so a slide can highlight the one
 * figure or phrase that matters without adding another text box.
 */
function runsFor(run: Run): string {
  return cleanCopy(run.text)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) => {
      const emphasised = part.length > 4 && part.startsWith("**") && part.endsWith("**");
      const text = emphasised ? part.slice(2, -2) : part;
      if (!text) return "";
      return runXml(
        emphasised ? { ...run, text, bold: true, color: THEME.colors.accent } : { ...run, text },
      );
    })
    .join("");
}

function paragraphXml(run: Run, options: ParagraphOptions = {}): string {
  const level = options.level ?? 0;
  const attrs = [
    options.align ? `algn="${options.align}"` : "",
    options.bullet ? `marL="${342900 + level * 285750}" indent="-285750"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const children = [
    options.lineSpacing ? `<a:lnSpc><a:spcPct val="${options.lineSpacing * 1000}"/></a:lnSpc>` : "",
    options.spaceBefore ? `<a:spcBef><a:spcPts val="${options.spaceBefore}"/></a:spcBef>` : "",
    options.bullet && options.bulletColor ? `<a:buClr>${rgb(options.bulletColor)}</a:buClr>` : "",
    options.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : "",
  ].join("");
  const pPr =
    attrs || children ? `<a:pPr${attrs ? ` ${attrs}` : ""}>${children}</a:pPr>` : "<a:pPr/>";
  return `<a:p>${pPr}${runsFor(run)}</a:p>`;
}

/** Multi-line copy keeps its paragraph breaks instead of one long run. */
function paragraphsFor(
  text: string,
  run: Omit<Run, "text">,
  options: ParagraphOptions = {},
): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => paragraphXml({ ...run, text: line }, options))
    .join("");
}

function textBody(
  paragraphs: string,
  options: { anchor?: "t" | "ctr" | "b"; inset?: number } = {},
): string {
  const inset = options.inset ?? 91440;
  return (
    `<p:txBody><a:bodyPr wrap="square" lIns="${inset}" rIns="${inset}" tIns="${Math.round(inset / 2)}" bIns="${Math.round(inset / 2)}"${options.anchor ? ` anchor="${options.anchor}"` : ""}><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${paragraphs}</p:txBody>`
  );
}

function shape(
  id: number,
  name: string,
  box: Box,
  options: {
    fill?: string;
    line?: string;
    rounded?: boolean;
    ellipse?: boolean;
    paragraphs?: string;
    anchor?: "t" | "ctr" | "b";
  } = {},
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr${options.paragraphs ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${options.ellipse ? "ellipse" : options.rounded ? "roundRect" : "rect"}"><a:avLst/></a:prstGeom>` +
    (options.fill ? solid(options.fill) : "<a:noFill/>") +
    (options.line ? `<a:ln w="12700">${solid(options.line)}</a:ln>` : "") +
    `</p:spPr>` +
    (options.paragraphs
      ? textBody(options.paragraphs, options.anchor ? { anchor: options.anchor } : {})
      : '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>') +
    `</p:sp>`
  );
}

/** Charts written in this render, shared by every slide that uses one. */
type ChartContext = { parts: string[]; rels: { part: number; relId: string }[] };

/** Native, editable DrawingML chart: bar, stacked bar, line, pie or doughnut. */
function chartXml(spec: ChartSpec): string {
  const count = spec.categories.length;
  const categories = spec.categories
    .map((category, index) => `<c:pt idx="${index}"><c:v>${escapeXml(category)}</c:v></c:pt>`)
    .join("");
  const series = spec.series
    .map((entry, seriesIndex) => {
      const values = entry.values
        .map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)
        .join("");
      return (
        `<c:ser><c:idx val="${seriesIndex}"/><c:order val="${seriesIndex}"/>` +
        `<c:tx><c:strRef><c:f>Series${seriesIndex + 1}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(entry.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        `<c:cat><c:strRef><c:f>Categories</c:f><c:strCache><c:ptCount val="${count}"/>${categories}</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Values${seriesIndex + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/>${values}</c:numCache></c:numRef></c:val>` +
        `</c:ser>`
      );
    })
    .join("");

  const plot =
    spec.type === "line"
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/></c:lineChart>`
      : spec.type === "pie"
        ? `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`
        : spec.type === "doughnut"
          ? `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`
          : `<c:barChart><c:barDir val="col"/><c:grouping val="${spec.type === "stacked_bar" ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${series}<c:gapWidth val="60"/><c:overlap val="${spec.type === "stacked_bar" ? "100" : "-10"}"/></c:barChart>`;

  return (
    `${XML_HEADER}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/>` +
    `<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB" sz="1200" b="1">${solid(THEME.colors.ink)}<a:latin typeface="${BODY_FONT}"/></a:rPr><a:t>${escapeXml(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

function chartFrame(id: number, relId: string, box: Box): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function tableXml(
  id: number,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  box: Box,
  options: { compact?: boolean } = {},
): string {
  const columns = headers.length;
  const columnWidth = box.w / columns;
  const rowCount = rows.length + 1;
  const rowHeight = Math.min(430000, Math.floor(box.h / Math.max(rowCount, 1)));
  const fontSize = options.compact ? 950 : rowCount > 7 ? 1000 : 1100;
  const rule = `<a:lnB w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${rgb(THEME.colors.border)}</a:solidFill></a:lnB>`;

  const cell = (value: string, header: boolean, index: number, column: number): string => {
    const fill = header
      ? THEME.colors.accentDark
      : index % 2 === 1
        ? THEME.colors.surface
        : THEME.colors.white;
    const color = header ? THEME.colors.white : THEME.colors.ink;
    const bold = header || column === 0;
    return (
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>` +
      `<a:r><a:rPr lang="en-GB" sz="${fontSize}"${bold ? ' b="1"' : ""}>` +
      `${solid(color)}<a:latin typeface="${header ? HEADING_FONT : BODY_FONT}"/></a:rPr>` +
      `<a:t>${escapeXml(cleanCopy(value).slice(0, 180))}</a:t></a:r></a:p></a:txBody>` +
      `<a:tcPr marL="108000" marR="108000" marT="45000" marB="45000" anchor="ctr">` +
      `${header ? "" : rule}${solid(fill)}</a:tcPr></a:tc>`
    );
  };

  const headerRow = `<a:tr h="${rowHeight}">${headers
    .map((header, column) => cell(header, true, 0, column))
    .join("")}</a:tr>`;
  const bodyRows = rows
    .map(
      (row, index) =>
        `<a:tr h="${rowHeight}">${headers
          .map((_header, column) => cell(row[column] ?? "", false, index, column))
          .join("")}</a:tr>`,
    )
    .join("");

  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(rowHeight * rowCount)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: columns }, () => `<a:gridCol w="${Math.round(columnWidth)}"/>`).join("")}</a:tblGrid>` +
    `${headerRow}${bodyRows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function slideXml(shapes: string, background: string = THEME.colors.white): string {
  return (
    `${XML_HEADER}<p:sld ${NS}><p:cSld><p:bg><p:bgPr>${solid(background)}<a:effectLst/></p:bgPr></p:bg><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

/** Rough height budget in EMU, used to split a section across slides. */
function estimateHeight(block: Block): number {
  switch (block.type) {
    case "heading":
      return 0;
    case "paragraph":
      return Math.ceil(block.text.length / 90) * 240000 + 140000;
    case "bullet_list":
    case "numbered_list":
      return block.items.length * 300000 + 120000;
    case "table":
      return (block.rows.length + 1) * 300000 + 320000;
    case "metrics":
      return 1_350_000;
    case "callout":
      return 720000;
    case "quote":
      return 760000;
    case "timeline":
      return 1_650_000;
    case "comparison":
      return (block.criteria.length + 1) * 300000 + 330000;
    case "chart":
      return 2_400_000;
    case "kpis":
      return 1_350_000;
    case "flow":
      return 1_500_000;
  }
}

export function paginateBlocks(blocks: readonly Block[], budget = BODY_HEIGHT): Block[][] {
  const pages: Block[][] = [];
  let current: Block[] = [];
  let used = 0;
  for (const block of blocks) {
    if (block.type === "heading") {
      // Section headlines already carry the argument; subheadings are noise on a slide.
      continue;
    }
    const height = estimateHeight(block);
    if (current.length > 0 && used + height > budget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(block);
    used += height;
  }
  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}

/** S-labels and citation marks are prompt plumbing; notes should read as notes. */
function stripSourceLabels(text: string): string {
  return text
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function notesXml(text: string): string {
  const paragraphs = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => paragraphXml({ text: line, size: 12, color: THEME.colors.ink }))
    .join("");
  return (
    `${XML_HEADER}<p:notes ${NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
}

function coverSlide(model: DocumentModel): string {
  const shapes: string[] = [];
  const inset = MARGIN + 91440;
  const title = model.cover.title.replace(/\*\*/g, "");
  const titleSize = title.length > 64 ? 30 : title.length > 44 ? 34 : 40;

  shapes.push(
    shape(
      2,
      "Accent stripe",
      { x: 0, y: 0, w: 167640, h: SLIDE_HEIGHT },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      3,
      "Brand",
      { x: inset, y: 560000, w: 5_000_000, h: 240000 },
      {
        paragraphs: paragraphXml({
          text: THEME.brand.wordmark,
          size: 9,
          bold: true,
          color: COVER_MUTED,
          spacing: 360,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      4,
      "Kicker",
      { x: inset, y: 1_900_000, w: CONTENT_WIDTH - 91440, h: 260000 },
      {
        paragraphs: paragraphXml({
          text: model.mode === "pitch" ? "PITCH DECK" : "PROPOSAL",
          size: 9,
          bold: true,
          color: COVER_ACCENT,
          spacing: 280,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      5,
      "Title",
      { x: inset, y: 2_240_000, w: CONTENT_WIDTH - 1_400_000, h: 1_600_000 },
      {
        paragraphs: paragraphXml(
          {
            text: title,
            size: titleSize,
            bold: true,
            color: THEME.colors.white,
            font: HEADING_FONT,
          },
          { lineSpacing: 95 },
        ),
      },
    ),
  );
  shapes.push(
    shape(
      6,
      "Accent rule",
      { x: inset, y: 4_020_000, w: 1_100_000, h: 42000 },
      {
        fill: COVER_ACCENT,
      },
    ),
  );
  if (model.cover.subtitle) {
    shapes.push(
      shape(
        7,
        "Subtitle",
        { x: inset, y: 4_200_000, w: CONTENT_WIDTH - 1_800_000, h: 620000 },
        {
          paragraphs: paragraphXml(
            {
              text: model.cover.subtitle,
              size: 15,
              color: COVER_MUTED,
            },
            { lineSpacing: 120 },
          ),
        },
      ),
    );
  }
  const meta = [
    model.cover.client ? `Prepared for ${model.cover.client}` : null,
    model.cover.industry,
    model.cover.date,
  ]
    .filter((value): value is string => Boolean(value))
    .join("   ·   ");
  if (meta) {
    shapes.push(
      shape(
        8,
        "Meta",
        { x: inset, y: 5_400_000, w: CONTENT_WIDTH - 91440, h: 300000 },
        {
          paragraphs: paragraphXml({
            text: meta,
            size: 10,
            bold: true,
            color: COVER_ACCENT,
            spacing: 140,
          }),
        },
      ),
    );
  }
  shapes.push(
    shape(
      9,
      "Footer rule",
      { x: inset, y: 6_060_000, w: CONTENT_WIDTH - 91440, h: 12700 },
      {
        fill: "#2A3F57",
      },
    ),
  );
  return slideXml(shapes.join(""), THEME.colors.ink);
}

function renderBlocks(
  blocks: readonly Block[],
  startId: number,
  charts: ChartContext = { parts: [], rels: [] },
): { shapes: string; nextId: number } {
  const shapes: string[] = [];
  let id = startId;
  let y = BODY_TOP;

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        break;
      case "paragraph": {
        const height = Math.min(estimateHeight(block), BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Body",
            { x: MARGIN, y, w: CONTENT_WIDTH, h: Math.max(height, 400000) },
            {
              paragraphs: paragraphsFor(
                block.text,
                { size: 16, color: THEME.colors.ink },
                { lineSpacing: 130 },
              ),
            },
          ),
        );
        y += Math.max(height, 400000) + 90000;
        break;
      }
      case "bullet_list":
      case "numbered_list": {
        const count = block.items.filter((item) => (item.level ?? 0) === 0).length;
        const size = count <= 3 ? 20 : count <= 5 ? 18 : 15;
        const paragraphs = block.items
          .map((item) => {
            const level = item.level ?? 0;
            return paragraphXml(
              { text: item.text.replace(/\s*\n\s*/g, " "), size, color: THEME.colors.ink },
              {
                bullet: block.type === "bullet_list",
                level,
                spaceBefore: 700,
                lineSpacing: 115,
                bulletColor: level === 0 ? THEME.colors.accent : THEME.colors.muted,
              },
            );
          })
          .join("");
        const height = Math.min(block.items.length * 400000 + 140000, BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Bullets",
            { x: MARGIN, y, w: CONTENT_WIDTH, h: Math.max(height, 400000) },
            {
              paragraphs,
            },
          ),
        );
        y += Math.max(height, 400000) + 90000;
        break;
      }
      case "metrics": {
        const columns = Math.min(3, block.items.length);
        const gap = 140000;
        const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
        const cardHeight = Math.min(1_300_000, BODY_BOTTOM - y);
        block.items.slice(0, 3).forEach((item, index) => {
          const x = MARGIN + index * (cardWidth + gap);
          shapes.push(
            shape(
              id++,
              `Metric ${index + 1}`,
              { x, y, w: cardWidth, h: cardHeight },
              {
                fill: THEME.colors.surface,
                line: THEME.colors.border,
                rounded: true,
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Metric accent ${index + 1}`,
              { x, y: y + 100000, w: 48000, h: cardHeight - 200000 },
              { fill: THEME.colors.accent },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Metric value ${index + 1}`,
              { x, y: y + 120000, w: cardWidth, h: 520000 },
              {
                paragraphs: paragraphXml({
                  text: `${item.value}${item.unit ? ` ${item.unit}` : ""}`,
                  size: 30,
                  bold: true,
                  font: HEADING_FONT,
                  color: THEME.colors.accentDark,
                }),
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Metric label ${index + 1}`,
              { x, y: y + 620000, w: cardWidth, h: Math.max(320000, cardHeight - 680000) },
              {
                paragraphs: [
                  paragraphXml({
                    text: item.label,
                    size: 10.5,
                    bold: true,
                    color: THEME.colors.ink,
                  }),
                  item.context
                    ? paragraphXml({ text: item.context, size: 9, color: THEME.colors.muted })
                    : "",
                ].join(""),
              },
            ),
          );
        });
        y += cardHeight + 180000;
        break;
      }
      case "chart": {
        const height = Math.max(1_900_000, Math.min(estimateHeight(block), BODY_BOTTOM - y));
        const part = charts.parts.length + 1;
        charts.parts.push(chartXml(block.chart));
        const relId = `rId${100 + part}`;
        charts.rels.push({ part, relId });
        shapes.push(chartFrame(id++, relId, { x: MARGIN, y, w: CONTENT_WIDTH, h: height }));
        if (block.illustrative) {
          shapes.push(
            shape(
              id++,
              "Illustrative badge",
              {
                x: MARGIN + CONTENT_WIDTH - 2_100_000,
                y: y + 60000,
                w: 2_050_000,
                h: 250000,
              },
              {
                fill: THEME.colors.accentSoft,
                rounded: true,
                paragraphs: paragraphXml({
                  text: "ILLUSTRATIVE - REPLACE WITH ACTUALS",
                  size: 8,
                  bold: true,
                  color: THEME.colors.accentDark,
                }),
              },
            ),
          );
        }
        y += height + 120000;
        break;
      }
      case "kpis": {
        const items = block.items.slice(0, 4);
        const columns = Math.min(2, items.length);
        const gap = 160000;
        const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
        const cardHeight = Math.min(1_100_000, (BODY_BOTTOM - y - gap) / 2);
        items.forEach((item, index) => {
          const cardY = y + Math.floor(index / columns) * (cardHeight + gap);
          const x = MARGIN + (index % columns) * (cardWidth + gap);
          shapes.push(
            shape(
              id++,
              `KPI ${index + 1}`,
              { x, y: cardY, w: cardWidth, h: cardHeight },
              {
                fill: THEME.colors.surface,
                line: THEME.colors.border,
                rounded: true,
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `KPI accent ${index + 1}`,
              { x, y: cardY + 100000, w: 48000, h: cardHeight - 200000 },
              { fill: THEME.colors.accent },
            ),
          );
          shapes.push(
            shape(
              id++,
              `KPI value ${index + 1}`,
              { x, y: cardY + 80000, w: cardWidth, h: 500000 },
              {
                paragraphs: paragraphXml({
                  text: item.value,
                  size: 32,
                  bold: true,
                  font: HEADING_FONT,
                  color: THEME.colors.accentDark,
                }),
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `KPI label ${index + 1}`,
              { x, y: cardY + 580000, w: cardWidth, h: Math.max(300000, cardHeight - 620000) },
              {
                paragraphs: [
                  paragraphXml({
                    text: item.label.slice(0, 120),
                    size: 10.5,
                    bold: true,
                    color: THEME.colors.ink,
                  }),
                  item.note
                    ? paragraphXml({
                        text: item.note.slice(0, 120),
                        size: 9,
                        color: THEME.colors.muted,
                      })
                    : "",
                ].join(""),
              },
            ),
          );
        });
        y += Math.ceil(items.length / columns) * (cardHeight + gap);
        break;
      }
      case "flow": {
        const steps = block.steps.slice(0, 5);
        const gap = 130000;
        const cardWidth = (CONTENT_WIDTH - gap * (steps.length - 1)) / Math.max(1, steps.length);
        const cardHeight = Math.min(1_450_000, BODY_BOTTOM - y);
        steps.forEach((step, index) => {
          const x = MARGIN + index * (cardWidth + gap);
          shapes.push(
            shape(
              id++,
              `Step ${index + 1}`,
              { x, y, w: cardWidth, h: cardHeight },
              { fill: THEME.colors.accentSoft, rounded: true },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Step number ${index + 1}`,
              { x: x + 160000, y: y + 160000, w: 340000, h: 340000 },
              {
                fill: THEME.colors.accent,
                ellipse: true,
                paragraphs: paragraphXml(
                  {
                    text: String(index + 1),
                    size: 11,
                    bold: true,
                    color: THEME.colors.white,
                  },
                  { align: "ctr" },
                ),
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Step label ${index + 1}`,
              { x: x + 160000, y: y + 580000, w: cardWidth - 300000, h: 420000 },
              {
                paragraphs: paragraphXml(
                  {
                    text: step.label,
                    size: 12.5,
                    bold: true,
                    font: HEADING_FONT,
                    color: THEME.colors.accentDark,
                  },
                  { lineSpacing: 110 },
                ),
              },
            ),
          );
          if (step.detail) {
            shapes.push(
              shape(
                id++,
                `Step detail ${index + 1}`,
                {
                  x: x + 160000,
                  y: y + 1_000_000,
                  w: cardWidth - 300000,
                  h: Math.max(300000, cardHeight - 1_060_000),
                },
                {
                  paragraphs: paragraphXml(
                    {
                      text: step.detail.slice(0, 150),
                      size: 9.5,
                      color: THEME.colors.ink,
                    },
                    { lineSpacing: 115 },
                  ),
                },
              ),
            );
          }
        });
        y += cardHeight + 160000;
        break;
      }
      case "table": {
        const rows = block.rows.slice(0, 8);
        const rowCount = rows.length + 1;
        const height = Math.min(Math.max(rowCount * 330000, 720000), BODY_BOTTOM - y);
        if (block.caption) {
          shapes.push(
            shape(
              id++,
              "Table caption",
              { x: MARGIN, y, w: CONTENT_WIDTH, h: 260000 },
              {
                paragraphs: paragraphXml({
                  text: block.caption,
                  size: 9.5,
                  italic: true,
                  color: THEME.colors.muted,
                }),
              },
            ),
          );
          y += 260000;
        }
        shapes.push(
          tableXml(id++, block.headers, rows, { x: MARGIN, y, w: CONTENT_WIDTH, h: height }),
        );
        y += height + 160000;
        break;
      }
      case "timeline": {
        const items = block.items.slice(0, 4);
        const gap = 170000;
        const cardWidth = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
        const cardHeight = Math.min(1_550_000, BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Timeline rail",
            { x: MARGIN, y: y + 305000, w: CONTENT_WIDTH, h: 19050 },
            { fill: THEME.colors.border },
          ),
        );
        items.forEach((item, index) => {
          const x = MARGIN + index * (cardWidth + gap);
          shapes.push(
            shape(
              id++,
              `Timeline dot ${index + 1}`,
              { x, y: y + 232000, w: 165000, h: 165000 },
              {
                fill: THEME.colors.accent,
                ellipse: true,
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Timeline text ${index + 1}`,
              { x, y: y + 470000, w: cardWidth, h: Math.max(400000, cardHeight - 470000) },
              {
                paragraphs: [
                  paragraphXml({
                    text: item.timeframe.toUpperCase(),
                    size: 8.5,
                    bold: true,
                    color: THEME.colors.accent,
                    spacing: 140,
                  }),
                  paragraphXml(
                    {
                      text: item.label,
                      size: 13,
                      bold: true,
                      font: HEADING_FONT,
                      color: THEME.colors.ink,
                    },
                    { lineSpacing: 110 },
                  ),
                  paragraphXml(
                    {
                      text: item.detail.slice(0, 150),
                      size: 9.5,
                      color: THEME.colors.muted,
                    },
                    { lineSpacing: 115 },
                  ),
                ].join(""),
              },
            ),
          );
        });
        y += cardHeight + 160000;
        break;
      }
      case "callout": {
        const height = Math.min(estimateHeight(block), BODY_BOTTOM - y);
        const fill =
          block.tone === "warning"
            ? "#FFF4E5"
            : block.tone === "success"
              ? "#E9F5EF"
              : THEME.colors.accentSoft;
        const bar =
          block.tone === "warning"
            ? THEME.colors.warning
            : block.tone === "success"
              ? THEME.colors.success
              : THEME.colors.accent;
        shapes.push(
          shape(id++, "Callout", { x: MARGIN, y, w: CONTENT_WIDTH, h: height }, { fill }),
        );
        shapes.push(
          shape(id++, "Callout bar", { x: MARGIN, y, w: 54000, h: height }, { fill: bar }),
        );
        shapes.push(
          shape(
            id++,
            "Callout text",
            { x: MARGIN + 54000, y, w: CONTENT_WIDTH - 54000, h: height },
            {
              paragraphs: paragraphXml(
                {
                  text: block.text,
                  size: 14.5,
                  color: THEME.colors.ink,
                },
                { lineSpacing: 120 },
              ),
            },
          ),
        );
        y += height + 140000;
        break;
      }
      case "quote": {
        const height = Math.min(estimateHeight(block), BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Quote bar",
            { x: MARGIN, y, w: 64000, h: height },
            { fill: THEME.colors.accent },
          ),
        );
        shapes.push(
          shape(
            id++,
            "Quote",
            { x: MARGIN + 160000, y, w: CONTENT_WIDTH - 160000, h: height },
            {
              paragraphs: [
                paragraphXml(
                  {
                    text: `"${block.text}"`,
                    size: 18,
                    italic: true,
                    font: HEADING_FONT,
                    color: THEME.colors.ink,
                  },
                  { lineSpacing: 120 },
                ),
                paragraphXml({
                  text: block.attribution.toUpperCase(),
                  size: 8.5,
                  bold: true,
                  color: THEME.colors.muted,
                  spacing: 140,
                }),
              ].join(""),
            },
          ),
        );
        y += height + 140000;
        break;
      }
      case "comparison": {
        const headers = ["", ...block.options.map((option) => option.name)];
        const rows = block.criteria.map((criterion, index) => [
          criterion,
          ...block.options.map((option) => option.values[index] ?? ""),
        ]);
        const height = Math.min((rows.length + 1) * 300000, BODY_BOTTOM - y);
        shapes.push(
          tableXml(
            id++,
            headers,
            rows.slice(0, 8),
            { x: MARGIN, y, w: CONTENT_WIDTH, h: height },
            { compact: true },
          ),
        );
        y += height + 120000;
        break;
      }
    }
  }

  return { shapes: shapes.join(""), nextId: id };
}

function contentSlide(
  section: DocumentSection,
  blocks: readonly Block[],
  index: number,
  continuation: boolean,
  charts: ChartContext,
): string {
  const shapes: string[] = [];
  const title = section.title.replace(/\*\*/g, "");
  const eyebrow = `${sectionTagFor(section.kind)}${continuation ? " · continued" : ""}`;

  shapes.push(
    shape(
      2,
      "Accent stripe",
      { x: 0, y: 0, w: 118872, h: SLIDE_HEIGHT },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      3,
      "Eyebrow",
      { x: MARGIN, y: TOP, w: CONTENT_WIDTH - 3_400_000, h: 240000 },
      {
        paragraphs: paragraphXml({
          text: eyebrow.toUpperCase(),
          size: 8.5,
          bold: true,
          color: THEME.colors.accent,
          spacing: 240,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      4,
      "Brand",
      { x: SLIDE_WIDTH - MARGIN - 3_400_000, y: TOP, w: 3_400_000, h: 240000 },
      {
        paragraphs: paragraphXml(
          {
            text: THEME.brand.wordmark,
            size: 8,
            bold: true,
            color: THEME.colors.border,
            spacing: 240,
          },
          { align: "r" },
        ),
      },
    ),
  );
  shapes.push(
    shape(
      5,
      "Headline",
      { x: MARGIN, y: 770000, w: CONTENT_WIDTH, h: 1_000_000 },
      {
        paragraphs: paragraphXml(
          {
            text: title,
            size: title.length > 64 ? 22 : 25,
            bold: true,
            color: THEME.colors.ink,
            font: HEADING_FONT,
          },
          { lineSpacing: 92 },
        ),
      },
    ),
  );
  shapes.push(
    shape(
      6,
      "Headline rule",
      { x: MARGIN, y: 1_790_000, w: 760000, h: 30000 },
      {
        fill: THEME.colors.accent,
      },
    ),
  );

  const body = renderBlocks(blocks, 7, charts);
  shapes.push(body.shapes);

  shapes.push(
    shape(
      body.nextId + 1,
      "Footer rule",
      { x: MARGIN, y: BODY_BOTTOM + 150000, w: CONTENT_WIDTH, h: 9525 },
      { fill: THEME.colors.border },
    ),
  );
  shapes.push(
    shape(
      body.nextId + 2,
      "Footer",
      { x: MARGIN, y: BODY_BOTTOM + 190000, w: 4_000_000, h: 240000 },
      {
        paragraphs: paragraphXml({
          text: "Confidential",
          size: 8,
          color: THEME.colors.muted,
          spacing: 120,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      body.nextId + 3,
      "Slide number",
      { x: SLIDE_WIDTH - MARGIN - 600000, y: BODY_BOTTOM + 190000, w: 600000, h: 240000 },
      {
        paragraphs: paragraphXml(
          {
            text: String(index + 1),
            size: 9,
            bold: true,
            color: THEME.colors.muted,
          },
          { align: "r" },
        ),
      },
    ),
  );

  return slideXml(shapes.join(""));
}

function sectionNotes(section: DocumentSection): string {
  const text =
    stripSourceLabels(section.speakerNotes) ||
    "Talk through the evidence behind this slide and invite the client's reaction before moving on.";
  return notesXml(text);
}

function coverNotes(model: DocumentModel): string {
  const client = model.cover.client ?? "the client";
  return notesXml(`Open with the outcome for ${client} and the decision you want by the end.`);
}

function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`,
  ).join("");
  return (
    `${XML_HEADER}<p:presentation ${NS}>` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>` +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`
  );
}

function presentationRels(slideCount: number): string {
  const rels = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` +
    `${rels}</Relationships>`
  );
}

function slideRels(index: number, charts: readonly { part: number; relId: string }[] = []): string {
  const chartRels = charts
    .map(
      ({ part, relId }) =>
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${part}.xml"/>`,
    )
    .join("");
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/>` +
    `${chartRels}</Relationships>`
  );
}

function notesRels(index: number): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${index + 1}.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>` +
    `</Relationships>`
  );
}

function contentTypes(slideCount: number, chartCount = 0): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
      `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
  ).join("");
  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `${slides}` +
    Array.from(
      { length: chartCount },
      (_, index) =>
        `<Override PartName="/ppt/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    ).join("") +
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

const NOTES_MASTER =
  `${XML_HEADER}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle>` +
  `</p:notesMaster>`;

const NOTES_MASTER_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
  `</Relationships>`;

/** One slide per outline section; long sections continue onto another slide. */
export function renderPptx(model: DocumentModel): { bytes: Uint8Array; pages: number } {
  const slides: string[] = [coverSlide(model)];
  const notes: string[] = [coverNotes(model)];
  const chartParts: string[] = [];
  // One entry per slide; only the cover starts without chart relationships.
  const chartRelsBySlide: { part: number; relId: string }[][] = [[]];

  for (const section of model.sections) {
    const pages = paginateBlocks(section.blocks);
    pages.forEach((blocks, index) => {
      const charts: ChartContext = { parts: chartParts, rels: [] };
      slides.push(contentSlide(section, blocks, slides.length, index > 0, charts));
      chartRelsBySlide.push(charts.rels);
      notes.push(sectionNotes(section));
    });
  }

  const parts: Record<string, Uint8Array> = { ...unzipSync(base64ToBytes(DECK_SKELETON_BASE64)) };
  parts["[Content_Types].xml"] = strToU8(contentTypes(slides.length, chartParts.length));
  parts["_rels/.rels"] = strToU8(PACKAGE_RELS);
  parts["ppt/presentation.xml"] = strToU8(presentationXml(slides.length));
  parts["ppt/_rels/presentation.xml.rels"] = strToU8(presentationRels(slides.length));
  parts["ppt/notesMasters/notesMaster1.xml"] = strToU8(NOTES_MASTER);
  parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = strToU8(NOTES_MASTER_RELS);
  parts["docProps/core.xml"] = strToU8(coreXml(model.cover.title));
  parts["docProps/app.xml"] = strToU8(APP_XML);
  chartParts.forEach((xml, chartIndex) => {
    parts[`ppt/charts/chart${chartIndex + 1}.xml`] = strToU8(xml);
  });
  slides.forEach((slide, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(
      slideRels(index, chartRelsBySlide[index] ?? []),
    );
    parts[`ppt/notesSlides/notesSlide${index + 1}.xml`] = strToU8(notes[index] ?? notes[0] ?? "");
    parts[`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`] = strToU8(notesRels(index));
  });

  return { bytes: zipSync(parts, { level: 6 }), pages: slides.length };
}
