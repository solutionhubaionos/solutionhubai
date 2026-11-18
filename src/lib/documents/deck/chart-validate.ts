/**
 * Chart integrity. Numbers in the deck already resolve through the claim
 * registry, so an invented value cannot reach a chart; this checks that the
 * resolved chart is drawable and honest: labels and values line up, values are
 * finite numbers, a pie is a whole with 2-6 readable slices, and no chart piles
 * on more series than a slide can carry.
 */

export type ResolvedChart = {
  kind: "bar" | "line" | "doughnut" | "range";
  categories: string[];
  series: { name: string; values: number[] }[];
};

export type ChartVerdict = { ok: true } | { ok: false; reason: string };

const MAX_SERIES = 6;
const MIN_PIE_SLICES = 2;
const MAX_PIE_SLICES = 6;
/** Slices below this share of the whole are merged into "Other". */
const MIN_PIE_SHARE = 0.03;

/** Drops the series that do not line up with the categories; rejects if none remain. */
export function alignSeries(
  categories: readonly string[],
  series: readonly { name: string; values: number[] }[],
): { name: string; values: number[] }[] {
  return series.filter((entry) => entry.values.length === categories.length);
}

export function validateChart(chart: ResolvedChart): ChartVerdict {
  if (chart.categories.length < 2) return { ok: false, reason: "fewer than two categories" };
  if (chart.series.length === 0) return { ok: false, reason: "no series with drawable values" };
  if (chart.series.length > MAX_SERIES) {
    return { ok: false, reason: `more than ${MAX_SERIES} series` };
  }
  for (const entry of chart.series) {
    if (entry.values.length !== chart.categories.length) {
      return { ok: false, reason: `series "${entry.name}" does not match the categories` };
    }
    if (entry.values.some((value) => !Number.isFinite(value))) {
      return { ok: false, reason: `series "${entry.name}" holds a non-finite value` };
    }
    if (chart.kind === "doughnut" && entry.values.some((value) => value < 0)) {
      return { ok: false, reason: "a pie slice is negative" };
    }
  }
  if (chart.kind === "doughnut") {
    const values = chart.series[0]?.values ?? [];
    const positive = values.filter((value) => value > 0).length;
    if (positive < MIN_PIE_SLICES) return { ok: false, reason: "a pie needs at least two slices" };
    if (positive > MAX_PIE_SLICES) return { ok: false, reason: "a pie needs at most six slices" };
  }
  return { ok: true };
}

/**
 * A pie must be a readable whole: drop non-positive slices and merge the tiny
 * ones into a single "Other" slice so labels never overlap. Returns the same
 * shape so the renderer can use it directly.
 */
export function tidyPie(
  categories: readonly string[],
  values: readonly number[],
): { categories: string[]; values: number[] } {
  const kept: { label: string; value: number }[] = [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let other = 0;
  categories.forEach((label, index) => {
    const value = Math.max(0, values[index] ?? 0);
    if (value <= 0) return;
    if (total > 0 && value / total < MIN_PIE_SHARE) {
      other += value;
      return;
    }
    kept.push({ label, value });
  });
  if (other > 0) kept.push({ label: "Other", value: other });
  return { categories: kept.map((entry) => entry.label), values: kept.map((entry) => entry.value) };
}
