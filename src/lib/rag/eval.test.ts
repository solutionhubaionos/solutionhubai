import { describe, expect, it } from "vitest";
import {
  chunkMatchesCase,
  evaluateCase,
  fileMatchesExpected,
  ndcgAtK,
  rankFiles,
  resolveCaseQuestion,
  summarize,
  type EvalCase,
} from "./eval";
import type { RetrievedChunk } from "./search";

function chunk(
  contentId: string,
  fileName: string,
  content = "passage",
  title = fileName,
): RetrievedChunk {
  return {
    chunkId: `${contentId}-0`,
    contentId,
    content,
    page: 1,
    slide: null,
    heading: null,
    title,
    fileName,
    filePath: `airlines/${fileName}`,
    industry: "airlines",
    customerName: null,
    vectorRank: 1,
    textRank: null,
    score: 0.03,
  };
}

describe("fileMatchesExpected", () => {
  it("matches the same name, with or without the download prefix", () => {
    const file = { fileName: "2dfa09fc-United_Airlines_Strategic_Brief.docx", title: "Brief" };
    expect(fileMatchesExpected(file, "2dfa09fc-United_Airlines_Strategic_Brief.docx")).toBe(true);
    expect(fileMatchesExpected(file, "United_Airlines_Strategic_Brief.docx")).toBe(true);
  });

  it("matches a title that names the document", () => {
    const file = {
      fileName: "upload-1234.pdf",
      title: "[Ingestion Test] c772bed6-Case_study_-_Bajaj_Pulsar.pdf",
    };
    expect(fileMatchesExpected(file, "c772bed6-Case_study_-_Bajaj_Pulsar.pdf")).toBe(true);
  });

  it("does not match unrelated files", () => {
    const file = { fileName: "Kotak_Deck.pptx", title: "Kotak" };
    expect(fileMatchesExpected(file, "United_Airlines_Strategic_Brief.docx")).toBe(false);
  });

  it("ignores empty expectations", () => {
    expect(fileMatchesExpected({ fileName: "a.pdf", title: "a" }, "  ")).toBe(false);
  });
});

describe("resolveCaseQuestion", () => {
  it("uses the last user turn so follow-ups can be tested", () => {
    expect(
      resolveCaseQuestion({
        id: "m",
        category: "multi-turn",
        question: "fallback",
        expectedFiles: [],
        turns: [
          { role: "user", content: "Tell me about United." },
          { role: "assistant", content: "United Next is its plan [1]." },
          { role: "user", content: " How many aircraft in 2025? " },
        ],
      }),
    ).toBe("How many aircraft in 2025?");
  });

  it("falls back to the question when there are no turns", () => {
    expect(
      resolveCaseQuestion({
        id: "s",
        category: "exact",
        question: "Plain question",
        expectedFiles: [],
      }),
    ).toBe("Plain question");
  });
});

describe("chunkMatchesCase", () => {
  const base: EvalCase = {
    id: "c",
    category: "chart",
    question: "q",
    expectedFiles: ["deck.pptx"],
  };

  it("requires the right file", () => {
    expect(chunkMatchesCase(chunk("1", "deck.pptx"), base)).toBe(true);
    expect(chunkMatchesCase(chunk("1", "other.pptx"), base)).toBe(false);
  });

  it("requires the evidence when the case supplies it", () => {
    const testCase = { ...base, evidence: ["1.59x", "1.50x"] };
    expect(chunkMatchesCase(chunk("1", "deck.pptx", "Solvency 1.59x vs 1.50x"), testCase)).toBe(
      true,
    );
    expect(chunkMatchesCase(chunk("1", "deck.pptx", "Solvency is discussed"), testCase)).toBe(
      false,
    );
  });

  it("ignores dash and spacing differences in evidence", () => {
    expect(
      chunkMatchesCase(chunk("1", "deck.pptx", "Quote of $800–$2,000"), {
        ...base,
        evidence: ["$800-$2,000"],
      }),
    ).toBe(true);
  });
});

describe("rankFiles", () => {
  it("deduplicates by document and keeps retrieval order", () => {
    const files = rankFiles([
      chunk("b", "b.pdf"),
      chunk("a", "a.pdf"),
      { ...chunk("a", "a.pdf"), chunkId: "a-1" },
    ]);
    expect(files.map((f) => f.contentId)).toEqual(["b", "a"]);
    expect(files.map((f) => f.rank)).toEqual([1, 2]);
  });
});

describe("ndcgAtK", () => {
  it("is 1 for a perfect ranking and 0 for a miss", () => {
    expect(ndcgAtK([1], 8)).toBe(1);
    expect(ndcgAtK([], 8)).toBe(0);
  });

  it("discounts a hit at rank 2", () => {
    expect(ndcgAtK([2], 8)).toBeCloseTo(1 / Math.log2(3));
  });

  it("ignores ranks beyond the cutoff", () => {
    expect(ndcgAtK([9], 8)).toBe(0);
  });
});

describe("evaluateCase", () => {
  const base: EvalCase = {
    id: "case",
    category: "exact",
    question: "q",
    expectedFiles: ["target.pdf"],
  };

  it("records the rank of the first expected file", () => {
    const outcome = evaluateCase(base, [chunk("1", "other.pdf"), chunk("2", "target.pdf")], 8);
    expect(outcome.firstRank).toBe(2);
    expect(outcome.recall).toBe(1);
    expect(outcome.documentRecall).toBe(1);
    expect(outcome.reciprocalRank).toBe(0.5);
    expect(outcome.ndcgAtK).toBeCloseTo(1 / Math.log2(3));
  });

  it("scores a miss as zero", () => {
    const outcome = evaluateCase(base, [chunk("1", "other.pdf")], 8);
    expect(outcome.firstRank).toBeNull();
    expect(outcome.chunkFirstRank).toBeNull();
    expect(outcome.recall).toBe(0);
    expect(outcome.chunkRecall).toBe(0);
    expect(outcome.reciprocalRank).toBe(0);
  });

  it("separates document recall from evidence-bearing chunk recall", () => {
    const testCase = { ...base, evidence: ["4.87%"] };
    const outcome = evaluateCase(
      testCase,
      [chunk("1", "target.pdf", "No figures here"), chunk("1", "target.pdf", "Share 4.87%")],
      8,
    );
    expect(outcome.documentRecall).toBe(1);
    expect(outcome.chunkRecall).toBe(1);
    expect(outcome.chunkFirstRank).toBe(2);

    const weak = evaluateCase(testCase, [chunk("1", "target.pdf", "No figures here")], 8);
    expect(weak.documentRecall).toBe(1);
    expect(weak.chunkRecall).toBe(0);
  });

  it("treats a case with no expected file as unanswerable", () => {
    const outcome = evaluateCase({ ...base, expectedFiles: [] }, [chunk("1", "other.pdf")], 8);
    expect(outcome.answerable).toBe(false);
    expect(outcome.recall).toBe(0);
  });
});

describe("summarize", () => {
  it("averages recall and MRR over answerable cases only", () => {
    const outcomes = [
      evaluateCase({ id: "a", category: "exact", question: "", expectedFiles: ["a.pdf"] }, [
        chunk("1", "a.pdf"),
      ]),
      evaluateCase({ id: "b", category: "exact", question: "", expectedFiles: ["b.pdf"] }, [
        chunk("1", "a.pdf"),
        chunk("2", "b.pdf"),
      ]),
      evaluateCase({ id: "c", category: "vague", question: "", expectedFiles: ["c.pdf"] }, [
        chunk("1", "a.pdf"),
      ]),
      evaluateCase({ id: "d", category: "unanswerable", question: "", expectedFiles: [] }, []),
    ];
    const summary = summarize(outcomes);

    expect(summary.total).toBe(4);
    expect(summary.answerable).toBe(3);
    expect(summary.unanswerable).toBe(1);
    expect(summary.recallAtK).toBeCloseTo(2 / 3);
    expect(summary.documentRecallAtK).toBeCloseTo(2 / 3);
    expect(summary.chunkRecallAtK).toBeCloseTo(2 / 3);
    expect(summary.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(summary.byCategory["exact"]).toMatchObject({ total: 2, answerable: 2 });
    expect(summary.byCategory["unanswerable"]).toMatchObject({ total: 1, answerable: 0, mrr: 0 });
  });

  it("counts unanswerable questions that still returned passages", () => {
    const summary = summarize([
      evaluateCase({ id: "a", category: "unanswerable", question: "", expectedFiles: [] }, [
        chunk("1", "a.pdf"),
      ]),
      evaluateCase({ id: "b", category: "unanswerable", question: "", expectedFiles: [] }, []),
    ]);
    expect(summary.unanswerableWithResults).toBe(1);
    expect(summary.unanswerableFalsePositiveRate).toBe(0.5);
    expect(summary.recallAtK).toBe(0);
  });

  it("reports nDCG with binary document relevance", () => {
    const summary = summarize([
      evaluateCase({ id: "a", category: "chart", question: "", expectedFiles: ["a.pdf"] }, [
        chunk("1", "a.pdf"),
      ]),
      evaluateCase({ id: "b", category: "chart", question: "", expectedFiles: ["b.pdf"] }, [
        chunk("1", "a.pdf"),
        chunk("2", "b.pdf"),
      ]),
    ]);
    expect(summary.ndcgAtK).toBeCloseTo((1 + 1 / Math.log2(3)) / 2);
  });
});
