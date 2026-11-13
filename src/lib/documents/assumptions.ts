/**
 * Illustrative assumptions. The user may ask for assumed volumes ("footfall",
 * "assume X visits"). Those numbers must never come from the model: they are
 * computed here, from figures the passages actually state, and every line is
 * labelled so the reader can see it is a working assumption rather than a
 * sourced fact.
 */
import type { Block, ChartSpec } from "./types";
import type { RetrievedChunk } from "../rag/search";

export const ASSUMPTION_LABEL = "Illustrative assumption";

export type AssumptionModel = {
  rows: { item: string; value: string; note: string }[];
  chart: ChartSpec;
  /** Every number the code model produced; the only values assumption charts may use. */
  values: number[];
  openItems: string[];
};

/**
 * The planning defaults. These are deliberately generic and labelled: no model
 * ever proposes them, and none of them is cited as a sourced fact.
 */
const DEFAULTS = {
  monthlyPassengers: 50_000,
  packageConversion: 8,
  nightsPerPackage: 3,
  hotelAdr: 120,
  logisticsAttach: 25,
};

/**
 * Code-only arithmetic for the illustrative economics slide. Low/base/high only
 * vary package conversion; every other input is the same declared default.
 */
export function buildAssumptionModel(): AssumptionModel {
  const packageRate = DEFAULTS.packageConversion / 100;
  const packages = Math.round(DEFAULTS.monthlyPassengers * packageRate);
  const roomNights = packages * DEFAULTS.nightsPerPackage;
  const hotelRevenue = roomNights * DEFAULTS.hotelAdr;
  const logisticsJobs = Math.round(packages * (DEFAULTS.logisticsAttach / 100));
  const low = Math.round(DEFAULTS.monthlyPassengers * 0.04);
  const high = Math.round(DEFAULTS.monthlyPassengers * 0.12);

  const rows = [
    {
      item: "Monthly passengers on target routes",
      value: DEFAULTS.monthlyPassengers.toLocaleString("en-GB"),
      note: "Planning default",
    },
    {
      item: "Share converting to a package",
      value: `${DEFAULTS.packageConversion}%`,
      note: "Planning default",
    },
    {
      item: "Average nights per package",
      value: String(DEFAULTS.nightsPerPackage),
      note: "Planning default",
    },
    {
      item: "Hotel average daily rate",
      value: `£${DEFAULTS.hotelAdr}`,
      note: "Planning default",
    },
    {
      item: "Logistics attach rate",
      value: `${DEFAULTS.logisticsAttach}%`,
      note: "Planning default",
    },
    {
      item: "Packages per month",
      value: packages.toLocaleString("en-GB"),
      note: "Passengers × conversion",
    },
    {
      item: "Room nights per month",
      value: roomNights.toLocaleString("en-GB"),
      note: "Packages × nights",
    },
    {
      item: "Hotel room revenue per month",
      value: `£${hotelRevenue.toLocaleString("en-GB")}`,
      note: "Room nights × ADR",
    },
    {
      item: "Logistics jobs per month",
      value: logisticsJobs.toLocaleString("en-GB"),
      note: "Packages × attach rate",
    },
  ];

  const chart: ChartSpec = {
    type: "bar",
    title: "Package volumes under low, base and high conversion",
    unit: "packages/month",
    categories: ["Low (4%)", "Base (8%)", "High (12%)"],
    series: [{ name: "Packages per month", values: [low, packages, high] }],
    basis: "assumption",
  };

  return {
    rows,
    chart,
    values: [
      DEFAULTS.monthlyPassengers,
      DEFAULTS.packageConversion,
      DEFAULTS.nightsPerPackage,
      DEFAULTS.hotelAdr,
      DEFAULTS.logisticsAttach,
      4,
      8,
      12,
      packages,
      roomNights,
      hotelRevenue,
      logisticsJobs,
      low,
      high,
    ],
    openItems: [
      "Replace the illustrative assumptions with the client's actual route volumes, package conversion, nights and hotel rates.",
      "The library does not contain consumer package pricing or hotel room-sales data; confirm these before sharing.",
    ],
  };
}

const COUNT = /(\d[\d,]*(?:\.\d+)?)\s?(thousand|million|bn)?\b/i;
const PERCENT = /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent)/i;

/** True for the code-generated assumption note, which has no passage to cite. */
export function isAssumptionBlock(block: Block): boolean {
  return (
    block.type === "callout" &&
    block.text.trim().toLowerCase().startsWith(ASSUMPTION_LABEL.toLowerCase())
  );
}

function firstCount(text: string): { value: number; raw: string } | null {
  const match = COUNT.exec(text);
  if (!match) return null;
  const value = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10) return null;
  const scale = (match[2] ?? "").toLowerCase();
  const multiplier =
    scale === "thousand"
      ? 1_000
      : scale === "million"
        ? 1_000_000
        : scale === "bn"
          ? 1_000_000_000
          : 1;
  return { value: value * multiplier, raw: match[0].trim() };
}

function firstPercent(text: string): { value: number; raw: string } | null {
  const match = PERCENT.exec(text);
  if (!match) return null;
  const value = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  return { value, raw: match[0].trim() };
}

/**
 * Deterministic arithmetic from one cited passage: count × percentage. Returns
 * null when the passages do not contain both figures, because inventing a
 * starting number would be worse than having no assumption at all.
 */
export function assumptionCallout(chunks: readonly RetrievedChunk[]): string | null {
  for (const chunk of chunks) {
    const count = firstCount(chunk.content);
    const percent = firstPercent(chunk.content);
    if (!count || !percent) continue;
    const derived = Math.round((count.value * percent.value) / 100);
    return [
      `${ASSUMPTION_LABEL} — planning arithmetic computed in code from the cited passages, not a forecast:`,
      `${count.raw} × ${percent.raw} = ${derived.toLocaleString("en-GB")} per cycle (${chunk.title}).`,
      "Replace with the client's own operating figures before this document is shared.",
    ].join(" ");
  }
  return null;
}
