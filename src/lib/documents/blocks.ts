/**
 * Strict schemas for what the section model may return. The model never writes
 * prose into the renderers directly: it returns JSON with short source labels
 * (S1, S2) that this module maps back to the chunk ids the server supplied.
 */
import { z } from "zod";
import type { Block, SourceLabel } from "./types";

/**
 * A citation may arrive as an S-label, a passage number, or wrapped in prose
 * ("[S1]", "passage 2", "S1, S2"); models mix the formats even when the prompt
 * is explicit, and a formatting slip must not fail a whole section.
 */
const label = z.preprocess(
  (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return `S${Math.trunc(value)}`;
    if (typeof value === "string") {
      const match = /(\d{1,3})/.exec(value);
      if (match) return `S${Number.parseInt(match[1] ?? "", 10)}`;
    }
    return value;
  },
  z
    .string()
    .trim()
    .regex(/^S\d{1,3}$/, "source must be a label like S1")
    .transform((value) => value.toUpperCase()),
);

/** Advisory text is shortened, never a reason to reject a whole section. */
const clipped = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .transform((value) => value.slice(0, max));

/** Extra labels are noise, never a reason to lose a whole section. */
const sourceList = z.array(label).transform((values) => values.slice(0, 12));

const passageNumber = z.union([
  z.number().int().min(1).max(80),
  z
    .string()
    .trim()
    .regex(/^\d{1,3}$/)
    .transform((value) => Number.parseInt(value, 10)),
  // The model often copies S-labels into passageRefs; accept them there too.
  z
    .string()
    .trim()
    .regex(/^S\d{1,3}$/i)
    .transform((value) => Number.parseInt(value.slice(1), 10)),
]);

/** 1-based passage numbers; the model may cite these instead of S-labels. */
const passageRefs = z.array(passageNumber).max(12);

/**
 * Blocks accept either S-labels or passage numbers, and sources may be omitted
 * entirely: a model that emits no citation still parses, and resolveBlocks drops
 * the factual block rather than rendering an unsourced claim.
 */
const grounding = {
  sources: sourceList.default([]),
  passageRefs: passageRefs.optional(),
};

/** Merge declared S-labels with passage numbers, which mean the same thing. */
function labelsOf(block: GeneratedBlock): SourceLabel[] {
  const declared = "sources" in block ? (block.sources ?? []) : [];
  const refs = ("passageRefs" in block ? (block.passageRefs ?? []) : []).map(
    (value) => `S${value}`,
  );
  return [...new Set([...declared, ...refs])];
}

const listItem = z.object({
  text: clipped(320, 4),
  level: z.number().int().min(0).max(2).optional(),
  sources: sourceList.optional(),
});

export const generatedBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    // Models routinely omit the level; a heading is never worth failing a
    // whole section over.
    level: z.union([z.literal(2), z.literal(3)]).default(2),
    text: z.string().trim().min(2).max(140),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: clipped(1_400, 20),
    ...grounding,
  }),
  z.object({
    type: z.literal("bullet_list"),
    items: z
      .array(listItem)
      .min(2)
      .transform((items) => items.slice(0, 8)),
    ...grounding,
  }),
  z.object({
    type: z.literal("numbered_list"),
    items: z
      .array(listItem)
      .min(2)
      .transform((items) => items.slice(0, 8)),
    ...grounding,
  }),
  z.object({
    type: z.literal("table"),
    caption: clipped(200).optional(),
    headers: z
      .array(z.string().trim().min(1).max(60))
      .min(2)
      .transform((headers: string[]) => headers.slice(0, 6)),
    // A real table cell can carry a clause or two; 240 rejected valid tables and
    // cost the whole section. Bounded, but generous enough for sourced detail.
    rows: z
      .array(
        z
          .array(z.string().trim().max(400))
          .min(1)
          .transform((row) => row.slice(0, 6)),
      )
      .min(2)
      .transform((rows) => rows.slice(0, 10)),
    ...grounding,
  }),
  z.object({
    type: z.literal("metrics"),
    items: z
      .array(
        z.object({
          label: clipped(80, 2),
          value: clipped(60, 1),
          unit: clipped(20).optional(),
          context: clipped(220).optional(),
          // A metric without a usable citation is dropped in resolveBlocks; it
          // must not reject the whole section (models put prose here).
          source: label.optional(),
        }),
      )
      .min(1)
      .transform((items) => items.slice(0, 4)),
    ...grounding,
  }),
  z.object({
    type: z.literal("callout"),
    // Models routinely omit tone or invent one; a callout is never worth failing
    // a whole section over, so unknown values fall back to "info".
    tone: z
      .preprocess(
        (value) => (value === "warning" || value === "success" ? value : "info"),
        z.enum(["info", "warning", "success"]),
      )
      .default("info"),
    text: clipped(600, 8),
    ...grounding,
  }),
  z.object({
    type: z.literal("quote"),
    text: z.string().trim().min(20).max(600),
    attribution: clipped(120, 2),
    source: label.optional(),
    passageRefs: passageRefs.optional(),
  }),
  z.object({
    type: z.literal("timeline"),
    items: z
      .array(
        z.object({
          // Models regularly drop the label or timeframe; the resolve step
          // falls back rather than losing the whole timeline.
          label: clipped(80, 2).optional(),
          timeframe: clipped(60, 1).optional(),
          detail: clipped(300, 8).optional(),
          ...grounding,
        }),
      )
      .min(2)
      .transform((items) => items.slice(0, 6)),
    ...grounding,
  }),
  z.object({
    type: z.literal("comparison"),
    title: clipped(160).optional(),
    criteria: z
      .array(clipped(80, 2))
      .min(1)
      .transform((criteria) => criteria.slice(0, 6)),
    options: z
      .array(
        z.object({
          name: clipped(80, 2),
          values: z
            .array(clipped(160))
            .min(1)
            .transform((values) => values.slice(0, 6)),
        }),
      )
      .min(2)
      .transform((options) => options.slice(0, 4)),
    ...grounding,
  }),
]);

export type GeneratedBlock = z.infer<typeof generatedBlockSchema>;

export const sectionOutputSchema = z.object({
  blocks: z
    .array(generatedBlockSchema)
    .min(1)
    .transform((blocks) => blocks.slice(0, 12)),
  /** 2-4 sentences; used as PPTX speaker notes and kept in the trace. */
  speakerNotes: clipped(1_400).default(""),
  openItems: z.array(clipped(220, 3)).max(8).default([]),
});

export type SectionOutput = z.infer<typeof sectionOutputSchema>;

/** Model output wrapped in prose or a fence: take the outermost JSON object. */
export function extractJsonObject(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("section response contained no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function sourcesOf(block: GeneratedBlock): SourceLabel[] {
  const labels = labelsOf(block);
  switch (block.type) {
    case "heading":
      return [];
    case "metrics":
      return [
        ...new Set([
          ...block.items.flatMap((item) => (item.source ? [item.source] : [])),
          ...labels,
        ]),
      ];
    case "quote":
      return [...new Set([...(block.source ? [block.source] : []), ...labels])];
    case "timeline":
      return [...new Set([...labels, ...block.items.flatMap((item) => item.sources)])];
    default:
      return labels;
  }
}

/** Every label a block refers to, used to validate against supplied sources. */
export function blockLabels(block: GeneratedBlock): SourceLabel[] {
  return sourcesOf(block);
}

/**
 * Maps S-labels to real chunk ids. A block that cites a label the server never
 * issued is dropped rather than rendered with a dangling citation.
 */
export function resolveBlocks(
  blocks: readonly GeneratedBlock[],
  chunkIdByLabel: ReadonlyMap<string, string>,
): { blocks: Block[]; dropped: number; usedLabels: string[] } {
  const used = new Set<string>();
  const resolved: Block[] = [];

  const ids = (labels: readonly string[], required: boolean): string[] => {
    const mapped = labels
      .map((value) => chunkIdByLabel.get(value))
      .filter((value): value is string => Boolean(value));
    if (required && mapped.length === 0) return [];
    mapped.forEach((id) => used.add(id));
    return [...new Set(mapped)];
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        resolved.push({ type: "heading", level: block.level, text: block.text });
        break;
      case "paragraph": {
        const sources = ids(sourcesOf(block), true);
        if (sources.length === 0) continue;
        resolved.push({ type: "paragraph", text: block.text, sources });
        break;
      }
      case "bullet_list":
      case "numbered_list": {
        const sources = ids(sourcesOf(block), true);
        if (sources.length === 0) continue;
        const items = block.items.map((item) => {
          const own = item.sources ? ids(item.sources, false) : [];
          const merged = [...new Set([...(own.length > 0 ? own : sources), ...sources])];
          return item.level === undefined
            ? { text: item.text, sources: merged }
            : { text: item.text, level: item.level, sources: merged };
        });
        resolved.push({ type: block.type, items, sources });
        break;
      }
      case "table": {
        const sources = ids(sourcesOf(block), true);
        if (sources.length === 0) continue;
        resolved.push({
          type: "table",
          ...(block.caption ? { caption: block.caption } : {}),
          headers: block.headers,
          rows: block.rows,
          sources,
        });
        break;
      }
      case "metrics": {
        const sources = ids(sourcesOf(block), true);
        const items = block.items.flatMap((item) => {
          const [source] = item.source ? ids([item.source], false) : [];
          if (!source) return [];
          return [
            {
              label: item.label,
              value: item.value,
              ...(item.unit ? { unit: item.unit } : {}),
              ...(item.context ? { context: item.context } : {}),
              source,
            },
          ];
        });
        if (items.length === 0) continue;
        resolved.push({
          type: "metrics",
          items,
          sources: [...new Set([...sources, ...items.map((i) => i.source)])],
        });
        break;
      }
      case "callout": {
        const sources = ids(sourcesOf(block), true);
        if (sources.length === 0) continue;
        resolved.push({ type: "callout", tone: block.tone, text: block.text, sources });
        break;
      }
      case "quote": {
        const [source] = ids(sourcesOf(block), false);
        if (!source) continue;
        resolved.push({
          type: "quote",
          text: block.text,
          attribution: block.attribution,
          source,
        });
        break;
      }
      case "timeline": {
        const sources = ids(sourcesOf(block), true);
        const items = block.items.flatMap((item) => {
          // An item without its own citation inherits the block's, and a missing
          // label/timeframe/detail falls back rather than dropping the row.
          const own = item.sources ? ids(item.sources, false) : [];
          const itemSources = own.length > 0 ? own : sources;
          if (itemSources.length === 0) return [];
          const timeframe = item.timeframe?.trim() || item.label?.trim() || "Phase";
          return [
            {
              label: item.label?.trim() || timeframe,
              timeframe,
              detail: item.detail?.trim() || item.label?.trim() || timeframe,
              sources: itemSources,
            },
          ];
        });
        if (items.length === 0) continue;
        resolved.push({
          type: "timeline",
          items,
          sources: [...new Set([...sources, ...items.flatMap((i) => i.sources)])],
        });
        break;
      }
      case "comparison": {
        const sources = ids(sourcesOf(block), true);
        if (sources.length === 0) continue;
        resolved.push({
          type: "comparison",
          ...(block.title ? { title: block.title } : {}),
          criteria: block.criteria,
          options: block.options,
          sources,
        });
        break;
      }
    }
  }

  return { blocks: resolved, dropped: blocks.length - resolved.length, usedLabels: [...used] };
}
