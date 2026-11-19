/**
 * OCR config and prompt selection. The model call itself needs the live
 * provider, so only the pure pieces are covered here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OCR_DEFAULT_MODEL,
  OCR_DEFAULT_PROMPT,
  OCR_TABLE_PROMPT,
  ocrConfigFromEnv,
  ocrImage,
  ocrPrompt,
} from "../src/lib/rag/ocr/glm-ocr";
import { cleanOcrText, ocrContextLine } from "../src/lib/rag/ocr/extract-images";

describe("OCR prompt selection", () => {
  test("defaults to the text prompt", () => {
    expect(ocrPrompt("text")).toBe(OCR_DEFAULT_PROMPT);
  });

  test("uses the table prompt in table mode, ignoring the configured text prompt", () => {
    expect(ocrPrompt("table", "custom")).toBe(OCR_TABLE_PROMPT);
    expect(ocrPrompt("text", "custom")).toBe("custom");
  });
});

describe("OCR config from env", () => {
  test("is disabled and uses safe defaults when nothing is set", () => {
    const config = ocrConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.model).toBe(OCR_DEFAULT_MODEL);
    expect(config.concurrency).toBe(3);
    expect(config.maxImagesPerDoc).toBe(40);
  });

  test("enables on OCR_ENABLED=true and reads overrides", () => {
    const config = ocrConfigFromEnv({
      OCR_ENABLED: "true",
      OCR_MODEL: "custom-ocr",
      OCR_CONCURRENCY: "5",
      OCR_MAX_IMAGES_PER_DOC: "2",
    });
    expect(config.enabled).toBe(true);
    expect(config.model).toBe("custom-ocr");
    expect(config.concurrency).toBe(5);
    expect(config.maxImagesPerDoc).toBe(2);
  });

  test("ignores a non-numeric override rather than crashing", () => {
    expect(ocrConfigFromEnv({ OCR_TIMEOUT_MS: "nope" }).timeoutMs).toBe(60_000);
  });
});

describe("OCR text cleanup", () => {
  test("unwraps a code fence, including an empty one", () => {
    expect(cleanOcrText("```markdown\nHello world\n```")).toBe("Hello world");
    expect(cleanOcrText("```markdown\n\n```")).toBe("");
  });

  test("unwraps a JSON {text} response but drops a description wrapper", () => {
    expect(cleanOcrText('{"text": "ENGAGEMENT WINS\\n✓ PoC"}')).toBe("ENGAGEMENT WINS\n✓ PoC");
    expect(cleanOcrText('```json\n{ "description": "a gradient circle" }\n```')).toBe("");
  });

  test("drops punctuation-only and stray-label output", () => {
    expect(cleanOcrText("___")).toBe("");
    expect(cleanOcrText("aws")).toBe("");
  });

  test("drops a non-transcription description of a picture", () => {
    expect(cleanOcrText("It looks like an abstract gradient circle.")).toBe("");
    expect(cleanOcrText("The image appears to show hands typing.")).toBe("");
    expect(cleanOcrText("Is the man a professional?\nRespond with a short phrase.")).toBe("");
    expect(cleanOcrText("THE BIG NUMBERS\nCURRENT STANDING")).toBe(
      "THE BIG NUMBERS\nCURRENT STANDING",
    );
  });

  test("builds the context line with the place", () => {
    expect(ocrContextLine("Slide 7")).toBe("[Slide 7 – OCR text]");
  });
});

// A real, decodable ≥100px image, so it passes the size/decode gate and reaches
// the provider; an undecodable buffer is skipped instead.
import { createCanvas } from "@napi-rs/canvas";
const canvas = createCanvas(120, 120);
canvas.getContext("2d").fillRect(0, 0, 120, 120);
const IMAGE = new Uint8Array(canvas.toBuffer("image/png"));
const BASE = { apiKey: "k", baseUrl: "https://example.test/v1", cacheDir: null };

describe("OCR client never blocks ingestion", () => {
  test("skips an image the runtime cannot decode without calling the provider", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const text = await ocrImage(new Uint8Array([1, 2, 3, 4]), "image/x-wmf", {
      ...BASE,
      fetchImpl,
    });
    expect(text).toBe("");
    expect(called).toBe(false);
  });

  test("returns empty text on a non-retryable provider error instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const text = await ocrImage(IMAGE, "image/png", { ...BASE, fetchImpl });
    expect(text).toBe("");
  });

  test("caches a result by image hash so a re-ingest makes no second call", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ocr-test-"));
    const ok = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Table X" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    expect(await ocrImage(IMAGE, "image/png", { ...BASE, cacheDir, fetchImpl: ok })).toBe(
      "Table X",
    );

    let called = false;
    const shouldNotRun = (async () => {
      called = true;
      throw new Error("fetch must not run on a cache hit");
    }) as unknown as typeof fetch;
    expect(await ocrImage(IMAGE, "image/png", { ...BASE, cacheDir, fetchImpl: shouldNotRun })).toBe(
      "Table X",
    );
    expect(called).toBe(false);
  });
});
