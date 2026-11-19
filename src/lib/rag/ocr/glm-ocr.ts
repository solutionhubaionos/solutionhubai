/**
 * GLM-OCR client for the ingestion worker (Bun/Node only — it uses
 * @napi-rs/canvas to size and downscale images before sending them).
 *
 * Additive and opt-in: nothing calls this unless OCR_ENABLED is set. It reuses
 * the existing TOKENFACTORY_API_BASE / TOKENFACTORY_API_KEY and the same
 * OpenAI-compatible /chat/completions shape as vision.ts, but never throws to
 * the caller: on any error or timeout it returns "" so ingestion continues.
 *
 * The prompt strings and image-input format for zai-org/glm-ocr are unverified
 * against the live provider (see README "OCR"). OCR_PROMPT overrides the text
 * prompt without a code change.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const OCR_DEFAULT_MODEL = "zai-org/glm-ocr";
export const OCR_DEFAULT_PROMPT = "Text Recognition:";
export const OCR_TABLE_PROMPT = "Table Recognition:";
export const OCR_DEFAULT_TIMEOUT_MS = 60_000;
export const OCR_DEFAULT_CONCURRENCY = 3;
export const OCR_DEFAULT_MAX_IMAGES = 40;
export const OCR_DEFAULT_MIN_TEXT_CHARS = 50;
export const OCR_MAX_TOKENS = 4_096;
/** Retries past the first attempt; only 429/5xx are retried. */
export const OCR_MAX_RETRIES = 2;
/** Longest side above which an image is downscaled before sending. */
export const OCR_MAX_IMAGE_SIDE = 2_000;
/** Below this on either side an image is chrome (logo, bullet), not content. */
export const OCR_MIN_IMAGE_SIDE = 100;

export type OcrMode = "text" | "table";

/** The task prompt sent with the image; table mode asks for markdown rows. */
export function ocrPrompt(mode: OcrMode, prompt: string = OCR_DEFAULT_PROMPT): string {
  return mode === "table" ? OCR_TABLE_PROMPT : prompt;
}

export type OcrConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  concurrency: number;
  maxImagesPerDoc: number;
  minTextChars: number;
  /** On-disk result cache keyed by image hash; null disables it. */
  cacheDir: string | null;
};

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the OCR_* env with safe defaults; disabled unless OCR_ENABLED is set. */
export function ocrConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  return {
    enabled: envFlag(env["OCR_ENABLED"]),
    apiKey: env["TOKENFACTORY_API_KEY"] ?? "",
    baseUrl: env["TOKENFACTORY_API_BASE"] ?? "",
    model: env["OCR_MODEL"] || OCR_DEFAULT_MODEL,
    prompt: env["OCR_PROMPT"] || OCR_DEFAULT_PROMPT,
    timeoutMs: envNumber(env["OCR_TIMEOUT_MS"], OCR_DEFAULT_TIMEOUT_MS),
    concurrency: envNumber(env["OCR_CONCURRENCY"], OCR_DEFAULT_CONCURRENCY),
    maxImagesPerDoc: envNumber(env["OCR_MAX_IMAGES_PER_DOC"], OCR_DEFAULT_MAX_IMAGES),
    minTextChars: envNumber(env["OCR_MIN_TEXT_CHARS"], OCR_DEFAULT_MIN_TEXT_CHARS),
    cacheDir: env["OCR_CACHE_DIR"] ?? ".cache/ocr",
  };
}

export type OcrOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  prompt?: string;
  mode?: OcrMode;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  logger?: (message: string) => void;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string } | string;
};

/**
 * One image in, one text transcription out. Never throws and never returns a
 * guess: an unreadable image, a small logo, a timeout or a provider error all
 * yield "". Successful results are cached by image hash so a re-ingest of an
 * unchanged file does not call the model again.
 */
export async function ocrImage(
  image: Uint8Array,
  mime: string,
  options: OcrOptions,
): Promise<string> {
  const log = options.logger ?? (() => {});
  try {
    // The cache key includes model and prompt: changing either must not reuse
    // results produced by the old configuration.
    const cacheKey = createHash("sha256")
      .update(
        `${options.model ?? OCR_DEFAULT_MODEL}\u0000${ocrPrompt(
          options.mode ?? "text",
          options.prompt,
        )}\u0000`,
      )
      .update(image)
      .digest("hex");
    const prepared = await prepareImage(image, mime);
    if (!prepared) return "";

    const cacheFile = options.cacheDir ? join(options.cacheDir, `${cacheKey}.txt`) : null;
    if (cacheFile) {
      const cached = readCache(cacheFile);
      if (cached !== null) return cached;
    }

    const text = await requestText(prepared.bytes, prepared.mime, options);
    if (text && cacheFile) writeCache(cacheFile, text);
    return text;
  } catch (error) {
    log(`ocr failed: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/** Sizes the image; returns null for chrome, and a downscaled copy when huge. */
async function prepareImage(
  image: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let decoded;
  try {
    decoded = await loadImage(Buffer.from(image));
  } catch {
    // A format canvas cannot decode (WMF/EMF and friends) is one the provider
    // rejects too ("Failed to load image"), so skip it instead of sending it.
    return null;
  }
  if (decoded.width < OCR_MIN_IMAGE_SIDE || decoded.height < OCR_MIN_IMAGE_SIDE) return null;

  const longest = Math.max(decoded.width, decoded.height);
  if (longest <= OCR_MAX_IMAGE_SIDE) return { bytes: image, mime };

  const scale = OCR_MAX_IMAGE_SIDE / longest;
  const canvas = createCanvas(
    Math.max(1, Math.round(decoded.width * scale)),
    Math.max(1, Math.round(decoded.height * scale)),
  );
  canvas.getContext("2d").drawImage(decoded, 0, 0, canvas.width, canvas.height);
  return { bytes: canvas.toBuffer("image/png"), mime: "image/png" };
}

/** Calls the provider with bounded retries on 429/5xx; throws on final failure. */
async function requestText(image: Uint8Array, mime: string, options: OcrOptions): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const model = options.model ?? OCR_DEFAULT_MODEL;
  const prompt = ocrPrompt(options.mode ?? "text", options.prompt);
  const timeoutMs = options.timeoutMs ?? OCR_DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    model,
    max_tokens: options.maxTokens ?? OCR_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64(image)}` } },
        ],
      },
    ],
  });

  let lastError = "";
  for (let attempt = 0; attempt <= OCR_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (response.ok) return parseText(raw);
      const message = providerMessage(raw);
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`OCR provider failed (${response.status}): ${message}`);
      }
      lastError = `OCR provider ${response.status}: ${message}`;
    } catch (error) {
      // A non-retryable 4xx is rethrown as-is; network/timeout errors retry.
      if (error instanceof Error && error.message.startsWith("OCR provider failed")) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < OCR_MAX_RETRIES) await delay(400 * 2 ** attempt);
  }
  throw new Error(lastError || "OCR request failed");
}

function parseText(raw: string): string {
  let body: ChatResponse;
  try {
    body = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new Error("OCR provider returned a non-JSON response");
  }
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

function readCache(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function writeCache(file: string, text: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  } catch {
    // A read-only cache directory must never fail ingestion.
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function providerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as ChatResponse;
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
    if (message) return message.slice(0, 300);
  } catch {
    // fall through to the raw body
  }
  return raw.slice(0, 300);
}

/** Runs `fn` over items with at most `limit` in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
