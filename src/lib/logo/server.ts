/**
 * Client-site reader: the logo (as a raw data URL) and the site's own words
 * about itself. Best effort — a failure returns null and the deck falls back to
 * the client's name. Pure web APIs (fetch/URL/Uint8Array) plus the shared SSRF
 * guard, so it runs on Node, Vercel or Cloudflare Workers with no native addon.
 *
 * The logo is returned RAw; the browser rasterises it to a PNG and measures it
 * (`src/lib/logo/rasterise.ts`), so this module never needs a canvas.
 */
import { logoCandidates, type LogoCandidate } from "./candidates";
import { downloadLogo } from "./download";
import { assertPublicDns } from "../brand/ssrf";

export type RawLogo = { dataUrl: string; source: string; url: string };
export type SiteLogoRead = { logo: RawLogo | null; siteText: string | null };

/** Optional third-party logo catalogs. Low-ranked; a site-hosted mark always wins. */
export const USE_LOGO_CATALOGS = true;

const BROWSERS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
];
const PAGE_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Cache-Control": "no-cache",
  "Upgrade-Insecure-Requests": "1",
};
const RETRY_STATUS = new Set([403, 405, 406, 429, 500, 502, 503, 504]);
const RETRY_PAUSE_MS = 250;
const MAX_HOPS = 4;
const MAX_HTML = 1_500_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scheme-less website normalised to a public http(s) URL, or null. */
export function normalizeWebsite(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Use an http or https website address.");
  }
  return url.toString();
}

function hostVariants(url: string) {
  const parsed = new URL(url);
  const other = parsed.hostname.startsWith("www.")
    ? parsed.hostname.slice(4)
    : `www.${parsed.hostname}`;
  if (!other.includes(".")) return [url];
  const toggled = new URL(url);
  toggled.hostname = other;
  return [url, toggled.toString()];
}

/**
 * GET with the SSRF guard re-run on every redirect hop. `redirect: "manual"`
 * keeps each hop visible, so a redirect to an internal host is refused.
 */
async function guardedGet(url: string, headers: Record<string, string>, timeout: number) {
  let current: URL;
  try {
    current = await assertPublicDns(new URL(url));
  } catch {
    return null;
  }
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      try {
        current = await assertPublicDns(new URL(location, current));
      } catch {
        return null;
      }
      continue;
    }
    return response;
  }
  return null;
}

async function fetchPage(rawUrl: string): Promise<string | null> {
  for (const [variant, url] of hostVariants(rawUrl).entries()) {
    for (const [attempt, browser] of BROWSERS.entries()) {
      if (variant || attempt) await sleep(RETRY_PAUSE_MS);
      const response = await guardedGet(url, { ...PAGE_HEADERS, "User-Agent": browser }, 15_000);
      if (!response) continue;
      if (!response.ok) {
        if (!RETRY_STATUS.has(response.status)) return null;
        continue;
      }
      const type = response.headers.get("content-type") ?? "";
      if (type && !/text\/html|text\/plain|application\/xhtml|application\/xml/i.test(type))
        continue;
      return (await response.text()).slice(0, MAX_HTML);
    }
  }
  return null;
}

/**
 * Optional JS-rendered HTML, via Cloudflare Browser Rendering. No-op unless the
 * account and a token are set. The Cloudflare-rendered hop cannot be seen by the
 * SSRF guard; the URL passed in was already cleared by it.
 */
async function fetchRenderedPage(url: string): Promise<string | null> {
  const env = globalThis.process?.env;
  const accountId = env?.["CLOUDFLARE_ACCOUNT_ID"]?.trim();
  const apiToken = env?.["CLOUDFLARE_API_TOKEN"]?.trim();
  const browserToken = env?.["CLOUDFLARE_BROWSER_TOKEN"]?.trim();
  const token = apiToken || browserToken;
  if (!accountId || !token) return null;
  const endpoint = apiToken ? "browser-rendering" : "browser-run";
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/${endpoint}/content`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          // networkidle2 never settles on a heavy site, so navigation times out
          // and the logo is missed. Wait for the DOM, then a short grace.
          gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
          waitForTimeout: 1_000,
        }),
        signal: AbortSignal.timeout(18_000),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { success?: boolean; result?: string };
    return payload.success && typeof payload.result === "string"
      ? payload.result.slice(0, MAX_HTML)
      : null;
  } catch {
    return null;
  }
}

/** The registrable domains of a URL, for a catalog lookup. */
function companyDomains(rawUrl: string) {
  const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  const compound = new Set([
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.in",
    "firm.in",
    "net.in",
    "org.in",
    "com.br",
    "com.cn",
    "com.sg",
    "com.my",
    "co.za",
    "com.mx",
    "com.tr",
    "com.tw",
    "com.hk",
    "com.ar",
    "co.jp",
    "co.kr",
  ]);
  const rootLabels = compound.has(labels.slice(-2).join(".")) ? 3 : 2;
  const root = labels.length > rootLabels ? labels.slice(-rootLabels).join(".") : hostname;
  return [...new Set([hostname, root])];
}

type Scored = LogoCandidate & { catalog: boolean };

/** Download every candidate and rank the ones that resolved. */
async function rank(candidates: Scored[]) {
  const downloaded = await Promise.all(
    candidates.map(async (candidate) => ({ candidate, image: await downloadLogo(candidate.url) })),
  );
  return downloaded
    .flatMap(({ candidate, image }) =>
      image
        ? [
            {
              candidate,
              data: image.dataUrl,
              score: candidate.catalog
                ? image.fallback === "tile"
                  ? 5
                  : image.fallback === "favicon"
                    ? 62
                    : candidate.score
                : candidate.score,
            },
          ]
        : [],
    )
    .sort((a, b) => b.score - a.score);
}

async function fromHtml(html: string, url: string): Promise<RawLogo | null> {
  const origin = new URL(url).origin;
  const catalogDomain = companyDomains(url).at(-1);
  const candidates: Scored[] = [
    ...logoCandidates(html, new URL(url)).map((candidate) => ({ ...candidate, catalog: false })),
    {
      url: new URL("/apple-touch-icon.png", origin).toString(),
      score: 70,
      source: "apple-icon",
      catalog: false,
    },
    {
      url: new URL("/favicon.ico", origin).toString(),
      score: 50,
      source: "favicon",
      catalog: false,
    },
    ...(catalogDomain && USE_LOGO_CATALOGS
      ? [
          {
            url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(catalogDomain)}&sz=128`,
            score: 72,
            source: "favicon",
            catalog: true,
          },
          {
            url: `https://logoapi.sh/${catalogDomain}.svg`,
            score: 82,
            source: "site-logo",
            catalog: true,
          },
        ]
      : []),
  ].filter(
    (candidate, index, all) => all.findIndex((other) => other.url === candidate.url) === index,
  );

  // The site's own assets first; a catalog is consulted only when they yield
  // nothing, so third-party egress is never spent on a logo we already have.
  const site = await rank(candidates.filter((candidate) => !candidate.catalog));
  const best = site[0] ?? (await rank(candidates.filter((candidate) => candidate.catalog)))[0];
  return best
    ? {
        dataUrl: best.data,
        source: best.candidate.catalog ? "logo-catalog" : best.candidate.source,
        url: best.candidate.url,
      }
    : null;
}

/** Best logo for a website, or null. Static HTML first, then one rendered pass. */
export async function extractClientLogo(rawUrl: string): Promise<RawLogo | null> {
  let url: string;
  try {
    url = normalizeWebsite(rawUrl) ?? "";
  } catch {
    return null;
  }
  if (!url) return null;

  const html = await fetchPage(url);
  if (html) {
    const logo = await fromHtml(html, url);
    if (logo) return logo;
  }

  const rendered = await fetchRenderedPage(url);
  if (rendered) {
    const logo = await fromHtml(rendered, url);
    if (logo) return logo;
  }

  // Last resort: the origin's favicon.
  const origin = new URL(url).origin;
  for (const fallback of [`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`]) {
    const image = await downloadLogo(fallback);
    if (image) return { dataUrl: image.dataUrl, source: "favicon", url: fallback };
  }
  return null;
}

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** The client's own words about itself, from its homepage. Best effort and capped. */
export async function fetchSiteText(rawUrl: string): Promise<string | null> {
  let url: string;
  try {
    url = normalizeWebsite(rawUrl) ?? "";
  } catch {
    return null;
  }
  if (!url) return null;
  const html = await fetchPage(url);
  if (!html) return null;
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = stripHtml(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i)?.[1] ??
      "",
  );
  const body = stripHtml(
    html.replace(/<(?:nav|header|footer)[\s\S]*?<\/(?:nav|header|footer)>/gi, " "),
  );
  return [title, description, body].filter(Boolean).join(". ").slice(0, 1600).trim() || null;
}
