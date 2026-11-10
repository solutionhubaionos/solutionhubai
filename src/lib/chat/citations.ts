/**
 * Citation markers in generated answers. Pure string work: parse [n], [2][3]
 * and [2, 3], drop numbers the server never issued, and renumber in order of
 * first use so the text and the Sources list cannot drift apart.
 *
 * The model is never trusted to name documents; a number only means something
 * while it is checked against the request's source map.
 */

export type CitationMarker = {
  start: number;
  end: number;
  numbers: number[];
};

/** [3] · [2][3] is two matches · [2, 3] and [2;3] are one match. */
const MARKER = /\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*\]/g;

export function parseCitationMarkers(text: string): CitationMarker[] {
  return [...text.matchAll(MARKER)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    numbers: (match[1] ?? "")
      .split(/[,;]/)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value)),
  }));
}

export type ProcessedCitations = {
  /** Answer text with invalid markers removed and numbers renumbered from 1. */
  text: string;
  /** Original source numbers, deduplicated, in order of first citation. */
  cited: number[];
  /** Marker numbers that were not in the source map and were dropped. */
  invalid: number[];
  /** Original number -> display number, for debugging. */
  display: Map<number, number>;
};

/**
 * Rewrites every marker against the numbers the server actually issued.
 * Display numbers follow first appearance, so a cited-once source is always [1]
 * however deep it sat in the retrieved list.
 */
export function processCitationMarkers(
  raw: string,
  valid: ReadonlySet<number>,
): ProcessedCitations {
  const markers = parseCitationMarkers(raw);
  const display = new Map<number, number>();
  const cited: number[] = [];
  const invalid: number[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const marker of markers) {
    parts.push(raw.slice(cursor, marker.start));
    cursor = marker.end;

    const kept: number[] = [];
    for (const number of new Set(marker.numbers)) {
      if (!valid.has(number)) {
        if (!invalid.includes(number)) invalid.push(number);
        continue;
      }
      if (!display.has(number)) {
        cited.push(number);
        display.set(number, cited.length);
      }
      kept.push(display.get(number) as number);
    }
    if (kept.length > 0) parts.push(kept.map((number) => `[${number}]`).join(""));
  }

  parts.push(raw.slice(cursor));
  return { text: tidyCitationSpacing(parts.join("")), cited, invalid, display };
}

/** Repairs the gap a removed marker leaves before punctuation, per line. */
function tidyCitationSpacing(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+([.,;:!?])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sentences that describe the context instead of answering. Used only to log a
 * warning with the request id: the answer is still returned.
 */
const META_PATTERNS: readonly RegExp[] = [
  /\bthe (?:numbered |retrieved |given )?passages?\b/gi,
  /\blibrary passages?\b/gi,
  /\bprovided context\b/gi,
  /\bthe (?:numbered )?context\b/gi,
  /\baccording to (?:the )?(?:passage|source)s?\s*\[/gi,
  /\bin the (?:passages|context)\b/gi,
];

export function findMetaPhrases(text: string): string[] {
  const found: string[] = [];
  for (const pattern of META_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = (match[0] ?? "").trim();
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found;
}
