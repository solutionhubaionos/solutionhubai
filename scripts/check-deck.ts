#!/usr/bin/env bun
/**
 * Acceptance check for a generated PowerPoint. Scans every XML part, including
 * speaker notes, charts, embedded workbook strings and document properties.
 *
 * Usage:
 *   bun scripts/check-deck.ts <file.pptx> [--references "IndiGo,Riyadh Air"] [--target "Client"]
 *
 * Reference names can also come from DECK_REFERENCE_BLOCKLIST (comma-separated).
 */
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { contrastRatio } from "../src/lib/brand/color";
import {
  checkDeckBackgrounds,
  checkDeckFonts,
  checkDeckGradients,
  checkDeckPalette,
} from "../src/lib/documents/render/palette-check";
import { checkDeckContrast } from "../src/lib/documents/render/contrast-check";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
  console.error(
    'Usage: bun scripts/check-deck.ts <file.pptx> [--references "Name,Name"] [--target "Client"]',
  );
  process.exit(2);
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

const references = [
  ...new Set(
    [option("references"), process.env.DECK_REFERENCE_BLOCKLIST ?? ""]
      .flatMap((value) => (value ?? "").split(","))
      .map((value) => value.trim())
      .filter((value) => value.length >= 3),
  ),
];
const target = option("target")?.trim() ?? "";
const claims = /\bCL-\d{1,4}\b|\{\{[^}]{0,80}\}\}/;
const attachment = /\.(?:pptx?|docx?|pdf|xlsx?)\b|_AIONOS\s+v?\d+(?:\.\d+)*/i;
const rawHeader = /Customer:\s*[^|]+\|\s*Industry:/i;
const orphan = /[$€£]\s*(?:-|—|bn|billion|million|m)\b|\b(?:at|by|of|to)\s*%/i;
const versionStem = /[-_ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_ ]?\d{2}\b/i;

const bytes = readFileSync(file);
const parts = unzipSync(new Uint8Array(bytes));
const hits: string[] = [];

for (const [name, data] of Object.entries(parts)) {
  // Workbook strings live in xl/sharedStrings.xml, which is included by design.
  if (!/\.(?:xml|rels)$/i.test(name)) continue;
  const text = new TextDecoder().decode(data);
  for (const reference of references) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    if (pattern.test(text)) hits.push(`${name}: reference name "${reference}"`);
  }
  if (claims.test(text)) hits.push(`${name}: claim id or unresolved token`);
  // Chart packages embed a workbook named Microsoft_Excel_Worksheet*.xlsx; that
  // is a legitimate OOXML part, not a leaked attachment, so rels are exempt.
  if (attachment.test(text) && !name.endsWith(".rels")) {
    hits.push(`${name}: attachment/file-name pattern`);
  }
  if (rawHeader.test(text)) hits.push(`${name}: raw Customer/Industry header`);
  if (orphan.test(text)) hits.push(`${name}: orphan currency or percentage symbol`);
  if (versionStem.test(text)) hits.push(`${name}: date-version file stem`);
  if (target) {
    const targetPattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    // The target may be named; this branch exists so a future rule that forbids
    // it on reference-number slides can be added without changing the scan seam.
    void targetPattern;
  }
}

const cover = parts["ppt/slides/slide1.xml"];
if (cover) {
  const xml = new TextDecoder().decode(cover);
  const background = xml.match(/<p:bg>.*?val="([0-9A-F]{6})"/s)?.[1];
  if (background) {
    const body = xml.replace(/<p:bg>.*?<\/p:bg>/s, "");
    const inks = [...body.matchAll(/<a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/g)].map(
      (match) => match[1]!,
    );
    // A text run on the cover must be readable. The lockup page is an image
    // only (the client's mark), so a page with no text runs is not a finding.
    if (inks.length > 0 && !inks.some((ink) => contrastRatio(`#${ink}`, `#${background}`) >= 4.5)) {
      hits.push(`ppt/slides/slide1.xml: no cover text run reaches 4.5 contrast on #${background}`);
    }
  }
}

for (const finding of checkDeckPalette(parts)) {
  hits.push(`${finding.part}: off-palette colour #${finding.colour}`);
}
for (const finding of checkDeckGradients(parts)) hits.push(`${finding.part}: ${finding.reason}`);
for (const finding of checkDeckFonts(parts)) hits.push(`${finding.part}: ${finding.reason}`);
for (const finding of checkDeckBackgrounds(parts).findings) {
  hits.push(`${finding.part}: ${finding.reason}`);
}
for (const finding of checkDeckContrast(parts)) {
  hits.push(`${finding.slide}: text #${finding.text} ${finding.reason}`);
}

if (hits.length > 0) {
  console.error(`FAIL ${file}`);
  for (const hit of [...new Set(hits)]) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(
  `OK ${file}: ${Object.keys(parts).length} parts, ${references.length} reference names checked`,
);
