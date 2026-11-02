import { describe, expect, it } from "vitest";
import { canManageContent, roleFromRows } from "./permissions";

describe("content roles", () => {
  it("defaults everyone without an admin grant to member", () => {
    expect(roleFromRows([])).toBe("member");
    expect(roleFromRows([{ role: "member" }])).toBe("member");
  });
  it("recognizes the protected admin grant", () => {
    expect(roleFromRows([{ role: "member" }, { role: "admin" }])).toBe("admin");
  });
  it("admins can manage content uploaded by someone else", () => {
    expect(canManageContent("admin", "arjun", "other-uploader")).toBe(true);
  });
  it("members cannot manage another member's content", () => {
    expect(canManageContent("member", "member", "other-uploader")).toBe(false);
    expect(canManageContent("member", "member", "member")).toBe(true);
  });
});