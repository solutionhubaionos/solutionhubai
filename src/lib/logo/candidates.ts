/**
 * Ordered logo candidates from a page's HTML. Pure string parsing — no cheerio,
 * no DOM, no native addon — so the module loads on any runtime.
 *
 * Only the logo is wanted; `og:image` is deliberately never used (it is a hero
 * banner, not a logo). The wordmark is often not an <img>: SPA navbars set it
 * as a CSS background-image, so url() values naming a logo/brand are also
 * considered, as are lazy-load attributes, a schema.org "logo" property, and
 * plain `*logo*.(png|jpg|svg|webp)` file names. Country/flag strips under a
 * `sites-logo` directory are excluded. Trust/review badges (which also call
 * themselves "logo") and footer variants are down-ranked so they cannot win.
 */
export type Candidate = { url: string; score: number; source: string };
export type LogoCandidate = Candidate;

/** A review/trust badge is never the client's own logo. */
const BADGE_LOGO = /(?:trustpilot|trust-?box|tp-logo|review|rating|badge|widget|seal)/i;

/** A country/flag strip or a "sites-logo" directory is not the company mark. */
const NOT_BRAND_PATH = /\/(?:sites?[-_])?(?:logo|flag|country|countries)\//i;

/** A tag attribute value, in double, single or unquoted form. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** The best image on a tag, preferring a real src over a lazy placeholder. */
function lazySrc(tag: string): string | undefined {
  const first = (value: string | undefined) => value?.split(/[ ,]/)[0] || undefined;
  return (
    attr(tag, "src") ??
    attr(tag, "data-src") ??
    attr(tag, "data-lazy-src") ??
    attr(tag, "data-original") ??
    first(attr(tag, "srcset")) ??
    first(attr(tag, "data-srcset"))
  );
}

function iconSize(sizes: string | undefined): number {
  const match = /(\d+)x(\d+)/.exec(sizes ?? "");
  return match ? Math.min(Number(match[1]), Number(match[2])) : 0;
}

export function logoCandidates(html: string, base: URL): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (
    raw: string | null | undefined,
    score: number,
    source: string,
    context = "",
    inFooter = false,
  ) => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return;
    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      return;
    }
    if (NOT_BRAND_PATH.test(url)) return;
    let adjusted = score;
    if (BADGE_LOGO.test(`${raw} ${context}`)) adjusted -= 70;
    if (inFooter || /footer/i.test(url)) adjusted -= 40;
    if (adjusted <= 0) return;
    if (candidates.some((candidate) => candidate.url === url)) return;
    candidates.push({ url, score: adjusted, source });
  };

  // Footer stretches, so a tag inside one is recognised as the mono variant.
  const footers = [...html.matchAll(/<footer\b[\s\S]*?<\/footer>/gi)].map(
    (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const,
  );
  const inFooter = (index: number) =>
    footers.some(([start, end]) => index >= start && index <= end);

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    const dimension = iconSize(attr(tag, "sizes"));
    if (rel.includes("apple-touch-icon")) {
      push(href, 90 + Math.min(8, Math.floor(dimension / 64)), "apple-icon");
    } else if (rel.split(/\s+/).includes("icon")) {
      push(href, 55 + Math.min(8, Math.floor(dimension / 32)), "favicon");
    }
  }

  // An <img>/<svg> that names itself a logo (class, id, alt, src) is the
  // strongest in-page signal, wherever it sits. Lazy-loaded marks count too.
  for (const match of html.matchAll(/<(?:img|svg)\b[^>]*>/gi)) {
    const tag = match[0];
    const text = ["src", "href", "data-src", "class", "id", "alt", "aria-label"]
      .map((name) => attr(tag, name) ?? "")
      .join(" ");
    if (/logo/i.test(text)) {
      push(lazySrc(tag) ?? attr(tag, "href"), 85, "site-logo", text, inFooter(match.index ?? 0));
    }
  }

  // Any header or nav image is a weaker signal.
  for (const region of html.matchAll(/<(?:header|nav)\b[\s\S]*?<\/(?:header|nav)>/gi)) {
    for (const img of region[0].matchAll(/<img\b[^>]*>/gi)) {
      push(lazySrc(img[0]), 45, "site-logo");
    }
  }

  // Logo files named in client-side data, CSS and JSON-LD are common on SPAs.
  for (const named of html.matchAll(/([^"'\s]*logo[^"'\s]*\.(?:png|jpe?g|svg|webp))/gi)) {
    const raw = named[1];
    if (raw && !NOT_BRAND_PATH.test(raw)) push(raw, 78, "site-logo");
  }

  // A schema.org "logo" property on the organisation names the mark explicitly.
  const structured = /"logo"\s*:\s*(?:"([^"\\]+)"|\{[^}]*?"(?:url|@id)"\s*:\s*"([^"\\]+)")/i.exec(
    html,
  );
  push(structured?.[1] ?? structured?.[2], 88, "structured-logo");

  // A logo set as a CSS background-image (common for SPA navbars: the wordmark
  // is a styled <div>, not an <img>) is invisible to the tags above.
  for (const match of html.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const raw = match[2];
    if (raw && /logo|brand/i.test(raw)) push(raw, 82, "site-logo", "css-background");
  }

  push(new URL("/apple-touch-icon.png", base).toString(), 25, "apple-icon");
  push(new URL("/favicon.ico", base).toString(), 10, "favicon");

  return candidates.sort((a, b) => b.score - a.score);
}
