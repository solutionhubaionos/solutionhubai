/**
 * Design system for the PowerPoint deck, read from `aionos.tokens.json`. The
 * renderer reads every size and colour from here, so a rebrand is an edit to
 * the token file rather than a hunt through the slide code.
 *
 * Colours are six-digit hex without a leading "#" because that is what PptxGenJS
 * expects; the shared `theme.ts` keeps its own "#RRGGBB" values for the DOCX and
 * PDF writers.
 *
 * Fonts come from the guide's "For PPT & Word" pair (Century Gothic headings,
 * Aptos body). The token file is the only place to change them.
 */
import { TOKENS, palette } from "./tokens";

export const DECK_THEME = {
  colors: {
    /** Aionos navy: the background of every BLUE content slide. */
    navy: palette.navy,
    /** Electric blue: table headers, boxes and accents on a WHITE slide. */
    blue: palette.electricBlue,
    /** Soft blue: muted copy, connectors, dividers and gridlines. */
    teal: palette.softBlue,
    /** Warm clay: chart series, highlights, one accent per slide. */
    amber: palette.warmClay,
    coral: palette.warmClay,
    slate: palette.softBlue,
    /** Pearl: the fill of a box on a BLUE/deep-navy slide, and table banding. */
    light: palette.pearl,
    white: palette.white,
    border: palette.softBlue,
    /** All text on a dark slide is white. */
    onDark: palette.white,
    /** Secondary copy on a dark slide. */
    onDarkMuted: palette.softBlue,
  },
  /** Flat series order for the legacy renderer; the deck uses light/navy sets. */
  chartSeries: [...TOKENS.chartSeries.flat],
  fonts: {
    heading: TOKENS.fonts.deckHeading,
    body: TOKENS.fonts.deckBody,
    /** Chart text uses the body font so a viewer aligns with the slides. */
    chart: TOKENS.fonts.deckChart,
  },
  type: TOKENS.type,
  /** Inches. LAYOUT_WIDE is 13.333 x 7.5. */
  geometry: TOKENS.geometry,
  /**
   * Product/behaviour switches. `sourceLine` and `sourcesSlide` are off because
   * the deck is client-facing and carries the argument only; the trace and the
   * DOCX/PDF exports hold provenance. Turn them on if a client asks for a
   * referenced deck.
   */
  config: {
    showSourceLine: TOKENS.config.showSourceLine,
    includeSourcesSlide: TOKENS.config.includeSourcesSlide,
    showTemplateFooter: TOKENS.config.showTemplateFooter,
    footer: TOKENS.brand.footer,
    wordmark: TOKENS.brand.wordmark,
    maxTableRows: TOKENS.config.maxTableRows,
    maxTableCols: TOKENS.config.maxTableCols,
    maxKpiCards: TOKENS.config.maxKpiCards,
    maxFlowSteps: TOKENS.config.maxFlowSteps,
    maxTimelineItems: TOKENS.config.maxTimelineItems,
    maxTableWordsPerCell: TOKENS.config.maxTableWordsPerCell,
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
  /** The target client's logo, detected from its website; drawn on the cover. */
  clientLogo?: { dataUrl: string; light: boolean; aspect: number } | null;
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
