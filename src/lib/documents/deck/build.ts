/**
 * The deck pipeline: planner → per-slide writer → critic → DeckSpec, plus the
 * ordinary blocks PDF/DOCX render from the same content. No assumption object,
 * no free-form parties and no auto-paging: every slide is one planned idea whose
 * numbers resolve through the claim registry.
 */
import type {
  ExportBrief,
  DocumentDraft,
  DocumentSection,
  SectionKind,
  SlideLayout,
} from "../types";
import type { ProviderOptions } from "../provider";
import {
  buildEvidencePack,
  chunkIdsForClaims,
  type EvidenceGroup,
  type EvidencePack,
} from "./evidence";
import { planDeck } from "./planner";
import { writeDeck } from "./writer";
import { critiqueDeck } from "./critic";
import { claimValue, claimsFromChunks } from "./claims";
import { claimsFromFacts, factSourceNote, type EntityFact } from "./enrichment";
import { inferSectionKind } from "../outline";
import type { ClaimRegistry, DeckChart, DeckSlideContent, DeckSpec, DeckSpecSlide } from "./types";
import type { Block, ChartSpec, ListItem, TableBlock } from "../types";
import { lintDeckSpec, type LintFinding } from "../lint";
import { throwIfAborted } from "../cancel";
import { tidyPie, validateChart } from "./chart-validate";
import { neutralDescriptor } from "../redact";

export type DeckBuildInput = {
  brief: ExportBrief;
  draft: DocumentDraft;
  parties: readonly string[];
  chunks: readonly import("../../rag/search").RetrievedChunk[];
  /** DB-backed claim registry; falls back to extraction when absent. */
  claims?: ClaimRegistry;
  /** Per-party retrieval groups, so metadata mismatches cannot orphan a party. */
  groups?: readonly EvidenceGroup[];
  /** Sourced facts that fill a party gap; each becomes an asterisked claim. */
  facts?: Record<string, readonly EntityFact[]>;
  /** The client the deck addresses; library customers are only references. */
  targetClient?: string | null;
  /** Deterministic name scrub for the final copy; the model input is already scrubbed. */
  scrubText?: (text: string) => string;
  /** Names the output linter must never let through. */
  blocklist?: readonly string[];
  provider: ProviderOptions;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export type DeckBuildOutput = {
  spec: DeckSpec;
  sections: DocumentSection[];
  warnings: string[];
  openItems: string[];
  usedFallback: boolean;
  pack: EvidencePack;
  lintFindings: LintFinding[];
};

function chartSpec(chart: DeckChart, claims: ClaimRegistry): ChartSpec | null {
  const series = chart.series
    .map((entry) => ({
      name: entry.name,
      values: entry.points
        .map((point) => claims[point.claimId]?.valueMax ?? claims[point.claimId]?.valueMin ?? null)
        .filter((value): value is number => value !== null),
    }))
    .filter((entry) => entry.values.length > 0);
  const categories = chart.series[0]?.points.map((point) => point.label) ?? [];
  if (series.length === 0 || categories.length === 0) return null;
  const type: ChartSpec["type"] =
    chart.kind === "doughnut" ? "doughnut" : chart.kind === "line" ? "line" : "bar";
  let finalCategories = categories;
  let finalSeries = series;
  if (chart.kind === "doughnut") {
    const tidied = tidyPie(categories, series[0]!.values);
    finalCategories = tidied.categories;
    finalSeries = [{ name: series[0]!.name, values: tidied.values }];
  }
  const verdict = validateChart({
    kind: chart.kind,
    categories: finalCategories,
    series: finalSeries,
  });
  if (!verdict.ok) return null;
  return {
    type,
    title: chart.title,
    ...(chart.unit ? { unit: chart.unit } : {}),
    categories: finalCategories,
    series: finalSeries,
    basis: "sourced",
  };
}

function listItems(
  bullets: Extract<DeckSlideContent, { layout: "context-bullets" }>["bullets"],
  claims: ClaimRegistry,
): ListItem[] {
  return bullets.map((bullet) => ({
    text: bullet.text,
    kind: bullet.claimIds.length > 0 ? "evidence" : "implication",
    ...(bullet.claimIds.length > 0 ? { sources: chunkIdsForClaims(bullet.claimIds, claims) } : {}),
  }));
}

/** Ordinary blocks for PDF/DOCX and for the legacy renderer fallback. */
export function blocksFromSlide(slide: DeckSpecSlide, claims: ClaimRegistry): Block[] {
  const content = slide.content;
  switch (content.layout) {
    case "section-divider":
      return [
        { type: "heading", level: 2, text: content.label },
        ...(content.statement
          ? [{ type: "paragraph" as const, text: content.statement, sources: [] }]
          : []),
      ];
    case "context-bullets":
      return [{ type: "bullet_list", items: listItems(content.bullets, claims), sources: [] }];
    case "kpi-cards":
      return [
        {
          type: "kpis",
          items: content.cards.map((card) => ({
            label: card.label,
            value: claims[card.claimId] ? claimValue(claims[card.claimId]!) : "",
            ...(card.note ? { note: card.note } : {}),
          })),
          sources: chunkIdsForClaims(
            content.cards.map((card) => card.claimId),
            claims,
          ),
        },
      ];
    case "partner-hub": {
      const table: TableBlock = {
        type: "table",
        headers: ["Party", "Role in the proposition"],
        rows: content.spokes.map((spoke) => [spoke.entity, spoke.role]),
        sources: chunkIdsForClaims(
          content.spokes.flatMap((spoke) => spoke.claimIds),
          claims,
        ),
      };
      return [table];
    }
    case "two-column-compare":
    case "before-after": {
      const rows = Math.max(content.left.points.length, content.right.points.length);
      const table: TableBlock = {
        type: "table",
        headers: [content.left.heading, content.right.heading],
        rows: Array.from({ length: rows }, (_, index) => [
          content.left.points[index] ?? "",
          content.right.points[index] ?? "",
        ]),
        sources: [],
      };
      return [table];
    }
    case "table-compact":
    case "shortcomings-table":
    case "collaboration-pointers-table": {
      const table: TableBlock = {
        type: "table",
        headers: content.headers,
        rows: content.rows,
        sources: [],
      };
      return [table];
    }
    case "process-roadmap":
      return [
        {
          type: "flow",
          steps: content.steps.map((step) => ({
            label: step.label,
            ...(step.detail ? { detail: step.detail } : {}),
          })),
          sources: [],
        },
      ];
    case "chart-with-takeaway": {
      const spec = chartSpec(content.chart, claims);
      return spec
        ? [
            {
              type: "chart",
              chart: spec,
              caption: content.takeaway,
              sources: chunkIdsForClaims(
                content.chart.series.flatMap((series) =>
                  series.points.map((point) => point.claimId),
                ),
                claims,
              ),
            },
          ]
        : [{ type: "paragraph", text: content.takeaway, sources: [] }];
    }
    case "image-with-caption":
      return [
        { type: "paragraph", text: content.caption, sources: [] },
        { type: "paragraph", text: content.sourceNote, sources: [] },
      ];
    case "next-steps-ask":
      return [
        { type: "paragraph", text: content.ask, sources: [] },
        {
          type: "numbered_list",
          items: content.steps.map((step) => ({
            text: [step.text, step.owner, step.when].filter(Boolean).join(" · "),
            kind: "recommendation" as const,
          })),
          sources: [],
        },
      ];
    case "maturity-progression": {
      const table: TableBlock = {
        type: "table",
        headers: ["Stage", "What changes"],
        rows: content.stages.map((stage) => [stage.label, stage.descriptor ?? ""]),
        sources: [],
      };
      return [table];
    }
    case "three-horizon": {
      const table: TableBlock = {
        type: "table",
        headers: ["Horizon", "Focus", "Outcomes"],
        rows: content.horizons.map((horizon) => [
          horizon.label,
          horizon.description,
          horizon.outcomes.join("; "),
        ]),
        sources: [],
      };
      return [table];
    }
    case "layered-architecture": {
      const table: TableBlock = {
        type: "table",
        headers: ["Layer", "Components"],
        rows: content.layers.map((layer) => [layer.label, layer.items.join(" · ")]),
        sources: [],
      };
      return [table];
    }
  }
}

const LAYOUT_TO_SLIDE: Record<DeckSlideContent["layout"], SlideLayout> = {
  "section-divider": "text",
  "context-bullets": "bullets",
  "kpi-cards": "kpis",
  "partner-hub": "table",
  "two-column-compare": "comparison",
  "before-after": "comparison",
  "table-compact": "table",
  "shortcomings-table": "table",
  "collaboration-pointers-table": "table",
  "process-roadmap": "flow",
  "chart-with-takeaway": "chart",
  "image-with-caption": "text",
  "next-steps-ask": "text",
  "maturity-progression": "timeline",
  "three-horizon": "timeline",
  "layered-architecture": "flow",
};

function deterministicNotes(): string {
  return "Walk the client through the point on this slide and confirm the next step in discussion.";
}

/**
 * A chart built only from other customers' figures is never the target's
 * forecast. Retitle it as an illustrative peer benchmark and make the sizing
 * step explicit.
 */
function retargetReferenceChart(slide: DeckSpecSlide, pack: EvidencePack): DeckSpecSlide {
  if (slide.content.layout !== "chart-with-takeaway" || !pack.targetClient) return slide;
  const claimIds = slide.content.chart.series.flatMap((series) =>
    series.points.map((point) => point.claimId),
  );
  const chunks = claimIds
    .map((id) => pack.claims[id]?.chunkId)
    .filter((id): id is string => Boolean(id))
    .map((id) => pack.chunks.find((chunk) => chunk.chunkId === id))
    .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
  const referenceOnly =
    chunks.length > 0 &&
    chunks.every((chunk) => (chunk.customerName ?? "") !== (pack.targetClient ?? ""));
  if (!referenceOnly) return slide;
  const descriptor = neutralDescriptor(chunks[0]?.industry);
  return {
    ...slide,
    content: {
      ...slide.content,
      chart: {
        ...slide.content.chart,
        title: `${descriptor.charAt(0).toUpperCase()}${descriptor.slice(1)} modelled scenarios (illustrative)`,
      },
      takeaway: `Reference benchmarks, not projections for ${pack.targetClient}. Size the opportunity with ${pack.targetClient} in discovery.`,
    },
  };
}

/**
 * The footnote on a slide. A public fact is asterisked and named; a library
 * claim keeps the plain `Source:` line. A slide that uses both carries both.
 */
export function slideSourceNote(claimIds: readonly string[], claims: ClaimRegistry): string {
  const cited = claimIds.map((id) => claims[id]).filter((claim) => Boolean(claim));
  const publicCited = cited.filter((claim) => claim!.origin === "public");
  const libraryClaim = cited.find((claim) => claim!.origin !== "public");
  return [
    ...(publicCited.length > 0 ? [factSourceNote(publicCited[0]!)] : []),
    ...(libraryClaim ? [`Source: ${libraryClaim.sourceTitle}`] : []),
  ].join("; ");
}

export async function buildDeck(input: DeckBuildInput): Promise<DeckBuildOutput> {
  const log = input.log ?? (() => undefined);
  const signal = input.provider.signal;
  if (signal) throwIfAborted(signal);
  const facts = input.facts ?? {};
  // Public facts join the same registry as library claims, so the writer may
  // reference them and the renderer's traceability guard still applies.
  const factClaims = claimsFromFacts(facts, input.claims ?? {});
  const mergedClaims: ClaimRegistry = { ...(input.claims ?? {}), ...factClaims };
  const pack = buildEvidencePack(input.chunks, input.parties, {
    ...(Object.keys(mergedClaims).length > 0 ? { claims: mergedClaims } : {}),
    ...(input.groups ? { groups: input.groups } : {}),
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
    ...(input.targetClient ? { targetClient: input.targetClient } : {}),
  });
  const planning = await planDeck(input.brief, input.draft, pack, {
    ...input.provider,
    log,
  });
  if (signal) throwIfAborted(signal);
  const writing = await writeDeck(planning.plan.slides, input.brief, input.draft, pack, {
    ...input.provider,
    log,
  });
  if (signal) throwIfAborted(signal);
  const criticism = await critiqueDeck(writing.slides, input.brief, input.draft, pack, {
    ...input.provider,
    log,
  });

  // The critic may have downgraded a layout to one the pack cannot support;
  // rebuild the claim registry only if a fallback introduced new values.
  const claims = Object.keys(pack.claims).length > 0 ? pack.claims : claimsFromChunks(input.chunks);
  const slides = criticism.slides.map((slide, index) => {
    const note = slideSourceNote(slide.claimIds, claims);
    return {
      ...slide,
      id: `slide-${index + 1}`,
      ...(slide.sourceNote ? {} : note ? { sourceNote: note } : {}),
      notes: slide.notes || deterministicNotes(),
    };
  });

  const retargeted = slides.map((slide) => retargetReferenceChart(slide, pack));
  const linted = lintDeckSpec(
    {
      deckTitle: planning.plan.deckTitle || input.brief.documentTitle || input.draft.title,
      audience: planning.plan.audience || input.brief.audience || "Executive committee",
      storyline: planning.plan.storyline,
      slides: retargeted,
      claims,
      entities: pack.parties.map((party) => party.name),
      gaps: pack.gaps,
      warnings: [...planning.warnings, ...writing.warnings, ...criticism.warnings, ...pack.gaps],
    },
    {
      ...(input.scrubText ? { scrubText: input.scrubText } : {}),
      ...(input.blocklist ? { blocklist: input.blocklist } : {}),
      ...(input.targetClient ? { targetClient: input.targetClient } : {}),
    },
  );
  const finalSlides = linted.spec.slides;

  const sections: DocumentSection[] = finalSlides.map((slide, index) => {
    const kind: SectionKind = inferSectionKind(slide.actionTitle, index, input.draft.mode);
    return {
      id: slide.id,
      kind,
      title: slide.actionTitle,
      layout: LAYOUT_TO_SLIDE[slide.content.layout],
      deck: slide,
      evidenceIds: slide.evidenceIds ?? [],
      blocks: blocksFromSlide(slide, claims),
      speakerNotes: slide.notes,
      flagged: false,
      warnings: [],
    };
  });

  const warnings = [...planning.warnings, ...writing.warnings, ...criticism.warnings, ...pack.gaps];

  const spec: DeckSpec = {
    ...linted.spec,
    warnings,
  };

  log("deck built", {
    slides: finalSlides.length,
    parties: spec.entities.length,
    claims: Object.keys(claims).length,
    gaps: spec.gaps.length,
    planned: planning.usedFallback ? "fallback" : "llm",
  });

  return {
    spec,
    sections,
    warnings,
    openItems: [...pack.gaps, ...warnings],
    usedFallback: planning.usedFallback || writing.warnings.length > 0,
    pack,
    lintFindings: linted.findings,
  };
}
