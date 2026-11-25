/**
 * The one place every renderer reads its colours, fonts and sizes from. The
 * values live in `aionos.tokens.json` at the repo root: editing that file
 * restyles every exported PPTX, PDF and DOCX at once. Nothing downstream may
 * hard-code a colour or font.
 *
 * The contrast matrix is generated here (never hardcoded) with the WCAG
 * relative-luminance formula, so the allowed/forbidden lists are derived from
 * the same palette the renderers paint with.
 *
 * Colours are six-digit hex without a leading "#", which is what PptxGenJS and
 * the OOXML writers expect. PDF/DOCX call `#rrggbb` when they need a hash.
 */
import raw from "../../../aionos.tokens.json";
import { contrastRatio } from "../brand/color";

export const TOKENS = raw;

export type PaletteName = keyof typeof raw.palette;
export type BrandPalette = Record<PaletteName, string>;

/** The closed brand palette, keyed as in the guide. */
export const palette: BrandPalette = raw.palette;

/** Resolve a palette name to its hex value, e.g. `hex("navy")` -> "1C2453". */
export function hex(name: PaletteName): string {
  return palette[name];
}

const up = (name: PaletteName): string => palette[name].toUpperCase();

/** Every colour the deck may put on a slide: the whole palette, nothing else. */
export function deckPalette(): Set<string> {
  return new Set(Object.values(palette).map((value) => value.toUpperCase()));
}

/** Inks a text run may use. A fill in any other colour is not a text colour. */
export const TEXT_INKS: ReadonlySet<string> = new Set(
  raw.contrast.textInks.map((name) => up(name as PaletteName)),
);

/** Fills that may never carry text (they are accent marks, not backgrounds). */
export const GRAPHICS_ONLY: ReadonlySet<string> = new Set(
  raw.contrast.graphicsOnly.map((name) => up(name as PaletteName)),
);

export type SafePair = { text: PaletteName; background: PaletteName; ratio: number };

/**
 * The six legal text/background combinations, with their live contrast ratios.
 * Generated from the token palette so a palette edit re-derives the matrix.
 */
export const SAFE_PAIRS: SafePair[] = raw.contrast.safePairs.map((pair) => {
  const text = pair.text as PaletteName;
  const background = pair.background as PaletteName;
  return { text, background, ratio: Number(contrastRatio(up(text), up(background)).toFixed(2)) };
});

export type ForbiddenPair = { text: PaletteName; background: PaletteName };

/**
 * Combinations the guide names as forbidden, e.g. navy on electric blue or any
 * text on a light fill. Exposed so a test can assert each one actually fails.
 */
export const FORBIDDEN_PAIRS: ForbiddenPair[] = raw.contrast.forbiddenPairs.map((pair) => ({
  text: pair.text as PaletteName,
  background: pair.background as PaletteName,
}));

/**
 * Fail loudly on a malformed token file rather than emitting an invalid colour.
 * Runs once at import; a bad value is a build error, not a broken deck.
 */
export function validateTokens(): void {
  const isHex = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9A-Fa-f]{6}$/.test(value);
  for (const [name, value] of Object.entries(palette)) {
    if (!isHex(value)) throw new Error(`aionos.tokens.json palette.${name} is not a hex colour`);
  }
  for (const [name, value] of Object.entries(raw.fonts)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`aionos.tokens.json fonts.${name} is empty`);
    }
  }
  for (const [group, values] of Object.entries(raw.chartSeries)) {
    if (group === "$comment") continue;
    if (!Array.isArray(values) || values.length === 0 || !values.every(isHex)) {
      throw new Error(`aionos.tokens.json chartSeries.${group} must be non-empty hex values`);
    }
  }
  // Every declared safe pair must actually clear the required ratio.
  for (const pair of SAFE_PAIRS) {
    if (pair.ratio < raw.contrast.minRatio) {
      throw new Error(
        `aionos.tokens.json safe pair ${pair.text} on ${pair.background} is ${pair.ratio}:1, below ${raw.contrast.minRatio}:1`,
      );
    }
  }
}

validateTokens();
