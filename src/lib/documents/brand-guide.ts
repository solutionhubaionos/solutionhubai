/**
 * The Aionos brand kit as data, so the deck agent and the renderer share one
 * source of truth. The agent writes content only; the renderer applies the
 * style. Nothing here invents colours or fonts - the values are the kit.
 *
 * The guide text below is the operational subset of the brand guide (voice,
 * naming, layout enum and rhythm, charts, logo, content rules, self-check) and
 * is prepended to the planner/writer/critic system prompts.
 */

export const AIONOS_TOKENS = {
  aionos_navy: "1C2453",
  electric_blue: "2148FB",
  deep_navy: "030C44",
  pearl: "F5F4F1",
  mist: "D2D7E2",
  light_grey: "EDEDED",
  soft_blue: "BAD6FF",
  warm_clay: "FFAF75",
  electric_cyan: "00ECFF",
  white: "FFFFFF",
} as const;

export type Surface = "cover" | "light" | "navy" | "blue" | "closing";

/** The brand's own writing/voice/content contract. Keep it short and operational. */
export const AIONOS_AGENT_GUIDE = [
  "Aionos brand kit (hard constraints).",
  "Voice: clarity of an expert, responsibility of a trusted partner, confidence to own outcomes. Confident, human, matter-of-fact, plain language, point first, active voice.",
  "Headlines: sentence case, at most ~10 words, a finding not a topic ('Turnaround time fell 18% after rollout', never 'Results'). Bullets: at most 5 per slide, at most ~15 words each.",
  'Naming: write "Aionos" (title case) in all body copy. Use "AIONOS" only for headlines/signage. Never write "AionOS".',
  "Avoid: jargon, exaggeration, unsupported claims, hype words (revolutionary, cutting-edge, game-changing, seamless, unleash, supercharge), and technical complexity without explanation.",
  "Grounded: evidence over claims. Every claim needs a number, source or example from the retrieved passages; no evidence, no claim.",
  "Layout enum and background rhythm: COVER (gradient title) first, then alternate LIGHT and NAVY, with BLUE for at most two section dividers or one key-message slide, and CLOSING (deep navy) last. Never three consecutive slides on the same background. Charts, tables and dense content are always LIGHT; statements, quotes, outcomes and summaries are NAVY.",
  "Charts: use only real, sourced numbers; if there is no real number, do not make a chart. Label axes and units and prefer direct labels over a legend.",
  "Imagery: real people and work environments only. Never generic futuristic AI visuals (robots, glowing brains, circuit art). If no authentic image exists, use none.",
  "Content hard rules: never name any other client, company or deck source - anonymise except for the current target. Content is for the current client, URL and sector only. Never print citation numbers in prose; source ids live in the slide's sources field.",
  "Self-check before returning: every slide has a valid layout; headlines are findings, sentence case, active voice; no hype words, no unsupported claims, no other-client names; 'Aionos' is title case; the client logo is slide 1 only; charts use real data; text/background pairs are legible.",
].join(" ");

/** Chart series by surface. Electric blue fails contrast on navy, so it moves last there. */
export const CHART_SERIES_LIGHT = [
  AIONOS_TOKENS.electric_blue,
  AIONOS_TOKENS.aionos_navy,
  AIONOS_TOKENS.electric_cyan,
  AIONOS_TOKENS.warm_clay,
  AIONOS_TOKENS.soft_blue,
  AIONOS_TOKENS.mist,
];

export const CHART_SERIES_NAVY = [
  AIONOS_TOKENS.electric_cyan,
  AIONOS_TOKENS.soft_blue,
  AIONOS_TOKENS.warm_clay,
  AIONOS_TOKENS.white,
  AIONOS_TOKENS.mist,
  AIONOS_TOKENS.pearl,
];

/** Which surface a content layout wants, before the rhythm pass. */
export function surfaceForLayout(layout: string): Surface {
  switch (layout) {
    case "table-compact":
    case "shortcomings-table":
    case "collaboration-pointers-table":
    case "chart-with-takeaway":
    case "kpi-cards":
    case "image-with-caption":
      return "light";
    case "section-divider":
      return "blue";
    case "next-steps-ask":
      return "closing";
    default:
      return "navy";
  }
}

/**
 * Assigns a surface to every slide following the kit's rhythm: never three
 * consecutive slides on the same background, and at most two BLUE slides.
 */
export function assignSurfaces(layouts: readonly string[]): Surface[] {
  const wanted = layouts.map(surfaceForLayout);
  const out: Surface[] = [];
  let blueUsed = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    let surface = wanted[index] ?? "navy";
    if (surface === "blue") {
      if (blueUsed >= 2) surface = "navy";
      else blueUsed += 1;
    }
    const a = out[index - 1];
    const b = out[index - 2];
    if (surface === a && surface === b && surface !== "cover" && surface !== "closing") {
      surface = surface === "navy" ? "light" : "navy";
    }
    out.push(surface);
  }
  return out;
}
