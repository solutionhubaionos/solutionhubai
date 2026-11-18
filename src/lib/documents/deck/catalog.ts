/**
 * The slide catalogue: what each planner layout is for and the hard shape it
 * will accept. The planner picks a layout, the writer must fill that exact
 * shape, and the renderer draws it. Capacities are code limits, not prompt
 * requests, so overflow is refused before it can become a "(continued)" slide.
 */
import { z } from "zod";
import { PLANNER_LAYOUTS, type PlannerLayoutId } from "./types";

export type LayoutSpec = {
  id: PlannerLayoutId;
  when: string;
  /** Human-readable capacity, used in the planner/writer prompts only. */
  capacity: string;
};

export const LAYOUT_CATALOGUE: LayoutSpec[] = [
  {
    id: "section-divider",
    when: "Open a new movement in the story. Use at most twice.",
    capacity: "label (3-8 words), optional statement (one sentence).",
  },
  {
    id: "context-bullets",
    when: "Set out the situation, the insight or the ask in words.",
    capacity: "2-4 bullets, each at most 16 words.",
  },
  {
    id: "kpi-cards",
    when: "Two to four sourced numbers carry the argument.",
    capacity: "2-4 cards, each a label and one claim id.",
  },
  {
    id: "partner-hub",
    when: "Two or more parties each own a leg of the proposition.",
    capacity: "one centre label, 2-6 spokes with a role.",
  },
  {
    id: "two-column-compare",
    when: "Two options, two routes or two operating models.",
    capacity: "two headings and 2-4 points per side.",
  },
  {
    id: "table-compact",
    when: "Three columns of short facts, such as offer lines or phases.",
    capacity: "2-3 columns, at most 5 rows, 18 words per cell.",
  },
  {
    id: "process-roadmap",
    when: "A delivery sequence with three to five steps.",
    capacity: "3-5 steps with a short detail line.",
  },
  {
    id: "chart-with-takeaway",
    when: "A sourced chart makes the point and needs one sentence of meaning.",
    capacity: "one chart from claim ids plus a one-sentence takeaway.",
  },
  {
    id: "before-after",
    when: "Show the change from today to the proposed state.",
    capacity: "two headings and 2-4 points per side.",
  },
  {
    id: "shortcomings-table",
    when: "Name the real risks, dependencies or open items as a table.",
    capacity: "2-3 columns, at most 5 rows.",
  },
  {
    id: "collaboration-pointers-table",
    when: "Who does what across the parties.",
    capacity: "2-3 columns, at most 5 rows.",
  },
  {
    id: "image-with-caption",
    when: "A library image (site, asset, product) carries the point.",
    capacity: "one caption and a source note.",
  },
  {
    id: "next-steps-ask",
    when: "Close with the decision requested and the first actions.",
    capacity: "one ask, 1-4 steps with an owner or timing.",
  },
  {
    id: "maturity-progression",
    when: "Capability grows through ordered stages, as in a data-maturity or operating-model journey.",
    capacity: "3-5 stages, each a short label and one descriptor; optional current and target stage.",
  },
  {
    id: "three-horizon",
    when: "The plan splits into now, next and later with different outcomes in each.",
    capacity: "exactly 3 horizons, each a label, one description and 1-4 outcomes.",
  },
  {
    id: "layered-architecture",
    when: "A platform or operating model has stacked layers, from experience down to data.",
    capacity: "3-5 layers, each a label and 2-5 components.",
  },
];

export function catalogueForPrompt(): string {
  return LAYOUT_CATALOGUE.map(
    (entry) => `- ${entry.id}: ${entry.when} Capacity: ${entry.capacity}`,
  ).join("\n");
}

export function layoutSpec(id: PlannerLayoutId): LayoutSpec {
  return LAYOUT_CATALOGUE.find((entry) => entry.id === id) ?? LAYOUT_CATALOGUE[1]!;
}

export function isPlannerLayout(value: unknown): value is PlannerLayoutId {
  return typeof value === "string" && (PLANNER_LAYOUTS as readonly string[]).includes(value);
}

const CLAIM_ID = /^CL-\d{1,4}$/;
const BANNED_HEADER =
  /(^|\b)(evidence|evid\.?|refs?|references?|sources?|citations?|chunks?|documented capability|what the library documents)(\b|$)/i;

const claimId = z.string().trim().regex(CLAIM_ID, "claim ids look like CL-1");
const shortText = z.string().trim().min(2).max(180);
const pointText = z.string().trim().min(2).max(140);
const points = z.array(pointText).min(2).max(4);
const bullet = z.object({
  text: z.string().trim().min(3).max(170),
  claimIds: z.array(claimId).max(3).default([]),
});
const tableBase = z.object({
  headers: z.array(z.string().trim().min(2).max(40)).min(2).max(3),
  rows: z
    .array(z.array(z.string().trim().max(120)).min(2).max(3))
    .min(1)
    .max(5),
});

/** Table rules a discriminated-union member cannot express; checked in code. */
export function tableProblem(table: { headers: string[]; rows: string[][] }): string | null {
  if (table.headers.some((header) => BANNED_HEADER.test(header))) {
    return "table headers must describe content, not evidence or sources";
  }
  if (table.rows.some((row) => row.length !== table.headers.length)) {
    return "every table row must have exactly one cell per header";
  }
  return null;
}

const twoColumn = z.object({
  left: z.object({ heading: shortText, points }),
  right: z.object({ heading: shortText, points }),
});

export const DeckContentSchema = z.discriminatedUnion("layout", [
  z.object({
    layout: z.literal("section-divider"),
    label: z.string().trim().min(3).max(60),
    statement: z.string().trim().max(160).optional(),
  }),
  z.object({ layout: z.literal("context-bullets"), bullets: z.array(bullet).min(2).max(4) }),
  z.object({
    layout: z.literal("kpi-cards"),
    cards: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(60),
          claimId,
          note: z.string().trim().max(90).optional(),
        }),
      )
      .min(2)
      .max(4),
  }),
  z.object({
    layout: z.literal("partner-hub"),
    centre: shortText,
    spokes: z
      .array(
        z.object({
          entity: z.string().trim().min(2).max(60),
          role: z.string().trim().min(3).max(120),
          claimIds: z.array(claimId).max(3).default([]),
          inferred: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(6),
  }),
  z.object({ layout: z.literal("two-column-compare"), ...twoColumn.shape }),
  z.object({ layout: z.literal("before-after"), ...twoColumn.shape }),
  z.object({ layout: z.literal("table-compact"), ...tableBase.shape }),
  z.object({ layout: z.literal("shortcomings-table"), ...tableBase.shape }),
  z.object({ layout: z.literal("collaboration-pointers-table"), ...tableBase.shape }),
  z.object({
    layout: z.literal("process-roadmap"),
    steps: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(60),
          detail: z.string().trim().max(130).optional(),
        }),
      )
      .min(3)
      .max(5),
  }),
  z.object({
    layout: z.literal("chart-with-takeaway"),
    chart: z.object({
      kind: z.enum(["bar", "doughnut", "line", "range"]),
      title: z.string().trim().min(3).max(80),
      unit: z.string().trim().max(30).optional(),
      series: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(40),
            points: z
              .array(z.object({ label: z.string().trim().min(1).max(40), claimId }))
              .min(2)
              .max(8),
          }),
        )
        .min(1)
        .max(3),
    }),
    takeaway: z.string().trim().min(10).max(220),
  }),
  z.object({
    layout: z.literal("image-with-caption"),
    caption: z.string().trim().min(5).max(180),
    sourceNote: z.string().trim().max(120),
    imageId: z.string().trim().max(80).optional(),
  }),
  z.object({
    layout: z.literal("next-steps-ask"),
    ask: z.string().trim().min(5).max(160),
    steps: z
      .array(
        z.object({
          text: z.string().trim().min(3).max(120),
          owner: z.string().trim().max(60).optional(),
          when: z.string().trim().max(40).optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.object({
    layout: z.literal("maturity-progression"),
    stages: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(40),
          descriptor: z.string().trim().max(120).optional(),
        }),
      )
      .min(3)
      .max(5),
    currentStage: z.number().int().min(0).max(4).optional(),
    targetStage: z.number().int().min(0).max(4).optional(),
  }),
  z.object({
    layout: z.literal("three-horizon"),
    horizons: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(40),
          description: z.string().trim().min(5).max(140),
          outcomes: z.array(z.string().trim().min(3).max(70)).min(1).max(4),
        }),
      )
      .length(3),
  }),
  z.object({
    layout: z.literal("layered-architecture"),
    layers: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(40),
          items: z.array(z.string().trim().min(2).max(50)).min(2).max(5),
        }),
      )
      .min(3)
      .max(5),
  }),
]);

export function contentSchemaFor(layout: PlannerLayoutId) {
  const index: Record<PlannerLayoutId, number> = {
    "section-divider": 0,
    "context-bullets": 1,
    "kpi-cards": 2,
    "partner-hub": 3,
    "two-column-compare": 4,
    "before-after": 5,
    "table-compact": 6,
    "shortcomings-table": 7,
    "collaboration-pointers-table": 8,
    "process-roadmap": 9,
    "chart-with-takeaway": 10,
    "image-with-caption": 11,
    "next-steps-ask": 12,
    "maturity-progression": 13,
    "three-horizon": 14,
    "layered-architecture": 15,
  };
  return DeckContentSchema.options[index[layout]]!;
}

const actionTitle = z
  .string()
  .trim()
  .min(12)
  .max(110)
  .refine((value) => value.split(/\s+/).filter(Boolean).length <= 14, {
    message: "an action title is at most 14 words",
  });

export const DeckPlanSlideSchema = z.object({
  layout: z.enum(PLANNER_LAYOUTS),
  actionTitle,
  purpose: z.string().trim().max(180),
  evidenceRefs: z.array(z.string().trim().max(40)).max(10).default([]),
  tier: z.enum(["sourced", "inferred", "illustrative"]).default("sourced"),
});

export const DeckPlanSchema = z.object({
  deckTitle: z.string().trim().min(3).max(120),
  audience: z.string().trim().max(80),
  storyline: z.string().trim().min(10).max(600),
  slides: z.array(DeckPlanSlideSchema).min(6).max(10),
});

export const DeckWriterSchema = z.object({
  // Shape is validated by `contentSchemaFor` AFTER `fitContent` clamps copy to
  // the layout limits, so an over-long sentence does not reject the slide.
  content: z.object({ layout: z.enum(PLANNER_LAYOUTS) }).passthrough(),
  notes: z.string().trim().max(900).default(""),
  // The writer truncates this to 120 characters. Accepting a longer note here
  // keeps one over-long footnote from discarding an otherwise valid slide.
  sourceNote: z.string().trim().max(400).optional(),
});

export const CriticSchema = z.object({
  flagged: z
    .array(z.object({ index: z.number().int().min(0).max(20), reason: z.string().trim().max(200) }))
    .max(10)
    .default([]),
});

export const TABLE_HEADER_REJECT = BANNED_HEADER;
