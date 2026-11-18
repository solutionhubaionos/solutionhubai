/**
 * The deck content contract shared by the planner, the slide writer, the critic
 * and the PPTX renderer.
 *
 * Numbers never live in slide copy: a KPI card or chart point carries a claim
 * id, and the renderer resolves the value, unit and source from the claim
 * registry. That is what makes "every number is traceable" enforceable in code
 * rather than by prompt alone.
 */

export const PLANNER_LAYOUTS = [
  "section-divider",
  "context-bullets",
  "kpi-cards",
  "partner-hub",
  "two-column-compare",
  "table-compact",
  "process-roadmap",
  "chart-with-takeaway",
  "before-after",
  "shortcomings-table",
  "collaboration-pointers-table",
  "image-with-caption",
  "next-steps-ask",
  "maturity-progression",
  "three-horizon",
  "layered-architecture",
] as const;

export const LAYOUT_IDS = ["cover", ...PLANNER_LAYOUTS] as const;

export type PlannerLayoutId = (typeof PLANNER_LAYOUTS)[number];
export type LayoutId = (typeof LAYOUT_IDS)[number];

export type EvidenceTier = "sourced" | "inferred" | "illustrative";

export type Claim = {
  id: string;
  /** Short metric phrase, e.g. "proposal creation time". */
  metric: string;
  /** Exactly as written in the source, e.g. "−65%", "10–15%", "$1.40M". */
  valueText: string;
  valueMin: number | null;
  valueMax: number | null;
  unit: string | null;
  /** One sentence of surrounding context, without citation marks. */
  context: string;
  sourceTitle: string;
  sourceYear: string | null;
  chunkId: string | null;
  entityName: string | null;
  /**
   * Where the claim comes from. Library claims are the default; `public` marks a
   * fact reconciled from outside the library, which renders with an asterisk
   * and a source footnote so it is never mistaken for a library figure.
   */
  origin?: "library" | "public";
};

export type ClaimRegistry = Record<string, Claim>;

export type ChartPoint = { label: string; claimId: string };
export type DeckChartSeries = { name: string; points: ChartPoint[] };

export type DeckChart = {
  /** `range` draws a floating bar from the claim's min to its max. */
  kind: "bar" | "doughnut" | "line" | "range";
  title: string;
  unit?: string;
  series: DeckChartSeries[];
};

export type DeckBullet = { text: string; claimIds: string[] };

export type DeckSlideContent =
  | { layout: "section-divider"; label: string; statement?: string }
  | { layout: "context-bullets"; bullets: DeckBullet[] }
  | { layout: "kpi-cards"; cards: { label: string; claimId: string; note?: string }[] }
  | {
      layout: "partner-hub";
      centre: string;
      spokes: { entity: string; role: string; claimIds: string[]; inferred: boolean }[];
    }
  | {
      layout: "two-column-compare";
      left: { heading: string; points: string[] };
      right: { heading: string; points: string[] };
    }
  | {
      layout: "before-after";
      left: { heading: string; points: string[] };
      right: { heading: string; points: string[] };
    }
  | { layout: "table-compact"; headers: string[]; rows: string[][] }
  | { layout: "shortcomings-table"; headers: string[]; rows: string[][] }
  | { layout: "collaboration-pointers-table"; headers: string[]; rows: string[][] }
  | { layout: "process-roadmap"; steps: { label: string; detail?: string }[] }
  | { layout: "chart-with-takeaway"; chart: DeckChart; takeaway: string }
  | { layout: "image-with-caption"; caption: string; sourceNote: string; imageId?: string }
  | {
      layout: "next-steps-ask";
      ask: string;
      steps: { text: string; owner?: string; when?: string }[];
    }
  | {
      layout: "maturity-progression";
      /** Ordered stages, left to right. No numeric maturity scores: progression only. */
      stages: { label: string; descriptor?: string }[];
      /** Zero-based index of today's stage, when the evidence supports one. */
      currentStage?: number;
      /** Zero-based index of the proposed stage. */
      targetStage?: number;
    }
  | {
      layout: "three-horizon";
      /** Exactly three: now, next and later. */
      horizons: { label: string; description: string; outcomes: string[] }[];
    }
  | {
      layout: "layered-architecture";
      /** Top layer first; each layer names the components that sit in it. */
      layers: { label: string; items: string[] }[];
    };

export type DeckSpecSlide = {
  id: string;
  layout: LayoutId;
  /** A full-sentence claim, max 14 words. */
  actionTitle: string;
  purpose: string;
  tier: EvidenceTier;
  content: DeckSlideContent;
  /** Speaker notes: full references, hedging and talking points. */
  notes: string;
  /** Small client-facing footnote, e.g. "Source: Accor case study, 2024". */
  sourceNote?: string;
  /** Claims this slide resolves values from. */
  claimIds: string[];
  /** Passages supplied to the writer for this slide, for the source audit. */
  evidenceIds?: string[];
};

export type DeckSpec = {
  deckTitle: string;
  audience: string;
  /** Two or three sentences: the one argument of the deck. */
  storyline: string;
  slides: DeckSpecSlide[];
  claims: ClaimRegistry;
  /** Validated party names only; concepts never appear. */
  entities: string[];
  gaps: string[];
  warnings: string[];
};

/** Raw planner output, before the writer fills each slide. */
export type DeckPlanSlide = {
  layout: PlannerLayoutId;
  actionTitle: string;
  purpose: string;
  evidenceRefs: string[];
  tier: EvidenceTier;
};

export type DeckPlan = {
  deckTitle: string;
  audience: string;
  storyline: string;
  slides: DeckPlanSlide[];
};
