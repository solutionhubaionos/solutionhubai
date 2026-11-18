/**
 * Colour maths for brand extraction: hex normalisation, WCAG contrast, a
 * readable foreground choice, and a harmonious chart palette. Pure functions so
 * every rule can be tested without a browser.
 */

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc`, `abc`, `#AABBCC` -> `#AABBCC`, or null when it is not a hex colour. */
export function normaliseHex(value: string): string | null {
  const match = value.trim().match(HEX);
  if (!match?.[1]) return null;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : match[1];
  return `#${hex.toUpperCase()}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const normalised = normaliseHex(hex);
  if (!normalised) return null;
  return {
    r: Number.parseInt(normalised.slice(1, 3), 16),
    g: Number.parseInt(normalised.slice(3, 5), 16),
    b: Number.parseInt(normalised.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  hue = (hue * 60 + 360) % 360;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const saturation = Math.min(100, Math.max(0, s)) / 100;
  const lightness = Math.min(100, Math.max(0, l)) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [r1, g1, b1] =
    huePrime < 1
      ? [chroma, x, 0]
      : huePrime < 2
        ? [x, chroma, 0]
        : huePrime < 3
          ? [0, chroma, x]
          : huePrime < 4
            ? [0, x, chroma]
            : huePrime < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return rgbToHex({ r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 });
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

export const READABLE_INK = "#0B1F3A";
export const READABLE_LIGHT = "#FFFFFF";

/**
 * Picks the nearer of the two house inks that clears AA. When neither does (a
 * mid-tone background), keeps the better of the two rather than pretending.
 */
export function readableTextOn(background: string, minimum = 4.5): string {
  const light = contrastRatio(background, READABLE_LIGHT);
  const dark = contrastRatio(background, READABLE_INK);
  if (light >= minimum && light >= dark) return READABLE_LIGHT;
  if (dark >= minimum) return READABLE_INK;
  return light >= dark ? READABLE_LIGHT : READABLE_INK;
}

/** Lightens or darkens `hex` until it clears `minimum` against `background`. */
export function adjustForContrast(
  hex: string,
  background: string,
  minimum = 4.5,
): { color: string; adjusted: boolean } {
  const rgb = hexToRgb(hex);
  if (!rgb) return { color: READABLE_INK, adjusted: true };
  if (contrastRatio(hex, background) >= minimum)
    return { color: normaliseHex(hex) ?? hex, adjusted: false };

  const towardsLight = relativeLuminance(background) < 0.5;
  const hsl = rgbToHsl(rgb);
  for (let step = 1; step <= 20; step += 1) {
    const candidate = hslToHex({
      h: hsl.h,
      s: hsl.s,
      l: towardsLight ? Math.min(100, hsl.l + step * 4) : Math.max(0, hsl.l - step * 4),
    });
    if (contrastRatio(candidate, background) >= minimum)
      return { color: candidate, adjusted: true };
  }
  return { color: towardsLight ? READABLE_LIGHT : READABLE_INK, adjusted: true };
}

/** Saturation/lightness test used to keep near-greys out of the accent slots. */
export function isNeutral(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  const { s, l } = rgbToHsl(rgb);
  return s < 12 || l < 6 || l > 96;
}

/** Linear blend of two hex colours; ratio 0 returns `a`, 1 returns `b`. */
export function mixHex(a: string, b: string, ratio: number): string {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  if (!first || !second) return normaliseHex(a) ?? READABLE_INK;
  const t = Math.min(1, Math.max(0, ratio));
  return rgbToHex({
    r: first.r + (second.r - first.r) * t,
    g: first.g + (second.g - first.g) * t,
    b: first.b + (second.b - first.b) * t,
  });
}

/**
 * Six to eight harmonious series colours seeded from the brand's own accents,
 * then hue-rotated around the wheel at a fixed lightness so charts stay legible.
 */
export function deriveChartSeries(seed: readonly string[], count = 6): string[] {
  const usable = seed
    .map(normaliseHex)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isNeutral(value));
  const base = usable[0];
  const rgb = base ? hexToRgb(base) : null;
  if (!base || !rgb) {
    return ["#1F5C8B", "#12A5A0", "#F2A93B", "#E4572E", "#5B6B7C", "#2E7D6F"].slice(0, count);
  }

  const hsl = rgbToHsl(rgb);
  const series: string[] = [base];
  const step = Math.max(28, Math.round(300 / Math.max(2, count)));
  for (let index = 1; index < count; index += 1) {
    series.push(
      hslToHex({
        h: hsl.h + index * step,
        s: Math.max(38, Math.min(78, hsl.s)),
        l: Math.max(32, Math.min(56, hsl.l < 30 ? 42 : hsl.l)),
      }),
    );
  }
  return series;
}
