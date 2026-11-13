/**
 * One place for the look of every export. Renderers must read from here rather
 * than hard-coding colours or fonts, so DOCX, PDF and PPTX stay consistent and
 * a rebrand is a single edit.
 *
 * The default is deliberately neutral: near-black ink, one blue accent, light
 * grey surfaces. Fonts are chosen per format because Word, PowerPoint and the
 * PDF writer have different reliable families.
 */
export const DOCUMENT_THEME = {
  brand: {
    name: "Solution Hub",
    wordmark: "SOLUTION HUB",
    /** No logo file is bundled; the wordmark stands in on the cover. */
    logo: null as string | null,
  },
  colors: {
    ink: "#0F1E33",
    accent: "#1F5C8B",
    accentDark: "#163F60",
    accentSoft: "#E8F0F6",
    muted: "#5B6B7C",
    border: "#D7DEE6",
    surface: "#F5F8FA",
    white: "#FFFFFF",
    success: "#1E7A5A",
    warning: "#B45309",
    danger: "#B42318",
  },
  fonts: {
    heading: "Calibri",
    body: "Calibri",
    /** Serif headlines over sans copy; both ship with Office and Google Slides. */
    deckHeading: "Georgia",
    deckBody: "Calibri",
    /** Standard 14 fonts, always available to the PDF writer. */
    pdfHeading: "Helvetica-Bold",
    pdfBody: "Helvetica",
    pdfOblique: "Helvetica-Oblique",
  },
  spacing: {
    /** A4 points. */
    pageMargin: 56,
    blockGap: 10,
    sectionGap: 22,
    tableCell: 6,
  },
  footer: "Confidential · prepared from the Solution Hub library",
} as const;

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
