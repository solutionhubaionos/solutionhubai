import { Buffer } from "node:buffer";
import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { documentFormat, type DocumentFormat } from "@/lib/document-format";

export const MIN_USEFUL_CHARS = 20;

// Real decks use custom heading styles; map the common ones to HTML headings.
const DOCX_STYLE_MAP = [
  "p[style-name='Section Heading'] => h1:fresh",
  "p[style-name='Heading 0'] => h1:fresh",
  "p[style-name='Title'] => h1:fresh",
];

export type ExtractedSection = {
  text: string;
  pageOrSlide: number | null;
  heading: string | null;
};

export type EmptyUnit = {
  pageOrSlide: number | null;
  heading: string | null;
};

export type ExtractedDocument = {
  format: DocumentFormat;
  sections: ExtractedSection[];
  emptyUnits: EmptyUnit[];
  warnings: string[];
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
  }));
  return { format: "pdf", sections, emptyUnits: emptyUnitsFrom(sections), warnings: [] };
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
  return { format: "docx", sections, emptyUnits: emptyUnitsFrom(sections), warnings };
}

function extractPptx(bytes: Uint8Array): ExtractedDocument {
  // Only decompress slide/notes XML; image-heavy decks can be hundreds of MB.
  const files = unzipSync(bytes, {
    filter: (file) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(file.name) ||
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(file.name) ||
      /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/.test(file.name),
  });
  const notes = pptxNotes(files);
  const slides = Object.keys(files)
    .map((path) => ({ path, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(path) }))
    .filter((entry): entry is { path: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  if (slides.length === 0) throw new Error("No slides found in PowerPoint file");

  const warnings: string[] = [];
  const sections: ExtractedSection[] = [];
  for (const { path, match } of slides) {
    const number = Number(match[1]);
    const data = files[path];
    if (!data) continue;
    try {
      // Slide text comes only from the slide XML. Image relationships are
      // ignored, so decks with broken media links still extract.
      const slideText = slideXmlToText(strFromU8(data));
      const note = notes.get(number);
      sections.push({
        text: note ? `${slideText}\n\nNotes: ${note}`.trim() : slideText,
        pageOrSlide: number,
        heading: null,
      });
    } catch (error) {
      warnings.push(`Slide ${number}: ${errorMessage(error)}`);
      sections.push({ text: "", pageOrSlide: number, heading: null });
    }
  }

  return { format: "pptx", sections, emptyUnits: emptyUnitsFrom(sections), warnings };
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
    if (text) sections.push({ text, pageOrSlide: null, heading });
    buffer = "";
  };

  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let lastIndex = 0;
  for (const match of html.matchAll(headingPattern)) {
    const index = match.index ?? 0;
    buffer += html.slice(lastIndex, index);
    flush();
    heading = htmlToText(match[2] ?? "");
    lastIndex = index + match[0].length;
  }
  buffer += html.slice(lastIndex);
  flush();
  return sections;
}

function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<\/(?:p|h[1-6]|li|tr|blockquote)>/gi, "\n")
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
