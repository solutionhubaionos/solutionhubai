/**
 * Scoring for the retrieval evaluation set. Pure functions so the numbers can be
 * tested without a database or an embedding provider.
 */
import type { RetrievedChunk } from "./search";

export type EvalScope = { industry?: string | null; customer?: string | null };

export type EvalCase = {
  id: string;
  category: string;
  question: string;
  /** File names that contain the answer; empty means the library has no answer. */
  expectedFiles: string[];
  scope?: EvalScope;
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
  recall: number;
  reciprocalRank: number;
};

export type CategorySummary = {
  total: number;
  answerable: number;
  recallAtK: number;
  mrr: number;
};

export type EvalSummary = {
  total: number;
  answerable: number;
  unanswerable: number;
  recallAtK: number;
  mrr: number;
  byCategory: Record<string, CategorySummary>;
  /** Unanswerable questions that still returned passages; useful for fabrication checks. */
  unanswerableWithResults: number;
};

/** Strips the download prefix (`<id8>-`) and punctuation so names compare cleanly. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[0-9a-f]{8}-/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

export function evaluateCase(testCase: EvalCase, chunks: readonly RetrievedChunk[]): EvalOutcome {
  const files = rankFiles(chunks);
  const answerable = testCase.expectedFiles.length > 0;
  const match = answerable
    ? files.find((file) =>
        testCase.expectedFiles.some((expected) => fileMatchesExpected(file, expected)),
      )
    : undefined;
  const firstRank = match?.rank ?? null;

  return {
    id: testCase.id,
    category: testCase.category,
    question: testCase.question,
    answerable,
    expectedFiles: testCase.expectedFiles,
    files,
    firstRank,
    recall: firstRank === null ? 0 : 1,
    reciprocalRank: firstRank === null ? 0 : 1 / firstRank,
  };
}

function emptySummary(): CategorySummary {
  return { total: 0, answerable: 0, recallAtK: 0, mrr: 0 };
}

export function summarize(outcomes: readonly EvalOutcome[]): EvalSummary {
  const categories = new Map<string, { summary: CategorySummary; recall: number; rr: number }>();
  let answerable = 0;
  let recall = 0;
  let reciprocalRank = 0;
  let unanswerableWithResults = 0;

  for (const outcome of outcomes) {
    const bucket = categories.get(outcome.category) ?? {
      summary: emptySummary(),
      recall: 0,
      rr: 0,
    };
    bucket.summary.total += 1;

    if (outcome.answerable) {
      answerable += 1;
      recall += outcome.recall;
      reciprocalRank += outcome.reciprocalRank;
      bucket.summary.answerable += 1;
      bucket.recall += outcome.recall;
      bucket.rr += outcome.reciprocalRank;
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
      mrr: bucket.summary.answerable ? bucket.rr / bucket.summary.answerable : 0,
    };
  }

  return {
    total: outcomes.length,
    answerable,
    unanswerable: outcomes.length - answerable,
    recallAtK: answerable ? recall / answerable : 0,
    mrr: answerable ? reciprocalRank / answerable : 0,
    byCategory,
    unanswerableWithResults,
  };
}
