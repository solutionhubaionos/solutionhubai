/**
 * Stage 2: the writer. One call per planned slide, strict JSON for the layout
 * the planner chose. Numbers may only appear through a claim id, and the layout
 * schemas refuse overflow before it reaches the renderer — there is no paging
 * and no "(continued)" slide.
 */
import type { ExportBrief, DocumentDraft } from "../types";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type ProviderOptions,
} from "../provider";
import { llmBudget, withMaxTokens } from "../llm-budget";
import { contentSchemaFor, DeckWriterSchema, layoutSpec, tableProblem } from "./catalog";
import { fitContent, layoutShape } from "./shapes";
import type { DeckPlanSlide, DeckSlideContent, DeckSpecSlide, EvidenceTier } from "./types";
import type { EvidencePack } from "./evidence";
import { claimsForPrompt } from "./evidence";
import {
  cleanSlideText,
  hasBannedCopy,
  stripPromptEcho,
  sanitiseSlide,
  sanitiseTitle,
  stripUnresolvedTokens,
} from "./text-guards";
import { untracedNumbers } from "./claims";
import { AIONOS_AGENT_GUIDE } from "../brand-guide";
import { roleForParty } from "./entities";

export type WriterOptions = ProviderOptions & {
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export const WRITER_SYSTEM = [
  AIONOS_AGENT_GUIDE,
  "You write one slide of a client-ready sales deck for Aionos. Return JSON only, no fences.",
  'Shape: {"content":{"layout":string,...},"notes":string,"sourceNote":string}.',
  "Fill the layout you are given. Do not change its layout id and do not add a second layout.",
  "A number may appear only if it comes from a claim: either use the placeholder {{CL-3}} in the copy, or put the claim id in claimIds beside the text. Never type a figure that is not in the claim registry, and never estimate, extrapolate or round into a new claim.",
  "Every bullet, table cell and KPI label must be client-facing English. Never write the words library, passage, evidence, source, chunk or citation. Never hedge, never say what is missing and never mention the brief or the user's request.",
  "Never invent a company, date, quotation, outcome or product name. Use only the validated parties and the supplied claims.",
  "Action titles, slide copy and table headers describe the client's business, not our process. No 'Documented capability', 'Evidence' or 'What the library documents' columns.",
  "Write in British English, active voice, confident and concrete. Notes are 2-4 sentences of presenter talking points only: no claim ids, file names, passage references, other customers' names or audit caveats.",
  "Aggressive localisation is mandatory. When a target client is supplied, rewrite every heading, bullet, table cell and sentence into that client's voice and context. Replace any previous client's name with the target client's name. Never leave reusable template copy that would fit any company.",
  "Reference customers are anonymised in the evidence as neutral labels such as 'peer airline A'. Never name a library customer in any slide, table, chart, footer or note. A peer may appear only as prior work, stated once on the proof slide, and never as a repeated template sentence.",
  "Never present a peer's systems, products, staff counts, integrations, results or numbers as the target's. A chart built from reference figures is an illustrative peer benchmark, never the target's forecast or revenue opportunity.",
  "Do not use model memory about the target client. Facts such as its loyalty programme, hub structure, fleet, route count, size or market position may appear only when supplied in the brief, the user's note or the website description. Otherwise write generically or leave the fact out.",
  "Prefer the target's own vocabulary from the brief and evidence (for example terminals, passenger volumes, sales systems, programme names). If the evidence has no client-specific number, keep the claim qualitative and record the gap only in the presenter's plain caveat, never in the slide copy.",
  "Never hard-code colours, logos, fonts or visual styling. The renderer applies the approved brand kit.",
].join(" ");

function tierFor(plan: DeckPlanSlide, pack: EvidencePack): EvidenceTier {
  if (plan.tier === "illustrative") {
    return Object.keys(pack.claims).length > 0 ? "illustrative" : "inferred";
  }
  return plan.tier === "inferred" ? "inferred" : "sourced";
}

/** The passages this slide's prompt actually supplied, recorded for the audit. */
function evidenceIdsForSlide(plan: DeckPlanSlide, pack: EvidencePack): string[] {
  const refs = new Set(plan.evidenceRefs);
  const chosen = pack.chunks.filter((chunk) => refs.size === 0 || refs.has(chunk.chunkId));
  return (chosen.length > 0 ? chosen : pack.chunks).slice(0, 6).map((chunk) => chunk.chunkId);
}

function evidenceForSlide(plan: DeckPlanSlide, pack: EvidencePack): string {
  const refs = new Set(plan.evidenceRefs);
  const chosen = pack.chunks.filter((chunk) => refs.size === 0 || refs.has(chunk.chunkId));
  const pool = chosen.length > 0 ? chosen : pack.chunks;
  return pool
    .slice(0, 6)
    .map((chunk) => {
      const owner = chunk.customerName ? ` · reference: ${chunk.customerName}` : "";
      const where = chunk.heading ? ` · ${chunk.heading}` : "";
      return `[${chunk.chunkId}] ${chunk.title}${where}${owner}\n${chunk.content.slice(0, 1200)}`;
    })
    .join("\n\n");
}

export function writerUserPrompt(
  plan: DeckPlanSlide,
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
): string {
  return [
    `Layout: ${plan.layout}`,
    `Layout brief: ${layoutSpec(plan.layout).when}`,
    `Capacity: ${layoutSpec(plan.layout).capacity}`,
    `Action title (do not repeat it in the content): ${plan.actionTitle}`,
    `Purpose: ${plan.purpose}`,
    `Evidence tier: ${tierFor(plan, pack)}`,
    "",
    'Return one JSON object with three keys: {"content": <the layout object below>, "notes": "2-4 presenter sentences, no ids or file names", "sourceNote": "optional, max 120 characters"}.',
    "The `content` object must be exactly this shape, with the placeholder text replaced. Keep the field names, keep the layout id, and respect every limit:",
    layoutShape(plan.layout),
    "",
    `Validated parties: ${pack.parties.map((party) => party.name).join("; ") || "none"}`,
    pack.parties.some((party) => party.gap)
      ? `Propose a role in our own voice for: ${pack.parties
          .filter((party) => party.gap)
          .map((party) => party.name)
          .join("; ")}`
      : "",
    "",
    "Claims (the only figures you may use). A claim marked * is a public source fact: cite it with its asterisk and keep it out of any library-sourced argument:",
    claimsForPrompt(pack),
    "",
    "Passages (the only facts you may use):",
    evidenceForSlide(plan, pack),
    "",
    `Client: ${brief.client ?? draft.client ?? "not stated"}; industry: ${brief.industry ?? draft.industry ?? "not stated"}; audience: ${brief.audience ?? draft.audience ?? "executive"}.`,
    brief.targetContext
      ? `What we know about the client (their own website wording; the only facts you may state about them): ${brief.targetContext}`
      : "",
    pack.targetClient
      ? `Target client (write every sentence for this client): ${pack.targetClient}`
      : "Target client: not named.",
    pack.referenceCustomers.length > 0
      ? `Reference customers in the evidence are anonymised as neutral labels. Never print a library customer's real name.`
      : "Reference customers: none.",
    "",
    "Return JSON only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function firstSentence(text: string, max = 120): string {
  const sentence = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)[0] ?? text;
  return sentence.trim().slice(0, max);
}

/** Deterministic content from the evidence when the writer cannot be used. */
export function fallbackSlideContent(plan: DeckPlanSlide, pack: EvidencePack): DeckSlideContent {
  const claims = Object.values(pack.claims);
  const parties = pack.parties;
  switch (plan.layout) {
    case "section-divider":
      return {
        layout: "section-divider",
        label: plan.actionTitle.slice(0, 60),
        statement: plan.purpose,
      };
    case "kpi-cards":
      if (claims.length >= 2) {
        return {
          layout: "kpi-cards",
          cards: claims.slice(0, 4).map((claim) => ({
            label: claim.metric.slice(0, 60) || "Measured result",
            claimId: claim.id,
          })),
        };
      }
      return fallbackSlideContent({ ...plan, layout: "context-bullets" }, pack);
    case "partner-hub":
      if (parties.length >= 2) {
        return {
          layout: "partner-hub",
          centre: "Integrated customer proposition",
          spokes: parties.slice(0, 6).map((party) => ({
            entity: party.name,
            role: roleForParty(party.name, party.chunks),
            claimIds: party.claims.slice(0, 2).map((claim) => claim.id),
            inferred: party.gap,
          })),
        };
      }
      return fallbackSlideContent({ ...plan, layout: "context-bullets" }, pack);
    case "two-column-compare":
    case "before-after":
      return {
        layout: plan.layout,
        left: {
          heading: "Today",
          points: [
            "Work is split across teams and tools, which slows every handoff.",
            "Data is re-keyed between systems, so the same task is paid for twice.",
            "Leaders see outcomes late, which delays the next decision.",
          ],
        },
        right: {
          heading: "With the proposed model",
          points: [
            "One intake and one queue give every case a clear owner.",
            "Shared data removes re-keying and shortens the cycle.",
            "A weekly performance view keeps the change on track.",
          ],
        },
      };
    case "process-roadmap":
      return {
        layout: "process-roadmap",
        steps: [
          {
            label: "Diagnose",
            detail: "Two weeks to map the current flow and agree the baseline.",
          },
          { label: "Pilot", detail: "One business unit proves the model before wider rollout." },
          { label: "Scale", detail: "The proven pattern is extended to the remaining teams." },
        ],
      };
    case "table-compact":
      return {
        layout: "table-compact",
        headers: ["Offer line", "What changes"],
        rows:
          parties.length >= 2
            ? parties
                .slice(0, 5)
                .map((party) => [party.name, roleForParty(party.name, party.chunks)])
            : [
                ["Intake", "A single front door for every request"],
                ["Triage", "Rules and AI route work to the right owner"],
                ["Performance", "One weekly view of cost, speed and quality"],
              ],
      };
    case "shortcomings-table":
      return {
        layout: "shortcomings-table",
        headers: ["Risk", "How we manage it"],
        rows: [
          ["Data quality", "Profile the source data before the pilot starts."],
          ["Adoption", "Name a business owner in each team from week one."],
          ["Scope creep", "Fix the pilot boundary and review it weekly."],
          ...(pack.gaps.length > 0 ? [["Evidence gap", pack.gaps[0]!.slice(0, 110)]] : []),
        ].slice(0, 5),
      };
    case "collaboration-pointers-table":
      return {
        layout: "collaboration-pointers-table",
        headers: ["Party", "What they own"],
        rows:
          parties.length > 0
            ? parties
                .slice(0, 5)
                .map((party) => [party.name, roleForParty(party.name, party.chunks)])
            : [["Aionos", "Design, delivery and measurement"]],
      };
    case "chart-with-takeaway": {
      const numeric = claims.filter((claim) => claim.valueMin !== null);
      if (numeric.length >= 2) {
        return {
          layout: "chart-with-takeaway",
          chart: {
            kind: "bar",
            title: numeric[0]?.metric || "Measured outcomes",
            series: [
              {
                name: "Reported result",
                points: numeric.slice(0, 6).map((claim) => ({
                  label: claim.sourceTitle.slice(0, 36),
                  claimId: claim.id,
                })),
              },
            ],
          },
          takeaway: `Comparable work reports results including {{${numeric[0]!.id}}}, which supports a measured pilot.`,
        };
      }
      return fallbackSlideContent({ ...plan, layout: "two-column-compare" }, pack);
    }
    case "image-with-caption":
      return fallbackSlideContent({ ...plan, layout: "context-bullets" }, pack);
    case "next-steps-ask":
      return {
        layout: "next-steps-ask",
        ask: plan.actionTitle,
        steps: [
          {
            text: "Agree the pilot scope and success measures.",
            owner: "Joint",
            when: "Next two weeks",
          },
          {
            text: "Name the business owner and the delivery lead.",
            owner: "Client",
            when: "Before kick-off",
          },
          {
            text: "Start the diagnostic with a fixed four-week review.",
            owner: "Aionos",
            when: "First month",
          },
        ],
      };
    case "maturity-progression":
      return {
        layout: "maturity-progression",
        stages: [
          {
            label: "Disconnected records",
            descriptor: "Teams keep their own copies, so every handover needs re-checking.",
          },
          {
            label: "Shared definitions",
            descriptor: "One agreed set of measures makes performance comparable across teams.",
          },
          {
            label: "Integrated flow",
            descriptor: "Work moves through one flow with a named owner at each step.",
          },
          {
            label: "Predictive decisions",
            descriptor: "Early signals let leaders act before the outcome is fixed.",
          },
        ],
        currentStage: 1,
        targetStage: 3,
      };
    case "three-horizon":
      return {
        layout: "three-horizon",
        horizons: [
          {
            label: "Now",
            description: "Stabilise the core and remove the most expensive handoffs.",
            outcomes: [
              "One owner for each step",
              "Shared baseline measures",
              "Faster, visible case progress",
            ],
          },
          {
            label: "Next",
            description: "Connect the workflow end to end and automate the routine work.",
            outcomes: ["Automated routing", "One performance view", "Shorter cycle time"],
          },
          {
            label: "Later",
            description: "Use the shared data to predict demand and prevent failures.",
            outcomes: ["Early warning signals", "Scenario planning", "Continuous improvement"],
          },
        ],
      };
    case "layered-architecture":
      return {
        layout: "layered-architecture",
        layers: [
          {
            label: "Experience",
            items: ["Client portal", "Operations console", "Executive view"],
          },
          {
            label: "Decisions",
            items: ["Rules and routing", "Agent assistance", "Workflow orchestration"],
          },
          {
            label: "Data",
            items: ["Shared definitions", "Event history", "Quality controls"],
          },
        ],
      };
    case "context-bullets":
    default: {
      const bullets: { text: string; claimIds: string[] }[] = [];
      for (const party of parties) {
        const chunk = party.chunks[0];
        if (chunk) {
          bullets.push({
            text: cleanSlideText(firstSentence(chunk.content, 130)),
            claimIds: party.claims.slice(0, 1).map((claim) => claim.id),
          });
        } else if (party.gap) {
          bullets.push({ text: `${party.name}: role and scope to agree with them.`, claimIds: [] });
        }
      }
      for (const chunk of pack.genericChunks) {
        if (bullets.length >= 4) break;
        bullets.push({ text: cleanSlideText(firstSentence(chunk.content, 130)), claimIds: [] });
      }
      if (bullets.length < 2) {
        bullets.push(
          { text: "The current model splits ownership and slows every handoff.", claimIds: [] },
          { text: "One integrated flow gives every case a clear owner.", claimIds: [] },
        );
      }
      return { layout: "context-bullets", bullets: bullets.slice(0, 4) };
    }
  }
}

function fallbackSpecSlide(
  plan: DeckPlanSlide,
  pack: EvidencePack,
  warning: string,
): DeckSpecSlide {
  const content = fallbackSlideContent(plan, pack);
  const sanitised = sanitiseSlide(content, [], pack.claims);
  return {
    id: `slide-${plan.actionTitle.slice(0, 24)}`,
    layout: sanitised.content.layout,
    actionTitle: sanitiseTitle(plan.actionTitle, sanitised.claimIds, pack.claims),
    purpose: plan.purpose,
    tier: tierFor(plan, pack),
    content: sanitised.content,
    notes: "Walk the client through the point on this slide and agree the next step.",
    claimIds: sanitised.claimIds,
    evidenceIds: evidenceIdsForSlide(plan, pack),
  };
}

export async function writeSlide(
  plan: DeckPlanSlide,
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
  options: WriterOptions,
): Promise<{ slide: DeckSpecSlide; warnings: string[] }> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const messages = [
    { role: "system" as const, content: WRITER_SYSTEM },
    { role: "user" as const, content: writerUserPrompt(plan, brief, draft, pack) },
  ];
  const schema = contentSchemaFor(plan.layout);
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
                content: `That slide was rejected: ${String(lastError).slice(0, 500)}. Return only {"content": <layout object>, "notes": string, "sourceNote": string} with the same layout and these exact content field names:\n${layoutShape(plan.layout)}`,
              },
            ],
        options,
        withMaxTokens(llmBudget("DECK"), 4_000, false),
        attempt === 0 ? 0.25 : 0.1,
        { label: `deck writer ${plan.layout}${attempt > 0 ? ":retry" : ""}` },
      );
      const parsed = DeckWriterSchema.parse(parseJsonValue(outcome.content));
      const parsedContent = parsed.content as DeckSlideContent;
      if (parsedContent.layout !== plan.layout) {
        throw new Error(`expected layout ${plan.layout}, received ${parsedContent.layout}`);
      }
      // Models cannot count characters. Shorten copy to the layout capacity
      // before validating, so length alone never costs a retry.
      const fitted = fitContent(parsedContent);
      schema.parse(fitted);
      if (
        (fitted.layout === "table-compact" ||
          fitted.layout === "shortcomings-table" ||
          fitted.layout === "collaboration-pointers-table") &&
        tableProblem(fitted)
      ) {
        throw new Error(tableProblem(fitted) ?? "invalid table");
      }
      const sanitised = sanitiseSlide(fitted, rawClaimIds(fitted), pack.claims);
      if (sanitised.removed.length > 0) {
        warnings.push(
          `${plan.actionTitle}: an unsupported figure was removed from the slide copy.`,
        );
      }
      const notes = stripPromptEcho(
        stripUnresolvedTokens(cleanSlideText(parsed.notes)) ||
          "Walk the client through the point on this slide and agree the next step.",
        draft.prompt,
      );
      const title = sanitiseTitle(plan.actionTitle, sanitised.claimIds, pack.claims);
      if (hasBannedCopy(title)) throw new Error("action title contains internal language");
      if (untracedNumbers(title, sanitised.claimIds, pack.claims).length > 0) {
        throw new Error("action title contains an unsupported figure");
      }
      const untraced = visibleStrings(sanitised.content).flatMap((text) =>
        untracedNumbers(text, sanitised.claimIds, pack.claims),
      );
      if (untraced.length > 0) {
        throw new Error(`unsupported figures: ${[...new Set(untraced)].join(", ")}`);
      }
      return {
        slide: {
          id: `slide-${plan.actionTitle.slice(0, 24)}`,
          layout: sanitised.content.layout,
          actionTitle: title,
          purpose: plan.purpose,
          tier: tierFor(plan, pack),
          content: sanitised.content,
          notes,
          ...(parsed.sourceNote
            ? { sourceNote: stripUnresolvedTokens(cleanSlideText(parsed.sourceNote)).slice(0, 120) }
            : {}),
          claimIds: sanitised.claimIds,
          evidenceIds: evidenceIdsForSlide(plan, pack),
        },
        warnings,
      };
    } catch (error) {
      lastError = error;
      log("deck writer attempt failed", {
        layout: plan.layout,
        attempt: attempt + 1,
        reason: failureReasonOf(error),
        error: String(error).slice(0, 240),
      });
    }
  }

  warnings.push(`"${plan.actionTitle}" was recovered from evidence after the writer failed.`);
  return { slide: fallbackSpecSlide(plan, pack, String(lastError).slice(0, 160)), warnings };
}

/** Every claim id a content object references. */
export function rawClaimIds(content: DeckSlideContent): string[] {
  const ids: string[] = [];
  const push = (value: string | undefined) => {
    if (value) ids.push(value);
  };
  switch (content.layout) {
    case "kpi-cards":
      for (const card of content.cards) push(card.claimId);
      break;
    case "partner-hub":
      for (const spoke of content.spokes) ids.push(...spoke.claimIds);
      break;
    case "context-bullets":
      for (const bullet of content.bullets) {
        ids.push(...bullet.claimIds);
        for (const match of bullet.text.matchAll(/\{\{\s*(CL-\d{1,4})\s*\}\}/g)) push(match[1]);
      }
      break;
    case "chart-with-takeaway":
      for (const series of content.chart.series)
        for (const point of series.points) push(point.claimId);
      break;
    default:
      break;
  }
  return [...new Set(ids)];
}

/** Every reader-visible string in a slide, for number and language checks. */
export function visibleStrings(content: DeckSlideContent): string[] {
  const strings: string[] = [];
  const add = (...values: (string | undefined)[]) => {
    for (const value of values) if (value) strings.push(value);
  };
  switch (content.layout) {
    case "section-divider":
      add(content.label, content.statement);
      break;
    case "context-bullets":
      for (const bullet of content.bullets) add(bullet.text);
      break;
    case "kpi-cards":
      for (const card of content.cards) add(card.label, card.note);
      break;
    case "partner-hub":
      add(content.centre);
      for (const spoke of content.spokes) add(spoke.entity, spoke.role);
      break;
    case "two-column-compare":
    case "before-after":
      add(content.left.heading, content.right.heading);
      strings.push(...content.left.points, ...content.right.points);
      break;
    case "table-compact":
    case "shortcomings-table":
    case "collaboration-pointers-table":
      strings.push(...content.headers, ...content.rows.flat());
      break;
    case "process-roadmap":
      for (const step of content.steps) add(step.label, step.detail);
      break;
    case "chart-with-takeaway":
      add(content.chart.title, content.chart.unit, content.takeaway);
      for (const series of content.chart.series) {
        add(series.name);
        for (const point of series.points) add(point.label);
      }
      break;
    case "image-with-caption":
      add(content.caption, content.sourceNote);
      break;
    case "next-steps-ask":
      add(content.ask);
      for (const step of content.steps) add(step.text, step.owner, step.when);
      break;
    case "maturity-progression":
      for (const stage of content.stages) add(stage.label, stage.descriptor);
      break;
    case "three-horizon":
      for (const horizon of content.horizons) {
        add(horizon.label, horizon.description);
        strings.push(...horizon.outcomes);
      }
      break;
    case "layered-architecture":
      for (const layer of content.layers) {
        add(layer.label);
        strings.push(...layer.items);
      }
      break;
  }
  return strings;
}

/** Small concurrency cap so a ten-slide deck does not open ten provider calls. */
export async function writeDeck(
  slides: readonly DeckPlanSlide[],
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
  options: WriterOptions,
  concurrency = 3,
): Promise<{ slides: DeckSpecSlide[]; warnings: string[] }> {
  const results: DeckSpecSlide[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, slides.length) }, async () => {
    while (cursor < slides.length) {
      const index = cursor;
      cursor += 1;
      const plan = slides[index]!;
      const written = await writeSlide(plan, brief, draft, pack, options);
      results[index] = written.slide;
      warnings.push(...written.warnings);
    }
  });
  await Promise.all(workers);
  return { slides: results, warnings };
}

export { tierFor };
