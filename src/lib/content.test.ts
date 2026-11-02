import { describe, expect, it } from "vitest";
import { sortByDate } from "./content";

const items = [{ id: "b", created_at: "2026-02-01T00:00:00Z" }, { id: "a", created_at: "2026-01-01T00:00:00Z" }, { id: "c", created_at: "2026-03-01T00:00:00Z" }];
describe("sortByDate", () => {
  it("newest first", () => expect(sortByDate(items, "newest").map((i) => i.id)).toEqual(["c", "b", "a"]));
  it("oldest first", () => expect(sortByDate(items, "oldest").map((i) => i.id)).toEqual(["a", "b", "c"]));
});
