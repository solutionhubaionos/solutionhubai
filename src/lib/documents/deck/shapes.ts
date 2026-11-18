/**
 * Exact JSON shape per layout, for the writer prompt.
 *
 * The schemas in `catalog.ts` reject overflow, but a model cannot guess field
 * names from a prose capacity line: it writes `title` where the layout wants
 * `centre`, or bullets as strings. Every writer slide then fails validation and
 * is replaced by fallback copy. These skeletons are the contract, written from
 * the same catalogue the validator uses.
 *
 * Keep this file in step with `DeckContentSchema` in `catalog.ts`; the tests
 * parse every skeleton against the matching schema.
 */
import type { DeckSlideContent, PlannerLayoutId } from "./types";

const SHAPES: Record<PlannerLayoutId, string> = {
  "section-divider":
    '{"layout":"section-divider","label":"3-8 words","statement":"one sentence, max 160 characters (optional)"}',
  "context-bullets":
    '{"layout":"context-bullets","bullets":[{"text":"max 16 words","claimIds":["CL-1"]},{"text":"max 16 words","claimIds":[]}]}',
  "kpi-cards":
    '{"layout":"kpi-cards","cards":[{"label":"max 60 characters","claimId":"CL-1","note":"optional, max 90 characters"},{"label":"max 60 characters","claimId":"CL-2"}]}',
  "partner-hub":
    '{"layout":"partner-hub","centre":"max 180 characters","spokes":[{"entity":"an exact validated party name","role":"max 120 characters","claimIds":["CL-1"],"inferred":false},{"entity":"another validated party","role":"max 120 characters","claimIds":[]}]}',
  "two-column-compare":
    '{"layout":"two-column-compare","left":{"heading":"max 180 characters","points":["max 140 characters","max 140 characters"]},"right":{"heading":"max 180 characters","points":["max 140 characters","max 140 characters"]}}',
  "before-after":
    '{"layout":"before-after","left":{"heading":"max 180 characters","points":["max 140 characters","max 140 characters"]},"right":{"heading":"max 180 characters","points":["max 140 characters","max 140 characters"]}}',
  "table-compact":
    '{"layout":"table-compact","headers":["max 40 characters","max 40 characters"],"rows":[["cell, max 120 characters","cell, max 120 characters"],["cell","cell"]]}',
  "shortcomings-table":
    '{"layout":"shortcomings-table","headers":["max 40 characters","max 40 characters"],"rows":[["cell, max 120 characters","cell, max 120 characters"],["cell","cell"]]}',
  "collaboration-pointers-table":
    '{"layout":"collaboration-pointers-table","headers":["max 40 characters","max 40 characters"],"rows":[["cell, max 120 characters","cell, max 120 characters"],["cell","cell"]]}',
  "process-roadmap":
    '{"layout":"process-roadmap","steps":[{"label":"max 60 characters","detail":"optional, max 130 characters"},{"label":"max 60 characters"},{"label":"max 60 characters"}]}',
  "chart-with-takeaway":
    '{"layout":"chart-with-takeaway","chart":{"kind":"bar","title":"max 80 characters","unit":"optional, max 30 characters","series":[{"name":"max 40 characters","points":[{"label":"max 40 characters","claimId":"CL-1"},{"label":"max 40 characters","claimId":"CL-2"}]}]},"takeaway":"one sentence, max 220 characters"}',
  "image-with-caption":
    '{"layout":"image-with-caption","caption":"max 180 characters","sourceNote":"max 120 characters"}',
  "next-steps-ask":
    '{"layout":"next-steps-ask","ask":"max 160 characters","steps":[{"text":"max 120 characters","owner":"optional, max 60 characters","when":"optional, max 40 characters"},{"text":"max 120 characters"}]}',
  "maturity-progression":
    '{"layout":"maturity-progression","stages":[{"label":"max 40 characters","descriptor":"optional, max 120 characters"},{"label":"max 40 characters"},{"label":"max 40 characters"}],"currentStage":0,"targetStage":2}',
  "three-horizon":
    '{"layout":"three-horizon","horizons":[{"label":"max 40 characters","description":"max 140 characters","outcomes":["max 70 characters","max 70 characters"]},{"label":"max 40 characters","description":"max 140 characters","outcomes":["max 70 characters"]},{"label":"max 40 characters","description":"max 140 characters","outcomes":["max 70 characters"]}]}',
  "layered-architecture":
    '{"layout":"layered-architecture","layers":[{"label":"max 40 characters","items":["max 50 characters","max 50 characters"]},{"label":"max 40 characters","items":["max 50 characters","max 50 characters"]},{"label":"max 40 characters","items":["max 50 characters","max 50 characters"]}]}',
};

/**
 * Trim to a layout limit at a word boundary. Models cannot count characters, so
 * a 130-character table cell used to reject the whole slide and cost a retry.
 * Cutting the copy keeps the layout intact and the sentence readable.
 */
function trimTo(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? window.slice(0, lastSpace) : text.slice(0, max);
  const trimmed = cut.replace(/[\s,;:.\-–—]+$/, "");
  return trimmed.length > 1 ? trimmed : text.slice(0, max);
}

/**
 * Clamp every visible string to the capacity its layout was designed for. Run
 * before schema validation so an over-long sentence shortens instead of
 * discarding the slide.
 */
export function fitContent(content: DeckSlideContent): DeckSlideContent {
  switch (content.layout) {
    case "section-divider":
      return {
        ...content,
        label: trimTo(content.label, 60),
        ...(content.statement ? { statement: trimTo(content.statement, 160) } : {}),
      };
    case "context-bullets":
      return {
        ...content,
        bullets: content.bullets.map((bullet) => ({ ...bullet, text: trimTo(bullet.text, 170) })),
      };
    case "kpi-cards":
      return {
        ...content,
        cards: content.cards.map((card) => ({
          ...card,
          label: trimTo(card.label, 60),
          ...(card.note ? { note: trimTo(card.note, 90) } : {}),
        })),
      };
    case "partner-hub":
      return {
        ...content,
        centre: trimTo(content.centre, 180),
        spokes: content.spokes.map((spoke) => ({
          ...spoke,
          entity: trimTo(spoke.entity, 60),
          role: trimTo(spoke.role, 120),
        })),
      };
    case "two-column-compare":
    case "before-after":
      return {
        ...content,
        left: {
          heading: trimTo(content.left.heading, 180),
          points: content.left.points.map((point) => trimTo(point, 140)),
        },
        right: {
          heading: trimTo(content.right.heading, 180),
          points: content.right.points.map((point) => trimTo(point, 140)),
        },
      };
    case "table-compact":
    case "shortcomings-table":
    case "collaboration-pointers-table":
      return {
        ...content,
        headers: content.headers.map((header) => trimTo(header, 40)),
        rows: content.rows.map((row) => row.map((cell) => trimTo(cell, 120))),
      };
    case "process-roadmap":
      return {
        ...content,
        steps: content.steps.map((step) => ({
          ...step,
          label: trimTo(step.label, 60),
          ...(step.detail ? { detail: trimTo(step.detail, 130) } : {}),
        })),
      };
    case "chart-with-takeaway":
      return {
        ...content,
        chart: {
          ...content.chart,
          title: trimTo(content.chart.title, 80),
          ...(content.chart.unit ? { unit: trimTo(content.chart.unit, 30) } : {}),
          series: content.chart.series.map((series) => ({
            ...series,
            name: trimTo(series.name, 40),
            points: series.points.map((point) => ({ ...point, label: trimTo(point.label, 40) })),
          })),
        },
        takeaway: trimTo(content.takeaway, 220),
      };
    case "image-with-caption":
      return {
        ...content,
        caption: trimTo(content.caption, 180),
        sourceNote: trimTo(content.sourceNote, 120),
      };
    case "next-steps-ask":
      return {
        ...content,
        ask: trimTo(content.ask, 160),
        steps: content.steps.map((step) => ({
          ...step,
          text: trimTo(step.text, 120),
          ...(step.owner ? { owner: trimTo(step.owner, 60) } : {}),
          ...(step.when ? { when: trimTo(step.when, 40) } : {}),
        })),
      };
    case "maturity-progression":
      return {
        ...content,
        stages: content.stages.map((stage) => ({
          label: trimTo(stage.label, 40),
          ...(stage.descriptor ? { descriptor: trimTo(stage.descriptor, 120) } : {}),
        })),
      };
    case "three-horizon":
      return {
        ...content,
        horizons: content.horizons.map((horizon) => ({
          label: trimTo(horizon.label, 40),
          description: trimTo(horizon.description, 140),
          outcomes: horizon.outcomes.map((outcome) => trimTo(outcome, 70)),
        })),
      };
    case "layered-architecture":
      return {
        ...content,
        layers: content.layers.map((layer) => ({
          label: trimTo(layer.label, 40),
          items: layer.items.map((item) => trimTo(item, 50)),
        })),
      };
    default:
      return content;
  }
}

/** The JSON the writer must return for this layout, placeholder values included. */
export function layoutShape(id: PlannerLayoutId): string {
  return SHAPES[id] ?? SHAPES["context-bullets"];
}

/** Every skeleton, for tests that parse them against the real schemas. */
export const LAYOUT_SHAPES = SHAPES;
