/**
 * Turns an extracted document's pictures into OCR text sections. Pages and
 * media that native extraction read well are skipped; everything it produced is
 * kept. The resulting sections go through the worker's normal chunk → embed →
 * insert path, so retrieval, ranking and answers are untouched.
 *
 * Runs in the Bun worker only: PDF pages are rendered through @napi-rs/canvas
 * and images are read via the GLM-OCR client.
 */
import { createHash } from "node:crypto";
import { renderPageAsImage } from "unpdf";
import type { DocumentFormat } from "@/lib/document-format";
import {
  collectOcrImages,
  readMediaFiles,
  type ExtractedDocument,
  type ExtractedSection,
} from "../extract";
import { mapWithConcurrency, ocrImage, type OcrConfig } from "./glm-ocr";

/** PDF.js renders at 72 DPI, so this is roughly 150 DPI. */
const PDF_OCR_SCALE = 150 / 72;

type OcrCandidate = {
  data: Uint8Array;
  mime: string;
  pageOrSlide: number | null;
  /** Human label for the context line, e.g. "Slide 7" / "Page 2" / "Image". */
  place: string;
};

/** The one-line context prefix stored with OCR text so citations make sense. */
export function ocrContextLine(place: string): string {
  return `[${place} – OCR text]`;
}

/** Output that describes or answers about the picture instead of transcribing it. */
const NOT_TRANSCRIPTION =
  /^(?:the|this|an?) (?:image|picture|photo|slide|screenshot)\b|\bit (?:looks|appears|seems)\b|respond with|^(?:no|yes|hold on|sure)\b[,.]/i;

/**
 * The model sometimes wraps its answer in a code fence or returns JSON instead
 * of plain text, describes a picture that has no text instead of transcribing
 * it, or emits only a stray label. Normalise the first, and drop the rest, so a
 * noise chunk is never stored.
 */
export function cleanOcrText(raw: string): string {
  let text = raw.trim();
  const fence = /^```[\w-]*[ \t]*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = (fence[1] ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // Only a text/content field is transcribed text; a "description" wrapper
      // is the model captioning the picture, which we do not store.
      const value = parsed["text"] ?? parsed["content"];
      if (typeof value !== "string") return "";
      text = value.trim();
    } catch {
      // Not JSON after all; keep the raw text.
    }
  }
  if (NOT_TRANSCRIPTION.test(text)) return "";
  // A stray label ("aws", "O") is not evidence; require a few letters/digits.
  if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length < 4) return "";
  return text;
}

export type OcrDocumentResult = {
  sections: ExtractedSection[];
  warnings: string[];
};

/**
 * OCRs the pictures of one document. Returns no sections when nothing needs
 * reading; any per-image failure is logged and skipped, never thrown.
 */
export async function ocrDocumentSections(
  bytes: Uint8Array,
  format: DocumentFormat,
  document: ExtractedDocument,
  config: OcrConfig,
  log: (message: string) => void = () => {},
): Promise<OcrDocumentResult> {
  const candidates = (await gatherCandidates(bytes, format, document, config)).slice(
    0,
    config.maxImagesPerDoc,
  );
  if (candidates.length === 0) return { sections: [], warnings: [] };

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = createHash("sha256").update(candidate.data).digest("hex");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const results = await mapWithConcurrency(unique, config.concurrency, async (candidate) => ({
    candidate,
    text: cleanOcrText(
      await ocrImage(candidate.data, candidate.mime, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        prompt: config.prompt,
        timeoutMs: config.timeoutMs,
        cacheDir: config.cacheDir,
        logger: log,
      }),
    ),
  }));

  const sections: ExtractedSection[] = [];
  let blank = 0;
  for (const { candidate, text } of results) {
    if (!text) {
      blank += 1;
      continue;
    }
    sections.push({
      text: `${ocrContextLine(candidate.place)}\n${text}`,
      pageOrSlide: candidate.pageOrSlide,
      heading: null,
      // "text" so the chunker splits and overlaps it like any other prose; the
      // metadata still marks it as OCR for diagnostics.
      kind: "text",
      metadata: { source: "ocr", type: "ocr", model: config.model },
    });
  }

  const warnings: string[] = [];
  if (sections.length > 0) {
    warnings.push(`${sections.length} image(s) read by ${config.model}`);
  }
  if (blank > 0) warnings.push(`${blank} image(s) yielded no OCR text`);

  return { sections, warnings };
}

async function gatherCandidates(
  bytes: Uint8Array,
  format: DocumentFormat,
  document: ExtractedDocument,
  config: OcrConfig,
): Promise<OcrCandidate[]> {
  if (format === "pdf") return pdfCandidates(bytes, document, config);
  if (format === "pptx" || format === "docx") return packageCandidates(bytes, format, config);
  return [];
}

/**
 * Only pages whose native text is too thin are rendered. A page with a real
 * text layer already has its words; rendering it again would duplicate them.
 *
 * shortcut: chart images sitting on a text-rich page are not rendered. Upgrade
 * to operator-list image detection if embedded-chart-only pages become common.
 */
async function pdfCandidates(
  bytes: Uint8Array,
  document: ExtractedDocument,
  config: OcrConfig,
): Promise<OcrCandidate[]> {
  const wanted = new Set<number>();
  for (const section of document.sections) {
    if (section.pageOrSlide === null) continue;
    if (section.text.replace(/\s+/g, "").length < config.minTextChars) {
      wanted.add(section.pageOrSlide);
    }
  }

  const candidates: OcrCandidate[] = [];
  for (const page of wanted) {
    if (candidates.length >= config.maxImagesPerDoc) break;
    try {
      // A fresh copy per page: PDF.js may detach the buffer it is handed.
      const png = await renderPageAsImage(bytes.slice(), page, {
        scale: PDF_OCR_SCALE,
        canvasImport: () => import("@napi-rs/canvas"),
      });
      candidates.push({
        data: new Uint8Array(png),
        mime: "image/png",
        pageOrSlide: page,
        place: `Page ${page}`,
      });
    } catch {
      // An unrenderable page is skipped; the rest of the document still runs.
    }
  }
  return candidates;
}

function packageCandidates(
  bytes: Uint8Array,
  format: DocumentFormat,
  config: OcrConfig,
): OcrCandidate[] {
  const media = collectOcrImages(bytes, format).slice(0, config.maxImagesPerDoc);
  if (media.length === 0) return [];
  const files = readMediaFiles(
    bytes,
    media.map((image) => image.path),
  );

  const candidates: OcrCandidate[] = [];
  for (const image of media) {
    const data = files.get(image.path);
    if (!data || data.byteLength === 0) continue;
    const place =
      format === "pptx" && image.pageOrSlide !== null ? `Slide ${image.pageOrSlide}` : "Image";
    candidates.push({ data, mime: image.mimeType, pageOrSlide: image.pageOrSlide, place });
  }
  return candidates;
}
