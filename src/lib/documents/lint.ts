/**
 * Output lint for client-facing exports. Pure functions only: the build calls
 * them before rendering, and the same rules run in tests and `check-deck.ts`.
 * The goal is that no customer name in the blocklist, attachment file name,
 * claim id, raw context header or orphan currency symbol can reach a slide,
 * chart, footer, note or document property.
 */
import type { DeckSpec, DeckSpecSlide } from "./deck/types";

const PROTECTED_KEYS = /^(?:id|layout|tier|claimId|claimIds|imageId|currentStage|targetStage)$/;

const CLAIM_ID = /\bCL-\d*\b|\{\{[^}]{0,80}\}\}/g;
const FILE_NAME =
  /\.(?:pptx?|docx?|pdf|xlsx?)\b|_AIONOS\s+v?\d+(?:\.\d+)*|[-_ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_ ]?\d{2}\b/gi;
const RAW_HEADER = /Customer:\s*[^|]+\|\s*Industry:\s*/gi;
const ORPHAN_FIGURE = /[$€£]\s*(?:-|—|bn|billion|million|m)\b|\b(?:at|by|of|to)\s*%/i;
const INSTRUCTION_PREFIX =
  /^(?:insight|proof|context|overview|evidence|situation|opportunity)\s*:\s*/i;
const IMPERATIVE_TITLE =
  /^(?:show|contrast|explain|describe|highlight|compare|prove|outline|summari[sz]e|frame|introduce|present|set out|lay out|walk through)\b/i;
const ATTRIBUTION = /As demonstrated at [^.;\n]+? and now proposed for [^.;\n]+?[.;]?/gi;
const AUDIT_NOTE =
  /\b(?:CL-\d+|passages?|chunks?|library|evidence|sources?|claim ids?)\b|\.(?:pptx?|docx?|pdf|xlsx?)\b/gi;

export type LintFinding = {
  kind:
    | "reference-name"
    | "claim-id"
    | "file-name"
    | "raw-header"
    | "orphan-figure"
    | "instruction-title"
    | "repeated-attribution"
    | "audit-notes";
  location: string;
  before: string;
  after: string;
};

export type LintOptions = {
  scrubText?: (text: string) => string;
  /** Extra names to flag even when the caller did not scrub them. */
  blocklist?: readonly string[];
  targetClient?: string | null;
};

function tidy(text: string): string {
  return text
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .trim();
}

/** Drops the whole sentence or title that contains an orphan figure. */
export function removeOrphanFigures(text: string, fallback = ""): string {
  if (!ORPHAN_FIGURE.test(text)) return text;
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !ORPHAN_FIGURE.test(sentence));
  return sentences.length > 0 ? tidy(sentences.join(" ")) : fallback;
}

/** A title must be a claim, not an instruction or a labelled section. */
export function lintTitle(title: string): string {
  const withoutPrefix = title.replace(INSTRUCTION_PREFIX, "").trim();
  const cleaned = removeOrphanFigures(withoutPrefix, "The commercial case needs sizing");
  if (IMPERATIVE_TITLE.test(cleaned)) {
    return cleaned
      .replace(
        /^(?:show|contrast|explain|describe|highlight|compare|prove|outline|summari[sz]e|frame|introduce|present|set out|lay out|walk through)\s+/i,
        "",
      )
      .replace(/^the\s+/i, "The ")
      .trim();
  }
  return cleaned;
}

/** 2-4 sentences of presenter speech, with audit material stripped. */
export function presenterNotes(text: string, scrubText?: (value: string) => string): string {
  let value = text
    .replace(CLAIM_ID, "")
    .replace(FILE_NAME, "")
    .replace(RAW_HEADER, "")
    .replace(/\bSource:\s*[^.;]+[.;]?/gi, "")
    .replace(/\b(?:see|refer to) (?:the )?(?:passages?|sources?|evidence)\b[^.;]*[.;]?/gi, "");
  value = scrubText ? scrubText(value) : value;
  value = value.replace(AUDIT_NOTE, "");
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map(tidy)
    .filter((sentence) => sentence.length > 3)
    .slice(0, 4);
  return (
    sentences.join(" ") || "Walk the client through what this slide shows and agree the next step."
  );
}

function referenceHits(text: string, blocklist: readonly string[]): string[] {
  const value = text.toLowerCase();
  return blocklist.filter((name) => {
    const key = name.trim().toLowerCase();
    if (key.length < 3) return false;
    return new RegExp(
      `(?<![\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "iu",
    ).test(value);
  });
}

function mapStrings(value: unknown, key: string, fn: (text: string) => string): unknown {
  if (typeof value === "string") return PROTECTED_KEYS.test(key) ? value : fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, key, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        mapStrings(child, childKey, fn),
      ]),
    );
  }
  return value;
}

function lintSlide(
  slide: DeckSpecSlide,
  index: number,
  state: { attributionSeen: boolean },
  options: LintOptions,
  findings: LintFinding[],
): DeckSpecSlide {
  const scrub = options.scrubText ?? ((text: string) => text);
  const check = (location: string, before: string, after: string) => {
    if (before === after) return;
    const lower = before.toLowerCase();
    if (options.blocklist?.some((name) => lower.includes(name.toLowerCase()))) {
      findings.push({ kind: "reference-name", location, before, after });
    }
    if (CLAIM_ID.test(before)) {
      CLAIM_ID.lastIndex = 0;
      findings.push({ kind: "claim-id", location, before, after });
    }
    if (FILE_NAME.test(before)) {
      FILE_NAME.lastIndex = 0;
      findings.push({ kind: "file-name", location, before, after });
    }
    if (RAW_HEADER.test(before)) {
      RAW_HEADER.lastIndex = 0;
      findings.push({ kind: "raw-header", location, before, after });
    }
    if (ORPHAN_FIGURE.test(before)) {
      findings.push({ kind: "orphan-figure", location, before, after });
    }
  };

  const clean = (text: string): string => {
    const after = tidy(
      scrub(text).replace(CLAIM_ID, "").replace(FILE_NAME, "").replace(RAW_HEADER, ""),
    );
    return removeOrphanFigures(after);
  };

  const titleBefore = slide.actionTitle;
  const titleAfter = lintTitle(clean(titleBefore));
  check(`slide ${index + 1} title`, titleBefore, titleAfter);

  const content = mapStrings(slide.content, "content", clean) as DeckSpecSlide["content"];
  const notesBefore = slide.notes;
  const notesAfter = presenterNotes(slide.notes, scrub);
  check(`slide ${index + 1} notes`, notesBefore, notesAfter);

  // One anonymised proof attribution is enough; repeated template copy is noise.
  let attributionSeen = state.attributionSeen;
  const once = (text: string): string =>
    text.replace(ATTRIBUTION, (match) => {
      if (!attributionSeen) {
        attributionSeen = true;
        return match;
      }
      findings.push({
        kind: "repeated-attribution",
        location: `slide ${index + 1}`,
        before: match,
        after: "",
      });
      return "";
    });
  const contentOnce = mapStrings(content, "content", once) as DeckSpecSlide["content"];
  state.attributionSeen = attributionSeen;

  return {
    ...slide,
    actionTitle: titleAfter,
    content: contentOnce,
    notes: notesAfter,
    ...(slide.sourceNote ? { sourceNote: clean(slide.sourceNote) } : {}),
  };
}

/** Returns a cleaned spec plus the findings that changed it. */
export function lintDeckSpec(
  spec: DeckSpec,
  options: LintOptions = {},
): { spec: DeckSpec; findings: LintFinding[] } {
  const findings: LintFinding[] = [];
  const state = { attributionSeen: false };
  const slides = spec.slides.map((slide, index) =>
    lintSlide(slide, index, state, options, findings),
  );
  return {
    spec: {
      ...spec,
      deckTitle: lintTitle(spec.deckTitle),
      slides,
    },
    findings,
  };
}

/** Every visible string, for check-deck and tests. */
export function visibleTexts(spec: DeckSpec): string[] {
  const strings: string[] = [spec.deckTitle, spec.storyline, spec.audience];
  for (const slide of spec.slides) {
    strings.push(slide.actionTitle, slide.notes, slide.sourceNote ?? "");
    const collect = (value: unknown, key: string) => {
      if (typeof value === "string" && !PROTECTED_KEYS.test(key)) strings.push(value);
      else if (Array.isArray(value)) value.forEach((entry) => collect(entry, key));
      else if (value && typeof value === "object") {
        Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) =>
          collect(child, childKey),
        );
      }
    };
    collect(slide.content, "content");
  }
  return strings.filter(Boolean);
}

/** Lint a set of already-rendered strings, for the CLI check. */
export function lintText(
  text: string,
  options: LintOptions = {},
): { text: string; findings: LintFinding[] } {
  const findings: LintFinding[] = [];
  const before = text;
  let after = text.replace(CLAIM_ID, "").replace(FILE_NAME, "").replace(RAW_HEADER, "");
  if (options.scrubText) after = options.scrubText(after);
  after = removeOrphanFigures(after);
  if (after !== before) {
    findings.push({
      kind: "claim-id",
      location: "text",
      before,
      after,
    });
  }
  const hits = referenceHits(before, options.blocklist ?? []);
  if (hits.length > 0) {
    findings.push({
      kind: "reference-name",
      location: "text",
      before,
      after,
    });
  }
  return { text: after, findings };
}
