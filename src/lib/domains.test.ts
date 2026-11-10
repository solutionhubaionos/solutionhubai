import { describe, expect, it } from "vitest";
import { isAllowedEmail } from "./domains";

describe("isAllowedEmail", () => {
  it("allows all five company domains", () => {
    for (const d of [
      "aionos.ai",
      "whilter.ai",
      "inetum.com",
      "cloudanalogy.com",
      "perpetuuitiaionos.com",
    ]) {
      expect(isAllowedEmail(`jane@${d}`)).toBe(true);
    }
  });
  it("is case-insensitive", () => {
    expect(isAllowedEmail("Jane@AIONOS.AI")).toBe(true);
  });
  it("rejects other domains and lookalikes", () => {
    expect(isAllowedEmail("jane@gmail.com")).toBe(false);
    expect(isAllowedEmail("jane@sub.aionos.ai")).toBe(false);
    expect(isAllowedEmail("jane@aionos.ai.evil.com")).toBe(false);
  });
});
