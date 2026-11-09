import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  checkCitations,
  checkNumericFaithfulness,
  completeness,
  extractNumbers,
  isRefusal,
  parseJudgeVerdicts,
  splitSentences,
} from "./answer-eval";

describe("splitSentences", () => {
  it("does not break on abbreviations or decimals", () => {
    const sentences = splitSentences(
      "Revenue rose 4.87%, e.g. in motor. The U.S. arm grew 2.5x. Solvency was 1.59x.",
    );
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toContain("e.g. in motor");
    expect(sentences[1]).toContain("U.S. arm");
  });

  it("keeps bullets as separate units", () => {
    expect(splitSentences("- First point.\n- Second point.")).toHaveLength(2);
  });
});

describe("extractNumbers", () => {
  it("normalises scale words and currency", () => {
    const [token] = extractNumbers("$2 million");
    expect(token).toMatchObject({ kind: "number", value: 2_000_000 });
    expect(extractNumbers("2,000,000")[0]?.value).toBe(2_000_000);
    expect(extractNumbers("$2M")[0]?.value).toBe(2_000_000);
  });

  it("keeps percentages and multiples distinct", () => {
    expect(extractNumbers("30%")[0]).toMatchObject({ kind: "percent", value: 30 });
    expect(extractNumbers("1.59x")[0]).toMatchObject({ kind: "multiple", value: 1.59 });
  });
});

describe("checkNumericFaithfulness", () => {
  it("accepts equivalent forms of a cited number", () => {
    const result = checkNumericFaithfulness("It saved $2 million [1].", [
      "The programme saved $2M in year one.",
    ]);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("flags a number that is absent from the cited passages", () => {
    const result = checkNumericFaithfulness("It saved $4 million [1].", [
      "The programme saved $2M in year one.",
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.raw).toBe("4 m");
  });

  it("flags a percentage with no cited source", () => {
    const result = checkNumericFaithfulness("CSAT rose 40% [2].", ["CSAT rose 6%."]);
    expect(result.violations[0]?.raw).toBe("40%");
  });
});

describe("checkCitations", () => {
  it("reports markers outside the passage range", () => {
    const result = checkCitations("Claim [1]. Another [7].", 3);
    expect(result.cited).toEqual([1]);
    expect(result.invalid).toEqual([7]);
  });

  it("flags numeric sentences with no citation", () => {
    const result = checkCitations("Revenue rose 12%. Costs fell [1].", 2);
    expect(result.uncitedNumericSentences).toHaveLength(1);
    expect(result.uncitedNumericSentences[0]).toContain("12%");
  });
});

describe("completeness", () => {
  it("scores the share of required facts that appear", () => {
    const result = completeness("Net written premium was $868M, up 7.1% [1].", [
      "868",
      "7.1",
      "4.87%",
    ]);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.missing).toEqual(["4.87%"]);
  });

  it("is 1 when nothing is required", () => {
    expect(completeness("anything", [])).toEqual({ score: 1, missing: [] });
  });
});

describe("isRefusal", () => {
  it("recognises a plain refusal", () => {
    expect(isRefusal("That is not covered in the library.")).toBe(true);
    expect(isRefusal("I couldn't find any relevant passages.")).toBe(true);
  });

  it("does not treat a grounded answer as a refusal", () => {
    expect(isRefusal("United Next is the growth plan [1].")).toBe(false);
  });
});

describe("judge prompt and parsing", () => {
  it("builds a strict JSON rubric with only the cited passages", () => {
    const prompt = buildJudgePrompt(
      "What is the solvency ratio?",
      [{ index: 0, text: "Solvency was 1.59x [1].", citations: [1] }],
      new Map([
        [1, "Solvency ratio 1.59x"],
        [2, "Uncited passage"],
      ]),
    );
    expect(prompt).toContain("Solvency was 1.59x [1].");
    expect(prompt).toContain("Solvency ratio 1.59x");
    expect(prompt).not.toContain("Uncited passage");
    expect(prompt).toContain('"supported"');
  });

  it("parses verdicts and leaves missing ones null", () => {
    const verdicts = parseJudgeVerdicts(
      '```json\n{"sentences":[{"index":0,"supported":true,"reason":"states it"},{"index":1,"supported":false,"reason":"not stated"}]}\n```',
      3,
    );
    expect(verdicts[0]?.supported).toBe(true);
    expect(verdicts[1]?.supported).toBe(false);
    expect(verdicts[2]).toBeNull();
  });

  it("returns all nulls for malformed output", () => {
    expect(parseJudgeVerdicts("no json here", 2)).toEqual([null, null]);
  });
});
