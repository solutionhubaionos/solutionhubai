import { describe, expect, it } from "vitest";
import { filterAdminFiles, storageSummary } from "./admin-content";
import type { ContentItem } from "./content";

const base: ContentItem = {
  id: "1",
  industry: "hospitality",
  customer_name: "Hotel A",
  title: "Guest solution",
  solution: null,
  description: null,
  content_type: "proposal",
  file_path: "one.pdf",
  file_name: "one.pdf",
  file_size: 1024,
  mime_type: "application/pdf",
  uploaded_by: "owner",
  uploader_email: null,
  created_at: "2026-10-22T23:59:59Z",
};
const files = [
  base,
  {
    ...base,
    id: "2",
    industry: "logistics",
    customer_name: null,
    file_path: "two.pdf",
    file_name: "two.pdf",
    file_size: 2048,
    created_at: "2026-10-21T12:00:00Z",
  },
];
describe("admin file filters", () => {
  it("limits results to the selected industry", () =>
    expect(filterAdminFiles(files, { industry: "hospitality" }).map((f) => f.id)).toEqual(["1"]));
  it("limits results to the selected customer", () =>
    expect(filterAdminFiles(files, { customer: "Hotel A" }).map((f) => f.id)).toEqual(["1"]));
  it("separates industry-wide content", () =>
    expect(filterAdminFiles(files, { customer: "__industry_wide__" }).map((f) => f.id)).toEqual([
      "2",
    ]));
  it("includes the entire end date in UTC", () =>
    expect(
      filterAdminFiles(files, { from: "2026-10-22", to: "2026-10-22" }).map((f) => f.id),
    ).toEqual(["1"]));
  it("searches file names", () =>
    expect(filterAdminFiles(files, { q: "two.pdf" }).map((f) => f.id)).toEqual(["2"]));
  it("sorts largest files first", () =>
    expect(filterAdminFiles(files, { sort: "largest" }).map((f) => f.id)).toEqual(["2", "1"]));
});
describe("storage report", () => {
  it("totals each physical file once", () =>
    expect(storageSummary([...files, { ...base, id: "3" }])).toEqual({
      bytes: 3072,
      unknown: 0,
      files: 2,
    }));
  it("reports unknown sizes instead of estimating", () =>
    expect(storageSummary([{ ...base, file_size: null }])).toEqual({
      bytes: 0,
      unknown: 1,
      files: 1,
    }));
});
