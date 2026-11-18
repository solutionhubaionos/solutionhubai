/**
 * Colour maths shared by the brand layer: hex normalisation for the logo
 * pipeline and the WCAG contrast ratio. The brand's palette and the allowed
 * text colours live in `aionos.tokens.json`; nothing here picks a brand colour.
 */

export type Rgb = { r: number; g: number; b: number };

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
