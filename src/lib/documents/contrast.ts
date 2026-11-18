/**
 * Aionos contrast rules, enforced in code rather than by memory. The allowed
 * text colours and the generated safe-pair matrix come from `aionos.tokens.json`
 * (see `tokens.ts`); this module turns them into a pass/fail verdict. A text run
 * in a fill colour (pearl, warm clay, ...) is always a defect, and any pair that
 * does not clear the ratio for its size is rejected.
 */
import { TEXT_INKS, SAFE_PAIRS, TOKENS, type PaletteName } from "./tokens";
import { contrastRatio } from "../brand/color";

/** #RRGGBB for every palette entry, keyed by name, for callers that want them. */
export const PALETTE: Record<PaletteName, string> = Object.fromEntries(
  Object.entries(TOKENS.palette).map(([name, value]) => [name, `#${value}`]),
) as Record<PaletteName, string>;

/** The generated safe-pair matrix, exposed for docs and tests. */
export { SAFE_PAIRS };

/** The minimum contrast ratio (WCAG AA for normal text) the tokens demand. */
export const MIN_CONTRAST = TOKENS.contrast.minRatio;

/** Minimum for large text (>= 18.66pt bold or >= 24pt), per WCAG AA. */
export const LARGE_CONTRAST = TOKENS.contrast.largeMin;

function up(value: string): string {
  return `#${value.replace("#", "").toUpperCase()}`;
}

export type ContrastVerdict = { ok: true } | { ok: false; reason: string };

/**
 * True when `text` on `background` may be legible under the brand rules.
 * `minRatio` defaults to the body minimum; pass `LARGE_CONTRAST` for large text.
 * An unknown background (`null`) only checks that the ink is a legal text colour.
 */
export function checkTextPair(
  text: string,
  background: string | null,
  minRatio: number = MIN_CONTRAST,
): ContrastVerdict {
  const ink = up(text);
  if (!TEXT_INKS.has(ink.slice(1))) {
    return { ok: false, reason: `${ink} is not an allowed text colour` };
  }
  if (!background) return { ok: true };
  const bg = up(background);
  const ratio = contrastRatio(ink, bg);
  if (ratio < minRatio) {
    return { ok: false, reason: `${ink} on ${bg} is ${ratio.toFixed(2)}:1, below ${minRatio}:1` };
  }
  return { ok: true };
}
