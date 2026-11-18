/**
 * Design system for the PowerPoint deck: one palette, one type scale, one set of
 * margins. The renderer reads every size and colour from here, so a redesign or
 * a rebrand is an edit to this file rather than a hunt through the slide code.
 *
 * Colours are six-digit hex without a leading "#" because that is what PptxGenJS
 * expects; the shared `theme.ts` keeps its own "#RRGGBB" values for the DOCX and
 * PDF writers.
 *
 * Fonts default to Calibri because brand fonts are often not installed on the
 * machine that opens the file, and PowerPoint would silently substitute a font
 * with different metrics and break every fitted box.
 */
export const DECK_THEME = {
  colors: {
    navy: "0B1F3A",
    blue: "1F5C8B",
    teal: "12A5A0",
    amber: "F2A93B",
    coral: "E4572E",
    slate: "5B6B7C",
    light: "F5F8FA",
    white: "FFFFFF",
    border: "D7DEE6",
    /** Illuminating ink on the dark cover/divider/closing slides. */
    onDark: "FFFFFF",
    onDarkMuted: "C3D0DC",
  },
  /** Series order for every chart; the first series is always the blue. */
  chartSeries: ["1F5C8B", "12A5A0", "F2A93B", "E4572E", "5B6B7C"],
  fonts: {
    heading: "Calibri",
    body: "Calibri",
    /** Chart text uses the theme font so a viewer without Calibri still aligns. */
    chart: "+mn-lt",
  },
  type: {
    title: 28,
    titleMin: 22,
    body: 16,
    /** Never below this except sources, captions and footers. */
    bodyMin: 12,
    bodyMax: 18,
    table: 12,
    tableHeader: 12,
    kpiValue: 40,
    kpiLabel: 13,
    closing: 22,
    caption: 10,
    tag: 11,
  },
  /** Inches. LAYOUT_WIDE is 13.333 x 7.5. */
  geometry: {
    width: 13.333,
    height: 7.5,
    margin: 0.6,
    tagY: 0.34,
    titleY: 0.7,
    titleH: 0.85,
    ruleY: 1.62,
    bodyTop: 1.92,
    bodyBottom: 6.5,
    footerY: 7.02,
    sourceY: 6.68,
    gap: 0.32,
    cardRadius: 0.12,
  },
  /**
   * Product/behaviour switches. `sourceLine` and `sourcesSlide` are off because
   * the deck is client-facing and carries the argument only; the trace and the
   * DOCX/PDF exports hold provenance. Turn them on if a client asks for a
   * referenced deck.
   */
  config: {
    showSourceLine: false,
    includeSourcesSlide: false,
    showTemplateFooter: true,
    footer: "Confidential · prepared for the client",
    wordmark: "AIONOS",
    maxTableRows: 6,
    maxTableCols: 4,
    maxKpiCards: 4,
    maxFlowSteps: 4,
    maxTimelineItems: 5,
    maxTableWordsPerCell: 20,
  },
} as const;

export type DeckTheme = typeof DECK_THEME;
export type DeckConfig = {
  showSourceLine?: boolean;
  includeSourcesSlide?: boolean;
  showTemplateFooter?: boolean;
  footer?: string;
  wordmark?: string;
  fonts?: { heading?: string; body?: string };
  locale?: string;
};

/** The renderer's effective configuration: theme defaults plus per-export overrides. */
export type ResolvedDeckConfig = {
  showSourceLine: boolean;
  includeSourcesSlide: boolean;
  showTemplateFooter: boolean;
  footer: string;
  wordmark: string;
  headingFont: string;
  bodyFont: string;
};

export function resolveDeckConfig(config: DeckConfig = {}): ResolvedDeckConfig {
  return {
    showSourceLine: config.showSourceLine ?? DECK_THEME.config.showSourceLine,
    includeSourcesSlide: config.includeSourcesSlide ?? DECK_THEME.config.includeSourcesSlide,
    showTemplateFooter: config.showTemplateFooter ?? DECK_THEME.config.showTemplateFooter,
    footer: config.footer ?? DECK_THEME.config.footer,
    wordmark: config.wordmark ?? DECK_THEME.config.wordmark,
    headingFont: config.fonts?.heading ?? DECK_THEME.fonts.heading,
    bodyFont: config.fonts?.body ?? DECK_THEME.fonts.body,
  };
}
