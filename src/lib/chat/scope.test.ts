import { describe, expect, it } from "vitest";
import {
  EMPTY_CONTEXT,
  MAX_RETRIEVAL_SCOPES,
  buildRetrievalQuery,
  contextSummary,
  isValidWebsite,
  normaliseWebsite,
  retrievalInputs,
  retrievalScopes,
  titleFromQuestion,
} from "./scope";

describe("retrievalInputs", () => {
  it("filters on a single industry and customer", () => {
    const result = retrievalInputs({
      ...EMPTY_CONTEXT,
      industries: ["airlines"],
      clients: ["United Airlines"],
    });
    expect(result.filter).toEqual({ industry: "airlines", customer: "United Airlines" });
    expect(result.hints).toEqual([]);
  });

  it("moves several picks into the query text instead of dropping them", () => {
    const result = retrievalInputs({
      ...EMPTY_CONTEXT,
      industries: ["airlines", "airports"],
      clients: ["United Airlines", "Lufthansa"],
    });
    expect(result.filter).toEqual({});
    expect(result.hints).toEqual(["airlines", "airports", "United Airlines", "Lufthansa"]);
  });

  it("keeps personas, sectors and the website as hints", () => {
    const result = retrievalInputs({
      ...EMPTY_CONTEXT,
      personas: ["CIO / CTO"],
      sectors: ["Payments"],
      website: "https://WWW.acme.com/",
    });
    expect(result.filter).toEqual({});
    expect(result.hints).toEqual(["CIO / CTO", "Payments", "acme.com"]);
  });
});

describe("retrievalScopes", () => {
  it("searches everything when no context is picked", () => {
    expect(retrievalScopes(EMPTY_CONTEXT)).toEqual([{}]);
  });

  it("searches each picked industry separately", () => {
    expect(retrievalScopes({ ...EMPTY_CONTEXT, industries: ["airports", "telecom"] })).toEqual([
      { industry: "airports" },
      { industry: "telecom" },
    ]);
  });

  it("pairs industries with companies so every pick is actually filtered", () => {
    expect(
      retrievalScopes({
        ...EMPTY_CONTEXT,
        industries: ["airports", "telecom"],
        clients: ["Heathrow", "Vodafone"],
      }),
    ).toEqual([
      { industry: "airports", customer: "Heathrow" },
      { industry: "airports", customer: "Vodafone" },
      { industry: "telecom", customer: "Heathrow" },
      { industry: "telecom", customer: "Vodafone" },
    ]);
  });

  it("keeps the number of scoped searches bounded", () => {
    const industries = Array.from({ length: 20 }, (_, index) => `industry-${index}`);
    const clients = Array.from({ length: 20 }, (_, index) => `client-${index}`);
    expect(retrievalScopes({ ...EMPTY_CONTEXT, industries, clients })).toHaveLength(
      MAX_RETRIEVAL_SCOPES,
    );
  });
});

describe("buildRetrievalQuery", () => {
  it("returns the plain question when no context is set", () => {
    expect(buildRetrievalQuery("  What is Smart Verify?  ", EMPTY_CONTEXT)).toBe(
      "What is Smart Verify?",
    );
  });

  it("appends the hints on their own line", () => {
    expect(
      buildRetrievalQuery("Where is our proof?", { ...EMPTY_CONTEXT, sectors: ["Payments"] }),
    ).toBe("Where is our proof?\nContext: Payments");
  });
});

describe("website helpers", () => {
  it("normalises scheme, www and trailing slash", () => {
    expect(normaliseWebsite("HTTPS://www.Example.com/")).toBe("example.com");
  });

  it("accepts plausible addresses and rejects junk", () => {
    expect(isValidWebsite("acme.com")).toBe(true);
    expect(isValidWebsite("https://www.acme.co.uk/path")).toBe(true);
    expect(isValidWebsite("acme")).toBe(false);
    expect(isValidWebsite("not a website")).toBe(false);
  });
});

describe("contextSummary", () => {
  it("resolves industry slugs to names and drops blanks", () => {
    expect(
      contextSummary(
        { ...EMPTY_CONTEXT, industries: ["airlines"], website: " " },
        { airlines: "Airlines" },
      ),
    ).toEqual(["Airlines"]);
  });
});

describe("titleFromQuestion", () => {
  it("collapses whitespace and truncates long questions", () => {
    expect(titleFromQuestion("  What   is Smart Verify? ")).toBe("What is Smart Verify?");
    expect(titleFromQuestion("x".repeat(80))).toHaveLength(48);
  });
});
