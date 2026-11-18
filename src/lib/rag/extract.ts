import { Buffer } from "node:buffer";
import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { documentFormat, type DocumentFormat } from "@/lib/document-format";

export const MIN_USEFUL_CHARS = 20;

/** A picture smaller than this is chrome (logo, bullet icon), not evidence. */
const MIN_FIGURE_BYTES = 24_000;

/** Above this much extracted text a slide is readable without its pictures. */
const LOW_TEXT_SLIDE_CHARS = 400;

/**
 * Alt text in these decks is mostly a shape name — "Rectangle 5", "solid fill",
 * "preencoded.png" — which is noise as a passage. Only prose survives.
 */
const SHAPE_ALT_TEXT =
  /\b(solid fill|gradient|picture|image|graphic|chart|diagram|table|placeholder|rectangle|oval|ellipse|arrow|shape|group|line|text box|preencoded|screenshot|smartart|wordart)\b/i;

// Real decks use custom heading styles; map the common ones to HTML headings.
const DOCX_STYLE_MAP = [
  "p[style-name='Section Heading'] => h1:fresh",
  "p[style-name='Heading 0'] => h1:fresh",
  "p[style-name='Title'] => h1:fresh",
];

/** How a passage should be read: prose, tabular rows, or a described visual. */
export type ChunkKind = "text" | "table" | "figure";

export type ExtractedSection = {
  text: string;
  pageOrSlide: number | null;
  heading: string | null;
  /** Defaults to "text" when omitted, so older callers keep working. */
  kind?: ChunkKind;
  metadata?: Record<string, unknown>;
};

export type EmptyUnit = {
  pageOrSlide: number | null;
  heading: string | null;
};

/** A picture that carries content but no text: only a vision pass can read it. */
export type ImageCandidate = {
  pageOrSlide: number;
  /** Part name inside the package, e.g. ppt/media/image41.png. */
  path: string;
  mimeType: string;
  bytes: number;
  altText: string | null;
};

export type ExtractedDocument = {
  format: DocumentFormat;
  sections: ExtractedSection[];
  emptyUnits: EmptyUnit[];
  warnings: string[];
  /** Pictures worth describing. Empty unless the format embeds media. */
  images: ImageCandidate[];
};

export type ExtractionResult =
  { ok: true; document: ExtractedDocument } | { ok: false; format: DocumentFormat; error: string };

/**
 * Extracts text for one document. Runs in Node (spike) and Deno (Edge
 * Function); never in the browser or the Cloudflare Worker.
 */
export async function extractDocument(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ExtractionResult> {
  const format = documentFormat(fileName, mimeType);
  try {
    switch (format) {
      case "pdf":
        return { ok: true, document: await extractPdf(bytes) };
      case "docx":
        return { ok: true, document: await extractDocx(bytes) };
      case "pptx":
        return { ok: true, document: extractPptx(bytes) };
      case "xlsx":
        return { ok: true, document: extractXlsx(bytes) };
      default:
        return { ok: false, format, error: `Unsupported format: ${format}` };
    }
  } catch (error) {
    return { ok: false, format, error: errorMessage(error) };
  }
}

/** True when a page or slide has too little text to be worth embedding (probable scan). */
export function isLowText(text: string): boolean {
  return text.replace(/\s+/g, "").length < MIN_USEFUL_CHARS;
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  // verbosity 0 silences PDF.js font warnings; one file per ingestion run.
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const sections = pages.map((page, index) => ({
    text: cleanText(page),
    pageOrSlide: index + 1,
    heading: null,
    kind: "text" as ChunkKind,
  }));
  return {
    format: "pdf",
    sections,
    emptyUnits: emptyUnitsFrom(sections),
    warnings: [],
    images: [],
  };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { styleMap: DOCX_STYLE_MAP },
  );
  const sections = sectionsFromHtml(result.value);
  if (sections.length === 0) sections.push({ text: "", pageOrSlide: null, heading: null });
  const warnings = result.messages
    .filter((message) => message.type === "warning")
    .map((message) => message.message);
  return {
    format: "docx",
    sections,
    emptyUnits: emptyUnitsFrom(sections),
    warnings,
    images: [],
  };
}

/**
 * Workbooks are read natively: every cell is text, so a sheet needs no OCR and
 * no model. A sheet becomes one table section whose first row is the header,
 * which is what the chunker repeats on every continuation chunk.
 */
function extractXlsx(bytes: Uint8Array): ExtractedDocument {
  const files = unzipSync(bytes, {
    filter: (file) =>
      file.name === "xl/workbook.xml" ||
      file.name === "xl/_rels/workbook.xml.rels" ||
      file.name === "xl/sharedStrings.xml" ||
      file.name === "xl/styles.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name) ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(file.name),
  });
  const workbook = files["xl/workbook.xml"];
  if (!workbook) throw new Error("No workbook found in Excel file");

  const sheets = xlsxSheetParts(
    strFromU8(workbook),
    files["xl/_rels/workbook.xml.rels"],
    Object.keys(files),
  );
  if (sheets.length === 0) throw new Error("No sheets found in Excel file");

  const shared = xlsxSharedStrings(files["xl/sharedStrings.xml"]);
  const formats = xlsxCellFormats(files["xl/styles.xml"]);
  const warnings: string[] = [];
  const sections: ExtractedSection[] = [];

  for (const sheet of sheets) {
    const data = files[sheet.path];
    if (!data) continue;
    const { rows, truncated } = xlsxSheetRows(strFromU8(data), shared, formats);
    if (rows.length === 0) continue;
    if (truncated) {
      warnings.push(`Sheet ${sheet.name}: only the first ${XLSX_MAX_ROWS} rows were read`);
    }
    const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    sections.push({
      text: tableText(rows),
      pageOrSlide: sheet.index,
      heading: sheet.name || null,
      kind: "table",
      metadata: {
        source: "sheet",
        sheet: sheet.name,
        sheet_index: sheet.index,
        rows: rows.length,
        columns,
      },
    });
  }

  return { format: "xlsx", sections, emptyUnits: [], warnings, images: [] };
}

function extractPptx(bytes: Uint8Array): ExtractedDocument {
  // Two passes: decompress only the small XML parts first, then whatever media
  // the vision pass asks for. Decks in this library carry gigabytes of images,
  // so never inflate media speculatively.
  const mediaBytes = new Map<string, number>();
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (file.name.startsWith("ppt/media/")) {
        mediaBytes.set(file.name, Math.max(file.originalSize ?? 0, file.size ?? 0));
        return false;
      }
      return (
        /^ppt\/slides\/slide\d+\.xml$/.test(file.name) ||
        /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(file.name) ||
        /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(file.name) ||
        /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/.test(file.name) ||
        /^ppt\/charts\/chart\d+\.xml$/.test(file.name) ||
        /^ppt\/diagrams\/data\d+\.xml$/.test(file.name)
      );
    },
  });

  const notes = pptxNotes(files);
  const slides = Object.keys(files)
    .map((path) => ({ path, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(path) }))
    .filter((entry): entry is { path: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  if (slides.length === 0) throw new Error("No slides found in PowerPoint file");

  const warnings: string[] = [];
  const sections: ExtractedSection[] = [];
  const images: ImageCandidate[] = [];
  const seenImages = new Set<string>();
  const seenCharts = new Set<string>();

  for (const { path, match } of slides) {
    const number = Number(match[1]);
    const data = files[path];
    if (!data) continue;
    try {
      const xml = strFromU8(data);
      const rels = parseRels(
        files[`ppt/slides/_rels/slide${number}.xml.rels`]
          ? strFromU8(files[`ppt/slides/_rels/slide${number}.xml.rels`]!)
          : undefined,
      );

      // Tables are real XML text, so they need no OCR at all: pull them out of
      // the slide, leave the surrounding prose behind.
      const tableSections = pptxTables(xml, number);

      // Prose excludes table cells so their text is not stored twice.
      const prose = slideXmlToText(xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, "\n"));
      const note = notes.get(number);
      if (prose) {
        sections.push({
          text: note ? `${prose}\n\nNotes: ${note}` : prose,
          pageOrSlide: number,
          heading: slideHeading(prose),
          kind: "text",
        });
      } else if (note) {
        sections.push({ text: `Notes: ${note}`, pageOrSlide: number, heading: null, kind: "text" });
      }
      sections.push(...tableSections);

      // Native charts: series names and any cached values live in the chart part.
      for (const chartId of slideRelIds(xml, "c:chart")) {
        const target = rels.get(chartId);
        if (!target || !target.startsWith("ppt/charts/")) continue;
        const chartData = files[target];
        if (!chartData || seenCharts.has(target)) continue;
        seenCharts.add(target);
        sections.push(...chartSections(strFromU8(chartData), number, slideHeading(prose), target));
      }

      // SmartArt keeps its text in a diagram data part, not in the slide.
      for (const diagramId of slideRelIds(xml, "dgm:relIds", "r:dm")) {
        const target = rels.get(diagramId);
        const diagram = target ? files[target] : undefined;
        if (!diagram) continue;
        const text = slideXmlToText(strFromU8(diagram));
        if (!text) continue;
        sections.push({
          text,
          pageOrSlide: number,
          heading: slideHeading(prose),
          kind: "text",
          metadata: { source: "diagram", part: target },
        });
      }

      // Pictures: alt text is free and often descriptive; anything else is a
      // vision candidate, never guessed at here.
      const slideTextChars =
        prose.length + tableSections.reduce((total, section) => total + section.text.length, 0);
      for (const picture of pptxPictures(xml)) {
        const target = picture.relId ? rels.get(picture.relId) : undefined;
        const part = target && target.startsWith("ppt/media/") ? target : null;
        // Alt text here is machine-written shape prose ("A person sitting at a
        // desk AI-generated content may be incorrect"), so it is kept as the
        // caption for the vision pass and never stored as a passage of its own.
        const altText = usableAltText(picture.altText);
        if (!part || seenImages.has(part)) continue;
        if (slideTextChars > LOW_TEXT_SLIDE_CHARS) continue;
        const size = mediaBytes.get(part) ?? 0;
        if (size < MIN_FIGURE_BYTES) continue;
        seenImages.add(part);
        images.push({
          pageOrSlide: number,
          path: part,
          mimeType: imageMimeType(part),
          bytes: size,
          altText,
        });
      }
    } catch (error) {
      warnings.push(`Slide ${number}: ${errorMessage(error)}`);
      sections.push({ text: "", pageOrSlide: number, heading: null });
    }
  }

  return { format: "pptx", sections, emptyUnits: emptyUnitsFrom(sections), warnings, images };
}

/** Inflates just the named media parts, for the vision pass. */
export function readMediaFiles(zip: Uint8Array, paths: readonly string[]): Map<string, Uint8Array> {
  const wanted = new Set(paths);
  const result = new Map<string, Uint8Array>();
  if (wanted.size === 0) return result;
  const files = unzipSync(zip, { filter: (file) => wanted.has(file.name) });
  for (const [name, data] of Object.entries(files)) result.set(name, data);
  return result;
}

function pptxTables(xml: string, slide: number): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  const tables = [...xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g)];
  tables.forEach((table, index) => {
    const rows = [...table[1]!.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((row) =>
      [...row[1]!.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((cell) =>
        [...cell[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
          .map((run) => decodeXmlEntities(run[1] ?? ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    const text = tableText(rows);
    if (!text) return;
    const columns = Math.max(...rows.map((row) => row.filter(Boolean).length), 0);
    sections.push({
      text,
      pageOrSlide: slide,
      heading: null,
      kind: "table",
      metadata: { source: "table", slide, table: index + 1, rows: rows.length, columns },
    });
  });
  return sections;
}

/** A sheet with more rows than this is a data dump; keep it readable. */
const XLSX_MAX_ROWS = 2_000;

/** Excel serial dates are days since 1899-12-30 (which absorbs the 1900 leap bug). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** Built-in number formats Excel ships without a `<numFmt>` entry. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);

type CellFormat = { date: boolean; percent: boolean; currency: string | null };

type XlsxSheet = { name: string; path: string; index: number };

/** Sheet names in workbook order, resolved through the workbook relationships. */
function xlsxSheetParts(
  workbookXml: string,
  rels: Uint8Array | undefined,
  available: readonly string[],
): XlsxSheet[] {
  const targets = new Map<string, string>();
  if (rels) {
    for (const match of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
      if (!id || !target) continue;
      const clean = target.replace(/\\/g, "/").replace(/^\.\//, "");
      targets.set(id, clean.startsWith("/") ? clean.slice(1) : `xl/${clean}`);
    }
  }

  const block = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbookXml)?.[1] ?? "";
  const named = [...block.matchAll(/<sheet\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(tag)?.[1] ?? "");
    const relId = /\br:id="([^"]+)"/.exec(tag)?.[1] ?? "";
    return { name, path: targets.get(relId) ?? "" };
  });

  const sheets: XlsxSheet[] = [];
  named.forEach((sheet) => {
    const path = sheet.path && available.includes(sheet.path) ? sheet.path : "";
    if (path) sheets.push({ name: sheet.name, path, index: sheets.length + 1 });
  });

  // Older writers omit the relationship: fall back to worksheet part order.
  if (sheets.length === 0) {
    available
      .filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))
      .sort((a, b) => {
        const first = Number(/(\d+)/.exec(a)?.[1] ?? 0);
        const second = Number(/(\d+)/.exec(b)?.[1] ?? 0);
        return first - second;
      })
      .forEach((path, index) => sheets.push({ name: "", path, index: index + 1 }));
  }

  return sheets;
}

/** Shared strings: one entry per distinct text cell, indexed by `<v>` in the cell. */
function xlsxSharedStrings(data: Uint8Array | undefined): string[] {
  if (!data) return [];
  return [...strFromU8(data).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((run) => decodeXmlEntities(run[1] ?? ""))
      .join("")
      .trim(),
  );
}

/**
 * A number cell holds only `0.35`; the format says whether that is 35% or a
 * date serial. Resolving it here keeps figures citable instead of cryptic.
 */
function xlsxCellFormats(data: Uint8Array | undefined): CellFormat[] {
  if (!data) return [];
  const xml = strFromU8(data);
  const codes = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[0])?.[1]);
    const code = decodeXmlEntities(/\bformatCode="([^"]*)"/.exec(match[0])?.[1] ?? "");
    if (Number.isFinite(id)) codes.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((match) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[0])?.[1] ?? 0);
    const code = codes.get(id) ?? "";
    const bare = code.replace(/"[^"]*"/g, "");
    return {
      date: BUILTIN_DATE_FORMATS.has(id) || /[ymd]/i.test(bare),
      percent: BUILTIN_PERCENT_FORMATS.has(id) || bare.includes("%"),
      currency: bare.includes("$")
        ? "$"
        : bare.includes("€")
          ? "€"
          : bare.includes("£")
            ? "£"
            : null,
    };
  });
}

/** Cells laid out by column, so a sparse row still lines up under its header. */
function xlsxSheetRows(
  xml: string,
  shared: readonly string[],
  formats: readonly CellFormat[],
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= XLSX_MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    let cursor = 0;
    for (const cell of rowMatch[1]!.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const raw = cell[0];
      const head = /^<c\b([^>]*?)\/?>/.exec(raw)?.[1] ?? "";
      const body = raw.endsWith("</c>")
        ? raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("</c>"))
        : "";
      const reference = /\br="([A-Z]+)\d+"/.exec(head)?.[1];
      const column = reference ? xlsxColumnIndex(reference) : cursor;
      const value = xlsxCellValue(head, body, shared, formats);
      cursor = column + 1;
      if (value) cells[column] = value;
    }
    while (cells.length > 0 && !cells[cells.length - 1]) cells.pop();
    if (cells.length > 0) rows.push(cells.map((value) => value ?? ""));
  }

  return { rows, truncated };
}

function xlsxCellValue(
  head: string,
  body: string,
  shared: readonly string[],
  formats: readonly CellFormat[],
): string {
  const type = /\bt="([^"]+)"/.exec(head)?.[1];
  if (type === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXmlEntities(match[1] ?? ""))
      .join("")
      .trim();
  }
  const raw = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim();
  if (!raw) return "";
  if (type === "s") return (shared[Number(raw)] ?? "").trim();
  if (type === "str") return raw;
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  // Error cells (#REF!, #DIV/0!) are not evidence.
  if (type === "e") return "";
  if (type === "d") return raw;

  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const format = formats[Number(/\bs="(\d+)"/.exec(head)?.[1] ?? -1)];
  if (format?.date) return xlsxDate(value);
  if (format?.percent) return `${xlsxNumber(value * 100)}%`;
  if (format?.currency) return `${format.currency}${xlsxNumber(value)}`;
  return xlsxNumber(value);
}

/** Thousands separators, at most six decimals, no scientific notation. */
function xlsxNumber(value: number): string {
  const rounded = Number(value.toFixed(6));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(rounded);
}

/** 45292 -> 2024-01-01; a fractional serial keeps its time. */
function xlsxDate(serial: number): string {
  const date = new Date(EXCEL_EPOCH_MS + serial * DAY_MS);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

function xlsxColumnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(index - 1, 0);
}

/** Pipe-delimited rows: the header stays adjacent to every value. */
function tableText(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .join(" | ")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter((line) => line.replace(/\|/g, "").trim().length > 0)
    .join("\n");
}

type PptxPicture = { relId: string | null; altText: string | null };

function pptxPictures(xml: string): PptxPicture[] {
  const pictures: PptxPicture[] = [];
  for (const match of xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
    const block = match[0];
    const altText = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/.exec(block)?.[1] ?? null;
    const relId = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block)?.[1] ?? null;
    pictures.push({ relId, altText: altText ? decodeXmlEntities(altText) : null });
  }
  return pictures;
}

/** Relationship ids used by a given element, e.g. every `<c:chart r:id="..."/>`. */
function slideRelIds(xml: string, tag: string, attribute = "r:id"): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]+)"`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}

/**
 * Chart parts carry the series names, categories and — when the author cached
 * them — the plotted values. No OCR: the numbers are XML.
 */
function chartSections(
  xml: string,
  slide: number,
  heading: string | null,
  part: string,
): ExtractedSection[] {
  const title = elementText(xml, "c:title");
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match) => {
    const block = match[1]!;
    const name = elementText(block, "c:tx");
    const categories = cachePoints(elementBlock(block, "c:cat"));
    const values = cachePoints(elementBlock(block, "c:val"));
    return { name, categories, values };
  });

  const lines: string[] = [];
  if (title) lines.push(`Chart: ${title}`);
  let hasValues = false;
  series.forEach((entry, index) => {
    const label = entry.name || `Series ${index + 1}`;
    if (entry.values.length > 0) {
      hasValues = true;
      const pairs = entry.values.map((value, point) => {
        const category = entry.categories[point];
        return category ? `${category} ${value}` : value;
      });
      lines.push(`${label}: ${pairs.join(", ")}`);
    } else {
      lines.push(`${label}: plotted values are stored in the embedded workbook (not extracted)`);
    }
  });

  if (lines.length === 0) return [];
  return [
    {
      text: lines.join("\n"),
      pageOrSlide: slide,
      heading,
      kind: hasValues ? "table" : "figure",
      metadata: {
        source: "chart",
        slide,
        part,
        series: series.length,
        hasValues,
      },
    },
  ];
}

/** Text of the first element with this tag, used for chart and axis titles. */
function elementText(xml: string, tag: string): string | null {
  const block = elementBlock(xml, tag);
  if (!block) return null;
  const text = [...block.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function elementBlock(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  return pattern.exec(xml)?.[1] ?? null;
}

/** Point values from a `<c:strCache>` or `<c:numCache>` inside a series block. */
function cachePoints(block: string | null): string[] {
  if (!block) return [];
  const cache = /<c:(?:str|num)Cache>([\s\S]*?)<\/c:(?:str|num)Cache>/.exec(block)?.[1];
  if (!cache) return [];
  return [...cache.matchAll(/<c:pt\b[^>]*>([\s\S]*?)<\/c:pt>/g)]
    .map((point) => decodeXmlEntities(/<c:v>([\s\S]*?)<\/c:v>/.exec(point[1] ?? "")?.[1] ?? ""))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseRels(xml: string | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) rels.set(id, resolvePart(target));
  }
  return rels;
}

/** Package-absolute part name for a relationship target like ../media/image1.png. */
function resolvePart(target: string): string {
  const clean = target.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  if (clean.startsWith("ppt/")) return clean;
  return clean.startsWith("media/") || clean.startsWith("charts/") || clean.startsWith("diagrams/")
    ? `ppt/${clean}`
    : `ppt/slides/${clean}`;
}

/** Alt text worth storing, or null when it only names the shape. */
function usableAltText(alt: string | null): string | null {
  if (!alt) return null;
  const clean = alt.replace(/\s+/g, " ").trim();
  if (clean.replace(/\s+/g, "").length < MIN_USEFUL_CHARS) return null;
  if (/\.[a-z0-9]{2,4}$/i.test(clean)) return null;
  if (SHAPE_ALT_TEXT.test(clean)) return null;
  return clean;
}

function imageMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "bmp") return "image/bmp";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  return "image/png";
}

/** First non-empty line, when it reads like a title rather than a sentence. */
function slideHeading(prose: string): string | null {
  const line = prose
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!line || line.length > 120) return null;
  return line;
}

/** Drops the slide-number placeholder from notes, keeping real speaker notes. */
function cleanNotes(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\d+$/.test(line))
    .join("\n");
}

function pptxNotes(files: Record<string, Uint8Array>): Map<number, string> {
  const notes = new Map<number, string>();
  for (const [path, data] of Object.entries(files)) {
    const match = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(path);
    if (!match) continue;
    try {
      const text = cleanNotes(slideXmlToText(strFromU8(data)));
      if (!text) continue;
      let slideNumber = Number(match[1]);
      const rels = files[`ppt/notesSlides/_rels/notesSlide${match[1]}.xml.rels`];
      if (rels) {
        const target = /Target="[^"]*slides\/slide(\d+)\.xml"/.exec(strFromU8(rels));
        if (target?.[1]) slideNumber = Number(target[1]);
      }
      notes.set(slideNumber, text);
    } catch {
      // Notes are optional; malformed notes must not fail the deck.
    }
  }
  return notes;
}

/** Pulls the a:t text runs out of one slide or notes XML file. */
export function slideXmlToText(xml: string): string {
  const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)];
  const lines = paragraphs
    .map((paragraph) =>
      [...(paragraph[1] ?? "").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((run) => decodeXmlEntities(run[1] ?? ""))
        .join("")
        .trim(),
    )
    .filter(Boolean);

  if (lines.length > 0) return lines.join("\n");

  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((run) => decodeXmlEntities(run[1] ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function sectionsFromHtml(html: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  let heading: string | null = null;
  let buffer = "";

  const flush = () => {
    const text = htmlToText(buffer);
    buffer = "";
    if (text) sections.push({ text, pageOrSlide: null, heading, kind: "text" });
  };

  // Headings and tables are both block boundaries; everything between is prose.
  const tokenPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>|<table\b[\s\S]*?<\/table>/gi;
  let lastIndex = 0;
  for (const match of html.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    buffer += html.slice(lastIndex, index);
    lastIndex = index + match[0].length;

    if (/^<table/i.test(match[0])) {
      flush();
      const table = htmlTableSection(match[0], heading);
      if (table) sections.push(table);
      continue;
    }
    flush();
    heading = htmlToText(match[2] ?? "");
  }
  buffer += html.slice(lastIndex);
  flush();
  return sections;
}

function htmlTableSection(html: string, heading: string | null): ExtractedSection | null {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
      htmlToText(cell[1] ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
  const text = tableText(rows);
  if (!text) return null;
  const columns = Math.max(...rows.map((row) => row.filter(Boolean).length), 0);
  return {
    text,
    pageOrSlide: null,
    heading,
    kind: "table",
    metadata: { source: "table", rows: rows.length, columns },
  };
}

function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<\/(?:p|h[1-6]|li|tr|blockquote|div)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#")) {
      const hex = normalized.startsWith("#x");
      const code = Number.parseInt(normalized.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[normalized] ?? match;
  });
}

function emptyUnitsFrom(sections: readonly ExtractedSection[]): EmptyUnit[] {
  return sections
    .filter((section) => isLowText(section.text))
    .map((section) => ({ pageOrSlide: section.pageOrSlide, heading: section.heading }));
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
