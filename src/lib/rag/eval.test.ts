import { describe, expect, it } from "vitest";
import { evaluateCase, fileMatchesExpected, rankFiles, summarize, type EvalCase } from "./eval";
import type { RetrievedChunk } from "./search";

function chunk(contentId: string, fileName: string, title = fileName): RetrievedChunk {
  return {
    chunkId: `${contentId}-0`,
    contentId,
    content: "passage",
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

describe("evaluateCase", () => {
  const base: EvalCase = {
    id: "case",
    category: "exact",
    question: "q",
    expectedFiles: ["target.pdf"],
  };

  it("records the rank of the first expected file", () => {
    const outcome = evaluateCase(base, [chunk("1", "other.pdf"), chunk("2", "target.pdf")]);
    expect(outcome.firstRank).toBe(2);
    expect(outcome.recall).toBe(1);
    expect(outcome.reciprocalRank).toBe(0.5);
  });

  it("scores a miss as zero", () => {
    const outcome = evaluateCase(base, [chunk("1", "other.pdf")]);
    expect(outcome.firstRank).toBeNull();
    expect(outcome.recall).toBe(0);
    expect(outcome.reciprocalRank).toBe(0);
  });

  it("treats a case with no expected file as unanswerable", () => {
    const outcome = evaluateCase({ ...base, expectedFiles: [] }, [chunk("1", "other.pdf")]);
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
    expect(summary.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(summary.byCategory["exact"]).toMatchObject({ total: 2, answerable: 2 });
    expect(summary.byCategory["unanswerable"]).toMatchObject({ total: 1, answerable: 0, mrr: 0 });
  });

  it("counts unanswerable questions that still returned passages", () => {
    const summary = summarize([
      evaluateCase({ id: "a", category: "unanswerable", question: "", expectedFiles: [] }, [
        chunk("1", "a.pdf"),
      ]),
    ]);
    expect(summary.unanswerableWithResults).toBe(1);
    expect(summary.recallAtK).toBe(0);
  });
});
