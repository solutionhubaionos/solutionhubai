/**
 * One place for the look of every export, read from `aionos.tokens.json`.
 * Renderers must read from here rather than hard-coding colours or fonts, so
 * DOCX, PDF and PPTX stay consistent and a rebrand is a single edit.
 *
 * Values are `#RRGGBB` for the PDF/DOCX writers; the deck theme keeps the same
 * colours without the hash because that is what PptxGenJS expects.
 */
import { TOKENS, palette } from "./tokens";

const hash = (value: string): string => `#${value}`;

export const DOCUMENT_THEME = {
  brand: {
    name: TOKENS.brand.name,
    wordmark: TOKENS.brand.wordmark,
    /** No logo file is bundled; the wordmark stands in on the cover. */
    logo: null as string | null,
  },
  colors: {
    /** Navy ink on the white PDF/DOCX page. */
    ink: hash(palette.navy),
    /** Electric blue accent. */
    accent: hash(palette.electricBlue),
    accentDark: hash(palette.deepNavy),
    accentSoft: hash(palette.softBlue),
    /** Secondary ink on the white PDF/DOCX page. */
    muted: hash(palette.navy),
    border: hash(palette.softBlue),
    surface: hash(palette.pearl),
    white: hash(palette.white),
    /** Warning ink for callouts, from the same closed palette. */
    warning: hash(palette.deepNavy),
  },
  /** Same brand marks as the deck so a chart looks the same in every export. */
  chartSeries: TOKENS.chartSeries.light.map(hash) as string[],
  fonts: {
    heading: TOKENS.fonts.documentHeading,
    body: TOKENS.fonts.documentBody,
    /** Standard 14 fonts, always available to the PDF writer. */
    pdfHeading: TOKENS.fonts.pdfHeading,
    pdfBody: TOKENS.fonts.pdfBody,
    pdfOblique: TOKENS.fonts.pdfOblique,
  },
  spacing: {
    /** A4 points. */
    pageMargin: 56,
    blockGap: 10,
    sectionGap: 22,
    tableCell: 6,
  },
  footer: "Confidential · prepared for the client",
};

export type DocumentTheme = typeof DOCUMENT_THEME;

/** #RRGGBB to the 0-1 tuple pdf-lib wants. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/** #RRGGBB to the six-hex string OOXML expects (no leading #). */
export function hexForOoxml(hex: string): string {
  return hex.replace("#", "").toUpperCase();
}

/** Long date used on covers and in footers. */
export function coverDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
