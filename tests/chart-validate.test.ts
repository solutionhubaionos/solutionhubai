import { describe, expect, test } from "bun:test";
import { tidyPie, validateChart } from "../src/lib/documents/deck/chart-validate";

describe("chart validation", () => {
  test("accepts a bar chart whose labels and values line up", () => {
    expect(
      validateChart({
        kind: "bar",
        categories: ["A", "B", "C"],
        series: [
          { name: "Units", values: [1, 2, 3] },
          { name: "Value", values: [4, 5, 6] },
        ],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a series that does not match the categories", () => {
    const verdict = validateChart({
      kind: "bar",
      categories: ["A", "B", "C"],
      series: [{ name: "Units", values: [1, 2] }],
    });
    expect(verdict.ok).toBe(false);
  });

  test("rejects a non-finite value", () => {
    const verdict = validateChart({
      kind: "line",
      categories: ["A", "B"],
      series: [{ name: "Units", values: [1, Number.NaN] }],
    });
    expect(verdict.ok).toBe(false);
  });

  test("rejects more than six series", () => {
    const verdict = validateChart({
      kind: "bar",
      categories: ["A", "B"],
      series: Array.from({ length: 7 }, (_, index) => ({ name: `S${index}`, values: [1, 2] })),
    });
    expect(verdict.ok).toBe(false);
  });

  test("a pie needs two to six positive slices", () => {
    expect(
      validateChart({ kind: "doughnut", categories: ["A", "B"], series: [{ name: "Share", values: [60, 40] }] }),
    ).toEqual({ ok: true });
    expect(
      validateChart({ kind: "doughnut", categories: ["A"], series: [{ name: "Share", values: [100] }] }).ok,
    ).toBe(false);
    expect(
      validateChart({
        kind: "doughnut",
        categories: ["A", "B", "C", "D", "E", "F", "G"],
        series: [{ name: "Share", values: [1, 1, 1, 1, 1, 1, 1] }],
      }).ok,
    ).toBe(false);
  });

  test("tidyPie merges tiny slices into Other and drops empties", () => {
    const tidied = tidyPie(
      ["Big", "Also big", "Tiny", "Empty"],
      [70, 29, 1, 0],
    );
    expect(tidied.categories).toEqual(["Big", "Also big", "Other"]);
    expect(tidied.values.reduce((sum, value) => sum + value, 0)).toBe(100);
  });
});
