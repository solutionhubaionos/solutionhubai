/**
 * Step 3-pre (2): outline first, retrieval per section. The outline is derived
 * from the export brief so a Zurich insurance pitch and an InterGlobe aviation
 * proposal do not share headings, and each section carries its own retrieval
 * query rather than reusing one search for the whole document.
 */
import { z } from "zod";
import type { DocumentDraft, ExportBrief, SectionKind, SlideLayout } from "./types";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type ProviderOptions,
} from "./provider";
import { llmBudget } from "./llm-budget";

export type SectionPlan = {
  id: string;
  kind: SectionKind;
  title: string;
  /** Composition chosen at plan time; the contract for generation. */
  layout?: SlideLayout;
  /** Optional section tag shown in the slide header. */
  section?: string;
  /** What this section must establish, in one sentence. */
  goal: string;
  /** First hybrid-search query for this section alone. */
  query: string;
  /** Two or three targeted queries, built from the conversation's entities. */
  queries?: string[];
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
  "parties",
  "solution",
  "journey",
  "approach",
  "proof",
  "timeline",
  "deliverables",
  "assumptions",
  "pricing",
  "next_steps",
  "open_questions",
];

const DECK_KINDS: SectionKind[] = [
  "problem",
  "parties",
  "solution",
  "why_us",
  "proof",
  "how_it_works",
  "results",
  "timeline",
  "ask",
];

/** Kinds the planner may use, including request-specific slides. */
const EXTRA_KINDS: SectionKind[] = [
  "pointers",
  "shortcomings",
  "economics",
  "governance",
  "open_questions",
  "journey",
];

export function allowedKinds(mode: DocumentDraft["mode"]): SectionKind[] {
  return [...(mode === "proposal" ? PROPOSAL_KINDS : DECK_KINDS), ...EXTRA_KINDS];
}

/** Words that carry no search signal on their own. */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "what",
  "why",
  "how",
  "our",
  "you",
  "your",
  "needs",
  "into",
  "over",
  "under",
  "their",
  "they",
  "are",
  "was",
  "were",
  "will",
  "can",
  "not",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/** Conversation entities first; wizard values only when the brief had none. */
function subjectTerms(brief: ExportBrief): string[] {
  const strong = [...(brief.keyEntities ?? []), ...(brief.partiesInvolved ?? [])].filter(Boolean);
  if (strong.length > 0) return strong;
  return [brief.subject, brief.client, brief.industry].filter((value): value is string =>
    Boolean(value),
  );
}

/**
 * At most three short queries per section: "<entity canonical name> <section
 * topic>". The raw user request is never a query, and nothing runs past twelve
 * words, which is what the hybrid search actually matches well.
 */
export function sectionQueries(kind: SectionKind, title: string, brief: ExportBrief): string[] {
  const strong = subjectTerms(brief);
  const topic = words(title).slice(0, 5).join(" ");
  const candidates = [
    [strong[0], topic].filter(Boolean).join(" "),
    [strong[1], topic].filter(Boolean).join(" "),
    [strong[2], topic].filter(Boolean).join(" "),
    topic,
  ];

  const unique: string[] = [];
  for (const candidate of candidates) {
    const query = compactQuery(candidate);
    if (query.split(" ").length < 2) continue;
    if (unique.some((existing) => existing.toLowerCase() === query.toLowerCase())) continue;
    unique.push(query);
    if (unique.length === 3) break;
  }
  return unique.length > 0 ? unique : [compactQuery(title) || kind.replace(/_/g, " ")];
}

/** One short query string; twelve words is the documented ceiling. */
export function compactQuery(text: string, maxWords = 12): string {
  return text
    .replace(/[^\p{L}\p{N}&+%.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function queryFor(kind: SectionKind, brief: ExportBrief): string {
  return sectionQueries(kind, titleFor(kind, brief), brief)[0] ?? kind.replace(/_/g, " ");
}

/** The parties a document is about, used when the brief has no single client. */
function partyLabel(brief: ExportBrief): string | null {
  const names = [
    ...new Set(
      [...(brief.partiesInvolved ?? []), ...(brief.keyEntities ?? [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) return brief.client ?? brief.subject ?? null;
  return names.slice(0, 3).join(" x ");
}

function titleFor(kind: SectionKind, brief: ExportBrief): string {
  const client = brief.client;
  const industry = brief.industry;
  const parties = partyLabel(brief);
  switch (kind) {
    case "executive_summary":
      return "Executive summary";
    case "problem":
      return client
        ? `The challenge facing ${client}`
        : parties
          ? `The challenge facing ${parties}`
          : `${industry ?? "Market"} pressures and priorities`;
    case "solution":
      return client
        ? `What we propose for ${client}`
        : parties
          ? `What we propose for ${parties}`
          : "What we propose";
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
      return parties ? `Why this fits ${parties}` : "Why us";
    case "how_it_works":
      return "How it works";
    case "results":
      return industry ? `Results that matter in ${industry}` : "Results that matter";
    case "ask":
      return "The ask";
    case "parties":
      return "The parties and what each brings";
    case "pointers":
      return "Collaboration pointers";
    case "shortcomings":
      return "Shortcomings and risks";
    case "economics":
      return "Indicative economics";
    case "governance":
      return "Governance and KPIs";
    case "open_questions":
      return "Open questions";
    case "journey":
      return "The customer journey";
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
    case "parties":
      return "Name each party and the documented capability it brings; use a table when several parties are involved.";
    case "pointers":
      return "Give the practical collaboration pointers: who does what, what each party must supply and where handoffs sit.";
    case "shortcomings":
      return "State the gaps, dependencies and risks the library does not resolve; do not invent answers.";
    case "economics":
      return "Show the commercial logic with sourced figures only, or the labelled code assumptions model.";
    case "governance":
      return "Describe decision rights, cadence and the KPIs that show the partnership is working.";
    case "open_questions":
      return "List what the library cannot answer and what the client must confirm before launch.";
    case "journey":
      return "Walk the customer journey end to end, showing where each party acts.";
  }
}

/** Default composition per section kind; the planner may override it. */
export function defaultLayout(kind: SectionKind): SlideLayout {
  switch (kind) {
    case "executive_summary":
    case "problem":
    case "ask":
    case "next_steps":
    case "open_questions":
      return "text";
    case "parties":
    case "pointers":
    case "shortcomings":
    case "governance":
      return "table";
    case "economics":
    case "results":
      return "chart";
    case "journey":
    case "how_it_works":
      return "flow";
    case "timeline":
      return "timeline";
    case "proof":
    case "pricing":
    case "deliverables":
      return "table";
    case "why_us":
    case "approach":
    case "solution":
    case "assumptions":
      return "bullets";
  }
}

export function defaultPlans(brief: ExportBrief): SectionPlan[] {
  const kinds = brief.mode === "proposal" ? PROPOSAL_KINDS : DECK_KINDS;
  return kinds.slice(0, 12).map((kind, index) => {
    const title = titleFor(kind, brief);
    const queries = sectionQueries(kind, title, brief);
    return {
      id: `s${index + 1}`,
      kind,
      title,
      layout: defaultLayout(kind),
      section: sectionTagFor(kind),
      goal: goalFor(kind, brief),
      query: queries[0] ?? kind,
      queries,
      minChars: brief.mode === "proposal" ? 220 : 70,
      wantsNumbers: kind === "proof" || kind === "results",
    };
  });
}

/** Short section tag shown in the slide header. */
export function sectionTagFor(kind: SectionKind): string {
  switch (kind) {
    case "executive_summary":
      return "Summary";
    case "problem":
      return "Context";
    case "solution":
      return "The offer";
    case "approach":
    case "how_it_works":
      return "Delivery";
    case "proof":
    case "results":
      return "Evidence";
    case "timeline":
      return "Roadmap";
    case "deliverables":
      return "Deliverables";
    case "assumptions":
      return "Assumptions";
    case "pricing":
    case "economics":
      return "Commercials";
    case "next_steps":
    case "ask":
      return "Next steps";
    case "why_us":
      return "Why us";
    case "parties":
    case "pointers":
      return "Partners";
    case "shortcomings":
      return "Risks";
    case "governance":
      return "Governance";
    case "open_questions":
      return "Open items";
    case "journey":
      return "Journey";
  }
}

/** Request items the plan and deck must cover; detected in code, not by the LLM. */
export function mustIncludeItems(request: string): string[] {
  const items: string[] = [];
  if (/\bpointer/i.test(request)) items.push("pointers");
  if (/\bshortcom|\bshortfall|\bweakness|\brisks?\b|\bgaps?\b/i.test(request))
    items.push("shortcomings");
  if (/\bnumbers?\b|\bmetrics?\b|\bkpis?\b|\bfigures?\b|\bfootfall|\bpassengers?\b/i.test(request))
    items.push("numbers");
  if (/\bcharts?\b|\bgraphs?\b|\bpie\b|\bbar chart|\bvisual/i.test(request)) items.push("charts");
  if (/\bassumptions?\b/i.test(request)) items.push("assumptions");
  if (/\btables?\b/i.test(request)) items.push("tables");
  return [...new Set(items)];
}

const LAYOUTS: SlideLayout[] = [
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

const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        kind: z.string().trim().max(40).optional(),
        title: z.string().trim().min(3).max(120),
        layout: z.string().trim().max(20).optional(),
        section: z.string().trim().max(40).optional(),
        goal: z.string().trim().max(300).optional(),
        query: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(16),
});

export const OUTLINE_SYSTEM = [
  "You plan a client-ready sales document from a brief.",
  'Return JSON only: {"sections":[{"title":string,"layout":string,"section":string,"goal":string,"query":string}]}.',
  `Layouts: ${LAYOUTS.join(", ")}. Pick the layout the content needs.`,
  "Suggested coverage for a proposal: cover; executive summary; context; parties; offer/journey; collaboration pointers; operating model; economics; shortcomings and risks; governance and KPIs; roadmap; the ask; open questions. Adapt, merge or drop freely for this request; a pitch is tighter.",
  "Write each title as the takeaway of that slide in at most twelve words, not a generic label.",
  "If the brief asks for a separate pointers table or shortcomings table, include a slide for each.",
  "Use only the allowed kinds supplied. Do not invent facts, clients or figures.",
  "Do not add a cover, contents or sources section; those are added automatically.",
].join(" ");

/** Keeps the confirmed order and wording; layouts are validated, never invented. */
export function normalizePlans(
  incoming: readonly {
    kind?: string | undefined;
    title: string;
    layout?: string | undefined;
    section?: string | undefined;
    goal?: string | undefined;
    query?: string | undefined;
  }[],
  brief: ExportBrief,
): SectionPlan[] {
  const allowed = new Set(allowedKinds(brief.mode));
  const defaults = defaultPlans(brief);

  return incoming.slice(0, 12).map((entry, index) => {
    const kind = allowed.has(entry.kind as SectionKind)
      ? (entry.kind as SectionKind)
      : inferSectionKind(entry.title, index, brief.mode);
    const layout = LAYOUTS.includes(entry.layout as SlideLayout)
      ? (entry.layout as SlideLayout)
      : defaultLayout(kind);
    const queries = sectionQueries(kind, entry.title, brief);
    return {
      id: `s${index + 1}`,
      kind,
      title: entry.title.trim(),
      layout,
      section: entry.section?.trim() || sectionTagFor(kind),
      goal: entry.goal?.trim() || goalFor(kind, brief),
      query: compactQuery(entry.query ?? "") || queries[0] || entry.title,
      queries,
      minChars: defaults[0]?.minChars ?? 220,
      wantsNumbers: kind === "proof" || kind === "results" || kind === "economics",
    };
  });
}

/**
 * The plan must contain a slide for each request item detected in code. This
 * runs before the confirm card, so the added slides are part of the contract.
 */
export function ensurePlanCoverage(
  plans: readonly SectionPlan[],
  brief: ExportBrief,
): SectionPlan[] {
  const items = mustIncludeItems(brief.request);
  if (items.length === 0) return [...plans];
  const result = [...plans];
  const has = (pattern: RegExp) => result.some((plan) => pattern.test(plan.title));
  const make = (kind: SectionKind, title: string, layout: SlideLayout): SectionPlan => {
    const queries = sectionQueries(kind, title, brief);
    return {
      id: "",
      kind,
      title,
      layout,
      section: sectionTagFor(kind),
      goal: goalFor(kind, brief),
      query: queries[0] ?? title,
      queries,
      minChars: brief.mode === "proposal" ? 220 : 70,
      wantsNumbers: kind === "economics",
    };
  };
  const additions: SectionPlan[] = [];
  if (items.includes("pointers") && !has(/\bpointer|\bcollaboration|\bwho does what/i)) {
    additions.push(make("pointers", "Collaboration pointers: who does what", "table"));
  }
  if (items.includes("shortcomings") && !has(/\bshortcom|\brisks?\b|\bgaps?\b/i)) {
    additions.push(make("shortcomings", "Shortcomings, gaps and risks", "table"));
  }
  if (items.includes("numbers") && !has(/\beconomics|\bnumbers?\b|\bcommercial/i)) {
    additions.push(make("economics", "Indicative economics under stated assumptions", "chart"));
  }
  if (
    items.includes("charts") &&
    ![...result, ...additions].some((plan) => plan.layout === "chart")
  ) {
    additions.push(make("economics", "Illustrative demand and conversion scenarios", "chart"));
  }
  if (items.includes("assumptions") && !has(/\bassumption/i)) {
    additions.push(make("assumptions", "What the numbers assume", "table"));
  }
  if (
    items.includes("tables") &&
    ![...result, ...additions].some((plan) => plan.layout === "table")
  ) {
    additions.push(make("parties", "The parties and what each brings", "table"));
  }

  for (const addition of additions) {
    if (result.length >= 12) result.splice(Math.max(1, result.length - 1), 0, addition);
    else {
      const closingIndex = result.findIndex((plan) =>
        /open questions?|next steps?|the ask/i.test(plan.title),
      );
      result.splice(closingIndex >= 0 ? closingIndex : result.length, 0, addition);
    }
  }

  return result.slice(0, 12).map((plan, index) => ({ ...plan, id: `s${index + 1}` }));
}

/** The exact user turn the outline model sees; reused by the calibration script. */
export function outlineUserPrompt(brief: ExportBrief, draft: DocumentDraft): string {
  const allowed = allowedKinds(brief.mode);
  return [
    `Mode: ${brief.mode}`,
    `Allowed kinds: ${allowed.join(", ")}`,
    `Section count: ${brief.mode === "proposal" ? "8-12" : "8-10"}`,
    `Must include: ${mustIncludeItems(brief.request).join("; ") || "none"}`,
    `Request: ${brief.request}`,
    `Client: ${brief.client ?? "not stated"}`,
    `Industry: ${brief.industry ?? "not stated"}`,
    `Audience: ${brief.audience ?? "not stated"}`,
    `Parties: ${[...new Set([...(brief.partiesInvolved ?? []), ...(brief.keyEntities ?? [])])].join("; ") || "not stated"}`,
    `Problem from conversation: ${brief.problem ?? "not stated"}`,
    `Goals: ${brief.goals.join("; ") || "not stated"}`,
    `Constraints: ${brief.constraints.join("; ") || "not stated"}`,
    `Requested outline to respect: ${draft.outline.join(" | ") || "none"}`,
    "",
    "Plan the sections, tailored to this brief. Choose a layout per slide.",
  ].join("\n");
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
    const outcome = await completeWithBudget(
      [
        { role: "system", content: OUTLINE_SYSTEM },
        { role: "user", content: outlineUserPrompt(brief, draft) },
      ],
      options,
      llmBudget("OUTLINE"),
      0.2,
      { label: "export outline" },
    );

    const parsed = outlineSchema.parse(parseJsonValue(outcome.content));

    const plans = ensurePlanCoverage(normalizePlans(parsed.sections, brief), brief);
    if (plans.length < 6) throw new Error("outline returned too few usable sections");
    return { plans, usedFallback: false };
  } catch (error) {
    log("outline fell back", { reason: failureReasonOf(error), error: String(error) });
    return { plans: ensurePlanCoverage(fallback, brief), usedFallback: true };
  }
}

/** Test seam: deterministic plans for a brief. */
export function outlineForBrief(brief: ExportBrief): SectionPlan[] {
  return defaultPlans(brief);
}

/** Title keywords to section kinds, most specific first. */
const KIND_HINTS: [SectionKind, RegExp][] = [
  ["executive_summary", /\bexecutive summary\b|\bsummary\b/i],
  ["pointers", /\bpointer|\bcollaboration\b|\bwho does what|\bhandoff/i],
  ["shortcomings", /\bshortcom|\bweakness|\brisks?\b|\bdependencies|\bgaps?\b/i],
  ["open_questions", /\bopen questions?\b|\bto be (confirmed|decided)\b|\bunknowns?\b/i],
  ["parties", /\bparties\b|\bpartners?\b|\bconsortium|\bwhat each brings/i],
  ["economics", /\beconomics?|\bcommercial logic|\bp&l|\bmargin|\brevenue model/i],
  ["governance", /\bgovernance|\bdecision rights|\bkpis?\b|\boperating cadence/i],
  ["journey", /\bjourney|\bcustomer experience|\btouchpoint|\bfunnel\b/i],
  ["governance", /\boperating model\b|\bgovernance\b/i],
  [
    "problem",
    /\bwhy\b.*\b(now|need|matter|urgent)\b|\bchallenge|\bproblem|\bpressure|\bopportunity|\bcurrent state|\bcontext\b/i,
  ],
  ["pricing", /\bcommercial|\binvestment|\bpricing|\bcommercial model|\bbusiness case|\bvalue\b/i],
  ["proof", /\bproof|\bcase stud|\bevidence\b|\bcredential|\btrack record\b/i],
  ["deliverables", /\bwhat we deliver|\bdeliverable|\bwhat you (get|receive)|\boffer\b/i],
  [
    "approach",
    /\bhow (an|the) engagement|\bengagement|\bapproach|\bmethod|\bdelivery model|\bhow we work|\bgovernance\b/i,
  ],
  ["timeline", /\btimeline|\broadmap|\bphase|\bplan\b/i],
  ["results", /\bresults?\b|\boutcomes?\b|\bimpact\b/i],
  ["why_us", /\bwhy us\b|\bdifferentiat|\bwhy choose\b/i],
  ["how_it_works", /\bhow it works\b|\barchitecture|\boperating model|\bintegration\b/i],
  ["assumptions", /\bassumption|\brisk|\bdependenc/i],
  ["ask", /\bthe ask\b|\bdecision\b/i],
  ["next_steps", /\bnext step|\bwhat happens next|\bproposed next\b/i],
];

export function inferSectionKind(
  title: string,
  index: number,
  mode: DocumentDraft["mode"],
): SectionKind {
  const allowed = new Set(allowedKinds(mode));
  for (const [kind, pattern] of KIND_HINTS) {
    if (allowed.has(kind) && pattern.test(title)) return kind;
  }
  const fallback = mode === "proposal" ? PROPOSAL_KINDS : DECK_KINDS;
  return fallback[index % fallback.length] ?? "solution";
}

/**
 * The confirmed outline is the single source of truth: one plan per heading the
 * user agreed to, in that order, with that exact wording. Nothing regenerates or
 * reorders the list at build time.
 */
export function plansFromOutline(draft: DocumentDraft, brief: ExportBrief): SectionPlan[] {
  const titles = draft.outline.map((title) => title.trim()).filter(Boolean);
  if (titles.length === 0) return defaultPlans(brief);

  return titles.slice(0, 12).map((title, index) => {
    const kind = inferSectionKind(title, index, brief.mode);
    const hint = draft.outlinePlan?.[index];
    const hintMatches = hint?.title?.trim() === title;
    const queries = sectionQueries(kind, title, brief);
    return {
      id: `s${index + 1}`,
      kind,
      title,
      layout: (hintMatches ? hint?.layout : undefined) ?? defaultLayout(kind),
      section: (hintMatches ? hint?.section : undefined) ?? sectionTagFor(kind),
      goal: goalFor(kind, brief),
      query: queries[0] ?? title,
      queries,
      minChars: brief.mode === "proposal" ? 220 : 70,
      wantsNumbers: kind === "proof" || kind === "results" || kind === "economics",
    };
  });
}
