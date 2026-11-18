/**
 * PowerPoint renderer. PptxGenJS writes native, editable shapes, tables and
 * charts; this module owns the composition.
 *
 * What it does with the validated model:
 *  - one idea per slide, takeaway headlines, speaker notes on every slide;
 *  - a layout chosen per section: cover, section divider, text, table, two-zone
 *    visual + commentary, full-width visual, KPI cards, process, timeline,
 *    comparison, closing, sources;
 *  - a real type scale (title 28, body 16, tables 12, KPI 40) with auto-shrink
 *    to 12pt and continuation slides instead of 9pt walls of text;
 *  - tables that never cut a word: cells shorten at a word boundary and rows
 *    and columns split across slides rather than squeezing;
 *  - native charts with data labels, the palette from `deck-theme.ts`, and an
 *    "illustrative" badge whenever the values are assumptions.
 *
 * The deck is client-facing and carries the argument only: no citation marks
 * and no source list. Provenance stays in the trace and in DOCX/PDF. Both the
 * per-slide source line and the sources slide exist but are off by default; see
 * `DECK_THEME.config`.
 */
import PptxGenJS from "pptxgenjs";
import type {
  Block,
  ChartSpec,
  DocumentModel,
  DocumentSection,
  KpiItem,
  MetricItem,
  TableBlock,
} from "../types";
import {
  DECK_THEME as T,
  resolveDeckConfig,
  type DeckConfig,
  type ResolvedDeckConfig,
} from "../deck-theme";
import { sectionTagFor } from "../outline";
import { dropDanglingOverrides } from "./pptx-package";
import { palette } from "../tokens";

// The house palette, read from the brand tokens. The legacy renderer stays as
// the fallback for fixtures; the deck pipeline uses render/deck.ts.
const C: Record<keyof typeof T.colors, string> = { ...T.colors };
const SERIES: string[] = [...T.chartSeries];
/** Heading ink on the dark masters. */
const HIGHLIGHT = C.navy;

const G = T.geometry;
const S = T.type;
const CONTENT_W = G.width - G.margin * 2;
const BODY_H = G.bodyBottom - G.bodyTop;

type Slide = ReturnType<PptxGenJS["addSlide"]>;
type TextRun = PptxGenJS.TextProps;

/* ------------------------------------------------------------------ text --- */

/** Citation marks and S-labels are prompt plumbing; a deck shows none of it. */
function cleanText(text: string): string {
  return text
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** `**phrase**` in the model becomes a bold blue run: the slide's one emphasis. */
function runsFor(
  text: string,
  options: { size: number; color: string; bold?: boolean; fontFace: string; italic?: boolean },
): TextRun[] {
  const parts = cleanText(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean);
  return parts.map((part) => {
    const strong = part.startsWith("**") && part.endsWith("**");
    return {
      text: strong ? part.slice(2, -2) : part,
      options: {
        bold: options.bold === true || strong,
        italic: options.italic === true,
        color: strong ? C.blue : options.color,
        fontFace: options.fontFace,
        fontSize: options.size,
      },
    };
  });
}

/**
 * Rough line count without a font engine. A typical body font averages about
 * half an em per glyph, so an inch holds ~144/size characters. Deliberately
 * conservative:
 * over-estimating produces a slightly roomier slide, under-estimating overflows.
 */
function lineCount(text: string, widthIn: number, size: number): number {
  const charsPerLine = Math.max(8, Math.floor((widthIn * 156) / size));
  return cleanText(text)
    .split(/\n/)
    .reduce((total, paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (words.length === 0) return total + 1;
      let lines = 1;
      let current = 0;
      for (const word of words) {
        const addition = current === 0 ? word.length : word.length + 1;
        if (current + addition > charsPerLine) {
          lines += 1;
          current = word.length;
        } else {
          current += addition;
        }
      }
      return total + lines;
    }, 0);
}

/**
 * Table cells keep reference numbers: deleting `[1]` outright left the model's
 * Evidence column blank, which reads as a rendering bug. The brackets go, the
 * number stays.
 */
function tableCellText(text: string): string {
  const refs = [...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].map((match) => match[1]);
  const cleaned = text
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " ")
    // An ellipsis authored in the cell would otherwise end mid-phrase and read
    // as a renderer truncation; the table's own shortening adds one cleanly.
    .replace(/\s*…/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (cleaned) return cleaned;
  return refs.join(", ");
}

/** Word-boundary shortening: never cuts a word, ellipsis only as a last resort. */
function shortenAtWord(text: string, maxChars: number, maxWords = Infinity): string {
  const clean = cleanText(text).replace(/\s+/g, " ");
  if (!clean) return "";
  const words = clean.split(" ");
  const kept: string[] = [];
  for (const word of words) {
    const next = kept.length === 0 ? word : `${kept.join(" ")} ${word}`;
    if (kept.length >= maxWords) break;
    if (next.length > maxChars && kept.length > 0) break;
    kept.push(word);
  }
  if (kept.length === words.length) return clean;
  return `${kept.join(" ").replace(/,|;|:$/, "")}…`;
}

/* ------------------------------------------------------------- body items --- */

type Tone = "info" | "warning" | "success";

type BodyItem =
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string; level: number; tag?: string }
  | { kind: "callout"; text: string; tone: Tone }
  | { kind: "quote"; text: string; attribution: string };

/** Width reserved beside a bullet for its "Proposed" tag. */
const TAG_W = 0.92;
const TAG_H = 0.26;

function toneFill(tone: Tone): { fill: string; bar: string } {
  switch (tone) {
    case "warning":
      return { fill: palette.pearl, bar: C.amber };
    case "success":
      return { fill: palette.pearl, bar: C.teal };
    default:
      return { fill: palette.softBlue, bar: C.blue };
  }
}

function itemHeight(item: BodyItem, widthIn: number, size: number): number {
  const lineHeight = (size * 1.28) / 72;
  switch (item.kind) {
    case "callout":
      return lineCount(item.text, widthIn - 0.56, size) * lineHeight + 0.34;
    case "quote":
      return lineCount(item.text, widthIn - 0.34, size) * lineHeight + 0.26;
    case "bullet":
      return (
        lineCount(item.text, widthIn - 0.34 - item.level * 0.3 - (item.tag ? TAG_W : 0), size) *
          lineHeight +
        0.14
      );
    default:
      return lineCount(item.text, widthIn, size) * lineHeight + 0.16;
  }
}

function totalHeight(items: readonly BodyItem[], widthIn: number, size: number): number {
  return items.reduce((sum, item) => sum + itemHeight(item, widthIn, size), 0);
}

/** Largest size in the scale that fits; falls back to the minimum and splits. */
function fitSize(
  items: readonly BodyItem[],
  widthIn: number,
  heightIn: number,
  sizes: readonly number[] = [S.bodyMax, S.body, 14, S.bodyMin],
): number {
  for (const size of sizes) {
    if (totalHeight(items, widthIn, size) <= heightIn) return size;
  }
  return sizes[sizes.length - 1] ?? S.bodyMin;
}

/** Splits one item that is taller than a whole slide's body into word chunks. */
function splitItem(item: BodyItem, widthIn: number, heightIn: number): BodyItem[] {
  if (item.kind === "callout" || item.kind === "quote") return [item];
  const size = S.body;
  const words = cleanText(item.text).split(/\s+/).filter(Boolean);
  const chunks: BodyItem[] = [];
  let current: string[] = [];
  for (const word of words) {
    const probe = [...current, word].join(" ");
    const candidate: BodyItem =
      item.kind === "bullet"
        ? { kind: "bullet", text: probe, level: item.level, ...(item.tag ? { tag: item.tag } : {}) }
        : { kind: "para", text: probe };
    if (current.length > 0 && itemHeight(candidate, widthIn, size) > heightIn) {
      chunks.push(
        item.kind === "bullet"
          ? {
              kind: "bullet",
              text: current.join(" "),
              level: item.level,
              ...(item.tag ? { tag: item.tag } : {}),
            }
          : { kind: "para", text: current.join(" ") },
      );
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) {
    chunks.push(
      item.kind === "bullet"
        ? {
            kind: "bullet",
            text: current.join(" "),
            level: item.level,
            ...(item.tag ? { tag: item.tag } : {}),
          }
        : { kind: "para", text: current.join(" ") },
    );
  }
  return chunks;
}

/** Groups body items into slides, splitting any item that cannot fit alone. */
function paginate(items: readonly BodyItem[], widthIn: number, heightIn: number): BodyItem[][] {
  const pages: BodyItem[][] = [];
  let current: BodyItem[] = [];
  let used = 0;
  for (const raw of items) {
    let item = raw;
    if (itemHeight(item, widthIn, S.body) > heightIn) {
      if (current.length > 0) {
        pages.push(current);
        current = [];
        used = 0;
      }
      const chunks = splitItem(item, widthIn, heightIn);
      chunks.slice(0, -1).forEach((chunk) => pages.push([chunk]));
      item = chunks[chunks.length - 1] ?? item;
      used = itemHeight(item, widthIn, S.body);
      current = [item];
      continue;
    }
    const height = itemHeight(item, widthIn, S.body);
    if (current.length > 0 && used + height > heightIn) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current = [...current, item];
    used += height;
  }
  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}

function bodyItemsOf(blocks: readonly Block[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        if (block.text.trim()) items.push({ kind: "para", text: block.text });
        break;
      case "bullet_list":
        block.items.forEach((item) =>
          items.push({
            kind: "bullet",
            text: item.text,
            level: item.level ?? 0,
            ...(item.kind === "recommendation" ? { tag: "Proposed" } : {}),
          }),
        );
        break;
      case "numbered_list":
        block.items.forEach((item, index) =>
          items.push({
            kind: "bullet",
            text: `${index + 1}. ${item.text}`,
            level: item.level ?? 0,
            ...(item.kind === "recommendation" ? { tag: "Proposed" } : {}),
          }),
        );
        break;
      case "callout":
        items.push({ kind: "callout", text: block.text, tone: block.tone });
        break;
      case "quote":
        items.push({ kind: "quote", text: block.text, attribution: block.attribution });
        break;
      case "metrics":
        block.items.forEach((metric) =>
          items.push({
            kind: "bullet",
            text: [metric.label, metric.value].filter(Boolean).join(": "),
            level: 0,
          }),
        );
        break;
      default:
        break;
    }
  }
  return items;
}

/* ------------------------------------------------------------------ chrome --- */

function tag(section: DocumentSection): string {
  return sectionTagFor(section.kind).toUpperCase();
}

/**
 * Section tag and (optionally) the per-slide source line. Masters carry the
 * title, footer and slide number; these two vary per slide, so they are drawn
 * in fixed zones: the tag above the title, the source line above the footer.
 */
function addChrome(
  slide: Slide,
  section: DocumentSection,
  cfg: ResolvedDeckConfig,
  tagText = tag(section),
): void {
  slide.addText(tagText, {
    x: G.margin,
    y: G.tagY,
    w: 7,
    h: 0.26,
    fontFace: cfg.bodyFont,
    fontSize: S.tag,
    bold: true,
    color: C.teal,
    charSpacing: 1.4,
    margin: 0,
    isTextBox: true,
  });
  if (cfg.showSourceLine) {
    const labels = sourceLabelsFor(section);
    if (labels.length > 0) {
      slide.addText(`Source: ${labels.join(" · ")}`, {
        x: G.margin,
        y: G.sourceY,
        w: CONTENT_W,
        h: 0.24,
        fontFace: cfg.bodyFont,
        fontSize: S.caption,
        color: C.slate,
        margin: 0,
        isTextBox: true,
      });
    }
  }
}

/** Titles are short on a deck; only the very long ones drop a step on the scale. */
function titleSizeFor(title: string): number {
  const length = cleanText(title).length;
  if (length > 90) return S.titleMin;
  if (length > 64) return 25;
  return S.title;
}

function addTitle(slide: Slide, title: string): void {
  slide.addText(cleanText(title), {
    placeholder: "title",
    fontSize: titleSizeFor(title),
    align: "left",
    valign: "top",
  });
}

function illustrativeBadge(slide: Slide, x: number, y: number): void {
  const label = "Illustrative — replace with actuals";
  slide.addShape("roundRect", {
    x,
    y,
    w: 2.34,
    h: 0.3,
    fill: { color: palette.pearl },
    line: { color: C.amber, width: 0.75 },
    rectRadius: 0.1,
  });
  slide.addText(label, {
    x,
    y: y + 0.02,
    w: 2.34,
    h: 0.26,
    fontFace: T.fonts.body,
    fontSize: 9.5,
    bold: true,
    color: palette.deepNavy,
    align: "center",
    valign: "middle",
    margin: 0,
  });
}

const TAKEAWAY_SIZE = 14;

/** The so-what line: a teal accent bar beside one or two sentences. */
function takeawayHeight(text: string, widthIn: number): number {
  return lineCount(text, widthIn - 0.32, TAKEAWAY_SIZE) * ((TAKEAWAY_SIZE * 1.3) / 72) + 0.18;
}

function addTakeaway(
  slide: Slide,
  text: string,
  x: number,
  y: number,
  w: number,
  cfg: ResolvedDeckConfig,
): number {
  const height = takeawayHeight(text, w);
  slide.addShape("rect", {
    x,
    y: y + 0.02,
    w: 0.06,
    h: Math.max(0.2, height - 0.06),
    fill: { color: C.teal },
    line: { color: C.teal, width: 0 },
  });
  slide.addText(runsFor(text, { size: TAKEAWAY_SIZE, color: C.navy, fontFace: cfg.headingFont }), {
    x: x + 0.2,
    y,
    w: w - 0.26,
    h: height,
    valign: "top",
    margin: 0,
    isTextBox: true,
  });
  return height;
}

function sourceLabelsFor(section: DocumentSection): string[] {
  const ids = new Set<string>();
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) if ("sources" in block) block.sources.forEach((id) => ids.add(id));
  };
  walk(section.blocks ?? []);
  return [...ids].slice(0, 3);
}

/* ------------------------------------------------------------------ charts --- */

type ChartBox = { x: number; y: number; w: number; h: number };

function normaliseChart(chart: ChartSpec): {
  categories: string[];
  series: { name: string; values: number[] }[];
} {
  const categories = chart.categories.map((category) => cleanText(category)).slice(0, 8);
  const series = chart.series
    .slice(0, 4)
    .map((entry) => ({
      name: cleanText(entry.name) || "Value",
      values: categories.map((_, index) => {
        const value = entry.values[index];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      }),
    }))
    .filter((entry) => entry.values.some((value) => value !== 0));
  return { categories, series };
}

function chartKindFor(
  chart: ChartSpec,
  categoryCount: number,
): {
  type: "bar" | "line" | "pie" | "doughnut";
  stacked: boolean;
  pie: boolean;
} {
  switch (chart.type) {
    case "line":
      return { type: "line", stacked: false, pie: false };
    case "pie":
    case "doughnut":
      // A pie with more than five slices is unreadable; the bar carries it.
      if (categoryCount > 5) return { type: "bar", stacked: false, pie: false };
      return { type: chart.type, stacked: false, pie: true };
    case "stacked_bar":
      return { type: "bar", stacked: true, pie: false };
    default:
      return { type: "bar", stacked: false, pie: false };
  }
}

function addChart(slide: Slide, chart: ChartSpec, box: ChartBox): void {
  const { categories, series } = normaliseChart(chart);
  if (categories.length === 0 || series.length === 0) return;
  const kind = chartKindFor(chart, categories.length);
  const data = kind.pie
    ? [{ name: series[0]?.name ?? "Value", labels: categories, values: series[0]?.values ?? [] }]
    : series.map((entry) => ({ name: entry.name, labels: categories, values: entry.values }));

  const multi = series.length > 1;
  const unit = chart.unit ? ` (${cleanText(chart.unit)})` : "";
  const dataLabelPosition = kind.pie
    ? "bestFit"
    : kind.stacked
      ? "ctr"
      : kind.type === "line"
        ? "t"
        : "outEnd";

  const options: PptxGenJS.IChartOpts = {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    chartColors: [...SERIES],
    chartColorsOpacity: 100,
    showTitle: true,
    title: `${cleanText(chart.title)}${unit}`,
    titleFontFace: T.fonts.chart,
    titleFontSize: 13,
    titleColor: HIGHLIGHT,
    titleAlign: "left",
    showLegend: multi || kind.pie,
    legendPos: "b",
    legendFontFace: T.fonts.chart,
    legendFontSize: 11,
    legendColor: C.slate,
    showValue: !kind.pie,
    showPercent: kind.pie,
    dataLabelPosition,
    dataLabelFontFace: T.fonts.chart,
    dataLabelFontSize: 11,
    dataLabelColor: kind.stacked ? C.white : C.navy,
    dataLabelFontBold: true,
    // The fourth number-format section is the zero case: empty hides a "0"
    // label on stacked segments that have no value in that category.
    dataLabelFormatCode: "#,##0;-#,##0;;",
    catAxisLabelFontFace: T.fonts.chart,
    catAxisLabelFontSize: 11,
    catAxisLabelColor: C.slate,
    valAxisLabelFontFace: T.fonts.chart,
    valAxisLabelFontSize: 11,
    valAxisLabelColor: C.slate,
    valAxisLabelFormatCode: "0.#",
    valGridLine: { style: "solid", color: C.border, size: 0.75 },
    catGridLine: { style: "none" },
    valAxisLineShow: false,
    catAxisLineShow: true,
    catAxisLineColor: C.border,
    barDir: "col",
    barGapWidthPct: kind.stacked ? 55 : 70,
    chartArea: { fill: { color: C.white } },
    plotArea: { fill: { color: C.white } },
    border: { pt: 0, color: C.white },
    ...(kind.stacked ? { barGrouping: "stacked", barOverlapPct: 100 } : {}),
    ...(kind.type === "line" ? { lineSize: 2.5, lineDataSymbol: "circle" } : {}),
    ...(kind.type === "doughnut" ? { holeSize: 55 } : {}),
  };

  slide.addChart(kind.type, data, options);
  if (chart.basis === "assumption") {
    illustrativeBadge(slide, G.width - G.margin - 2.34, G.tagY - 0.03);
  }
}

/* ------------------------------------------------------------------ tables --- */

// Only citation-shaped columns are pinned narrow; an Owner column needs room
// for a team name and should size with the rest.
const REF_HEADER = /^(evidence|evid\.?|ref|refs|references?|source|sources|citation)$/i;

function columnWeights(headers: readonly string[], rows: readonly string[][]): number[] {
  return headers.map((header, index) => {
    const cells = rows.map((row) => cleanText(row[index] ?? ""));
    const longestWord = Math.max(
      4,
      ...cells.flatMap((cell) => cell.split(/\s+/).map((word) => word.length)),
    );
    const average = cells.reduce((sum, cell) => sum + cell.length, 0) / Math.max(1, cells.length);
    const weight = REF_HEADER.test(header.trim()) ? 12 : Math.max(longestWord, average * 0.55);
    return REF_HEADER.test(header.trim()) ? Math.min(weight, 14) : Math.max(weight, 14);
  });
}

function columnWidths(
  headers: readonly string[],
  rows: readonly string[][],
  total: number,
): number[] {
  const refColumns = headers.map((header) => REF_HEADER.test(header.trim()));
  const refWidth = 1.15;
  const flexible = refColumns.filter((isRef) => !isRef).length;
  const flexibleTotal = Math.max(total - refWidth * (headers.length - flexible), total * 0.6);
  const weights = columnWeights(headers, rows);
  const sum =
    headers.reduce(
      (acc, _header, index) => acc + (refColumns[index] ? 0 : (weights[index] ?? 1)),
      0,
    ) || 1;
  const minimum = Math.min(1.1, flexibleTotal / Math.max(flexible, 1) / 1.6);
  const widths = headers.map((_header, index) => {
    if (refColumns[index]) return refWidth;
    return Math.max(minimum, ((weights[index] ?? 1) / sum) * flexibleTotal);
  });
  const scale = total / widths.reduce((a, b) => a + b, 0);
  return widths.map((width) => Number((width * scale).toFixed(3)));
}

/** How many wrapped lines a cell needs at table size, used to plan row heights. */
function cellLines(text: string, widthIn: number, size: number): number {
  return Math.max(1, lineCount(text, widthIn - 0.2, size));
}

function rowHeight(row: readonly string[], widths: readonly number[], size: number): number {
  const lines = row.reduce(
    (max, cell, index) => Math.max(max, cellLines(cell, widths[index] ?? 1.4, size)),
    1,
  );
  return Math.min(1.05, lines * ((size * 1.24) / 72) + 0.19);
}

function tableRow(
  cells: readonly string[],
  options: {
    header?: boolean;
    first?: boolean;
    zebra?: boolean;
    size: number;
    fontFace: string;
  },
): PptxGenJS.TableCell[] {
  return cells.map((cell, index) => ({
    text: cell,
    options: {
      fontFace: options.fontFace,
      fontSize: options.size,
      bold: options.header === true || (options.first === true && index === 0),
      color: options.header ? C.white : C.navy,
      fill: {
        color: options.header ? HIGHLIGHT : options.zebra && index >= 0 ? C.light : C.white,
      },
      valign: "middle",
      margin: 0.08,
    },
  }));
}

type TablePlan = { start: number; count: number; columns: number[]; heights: number[] };

/**
 * Plans table pages: at most N rows and M columns per slide, rows chosen so the
 * table never runs under the source line. Column overflow is repeated with the
 * first (key) column so a wide table keeps its row labels.
 */
function planTable(
  headers: readonly string[],
  rows: readonly string[][],
  widths: readonly number[],
  maxHeight: number,
): TablePlan[] {
  const plans: TablePlan[] = [];
  const columnGroups: number[][] = [];
  if (headers.length <= T.config.maxTableCols) {
    columnGroups.push(headers.map((_, index) => index));
  } else {
    for (let start = 0; start < headers.length; start += T.config.maxTableCols - 1) {
      const group = start === 0 ? [] : [0];
      for (
        let index = start;
        index < headers.length && group.length < T.config.maxTableCols;
        index += 1
      ) {
        group.push(index);
      }
      columnGroups.push(group);
    }
  }
  for (const columns of columnGroups) {
    const colWidths = columns.map((c) => widths[c] ?? 1.4);
    const rowHeights = rows.map((row) => rowHeight(row, colWidths, S.table));
    const total = rowHeights.reduce((sum, height) => sum + height, 0);
    // Balance the pages instead of filling each to the brim: seven rows on two
    // slides read as 4 + 3, not 6 + 1.
    const pageCount = Math.max(
      1,
      Math.ceil(total / Math.max(0.8, maxHeight - 0.42)),
      Math.ceil(rows.length / T.config.maxTableRows),
    );
    const target = Math.ceil(rows.length / pageCount);
    let index = 0;
    while (index < rows.length) {
      const heights: number[] = [];
      let used = 0.42;
      let count = 0;
      while (
        index + count < rows.length &&
        count < Math.min(T.config.maxTableRows, target) &&
        (count === 0 || used + (rowHeights[index + count] ?? 0.45) <= maxHeight)
      ) {
        const height = rowHeights[index + count] ?? 0.45;
        heights.push(height);
        used += height;
        count += 1;
      }
      plans.push({ start: index, count, columns, heights });
      index += count;
    }
  }
  return plans;
}

function addTable(
  slide: Slide,
  block: TableBlock,
  box: ChartBox,
  cfg: ResolvedDeckConfig,
  plan: TablePlan,
  widths: readonly number[],
): void {
  const headers = plan.columns.map((index) =>
    shortenAtWord(tableCellText(block.headers[index] ?? ""), 60, 6),
  );
  const bodyRows = block.rows
    .slice(plan.start, plan.start + plan.count)
    .map((row) => plan.columns.map((index) => row[index] ?? ""));
  const colWidths = plan.columns.map((index) => widths[index] ?? 1.4);
  const scale = box.w / colWidths.reduce((a, b) => a + b, 0);
  const sizedWidths = colWidths.map((width) => Number((width * scale).toFixed(3)));

  const clipped = bodyRows.map((row) =>
    row.map((cell, cellIndex) => {
      const width = sizedWidths[cellIndex] ?? 1.4;
      // Two wrapped lines are allowed before a cell is shortened; that keeps an
      // owner name or a currency value whole instead of showing "InterGlobe…".
      const perLine = Math.floor(((width - 0.2) * 138) / S.table);
      const maxChars = Math.max(24, perLine * 2);
      return shortenAtWord(tableCellText(cell), maxChars, T.config.maxTableWordsPerCell);
    }),
  );

  const rows: PptxGenJS.TableRow[] = [
    tableRow(headers, { header: true, size: S.tableHeader, fontFace: cfg.headingFont }),
    ...clipped.map((row, rowIndex) =>
      tableRow(row, {
        first: true,
        zebra: rowIndex % 2 === 1,
        size: S.table,
        fontFace: cfg.bodyFont,
      }),
    ),
  ];

  slide.addTable(rows, {
    x: box.x,
    y: box.y,
    w: box.w,
    colW: sizedWidths,
    rowH: [0.42, ...plan.heights].slice(0, rows.length),
    border: { type: "solid", pt: 0.75, color: C.border },
    fontFace: cfg.bodyFont,
    fontSize: S.table,
    color: C.navy,
    valign: "middle",
    autoPage: false,
  });
}

/* -------------------------------------------------------- visual detection --- */

type VisualBlock = Extract<
  Block,
  { type: "chart" | "table" | "kpis" | "metrics" | "flow" | "timeline" | "comparison" }
>;

function isVisual(block: Block): block is VisualBlock {
  return (
    block.type === "chart" ||
    block.type === "table" ||
    block.type === "kpis" ||
    block.type === "metrics" ||
    block.type === "flow" ||
    block.type === "timeline" ||
    block.type === "comparison"
  );
}

function hasBody(items: readonly BodyItem[]): boolean {
  return items.length > 0;
}

/* ------------------------------------------------------------- card grid --- */

type Card = { label: string; value: string; note?: string };

function cardsFrom(block: VisualBlock): Card[] {
  if (block.type === "kpis") return block.items.map(kpiCard);
  if (block.type === "metrics")
    return block.items.map((item: MetricItem) => ({
      label: item.label,
      value: [item.value, item.unit].filter(Boolean).join(" "),
      ...(item.context ? { note: item.context } : {}),
    }));
  return [];
}

function kpiCard(item: KpiItem): Card {
  return {
    label: item.label,
    value: item.value,
    ...(item.note ? { note: item.note } : {}),
  };
}

function addKpiCards(
  slide: Slide,
  cards: readonly Card[],
  box: ChartBox,
  cfg: ResolvedDeckConfig,
): void {
  const perRow = Math.min(cards.length, T.config.maxKpiCards);
  const columns = perRow === 3 ? 3 : Math.min(perRow, 4);
  const rows = Math.ceil(cards.length / columns);
  const gap = G.gap;
  const cardW = (box.w - gap * (columns - 1)) / columns;
  const cardH = Math.min(rows === 1 ? 2.15 : 1.95, (box.h - gap * (rows - 1)) / rows);
  const top = box.y + (rows === 1 ? 0.35 : 0.1);

  cards.forEach((card, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = box.x + column * (cardW + gap);
    const y = top + row * (cardH + gap);
    const accent = SERIES[index % SERIES.length] ?? C.blue;

    slide.addShape("roundRect", {
      x,
      y,
      w: cardW,
      h: cardH,
      fill: { color: C.white },
      line: { color: C.border, width: 0.75 },
      rectRadius: G.cardRadius,
    });
    slide.addShape("roundRect", {
      x: x + 0.26,
      y: y + 0.26,
      w: 0.42,
      h: 0.06,
      fill: { color: accent },
      line: { color: accent, width: 0 },
      rectRadius: 0.03,
    });
    slide.addText(cleanText(card.label), {
      x: x + 0.26,
      y: y + 0.44,
      w: cardW - 0.52,
      h: 0.4,
      fontFace: cfg.bodyFont,
      fontSize: S.kpiLabel,
      bold: true,
      color: C.slate,
      valign: "top",
      margin: 0,
      isTextBox: true,
      fit: "shrink",
    });
    slide.addText(cleanText(card.value), {
      x: x + 0.26,
      y: y + 0.84,
      w: cardW - 0.52,
      h: 0.66,
      fontFace: cfg.headingFont,
      fontSize: S.kpiValue,
      bold: true,
      color: HIGHLIGHT,
      valign: "middle",
      margin: 0,
      isTextBox: true,
      fit: "shrink",
    });
    if (card.note) {
      slide.addText(shortenAtWord(card.note, Math.floor(cardW * 14), 22), {
        x: x + 0.26,
        y: y + cardH - 0.48,
        w: cardW - 0.52,
        h: 0.36,
        fontFace: cfg.bodyFont,
        fontSize: S.bodyMin,
        color: C.slate,
        valign: "top",
        margin: 0,
        isTextBox: true,
        fit: "shrink",
      });
    }
  });
}

/* --------------------------------------------------------------- flow/timeline --- */

function addFlow(
  slide: Slide,
  steps: readonly { label: string; detail?: string }[],
  box: ChartBox,
  cfg: ResolvedDeckConfig,
): void {
  const gap = 0.24;
  const stepW = (box.w - gap * (steps.length - 1)) / steps.length;
  // The flow band is ~2.8in tall in a 4.6in body; centre it rather than leaving
  // a third of the slide empty under the steps.
  const markerY = box.y + 0.85;

  slide.addShape("rect", {
    x: box.x + stepW / 2,
    y: markerY,
    w: box.w - stepW,
    h: 0.02,
    fill: { color: C.border },
    line: { color: C.border, width: 0 },
  });

  steps.forEach((step, index) => {
    const x = box.x + index * (stepW + gap);
    slide.addShape("ellipse", {
      x: x + stepW / 2 - 0.21,
      y: markerY - 0.21,
      w: 0.42,
      h: 0.42,
      fill: { color: index === 0 ? C.blue : C.white },
      line: { color: index === 0 ? C.blue : C.teal, width: 1.25 },
    });
    slide.addText(String(index + 1).padStart(2, "0"), {
      x: x + stepW / 2 - 0.21,
      y: markerY - 0.21,
      w: 0.42,
      h: 0.42,
      fontFace: cfg.bodyFont,
      fontSize: 12,
      bold: true,
      color: index === 0 ? C.white : C.teal,
      align: "center",
      valign: "middle",
      margin: 0,
    });
    slide.addText(cleanText(step.label), {
      x,
      y: markerY + 0.45,
      w: stepW,
      h: 0.72,
      fontFace: cfg.headingFont,
      fontSize: 14,
      bold: true,
      color: HIGHLIGHT,
      align: "center",
      valign: "top",
      margin: 0,
      isTextBox: true,
      fit: "shrink",
    });
    if (step.detail) {
      slide.addText(cleanText(step.detail), {
        x,
        y: markerY + 1.16,
        w: stepW,
        h: 1.6,
        fontFace: cfg.bodyFont,
        fontSize: S.bodyMin,
        color: C.slate,
        align: "center",
        valign: "top",
        margin: 0,
        isTextBox: true,
        fit: "shrink",
      });
    }
  });
}

function addTimeline(
  slide: Slide,
  items: readonly { label: string; timeframe: string; detail: string }[],
  box: ChartBox,
  cfg: ResolvedDeckConfig,
): void {
  const rowH = Math.min(0.98, (box.h - 0.16 * (items.length - 1)) / items.length);
  items.forEach((item, index) => {
    const y = box.y + index * (rowH + 0.16);
    const accent = SERIES[index % SERIES.length] ?? C.blue;

    slide.addText(cleanText(item.timeframe), {
      x: box.x,
      y,
      w: 1.55,
      h: rowH,
      fontFace: cfg.bodyFont,
      fontSize: 12,
      bold: true,
      color: C.blue,
      align: "left",
      valign: "middle",
      margin: 0,
      isTextBox: true,
    });
    slide.addShape("roundRect", {
      x: box.x + 1.65,
      y,
      w: box.w - 1.65,
      h: rowH,
      fill: { color: C.light },
      line: { color: C.border, width: 0.5 },
      rectRadius: 0.08,
    });
    slide.addShape("roundRect", {
      x: box.x + 1.65,
      y,
      w: 0.07,
      h: rowH,
      fill: { color: accent },
      line: { color: accent, width: 0 },
      rectRadius: 0.03,
    });
    slide.addText(cleanText(item.label), {
      x: box.x + 1.88,
      y: y + 0.06,
      w: box.w - 2,
      h: Math.min(0.34, rowH / 2),
      fontFace: cfg.headingFont,
      fontSize: 14,
      bold: true,
      color: HIGHLIGHT,
      margin: 0,
      isTextBox: true,
    });
    slide.addText(shortenAtWord(item.detail, Math.floor((box.w - 1.9) * 14), 30), {
      x: box.x + 1.88,
      y: y + rowH / 2 - 0.04,
      w: box.w - 2,
      h: Math.max(0.3, rowH / 2 - 0.06),
      fontFace: cfg.bodyFont,
      fontSize: S.bodyMin,
      color: C.slate,
      margin: 0,
      isTextBox: true,
      fit: "shrink",
    });
  });
}

/* ------------------------------------------------------------- body drawing --- */

function addBodyItems(
  slide: Slide,
  items: readonly BodyItem[],
  box: ChartBox,
  size: number,
  cfg: ResolvedDeckConfig,
): void {
  let cursor = box.y;
  for (const item of items) {
    const height = itemHeight(item, box.w, size);
    switch (item.kind) {
      case "callout": {
        const tone = toneFill(item.tone);
        slide.addShape("roundRect", {
          x: box.x,
          y: cursor,
          w: box.w,
          h: height,
          fill: { color: tone.fill },
          line: { color: tone.fill, width: 0 },
          rectRadius: 0.08,
        });
        slide.addShape("rect", {
          x: box.x,
          y: cursor,
          w: 0.06,
          h: height,
          fill: { color: tone.bar },
          line: { color: tone.bar, width: 0 },
        });
        slide.addText(runsFor(item.text, { size, color: C.navy, fontFace: cfg.bodyFont }), {
          x: box.x + 0.22,
          y: cursor + 0.14,
          w: box.w - 0.44,
          h: height - 0.24,
          valign: "middle",
          margin: 0,
          isTextBox: true,
        });
        break;
      }
      case "quote": {
        slide.addShape("rect", {
          x: box.x,
          y: cursor + 0.04,
          w: 0.05,
          h: height - 0.12,
          fill: { color: C.amber },
          line: { color: C.amber, width: 0 },
        });
        // The model's quote attribution names the library document ("... page
        // 3"). A client-facing deck carries no source references, so the
        // statement stands on its own; provenance stays in the trace and notes.
        slide.addText(
          runsFor(item.text, { size, color: C.navy, fontFace: cfg.headingFont, italic: true }),
          {
            x: box.x + 0.22,
            y: cursor,
            w: box.w - 0.26,
            h: height - 0.08,
            valign: "top",
            margin: 0,
            isTextBox: true,
          },
        );
        break;
      }
      case "bullet": {
        // PptxGenJS writes <a:pPr> before every run, and a paragraph-level bullet
        // option therefore restarts the paragraph mid-sentence (or is dropped when
        // only the first run carries it). Drawing the marker as its own glyph is
        // deterministic in PowerPoint, LibreOffice and Google Slides, and lets the
        // paragraph itself stay a plain rich-text box.
        const bulletRuns = runsFor(item.text, { size, color: C.navy, fontFace: cfg.bodyFont });
        const markerX = box.x + item.level * 0.3;
        slide.addText("•", {
          x: markerX,
          y: cursor,
          w: 0.22,
          h: (size * 1.3) / 72 + 0.06,
          fontFace: cfg.bodyFont,
          fontSize: size,
          bold: true,
          color: C.blue,
          align: "left",
          valign: "top",
          margin: 0,
          isTextBox: true,
        });
        if (item.tag) {
          slide.addShape("roundRect", {
            x: markerX + 0.24,
            y: cursor + 0.01,
            w: 0.84,
            h: TAG_H,
            fill: { color: palette.pearl },
            line: { color: C.teal, width: 0.5 },
            rectRadius: 0.08,
          });
          slide.addText(item.tag, {
            x: markerX + 0.24,
            y: cursor + 0.01,
            w: 0.84,
            h: TAG_H,
            fontFace: cfg.bodyFont,
            fontSize: 12,
            bold: true,
            color: C.teal,
            align: "center",
            valign: "middle",
            margin: 0,
            isTextBox: true,
          });
        }
        slide.addText(bulletRuns, {
          x: markerX + 0.24 + (item.tag ? TAG_W : 0),
          y: cursor,
          w: box.w - 0.24 - item.level * 0.3 - (item.tag ? TAG_W : 0),
          h: height,
          valign: "top",
          margin: 0,
          isTextBox: true,
        });
        break;
      }
      default: {
        slide.addText(runsFor(item.text, { size, color: C.navy, fontFace: cfg.bodyFont }), {
          x: box.x,
          y: cursor,
          w: box.w,
          h: height,
          valign: "top",
          margin: 0,
          isTextBox: true,
        });
        break;
      }
    }
    cursor += height;
  }
}

/* ----------------------------------------------------------------- slides --- */

function coverSlide(pres: PptxGenJS, model: DocumentModel, cfg: ResolvedDeckConfig): Slide {
  const slide = pres.addSlide({ masterName: "cover" });
  const title = cleanText(model.cover.title);
  const subtitle = cleanText(model.cover.subtitle);

  // The client's own mark, never recoloured; a white panel unless it is light.
  const logo = model.clientLogo;
  if (logo) {
    const height = 0.62;
    const width = Math.min(3.4, height * logo.aspect);
    const x = G.width - G.margin - width;
    const y = 0.62;
    if (!logo.light) {
      slide.addShape("roundRect", {
        x: x - 0.14,
        y: y - 0.12,
        w: width + 0.28,
        h: height + 0.24,
        fill: { color: palette.white },
        line: { color: palette.white, width: 0 },
        rectRadius: 0.08,
      });
    }
    try {
      slide.addImage({ data: logo.dataUrl, x, y, w: width, h: height });
    } catch {
      // An unsupported image leaves the cover without a logo, never broken.
    }
  }

  slide.addText(title, {
    x: G.margin,
    y: 2.15,
    w: 10.6,
    h: 1.5,
    fontFace: cfg.headingFont,
    fontSize: title.length > 68 ? 32 : title.length > 46 ? 36 : 40,
    bold: true,
    color: C.onDark,
    valign: "bottom",
    margin: 0,
    isTextBox: true,
  });
  slide.addShape("rect", {
    x: G.margin,
    y: 3.78,
    w: 0.9,
    h: 0.045,
    fill: { color: C.teal },
    line: { color: C.teal, width: 0 },
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: G.margin,
      y: 3.98,
      w: 9.6,
      h: 0.9,
      fontFace: cfg.bodyFont,
      fontSize: S.bodyMax,
      color: C.onDarkMuted,
      valign: "top",
      margin: 0,
      isTextBox: true,
    });
  }
  const meta = [model.cover.client, model.cover.industry, model.cover.date]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(cleanText)
    .join("  ·  ");
  slide.addText(meta, {
    x: G.margin,
    y: 5.5,
    w: 10.6,
    h: 0.34,
    fontFace: cfg.bodyFont,
    fontSize: 13,
    color: C.onDarkMuted,
    margin: 0,
    isTextBox: true,
  });
  slide.addNotes(coverNotes(model));
  return slide;
}

function coverNotes(model: DocumentModel): string {
  return [
    "Open with the outcome, not the agenda.",
    `This deck answers: ${cleanText(model.cover.request)}`,
    model.cover.client ? `Written for ${cleanText(model.cover.client)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function dividerSlide(pres: PptxGenJS, section: DocumentSection, cfg: ResolvedDeckConfig): Slide {
  const slide = pres.addSlide({ masterName: "section" });
  slide.addText(tag(section), {
    x: G.margin,
    y: 2.45,
    w: 8,
    h: 0.3,
    fontFace: cfg.bodyFont,
    fontSize: 12,
    bold: true,
    color: C.teal,
    charSpacing: 1.6,
    margin: 0,
    isTextBox: true,
  });
  slide.addText(cleanText(section.title), {
    x: G.margin,
    y: 2.8,
    w: 10.5,
    h: 1.6,
    fontFace: cfg.headingFont,
    fontSize: 34,
    bold: true,
    color: C.onDark,
    valign: "top",
    margin: 0,
    isTextBox: true,
    fit: "shrink",
  });
  slide.addNotes(sectionNotes(section));
  return slide;
}

function closingSlide(pres: PptxGenJS, section: DocumentSection, cfg: ResolvedDeckConfig): Slide {
  const slide = pres.addSlide({ masterName: "closing" });
  addTitle(slide, section.title);
  addChrome(slide, section, cfg);
  const items = bodyItemsOf(section.blocks);
  const lead = items.find((item) => item.kind === "para" || item.kind === "quote");
  const rest = items.filter((item) => item !== lead);

  if (lead) {
    slide.addText(cleanText(lead.text), {
      x: G.margin,
      y: 2.0,
      w: 10.8,
      h: 1.7,
      fontFace: cfg.headingFont,
      fontSize: S.closing,
      color: C.onDark,
      valign: "top",
      margin: 0,
      isTextBox: true,
      fit: "shrink",
    });
  }
  if (rest.length > 0) {
    slide.addText(
      rest.map((item, index) => ({
        text: cleanText(item.text),
        options: {
          bullet: { indent: 18 },
          breakLine: index < rest.length - 1,
          color: C.onDarkMuted,
          fontSize: S.body,
          fontFace: cfg.bodyFont,
          paraSpaceAfter: 8,
        },
      })),
      {
        x: G.margin,
        y: 3.95,
        w: 10.8,
        h: 2.4,
        valign: "top",
        margin: 0,
        isTextBox: true,
      },
    );
  }
  slide.addNotes(sectionNotes(section));
  return slide;
}

function textSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  items: readonly BodyItem[],
  cfg: ResolvedDeckConfig,
): Slide[] {
  const pages = paginate(items, CONTENT_W, BODY_H);
  return pages.map((page, index) => {
    const slide = pres.addSlide({ masterName: "text" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);
    const size = fitSize(page, CONTENT_W, BODY_H);
    addBodyItems(slide, page, { x: G.margin, y: G.bodyTop, w: CONTENT_W, h: BODY_H }, size, cfg);
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function tableSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  block: TableBlock,
  commentary: readonly BodyItem[],
  cfg: ResolvedDeckConfig,
  takeaway?: string,
): Slide[] {
  const rows = block.rows.filter((row) => row.some((cell) => cleanText(cell).length > 0));
  if (rows.length === 0) return [];
  const commentaryHeight = commentary.length > 0 ? 0.85 : 0;
  const takeawayHeightValue = takeaway ? takeawayHeight(takeaway, CONTENT_W) + 0.16 : 0;
  const available = BODY_H - commentaryHeight - takeawayHeightValue - 0.4;
  const widths = columnWidths(block.headers, rows, CONTENT_W);
  const plans = planTable(block.headers, rows, widths, available);

  return plans.map((plan, index) => {
    const slide = pres.addSlide({ masterName: "table" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);

    let top = G.bodyTop;
    if (takeaway && index === 0) {
      addTakeaway(slide, takeaway, G.margin, top, CONTENT_W, cfg);
      top += takeawayHeightValue;
    }
    if (commentary.length > 0 && index === 0) {
      const size = fitSize(commentary, CONTENT_W, commentaryHeight);
      addBodyItems(
        slide,
        commentary,
        { x: G.margin, y: top, w: CONTENT_W, h: commentaryHeight },
        size,
        cfg,
      );
      top += commentaryHeight + 0.2;
    }
    const tableHeight = 0.42 + plan.heights.reduce((sum, height) => sum + height, 0);
    const centredTop = top + Math.max(0, Math.min(0.5, (G.bodyBottom - top - tableHeight) / 3));
    addTable(
      slide,
      block,
      { x: G.margin, y: centredTop, w: CONTENT_W, h: G.bodyBottom - centredTop },
      cfg,
      plan,
      widths,
    );
    if (block.caption) {
      const captionY = Math.min(G.bodyBottom, centredTop + tableHeight + 0.14);
      slide.addText(shortenAtWord(block.caption, 140, 24), {
        x: G.margin,
        y: captionY,
        w: CONTENT_W,
        h: 0.24,
        fontFace: cfg.bodyFont,
        fontSize: S.caption,
        italic: true,
        color: C.slate,
        margin: 0,
        isTextBox: true,
      });
    }
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function chartSlide(
  pres: PptxGenJS,
  section: DocumentSection,
  chart: ChartSpec,
  commentary: readonly BodyItem[],
  cfg: ResolvedDeckConfig,
  takeaway?: string,
): Slide {
  const twoZone = commentary.length > 0;
  const slide = pres.addSlide({ masterName: twoZone ? "visual" : "fullvisual" });
  addTitle(slide, section.title);
  addChrome(slide, section, cfg);

  const takeawaySize = takeaway ? takeawayHeight(takeaway, twoZone ? 6.9 : CONTENT_W) : 0;
  const top = G.bodyTop + (takeawaySize ? takeawaySize + 0.16 : 0);
  const height = BODY_H - (takeawaySize ? takeawaySize + 0.16 : 0);
  if (takeaway) {
    addTakeaway(slide, takeaway, G.margin, G.bodyTop, twoZone ? 6.9 : CONTENT_W, cfg);
  }

  if (twoZone) {
    addChart(slide, chart, { x: G.margin, y: top + 0.38, w: 6.9, h: height - 0.46 });
    const textBox = {
      x: G.margin + 7.22,
      y: top + 0.1,
      w: CONTENT_W - 7.22,
      h: height - 0.2,
    };
    const size = fitSize(commentary, textBox.w, textBox.h);
    addBodyItems(slide, commentary, textBox, size, cfg);
  } else {
    addChart(slide, chart, { x: G.margin, y: top, w: CONTENT_W, h: height });
  }
  slide.addNotes(sectionNotes(section));
  return slide;
}

function kpiSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  cards: readonly Card[],
  commentary: readonly BodyItem[],
  cfg: ResolvedDeckConfig,
  takeaway?: string,
): Slide[] {
  const perSlide = T.config.maxKpiCards * 2;
  const chunks: Card[][] = [];
  for (let index = 0; index < cards.length; index += perSlide) {
    chunks.push(cards.slice(index, index + perSlide));
  }
  return chunks.map((chunk, index) => {
    const slide = pres.addSlide({ masterName: "kpi" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);
    const takeawaySize = takeaway && index === 0 ? takeawayHeight(takeaway, CONTENT_W) + 0.16 : 0;
    if (takeaway && index === 0) {
      addTakeaway(slide, takeaway, G.margin, G.bodyTop, CONTENT_W, cfg);
    }
    const commentaryHeight = commentary.length > 0 && index === 0 ? 0.9 : 0;
    const top = G.bodyTop + takeawaySize;
    if (commentary.length > 0 && index === 0) {
      const size = fitSize(commentary, CONTENT_W, commentaryHeight);
      addBodyItems(
        slide,
        commentary,
        { x: G.margin, y: top, w: CONTENT_W, h: commentaryHeight },
        size,
        cfg,
      );
    }
    addKpiCards(
      slide,
      chunk,
      {
        x: G.margin,
        y: top + commentaryHeight + 0.2,
        w: CONTENT_W,
        h: BODY_H - takeawaySize - commentaryHeight - 0.2,
      },
      cfg,
    );
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function flowSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  steps: readonly { label: string; detail?: string }[],
  cfg: ResolvedDeckConfig,
): Slide[] {
  const perSlide = T.config.maxFlowSteps;
  const chunks: (typeof steps)[] = [];
  for (let index = 0; index < steps.length; index += perSlide) {
    chunks.push(steps.slice(index, index + perSlide));
  }
  return chunks.map((chunk, index) => {
    const slide = pres.addSlide({ masterName: "flow" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);
    addFlow(slide, chunk, { x: G.margin, y: G.bodyTop, w: CONTENT_W, h: BODY_H }, cfg);
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function timelineSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  items: readonly { label: string; timeframe: string; detail: string }[],
  cfg: ResolvedDeckConfig,
): Slide[] {
  const perSlide = T.config.maxTimelineItems;
  const chunks: (typeof items)[] = [];
  for (let index = 0; index < items.length; index += perSlide) {
    chunks.push(items.slice(index, index + perSlide));
  }
  return chunks.map((chunk, index) => {
    const slide = pres.addSlide({ masterName: "timeline" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);
    addTimeline(slide, chunk, { x: G.margin, y: G.bodyTop, w: CONTENT_W, h: BODY_H }, cfg);
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function comparisonSlides(
  pres: PptxGenJS,
  section: DocumentSection,
  block: Extract<Block, { type: "comparison" }>,
  cfg: ResolvedDeckConfig,
): Slide[] {
  const options = block.options.slice(0, 3);
  const headers = [
    block.title ? cleanText(block.title) : "Criteria",
    ...options.map((option) => cleanText(option.name)),
  ];
  const rows = block.criteria.map((criterion, index) => [
    cleanText(criterion),
    ...options.map((option) => option.values[index] ?? ""),
  ]);
  const table: TableBlock = { type: "table", headers, rows, sources: block.sources };
  const widths = columnWidths(headers, rows, CONTENT_W);
  const plans = planTable(headers, rows, widths, BODY_H - 0.2);

  return plans.map((plan, index) => {
    const slide = pres.addSlide({ masterName: "compare" });
    addTitle(slide, `${section.title}${index > 0 ? " (continued)" : ""}`);
    addChrome(slide, section, cfg);
    addTable(
      slide,
      table,
      { x: G.margin, y: G.bodyTop, w: CONTENT_W, h: BODY_H - 0.2 },
      cfg,
      plan,
      widths,
    );
    slide.addNotes(sectionNotes(section));
    return slide;
  });
}

function sourcesSlides(pres: PptxGenJS, model: DocumentModel, cfg: ResolvedDeckConfig): Slide[] {
  const entries = model.sources.map((source) => {
    const locator = [
      source.page ? `p. ${source.page}` : "",
      source.slide ? `slide ${source.slide}` : "",
      source.heading ? cleanText(source.heading) : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      title: cleanText(source.title),
      detail: [source.fileName, locator, source.date].filter(Boolean).join(" · "),
    };
  });
  if (entries.length === 0) return [];
  const perSlide = 16;
  const pages: (typeof entries)[] = [];
  for (let index = 0; index < entries.length; index += perSlide) {
    pages.push(entries.slice(index, index + perSlide));
  }
  return pages.map((page, index) => {
    const slide = pres.addSlide({ masterName: "sources" });
    addTitle(slide, `Sources${index > 0 ? " (continued)" : ""}`);
    addChrome(
      slide,
      {
        id: "sources",
        kind: "pointers",
        title: "Sources",
        blocks: [],
        speakerNotes: "",
        flagged: false,
        warnings: [],
      },
      cfg,
      "SOURCES",
    );
    const half = Math.ceil(page.length / 2);
    [page.slice(0, half), page.slice(half)].forEach((column, columnIndex) => {
      slide.addText(
        column.map((entry, entryIndex) => ({
          text: `${entry.title}${entry.detail ? ` — ${entry.detail}` : ""}`,
          options: {
            bullet: { indent: 12 },
            breakLine: entryIndex < column.length - 1,
            fontSize: S.caption,
            fontFace: cfg.bodyFont,
            color: C.slate,
            paraSpaceAfter: 6,
          },
        })),
        {
          x: G.margin + columnIndex * (CONTENT_W / 2 + 0.2),
          y: G.bodyTop,
          w: CONTENT_W / 2 - 0.2,
          h: BODY_H,
          valign: "top",
          margin: 0,
          isTextBox: true,
        },
      );
    });
    slide.addNotes("Every claim in this deck traces to a library document listed here.");
    return slide;
  });
}

function sectionNotes(section: DocumentSection): string {
  const notes = cleanText(section.speakerNotes);
  return notes.length > 0
    ? notes
    : `Talk through “${cleanText(section.title)}” and stop at the ask.`;
}

/* ------------------------------------------------------------- composition --- */

type PlannedSlide =
  | { kind: "divider" }
  | { kind: "closing" }
  | { kind: "text"; items: BodyItem[] }
  | { kind: "table"; block: TableBlock; commentary: BodyItem[]; takeaway?: string }
  | { kind: "chart"; chart: ChartSpec; commentary: BodyItem[]; takeaway?: string }
  | { kind: "kpis"; cards: Card[]; commentary: BodyItem[]; takeaway?: string }
  | { kind: "flow"; steps: { label: string; detail?: string }[] }
  | { kind: "timeline"; items: { label: string; timeframe: string; detail: string }[] }
  | { kind: "comparison"; block: Extract<Block, { type: "comparison" }> };

/**
 * One section becomes one or more slides. Visuals lead; the remaining prose is
 * commentary beside a chart, above a table, or a slide of its own.
 */
function planSection(section: DocumentSection): PlannedSlide[] {
  const blocks = section.blocks.filter((block) => block.type !== "heading");
  const visuals = blocks.filter(isVisual);
  const body = bodyItemsOf(blocks);

  if (visuals.length === 0 && body.length === 0) {
    return [{ kind: "divider" }];
  }
  if (section.layout === "cover") return [{ kind: "text", items: body }];
  if (
    visuals.length === 0 &&
    body.length > 0 &&
    (section.kind === "ask" || section.kind === "next_steps") &&
    totalHeight(body, CONTENT_W, S.body) < 2.5
  ) {
    return [{ kind: "closing" }];
  }
  if (visuals.length === 0) return [{ kind: "text", items: body }];

  const plans: PlannedSlide[] = [];
  let commentary: BodyItem[] = body;
  visuals.forEach((visual) => {
    const take = commentary;
    commentary = [];
    switch (visual.type) {
      case "chart":
        plans.push({
          kind: "chart",
          chart: visual.chart,
          commentary: take,
          ...(section.takeaway ? { takeaway: section.takeaway } : {}),
        });
        break;
      case "table":
        plans.push({
          kind: "table",
          block: visual,
          commentary: take.slice(0, 2),
          ...(section.takeaway ? { takeaway: section.takeaway } : {}),
        });
        break;
      case "kpis":
      case "metrics":
        plans.push({
          kind: "kpis",
          cards: cardsFrom(visual),
          commentary: take,
          ...(section.takeaway ? { takeaway: section.takeaway } : {}),
        });
        break;
      case "flow":
        plans.push({ kind: "flow", steps: visual.steps });
        commentary = take;
        break;
      case "timeline":
        plans.push({
          kind: "timeline",
          items: visual.items.map((item) => ({
            label: item.label,
            timeframe: item.timeframe,
            detail: item.detail,
          })),
        });
        commentary = take;
        break;
      case "comparison":
        plans.push({ kind: "comparison", block: visual });
        commentary = take;
        break;
    }
  });
  if (commentary.length > 0) plans.push({ kind: "text", items: commentary });
  return plans;
}

function defineMasters(pres: PptxGenJS, cfg: ResolvedDeckConfig): void {
  const titlePlaceholder = (options?: {
    color?: string;
    y?: number;
    h?: number;
    size?: number;
  }) => ({
    placeholder: {
      text: "",
      options: {
        name: "title",
        type: "title" as const,
        x: G.margin,
        y: options?.y ?? G.titleY,
        w: CONTENT_W,
        h: options?.h ?? G.titleH,
        fontFace: cfg.headingFont,
        fontSize: options?.size ?? S.title,
        bold: true,
        color: options?.color ?? HIGHLIGHT,
        valign: "top" as const,
        margin: 0,
        isTextBox: true,
      },
    },
  });

  const lightChrome = (name: string) =>
    pres.defineSlideMaster({
      title: name,
      background: { color: C.white },
      objects: [
        {
          line: {
            x: G.margin,
            y: G.ruleY,
            w: CONTENT_W,
            h: 0,
            line: { color: C.border, width: 0.75 },
          },
        },
        {
          text: {
            text: cfg.showTemplateFooter ? cfg.footer : "",
            options: {
              x: G.margin,
              y: G.footerY,
              w: CONTENT_W - 0.8,
              h: 0.24,
              fontFace: cfg.bodyFont,
              fontSize: S.caption,
              color: C.slate,
              margin: 0,
              isTextBox: true,
            },
          },
        },
        titlePlaceholder(),
      ],
      slideNumber: {
        x: G.width - G.margin - 0.5,
        y: G.footerY,
        w: 0.5,
        h: 0.24,
        fontFace: cfg.bodyFont,
        fontSize: S.caption,
        color: C.slate,
        align: "right",
        margin: 0,
      },
    });

  [
    "text",
    "table",
    "visual",
    "fullvisual",
    "kpi",
    "flow",
    "timeline",
    "compare",
    "sources",
  ].forEach(lightChrome);

  pres.defineSlideMaster({
    title: "cover",
    // Branded covers are white like every other branded page.
    background: { color: C.navy },
    objects: [
      {
        text: {
          text: cfg.wordmark,
          options: {
            x: G.margin,
            y: 0.55,
            w: 6,
            h: 0.24,
            fontFace: cfg.bodyFont,
            fontSize: 8,
            bold: true,
            charSpacing: 2,
            color: C.teal,
            margin: 0,
            isTextBox: true,
          },
        },
      },
      {
        line: {
          x: G.margin,
          y: G.height - 0.86,
          w: CONTENT_W,
          h: 0,
          line: { color: palette.deepNavy, width: 1 },
        },
      },
      {
        text: {
          text: cfg.showTemplateFooter ? cfg.footer : "",
          options: {
            x: G.margin,
            y: G.height - 0.72,
            w: CONTENT_W - 0.9,
            h: 0.26,
            fontFace: cfg.bodyFont,
            fontSize: S.caption,
            color: C.onDarkMuted,
            margin: 0,
            isTextBox: true,
          },
        },
      },
    ],
    slideNumber: {
      x: G.width - G.margin - 0.5,
      y: G.height - 0.72,
      w: 0.5,
      h: 0.26,
      fontFace: cfg.bodyFont,
      fontSize: S.caption,
      color: C.onDarkMuted,
      align: "right",
      margin: 0,
    },
  });

  pres.defineSlideMaster({
    title: "section",
    background: { color: C.navy },
  });

  pres.defineSlideMaster({
    title: "closing",
    background: { color: C.navy },
    objects: [titlePlaceholder({ color: C.onDark, y: 0.85 })],
  });
}

/**
 * Renders the deck. `pages` counts slides. The signature keeps the old shape
 * (bytes + pages) so the export pipeline did not have to change beyond awaiting
 * the PptxGenJS writer.
 */
export async function renderPptx(
  model: DocumentModel,
  config: DeckConfig = {},
): Promise<{ bytes: Uint8Array; pages: number }> {
  // New planner/writer decks carry a DeckSpec; the legacy renderer stays for
  // older models and the review fixtures.
  if (model.deck) {
    const { renderDeck } = await import("./deck");
    return renderDeck(
      model.deck,
      { date: model.cover.date, subtitle: model.cover.subtitle },
      { ...config, ...(model.clientLogo ? { clientLogo: model.clientLogo } : {}) },
    );
  }
  return renderLegacyDeck(model, config);
}

async function renderLegacyDeck(
  model: DocumentModel,
  config: DeckConfig,
): Promise<{ bytes: Uint8Array; pages: number }> {
  const cfg = resolveDeckConfig(config);
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Aionos";
  pres.company = "Aionos";
  pres.title = cleanText(model.cover.title);
  pres.subject = cleanText(model.cover.subtitle);
  pres.theme = {
    headFontFace: cfg.headingFont,
    bodyFontFace: cfg.bodyFont,
  };
  defineMasters(pres, cfg);

  coverSlide(pres, model, cfg);
  // A section with no grounded copy is left out, so the deck never carries a
  // slide about what the library could not supply.
  for (const section of model.sections.filter((entry) => entry.blocks.length > 0)) {
    for (const plan of planSection(section)) {
      switch (plan.kind) {
        case "divider":
          dividerSlide(pres, section, cfg);
          break;
        case "closing":
          closingSlide(pres, section, cfg);
          break;
        case "text":
          textSlides(pres, section, plan.items, cfg);
          break;
        case "table":
          tableSlides(pres, section, plan.block, plan.commentary, cfg, plan.takeaway);
          break;
        case "chart":
          chartSlide(pres, section, plan.chart, plan.commentary, cfg, plan.takeaway);
          break;
        case "kpis":
          kpiSlides(pres, section, plan.cards, plan.commentary, cfg, plan.takeaway);
          break;
        case "flow":
          flowSlides(pres, section, plan.steps, cfg);
          break;
        case "timeline":
          timelineSlides(pres, section, plan.items, cfg);
          break;
        case "comparison":
          comparisonSlides(pres, section, plan.block, cfg);
          break;
      }
    }
  }
  if (cfg.includeSourcesSlide) sourcesSlides(pres, model, cfg);

  // PptxGenJS keeps the slide list private in its typings; the runtime array is
  // what `pages` must report, and every other count is derived from it.
  const pages = (pres as unknown as { slides: unknown[] }).slides.length;
  const output = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return { bytes: dropDanglingOverrides(new Uint8Array(output)), pages };
}

/** Blocks per slide is no longer the unit of pagination; kept for callers that ask. */
export function paginateBlocks(blocks: readonly Block[]): Block[][] {
  const items = bodyItemsOf(blocks);
  return paginate(items, CONTENT_W, BODY_H).map((page) =>
    page.map((item): Block => ({ type: "paragraph", text: item.text, sources: [] })),
  );
}
