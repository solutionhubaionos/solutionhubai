/**
 * PDF renderer. Consumes the validated DocumentModel only — there is no prose
 * or structure in this file. Layout is measured with the real font metrics, so
 * tables wrap, rows never split across pages, headings are kept with their
 * following content, and every page carries a footer and page number.
 *
 * A4 portrait for proposals; 16:9 landscape for pitch mode with one section per
 * page, so a PDF export of a deck reads like slides.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Block, DocumentModel, DocumentSection } from "../types";
import { DOCUMENT_THEME as THEME, hexToRgb } from "../theme";

const A4 = { width: 595.28, height: 841.89 };
const SLIDE = { width: 960, height: 540 };

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  width: number;
  height: number;
  margin: number;
  body: PDFFont;
  bold: PDFFont;
  oblique: PDFFont;
  pages: PDFPage[];
  citations: Map<string, number>;
  isSlide: boolean;
};

const color = (hex: string) => rgb(...hexToRgb(hex));

/** WinAnsi-safe text: map the common typographic characters, drop the rest. */
export function pdfSafe(text: string): string {
  return text
    .replace(/\u2018|\u2019|\u201a|\u2032/g, "'")
    .replace(/\u201c|\u201d|\u201e|\u2033/g, '"')
    .replace(/\u2212/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00b7|\u2022/g, "-")
    .replace(/\u2192/g, "->")
    .replace(/\u2264/g, "<=")
    .replace(/\u2265/g, ">=")
    .replace(/\u00a0/g, " ")
    .replace(/\t/g, "    ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[^\x20-\x7e\u00a1-\u00ff\u2013\u2014]/g, ""))
    .join("\n");
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) {
        line = word;
        continue;
      }
      // Break a single very long token by character.
      let rest = word;
      while (rest.length > 1 && font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function lineHeight(size: number): number {
  return Math.round(size * 1.42 * 10) / 10;
}

function newPage(ctx: Ctx): void {
  const page = ctx.doc.addPage([ctx.width, ctx.height]);
  ctx.pages.push(page);
  ctx.page = page;
  ctx.y = ctx.height - ctx.margin;
}

function space(ctx: Ctx, height: number): void {
  if (ctx.y - height < ctx.margin + 30) newPage(ctx);
}

function text(
  ctx: Ctx,
  value: string,
  options: {
    font?: PDFFont;
    size?: number;
    color?: string;
    gap?: number;
    indent?: number;
    width?: number;
    keep?: number;
  } = {},
): void {
  const font = options.font ?? ctx.body;
  const size = options.size ?? 10.5;
  const fill = options.color ?? THEME.colors.ink;
  const indent = options.indent ?? 0;
  const width = options.width ?? ctx.width - ctx.margin * 2 - indent;
  const leading = lineHeight(size);
  const lines = wrapText(value, font, size, width);
  if (lines.length === 0) return;

  if (options.gap) ctx.y -= options.gap;
  space(ctx, leading * Math.min(lines.length, options.keep ?? lines.length) + 4);

  for (const piece of lines) {
    if (ctx.y - leading < ctx.margin + 24) newPage(ctx);
    ctx.y -= leading;
    ctx.page.drawText(piece, {
      x: ctx.margin + indent,
      y: ctx.y,
      size,
      font,
      color: color(fill),
    });
  }
}

function withCitations(value: string, ids: readonly string[], ctx: Ctx): string {
  // The model sometimes leaves [n] in the prose; do not double up the marker.
  if (/\[\d+\]/.test(value)) return value;
  const numbers = [...new Set(ids)]
    .map((id) => ctx.citations.get(id))
    .filter((number): number is number => Boolean(number));
  return numbers.length > 0 ? `${value} ${numbers.map((number) => `[${number}]`).join("")}` : value;
}

function rule(
  ctx: Ctx,
  width = ctx.width - ctx.margin * 2,
  colour: string = THEME.colors.border,
): void {
  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: ctx.margin, y: ctx.y },
    end: { x: ctx.margin + width, y: ctx.y },
    thickness: 0.8,
    color: color(colour),
  });
  ctx.y -= 4;
}

function drawBulletList(
  ctx: Ctx,
  items: readonly { text: string; level?: number | undefined; sources?: string[] | undefined }[],
  ordered: boolean,
  sources: readonly string[],
): void {
  const size = ctx.isSlide ? 13 : 10.5;
  const leading = lineHeight(size);
  items.forEach((item, index) => {
    const level = Math.min(item.level ?? 0, 2);
    const indent = 14 + level * 16;
    const marker = ordered ? `${index + 1}.` : "\u2022";
    space(ctx, leading + 3);
    ctx.y -= leading;
    ctx.page.drawText(marker, {
      x: ctx.margin + indent - 11,
      y: ctx.y,
      size: size - (ordered ? 0.5 : 1),
      font: ordered ? ctx.bold : ctx.body,
      color: color(THEME.colors.accent),
    });
    const value = withCitations(
      item.text,
      item.sources && item.sources.length > 0 ? item.sources : sources,
      ctx,
    );
    const lines = wrapText(value, ctx.body, size, ctx.width - ctx.margin * 2 - indent);
    for (const [lineIndex, piece] of lines.entries()) {
      if (lineIndex > 0) {
        if (ctx.y - leading < ctx.margin + 24) newPage(ctx);
        ctx.y -= leading;
      }
      ctx.page.drawText(piece, {
        x: ctx.margin + indent,
        y: ctx.y,
        size,
        font: ctx.body,
        color: color(THEME.colors.ink),
      });
    }
    ctx.y -= 2.5;
  });
}

function drawTable(
  ctx: Ctx,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  caption: string | undefined,
  sources: readonly string[],
): void {
  if (headers.length === 0 || rows.length === 0) return;
  if (caption) {
    text(ctx, withCitations(caption, sources, ctx), {
      size: 8.5,
      font: ctx.oblique,
      color: THEME.colors.muted,
      gap: 4,
      keep: 2,
    });
  }

  const font = ctx.body;
  const headerFont = ctx.bold;
  const size = ctx.isSlide ? 9.5 : 8.3;
  const padding = 4.5;
  const leading = lineHeight(size);
  const usable = ctx.width - ctx.margin * 2;

  const weights = headers.map((header, index) => {
    const longest = rows.reduce(
      (max, row) => Math.max(max, (row[index] ?? "").length),
      header.length,
    );
    return Math.max(8, Math.min(52, longest));
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => Math.max(52, (usable * weight) / totalWeight));
  const widthScale = usable / widths.reduce((sum, width) => sum + width, 0);
  const columns = widths.map((width) => width * widthScale);

  const drawHeader = () => {
    const headerLines = headers.map((header, index) =>
      wrapText(header, headerFont, size, (columns[index] ?? 60) - padding * 2),
    );
    const height = Math.max(...headerLines.map((lines) => lines.length)) * leading + padding * 2;
    space(ctx, height + 4);
    ctx.y -= height;
    ctx.page.drawRectangle({
      x: ctx.margin,
      y: ctx.y,
      width: usable,
      height,
      color: color(THEME.colors.accent),
    });
    headerLines.forEach((lines, index) => {
      const x = ctx.margin + columns.slice(0, index).reduce((sum, width) => sum + width, 0);
      lines.forEach((line, lineIndex) => {
        ctx.page.drawText(line, {
          x: x + padding,
          y: ctx.y + height - padding - leading * (lineIndex + 1) + 2,
          size,
          font: headerFont,
          color: color(THEME.colors.white),
        });
      });
    });
  };

  drawHeader();

  rows.forEach((row, rowIndex) => {
    const cellLines = columns.map((width, index) =>
      wrapText(row[index] ?? "", font, size, width - padding * 2).slice(0, 14),
    );
    const rowHeight = Math.max(...cellLines.map((lines) => lines.length)) * leading + padding * 2;
    if (ctx.y - rowHeight < ctx.margin + 24) {
      newPage(ctx);
      drawHeader();
    }
    ctx.y -= rowHeight;
    if (rowIndex % 2 === 1) {
      ctx.page.drawRectangle({
        x: ctx.margin,
        y: ctx.y,
        width: usable,
        height: rowHeight,
        color: color(THEME.colors.surface),
      });
    }
    cellLines.forEach((lines, index) => {
      const x = ctx.margin + columns.slice(0, index).reduce((sum, width) => sum + width, 0);
      lines.forEach((line, lineIndex) => {
        ctx.page.drawText(line, {
          x: x + padding,
          y: ctx.y + rowHeight - padding - leading * (lineIndex + 1) + 2,
          size,
          font,
          color: color(THEME.colors.ink),
        });
      });
    });
    ctx.page.drawLine({
      start: { x: ctx.margin, y: ctx.y },
      end: { x: ctx.margin + usable, y: ctx.y },
      thickness: 0.5,
      color: color(THEME.colors.border),
    });
  });

  ctx.y -= 8;
}

function drawMetrics(
  ctx: Ctx,
  items: readonly {
    label: string;
    value: string;
    unit?: string | undefined;
    context?: string | undefined;
    source: string;
  }[],
): void {
  const gap = 10;
  const columns = items.length === 1 ? 1 : ctx.isSlide ? Math.min(3, items.length) : 2;
  const cardWidth = (ctx.width - ctx.margin * 2 - gap * (columns - 1)) / columns;
  const cardHeight = ctx.isSlide ? 92 : 78;
  const rows: (typeof items)[number][][] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns));
  }

  for (const row of rows) {
    space(ctx, cardHeight + gap);
    ctx.y -= cardHeight;
    row.forEach((item, index) => {
      const x = ctx.margin + index * (cardWidth + gap);
      ctx.page.drawRectangle({
        x,
        y: ctx.y,
        width: cardWidth,
        height: cardHeight,
        color: color(THEME.colors.surface),
        borderColor: color(THEME.colors.border),
        borderWidth: 0.6,
      });
      ctx.page.drawRectangle({
        x,
        y: ctx.y + cardHeight - 3,
        width: cardWidth,
        height: 3,
        color: color(THEME.colors.accent),
      });
      const value = `${item.value}${item.unit ? ` ${item.unit}` : ""}`;
      ctx.page.drawText(pdfSafe(value).slice(0, 28), {
        x: x + 10,
        y: ctx.y + cardHeight - 30,
        size: ctx.isSlide ? 24 : 19,
        font: ctx.bold,
        color: color(THEME.colors.accentDark),
      });
      let labelY = ctx.y + cardHeight - 46;
      for (const line of wrapText(item.label, ctx.bold, 8.2, cardWidth - 20).slice(0, 2)) {
        ctx.page.drawText(line, {
          x: x + 10,
          y: labelY,
          size: 8.2,
          font: ctx.bold,
          color: color(THEME.colors.muted),
        });
        labelY -= 10;
      }
      if (item.context) {
        for (const line of wrapText(item.context, ctx.body, 8, cardWidth - 20).slice(0, 2)) {
          ctx.page.drawText(line, {
            x: x + 10,
            y: labelY,
            size: 8,
            font: ctx.body,
            color: color(THEME.colors.ink),
          });
          labelY -= 9.5;
        }
      }
      const citation = ctx.citations.get(item.source);
      if (citation) {
        ctx.page.drawText(`[${citation}]`, {
          x: x + cardWidth - 22,
          y: ctx.y + 8,
          size: 7.5,
          font: ctx.body,
          color: color(THEME.colors.muted),
        });
      }
    });
    ctx.y -= gap;
  }
}

function drawCallout(
  ctx: Ctx,
  block: { tone: "info" | "warning" | "success"; text: string },
  sources: readonly string[],
): void {
  const size = ctx.isSlide ? 12 : 9.6;
  const leading = lineHeight(size);
  const innerWidth = ctx.width - ctx.margin * 2 - 26;
  const lines = wrapText(withCitations(block.text, sources, ctx), ctx.body, size, innerWidth);
  const height = lines.length * leading + 18;
  space(ctx, height + 8);
  ctx.y -= height;
  const fill =
    block.tone === "warning"
      ? "#FFF4E5"
      : block.tone === "success"
        ? "#E9F5EF"
        : THEME.colors.accentSoft;
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y,
    width: ctx.width - ctx.margin * 2,
    height,
    color: color(fill),
  });
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y,
    width: 3.5,
    height,
    color: color(block.tone === "warning" ? THEME.colors.warning : THEME.colors.accent),
  });
  lines.forEach((line, index) => {
    ctx.page.drawText(line, {
      x: ctx.margin + 14,
      y: ctx.y + height - 13 - leading * index,
      size,
      font: ctx.body,
      color: color(THEME.colors.ink),
    });
  });
  ctx.y -= 10;
}

function drawQuote(ctx: Ctx, block: { text: string; attribution: string; source: string }): void {
  const size = ctx.isSlide ? 14 : 10.5;
  const textValue = withCitations(`"${block.text}"`, [block.source], ctx);
  const lines = wrapText(textValue, ctx.oblique, size, ctx.width - ctx.margin * 2 - 22);
  const height = lines.length * lineHeight(size) + 14;
  space(ctx, height + 26);
  ctx.y -= height;
  ctx.page.drawRectangle({
    x: ctx.margin,
    y: ctx.y,
    width: 3,
    height,
    color: color(THEME.colors.accent),
  });
  lines.forEach((line, index) => {
    ctx.page.drawText(line, {
      x: ctx.margin + 13,
      y: ctx.y + height - 12 - lineHeight(size) * index,
      size,
      font: ctx.oblique,
      color: color(THEME.colors.ink),
    });
  });
  ctx.page.drawText(pdfSafe(block.attribution), {
    x: ctx.margin + 13,
    y: ctx.y - 8,
    size: 8,
    font: ctx.body,
    color: color(THEME.colors.muted),
  });
  ctx.y -= 20;
}

function drawTimeline(
  ctx: Ctx,
  items: readonly { label: string; timeframe: string; detail: string; sources: string[] }[],
): void {
  const size = ctx.isSlide ? 10.5 : 9.3;
  const leading = lineHeight(size);
  items.forEach((item, index) => {
    const detailLines = wrapText(
      withCitations(item.detail, item.sources, ctx),
      ctx.body,
      size,
      ctx.width - ctx.margin * 2 - 92,
    );
    const height = Math.max(38, detailLines.length * leading + 20);
    space(ctx, height + 6);
    ctx.y -= height;
    const x = ctx.margin + 12;
    // Rail and dot.
    if (index < items.length - 1) {
      ctx.page.drawLine({
        start: { x, y: ctx.y + height },
        end: { x, y: ctx.y - 2 },
        thickness: 1.2,
        color: color(THEME.colors.border),
      });
    }
    ctx.page.drawCircle({
      x,
      y: ctx.y + height - 12,
      size: 4,
      color: color(THEME.colors.accent),
    });

    ctx.page.drawText(pdfSafe(item.timeframe).slice(0, 26), {
      x: ctx.margin + 26,
      y: ctx.y + height - 9,
      size: 8,
      font: ctx.bold,
      color: color(THEME.colors.accent),
    });
    ctx.page.drawText(pdfSafe(item.label).slice(0, 60), {
      x: ctx.margin + 26,
      y: ctx.y + height - 24,
      size: size + 1,
      font: ctx.bold,
      color: color(THEME.colors.ink),
    });
    detailLines.forEach((line, lineIndex) => {
      ctx.page.drawText(line, {
        x: ctx.margin + 92,
        y: ctx.y + height - 24 - lineIndex * leading,
        size,
        font: ctx.body,
        color: color(THEME.colors.muted),
      });
    });
    ctx.y -= 6;
  });
}

function drawBlock(ctx: Ctx, block: Block): void {
  switch (block.type) {
    case "heading":
      text(ctx, block.text, {
        font: ctx.bold,
        size: block.level === 2 ? (ctx.isSlide ? 15 : 11.5) : ctx.isSlide ? 13 : 10.5,
        color: THEME.colors.accentDark,
        gap: block.level === 2 ? 10 : 6,
        keep: 2,
      });
      break;
    case "paragraph":
      text(ctx, withCitations(block.text, block.sources, ctx), {
        size: ctx.isSlide ? 13 : 10.5,
        gap: 4,
        keep: 3,
      });
      break;
    case "bullet_list":
      drawBulletList(ctx, block.items, false, block.sources);
      break;
    case "numbered_list":
      drawBulletList(ctx, block.items, true, block.sources);
      break;
    case "table":
      drawTable(ctx, block.headers, block.rows, block.caption, block.sources);
      break;
    case "metrics":
      drawMetrics(ctx, block.items);
      break;
    case "callout":
      drawCallout(ctx, block, block.sources);
      break;
    case "quote":
      drawQuote(ctx, block);
      break;
    case "timeline":
      drawTimeline(ctx, block.items);
      break;
    case "comparison": {
      const headers = ["", ...block.options.map((option) => option.name)];
      const rows = block.criteria.map((criterion, index) => [
        criterion,
        ...block.options.map((option) => option.values[index] ?? ""),
      ]);
      drawTable(ctx, headers, rows, block.title, block.sources);
      break;
    }
  }
}

function drawCover(ctx: Ctx, model: DocumentModel): void {
  const { width, height } = ctx;
  ctx.page.drawRectangle({
    x: 0,
    y: height - 12,
    width,
    height: 12,
    color: color(THEME.colors.accent),
  });
  ctx.page.drawRectangle({
    x: 0,
    y: 0,
    width: 6,
    height,
    color: color(THEME.colors.accent),
  });

  const left = ctx.isSlide ? 64 : 48;
  let y = height - (ctx.isSlide ? 92 : 130);
  ctx.page.drawText(THEME.brand.wordmark, {
    x: left,
    y,
    size: 9,
    font: ctx.bold,
    color: color(THEME.colors.accent),
  });

  y -= ctx.isSlide ? 54 : 72;
  const titleLines = wrapText(model.cover.title, ctx.bold, ctx.isSlide ? 40 : 30, width - left * 2);
  for (const line of titleLines.slice(0, 4)) {
    ctx.page.drawText(line, {
      x: left,
      y,
      size: ctx.isSlide ? 40 : 30,
      font: ctx.bold,
      color: color(THEME.colors.ink),
    });
    y -= ctx.isSlide ? 46 : 36;
  }

  if (model.cover.subtitle) {
    y -= 4;
    for (const line of wrapText(
      model.cover.subtitle,
      ctx.body,
      ctx.isSlide ? 16 : 13,
      width - left * 2 - 60,
    ).slice(0, 3)) {
      ctx.page.drawText(line, {
        x: left,
        y,
        size: ctx.isSlide ? 16 : 13,
        font: ctx.body,
        color: color(THEME.colors.muted),
      });
      y -= ctx.isSlide ? 22 : 18;
    }
  }

  y -= ctx.isSlide ? 26 : 36;
  ctx.page.drawLine({
    start: { x: left, y },
    end: { x: left + 70, y },
    thickness: 2,
    color: color(THEME.colors.accent),
  });

  y -= 28;
  const meta = [
    model.cover.client ? `Prepared for ${model.cover.client}` : null,
    model.cover.industry ? `Industry: ${model.cover.industry}` : null,
    model.cover.date,
  ].filter((value): value is string => Boolean(value));
  for (const line of meta) {
    ctx.page.drawText(pdfSafe(line), {
      x: left,
      y,
      size: ctx.isSlide ? 13 : 10.5,
      font: ctx.body,
      color: color(THEME.colors.muted),
    });
    y -= ctx.isSlide ? 20 : 16;
  }

  if (model.cover.request) {
    const boxWidth = Math.min(width - left * 2, ctx.isSlide ? 620 : 420);
    const lines = wrapText(
      `Request: ${model.cover.request}`,
      ctx.oblique,
      8.8,
      boxWidth - 22,
    ).slice(0, 4);
    const boxHeight = lines.length * 12 + 16;
    const boxY = ctx.isSlide ? 56 : 70;
    ctx.page.drawRectangle({
      x: left,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      color: color(THEME.colors.surface),
    });
    lines.forEach((line, index) => {
      ctx.page.drawText(line, {
        x: left + 11,
        y: boxY + boxHeight - 13 - index * 12,
        size: 8.8,
        font: ctx.oblique,
        color: color(THEME.colors.muted),
      });
    });
  }
}

function drawContents(
  ctx: Ctx,
  entries: readonly { title: string; page: number }[],
  page: PDFPage,
): void {
  let y = ctx.height - ctx.margin - 10;
  page.drawText("Contents", {
    x: ctx.margin,
    y,
    size: 19,
    font: ctx.bold,
    color: color(THEME.colors.ink),
  });
  y -= 16;
  page.drawLine({
    start: { x: ctx.margin, y },
    end: { x: ctx.width - ctx.margin, y },
    thickness: 1,
    color: color(THEME.colors.accent),
  });
  y -= 26;
  entries.forEach((entry, index) => {
    page.drawText(`${String(index + 1).padStart(2, "0")}`, {
      x: ctx.margin,
      y,
      size: 9.5,
      font: ctx.bold,
      color: color(THEME.colors.accent),
    });
    const title = pdfSafe(entry.title).slice(0, 78);
    page.drawText(title, {
      x: ctx.margin + 24,
      y,
      size: 10.5,
      font: ctx.body,
      color: color(THEME.colors.ink),
    });
    page.drawText(String(entry.page), {
      x: ctx.width - ctx.margin - 14,
      y,
      size: 10,
      font: ctx.body,
      color: color(THEME.colors.muted),
    });
    y -= 19;
  });
}

function drawSources(ctx: Ctx, model: DocumentModel): void {
  if (model.sources.length === 0) return;
  // A long source list gets its own page so entries are never orphaned.
  if (ctx.isSlide || model.sources.length >= 6) newPage(ctx);
  else space(ctx, 120);
  text(ctx, "Sources", {
    font: ctx.bold,
    size: ctx.isSlide ? 24 : 16,
    color: THEME.colors.ink,
    gap: 4,
    keep: 1,
  });
  rule(ctx);
  model.sources.forEach((source, index) => {
    const location = source.slide
      ? `slide ${source.slide}`
      : source.page
        ? `page ${source.page}`
        : (source.heading ?? "");
    const type = source.contentType ? `${source.contentType} · ` : "";
    const client = source.customerName ? `${source.customerName} · ` : "";
    const value = `[${index + 1}] ${source.title} — ${type}${client}${location}. File: ${source.fileName}`;
    text(ctx, value, { size: ctx.isSlide ? 10 : 8.6, color: THEME.colors.muted, gap: 4, keep: 2 });
  });
}

export async function renderPdf(
  model: DocumentModel,
): Promise<{ bytes: Uint8Array; pages: number }> {
  const isSlide = model.mode === "pitch";
  const size = isSlide ? SLIDE : A4;
  const doc = await PDFDocument.create();
  doc.setTitle(model.cover.title);
  doc.setAuthor(THEME.brand.name);
  doc.setSubject(model.mode === "pitch" ? "Pitch deck" : "Proposal");
  doc.setCreationDate(new Date());

  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const cover = doc.addPage([size.width, size.height]);
  const citations = new Map(model.sources.map((source, index) => [source.chunkId, index + 1]));
  const ctx: Ctx = {
    doc,
    page: cover,
    y: size.height - 56,
    width: size.width,
    height: size.height,
    margin: isSlide ? 48 : 56,
    body,
    bold,
    oblique,
    pages: [cover],
    citations,
    isSlide,
  };

  drawCover(ctx, model);

  const contents = !isSlide && model.sections.length >= 5;
  let contentsPage: PDFPage | null = null;
  if (contents) {
    newPage(ctx);
    contentsPage = ctx.page;
    // Reserve the page; the body must start on the next one.
    newPage(ctx);
  }

  const starts: { title: string; page: number }[] = [];

  model.sections.forEach((section: DocumentSection, index) => {
    if (isSlide) {
      newPage(ctx);
    } else {
      if (index > 0) ctx.y -= 18;
      space(ctx, 150);
    }
    starts.push({ title: section.title, page: ctx.pages.length });
    text(ctx, section.title, {
      font: ctx.bold,
      size: isSlide ? 26 : 17,
      color: THEME.colors.ink,
      gap: 2,
      keep: 2,
    });
    rule(ctx, ctx.width - ctx.margin * 2, THEME.colors.accent);
    ctx.y -= 8;

    section.blocks.forEach((block) => drawBlock(ctx, block));

    if (section.flagged) {
      text(ctx, "This section is marked for completion before the document is sent.", {
        size: 8,
        font: ctx.oblique,
        color: THEME.colors.warning,
        gap: 4,
      });
    }
  });

  drawSources(ctx, model);

  if (contentsPage) drawContents(ctx, starts, contentsPage);

  // Footer on every page except the cover.
  const total = ctx.pages.length;
  ctx.pages.forEach((page, index) => {
    if (index === 0) return;
    page.drawLine({
      start: { x: ctx.margin, y: 40 },
      end: { x: ctx.width - ctx.margin, y: 40 },
      thickness: 0.6,
      color: color(THEME.colors.border),
    });
    page.drawText(pdfSafe(THEME.footer), {
      x: ctx.margin,
      y: 29,
      size: 7,
      font: ctx.body,
      color: color(THEME.colors.muted),
    });
    const label = `Page ${index + 1} of ${total}`;
    page.drawText(label, {
      x: ctx.width - ctx.margin - body.widthOfTextAtSize(label, 7.5),
      y: 29,
      size: 7.5,
      font: ctx.bold,
      color: color(THEME.colors.muted),
    });
  });

  const bytes = await doc.save();
  return { bytes, pages: total };
}
