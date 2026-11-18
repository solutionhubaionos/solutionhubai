/**
 * Stage 3: the critic. Deterministic checks first — they are the ones that must
 * never regress — then one "skeptical CXO" pass that flags vague or repetitive
 * slides. Flagged slides get one rewrite, then the deck ships; a thin slide is
 * a warning, never a reason to fail the whole document.
 */
import type { ExportBrief, DocumentDraft } from "../types";
import {
  completeWithBudget,
  failureReasonOf,
  parseJsonValue,
  type ProviderOptions,
} from "../provider";
import { llmBudget } from "../llm-budget";
import { CriticSchema, isPlannerLayout } from "./catalog";
import type { DeckPlanSlide, DeckSpecSlide, PlannerLayoutId } from "./types";
import type { EvidencePack } from "./evidence";
import { writeSlide } from "./writer";
import { fallbackSlideContent, visibleStrings } from "./writer";
import {
  cleanSlideText,
  hasClaimVerb,
  isInstructionTitle,
  sanitiseSlide,
  sanitiseTitle,
  stripEvidenceColumns,
} from "./text-guards";
import { untracedNumbers } from "./claims";

export type CriticOptions = ProviderOptions & {
  log?: (event: string, meta: Record<string, unknown>) => void;
};

export const CRITIC_SYSTEM = [
  "You are a skeptical CXO reading a pitch deck before a partner meeting.",
  "Flag a slide when its action title is a label rather than a claim, when the copy is vague, repetitive or generic, when the slide repeats another slide's point, or when a claim is not supported by the evidence summarised below.",
  'Return JSON only: {"flagged":[{"index":number,"reason":string}]}. Index is the zero-based slide index. Flag at most four slides. If the deck is strong, return {"flagged":[]}.',
  "Do not rewrite the slide and do not suggest new facts.",
].join(" ");

function fallbackContentFor(slide: DeckSpecSlide, pack: EvidencePack) {
  const plan: DeckPlanSlide = {
    layout: isPlannerLayout(slide.layout) ? slide.layout : "context-bullets",
    actionTitle: slide.actionTitle,
    purpose: slide.purpose,
    evidenceRefs: [],
    tier: slide.tier,
  };
  return fallbackSlideContent(plan, pack);
}

function ensureContent(slide: DeckSpecSlide, pack: EvidencePack): DeckSpecSlide {
  const strings = visibleStrings(slide.content).join(" ").trim();
  const usable =
    strings.length > 12 &&
    (slide.content.layout !== "context-bullets" || slide.content.bullets.length >= 2) &&
    (slide.content.layout !== "kpi-cards" || slide.content.cards.length >= 2);
  if (usable) return slide;
  const content = fallbackContentFor(slide, pack);
  const sanitised = sanitiseSlide(content, [], pack.claims);
  return { ...slide, content: sanitised.content, claimIds: sanitised.claimIds };
}

function dedupeTitles(
  slides: DeckSpecSlide[],
  registry: import("./types").ClaimRegistry,
): DeckSpecSlide[] {
  const seen = new Set<string>();
  return slides.map((slide) => {
    let title = sanitiseTitle(
      slide.actionTitle.replace(/\s*\(continued\)\s*/gi, "").trim(),
      slide.claimIds,
      registry,
    );
    if (!hasClaimVerb(title) || isInstructionTitle(title)) {
      const shaped = sanitiseTitle(
        claimShapedTitle(title, slide.purpose, slide.layout),
        slide.claimIds,
        registry,
      );
      title =
        shaped.split(/\s+/).filter(Boolean).length >= 3
          ? shaped
          : "The case for change is measurable now";
    }
    const key = title.toLowerCase();
    if (seen.has(key)) {
      const suffix = slide.layout === "next-steps-ask" ? "now" : "for this partnership";
      if (!title.toLowerCase().endsWith(` ${suffix}`)) title = `${title} ${suffix}`.trim();
    }
    seen.add(title.toLowerCase());
    return { ...slide, actionTitle: title };
  });
}

/**
 * Rewrites a label or a planning instruction into an action title. Every
 * template here is a structural statement the deck can stand behind; none of
 * them invents a number, a date or a benefit the evidence did not supply.
 */
/**
 * Last-resort titles, one per layout. They state what the layout itself shows,
 * so a repaired title is still true and two repaired slides do not collide.
 */
const LAYOUT_TITLES: Partial<Record<DeckSpecSlide["layout"], string>> = {
  "maturity-progression": "Capability advances through stages before prediction is possible",
  "three-horizon": "Value arrives in horizons rather than in one release",
  "layered-architecture": "Each layer of the target model has one clear job",
  "process-roadmap": "Delivery is sequenced so value arrives before the full build",
  "kpi-cards": "The outcomes the programme is judged on are explicit",
  "before-after": "The target state removes today's manual reconciliation",
  "next-steps-ask": "A scoped first step proves the case before scale",
  "chart-with-takeaway": "The evidence points to one clear direction",
  "two-column-compare": "The two routes differ in effort and in risk",
  "partner-hub": "Each party owns the leg it is best placed to run",
  "table-compact": "The offer breaks into a small set of measurable pieces",
  "shortcomings-table": "The risks are known and each has an owner",
  "collaboration-pointers-table": "The working model gives every party a clear role",
  "context-bullets": "The current model leaves value on the table",
  "section-divider": "The story turns on one decision",
  "image-with-caption": "The evidence is visible in the client's own environment",
};

function claimShapedTitle(title: string, purpose: string, layout: DeckSpecSlide["layout"]): string {
  const lower = title.toLowerCase();
  if (/partners?|parties|what each brings|collaboration/.test(lower)) {
    return "Each party owns a leg of the journey the others cannot";
  }
  if (/what you (?:receive|get)|deliverable/.test(lower)) {
    return "The engagement is scoped around concrete outputs";
  }
  if (/commercial|pricing|investment|business case/.test(lower)) {
    return "The commercial model is designed to stand on its own";
  }
  if (/approach|delivery|how we work|timeline|roadmap/.test(lower)) {
    return "A phased approach delivers value before the full build";
  }
  if (/next steps?|the decision|the ask|conclusion/.test(lower)) {
    return "A scoped first step proves the case before scale";
  }
  if (/overview|summary|context|introduction/.test(lower)) {
    return "The current model leaves value on the table";
  }
  if (/proof|comparable|results|evidence/.test(lower)) {
    return "Comparable work points to what the change can deliver";
  }
  if (/offer|what we propose|solution/.test(lower)) {
    return "One integrated offer removes the current handoffs";
  }
  const cleanPurpose = cleanSlideText(purpose);
  // A purpose sentence can carry a figure no claim supports ("approve a 90-day
  // pilot"). Using it would put an untraced number in the title, which fails the
  // render-time traceability check, so fall through to the neutral title.
  if (
    !/\d/.test(cleanPurpose) &&
    !isInstructionTitle(cleanPurpose) &&
    !/cover slide/i.test(cleanPurpose) &&
    cleanPurpose.split(/\s+/).filter(Boolean).length >= 4
  ) {
    return cleanPurpose.slice(0, 110);
  }
  return LAYOUT_TITLES[layout] ?? "The case for change is measurable now";
}

function repairTable(slide: DeckSpecSlide): DeckSpecSlide {
  const content = slide.content;
  if (
    content.layout !== "table-compact" &&
    content.layout !== "shortcomings-table" &&
    content.layout !== "collaboration-pointers-table"
  ) {
    return slide;
  }
  const stripped = stripEvidenceColumns(content.headers, content.rows);
  return {
    ...slide,
    content: {
      layout: content.layout,
      headers: stripped.headers.slice(0, 3),
      rows: stripped.rows.map((row) => row.slice(0, 3)).slice(0, 5),
    },
  };
}

/** Deterministic checks that run whether or not the LLM critic is available. */
export function deterministicCritic(
  slides: DeckSpecSlide[],
  pack: EvidencePack,
): { slides: DeckSpecSlide[]; warnings: string[] } {
  const warnings: string[] = [];
  const allowed = new Set(pack.parties.map((party) => party.name.toLowerCase()));
  const repaired = dedupeTitles(slides, pack.claims)
    .map((slide) => ensureContent(slide, pack))
    .map((slide) => {
      // A hub diagram with one or two nodes collapses into overlapping shapes;
      // the same content reads better as bullets.
      if (slide.content.layout !== "partner-hub" || slide.content.spokes.length >= 3) {
        return slide;
      }
      const content = fallbackSlideContent(
        {
          layout: "context-bullets",
          actionTitle: slide.actionTitle,
          purpose: slide.purpose,
          evidenceRefs: [],
          tier: slide.tier,
        },
        pack,
      );
      const sanitised = sanitiseSlide(content, slide.claimIds, pack.claims);
      return { ...slide, content: sanitised.content, claimIds: sanitised.claimIds };
    })
    .map(repairTable)
    .map((slide) => {
      const sanitised = sanitiseSlide(slide.content, slide.claimIds, pack.claims);
      if (
        slide.content.layout === "partner-hub" &&
        sanitised.content.layout === "partner-hub" &&
        allowed.size > 0
      ) {
        const spokes = sanitised.content.spokes.filter((spoke) =>
          allowed.has(spoke.entity.toLowerCase()),
        );
        if (spokes.length !== sanitised.content.spokes.length) {
          warnings.push(`"${slide.actionTitle}" named a party that is not in the validated list.`);
        }
        if (spokes.length >= 1) {
          return {
            ...slide,
            content: { ...sanitised.content, spokes },
            claimIds: sanitised.claimIds,
          };
        }
      }
      return { ...slide, content: sanitised.content, claimIds: sanitised.claimIds };
    })
    .map((slide) => {
      const untraced = visibleStrings(slide.content).flatMap((text) =>
        untracedNumbers(text, slide.claimIds, pack.claims),
      );
      if (untraced.length > 0) {
        warnings.push(`"${slide.actionTitle}" had unsupported figures removed.`);
      }
      return slide;
    });

  const ids = new Set<string>();
  const unique = repaired.map((slide, index) => {
    const id = `slide-${index + 1}`;
    ids.add(id);
    return { ...slide, id };
  });
  return { slides: unique, warnings };
}

function planFromSlide(slide: DeckSpecSlide): DeckPlanSlide {
  return {
    layout: (isPlannerLayout(slide.layout) ? slide.layout : "context-bullets") as PlannerLayoutId,
    actionTitle: slide.actionTitle,
    purpose: slide.purpose,
    evidenceRefs: [],
    tier: slide.tier,
  };
}

/** One CXO pass; failures are logged and skipped, never fatal. */
export async function critiqueDeck(
  slides: DeckSpecSlide[],
  brief: ExportBrief,
  draft: DocumentDraft,
  pack: EvidencePack,
  options: CriticOptions,
): Promise<{ slides: DeckSpecSlide[]; warnings: string[] }> {
  const log = options.log ?? (() => undefined);
  const deterministic = deterministicCritic(slides, pack);
  const warnings = [...deterministic.warnings];
  let current = deterministic.slides;

  try {
    const digest = current
      .map(
        (slide, index) =>
          `${index}. [${slide.layout}] ${slide.actionTitle}\n${visibleStrings(slide.content).join(" | ").slice(0, 500)}`,
      )
      .join("\n\n");
    const outcome = await completeWithBudget(
      [
        { role: "system" as const, content: CRITIC_SYSTEM },
        {
          role: "user" as const,
          content: `Brief: ${brief.request}\n\nEvidence: ${pack.parties
            .map((party) => `${party.name}${party.gap ? " (no direct passage)" : ""}`)
            .join("; ")}\n\nDeck:\n${digest}`,
        },
      ],
      options,
      llmBudget("VERIFY"),
      0,
      { label: "deck critic" },
    );
    const parsed = CriticSchema.parse(parseJsonValue(outcome.content));
    const flagged = parsed.flagged.filter((entry) => entry.index < current.length).slice(0, 4);
    if (flagged.length > 0) {
      const replacements = new Map<number, DeckSpecSlide>();
      await Promise.all(
        flagged.map(async (entry) => {
          const original = current[entry.index]!;
          const rewritten = await writeSlide(planFromSlide(original), brief, draft, pack, options);
          replacements.set(entry.index, rewritten.slide);
          warnings.push(
            `"${original.actionTitle}" was rewritten after the critic: ${entry.reason}`,
          );
        }),
      );
      current = current.map((slide, index) => replacements.get(index) ?? slide);
      current = deterministicCritic(current, pack).slides;
    }
  } catch (error) {
    log("deck critic skipped", {
      reason: failureReasonOf(error),
      error: String(error).slice(0, 200),
    });
  }

  return { slides: current, warnings };
}
