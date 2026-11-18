/**
 * Aionos contrast rules, enforced in code rather than by memory. The deck is
 * navy with white text; the only other legal text colour is navy, and only on a
 * light fill. Every chart/diagram/table accent colour is a graphics colour and
 * must never be used as a text run.
 */
import { contrastRatio } from "../brand/color";

export const PALETTE = {
  navy: "#1C2453",
  deepNavy: "#030C44",
  electricBlue: "#2148FB",
  cyan: "#00ECFF",
  clay: "#FFAF75",
  softBlue: "#BAD6FF",
  pearl: "#F5F4F1",
  mist: "#D2D7E2",
  lightGrey: "#EDEDED",
  white: "#FFFFFF",
} as const;

/** Backgrounds that may carry white text. */
const DARK_BACKDROPS = new Set<string>([
  PALETTE.navy,
  PALETTE.deepNavy,
  PALETTE.electricBlue,
]);

/** Light fills that may carry navy text. */
const LIGHT_BACKDROPS = new Set<string>([
  PALETTE.pearl,
  PALETTE.mist,
  PALETTE.lightGrey,
  PALETTE.softBlue,
  PALETTE.clay,
  PALETTE.cyan,
]);

/** Graphics-only colours: a text run in one of these is always a defect. */
const GRAPHICS_ONLY = new Set<string>([
  PALETTE.electricBlue,
  PALETTE.cyan,
  PALETTE.clay,
  PALETTE.softBlue,
  PALETTE.pearl,
  PALETTE.mist,
  PALETTE.lightGrey,
]);

function hex(value: string): string {
  return `#${value.replace("#", "").toUpperCase()}`;
}

export type ContrastVerdict = { ok: true } | { ok: false; reason: string };

/**
 * True when `text` on `background` is an allowed Aionos pair. When the
 * background is unknown (`null`), the pair is accepted if the text colour is
 * legal anywhere (white, or navy which is only used inside a light fill).
 */
export function checkTextPair(text: string, background: string | null): ContrastVerdict {
  const ink = hex(text);
  if (GRAPHICS_ONLY.has(ink)) {
    return { ok: false, reason: `${ink} is a graphics colour and cannot be text` };
  }
  if (ink !== PALETTE.white && ink !== PALETTE.navy) {
    return { ok: false, reason: `${ink} is not an allowed text colour` };
  }
  if (!background) {
    return { ok: true };
  }
  const bg = hex(background);
  if (ink === PALETTE.white) {
    if (LIGHT_BACKDROPS.has(bg)) {
      return { ok: false, reason: `white text on light fill ${bg}` };
    }
    if (contrastRatio(ink, bg) < 4.5) {
      return { ok: false, reason: `white on ${bg} is below 4.5:1` };
    }
    return { ok: true };
  }
  // Navy text is legal only on a light fill.
  if (DARK_BACKDROPS.has(bg)) {
    return { ok: false, reason: `navy text on dark background ${bg}` };
  }
  if (contrastRatio(ink, bg) < 4.5) {
    return { ok: false, reason: `navy on ${bg} is below 4.5:1` };
  }
  return { ok: true };
}
