import { describe, expect, it } from "vitest";
import { passwordRedirect } from "./auth-security";

describe("password reset destination", () => {
  it("uses the primary Solution Hub domain", () => {
    expect(passwordRedirect("https://solutionhub.aionos.ai")).toBe(
      "https://solutionhub.aionos.ai/reset-password",
    );
  });
  it("rejects attacker domains and misleading credentials", () => {
    for (const origin of [
      "https://attacker.example",
      "https://solutionhub.aionos.ai.attacker.example",
      "https://attacker@solutionhub.aionos.ai",
      "https://solutionhub.aionos.ai/?next=evil",
    ]) {
      expect(() => passwordRedirect(origin)).toThrow();
    }
  });
});
