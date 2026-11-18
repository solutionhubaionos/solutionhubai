/**
 * The Aionos brand kit as data, so the deck agent and the renderer share one
 * source of truth. The agent writes content only; the renderer applies the
 * style. Nothing here invents colours or fonts - the values are the kit.
 *
 * The guide text below is the operational subset of the brand guide (voice,
 * naming, layout enum and rhythm, charts, logo, content rules, self-check) and
 * is prepended to the planner/writer/critic system prompts.
 */

import { TOKENS, palette, type PaletteName } from "./tokens";

/** The brand palette under the guide's own names, read from the token file. */
export const AIONOS_TOKENS = {
  aionos_navy: palette.navy,
  electric_blue: palette.electricBlue,
  deep_navy: palette.deepNavy,
  pearl: palette.pearl,
  soft_blue: palette.softBlue,
  warm_clay: palette.warmClay,
  white: palette.white,
} as const;

export type Surface = "cover" | "light" | "navy" | "blue" | "closing";

/** The token key that names each surface's background. */
export const SURFACE_BACKGROUND: Record<Surface, PaletteName> = {
  cover: TOKENS.surfaces.cover as PaletteName,
  light: TOKENS.surfaces.light as PaletteName,
  navy: TOKENS.surfaces.navy as PaletteName,
  blue: TOKENS.surfaces.blue as PaletteName,
  closing: TOKENS.surfaces.closing as PaletteName,
};

/** The brand's own writing/voice/content contract. Keep it short and operational. */
export const AIONOS_AGENT_GUIDE = [
  "Aionos brand kit (hard constraints).",
  "Voice: clarity of an expert, responsibility of a trusted partner, confidence to own outcomes. Confident, human, matter-of-fact, plain language, point first, active voice.",
  "Headlines: sentence case, at most ~10 words, a finding not a topic ('Turnaround time fell 18% after rollout', never 'Results'). Bullets: at most 5 per slide, at most ~15 words each.",
  'Naming: write "Aionos" (title case) in all body copy. Use "AIONOS" only for headlines/signage. Never write "AionOS".',
  "Avoid: jargon, exaggeration, unsupported claims, hype words (revolutionary, cutting-edge, game-changing, seamless, unleash, supercharge), and technical complexity without explanation.",
  "Grounded: evidence over claims. Every claim needs a number, source or example from the retrieved passages; no evidence, no claim.",
  "Background rhythm: COVER (deep navy) first, then content slides alternate BLUE (aionos navy) and WHITE strictly, never two of the same in a row, with CLOSING (deep navy) last. Charts, tables, KPI cards and images are always WHITE; statements, quotes, outcomes and summaries are BLUE.",
  "Colour: the only colours are aionos navy, deep navy, electric blue, warm clay, pearl, soft blue and white. On a WHITE slide, boxes, table headers and borders are electric blue with white text; body text is deep navy; the eyebrow label is electric blue. On a BLUE slide, every box or border is white or pearl with deep navy text; text is white; the eyebrow label is soft blue. Never navy boxes with light text.",
  "Charts: use only real, sourced numbers; if there is no real number, do not make a chart. Label axes and units and prefer direct labels over a legend. No chart of two identical placeholder values.",
  "Imagery: real people and work environments only. Never generic futuristic AI visuals (robots, glowing brains, circuit art). If no authentic image exists, use none.",
  "Content hard rules: never name any other client, company or deck source - anonymise except for the current target. Content is for the current client, URL and sector only. Never print citation numbers in prose; source ids live in the slide's sources field.",
  "Self-check before returning: every slide has a valid layout; headlines are findings, sentence case, active voice; no hype words, no unsupported claims, no other-client names; 'Aionos' is title case; the client logo is slide 1 only; charts use real data; text/background pairs are legible.",
].join(" ");

/** Chart series by surface, read from the token file. */
export const CHART_SERIES_LIGHT = [...TOKENS.chartSeries.light];
export const CHART_SERIES_NAVY = [...TOKENS.chartSeries.navy];

/** Layouts that must sit on a WHITE slide (charts, tables, KPI cards, images). */
const WHITE_LAYOUTS = new Set([
  "table-compact",
  "shortcomings-table",
  "collaboration-pointers-table",
  "chart-with-takeaway",
  "kpi-cards",
  "image-with-caption",
]);

/** The surface a layout wants before the rhythm pass. */
export function surfaceForLayout(layout: string): Surface {
  if (layout === "next-steps-ask") return "closing";
  return WHITE_LAYOUTS.has(layout) ? "light" : "navy";
}

/**
 * The rhythm pass. Content slides alternate BLUE (navy) and WHITE strictly,
 * with the closing slide deep navy and last. Charts/tables prefer WHITE; the
 * start colour is chosen so as many of them as possible land on a white slide.
 * Never returns two adjacent content slides on the same colour.
 */
export function assignSurfaces(layouts: readonly string[]): Surface[] {
  const build = (firstLight: boolean): Surface[] =>
    layouts.map((layout, index) => {
      if (layout === "next-steps-ask") return "closing" as Surface;
      const isLight = firstLight ? index % 2 === 0 : index % 2 === 1;
      return (isLight ? "light" : "navy") as Surface;
    });

  const wantsWhite = (index: number): boolean => WHITE_LAYOUTS.has(layouts[index] ?? "");
  const conflicts = (surfaces: Surface[]): number =>
    surfaces.reduce(
      (total, surface, index) => total + (wantsWhite(index) && surface !== "light" ? 1 : 0),
      0,
    );

  const navyFirst = build(false);
  const lightFirst = build(true);
  return conflicts(navyFirst) <= conflicts(lightFirst) ? navyFirst : lightFirst;
}
