/**
 * Stage 1: the planner. It chooses the storyline, the action title of every
 * slide, the layout that carries each point and the evidence tier. It writes no
 * body copy and no numbers: the writer fills the plan, the critic audits it.
 */
import type { ExportBrief, DocumentDraft } from "../types";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type ProviderOptions,
} from "../provider";
import { withMaxTokens, llmBudget } from "../llm-budget";
import { catalogueForPrompt, DeckPlanSchema } from "./catalog";
import type { DeckPlan, DeckPlanSlide, PlannerLayoutId } from "./types";
import { evidenceForPlanner, type EvidencePack } from "./evidence";

export type PlannerOptions = ProviderOptions & {
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export const PLANNER_SYSTEM = [
  "You are a senior pre-sales strategist planning a client-ready pitch deck for AIonOS.",
  'Return JSON only, no fences: {"deckTitle":string,"audience":string,"storyline":string,"slides":[{layout,actionTitle,purpose,evidenceRefs,tier}]}.',
  "The deck has one argument, told in six to ten slides: Situation, Insight, Propose, Proof, Plan, Ask.",
  "Every action title is a claim of at most 14 words that a reader could disagree with. Never use a label such as Overview, Our approach, Partners, Next steps or Conclusion.",
  "Choose the layout that carries the point, not the layout that is easiest. Use no layout more than twice in a row. Include at least one visual layout (kpi-cards, chart-with-takeaway, partner-hub, process-roadmap, two-column-compare, before-after, maturity-progression, three-horizon or layered-architecture).",
  "Match the visual to the content: ordered capability stages use maturity-progression, a now-next-later plan uses three-horizon, stacked platform or operating-model layers use layered-architecture, and a sequence of delivery steps uses process-roadmap. Never put stages, horizons or layers into generic text cards.",
  `Layouts:\n${catalogueForPrompt()}`,
  "No slide may talk about the library, passages, evidence, sources or the brief. Write for the client, never about our process.",
  "Tier: sourced when a passage supports the slide; inferred when the slide proposes a role, next step or structure; illustrative only for a labelled scenario built from claims.",
  "Never invent a company, number, date, quotation or outcome. A party with no direct passage still gets a slide, marked inferred, with the role we propose.",
  "The confirmed outline in the brief is the storyline the user agreed to: keep its subjects and order. You may sharpen a heading into an action title and merge a thin heading, but do not replace the story with a template.",
  "If the evidence is only about one party, the deck is about that party and the offer around it; do not add other companies.",
  "Localise hard: when the brief names a target client, every action title is written for that client by name, or addresses it as 'you'. Titles must sound like statements about this client's business, not a reusable template.",
  "Library customers in the evidence are anonymised references, never parties. Never plan a slide title that names a library customer. Plan peer examples only on proof or impact slides, and use the neutral labels the evidence supplies.",
  "When the library has little material on the target, plan the same storyline from the closest peer evidence without presenting the peer's numbers as the target's.",
  "Do not use model memory about the target client (loyalty programme, hub, fleet, route count, size or market position). Only the brief, the user's note or the website description may supply those facts.",
].join(" ");

function briefForPlanner(brief: ExportBrief, draft: DocumentDraft): string {
  return JSON.stringify(
    {
      request: brief.request,
      mode: brief.mode,
      title: brief.documentTitle,
      client: brief.client,
      industry: brief.industry,
      audience: brief.audience,
      problem: brief.problem,
      goals: brief.goals,
      constraints: brief.constraints,
      parties: brief.partiesInvolved ?? [],
      entities: brief.keyEntities ?? [],
      confirmedOutline: draft.outline,
      mustInclude: brief.include,
      exclude: brief.exclude,
      wizardSelection: {
        client: draft.client,
        industry: draft.industry,
        sector: draft.sector,
      },
    },
    null,
    1,
  );
}

export function plannerUserPrompt(
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
): string {
  return [
    "Brief (framing only, never a source of facts):",
    briefForPlanner(brief, draft),
    "",
    "Validated parties (only these may appear as companies):",
    pack.parties.length > 0 ? pack.parties.map((party) => party.name).join("; ") : "none",
    "",
    pack.targetClient
      ? `Target client (the deck is written to this client): ${pack.targetClient}`
      : "Target client: not named; keep the titles client-shaped without inventing a name.",
    pack.referenceCustomers.length > 0
      ? "Reference customers behind the evidence are anonymised neutral labels (proof slides only, never parties; never print a real customer name)."
      : "Reference customers: none in the evidence.",
    "",
    "Evidence pack:",
    evidenceForPlanner(pack),
    "",
    pack.images.length > 0
      ? `Available images: ${pack.images.map((image) => image.id).join(", ")}`
      : "Images: none available. Do not choose image-with-caption.",
    "",
    "Return six to ten slides, in order. JSON only.",
  ].join("\n");
}

/** No layout three times in a row; the planner is asked, this enforces it. */
function easeRuns(slides: DeckPlanSlide[]): DeckPlanSlide[] {
  const category = (layout: PlannerLayoutId): string =>
    layout === "shortcomings-table" ||
    layout === "collaboration-pointers-table" ||
    layout === "table-compact"
      ? "table"
      : layout === "two-column-compare" || layout === "before-after"
        ? "compare"
        : layout;
  let run: string[] = [];
  return slides.map((slide, index) => {
    const key = category(slide.layout);
    run = [...run, key].slice(-3);
    if (run.length === 3 && run.every((entry) => entry === key)) {
      const alternatives: PlannerLayoutId[] = [
        "context-bullets",
        "kpi-cards",
        "process-roadmap",
        "two-column-compare",
      ];
      const replacement =
        alternatives.find(
          (layout) => category(layout) !== key && layout !== slides[index - 1]?.layout,
        ) ?? "context-bullets";
      run[2] = category(replacement);
      return { ...slide, layout: replacement };
    }
    return slide;
  });
}

function normalisePlan(plan: DeckPlan, draft: DocumentDraft): DeckPlan {
  const slides = easeRuns([...plan.slides]).slice(0, 10);
  if (slides.length >= 6) return { ...plan, slides };
  // Pad a short plan with evidence-neutral movements rather than shipping four
  // slides that cannot tell a story.
  const extra: DeckPlanSlide[] = [
    {
      layout: "context-bullets",
      actionTitle: "The current model leaves measurable value on the table",
      purpose: "Frame the situation.",
      evidenceRefs: [],
      tier: "inferred",
    },
    {
      layout: "next-steps-ask",
      actionTitle: "A scoped first step proves the case before scale",
      purpose: "Close with the ask.",
      evidenceRefs: [],
      tier: "inferred",
    },
  ];
  const merged = [...slides];
  for (const slide of extra) {
    if (merged.length >= 6) break;
    merged.push(slide);
  }
  return {
    ...plan,
    deckTitle: plan.deckTitle || draft.title,
    slides: merged,
  };
}

export async function planDeck(
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
  options: PlannerOptions,
): Promise<{ plan: DeckPlan; usedFallback: boolean; warnings: string[] }> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const messages = [
    { role: "system" as const, content: PLANNER_SYSTEM },
    { role: "user" as const, content: plannerUserPrompt(brief, draft, pack) },
  ];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const outcome = await completeWithBudget(
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: "user" as const,
                content: `That plan was rejected: ${String(lastError).slice(0, 400)}. Return six to ten valid slides, JSON only, with action titles and a varied layout sequence.`,
              },
            ],
        options,
        withMaxTokens(llmBudget("DECK"), 6_000, false),
        attempt === 0 ? 0.35 : 0.2,
        { label: `deck planner${attempt > 0 ? ":retry" : ""}` },
      );
      const plan = normalisePlan(DeckPlanSchema.parse(parseJsonValue(outcome.content)), draft);
      if (plan.slides.length < 6) throw new Error("plan had fewer than six usable slides");
      return { plan, usedFallback: false, warnings };
    } catch (error) {
      lastError = error;
      log("deck planner attempt failed", {
        attempt: attempt + 1,
        reason: failureReasonOf(error),
        error: String(error).slice(0, 240),
      });
    }
  }

  warnings.push("The planner fell back to the standard storyline.");
  return { plan: fallbackPlan(brief, draft, pack), usedFallback: true, warnings };
}

/** Deterministic 7-slide storyline used when planning fails twice. */
export function fallbackPlan(
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
): DeckPlan {
  const client = brief.client ?? draft.client ?? pack.parties[0]?.name ?? "the client";
  const industry = brief.industry ?? draft.industry ?? "the sector";
  const hasClaims = Object.keys(pack.claims).length >= 2;
  const multiParty = pack.parties.length >= 2;
  const slides: DeckPlanSlide[] = [
    {
      layout: "context-bullets",
      actionTitle: `${client} can turn ${industry} complexity into a repeatable advantage`,
      purpose: "Set the situation and the value at stake.",
      evidenceRefs: pack.genericChunks.slice(0, 2).map((chunk) => chunk.chunkId),
      tier: pack.chunks.length > 0 ? "sourced" : "inferred",
    },
    {
      layout: multiParty ? "partner-hub" : "two-column-compare",
      actionTitle: multiParty
        ? "Each party owns a leg of the journey the others cannot cover"
        : "One integrated model replaces today's fragmented handoffs",
      purpose: "Show how the pieces fit together.",
      evidenceRefs: pack.parties.flatMap((party) =>
        party.chunks.slice(0, 1).map((chunk) => chunk.chunkId),
      ),
      tier: "sourced",
    },
    hasClaims
      ? {
          layout: "kpi-cards",
          actionTitle: "The evidence already shows what a focused change delivers",
          purpose: "Prove the case with sourced numbers.",
          evidenceRefs: [],
          tier: "sourced",
        }
      : {
          layout: "table-compact",
          actionTitle: "The offer is built from capabilities already delivered",
          purpose: "Set out the offer.",
          evidenceRefs: pack.chunks.slice(0, 2).map((chunk) => chunk.chunkId),
          tier: "sourced",
        },
    {
      layout: "process-roadmap",
      actionTitle: "A phased start reaches first value before the next quarter",
      purpose: "Show the delivery sequence.",
      evidenceRefs: [],
      tier: "inferred",
    },
    {
      layout: hasClaims ? "chart-with-takeaway" : "two-column-compare",
      actionTitle: hasClaims
        ? "The upside is large enough to justify a measured pilot"
        : "The proposed model removes the constraints that slow delivery",
      purpose: "Make the commercial case.",
      evidenceRefs: [],
      tier: hasClaims ? "sourced" : "inferred",
    },
    {
      layout: "shortcomings-table",
      actionTitle: "The risks are real and each has an owner",
      purpose: "Name the dependencies honestly.",
      evidenceRefs: [],
      tier: "inferred",
    },
    {
      layout: "next-steps-ask",
      actionTitle: "Approve a scoped pilot and name the decision owner",
      purpose: "Ask for the next step.",
      evidenceRefs: [],
      tier: "inferred",
    },
  ];
  return {
    deckTitle: brief.documentTitle || draft.title,
    audience: brief.audience ?? draft.audience ?? "Executive committee",
    storyline: `${client} faces a fragmented ${industry} operating model. The deck proposes one integrated route, proves it with comparable outcomes, and asks for a scoped pilot.`,
    slides: slides.map((slide) => ({ ...slide, evidenceRefs: [...new Set(slide.evidenceRefs)] })),
  };
}
