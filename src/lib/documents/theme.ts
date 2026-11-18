/**
 * One place for the look of every export. Renderers must read from here rather
 * than hard-coding colours or fonts, so DOCX, PDF and PPTX stay consistent and
 * a rebrand is a single edit.
 *
 * The default is deliberately neutral: near-black ink, one blue accent, light
 * grey surfaces. Fonts are chosen per format because Word, PowerPoint and the
 * PDF writer have different reliable families.
 */

const HOUSE_COLORS = {
  /** Navy ink on the white PDF/DOCX page. */
  ink: "#1C2453",
  /** Electric blue accent. */
  accent: "#2148FB",
  accentDark: "#030C44",
  accentSoft: "#BAD6FF",
  muted: "#4B5573",
  border: "#D2D7E2",
  surface: "#F5F4F1",
  white: "#FFFFFF",
  success: "#0E7C66",
  warning: "#B45309",
  danger: "#B42318",
  /** Chart series for the light document page (readable on white). */
  teal: "#0E7C66",
  amber: "#B45309",
  coral: "#7A1022",
  slate: "#5B6B7C",
  navy: "#1C2453",
};

const HOUSE_FONTS = {
  heading: "Aptos",
  body: "Aptos",
  /** Serif headlines over sans copy; both ship with Office and Google Slides. */
  deckHeading: "Georgia",
  deckBody: "Aptos",
  /** Standard 14 fonts, always available to the PDF writer. */
  pdfHeading: "Helvetica-Bold",
  pdfBody: "Helvetica",
  pdfOblique: "Helvetica-Oblique",
};

const HOUSE_SERIES = ["#2148FB", "#0E7C66", "#B45309", "#7A1022", "#5B6B7C"];

export const DOCUMENT_THEME = {
  brand: {
    name: "Aionos",
    wordmark: "AIONOS",
    /** No logo file is bundled; the wordmark stands in on the cover. */
    logo: null as string | null,
  },
  colors: { ...HOUSE_COLORS },
  /** Same order as the deck palette so a chart looks the same in every export. */
  chartSeries: [...HOUSE_SERIES] as string[],
  fonts: { ...HOUSE_FONTS },
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
