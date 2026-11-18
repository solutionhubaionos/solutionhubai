/**
 * Renders the golden-set decks through the real brand renderer into `qa/golden/`.
 *
 *   bun scripts/render-golden.ts
 *
 * Four clients, one story each: GMR Airports, DFW Airport, Zurich Airport and
 * Ethiopian Airlines. The deck uses only `aionos.tokens.json` colours, so this
 * doubles as a style acceptance check: every deck must pass the palette lint.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { renderDeck } from "../src/lib/documents/render/deck";
import { checkDeckPalette } from "../src/lib/documents/render/palette-check";
import type {
  Claim,
  DeckSlideContent,
  DeckSpec,
  DeckSpecSlide,
} from "../src/lib/documents/deck/types";

const OUT = "qa/golden";

type Client = {
  slug: string;
  name: string;
  url: string;
  audience: string;
  storyline: string;
  subtitle: string;
};

const CLIENTS: Client[] = [
  {
    slug: "gmr-airports",
    name: "GMR Airports",
    url: "https://www.gmrairports.com",
    audience: "Executive committee",
    storyline:
      "One operational data platform turns scattered airport systems into a single, predictive view.",
    subtitle: "Operational data platform",
  },
  {
    slug: "dfw-airport",
    name: "DFW Airport",
    url: "https://www.dfwairport.com",
    audience: "Operations board",
    storyline:
      "A shared data layer shortens the path from a gate event to the decision that resolves it.",
    subtitle: "Connected airport operations",
  },
  {
    slug: "zurich-airport",
    name: "Zurich Airport",
    url: "https://www.zurich-airport.com",
    audience: "Programme sponsors",
    storyline:
      "Passenger flow data, read once and trusted by every team, removes the daily guesswork.",
    subtitle: "Passenger flow intelligence",
  },
  {
    slug: "ethiopian-airlines",
    name: "Ethiopian Airlines",
    url: "https://www.ethiopianairlines.com",
    audience: "Commercial leadership",
    storyline:
      "A single view of operations and revenue lets a growing network plan with the same numbers.",
    subtitle: "Network operations platform",
  },
];

function claim(
  id: string,
  metric: string,
  valueText: string,
  unit: string,
  context: string,
): Claim {
  return {
    id,
    metric,
    valueText,
    unit,
    valueMin: Number.parseFloat(valueText),
    valueMax: Number.parseFloat(valueText),
    context,
    sourceTitle: "Aionos benchmark",
    sourceYear: 2025,
    origin: "library",
  };
}

function slide(
  id: string,
  layout: DeckSlideContent,
  actionTitle: string,
  claimIds: string[] = [],
): DeckSpecSlide {
  return {
    id,
    layout: layout.layout,
    actionTitle,
    purpose: "Carry the argument",
    tier: claimIds.length > 0 ? "illustrative" : "sourced",
    content: layout,
    notes: "Walk the client through the point and agree the next step.",
    claimIds,
  };
}

function deckFor(client: Client): DeckSpec {
  const claims: DeckSpec["claims"] = {
    "CL-1": claim("CL-1", "manual rework", "34%", "%", "of daily tasks"),
    "CL-2": claim("CL-2", "decision time", "22", "minutes", "to resolve a gate event"),
    "CL-3": claim("CL-3", "on-time departures", "9%", "%", "after the change"),
    "CL-4": claim("CL-4", "systems replaced", "4", "systems", "consolidated into one platform"),
    "CL-5": claim("CL-5", "decision time today", "45", "minutes", "to resolve a gate event"),
  };

  const slides: DeckSpecSlide[] = [
    // Order matters: white-slide layouts (KPI, chart, table, compare) must land
    // on even content positions so the strict BLUE/WHITE alternation puts them
    // on WHITE. The free slides between them take the navy positions.
    slide(
      "s3",
      {
        layout: "kpi-cards",
        cards: [
          { label: "Less manual rework", claimId: "CL-1" },
          { label: "Faster decisions", claimId: "CL-2" },
          { label: "More on-time departures", claimId: "CL-3" },
        ],
      },
      "The gains are measured, not promised",
      ["CL-1", "CL-2", "CL-3"],
    ),
    slide(
      "s1",
      {
        layout: "section-divider",
        label: "Where the work starts",
        statement: "One shared view of the operation.",
      },
      "Where the work starts",
    ),
    slide(
      "s4",
      {
        layout: "chart-with-takeaway",
        chart: {
          kind: "bar",
          title: "Time to resolve a gate event",
          unit: "minutes",
          series: [
            {
              name: "Minutes",
              points: [
                { label: "Today", claimId: "CL-5" },
                { label: "With one platform", claimId: "CL-2" },
              ],
            },
          ],
        },
        takeaway: "A shorter path from event to decision compounds across every shift.",
      },
      "Decisions get faster when one system holds the truth",
      ["CL-5", "CL-2"],
    ),
    slide(
      "s2",
      {
        layout: "context-bullets",
        bullets: [
          {
            text: "Teams work from separate systems and their own copy of the numbers.",
            claimIds: [],
          },
          {
            text: "A gate event is resolved by phone, not by the system that sees it first.",
            claimIds: [],
          },
          {
            text: "Every shift rebuilds context that the previous shift already had.",
            claimIds: [],
          },
        ],
      },
      "Scattered systems keep the operation reactive",
    ),
    slide(
      "s5",
      {
        layout: "table-compact",
        headers: ["Today", "With one platform"],
        rows: [
          ["Four systems", "One workspace"],
          ["Manual rework", "Handled in the flow"],
          ["Reactive shifts", "Shared situational view"],
        ],
      },
      "The change consolidates the toolset",
    ),
    slide(
      "s6",
      {
        layout: "process-roadmap",
        steps: [
          { label: "Connect", detail: "Bring the operational sources into one layer." },
          { label: "Explain", detail: "Turn events into a shared, current picture." },
          { label: "Predict", detail: "Surface the next constraint before it bites." },
        ],
      },
      "The platform arrives in three moves",
    ),
    slide(
      "s7",
      {
        layout: "two-column-compare",
        left: {
          heading: "Where we start",
          points: ["Separate systems", "Manual handovers", "Reactive shifts"],
        },
        right: {
          heading: "Where we land",
          points: ["One workspace", "Automated flow", "Predictive shifts"],
        },
      },
      "The operating model moves from reactive to predictive",
    ),
    slide(
      "s8",
      {
        layout: "next-steps-ask",
        ask: "Agree the first pilot",
        steps: [
          { text: "Name the pilot site and the two metrics", owner: client.name },
          { text: "Connect the sources with our team", owner: "Aionos" },
          { text: "Review the first results together", owner: "Joint" },
        ],
      },
      "Approve the pilot and we start next month",
    ),
  ];

  return {
    deckTitle: `${client.name} — ${client.subtitle}`,
    audience: client.audience,
    storyline: client.storyline,
    claims,
    entities: [client.name],
    gaps: [],
    warnings: [],
    slides,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest: { slug: string; name: string; url: string; file: string; pages: number }[] = [];
  for (const client of CLIENTS) {
    const spec = deckFor(client);
    const rendered = await renderDeck(spec, {
      date: "18 November 2026",
      subtitle: client.subtitle,
    });
    const parts = unzipSync(rendered.bytes);
    const findings = checkDeckPalette(parts);
    if (findings.length > 0) {
      throw new Error(`${client.slug}: off-palette ${JSON.stringify(findings.slice(0, 5))}`);
    }
    const file = `${OUT}/${client.slug}.pptx`;
    writeFileSync(file, rendered.bytes);
    manifest.push({
      slug: client.slug,
      name: client.name,
      url: client.url,
      file,
      pages: rendered.pages,
    });
    console.log(`OK ${file}: ${rendered.pages} slides, palette clean`);
  }
  writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
