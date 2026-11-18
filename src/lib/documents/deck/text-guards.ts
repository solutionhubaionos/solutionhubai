/**
 * Deterministic language guards. Prompts ask for client-ready copy, but a model
 * can still leak provenance ("the library documents…"), hedge at the client, or
 * echo the request into the speaker notes. These checks are code, so the same
 * failure can never reach a rendered slide twice.
 */
import type { ClaimRegistry, DeckSlideContent } from "./types";
import { untracedNumbers, numbersIn, resolveClaimTokens } from "./claims";

/** Phrases that describe our process instead of the client's problem. */
const BANNED_PHRASES: RegExp[] = [
  /\bdocumented capability\b/i,
  /\bwhat the library documents\b/i,
  /\bproof points? from the library\b/i,
  /\bbuilt from the (?:solution hub )?library\b/i,
  /\bthe passages? (?:do|does|did) not\b/i,
  /\bno library evidence\b/i,
  /\bno passage (?:states|says|shows)\b/i,
  /\baccording to (?:the )?passages?\b/i,
  /\bas an ai\b/i,
];

/** Hedging that tells the client what we could not find. */
const HEDGE_PHRASES: RegExp[] = [
  /\bnot for [^.]*? specifically\b/i,
  /\bno [^.]*? is claimed\b/i,
  /\bnot claimed\b/i,
  /\bcannot be confirmed\b/i,
  /\bto be confirmed\b/i,
  /\bwe (?:could|can) not (?:find|confirm|verify)\b/i,
  /\bnot (?:available|documented) in the library\b/i,
  /\bno data (?:is )?available\b/i,
  /\bnot (?:stated|specified) in the sources\b/i,
];

const PROVENANCE_WORDS = /\b(?:library|passages?|chunks?|evidence)\b/gi;
/** The brand is written "Aionos"; "AIONOS" only in formal headlines/wordmarks. */
const BRAND_NAME = /\b(?:AIonOS|AionOS|aionos)\b/g;
/** Footers and copyright lines baked into source documents. */
const SOURCE_ARTIFACT =
  /(?:©\s*\d{2,4}[^.;\n]*|\bcopyright\b[^.;\n]*|\ball rights reserved\b[^.;\n]*|confidential[^.;\n]*?prepared[^.;\n]*)/gi;
const REF_MARKS = /\[S?\d+(?:\s*[,–-]\s*\d+)*\]/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Template leftovers a model occasionally types instead of a value. A valid
 * claim token ({{CL-3}}) is not a placeholder: it is resolved from the registry
 * later, so the negative lookahead keeps it intact.
 */
const PLACEHOLDER_TOKEN = /\{\{\s*(?!CL-\d{1,4}\s*\}\})[^}]{0,80}\}\}/g;
const ANY_TOKEN = /\{\{[^}]{0,80}\}\}/;
const ANY_TOKEN_ALL = /\{\{[^}]{0,80}\}\}/g;
const PLACEHOLDER_WORDS =
  /\b(?:TODO|TBD|TBC|placeholder|insert (?:text|here|value)|lorem ipsum|XXX+)\b/gi;
const INSERT_BRACKET = /\[(?:insert|add|tbd|todo)[^\]]{0,60}\]/gi;
const INSTRUCTION_PREFIX =
  /^(?:insight|proof|context|overview|evidence|situation|opportunity)\s*:\s*/i;
const ORPHAN_FIGURE = /[$€£]\s*(?:-|—|bn|billion|million|m)\b|\b(?:at|by|of|to)\s*%/i;

export function stripPlaceholders(text: string): string {
  return text
    .replace(PLACEHOLDER_TOKEN, "")
    .replace(INSERT_BRACKET, "")
    .replace(PLACEHOLDER_WORDS, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Any unresolved template token or placeholder word left in visible copy. */
export function hasPlaceholders(text: string): boolean {
  return (
    ANY_TOKEN.test(text) ||
    new RegExp(PLACEHOLDER_WORDS.source, "i").test(text) ||
    INSERT_BRACKET.test(text)
  );
}

/** Removes every leftover token, including one a claim lookup could not resolve. */
export function stripUnresolvedTokens(text: string): string {
  return stripPlaceholders(text.replace(ANY_TOKEN_ALL, ""));
}

export function stripRefs(text: string): string {
  return text
    .replace(REF_MARKS, "")
    .replace(UUID, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripSentences(text: string, pattern: RegExp): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !pattern.test(sentence))
    .join(" ");
}

/** Banned phrases, provenance words, hedges and citation marks, all removed. */
export function cleanSlideText(text: string): string {
  let value = stripPlaceholders(stripRefs(text)).replace(INSTRUCTION_PREFIX, "");
  value = value.replace(BRAND_NAME, "Aionos").replace(SOURCE_ARTIFACT, " ");
  for (const pattern of BANNED_PHRASES) value = value.replace(pattern, "");
  for (const pattern of HEDGE_PHRASES) value = stripSentences(value, pattern);
  value = value.replace(PROVENANCE_WORDS, "").replace(/\b(?:the|a|an)\s+(?=\s|$)/gi, "");
  return value
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\s*([.!?])+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .trim();
}

export function hasBannedCopy(text: string): boolean {
  const value = stripRefs(text);
  return (
    BANNED_PHRASES.some((pattern) => pattern.test(value)) ||
    HEDGE_PHRASES.some((pattern) => pattern.test(value)) ||
    new RegExp(PROVENANCE_WORDS.source, "i").test(value)
  );
}

export function hasHedge(text: string): boolean {
  return HEDGE_PHRASES.some((pattern) => pattern.test(stripRefs(text)));
}

/** Removes a trailing evidence/source column if a writer slips one in. */
export function stripEvidenceColumns(
  headers: string[],
  rows: string[][],
): {
  headers: string[];
  rows: string[][];
} {
  const keep = headers
    .map((header, index) => ({ header, index }))
    .filter(
      ({ header }) =>
        !/\b(evidence|refs?|references?|sources?|citations?|chunks?|documented capability)\b/i.test(
          header,
        ),
    )
    .map(({ index }) => index);
  return {
    headers: keep.map((index) => headers[index]!),
    rows: rows.map((row) => keep.map((index) => row[index] ?? "")),
  };
}

/**
 * Planning copy a model sometimes hands back as a title: "Show the stages…",
 * "Close with the decision requested…". It reads as an instruction to the
 * writer, never as something a reader could disagree with, so it is repaired
 * like a label even though it contains a verb such as "show" or "close".
 */
export function isInstructionTitle(title: string): boolean {
  const value = title.trim();
  return (
    /^(?:show|close|set out|prove|explain|introduce|highlight|outline|summari[sz]e|describe|contrast|compare|cover|define|frame|present|illustrate|walk through|lay out|make the case|set the (?:situation|scene|stage|context))\b/i.test(
      value,
    ) ||
    /\bthe decision requested\b|\bfirst actions\b|\bthe stages? from\b|\bhow the pieces fit\b/i.test(
      value,
    )
  );
}

/** A title must make a claim, not name a section. */
export function hasClaimVerb(title: string): boolean {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  return /\b(?:is|are|was|were|will|cuts?|raises?|adds?|removes?|turns?|makes?|moves?|grows?|reduces?|improves?|unlocks?|needs?|means?|becomes?|creates?|gives?|takes?|lets?|can|should|must|does|do|has|have|owns?|wins?|comes?|starts?|ends?|sits?|drives?|shows?|proves?|pays?|saves?|earns?|fits?|helps?|changes?|delivers?|covers?|connects?|enables?|unifies?|replaces?|removes?|closes?|opens?|builds?|protects?|scales?|proves?)\b/i.test(
    title,
  );
}

/** The user's request must never appear in the speaker notes. */
export function stripPromptEcho(notes: string, prompt: string): string {
  const request = prompt.replace(/\s+/g, " ").trim();
  let value = notes
    .replace(/This deck answers:[^.]*\.?/gi, "")
    .replace(/The (?:user|client) asked[^.]*\.?/gi, "");
  if (request.length > 12) {
    const escaped = request.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(escaped, "gi"), "");
  }
  return value.replace(/\s{2,}/g, " ").trim();
}

function removeUntraced(text: string, allowed: ReadonlySet<string>): string {
  let value = text;
  for (const token of numbersIn(text)) {
    if (/^(19|20)\d{2}$/.test(token.raw)) continue;
    if (allowed.has(token.digits)) continue;
    const escaped = token.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(
      new RegExp(
        `(?<![\\d.])${escaped}(?:\\s?(?:%|percent|days?|weeks?|months?|years?|hours?|markets?|stores?|bases?))?`,
        "gi",
      ),
      "",
    );
  }
  const cleaned = value
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*[-–—,;:]\s*/, "")
    .trim();
  // Removing a figure can leave "$ billion" or "at %". A dangling unit is
  // worse than losing the sentence that carried it.
  if (!ORPHAN_FIGURE.test(cleaned)) return cleaned;
  return cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !ORPHAN_FIGURE.test(sentence))
    .join(" ")
    .trim();
}

function allowedDigits(claimIds: readonly string[], registry: ClaimRegistry): Set<string> {
  const allowed = new Set<string>();
  for (const id of claimIds) {
    const claim = registry[id];
    if (!claim) continue;
    for (const token of numbersIn(claim.valueText)) allowed.add(token.digits);
    if (claim.valueMin !== null) allowed.add(String(claim.valueMin));
    if (claim.valueMax !== null) allowed.add(String(claim.valueMax));
  }
  return allowed;
}

export type SlideSanitiseResult = {
  content: DeckSlideContent;
  claimIds: string[];
  removed: string[];
};

/**
 * Final deterministic pass over one slide: resolve claim tokens, remove banned
 * copy, drop bullets or cards whose numbers cannot be traced, and blank table
 * cells that still carry an unsupported figure. Returns the claims the slide
 * now actually uses.
 */
export function sanitiseSlide(
  content: DeckSlideContent,
  claimIds: readonly string[],
  registry: ClaimRegistry,
): SlideSanitiseResult {
  const used = new Set(claimIds.filter((id) => Boolean(registry[id])));
  const removed: string[] = [];
  const allowed = allowedDigits([...used], registry);

  const text = (value: string): string => {
    const resolved = resolveClaimTokens(cleanSlideText(value), registry);
    const cleaned = removeUntraced(stripUnresolvedTokens(resolved), allowed);
    if (cleaned !== resolved) removed.push(`untraced number in "${value}"`);
    return cleaned;
  };

  const mapTable = (table: { headers: string[]; rows: string[][] }) => {
    const stripped = stripEvidenceColumns(table.headers, table.rows);
    return {
      headers: stripped.headers.map((header) => text(header)),
      rows: stripped.rows.map((row) => row.map((cell) => text(cell))),
    };
  };

  switch (content.layout) {
    case "section-divider": {
      return {
        content: {
          ...content,
          label: text(content.label),
          ...(content.statement ? { statement: text(content.statement) } : {}),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "context-bullets": {
      const bullets = content.bullets
        .map((bullet) => ({
          text: text(bullet.text),
          claimIds: bullet.claimIds.filter((id) => registry[id]),
        }))
        .filter((bullet) => bullet.text.length > 2);
      for (const id of bullets.flatMap((bullet) => bullet.claimIds)) used.add(id);
      return {
        content: { layout: "context-bullets", bullets: bullets.slice(0, 4) },
        claimIds: [...used],
        removed,
      };
    }
    case "kpi-cards": {
      const cards = content.cards
        .filter((card) => Boolean(registry[card.claimId]))
        .map((card) => ({
          ...card,
          label: text(card.label),
          ...(card.note ? { note: text(card.note) } : {}),
        }));
      for (const card of cards) used.add(card.claimId);
      return {
        content: { layout: "kpi-cards", cards: cards.slice(0, 4) },
        claimIds: [...used],
        removed,
      };
    }
    case "partner-hub": {
      const spokes = content.spokes
        .map((spoke) => ({
          ...spoke,
          entity: text(spoke.entity),
          role: text(spoke.role),
          claimIds: spoke.claimIds.filter((id) => registry[id]),
        }))
        .filter((spoke) => spoke.entity.length > 1 && spoke.role.length > 2);
      for (const id of spokes.flatMap((spoke) => spoke.claimIds)) used.add(id);
      return {
        content: {
          layout: "partner-hub",
          centre: text(content.centre),
          spokes: spokes.slice(0, 6),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "two-column-compare":
    case "before-after": {
      const side = (value: { heading: string; points: string[] }) => ({
        heading: text(value.heading),
        points: value.points.map(text).filter(Boolean).slice(0, 4),
      });
      return {
        content: { layout: content.layout, left: side(content.left), right: side(content.right) },
        claimIds: [...used],
        removed,
      };
    }
    case "table-compact":
    case "shortcomings-table":
    case "collaboration-pointers-table": {
      const table = mapTable(content);
      return {
        content: { layout: content.layout, headers: table.headers, rows: table.rows.slice(0, 5) },
        claimIds: [...used],
        removed,
      };
    }
    case "process-roadmap": {
      return {
        content: {
          layout: "process-roadmap",
          steps: content.steps
            .map((step) => ({
              label: text(step.label),
              ...(step.detail ? { detail: text(step.detail) } : {}),
            }))
            .filter((step) => step.label.length > 1)
            .slice(0, 5),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "chart-with-takeaway": {
      const series = content.chart.series.map((entry) => ({
        name: text(entry.name),
        points: entry.points
          .filter((point) => Boolean(registry[point.claimId]))
          .map((point) => ({ ...point, label: text(point.label) })),
      }));
      for (const entry of series) for (const point of entry.points) used.add(point.claimId);
      return {
        content: {
          layout: "chart-with-takeaway",
          chart: { ...content.chart, title: text(content.chart.title), series },
          takeaway: text(content.takeaway),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "image-with-caption": {
      return {
        content: {
          layout: "image-with-caption",
          caption: text(content.caption),
          sourceNote: text(content.sourceNote),
          ...(content.imageId ? { imageId: content.imageId } : {}),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "next-steps-ask": {
      return {
        content: {
          layout: "next-steps-ask",
          ask: text(content.ask),
          steps: content.steps
            .map((step) => ({
              text: text(step.text),
              ...(step.owner ? { owner: text(step.owner) } : {}),
              ...(step.when ? { when: text(step.when) } : {}),
            }))
            .filter((step) => step.text.length > 2)
            .slice(0, 4),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "maturity-progression": {
      const stages = content.stages
        .map((stage) => ({
          label: text(stage.label),
          ...(stage.descriptor ? { descriptor: text(stage.descriptor) } : {}),
        }))
        .filter((stage) => stage.label.length > 1)
        .slice(0, 5);
      const last = Math.max(0, stages.length - 1);
      return {
        content: {
          layout: "maturity-progression",
          stages,
          ...(content.currentStage !== undefined
            ? { currentStage: Math.min(content.currentStage, last) }
            : {}),
          ...(content.targetStage !== undefined
            ? { targetStage: Math.min(content.targetStage, last) }
            : {}),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "three-horizon": {
      return {
        content: {
          layout: "three-horizon",
          horizons: content.horizons
            .map((horizon) => ({
              label: text(horizon.label),
              description: text(horizon.description),
              outcomes: horizon.outcomes.map(text).filter(Boolean).slice(0, 4),
            }))
            .filter((horizon) => horizon.label.length > 1 && horizon.outcomes.length > 0)
            .slice(0, 3),
        },
        claimIds: [...used],
        removed,
      };
    }
    case "layered-architecture": {
      return {
        content: {
          layout: "layered-architecture",
          layers: content.layers
            .map((layer) => ({
              label: text(layer.label),
              items: layer.items.map(text).filter(Boolean).slice(0, 5),
            }))
            .filter((layer) => layer.label.length > 1 && layer.items.length > 0)
            .slice(0, 5),
        },
        claimIds: [...used],
        removed,
      };
    }
  }
}

/** A claim-shaped, number-safe action title. */
export function sanitiseTitle(
  title: string,
  claimIds: readonly string[],
  registry: ClaimRegistry,
): string {
  const resolved = resolveClaimTokens(cleanSlideText(title), registry);
  const cleaned = removeUntraced(
    stripUnresolvedTokens(resolved),
    allowedDigits(claimIds, registry),
  );
  return cleaned || "The commercial case needs sizing";
}

/** True when every digit in the text is covered by one of the slide's claims. */
export function allNumbersTraced(
  text: string,
  claimIds: readonly string[],
  registry: ClaimRegistry,
): boolean {
  return untracedNumbers(text, claimIds, registry).length === 0;
}
