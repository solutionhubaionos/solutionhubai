/**
 * Client logo extraction from a website URL.
 *
 * Only the logo is wanted; the target's colours are not used. Every fetch goes
 * through the SSRF guard, redirects are followed manually with the guard re-run
 * per hop, and the result is rasterised to a PNG (SVG included) so the PPTX/PDF
 * writers can place it. `og:image` is deliberately never used: it is a hero
 * banner, not a logo.
 *
 * Server-only: uses node:dns and @napi-rs/canvas.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { assertAllowedUrl, assertPublicDns } from "../brand/ssrf";

export type ClientLogo = {
  /** PNG data URL, already sized for a slide. */
  dataUrl: string;
  width: number;
  height: number;
  /** True when the logo's opaque pixels are mostly light (place it without a panel). */
  light: boolean;
};

const MAX_HTML_BYTES = 600_000;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_HOPS = 4;
const TIMEOUT_MS = 8_000;
const MAX_WIDTH = 640;
const MIN_DIMENSION = 48;

async function guardedFetch(url: URL): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let current = await assertPublicDns(url);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; SolutionHubBot/1.0)" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        current = await assertPublicDns(new URL(location, current));
        continue;
      }
      if (!response.ok) return null;
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
      const declared = Number(response.headers.get("content-length") ?? "0");
      const cap = contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_HTML_BYTES;
      if (declared > cap) return null;
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > cap) return null;
      return { bytes: buffer, contentType };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

type Candidate = { url: string; score: number };

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() ?? null;
}

/** Ordered logo candidates from the page HTML. Never og:image. */
export function logoCandidates(html: string, base: URL): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (raw: string | null, score: number) => {
    if (!raw || raw.startsWith("data:")) return;
    try {
      candidates.push({ url: new URL(raw, base).toString(), score });
    } catch {
      // A malformed href is simply skipped.
    }
  };

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, "rel") ?? "").toLowerCase();
    const href = attribute(tag, "href");
    if (rel.includes("apple-touch-icon")) push(href, 90);
    else if (rel.split(/\s+/).includes("icon")) push(href, 55);
  }

  // An <img>/<svg> whose own attributes mention "logo" is the strongest signal.
  for (const tag of html.match(/<(?:img|svg)\b[^>]*>/gi) ?? []) {
    if (/logo/i.test(tag)) push(attribute(tag, "src") ?? attribute(tag, "href"), 85);
  }

  // Any header/nav image is a weaker signal.
  const header = html.match(/<(?:header|nav)\b[\s\S]*?<\/(?:header|nav)>/i)?.[0] ?? "";
  for (const tag of header.match(/<img\b[^>]*>/gi) ?? []) {
    push(attribute(tag, "src"), 45);
  }

  push(new URL("/apple-touch-icon.png", base).toString(), 25);
  push(new URL("/favicon.ico", base).toString(), 10);

  return candidates.sort((a, b) => b.score - a.score);
}

/** Draws any supported image (PNG/JPEG/WebP/SVG) to a capped PNG and reads luminance. */
async function toPng(bytes: Uint8Array): Promise<ClientLogo | null> {
  let image;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch {
    return null;
  }
  const width = image.width;
  const height = image.height;
  if (!width || !height) return null;
  if (Math.min(width, height) < MIN_DIMENSION) return null;

  const scale = Math.min(1, MAX_WIDTH / width);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(outWidth, outHeight);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, outWidth, outHeight);

  // Mean luminance of the opaque pixels decides whether the logo needs a panel.
  const { data } = ctx.getImageData(0, 0, outWidth, outHeight);
  let sum = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < 128) continue;
    sum += 0.2126 * (data[index] ?? 0) + 0.7152 * (data[index + 1] ?? 0) + 0.0722 * (data[index + 2] ?? 0);
    count += 1;
  }
  const light = count === 0 ? false : sum / count / 255 > 0.72;

  return {
    dataUrl: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`,
    width: outWidth,
    height: outHeight,
    light,
  };
}

/**
 * Returns the best usable logo for a website, or null. Best effort: a failure
 * must never block a deck, which falls back to the client's name in text.
 */
export async function extractClientLogo(
  websiteUrl: string,
  log: (event: string, meta: Record<string, unknown>) => void = () => undefined,
): Promise<ClientLogo | null> {
  let base: URL;
  try {
    base = await assertPublicDns(new URL(websiteUrl));
  } catch (error) {
    log("client logo: unsafe url", { error: String(error).slice(0, 120) });
    return null;
  }

  const page = await guardedFetch(base);
  if (!page || !/text\/html|application\/xhtml/i.test(page.contentType)) {
    log("client logo: no html", { url: base.href });
    return null;
  }
  const html = new TextDecoder().decode(page.bytes);

  for (const candidate of logoCandidates(html, base)) {
    let target: URL;
    try {
      target = assertAllowedUrl(candidate.url);
    } catch {
      continue;
    }
    const asset = await guardedFetch(target);
    if (!asset || !asset.contentType.startsWith("image/")) continue;
    const logo = await toPng(asset.bytes);
    if (logo) {
      log("client logo: found", { url: target.href, width: logo.width, light: logo.light });
      return logo;
    }
  }
  log("client logo: none", { url: base.href });
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The client's own words about itself, from its homepage, for grounding the
 * deck on the target rather than on model memory. Best effort and capped; a
 * failure returns null and the deck simply has no extra target context.
 */
export async function fetchSiteText(
  websiteUrl: string,
  log: (event: string, meta: Record<string, unknown>) => void = () => undefined,
): Promise<string | null> {
  let base: URL;
  try {
    base = await assertPublicDns(new URL(websiteUrl));
  } catch {
    return null;
  }
  const page = await guardedFetch(base);
  if (!page || !/text\/html|application\/xhtml/i.test(page.contentType)) return null;
  const html = new TextDecoder().decode(page.bytes);
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = stripHtml(
    html.match(
      /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
    )?.[1] ??
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i,
      )?.[1] ??
      "",
  );
  const body = stripHtml(html.replace(/<(?:nav|header|footer)[\s\S]*?<\/(?:nav|header|footer)>/gi, " "));
  const text = [title, description, body].filter(Boolean).join(". ").slice(0, 1600).trim();
  if (!text) {
    log("client site: no text", { url: base.href });
    return null;
  }
  log("client site: text", { url: base.href, chars: text.length });
  return text;
}
