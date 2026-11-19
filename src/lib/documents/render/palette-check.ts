/**
 * Deterministic style lint for a rendered deck: every colour that reaches the
 * slides or charts must come from `aionos.tokens.json`, no programmatic
 * gradient fill may appear (the title bleeds a bundled baked gradient image,
 * not `<a:gradFill>`), only the two brand typefaces may be used, and the deck
 * opens on the white co-brand page and closes on a deep-navy page. The renderer
 * reads only the tokens, so a finding here means a literal slipped in or a
 * dependency injected its own default. Run on the exported package; see
 * `scripts/check-deck.ts`.
 */
import { palette, type PaletteName } from "../tokens";

export type PaletteFinding = { part: string; colour: string };
export type StyleFinding = { part: string; reason: string };

/** The closed brand palette. Nothing else may reach a slide. */
const ALLOWED = new Set(Object.values(palette).map((value) => value.toUpperCase()));

/** The only typefaces a slide or chart may name. */
const FONTS = new Set([
  "Century Gothic",
  "Aptos",
  "+mn-lt",
  "+mj-lt",
  "", // an explicit default; the theme fills it in
]);

const SLIDE_TEXT = /^ppt\/(?:slides|charts|notesSlides)\//;

/** Every `srgbClr` value in the slide and chart XML that is not a brand colour. */
export function checkDeckPalette(parts: Record<string, Uint8Array>): PaletteFinding[] {
  const findings: PaletteFinding[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(parts)) {
    if (!/^ppt\/(?:slides|charts|notesSlides)\//.test(name)) continue;
    const xml = decoder.decode(data);
    for (const match of xml.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)) {
      const colour = match[1]!.toUpperCase();
      if (!ALLOWED.has(colour)) findings.push({ part: name, colour });
    }
  }
  return findings;
}

/** Any gradient fill in a slide or chart. The brand forbids them in a deck. */
export function checkDeckGradients(parts: Record<string, Uint8Array>): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(parts)) {
    if (!SLIDE_TEXT.test(name)) continue;
    if (decoder.decode(data).includes("<a:gradFill")) {
      findings.push({ part: name, reason: "gradient fill is not allowed" });
    }
  }
  return findings;
}

/** Any typeface a slide or chart names that is not Century Gothic or Aptos. */
export function checkDeckFonts(parts: Record<string, Uint8Array>): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(parts)) {
    if (!SLIDE_TEXT.test(name)) continue;
    for (const match of decoder.decode(data).matchAll(/typeface="([^"]*)"/g)) {
      const face = match[1]!;
      if (!FONTS.has(face))
        findings.push({ part: name, reason: `typeface "${face}" is off-brand` });
    }
  }
  return findings;
}

/** Parts that embed a picture (a logo or approved image), for the image budget. */
export function checkDeckImages(parts: Record<string, Uint8Array>): string[] {
  const decoder = new TextDecoder();
  return Object.entries(parts)
    .filter(([name]) => SLIDE_TEXT.test(name))
    .filter(([, data]) => decoder.decode(data).includes("<a:blip"))
    .map(([name]) => name);
}

/** The solid background colour of a slide, or null when it paints none. */
function slideBackground(xml: string): string | null {
  const bg = xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/);
  return bg ? bg[1]!.toUpperCase() : null;
}

/**
 * Backgrounds: the deck opens on the white lockup page, every content page is
 * white (the contents page may be pearl), and blue is never a solid background
 * — the only dark canvas is the gradient title, recognised by its embedded
 * image. A dark background without that image is a finding.
 */
export function checkDeckBackgrounds(parts: Record<string, Uint8Array>): {
  sequence: string[];
  findings: StyleFinding[];
} {
  const decoder = new TextDecoder();
  const slides = Object.keys(parts)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const decoded = slides.map((name) => decoder.decode(parts[name]!));
  const sequence = decoded.map((xml) => slideBackground(xml) ?? "?");
  const findings: StyleFinding[] = [];
  const deepNavy = palette.deepNavy;
  const white = palette.white;
  const lightBackdrops = new Set([white, palette.pearl]);
  slides.forEach((name, index) => {
    const colour = sequence[index]!;
    if (index === 0) {
      if (colour !== white) findings.push({ part: name, reason: "cover must be white" });
      return;
    }
    if (lightBackdrops.has(colour)) return;
    // The one allowed dark canvas: the baked gradient title carries an image.
    if (colour === deepNavy && decoded[index]!.includes("<a:blip")) return;
    findings.push({
      part: name,
      reason: `background ${colour} must be white or pearl; blue is only the gradient title`,
    });
  });
  return { sequence, findings };
}

/** True when every palette name in the token file is a valid six-hex colour. */
export function paletteIsComplete(): boolean {
  return Object.values(palette as Record<PaletteName, string>).every((value) =>
    /^[0-9A-Fa-f]{6}$/.test(value),
  );
}
