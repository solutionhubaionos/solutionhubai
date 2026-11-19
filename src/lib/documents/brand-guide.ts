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
  "Background rhythm: the deck opens on a white co-brand page and a deep-navy gradient title, then content pages run on white, with CLOSING (deep navy) last. Content never alternates surface and never uses a gradient of its own.",
  "Colour: the only colours are aionos navy, deep navy, electric blue, warm clay, pearl, soft blue and white. On a white content page, boxes, table headers and borders are electric blue with white text; body text is deep navy; the eyebrow label is electric blue. On the closing deep-navy page, text is white. Never navy boxes with light text.",
  "Charts: use only real, sourced numbers; if there is no real number, do not make a chart. Label axes and units and prefer direct labels over a legend. No chart of two identical placeholder values.",
  "Imagery: real people and work environments only. Never generic futuristic AI visuals (robots, glowing brains, circuit art). If no authentic image exists, use none.",
  "Content hard rules: never name any other client, company or deck source - anonymise except for the current target. Content is for the current client, URL and sector only. Never print citation numbers in prose; source ids live in the slide's sources field.",
  "Self-check before returning: every slide has a valid layout; headlines are findings, sentence case, active voice; no hype words, no unsupported claims, no other-client names; 'Aionos' is title case; the client logo is slide 1 only; charts use real data; text/background pairs are legible.",
].join(" ");

/** Chart series by surface, read from the token file. */
export const CHART_SERIES_LIGHT = [...TOKENS.chartSeries.light];
export const CHART_SERIES_NAVY = [...TOKENS.chartSeries.navy];

/**
 * The rhythm pass. The reference kit draws every content page on white and
 * closes on deep navy; only the closing slide changes surface.
 */
export function assignSurfaces(layouts: readonly string[]): Surface[] {
  return layouts.map((layout) => (layout === "next-steps-ask" ? "closing" : "light"));
}
