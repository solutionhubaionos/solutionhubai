import { describe, expect, it } from "vitest";
import { uploadDestination } from "./upload-destination";

describe("upload destination", () => {
  it("uses Hospitality instead of a stale Logistics selection", () => {
    expect(uploadDestination("hospitality", "logistics", "industry", "")).toEqual({ industry: "hospitality", customer_name: null });
  });
  it("uses Healthcare instead of a previously visited industry", () => {
    expect(uploadDestination("healthcare-and-life-sciences", "hospitality", "industry", "").industry).toBe("healthcare-and-life-sciences");
  });
  it("keeps industry-wide content out of a previously selected company", () => {
    expect(uploadDestination("hospitality", "", "industry", "Accor Hotels").customer_name).toBeNull();
  });
  it("assigns company content to its named company and current industry", () => {
    expect(uploadDestination("hospitality", "logistics", "company", "Accor Hotels")).toEqual({ industry: "hospitality", customer_name: "Accor Hotels" });
  });
  it("requires a company for company-specific content", () => {
    expect(() => uploadDestination("hospitality", "", "company", " ")).toThrow("Choose or enter a company");
  });
});