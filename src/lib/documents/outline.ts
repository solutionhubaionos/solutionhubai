/**
 * Step 3-pre (2): outline first, retrieval per section. The outline is derived
 * from the export brief so a Zurich insurance pitch and an InterGlobe aviation
 * proposal do not share headings, and each section carries its own retrieval
 * query rather than reusing one search for the whole document.
 */
import { z } from "zod";
import type { DocumentDraft, ExportBrief, SectionKind } from "./types";
import { completeJson, type ProviderOptions } from "./provider";

export type SectionPlan = {
  id: string;
  kind: SectionKind;
  title: string;
  /** What this section must establish, in one sentence. */
  goal: string;
  /** Hybrid-search query for this section alone. */
  query: string;
  minChars: number;
  /** Proof/results sections prefer chunks that contain measurable outcomes. */
  wantsNumbers: boolean;
};

export type OutlineOptions = ProviderOptions & {
  log?: (event: string, meta: Record<string, unknown>) => void;
};

const PROPOSAL_KINDS: SectionKind[] = [
  "executive_summary",
  "problem",
  "solution",
  "approach",
  "proof",
  "timeline",
  "deliverables",
  "assumptions",
  "pricing",
  "next_steps",
];

const DECK_KINDS: SectionKind[] = [
  "problem",
  "solution",
  "why_us",
  "proof",
  "how_it_works",
  "results",
  "timeline",
  "ask",
];

export function allowedKinds(mode: DocumentDraft["mode"]): SectionKind[] {
  return mode === "proposal" ? PROPOSAL_KINDS : DECK_KINDS;
}

function queryFor(kind: SectionKind, brief: ExportBrief): string {
  const industry = brief.industry ?? "";
  const client = brief.client ?? "";
  const topic = [client, industry, brief.sector].filter(Boolean).join(" ");
  switch (kind) {
    case "executive_summary":
      return `${topic} priorities outcomes proposal summary`;
    case "problem":
      return `${topic} challenges pressures priorities market transformation problem`;
    case "solution":
      return `${topic} solution capabilities platform what we deliver`;
    case "approach":
      return `delivery approach methodology phases governance workshops mobilisation`;
    case "proof":
      return `case study ${industry} measurable outcomes results reduced increased percent saved`;
    case "timeline":
      return `timeline implementation phases weeks months roadmap delivery plan`;
    case "deliverables":
      return `deliverables outputs artefacts roadmap workshop report`;
    case "assumptions":
      return `assumptions dependencies prerequisites scope client responsibilities`;
    case "pricing":
      return `pricing investment cost commercial model fees budget`;
    case "next_steps":
      return `next steps pilot workshop proposal mobilisation`;
    case "why_us":
      return `${industry} differentiators credentials experience why choose us`;
    case "how_it_works":
      return `${industry} how it works architecture integration process operating model`;
    case "results":
      return `results metrics kpi improvement outcomes ${industry} percent reduction increase`;
    case "ask":
      return `next steps pilot decision investment ask`;
  }
}

function titleFor(kind: SectionKind, brief: ExportBrief): string {
  const client = brief.client;
  const industry = brief.industry;
  switch (kind) {
    case "executive_summary":
      return "Executive summary";
    case "problem":
      return client
        ? `The challenge facing ${client}`
        : `${industry ?? "Market"} pressures and priorities`;
    case "solution":
      return client ? `What we propose for ${client}` : "What we propose";
    case "approach":
      return "How we would deliver it";
    case "proof":
      return industry ? `Proof: outcomes in ${industry}` : "Proof from comparable work";
    case "timeline":
      return "Indicative timeline";
    case "deliverables":
      return "What you receive";
    case "assumptions":
      return "Assumptions and dependencies";
    case "pricing":
      return "Investment";
    case "next_steps":
      return "Recommended next steps";
    case "why_us":
      return "Why us";
    case "how_it_works":
      return "How it works";
    case "results":
      return industry ? `Results that matter in ${industry}` : "Results that matter";
    case "ask":
      return "The ask";
  }
}

function goalFor(kind: SectionKind, brief: ExportBrief): string {
  const client = brief.client ?? "the client";
  switch (kind) {
    case "executive_summary":
      return `State the recommendation for ${client}, the value at stake and the evidence behind it in under 200 words.`;
    case "problem":
      return `Establish the client's situation and why acting now matters, using only evidence from the library or the conversation.`;
    case "solution":
      return "Describe the proposed capability and exactly what it changes for the client.";
    case "approach":
      return "Explain how the work would run: phases, governance, client involvement and quality gates.";
    case "proof":
      return "Give 2-3 comparable case studies with named clients, hard numbers and outcomes.";
    case "timeline":
      return "Lay out phases, durations and decision points that the sources actually support.";
    case "deliverables":
      return "List concrete outputs the client receives, with formats or cadence where the sources say so.";
    case "assumptions":
      return "State the dependencies and client responsibilities that must hold for the plan.";
    case "pricing":
      return "Include commercial figures only if a source states them; otherwise mark [To be confirmed].";
    case "next_steps":
      return "Recommend a specific, low-risk next step and who needs to decide.";
    case "why_us":
      return "Give the differentiators that the evidence supports, not generic claims.";
    case "how_it_works":
      return "Explain the mechanics in a way a non-technical buyer can follow.";
    case "results":
      return "Show measurable outcomes with baselines and units.";
    case "ask":
      return "State the decision or commitment requested now, and the immediate next action.";
  }
}

export function defaultPlans(brief: ExportBrief): SectionPlan[] {
  const kinds = brief.mode === "proposal" ? PROPOSAL_KINDS : DECK_KINDS;
  return kinds.map((kind) => ({
    id: kind,
    kind,
    title: titleFor(kind, brief),
    goal: goalFor(kind, brief),
    query: queryFor(kind, brief),
    minChars: brief.mode === "proposal" ? 220 : 70,
    wantsNumbers: kind === "proof" || kind === "results",
  }));
}

const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        kind: z.string().trim().max(40),
        title: z.string().trim().min(3).max(120),
        goal: z.string().trim().max(300).optional(),
        query: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(14),
});

const OUTLINE_SYSTEM = [
  "You plan a client-ready sales document from a brief.",
  'Return JSON only: {"sections":[{"kind":string,"title":string,"goal":string,"query":string}]}.',
  "Use only the allowed kinds supplied. Do not invent facts, clients or figures.",
  "For a proposal, keep the standard logical order. For a pitch deck, write each title as the takeaway of that slide, not a label.",
  "Each query is a short hybrid-search query for that section alone, including the client industry where relevant.",
  "Do not add a cover, contents or sources section; those are added automatically.",
].join(" ");

/** Keeps the standard order, the allowed kinds and the count bounds. */
export function normalizePlans(
  incoming: readonly {
    kind: string;
    title: string;
    goal?: string | undefined;
    query?: string | undefined;
  }[],
  brief: ExportBrief,
): SectionPlan[] {
  const allowed = new Set(allowedKinds(brief.mode));
  const defaults = defaultPlans(brief);
  const defaultByKind = new Map(defaults.map((plan) => [plan.kind, plan]));
  const seen = new Set<SectionKind>();
  const plans: SectionPlan[] = [];

  for (const entry of incoming) {
    const kind = entry.kind as SectionKind;
    if (!allowed.has(kind) || seen.has(kind)) continue;
    const fallback = defaultByKind.get(kind);
    seen.add(kind);
    plans.push({
      id: kind,
      kind,
      title: entry.title,
      goal: entry.goal?.trim() || fallback?.goal || goalFor(kind, brief),
      query: entry.query?.trim() || fallback?.query || queryFor(kind, brief),
      minChars: fallback?.minChars ?? (brief.mode === "proposal" ? 220 : 70),
      wantsNumbers: fallback?.wantsNumbers ?? (kind === "proof" || kind === "results"),
    });
  }

  // Fill any missing required kind in its canonical position, so a short model
  // response can never produce a document with no problem statement or ask.
  for (const fallback of defaults) {
    if (seen.has(fallback.kind)) continue;
    const index = defaults.findIndex((plan) => plan.kind === fallback.kind);
    plans.splice(Math.min(index, plans.length), 0, fallback);
    seen.add(fallback.kind);
  }

  return plans.slice(0, brief.mode === "proposal" ? 10 : 9);
}

/** Outline from the brief, with the mode's standard structure as the floor. */
export async function planOutline(
  brief: ExportBrief,
  draft: DocumentDraft,
  options: OutlineOptions,
): Promise<{ plans: SectionPlan[]; usedFallback: boolean }> {
  const log = options.log ?? (() => undefined);
  const fallback = defaultPlans(brief);
  const allowed = allowedKinds(brief.mode);

  try {
    const parsed = outlineSchema.parse(
      await completeJson(
        [
          { role: "system", content: OUTLINE_SYSTEM },
          {
            role: "user",
            content: [
              `Mode: ${brief.mode}`,
              `Allowed kinds: ${allowed.join(", ")}`,
              `Section count: ${brief.mode === "proposal" ? "8-10" : "8-9"}`,
              `Client: ${brief.client ?? "not stated"}`,
              `Industry: ${brief.industry ?? "not stated"}`,
              `Audience: ${brief.audience ?? "not stated"}`,
              `Problem from conversation: ${brief.problem ?? "not stated"}`,
              `Goals: ${brief.goals.join("; ") || "not stated"}`,
              `Constraints: ${brief.constraints.join("; ") || "not stated"}`,
              `Requested outline to respect: ${draft.outline.join(" | ")}`,
              "",
              "Plan the sections, tailored to this brief.",
            ].join("\n"),
          },
        ],
        options,
        900,
        0.2,
      ),
    );

    const plans = normalizePlans(parsed.sections, brief);
    if (plans.length < 6) throw new Error("outline returned too few usable sections");
    return { plans, usedFallback: false };
  } catch (error) {
    log("outline fell back", { error: String(error) });
    return { plans: fallback, usedFallback: true };
  }
}

/** Test seam: deterministic plans for a brief. */
export function outlineForBrief(brief: ExportBrief): SectionPlan[] {
  return defaultPlans(brief);
}
