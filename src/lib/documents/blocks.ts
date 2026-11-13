/**
 * Strict schemas for what the section model may return. The model never writes
 * prose into the renderers directly: it returns JSON with short source labels
 * (S1, S2) that this module maps back to the chunk ids the server supplied.
 */
import { z } from "zod";
import type { Block, SourceLabel } from "./types";

const label = z
  .string()
  .trim()
  .regex(/^S\d{1,3}$/, "source must be a label like S1");

const sourceList = z.array(label).max(12);

const listItem = z.object({
  text: z.string().trim().min(4).max(320),
  level: z.number().int().min(0).max(2).optional(),
  sources: sourceList.optional(),
});

export const generatedBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    text: z.string().trim().min(2).max(140),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: z.string().trim().min(20).max(1400),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("bullet_list"),
    items: z.array(listItem).min(2).max(8),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("numbered_list"),
    items: z.array(listItem).min(2).max(8),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("table"),
    caption: z.string().trim().max(200).optional(),
    headers: z.array(z.string().trim().min(1).max(60)).min(2).max(6),
    rows: z
      .array(z.array(z.string().trim().max(240)).min(1).max(6))
      .min(2)
      .max(10),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("metrics"),
    items: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(80),
          value: z.string().trim().min(1).max(40),
          unit: z.string().trim().max(20).optional(),
          context: z.string().trim().max(220).optional(),
          source: label,
        }),
      )
      .min(1)
      .max(4),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("callout"),
    tone: z.enum(["info", "warning", "success"]),
    text: z.string().trim().min(8).max(600),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("quote"),
    text: z.string().trim().min(20).max(600),
    attribution: z.string().trim().min(2).max(120),
    source: label,
  }),
  z.object({
    type: z.literal("timeline"),
    items: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(80),
          timeframe: z.string().trim().min(1).max(60),
          detail: z.string().trim().min(8).max(300),
          sources: sourceList.min(1),
        }),
      )
      .min(2)
      .max(6),
    sources: sourceList.min(1),
  }),
  z.object({
    type: z.literal("comparison"),
    title: z.string().trim().max(160).optional(),
    criteria: z.array(z.string().trim().min(2).max(80)).min(1).max(6),
    options: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(80),
          values: z.array(z.string().trim().max(160)).min(1).max(6),
        }),
      )
      .min(2)
      .max(4),
    sources: sourceList.min(1),
  }),
]);

export type GeneratedBlock = z.infer<typeof generatedBlockSchema>;

export const sectionOutputSchema = z.object({
  blocks: z.array(generatedBlockSchema).min(1).max(12),
  /** 2-4 sentences; used as PPTX speaker notes and kept in the trace. */
  speakerNotes: z.string().trim().max(1400).default(""),
  openItems: z.array(z.string().trim().min(3).max(220)).max(8).default([]),
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
  switch (block.type) {
    case "heading":
      return [];
    case "metrics":
      return [...new Set([...block.items.map((item) => item.source), ...block.sources])];
    case "quote":
      return [block.source];
    case "timeline":
      return [...new Set([...block.sources, ...block.items.flatMap((item) => item.sources)])];
    default:
      return block.sources;
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
        const sources = ids(block.sources, true);
        if (sources.length === 0) continue;
        resolved.push({ type: "paragraph", text: block.text, sources });
        break;
      }
      case "bullet_list":
      case "numbered_list": {
        const sources = ids(block.sources, true);
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
        const sources = ids(block.sources, true);
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
        const sources = ids(block.sources, true);
        const items = block.items.flatMap((item) => {
          const [source] = ids([item.source], false);
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
        const sources = ids(block.sources, true);
        if (sources.length === 0) continue;
        resolved.push({ type: "callout", tone: block.tone, text: block.text, sources });
        break;
      }
      case "quote": {
        const [source] = ids([block.source], false);
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
        const sources = ids(block.sources, true);
        const items = block.items.flatMap((item) => {
          const own = ids(item.sources, false);
          if (own.length === 0) return [];
          return [
            { label: item.label, timeframe: item.timeframe, detail: item.detail, sources: own },
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
        const sources = ids(block.sources, true);
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
