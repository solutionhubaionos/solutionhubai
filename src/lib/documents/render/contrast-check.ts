/**
 * Reads a rendered PPTX package and verifies every text run's colour against
 * its nearest filled ancestor. pptxgenjs emits a text box as its own shape, so
 * the backdrop is found geometrically: the most recent filled shape drawn before
 * the run whose rectangle contains it, else the slide background. This is the
 * Phase 6 "text vs nearest filled ancestor" check, so a correct white-on-
 * electric-blue box passes and a wrong white-on-pearl box fails.
 */
import { palette } from "../tokens";
import { checkTextPair } from "../contrast";

export type ContrastFinding = { slide: string; text: string; reason: string };

const DEFAULT_BG = palette.navy;

/** The solid background colour of a slide, or the dark default. */
function slideBackground(xml: string): string {
  const block = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0];
  if (!block) return DEFAULT_BG;
  return block.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase() ?? DEFAULT_BG;
}

/** The first `srgbClr` inside every text-run properties block. */
function runColours(block: string): string[] {
  const colours: string[] = [];
  for (const run of block.match(/<a:rPr\b[\s\S]*?<\/a:rPr>/g) ?? []) {
    const value = run.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
    if (value) colours.push(value.toUpperCase());
  }
  return colours;
}

/** The shape's own fill: the first `srgbClr` before any outline. */
function shapeFill(block: string): string | null {
  const spPr = block.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0];
  if (!spPr) return null;
  const beforeOutline = spPr.split(/<a:ln\b/)[0] ?? spPr;
  const value = beforeOutline.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
  return value ? value.toUpperCase() : null;
}

type Rect = { x: number; y: number; w: number; h: number };

/** The shape's bounding box in EMU, or null when it has no transform. */
function shapeRect(block: string): Rect | null {
  const off = block.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const ext = block.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!off || !ext) return null;
  return { x: Number(off[1]), y: Number(off[2]), w: Number(ext[1]), h: Number(ext[2]) };
}

/** True when `inner`'s centre sits inside `outer` (both in EMU). */
function contains(outer: Rect, inner: Rect): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/** The table cell's fill, ignoring the cell's border lines. */
function cellFill(block: string): string | null {
  const tcPr = block.match(/<a:tcPr[\s\S]*?<\/a:tcPr>/)?.[0];
  if (!tcPr) return null;
  const cleaned = tcPr.replace(/<a:ln[LRTB]?\b[^>]*>[\s\S]*?<\/a:ln[LRTB]?>/g, "");
  const value = cleaned.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
  return value ? value.toUpperCase() : null;
}

export function checkDeckContrast(parts: Record<string, Uint8Array>): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(parts)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const xml = decoder.decode(data);
    const background = slideBackground(xml);
    const filled: { rect: Rect; fill: string }[] = [];
    for (const block of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
      const rect = shapeRect(block);
      const fill = shapeFill(block);
      const runs = runColours(block);
      if (runs.length > 0) {
        const own = fill ?? undefined;
        const ancestor = own
          ? own
          : rect
            ? filled.filter((box) => contains(box.rect, rect)).at(-1)?.fill
            : undefined;
        const backdrop = ancestor ?? background;
        for (const colour of runs) {
          const verdict = checkTextPair(colour, backdrop);
          if (!verdict.ok) findings.push({ slide: name, text: colour, reason: verdict.reason });
        }
      }
      if (fill && rect) filled.push({ rect, fill });
    }
    for (const cell of xml.match(/<a:tc>[\s\S]*?<\/a:tc>/g) ?? []) {
      const backdrop = cellFill(cell) ?? background;
      for (const colour of runColours(cell)) {
        const verdict = checkTextPair(colour, backdrop);
        if (!verdict.ok) findings.push({ slide: name, text: colour, reason: verdict.reason });
      }
    }
  }
  return findings;
}
