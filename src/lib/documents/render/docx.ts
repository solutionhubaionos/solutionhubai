/**
 * Word renderer. Real WordprocessingML: named heading styles (so the navigation
 * pane and TOC work), numbered/bulleted lists with nesting, bordered tables
 * with a repeating header row that cannot split, callout boxes, a cover page, an
 * auto-updating table of contents, and a header/footer with page fields.
 *
 * It consumes the validated DocumentModel; no prose or section structure is
 * defined here.
 */
import { strToU8, zipSync } from "fflate";
import type { Block, DocumentModel, DocumentSection } from "../types";
import { DOCUMENT_THEME as THEME, hexForOoxml } from "../theme";
import { chartPng } from "../chart-image";
import { APP_XML, coreXml, escapeXml, XML_HEADER } from "./ooxml";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CONTENT_WIDTH = 9638;

function run(
  text: string,
  options: { bold?: boolean; italic?: boolean; size?: number; color?: string } = {},
): string {
  const props = [
    `<w:rFonts w:ascii="${THEME.fonts.body}" w:hAnsi="${THEME.fonts.body}"/>`,
    options.bold ? "<w:b/>" : "",
    options.italic ? "<w:i/>" : "",
    options.color ? `<w:color w:val="${hexForOoxml(options.color)}"/>` : "",
    options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : "",
  ].join("");
  const halves = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  const runs = halves
    .map((part) => {
      const bold = part.startsWith("**") && part.endsWith("**");
      const value = bold ? part.slice(2, -2) : part;
      if (!value) return "";
      return `<w:r><w:rPr>${props}${bold ? "<w:b/>" : ""}</w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
    })
    .join("");
  return runs;
}

function paragraph(
  text: string,
  style:
    | "Normal"
    | "Title"
    | "Subtitle"
    | "Heading1"
    | "Heading2"
    | "Heading3"
    | "Caption"
    | "Quote"
    | "TOCHeading"
    | "ListParagraph",
  options: {
    before?: number;
    after?: number;
    bold?: boolean;
    italic?: boolean;
    size?: number;
    color?: string;
    align?: "left" | "right" | "center";
  } = {},
): string {
  const pPr = [
    `<w:pStyle w:val="${style}"/>`,
    options.before !== undefined ? `<w:spacing w:before="${options.before}"/>` : "",
    options.after !== undefined ? `<w:spacing w:after="${options.after}"/>` : "",
    options.align ? `<w:jc w:val="${options.align}"/>` : "",
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${run(text, options)}</w:p>`;
}

function listParagraph(text: string, level: number, ordered: boolean, after = 50): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>` +
    `<w:numPr><w:ilvl w:val="${Math.min(level, 2)}"/><w:numId w:val="${ordered ? 2 : 1}"/></w:numPr>` +
    `<w:spacing w:after="${after}"/><w:contextualSpacing/></w:pPr>` +
    `${run(text, { size: 21 })}</w:p>`
  );
}

function cell(
  text: string,
  options: {
    width: number;
    fill?: string;
    bold?: boolean;
    color?: string;
    size?: number;
    border?: boolean;
  } = { width: CONTENT_WIDTH },
): string {
  const borders =
    options.border === false
      ? ""
      : `<w:tcBorders><w:top w:val="single" w:sz="4" w:color="${hexForOoxml(THEME.colors.border)}"/><w:left w:val="single" w:sz="4" w:color="${hexForOoxml(THEME.colors.border)}"/><w:bottom w:val="single" w:sz="4" w:color="${hexForOoxml(THEME.colors.border)}"/><w:right w:val="single" w:sz="4" w:color="${hexForOoxml(THEME.colors.border)}"/></w:tcBorders>`;
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${Math.round(options.width)}" w:type="dxa"/>` +
    `${borders}` +
    (options.fill
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexForOoxml(options.fill)}"/>`
      : "") +
    `<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar></w:tcPr>` +
    paragraph(text, "Normal", {
      after: 0,
      size: options.size ?? 19,
      ...(options.bold ? { bold: true } : {}),
      ...(options.color ? { color: options.color } : {}),
    }) +
    `</w:tc>`
  );
}

function tableXml(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: { caption?: string; captionCitation?: string; fillHeader?: string } = {},
): string {
  if (headers.length === 0 || rows.length === 0) return "";
  const width = CONTENT_WIDTH / headers.length;
  const headerRow =
    `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>` +
    headers
      .map((header) =>
        cell(header, {
          width,
          fill: options.fillHeader ?? THEME.colors.accent,
          bold: true,
          color: THEME.colors.white,
          size: 18,
        }),
      )
      .join("") +
    `</w:tr>`;

  const body = rows
    .map((row, index) => {
      const fill = index % 2 === 1 ? THEME.colors.surface : undefined;
      return (
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>` +
        headers
          .map((_, column) =>
            cell(row[column] ?? "", {
              width,
              ...(fill ? { fill } : {}),
              size: 18,
            }),
          )
          .join("") +
        `</w:tr>`
      );
    })
    .join("");

  const caption = options.caption
    ? paragraph(`${options.caption}${options.captionCitation ?? ""}`, "Caption", {
        before: 120,
        after: 60,
      })
    : "";

  return (
    caption +
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr><w:tblGrid>${headers.map(() => `<w:gridCol w:w="${Math.round(width)}"/>`).join("")}</w:tblGrid>` +
    `${headerRow}${body}</w:tbl>` +
    `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`
  );
}

function callout(text: string, tone: "info" | "warning" | "success"): string {
  const fill =
    tone === "warning" ? "#FFF4E5" : tone === "success" ? "#E9F5EF" : THEME.colors.accentSoft;
  const bar = tone === "warning" ? THEME.colors.warning : THEME.colors.accent;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>` +
    `<w:top w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>` +
    `<w:left w:val="single" w:sz="24" w:space="0" w:color="${hexForOoxml(bar)}"/>` +
    `</w:tblBorders><w:shd w:val="clear" w:color="auto" w:fill="${hexForOoxml(fill)}"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${CONTENT_WIDTH}"/></w:tblGrid><w:tr><w:tc>` +
    `<w:tcPr><w:tcW w:w="${CONTENT_WIDTH}" w:type="dxa"/><w:tcMar><w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tcMar></w:tcPr>` +
    paragraph(text, "Normal", { after: 0, size: 20 }) +
    `</w:tc></w:tr></w:tbl><w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>`
  );
}

function quote(text: string, attribution: string): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="${hexForOoxml(THEME.colors.accent)}"/></w:pBdr>` +
    `<w:spacing w:before="120" w:after="40"/><w:ind w:left="240"/></w:pPr>` +
    `${run(`"${text}"`, { italic: true, size: 21 })}</w:p>` +
    paragraph(attribution, "Caption", { after: 140 })
  );
}

function citationSuffix(ids: readonly string[], citations: ReadonlyMap<string, number>): string {
  const numbers = [...new Set(ids)]
    .map((id) => citations.get(id))
    .filter((number): number is number => Boolean(number));
  return numbers.length > 0 ? ` ${numbers.map((number) => `[${number}]`).join("")}` : "";
}

/** Avoids appending a second marker when the model already wrote one. */
function suffixFor(
  text: string,
  ids: readonly string[],
  citations: ReadonlyMap<string, number>,
): string {
  return /\[\d+\]/.test(text) ? "" : citationSuffix(ids, citations);
}

function imageParagraph(relId: string, name: string, index: number, caption: string): string {
  const width = 5_943_600;
  const height = Math.round((width * 675) / 1200);
  return (
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr>` +
    `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${100 + index}" name="${escapeXml(name)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${100 + index}" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
    (caption ? paragraph(caption, "Caption", { align: "center", after: 120 }) : "")
  );
}

function blocksToXml(
  blocks: readonly Block[],
  citations: ReadonlyMap<string, number>,
  flags: { isLast: boolean },
  charts: { name: string; png: Uint8Array }[] = [],
): string {
  return blocks
    .map((block, index): string => {
      switch (block.type) {
        case "heading":
          return paragraph(block.text, block.level === 2 ? "Heading2" : "Heading3");
        case "paragraph":
          return paragraph(
            `${block.text}${suffixFor(block.text, block.sources, citations)}`,
            "Normal",
          );
        case "bullet_list":
        case "numbered_list":
          return block.items
            .map((item, itemIndex) => {
              const own = item.sources ?? block.sources;
              const suffix =
                itemIndex === block.items.length - 1 ? suffixFor(item.text, own, citations) : "";
              return listParagraph(
                `${item.text}${suffix}`,
                item.level ?? 0,
                block.type === "numbered_list",
              );
            })
            .join("");
        case "table":
          return tableXml(block.headers, block.rows, {
            ...(block.caption ? { caption: block.caption } : {}),
            captionCitation: suffixFor(block.caption ?? "", block.sources, citations),
          });
        case "metrics":
          return tableXml(
            ["Metric", "Value", "Source"],
            block.items.map((item) => [
              item.context ? `${item.label} — ${item.context}` : item.label,
              `${item.value}${item.unit ? ` ${item.unit}` : ""}`,
              citations.get(item.source) ? `[${citations.get(item.source)}]` : "",
            ]),
            { caption: "Measured outcomes" },
          );
        case "callout":
          return callout(
            `${block.text}${suffixFor(block.text, block.sources, citations)}`,
            block.tone,
          );
        case "quote":
          return quote(
            block.text,
            `${block.attribution}${suffixFor(block.attribution, [block.source], citations)}`,
          );
        case "timeline":
          return tableXml(
            ["Phase", "Timing", "What happens"],
            block.items.map((item) => [
              item.label,
              item.timeframe,
              `${item.detail}${suffixFor(item.detail, item.sources, citations)}`,
            ]),
            { caption: "Indicative timeline" },
          );
        case "comparison":
          return tableXml(
            ["", ...block.options.map((option) => option.name)],
            block.criteria.map((criterion, criterionIndex) => [
              criterion,
              ...block.options.map((option) => option.values[criterionIndex] ?? ""),
            ]),
            { ...(block.title ? { caption: block.title } : {}) },
          );
        case "chart": {
          const png = chartPng(block.chart);
          if (!png) {
            return tableXml(
              ["Category", ...block.chart.series.map((series) => series.name)],
              block.chart.categories.map((category, categoryIndex) => [
                category,
                ...block.chart.series.map((series) => String(series.values[categoryIndex] ?? "")),
              ]),
              { caption: block.chart.title },
            );
          }
          const relId = `rId${6 + charts.length}`;
          charts.push({ name: `chart-${charts.length + 1}.png`, png });
          return imageParagraph(
            relId,
            `chart-${charts.length}.png`,
            charts.length,
            `${block.chart.title}${suffixFor(block.chart.title, block.sources, citations)}`,
          );
        }
        case "kpis":
          return tableXml(
            ["Metric", "Value", "Note"],
            block.items.map((item) => [item.label, item.value, item.note ?? ""]),
            { caption: "Key figures" },
          );
        case "flow":
          return tableXml(
            ["Step", "Detail"],
            block.steps.map((step) => [step.label, step.detail ?? ""]),
            { caption: "How it works" },
          );
        default:
          void index;
          void flags;
          return "";
      }
    })
    .join("");
}

const STYLES_XML =
  `${XML_HEADER}<w:styles xmlns:w="${W_NS}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${THEME.fonts.body}" w:hAnsi="${THEME.fonts.body}" w:eastAsia="${THEME.fonts.body}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="${hexForOoxml(THEME.colors.ink)}"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="2400" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="${hexForOoxml(THEME.colors.ink)}"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:color w:val="${hexForOoxml(THEME.colors.muted)}"/><w:sz w:val="26"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${hexForOoxml(THEME.colors.accent)}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="${hexForOoxml(THEME.colors.accentDark)}"/><w:sz w:val="26"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="${hexForOoxml(THEME.colors.ink)}"/><w:sz w:val="22"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:i/><w:color w:val="${hexForOoxml(THEME.colors.muted)}"/><w:sz w:val="17"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="80"/></w:pPr><w:rPr><w:i/><w:color w:val="${hexForOoxml(THEME.colors.ink)}"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="${hexForOoxml(THEME.colors.ink)}"/><w:sz w:val="36"/></w:rPr></w:style>` +
  `</w:styles>`;

const NUMBERING_XML =
  `${XML_HEADER}<w:numbering xmlns:w="${W_NS}">` +
  `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [0, 1, 2]
    .map(
      (level) =>
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${level === 0 ? "\u2022" : level === 1 ? "\u25e6" : "\u25aa"}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="${THEME.fonts.body}" w:hAnsi="${THEME.fonts.body}"/><w:color w:val="${hexForOoxml(THEME.colors.accent)}"/></w:rPr></w:lvl>`,
    )
    .join("") +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>` +
  [0, 1, 2]
    .map(
      (level) =>
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`,
    )
    .join("") +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

const SETTINGS_XML = `${XML_HEADER}<w:settings xmlns:w="${W_NS}"><w:updateFields w:val="true"/><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>`;

function pageField(): string {
  return (
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  );
}

function headerXml(title: string): string {
  return (
    `${XML_HEADER}<w:hdr xmlns:w="${W_NS}">` +
    `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="${hexForOoxml(THEME.colors.border)}"/></w:pBdr>` +
    `<w:tabs><w:tab w:val="right" w:pos="${CONTENT_WIDTH}"/></w:tabs><w:spacing w:after="0"/></w:pPr>` +
    `${run(THEME.brand.wordmark, { bold: true, size: 15, color: THEME.colors.accent })}` +
    `<w:r><w:tab/></w:r>${run(title.slice(0, 80), { size: 15, color: THEME.colors.muted })}</w:p></w:hdr>`
  );
}

function footerXml(): string {
  return (
    `${XML_HEADER}<w:ftr xmlns:w="${W_NS}">` +
    `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="${hexForOoxml(THEME.colors.border)}"/></w:pBdr>` +
    `<w:tabs><w:tab w:val="right" w:pos="${CONTENT_WIDTH}"/></w:tabs><w:spacing w:after="0"/></w:pPr>` +
    `${run(THEME.footer, { size: 15, color: THEME.colors.muted })}<w:r><w:tab/></w:r>` +
    `${run("Page ", { size: 15, color: THEME.colors.muted })}${pageField()}` +
    `</w:p></w:ftr>`
  );
}

const CONTENT_TYPES =
  `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
  `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
  `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
  `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
  `</Types>`;

const PACKAGE_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
  `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>` +
  `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
  `</Relationships>`;

function coverXml(model: DocumentModel, citations: ReadonlyMap<string, number>): string {
  void citations;
  const meta = [
    model.cover.client ? `Prepared for ${model.cover.client}` : null,
    model.cover.industry ? `Industry: ${model.cover.industry}` : null,
    model.cover.date,
  ].filter((value): value is string => Boolean(value));

  return (
    paragraph(THEME.brand.wordmark, "Caption", {
      before: 0,
      after: 1200,
      color: THEME.colors.accent,
      bold: true,
      size: 18,
    }) +
    paragraph(model.cover.title, "Title") +
    (model.cover.subtitle ? paragraph(model.cover.subtitle, "Subtitle") : "") +
    meta
      .map((line) => paragraph(line, "Normal", { color: THEME.colors.muted, after: 40 }))
      .join("") +
    (model.cover.request
      ? `<w:p><w:pPr><w:spacing w:before="480" w:after="0"/></w:pPr></w:p>` +
        callout(`Request: ${model.cover.request}`, "info")
      : "") +
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`
  );
}

function contentsXml(): string {
  return (
    `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr>` +
    `<w:sdtContent>${paragraph("Contents", "TOCHeading")}` +
    `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>Update fields in Word to build the contents.</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>` +
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`
  );
}

function sourcesXml(model: DocumentModel, citations: ReadonlyMap<string, number>): string {
  if (model.sources.length === 0) return "";
  const items = model.sources
    .map((source) => {
      const where = source.slide
        ? `slide ${source.slide}`
        : source.page
          ? `page ${source.page}`
          : (source.heading ?? "");
      const meta = [source.contentType, source.customerName, source.industry, where]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      return listParagraph(
        `[${citations.get(source.chunkId) ?? 0}] ${source.title} — ${meta}. File: ${source.fileName}`,
        0,
        true,
      );
    })
    .join("");
  return paragraph("Sources", "Heading1") + items;
}

export function renderDocx(model: DocumentModel): { bytes: Uint8Array; pages: number } {
  const citations = new Map(model.sources.map((source, index) => [source.chunkId, index + 1]));
  const body: string[] = [coverXml(model, citations)];
  const includeContents = model.mode === "proposal" && model.sections.length >= 5;
  if (includeContents) body.push(contentsXml());

  model.sections.forEach((section: DocumentSection) => {
    body.push(paragraph(section.title, "Heading1"));
    body.push(blocksToXml(section.blocks, citations, { isLast: false }));
    if (section.flagged) {
      body.push(
        paragraph("This section is marked for completion before the document is sent.", "Caption", {
          color: THEME.colors.warning,
        }),
      );
    }
  });

  body.push(sourcesXml(model, citations));

  const sectPr =
    `<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>` +
    `<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;

  const documentXml =
    `${XML_HEADER}<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body.join("")}${sectPr}</w:body></w:document>`;

  const bytes = zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(PACKAGE_RELS),
      "word/document.xml": strToU8(documentXml),
      "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
      "word/styles.xml": strToU8(STYLES_XML),
      "word/numbering.xml": strToU8(NUMBERING_XML),
      "word/settings.xml": strToU8(SETTINGS_XML),
      "word/header1.xml": strToU8(headerXml(model.cover.title)),
      "word/footer1.xml": strToU8(footerXml()),
      "docProps/core.xml": strToU8(coreXml(model.cover.title)),
      "docProps/app.xml": strToU8(APP_XML),
    },
    { level: 6 },
  );

  const characters = model.sections
    .flatMap((section) => section.blocks)
    .reduce((sum, block) => sum + JSON.stringify(block).length, 0);
  const pages = Math.max(2, Math.round(characters / 2300 + (model.sources.length > 0 ? 0.5 : 0)));

  return { bytes, pages };
}
