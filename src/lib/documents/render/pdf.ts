/**
 * Minimal PDF writer: A4 pages, Helvetica/Helvetica-Bold, wrapped paragraphs
 * and a footer. Hand-rolled on purpose — the alternative is a PDF library for
 * six lines of text, and this keeps the generator dependency-free.
 *
 * Everything emitted is ASCII (WinAnsi-safe), so string length equals byte
 * length and the xref offsets stay correct.
 */
import type { DocumentOutline } from "../types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN + 32;
/** Helvetica's average advance as a fraction of the font size. */
const AVG_CHAR_RATIO = 0.5;

type FontKey = "F1" | "F2";
type Page = { ops: string[]; y: number };

function sanitize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2022\u25aa\u25cf]/g, "-")
    .replace(/\u00a0/g, " ")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e\n]/g, "");
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text: string, size: number, width = CONTENT_WIDTH): string[] {
  const maxChars = Math.max(12, Math.floor(width / (size * AVG_CHAR_RATIO)));
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maxChars) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function renderPdf(outline: DocumentOutline): { bytes: Uint8Array; pages: number } {
  const pages: Page[] = [{ ops: [], y: PAGE_HEIGHT - MARGIN }];
  let page = pages[0]!;

  const nextPage = () => {
    page = { ops: [], y: PAGE_HEIGHT - MARGIN };
    pages.push(page);
  };

  const line = (text: string, size: number, font: FontKey, gap: number, grey?: number) => {
    const leading = Math.round(size * 1.4);
    page.y -= gap;
    for (const piece of wrap(sanitize(text), size)) {
      if (page.y - leading < BOTTOM_LIMIT) nextPage();
      page.y -= leading;
      const ops: string[] = [];
      if (grey !== undefined) ops.push(`${grey} g`);
      ops.push(
        `BT /${font} ${size} Tf 1 0 0 1 ${MARGIN.toFixed(2)} ${page.y.toFixed(2)} Tm (${escapeText(piece)}) Tj ET`,
      );
      if (grey !== undefined) ops.push("0 g");
      page.ops.push(...ops);
    }
  };

  line(outline.title, 26, "F2", 0);
  if (outline.subtitle) line(outline.subtitle, 12, "F1", 10, 0.4);

  page.y -= 20;
  page.ops.push(
    `0.7 w 0.35 G ${MARGIN} ${page.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${page.y.toFixed(2)} l S 0 G`,
  );
  page.y -= 6;

  for (const section of outline.sections) {
    line(section.heading, 14, "F2", 20);
    for (const bullet of section.bullets) line(`-  ${bullet}`, 10.5, "F1", 6);
  }

  const total = pages.length;
  const footer = sanitize(outline.title).slice(0, 70);
  pages.forEach((entry, index) => {
    entry.ops.push(
      `0.4 g BT /F1 8 Tf 1 0 0 1 ${MARGIN} ${(MARGIN - 26).toFixed(2)} Tm (${escapeText(footer)}) Tj ET 0 g`,
    );
    entry.ops.push(
      `0.4 g BT /F1 8 Tf 1 0 0 1 ${(PAGE_WIDTH - MARGIN - 26).toFixed(2)} ${(MARGIN - 26).toFixed(2)} Tm (${index + 1} / ${total}) Tj ET 0 g`,
    );
  });

  const objects: string[] = [];
  const pageObjects = pages.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjects
    .map((number) => `${number} 0 R`)
    .join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((entry, index) => {
    const pageNumber = pageObjects[index]!;
    const contentNumber = pageNumber + 1;
    const stream = entry.ops.join("\n");
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    objects[contentNumber] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return { bytes: new TextEncoder().encode(pdf), pages: pages.length };
}
