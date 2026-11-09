/**
 * Scoring for the retrieval evaluation set. Pure functions so the numbers can be
 * tested without a database or an embedding provider.
 *
 * Relevance has two levels:
 * - document level: a retrieved document is relevant when its file matches one
 *   of `expectedFiles`;
 * - chunk level: the passage must also contain one of the case's `evidence`
 *   strings when they are supplied, so a chart/table answer is only credited
 *   when the actual numbers came back, not merely the right file.
 */
import type { RetrievedChunk } from "./search";

export type EvalScope = { industry?: string | null; customer?: string | null };

export type EvalTurn = { role: "user" | "assistant"; content: string };

/** focus = scoped search (default); strict = scoped only; all = whole library. */
export type EvalScopeMode = "focus" | "strict" | "all";

export type EvalCase = {
  id: string;
  category: string;
  question: string;
  /** File names that contain the answer; empty means the library has no answer. */
  expectedFiles: string[];
  scope?: EvalScope;
  scopeMode?: EvalScopeMode;
  /** Conversation before the final question, used to test pronoun/ellipsis resolution. */
  turns?: EvalTurn[];
  /** Substrings that must appear in a relevant chunk (numbers, labels, diagrams). */
  evidence?: string[];
  /** Short facts an answer must mention (answer-level eval only). */
  mustMention?: string[];
  expectation?: "projection" | "delivered";
  notes?: string;
};

export type EvalSet = {
  version: number;
  k: number;
  cases: EvalCase[];
};

export type RankedFile = {
  rank: number;
  contentId: string;
  fileName: string;
  title: string;
};

export type EvalOutcome = {
  id: string;
  category: string;
  question: string;
  answerable: boolean;
  expectedFiles: string[];
  files: RankedFile[];
  /** Rank (1-based) of the first expected file, or null when none was found. */
  firstRank: number | null;
  /** Rank (1-based) of the first passage that matches file and evidence. */
  chunkFirstRank: number | null;
  recall: number;
  documentRecall: number;
  chunkRecall: number;
  reciprocalRank: number;
  ndcgAtK: number;
};

export type CategorySummary = {
  total: number;
  answerable: number;
  recallAtK: number;
  documentRecallAtK: number;
  chunkRecallAtK: number;
  mrr: number;
  ndcgAtK: number;
};

export type EvalSummary = {
  total: number;
  answerable: number;
  unanswerable: number;
  recallAtK: number;
  documentRecallAtK: number;
  chunkRecallAtK: number;
  mrr: number;
  ndcgAtK: number;
  byCategory: Record<string, CategorySummary>;
  /** Unanswerable questions that still returned passages; useful for fabrication checks. */
  unanswerableWithResults: number;
  unanswerableFalsePositiveRate: number;
};

/** The question retrieval actually runs: the last user turn of a follow-up. */
export function resolveCaseQuestion(testCase: EvalCase): string {
  const lastUser = [...(testCase.turns ?? [])].reverse().find((turn) => turn.role === "user");
  return (lastUser?.content ?? testCase.question).trim();
}

/** Strips the download prefix (`<id8>-`) and punctuation so names compare cleanly. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[0-9a-f]{8}-/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Case- and punctuation-insensitive text used for evidence matching. */
export function normalizeEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function fileMatchesExpected(
  file: { fileName: string; title: string },
  expected: string,
): boolean {
  const normalizedExpected = normalize(expected);
  if (!normalizedExpected) return false;
  const stem = normalizedExpected.replace(/\.[a-z0-9]+$/, "");
  const normalizedFile = normalize(file.fileName);
  const normalizedTitle = normalize(file.title);

  return (
    normalizedFile === normalizedExpected ||
    normalizedFile.endsWith(`-${normalizedExpected}`) ||
    normalizedFile.endsWith(normalizedExpected) ||
    (stem.length >= 8 && normalizedFile.includes(stem)) ||
    (stem.length >= 8 && normalizedTitle.includes(stem))
  );
}

/** True when a passage is relevant: right file, plus the evidence when required. */
export function chunkMatchesCase(chunk: RetrievedChunk, testCase: EvalCase): boolean {
  const fileMatch = testCase.expectedFiles.some((expected) =>
    fileMatchesExpected({ fileName: chunk.fileName, title: chunk.title }, expected),
  );
  if (!fileMatch) return false;

  const evidence = (testCase.evidence ?? []).map(normalizeEvidence).filter(Boolean);
  if (evidence.length === 0) return true;
  const haystack = normalizeEvidence(chunk.content);
  return evidence.some((needle) => haystack.includes(needle));
}

/** Deduplicates by document while preserving the retrieval order. */
export function rankFiles(chunks: readonly RetrievedChunk[]): RankedFile[] {
  const seen = new Set<string>();
  const files: RankedFile[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.contentId)) continue;
    seen.add(chunk.contentId);
    files.push({
      rank: files.length + 1,
      contentId: chunk.contentId,
      fileName: chunk.fileName,
      title: chunk.title,
    });
  }
  return files;
}

/**
 * Binary-relevance nDCG@k over document ranks. Each relevant document counts
 * once, so a second passage from the same deck cannot inflate the score.
 */
export function ndcgAtK(relevantRanks: readonly number[], k: number): number {
  const cutoff = Math.max(1, Math.trunc(k));
  const dcg = relevantRanks
    .filter((rank) => rank >= 1 && rank <= cutoff)
    .reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const idealCount = Math.min(new Set(relevantRanks).size, cutoff);
  let idcg = 0;
  for (let position = 1; position <= idealCount; position += 1) {
    idcg += 1 / Math.log2(position + 1);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export function evaluateCase(
  testCase: EvalCase,
  chunks: readonly RetrievedChunk[],
  k = 8,
): EvalOutcome {
  const files = rankFiles(chunks);
  const answerable = testCase.expectedFiles.length > 0;
  const matchingFiles = answerable
    ? files.filter((file) =>
        testCase.expectedFiles.some((expected) => fileMatchesExpected(file, expected)),
      )
    : [];
  const firstRank = matchingFiles[0]?.rank ?? null;
  const chunkFirstRank = answerable
    ? chunks.findIndex((chunk) => chunkMatchesCase(chunk, testCase)) + 1 || null
    : null;

  return {
    id: testCase.id,
    category: testCase.category,
    question: resolveCaseQuestion(testCase),
    answerable,
    expectedFiles: testCase.expectedFiles,
    files,
    firstRank,
    chunkFirstRank,
    recall: firstRank === null ? 0 : 1,
    documentRecall: firstRank === null ? 0 : 1,
    chunkRecall: chunkFirstRank === null ? 0 : 1,
    reciprocalRank: firstRank === null ? 0 : 1 / firstRank,
    ndcgAtK: ndcgAtK(
      matchingFiles.map((file) => file.rank),
      k,
    ),
  };
}

function emptySummary(): CategorySummary {
  return {
    total: 0,
    answerable: 0,
    recallAtK: 0,
    documentRecallAtK: 0,
    chunkRecallAtK: 0,
    mrr: 0,
    ndcgAtK: 0,
  };
}

export function summarize(outcomes: readonly EvalOutcome[]): EvalSummary {
  const categories = new Map<
    string,
    { summary: CategorySummary; recall: number; chunkRecall: number; rr: number; ndcg: number }
  >();
  let answerable = 0;
  let recall = 0;
  let chunkRecall = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  let unanswerableWithResults = 0;

  for (const outcome of outcomes) {
    const bucket = categories.get(outcome.category) ?? {
      summary: emptySummary(),
      recall: 0,
      chunkRecall: 0,
      rr: 0,
      ndcg: 0,
    };
    bucket.summary.total += 1;

    if (outcome.answerable) {
      answerable += 1;
      recall += outcome.documentRecall;
      chunkRecall += outcome.chunkRecall;
      reciprocalRank += outcome.reciprocalRank;
      ndcg += outcome.ndcgAtK;
      bucket.summary.answerable += 1;
      bucket.recall += outcome.documentRecall;
      bucket.chunkRecall += outcome.chunkRecall;
      bucket.rr += outcome.reciprocalRank;
      bucket.ndcg += outcome.ndcgAtK;
    } else if (outcome.files.length > 0) {
      unanswerableWithResults += 1;
    }

    categories.set(outcome.category, bucket);
  }

  const byCategory: Record<string, CategorySummary> = {};
  for (const [name, bucket] of categories) {
    byCategory[name] = {
      ...bucket.summary,
      recallAtK: bucket.summary.answerable ? bucket.recall / bucket.summary.answerable : 0,
      documentRecallAtK: bucket.summary.answerable ? bucket.recall / bucket.summary.answerable : 0,
      chunkRecallAtK: bucket.summary.answerable
        ? bucket.chunkRecall / bucket.summary.answerable
        : 0,
      mrr: bucket.summary.answerable ? bucket.rr / bucket.summary.answerable : 0,
      ndcgAtK: bucket.summary.answerable ? bucket.ndcg / bucket.summary.answerable : 0,
    };
  }

  const unanswerable = outcomes.length - answerable;

  return {
    total: outcomes.length,
    answerable,
    unanswerable,
    recallAtK: answerable ? recall / answerable : 0,
    documentRecallAtK: answerable ? recall / answerable : 0,
    chunkRecallAtK: answerable ? chunkRecall / answerable : 0,
    mrr: answerable ? reciprocalRank / answerable : 0,
    ndcgAtK: answerable ? ndcg / answerable : 0,
    byCategory,
    unanswerableWithResults,
    unanswerableFalsePositiveRate: unanswerable ? unanswerableWithResults / unanswerable : 0,
  };
}
