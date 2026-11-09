/**
 * Deterministic answer-level scoring for the RAG eval. Kept pure and free of
 * provider calls so the rules can be tested; `scripts/run-answer-eval.ts` adds
 * the LLM judge for citation support and the gateway call itself.
 *
 * The numeric check is deliberately strict: every number, percentage, currency
 * amount or multiple in the answer must normalise to a value that appears in at
 * least one cited passage.
 */

export type NumericKind = "number" | "percent" | "multiple";

export type NumericToken = {
  raw: string;
  value: number;
  kind: NumericKind;
};

export type NumericViolation = {
  sentence: string;
  raw: string;
};

export type CitationCheck = {
  citations: number[];
  cited: number[];
  invalid: number[];
  /** Sentences that state a number but carry no [n] marker. */
  uncitedNumericSentences: string[];
};

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  bn: 1e9,
  b: 1e9,
  billion: 1e9,
  crore: 1e7,
  cr: 1e7,
  lakh: 1e5,
};

/** Common abbreviations that end in a full stop but do not end a sentence. */
const ABBREVIATIONS =
  /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|inc|ltd|co|corp|u\.s|u\.k|approx|no|fig|ref|al)\.$/i;

/** Removes [n] markers so citation numbers are not counted as facts. */
export function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, " ");
}

/**
 * Splits prose into sentences without breaking on decimals, "e.g.", "U.S." or
 * initials. Bullets and headings each start a new unit.
 */
export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split(/\n+/)) {
    const cleaned = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!cleaned) continue;
    const parts = cleaned.split(/(?<=[.!?])\s+/);
    let current = "";
    for (const part of parts) {
      current = current ? `${current} ${part}` : part;
      const endsAbbreviated =
        ABBREVIATIONS.test(current) || /(?:^|\s)[A-Z]\.$/.test(current) || /\d\.$/.test(current);
      if (!endsAbbreviated) {
        pieces.push(current.trim());
        current = "";
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }
  return pieces.filter(Boolean);
}

/** Extracts numeric claims with their unit, so 2x and 2% are not the same fact. */
export function extractNumbers(text: string): NumericToken[] {
  const pattern =
    /(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|per\s?cent|x|k|thousand|m|mn|million|bn|billion|crore|cr|lakh)?/gi;
  const tokens: NumericToken[] = [];
  for (const match of text.matchAll(pattern)) {
    const digits = match[1];
    if (!digits) continue;
    const parsed = Number.parseFloat(digits.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) continue;

    const unit = (match[2] ?? "").toLowerCase().replace(/\s+/g, " ");
    let kind: NumericKind = "number";
    let value = parsed;
    if (unit === "%" || unit === "percent" || unit === "per cent") {
      kind = "percent";
    } else if (unit === "x") {
      kind = "multiple";
    } else if (unit && SCALES[unit] !== undefined) {
      value = parsed * (SCALES[unit] as number);
    }

    tokens.push({ raw: match[0].trim(), value, kind });
  }
  return tokens;
}

/** Canonical key for comparing normalised numbers. */
export function numericKey(token: NumericToken): string {
  return `${token.kind}:${token.value.toFixed(6)}`;
}

/**
 * Every numeric token in the answer must occur in one of the cited passages.
 * Returns each offending token with the sentence it appeared in.
 */
export function checkNumericFaithfulness(
  answer: string,
  citedPassages: readonly string[],
): { violations: NumericViolation[]; checked: number } {
  const allowed = new Set<string>();
  for (const passage of citedPassages) {
    for (const token of extractNumbers(passage)) allowed.add(numericKey(token));
  }

  const violations: NumericViolation[] = [];
  let checked = 0;
  for (const sentence of splitSentences(stripCitations(answer))) {
    for (const token of extractNumbers(sentence)) {
      checked += 1;
      if (!allowed.has(numericKey(token))) {
        violations.push({ sentence, raw: token.raw });
      }
    }
  }
  return { violations, checked };
}

/** Validates [n] markers against the number of retrieved passages. */
export function checkCitations(answer: string, maxCitation: number): CitationCheck {
  const citations = [...answer.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value));
  const invalid = [...new Set(citations.filter((n) => n < 1 || n > maxCitation))];
  const cited = [...new Set(citations.filter((n) => n >= 1 && n <= maxCitation))].sort(
    (a, b) => a - b,
  );
  const uncitedNumericSentences = splitSentences(answer).filter((sentence) => {
    if (/\[\d+\]/.test(sentence)) return false;
    return extractNumbers(stripCitations(sentence)).length > 0;
  });

  return { citations, cited, invalid, uncitedNumericSentences };
}

/** Case/punctuation-insensitive text used for mustMention matching. */
function normalizeMention(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9%$.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fraction of the case's mustMention facts that appear in the answer. */
export function completeness(
  answer: string,
  mustMention: readonly string[],
): { score: number; missing: string[] } {
  const mentions = mustMention.map(normalizeMention).filter(Boolean);
  if (mentions.length === 0) return { score: 1, missing: [] };
  const haystack = normalizeMention(answer);
  const missing = mustMention.filter(
    (_mention, index) => !haystack.includes(mentions[index] as string),
  );
  return { score: (mentions.length - missing.length) / mentions.length, missing };
}

/** True when the answer clearly refuses rather than inventing an answer. */
export function isRefusal(answer: string): boolean {
  const text = answer.toLowerCase();
  return [
    /\bnot (?:covered|found|available|in the library|stated)\b/,
    /\b(?:couldn't|could not|can't|cannot) find\b/,
    /\bno (?:relevant )?(?:passages?|information|evidence|content)\b/,
    /\b(?:does not|doesn't) (?:say|cover|contain|mention)\b/,
    /\bnothing in the library\b/,
  ].some((pattern) => pattern.test(text));
}

export type JudgeVerdict = { supported: boolean; reason: string };

/**
 * Strict citation-support rubric. One call judges every cited sentence against
 * only the passages it cites; the model must return JSON, not prose.
 */
export function buildJudgePrompt(
  question: string,
  sentences: readonly { index: number; text: string; citations: number[] }[],
  passages: ReadonlyMap<number, string>,
): string {
  const cited = new Set(sentences.flatMap((sentence) => sentence.citations));
  const passageBlock = [...cited]
    .sort((a, b) => a - b)
    .map((citation) => `[${citation}] ${passages.get(citation) ?? ""}`)
    .join("\n\n");

  const sentenceBlock = sentences
    .map((sentence) => `${sentence.index}. ${sentence.text}`)
    .join("\n");

  return [
    "You are auditing a grounded answer for citation support.",
    "For each numbered sentence, decide whether the passages it cites actually state its claim.",
    "A sentence is supported only when every factual element (names, numbers, dates, status) is present in the cited passages.",
    "Do not use outside knowledge. Do not accept a plausible inference. If unsure, mark it unsupported.",
    'Return JSON only, with no markdown: {"sentences":[{"index":number,"supported":boolean,"reason":string}]}.',
    "",
    `Question: ${question}`,
    "",
    "Sentences to check:",
    sentenceBlock,
    "",
    "Cited passages:",
    passageBlock,
  ].join("\n");
}

/** Parses the judge's JSON, tolerating fences and stray prose. */
export function parseJudgeVerdicts(raw: string, expectedCount: number): (JudgeVerdict | null)[] {
  const verdicts: (JudgeVerdict | null)[] = Array.from({ length: expectedCount }, () => null);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return verdicts;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return verdicts;
  }
  if (typeof parsed !== "object" || parsed === null) return verdicts;

  const sentences = (parsed as { sentences?: unknown }).sentences;
  if (!Array.isArray(sentences)) return verdicts;

  for (const entry of sentences) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const index = typeof record["index"] === "number" ? record["index"] : null;
    if (index === null || index < 0 || index >= expectedCount) continue;
    if (typeof record["supported"] !== "boolean") continue;
    verdicts[index] = {
      supported: record["supported"],
      reason: typeof record["reason"] === "string" ? record["reason"] : "",
    };
  }
  return verdicts;
}
