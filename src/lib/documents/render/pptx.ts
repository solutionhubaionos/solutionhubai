/**
 * PowerPoint renderer for pitch mode. Consumes the validated model: one idea
 * per slide, takeaway headlines, at most five short bullets, native tables,
 * metric cards with real source figures, a visual timeline, per-slide source
 * footnotes and speaker notes with chunk references.
 *
 * The theme, master and layout come from the generated skeleton; every slide
 * body is written here so layout does not depend on template placeholders.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Block, DocumentModel, DocumentSection, SourceRecord } from "../types";
import { DOCUMENT_THEME as THEME, hexForOoxml } from "../theme";
import { DECK_SKELETON_BASE64 } from "../templates/deckSkeleton";
import { APP_XML, coreXml, escapeXml, XML_HEADER } from "./ooxml";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const MARGIN = 609600;
const CONTENT_WIDTH = SLIDE_WIDTH - MARGIN * 2;
const TOP = 457200;
const BODY_TOP = 1554480;
const BODY_BOTTOM = 5852160;
const BODY_HEIGHT = BODY_BOTTOM - BODY_TOP;

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

type Run = { text: string; size: number; bold?: boolean; italic?: boolean; color?: string };

function paragraphXml(
  run: Run,
  options: {
    bullet?: boolean;
    level?: number;
    align?: "l" | "ctr" | "r";
    spaceBefore?: number;
  } = {},
): string {
  const level = options.level ?? 0;
  const attrs = [
    options.align ? `algn="${options.align}"` : "",
    options.bullet ? `marL="${342900 + level * 285750}" indent="-285750"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const children = [
    options.spaceBefore ? `<a:spcBef><a:spcPts val="${options.spaceBefore}"/></a:spcBef>` : "",
    options.bullet ? '<a:buChar char="&#8226;"/>' : "",
  ].join("");
  const pPr =
    attrs || children ? `<a:pPr${attrs ? ` ${attrs}` : ""}>${children}</a:pPr>` : "<a:pPr/>";
  const rAttrs = [
    `lang="en-GB"`,
    `sz="${Math.round(run.size * 100)}"`,
    run.bold ? 'b="1"' : "",
    run.italic ? 'i="1"' : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rChildren =
    (run.color ? solid(run.color) : "") + `<a:latin typeface="${THEME.fonts.body}"/>`;
  return (
    `<a:p>${pPr}` +
    `<a:r><a:rPr ${rAttrs} dirty="0">${rChildren}</a:rPr><a:t>${escapeXml(run.text)}</a:t></a:r></a:p>`
  );
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
    paragraphs?: string;
    anchor?: "t" | "ctr" | "b";
  } = {},
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr${options.paragraphs ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${options.rounded ? "roundRect" : "rect"}"><a:avLst/></a:prstGeom>` +
    (options.fill ? solid(options.fill) : "<a:noFill/>") +
    (options.line ? `<a:ln w="12700">${solid(options.line)}</a:ln>` : "") +
    `</p:spPr>` +
    (options.paragraphs
      ? textBody(options.paragraphs, options.anchor ? { anchor: options.anchor } : {})
      : '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>') +
    `</p:sp>`
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
  const rowHeight = Math.min(420000, Math.floor(box.h / Math.max(rowCount, 1)));
  const fontSize = options.compact ? 900 : rowCount > 7 ? 950 : 1050;

  const cell = (value: string, header: boolean, index: number): string => {
    const fill = header
      ? THEME.colors.accent
      : index % 2 === 1
        ? THEME.colors.surface
        : THEME.colors.white;
    return (
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>` +
      `<a:r><a:rPr lang="en-GB" sz="${fontSize}"${header ? ' b="1"' : ""}>` +
      `${solid(header ? THEME.colors.white : THEME.colors.ink)}<a:latin typeface="${THEME.fonts.body}"/></a:rPr>` +
      `<a:t>${escapeXml(value.slice(0, 180))}</a:t></a:r></a:p></a:txBody>` +
      `<a:tcPr marL="72000" marR="72000" marT="36000" marB="36000" anchor="ctr">${solid(fill)}</a:tcPr></a:tc>`
    );
  };

  const headerRow = `<a:tr h="${rowHeight}">${headers.map((header) => cell(header, true, 0)).join("")}</a:tr>`;
  const bodyRows = rows
    .map(
      (row, index) =>
        `<a:tr h="${rowHeight}">${headers
          .map((_, column) => cell(row[column] ?? "", false, index))
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

function slideXml(shapes: string): string {
  return (
    `${XML_HEADER}<p:sld ${NS}><p:cSld><p:bg><p:bgPr>${solid(THEME.colors.white)}<a:effectLst/></p:bgPr></p:bg><p:spTree>` +
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

function sourceLabel(source: SourceRecord, index: number): string {
  const where = source.slide ? `slide ${source.slide}` : source.page ? `page ${source.page}` : "";
  return `[${index + 1}] ${source.title}${where ? `, ${where}` : ""}`;
}

function sectionSources(section: DocumentSection, model: DocumentModel): SourceRecord[] {
  const ids = new Set<string>();
  for (const block of section.blocks) {
    switch (block.type) {
      case "heading":
        break;
      case "quote":
        ids.add(block.source);
        break;
      case "metrics":
        block.items.forEach((item) => ids.add(item.source));
        block.sources.forEach((id) => ids.add(id));
        break;
      case "timeline":
        block.sources.forEach((id) => ids.add(id));
        block.items.forEach((item) => item.sources.forEach((id) => ids.add(id)));
        break;
      default:
        block.sources.forEach((id) => ids.add(id));
    }
  }
  return model.sources.filter((source) => ids.has(source.chunkId));
}

/** S-labels are prompt plumbing; speaker notes should read like notes. */
function stripSourceLabels(text: string): string {
  return text
    .replace(/\[S\d+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function notesXml(text: string, references: string): string {
  const body = `${text}${references ? `\n\nSource references: ${references}` : ""}`;
  const paragraphs = body
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
  shapes.push(
    shape(
      2,
      "Accent band",
      { x: 0, y: 0, w: SLIDE_WIDTH, h: 182880 },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      3,
      "Brand",
      { x: MARGIN, y: 480000, w: 3_000_000, h: 260000 },
      {
        paragraphs: paragraphXml({
          text: THEME.brand.wordmark,
          size: 11,
          bold: true,
          color: THEME.colors.accent,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      4,
      "Title",
      { x: MARGIN, y: 1_700_000, w: CONTENT_WIDTH, h: 1_900_000 },
      {
        paragraphs: paragraphXml({
          text: model.cover.title,
          size: 38,
          bold: true,
          color: THEME.colors.ink,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      5,
      "Accent rule",
      { x: MARGIN, y: 3_650_000, w: 914400, h: 36000 },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      6,
      "Subtitle",
      { x: MARGIN, y: 3_800_000, w: CONTENT_WIDTH - 900000, h: 700000 },
      {
        paragraphs: paragraphXml({
          text: model.cover.subtitle,
          size: 17,
          color: THEME.colors.muted,
        }),
      },
    ),
  );
  const meta = [
    model.cover.client ? `Prepared for ${model.cover.client}` : null,
    model.cover.industry,
    model.cover.date,
  ]
    .filter((value): value is string => Boolean(value))
    .join("  ·  ");
  shapes.push(
    shape(
      7,
      "Meta",
      { x: MARGIN, y: 4_650_000, w: CONTENT_WIDTH, h: 320000 },
      {
        paragraphs: paragraphXml({ text: meta, size: 12, color: THEME.colors.muted }),
      },
    ),
  );
  if (model.cover.request) {
    shapes.push(
      shape(
        8,
        "Request panel",
        { x: MARGIN, y: 5_250_000, w: CONTENT_WIDTH, h: 760000 },
        {
          fill: THEME.colors.surface,
          paragraphs: paragraphXml({
            text: `Request: ${model.cover.request.slice(0, 220)}`,
            size: 10,
            italic: true,
            color: THEME.colors.muted,
          }),
        },
      ),
    );
  }
  if (model.sources.length > 0) {
    shapes.push(
      shape(
        9,
        "Cover source note",
        { x: MARGIN, y: 6_240_000, w: CONTENT_WIDTH, h: 240000 },
        {
          paragraphs: paragraphXml({
            text: `Built from ${model.sources.length} documents in the Solution Hub library`,
            size: 8,
            color: THEME.colors.muted,
          }),
        },
      ),
    );
  }
  return slideXml(shapes.join(""));
}

function renderBlocks(
  blocks: readonly Block[],
  section: DocumentSection,
  citations: Map<string, number>,
  startId: number,
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
              paragraphs: paragraphXml({ text: block.text, size: 15, color: THEME.colors.ink }),
            },
          ),
        );
        y += Math.max(height, 400000) + 90000;
        break;
      }
      case "bullet_list":
      case "numbered_list": {
        const count = block.items.filter((item) => (item.level ?? 0) === 0).length;
        const size = count <= 3 ? 19 : count <= 5 ? 17 : 14;
        const paragraphs = block.items
          .map((item) =>
            paragraphXml(
              { text: item.text, size, color: THEME.colors.ink },
              { bullet: block.type === "bullet_list", level: item.level ?? 0, spaceBefore: 500 },
            ),
          )
          .join("");
        const height = Math.min(block.items.length * 340000 + 120000, BODY_BOTTOM - y);
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
        const gap = 120000;
        const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
        const cardHeight = Math.min(1_250_000, BODY_BOTTOM - y);
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
              `Metric value ${index + 1}`,
              { x, y: y + 80000, w: cardWidth, h: 420000 },
              {
                paragraphs: paragraphXml({
                  text: `${item.value}${item.unit ? ` ${item.unit}` : ""}`,
                  size: 30,
                  bold: true,
                  color: THEME.colors.accentDark,
                }),
              },
            ),
          );
          const citation = citations.get(item.source) ? ` [${citations.get(item.source)}]` : "";
          shapes.push(
            shape(
              id++,
              `Metric label ${index + 1}`,
              { x, y: y + 520000, w: cardWidth, h: cardHeight - 560000 },
              {
                paragraphs: [
                  paragraphXml({ text: item.label, size: 11, bold: true, color: THEME.colors.ink }),
                  item.context
                    ? paragraphXml({
                        text: `${item.context}${citation}`,
                        size: 9,
                        color: THEME.colors.muted,
                      })
                    : paragraphXml({ text: citation.trim(), size: 9, color: THEME.colors.muted }),
                ].join(""),
              },
            ),
          );
        });
        y += cardHeight + 160000;
        break;
      }
      case "table": {
        const rows = block.rows.slice(0, 8);
        const rowCount = rows.length + 1;
        const height = Math.min(Math.max(rowCount * 300000, 700000), BODY_BOTTOM - y);
        if (block.caption) {
          shapes.push(
            shape(
              id++,
              "Table caption",
              { x: MARGIN, y, w: CONTENT_WIDTH, h: 240000 },
              {
                paragraphs: paragraphXml({
                  text: block.caption,
                  size: 9,
                  italic: true,
                  color: THEME.colors.muted,
                }),
              },
            ),
          );
          y += 240000;
        }
        shapes.push(
          tableXml(id++, block.headers, rows, { x: MARGIN, y, w: CONTENT_WIDTH, h: height }),
        );
        y += height + 140000;
        break;
      }
      case "timeline": {
        const items = block.items.slice(0, 4);
        const gap = 120000;
        const cardWidth = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
        const cardHeight = Math.min(1_350_000, BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Timeline rail",
            { x: MARGIN, y: y + 260000, w: CONTENT_WIDTH, h: 25400 },
            { fill: THEME.colors.border },
          ),
        );
        items.forEach((item, index) => {
          const x = MARGIN + index * (cardWidth + gap);
          shapes.push(
            shape(
              id++,
              `Timeline dot ${index + 1}`,
              { x, y: y + 205000, w: 125000, h: 125000 },
              {
                fill: THEME.colors.accent,
                rounded: true,
              },
            ),
          );
          shapes.push(
            shape(
              id++,
              `Timeline text ${index + 1}`,
              { x, y: y + 400000, w: cardWidth, h: cardHeight - 400000 },
              {
                paragraphs: [
                  paragraphXml({
                    text: item.timeframe,
                    size: 9,
                    bold: true,
                    color: THEME.colors.accent,
                  }),
                  paragraphXml({ text: item.label, size: 13, bold: true, color: THEME.colors.ink }),
                  paragraphXml({
                    text: item.detail.slice(0, 140),
                    size: 9,
                    color: THEME.colors.muted,
                  }),
                ].join(""),
              },
            ),
          );
        });
        y += cardHeight + 120000;
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
        shapes.push(
          shape(
            id++,
            "Callout",
            { x: MARGIN, y, w: CONTENT_WIDTH, h: height },
            {
              fill,
              paragraphs: paragraphXml({ text: block.text, size: 14, color: THEME.colors.ink }),
            },
          ),
        );
        y += height + 120000;
        break;
      }
      case "quote": {
        const height = Math.min(estimateHeight(block), BODY_BOTTOM - y);
        shapes.push(
          shape(
            id++,
            "Quote bar",
            { x: MARGIN, y, w: 45720, h: height },
            { fill: THEME.colors.accent },
          ),
        );
        shapes.push(
          shape(
            id++,
            "Quote",
            { x: MARGIN + 90000, y, w: CONTENT_WIDTH - 90000, h: height },
            {
              paragraphs: [
                paragraphXml({
                  text: `"${block.text}"`,
                  size: 16,
                  italic: true,
                  color: THEME.colors.ink,
                }),
                paragraphXml({ text: block.attribution, size: 9, color: THEME.colors.muted }),
              ].join(""),
            },
          ),
        );
        y += height + 120000;
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

  // Keep the footer area clear even if the content budget was optimistic.
  void section;
  return { shapes: shapes.join(""), nextId: id };
}

function contentSlide(
  section: DocumentSection,
  blocks: readonly Block[],
  index: number,
  model: DocumentModel,
  citations: Map<string, number>,
  continuation: boolean,
): string {
  const shapes: string[] = [];
  shapes.push(
    shape(
      2,
      "Accent band",
      { x: 0, y: 0, w: SLIDE_WIDTH, h: 91440 },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      3,
      "Brand",
      { x: MARGIN, y: TOP - 120000, w: 2_600_000, h: 200000 },
      {
        paragraphs: paragraphXml({
          text: THEME.brand.wordmark,
          size: 9,
          bold: true,
          color: THEME.colors.accent,
        }),
      },
    ),
  );
  const headline = continuation ? `${section.title} (cont.)` : section.title;
  shapes.push(
    shape(
      4,
      "Headline",
      { x: MARGIN, y: TOP + 200000, w: CONTENT_WIDTH, h: 880000 },
      {
        paragraphs: paragraphXml({ text: headline, size: 25, bold: true, color: THEME.colors.ink }),
      },
    ),
  );
  shapes.push(
    shape(
      5,
      "Headline rule",
      { x: MARGIN, y: TOP + 1_090_000, w: 640080, h: 30000 },
      { fill: THEME.colors.accent },
    ),
  );

  const body = renderBlocks(blocks, section, citations, 6);
  shapes.push(body.shapes);

  const sources = sectionSources(section, model).slice(0, 2);
  const footnote = sources
    .map(
      (source) =>
        `${source.title}${source.slide ? ` · slide ${source.slide}` : source.page ? ` · p.${source.page}` : ""}`,
    )
    .join("  |  ");
  shapes.push(
    shape(
      body.nextId + 1,
      "Source footnote",
      { x: MARGIN, y: BODY_BOTTOM + 180000, w: CONTENT_WIDTH - 800000, h: 260000 },
      {
        paragraphs: paragraphXml({
          text: footnote ? `Source: ${footnote}` : THEME.footer,
          size: 8,
          color: THEME.colors.muted,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      body.nextId + 2,
      "Slide number",
      { x: SLIDE_WIDTH - MARGIN - 500000, y: BODY_BOTTOM + 180000, w: 500000, h: 260000 },
      {
        paragraphs: paragraphXml({ text: String(index + 1), size: 8, color: THEME.colors.muted }),
      },
    ),
  );

  return slideXml(shapes.join(""));
}

function sectionNotes(section: DocumentSection, model: DocumentModel): string {
  const references = sectionSources(section, model)
    .slice(0, 4)
    .map((source) => sourceLabel(source, model.sources.indexOf(source)))
    .join("; ");
  const text =
    stripSourceLabels(section.speakerNotes) ||
    "Talk through the evidence behind this slide and invite the client's reaction before moving on.";
  return notesXml(text, references);
}

function coverNotes(model: DocumentModel): string {
  const client = model.cover.client ?? "the client";
  return notesXml(
    `Open with the outcome for ${client} and the decision you want by the end. This deck is built from ${model.sources.length} documents in the Solution Hub library.`,
    "",
  );
}

function sourcesNotes(model: DocumentModel): string {
  return notesXml(
    "Use this slide if the client asks where a figure came from. Every figure in the deck is traceable to these documents.",
    model.sources.map((source, index) => sourceLabel(source, index)).join("; "),
  );
}

function sourcesSlide(
  sources: readonly SourceRecord[],
  part: number,
  totalParts: number,
  startIndex: number,
): string {
  const shapes: string[] = [];
  shapes.push(
    shape(
      2,
      "Accent band",
      { x: 0, y: 0, w: SLIDE_WIDTH, h: 91440 },
      { fill: THEME.colors.accent },
    ),
  );
  shapes.push(
    shape(
      3,
      "Brand",
      { x: MARGIN, y: TOP - 120000, w: 2_600_000, h: 200000 },
      {
        paragraphs: paragraphXml({
          text: THEME.brand.wordmark,
          size: 9,
          bold: true,
          color: THEME.colors.accent,
        }),
      },
    ),
  );
  shapes.push(
    shape(
      4,
      "Title",
      { x: MARGIN, y: 700000, w: CONTENT_WIDTH, h: 600000 },
      {
        paragraphs: paragraphXml({
          text: part === 0 ? "Sources" : `Sources (${part + 1}/${totalParts})`,
          size: 28,
          bold: true,
          color: THEME.colors.ink,
        }),
      },
    ),
  );
  const list = sources
    .map((source, index) =>
      paragraphXml(
        { text: sourceLabel(source, startIndex + index), size: 10, color: THEME.colors.ink },
        { bullet: true, spaceBefore: 500 },
      ),
    )
    .join("");
  shapes.push(
    shape(
      5,
      "Source list",
      { x: MARGIN, y: 1_500_000, w: CONTENT_WIDTH, h: 4_600_000 },
      { paragraphs: list },
    ),
  );
  return slideXml(shapes.join(""));
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

function slideRels(index: number): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/>` +
    `</Relationships>`
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

function contentTypes(slideCount: number): string {
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
  const citations = new Map(model.sources.map((source, index) => [source.chunkId, index + 1]));
  const slides: string[] = [coverSlide(model)];
  const notes: string[] = [coverNotes(model)];

  for (const section of model.sections) {
    const pages = paginateBlocks(section.blocks);
    pages.forEach((blocks, index) => {
      slides.push(contentSlide(section, blocks, slides.length, model, citations, index > 0));
      notes.push(sectionNotes(section, model));
    });
  }

  const sourcesPerSlide = 10;
  const sourceParts = Math.max(1, Math.ceil(model.sources.length / sourcesPerSlide));
  for (let part = 0; part < sourceParts; part += 1) {
    const chunk = model.sources.slice(part * sourcesPerSlide, (part + 1) * sourcesPerSlide);
    slides.push(sourcesSlide(chunk, part, sourceParts, part * sourcesPerSlide));
    notes.push(sourcesNotes(model));
  }

  const parts: Record<string, Uint8Array> = { ...unzipSync(base64ToBytes(DECK_SKELETON_BASE64)) };
  parts["[Content_Types].xml"] = strToU8(contentTypes(slides.length));
  parts["_rels/.rels"] = strToU8(PACKAGE_RELS);
  parts["ppt/presentation.xml"] = strToU8(presentationXml(slides.length));
  parts["ppt/_rels/presentation.xml.rels"] = strToU8(presentationRels(slides.length));
  parts["ppt/notesMasters/notesMaster1.xml"] = strToU8(NOTES_MASTER);
  parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = strToU8(NOTES_MASTER_RELS);
  parts["docProps/core.xml"] = strToU8(coreXml(model.cover.title));
  parts["docProps/app.xml"] = strToU8(APP_XML);
  slides.forEach((slide, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(slideRels(index));
    parts[`ppt/notesSlides/notesSlide${index + 1}.xml`] = strToU8(notes[index] ?? notes[0] ?? "");
    parts[`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`] = strToU8(notesRels(index));
  });

  return { bytes: zipSync(parts, { level: 6 }), pages: slides.length };
}
