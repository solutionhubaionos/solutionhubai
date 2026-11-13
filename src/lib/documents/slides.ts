/**
 * One lenient normaliser for every format. The model returns slide-shaped JSON;
 * this module coerces strings, object rows and numeric strings instead of
 * rejecting a deck, then applies the render-safety limits (bullets 6x20 words,
 * tables 7x5, charts 8 categories x 3 series) and the no-invented-numbers checks.
 *
 * Nothing here calls the provider. A malformed chart becomes a table, an empty
 * slide is dropped, and only the caller decides whether enough slides survived.
 */
import type {
  Block,
  ChartSpec,
  ChartType,
  ComparisonBlock,
  DocumentSection,
  ExportBrief,
  FlowStep,
  KpiItem,
  SlideLayout,
  SlidePlan,
  TableBlock,
  TimelineItem,
} from "./types";
import type { SectionPlan } from "./outline";
import { inferSectionKind, sectionTagFor } from "./outline";
import type { RetrievedChunk } from "../rag/search";

type Raw = {
  [key: string]: unknown;
  title?: unknown;
  section?: unknown;
  layout?: unknown;
  text?: unknown;
  bullets?: unknown;
  table?: unknown;
  chart?: unknown;
  kpis?: unknown;
  flow?: unknown;
  timeline?: unknown;
  comparison?: unknown;
  raci?: unknown;
  notes?: unknown;
  refs?: unknown;
  passageRefs?: unknown;
  rows?: unknown;
  headers?: unknown;
  caption?: unknown;
  categories?: unknown;
  series?: unknown;
  values?: unknown;
  name?: unknown;
  type?: unknown;
  basis?: unknown;
  unit?: unknown;
  label?: unknown;
  number?: unknown;
  value?: unknown;
  note?: unknown;
  context?: unknown;
  step?: unknown;
  detail?: unknown;
  description?: unknown;
  phase?: unknown;
  timeframe?: unknown;
  items?: unknown;
  when?: unknown;
  time?: unknown;
  criteria?: unknown;
  options?: unknown;
  bullet?: unknown;
};

const MAX_BULLETS = 6;
const MAX_BULLET_WORDS = 20;
const MAX_TABLE_ROWS = 7;
const MAX_TABLE_COLS = 5;
const MAX_CHART_CATEGORIES = 8;
const MAX_CHART_SERIES = 3;

const asRecord = (value: unknown): Raw =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};
const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const clipWords = (text: string, max: number): string => words(text).slice(0, max).join(" ");

/** Passage refs accept numbers or strings; only 1..80 survive. */
export function refNumbers(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const refs: number[] = [];
  for (const entry of values) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      const n = Math.trunc(entry);
      if (n >= 1 && n <= 80) refs.push(n);
      continue;
    }
    if (typeof entry !== "string") continue;
    for (const match of entry.matchAll(/\d{1,3}/g)) {
      const n = Number.parseInt(match[0], 10);
      if (n >= 1 && n <= 80) refs.push(n);
    }
  }
  return [...new Set(refs)].slice(0, 12);
}

function chunkIdsFor(refs: readonly number[], chunks: readonly RetrievedChunk[]): string[] {
  const ids = refs.map((ref) => chunks[ref - 1]?.chunkId).filter(Boolean);
  return [...new Set(ids as string[])];
}

function citedText(refs: readonly number[], chunks: readonly RetrievedChunk[]): string {
  return refs.map((ref) => chunks[ref - 1]?.content ?? "").join("\n");
}

/** A value only counts as sourced when it appears verbatim, with locale separators. */
export function numberInText(value: number, text: string): boolean {
  const candidates = new Set([
    String(value),
    value.toLocaleString("en-GB"),
    value.toLocaleString("en-US"),
    value.toFixed(0),
    value.toFixed(1),
    value.toFixed(2),
  ]);
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\d])${escaped}([^\\d]|$)`).test(text)) return true;
  }
  return false;
}

function formatter(unit: string | undefined): (value: number) => string {
  return (value) =>
    `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
}

function tableBlock(
  headers: string[],
  rows: string[][],
  sources: string[],
  caption?: string,
): TableBlock | null {
  const clippedHeaders = headers.slice(0, MAX_TABLE_COLS).map((header) => asString(header));
  const clippedRows = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => clippedHeaders.map((_, index) => asString(row[index] ?? "")))
    .filter((row) => row.some(Boolean));
  if (clippedHeaders.length === 0 || clippedRows.length === 0) return null;
  return {
    type: "table",
    headers: clippedHeaders,
    rows: clippedRows,
    sources,
    ...(caption ? { caption } : {}),
  };
}

/** Tables accept array rows, object rows, missing headers and numeric cells. */
export function normalizeTable(value: unknown, sources: string[]): TableBlock | null {
  const raw = asRecord(value);
  const rawRows = asArray(raw.rows);
  let headers = asArray(raw.headers).map(asString).filter(Boolean);
  const rows: string[][] = [];

  if (
    rawRows.length > 0 &&
    rawRows.every((row) => row && typeof row === "object" && !Array.isArray(row))
  ) {
    if (headers.length === 0) {
      headers = [...new Set(rawRows.flatMap((row) => Object.keys(asRecord(row))))].slice(
        0,
        MAX_TABLE_COLS,
      );
    }
    for (const row of rawRows) {
      const record = asRecord(row);
      rows.push(headers.map((header) => asString(record[header])));
    }
  } else {
    const arrayRows = rawRows.map((row) => (Array.isArray(row) ? row : [row]));
    if (headers.length === 0 && arrayRows.length > 1) {
      headers = (arrayRows[0] ?? []).map(asString).filter(Boolean);
      arrayRows.shift();
    }
    if (headers.length === 0) {
      const width = Math.max(1, Math.min(MAX_TABLE_COLS, ...arrayRows.map((row) => row.length)));
      headers = Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
    }
    for (const row of arrayRows) rows.push(row.map(asString));
  }

  return tableBlock(headers, rows, sources, asString(raw.caption) || undefined);
}

function chartToTable(spec: ChartSpec, sources: string[]): TableBlock | null {
  const format = formatter(spec.unit);
  const rows = spec.categories.map((category, index) => [
    category,
    ...spec.series.map((series) => format(series.values[index] ?? 0)),
  ]);
  return tableBlock(
    ["Category", ...spec.series.map((series) => series.name)],
    rows,
    sources,
    spec.title,
  );
}

const CHART_TYPES: ChartType[] = ["bar", "stacked_bar", "line", "pie", "doughnut"];

/**
 * Chart values must be sourced verbatim or come from the code assumptions. A
 * mismatch turns the chart into the same data as a table; it never fails a deck.
 */
function normalizeChart(
  value: unknown,
  refs: readonly number[],
  sources: string[],
  chunks: readonly RetrievedChunk[],
  assumptionValues: ReadonlySet<number>,
): { block: Block | null; warning?: string } {
  const raw = asRecord(value);
  const categories = asArray(raw.categories).map(asString).filter(Boolean);
  const rawSeries = asArray(raw.series).map(asRecord);
  if (categories.length === 0 || rawSeries.length === 0) return { block: null };

  const series: { name: string; values: number[] }[] = [];
  for (const entry of rawSeries.slice(0, MAX_CHART_SERIES)) {
    const values = asArray(entry.values).map(asNumber);
    if (values.some((item) => item === null)) {
      return { block: null, warning: "Chart values were not numeric; rendered as a table." };
    }
    series.push({
      name: asString(entry.name) || `Series ${series.length + 1}`,
      values: values as number[],
    });
  }
  const length = categories.length;
  if (series.some((entry) => entry.values.length !== length)) {
    return { block: null, warning: "Chart series lengths differed; rendered as a table." };
  }

  const type = CHART_TYPES.includes(asString(raw.type) as ChartType)
    ? (asString(raw.type) as ChartType)
    : "bar";
  const basis = asString(raw.basis).toLowerCase() === "assumption" ? "assumption" : "sourced";
  const spec: ChartSpec = {
    type,
    title: asString(raw.title) || "Chart",
    ...(asString(raw.unit) ? { unit: asString(raw.unit) } : {}),
    categories: categories.slice(0, MAX_CHART_CATEGORIES),
    series: series.map((entry) => ({
      ...entry,
      values: entry.values.slice(0, MAX_CHART_CATEGORIES),
    })),
    basis,
  };
  // Keep pies and doughnuts single-series; the first series is the data.
  if ((type === "pie" || type === "doughnut") && spec.series.length > 1) {
    spec.series = spec.series.slice(0, 1);
  }

  if (basis === "sourced") {
    if (refs.length === 0) {
      return {
        block: chartToTable(spec, sources),
        warning: "Chart cited no passage; rendered as a table.",
      };
    }
    const text = citedText(refs, chunks);
    const unsupported = spec.series.some((entry) =>
      entry.values.some((number) => !numberInText(number, text)),
    );
    if (unsupported) {
      return {
        block: chartToTable(spec, sources),
        warning: "A chart value was not in the cited passages; rendered as a table.",
      };
    }
  } else {
    const invented = spec.series.some((entry) =>
      entry.values.some((number) => !assumptionValues.has(number)),
    );
    if (invented) {
      return {
        block: chartToTable(spec, sources),
        warning: "An assumption chart used a value outside the code model; rendered as a table.",
      };
    }
  }

  return {
    block: {
      type: "chart",
      chart: spec,
      sources,
      illustrative: basis === "assumption",
    },
  };
}

function normalizeKpis(value: unknown, sources: string[]): Block | null {
  const items: KpiItem[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      const [label, ...rest] = entry.split(":");
      if (label && rest.length > 0)
        items.push({ label: asString(label), value: asString(rest.join(":")) });
      continue;
    }
    const record = asRecord(entry);
    const label = asString(record.label ?? record.title);
    const valueText = asString(record.value ?? record.number);
    if (!label || !valueText) continue;
    const note = asString(record.note ?? record.context);
    items.push({ label, value: valueText, ...(note ? { note } : {}) });
  }
  if (items.length === 0) return null;
  return { type: "kpis", items: items.slice(0, 6), sources };
}

function normalizeFlow(value: unknown, sources: string[]): Block | null {
  const steps: FlowStep[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry.trim()) steps.push({ label: asString(entry) });
      continue;
    }
    const record = asRecord(entry);
    const label = asString(record.label ?? record.step ?? record.title);
    if (!label) continue;
    const detail = asString(record.detail ?? record.description);
    steps.push({ label, ...(detail ? { detail } : {}) });
  }
  if (steps.length === 0) return null;
  return { type: "flow", steps: steps.slice(0, 6), sources };
}

function normalizeTimeline(value: unknown, sources: string[]): Block | null {
  const items: TimelineItem[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (typeof entry === "string") {
      if (entry.trim())
        items.push({ label: "Phase", timeframe: "", detail: asString(entry), sources });
      continue;
    }
    const label = asString(record.phase ?? record.label ?? record.timeframe);
    const detail = Array.isArray(record.items)
      ? asArray(record.items).map(asString).filter(Boolean).join("; ")
      : asString(record.detail ?? record.description);
    if (!label && !detail) continue;
    items.push({
      label: label || "Phase",
      timeframe: asString(record.when ?? record.timeframe ?? record.time),
      detail,
      sources,
    });
  }
  if (items.length === 0) return null;
  return { type: "timeline", items: items.slice(0, 6), sources };
}

function normalizeComparison(value: unknown, sources: string[]): Block | null {
  const raw = asRecord(value);
  const criteria = asArray(raw.criteria).map(asString).filter(Boolean).slice(0, 4);
  const options = asArray(raw.options)
    .map(asRecord)
    .map((option) => ({
      name: asString(option.name),
      values: asArray(option.values).map(asString).slice(0, 4),
    }))
    .filter((option) => option.name && option.values.length > 0)
    .slice(0, 3);
  if (criteria.length === 0 || options.length === 0) return null;
  const comparison: ComparisonBlock = {
    type: "comparison",
    criteria,
    options: options.map((option) => ({
      ...option,
      values: criteria.map((_, index) => option.values[index] ?? ""),
    })),
    sources,
  };
  return comparison;
}

function normalizeBullets(value: unknown): string[] {
  return asArray(value)
    .map((entry) =>
      typeof entry === "string" ? entry : asString(asRecord(entry).text ?? asRecord(entry).bullet),
    )
    .map((text) => clipWords(text.replace(/\s+/g, " ").trim(), MAX_BULLET_WORDS))
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
}

function resolveLayout(
  raw: Raw,
  plan: SectionPlan | undefined,
  blocks: readonly Block[],
): SlideLayout {
  if (plan?.layout) return plan.layout;
  const declared = asString(raw.layout) as SlideLayout;
  const allowed: SlideLayout[] = [
    "summary",
    "bullets",
    "text",
    "table",
    "comparison",
    "kpis",
    "chart",
    "flow",
    "timeline",
    "raci",
  ];
  if (allowed.includes(declared)) return declared;
  if (blocks.some((block) => block.type === "chart")) return "chart";
  if (blocks.some((block) => block.type === "table")) return "table";
  if (blocks.some((block) => block.type === "kpis")) return "kpis";
  if (blocks.some((block) => block.type === "flow")) return "flow";
  if (blocks.some((block) => block.type === "timeline")) return "timeline";
  if (blocks.some((block) => block.type === "comparison")) return "comparison";
  if (blocks.some((block) => block.type === "bullet_list")) return "bullets";
  return "text";
}

export type NormalizedDeck = {
  sections: DocumentSection[];
  missing: SectionPlan[];
  warnings: string[];
};

/**
 * Maps the model's slides onto the confirmed plan. Titles, order and layout come
 * from the plan; the model only fills the content. Empty slides are returned as
 * missing, never retried here.
 */
export function normalizeDeck(
  rawSlides: readonly unknown[],
  plans: readonly SectionPlan[],
  chunks: readonly RetrievedChunk[],
  brief: ExportBrief,
  assumptionValues: ReadonlySet<number> = new Set(),
): NormalizedDeck {
  const warnings: string[] = [];
  const sections: DocumentSection[] = [];
  const missing: SectionPlan[] = [];
  const used = new Set<number>();
  const byTitle = new Map<string, number>();
  rawSlides.forEach((slide, index) => {
    const title = asString(asRecord(slide).title).toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, index);
  });

  for (const [planIndex, plan] of plans.entries()) {
    let rawIndex = byTitle.get(plan.title.toLowerCase());
    if (rawIndex === undefined || used.has(rawIndex)) rawIndex = planIndex;
    const raw = asRecord(rawSlides[rawIndex]);
    if (rawIndex < rawSlides.length) used.add(rawIndex);
    const refs = refNumbers(raw.refs ?? raw.passageRefs);
    const sources = chunkIdsFor(refs, chunks);
    const slideWarnings: string[] = [];
    if (sources.length === 0) slideWarnings.push("No passage cited.");

    const blocks: Block[] = [];
    if (raw.table !== undefined) {
      const table = normalizeTable(raw.table, sources);
      if (table) blocks.push(table);
    }
    if (raw.chart !== undefined) {
      const chart = normalizeChart(raw.chart, refs, sources, chunks, assumptionValues);
      if (chart.block) blocks.push(chart.block);
      if (chart.warning) slideWarnings.push(chart.warning);
    }
    if (raw.kpis !== undefined) {
      const kpis = normalizeKpis(raw.kpis, sources);
      if (kpis) blocks.push(kpis);
    }
    if (raw.flow !== undefined) {
      const flow = normalizeFlow(raw.flow, sources);
      if (flow) blocks.push(flow);
    }
    if (raw.timeline !== undefined) {
      const timeline = normalizeTimeline(raw.timeline, sources);
      if (timeline) blocks.push(timeline);
    }
    if (raw.comparison !== undefined) {
      const comparison = normalizeComparison(raw.comparison, sources);
      if (comparison) blocks.push(comparison);
    }
    if (raw.raci !== undefined) {
      const raci = normalizeTable(raw.raci, sources);
      if (raci) blocks.push(raci);
    }

    const text = asString(raw.text).slice(0, 1400);
    if (text) blocks.push({ type: "paragraph", text, sources });
    const bullets = normalizeBullets(raw.bullets);
    if (bullets.length > 0) {
      blocks.push({
        type: "bullet_list",
        items: bullets.map((textValue) => ({ text: textValue })),
        sources,
      });
    }

    if (blocks.length === 0) {
      missing.push(plan);
      continue;
    }

    const layout = resolveLayout(raw, plan, blocks);
    const title = plan.title;
    const notes = asString(raw.notes).slice(0, 1200);
    const sectionTag = plan.section ?? sectionTagFor(plan.kind);
    const deterministicNotes =
      refs.length > 0
        ? `${title}. Section: ${sectionTag}. Draws on passages ${refs.join(", ")}.`
        : `${title}. No passage was cited for this slide; review before sharing.`;
    sections.push({
      id: plan.id,
      kind: plan.kind || inferSectionKind(title, planIndex, brief.mode),
      title,
      layout,
      blocks,
      speakerNotes: notes || deterministicNotes,
      flagged: false,
      warnings: slideWarnings,
    });
    warnings.push(...slideWarnings.map((warning) => `${title}: ${warning}`));
  }

  return { sections, missing, warnings };
}

/** A deterministic, honest table for a plan item the model left empty. */
export function fallbackSlide(
  plan: SectionPlan,
  chunks: readonly RetrievedChunk[],
): DocumentSection | null {
  const usable = chunks.slice(0, 3);
  if (usable.length === 0) return null;
  const bullets = usable
    .map((chunk) => clipWords(chunk.content.replace(/\s+/g, " "), MAX_BULLET_WORDS))
    .filter(Boolean);
  if (bullets.length === 0) return null;
  const sources = usable.map((chunk) => chunk.chunkId);
  return {
    id: plan.id,
    kind: plan.kind,
    title: plan.title,
    layout: plan.layout ?? "bullets",
    blocks: [
      {
        type: "bullet_list",
        items: bullets.map((text) => ({ text })),
        sources,
      },
    ],
    speakerNotes: `${plan.title}. Recovered from the cited passages because the model returned no content.`,
    flagged: false,
    warnings: ["Generated from cited passages after an empty deck slide."],
  };
}

/** Renders an assumptions table as a normal table block. */
export function assumptionTable(
  rows: { item: string; value: string; note: string }[],
  sources: string[] = [],
): Block {
  const table: TableBlock = {
    type: "table",
    caption: "Illustrative assumptions — replace with actuals",
    headers: ["Assumption", "Value", "Basis"],
    rows: rows.slice(0, MAX_TABLE_ROWS).map((row) => [row.item, row.value, row.note]),
    sources,
  };
  return table;
}
