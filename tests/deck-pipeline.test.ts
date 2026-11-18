/**
 * Contract tests for the planner → writer → critic deck pipeline. These are the
 * defects the pipeline exists to prevent: leaked assumptions, provenance
 * language, unvalidated parties, label titles, paged slides and untraceable
 * numbers.
 */
import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { buildDocument } from "../src/lib/documents/build";
import { claimsFromChunks, loadClaims } from "../src/lib/documents/deck/claims";
import {
  groundedEntities,
  isValidPartyName,
  partyList,
  retrievalEntityNames,
} from "../src/lib/documents/deck/entities";
import { buildEvidencePack } from "../src/lib/documents/deck/evidence";
import { contentSchemaFor } from "../src/lib/documents/deck/catalog";
import { deterministicCritic } from "../src/lib/documents/deck/critic";
import { LAYOUT_SHAPES, fitContent } from "../src/lib/documents/deck/shapes";
import { WRITER_SYSTEM, writerUserPrompt } from "../src/lib/documents/deck/writer";
import { PLANNER_SYSTEM, plannerUserPrompt } from "../src/lib/documents/deck/planner";
import { DECK_SYSTEM, deckUserPrompt } from "../src/lib/documents/deck";
import type { ExportBrief } from "../src/lib/documents/types";
import type {
  DeckSlideContent,
  DeckSpec,
  DeckSpecSlide,
  PlannerLayoutId,
} from "../src/lib/documents/deck/types";
import { extractChunkFacts } from "../src/lib/rag/facts";
import { loadValidatedEntities } from "../src/lib/rag/entities";
import { sanitiseSlide, hasBannedCopy } from "../src/lib/documents/deck/text-guards";
import { visibleStrings } from "../src/lib/documents/deck/writer";
import { assertDeckTraceable, renderDeck } from "../src/lib/documents/render/deck";
import { renderPptx } from "../src/lib/documents/render/pptx";
import { contrastRatio } from "../src/lib/brand/color";
import { CHUNKS, createMockFetch, createMockSupabase, deckHistory, draftFor } from "./fixtures";

const PROVIDER = {
  apiKey: "test",
  baseUrl: "https://mock.local",
  fetchImpl: createMockFetch(),
};

function everyVisibleText(
  model: NonNullable<Awaited<ReturnType<typeof buildDocument>>["model"]["deck"]>,
) {
  return model.slides.flatMap((slide) => [slide.actionTitle, ...visibleStrings(slide.content)]);
}

describe("claims and party validation", () => {
  test("extracts sourced claims with exact values and provenance", () => {
    const registry = claimsFromChunks(CHUNKS);
    const claims = Object.values(registry);
    expect(claims.length).toBeGreaterThan(10);
    expect(claims.every((claim) => claim.id.startsWith("CL-"))).toBe(true);
    expect(claims.some((claim) => claim.valueText.includes("%"))).toBe(true);
    expect(claims.some((claim) => claim.valueText.includes("days"))).toBe(true);
    expect(claims.every((claim) => claim.sourceTitle.length > 0)).toBe(true);
  });

  test("keeps wizard companies and drops concepts and instructions", () => {
    expect(isValidPartyName("Adani Airports")).toBe(true);
    expect(isValidPartyName("InterGlobe Hotels")).toBe(true);
    expect(isValidPartyName("18 hotel functions")).toBe(false);
    expect(isValidPartyName("hotel-platform")).toBe(false);
    expect(isValidPartyName("create a pitch deck")).toBe(false);
    const parties = partyList({
      wizardCompanies: ["Adani Airports", "IndiGo", "hotel-platform"],
      briefParties: ["Accor Hotels", "18 hotel functions", "create a proposal"],
      evidenceNames: ["InterGlobe Aviation"],
    });
    expect(parties).toEqual(
      expect.arrayContaining(["Adani Airports", "IndiGo", "Accor Hotels", "InterGlobe Aviation"]),
    );
    expect(parties).not.toContain("hotel-platform");
    expect(parties).not.toContain("18 hotel functions");
  });

  test("treats a validated concept as a concept, not a party", () => {
    expect(
      partyList({
        briefParties: ["Insurance"],
        validatedEntities: [{ name: "Insurance", type: "concept" }],
      }),
    ).not.toContain("Insurance");
  });

  test("keeps only validated parties when the entities table answered", () => {
    // A live run produced parties like these from a brief about one company.
    const parties = partyList({
      briefParties: ["Adani Airports", "our company", "Charts", "KPIs", "Adani Power"],
      conversationEntities: ["AI operations center"],
      evidenceNames: ["Adani Airports", "Charts"],
      validatedEntities: [
        { name: "Adani Airports", type: "company" },
        { name: "Adani Power", type: "concept" },
      ],
      authoritative: true,
    });
    expect(parties).toEqual(["Adani Airports"]);
  });

  test("resolves a short brief name to its canonical validated party", () => {
    expect(
      partyList({
        briefParties: ["Adani"],
        validatedEntities: [{ name: "Adani Airports", type: "company" }],
        authoritative: true,
      }),
    ).toEqual(["Adani Airports"]);
  });

  test("drops the matched brief span from an entity's spellings", async () => {
    // The RPC reports the best-scoring candidate as matched_name; for a near
    // neighbour that span can be a different company's name.
    const client = {
      rpc: async () => ({
        data: [
          {
            id: "e1",
            name: "Adani Power",
            entity_type: "company",
            industry: null,
            score: 0.51,
            matched_name: "Adani Airports",
            spellings: ["Adani Power", "Adani Airports"],
          },
        ],
        error: null,
      }),
    };
    const lookup = await loadValidatedEntities(client as never, ["Adani Power"]);
    expect(lookup.available).toBe(true);
    expect(lookup.entities[0]?.spellings).toEqual(["Adani Power"]);
  });

  test("keeps only entities the user's own words name", () => {
    // All three score highly: two are exact strings the brief listed.
    const entities = [
      { name: "Adani Airports", type: "company", spellings: ["Adani Airports"] },
      { name: "Zurich Airport", type: "company", spellings: ["Zurich Airport"] },
      { name: "Adani Power", type: "company", spellings: ["Adani Power"] },
    ];
    const kept = groundedEntities({
      entities,
      requestText:
        "build a pitch deck for adani airports on airport operations and ai propositions",
    });
    expect(kept.map((entity) => entity.name)).toEqual(["Adani Airports"]);
  });

  test("an alias spelling still grounds a misspelt request", () => {
    const kept = groundedEntities({
      entities: [
        {
          name: "InterGlobe Hotels",
          type: "company",
          spellings: ["InterGlobe Hotels", "InterGlode Hotels"],
        },
      ],
      requestText: "build a deck for interglode hotels",
    });
    expect(kept.map((entity) => entity.name)).toEqual(["InterGlobe Hotels"]);
  });

  test("retrieval never searches a company the brief invented", () => {
    expect(
      retrievalEntityNames({
        clientName: "Adani Airports",
        briefParties: ["Adani Airports", "our company"],
        briefEntities: ["Adani Power"],
        validatedEntities: [{ name: "Adani Airports", type: "company" }],
        authoritative: true,
      }),
    ).toEqual(["Adani Airports"]);
  });

  test("every layout skeleton satisfies that layout's own schema", () => {
    for (const [layout, shape] of Object.entries(LAYOUT_SHAPES) as [PlannerLayoutId, string][]) {
      const parsed = contentSchemaFor(layout).parse(JSON.parse(shape)) as { layout: string };
      expect(parsed.layout).toBe(layout);
    }
  });

  test("keeps an untraced figure out of a repaired action title", () => {
    // The critic can fall back to the planner's purpose sentence for a title;
    // a purpose like "approve a 90-day pilot" would fail render traceability.
    const slide: DeckSpecSlide = {
      id: "s1",
      layout: "next-steps-ask",
      actionTitle: "Pilot proposal",
      purpose: "Approve a 90-day AI operations pilot with joint KPIs",
      tier: "inferred",
      content: {
        layout: "next-steps-ask",
        ask: "Approve the pilot",
        steps: [{ text: "Approve the pilot scope" }],
      },
      notes: "",
      claimIds: [],
    };
    const { slides } = deterministicCritic([slide], buildEvidencePack(CHUNKS, [], {}));
    expect(slides[0]?.actionTitle ?? "").not.toMatch(/\d/);
    expect((slides[0]?.actionTitle ?? "").length).toBeGreaterThan(8);
  });

  test("repairs a planning instruction instead of shipping it as a title", () => {
    // A live planner run returned its own layout brief as the slide title, and a
    // label title gained the invented suffix "changes the economics".
    const bullets = (text: string): DeckSpecSlide => ({
      id: text.slice(0, 8),
      layout: "context-bullets",
      actionTitle: text,
      purpose: "Explain the current challenge.",
      tier: "inferred",
      content: {
        layout: "context-bullets",
        bullets: [
          { text: "One intake queue replaces three handovers", claimIds: [] },
          { text: "Shared definitions make performance comparable", claimIds: [] },
        ],
      },
      notes: "",
      claimIds: [],
    });
    const { slides } = deterministicCritic(
      [
        bullets("Close with the decision requested and first actions"),
        bullets("Manual reconciliation across separate systems slows operational decisions"),
        bullets("Set the situation: fragmented data slows executive decisions"),
      ],
      buildEvidencePack(CHUNKS, [], {}),
    );
    for (const slide of slides) {
      expect(slide.actionTitle).not.toContain("changes the economics");
      expect(slide.actionTitle).not.toMatch(/^(?:close|show|explain|frame)\b/i);
      expect(slide.actionTitle).not.toMatch(/decision requested|first actions/i);
      expect(slide.actionTitle).not.toMatch(/^set the situation/i);
    }
    expect(new Set(slides.map((slide) => slide.actionTitle)).size).toBe(slides.length);
  });

  test("shortens over-long copy instead of rejecting the slide", () => {
    const long = "Adani Airports runs one integrated control room across every terminal. ".repeat(
      6,
    );
    const fitted = fitContent({
      layout: "table-compact",
      headers: ["Risk", "How we manage it"],
      rows: [
        [long, long],
        [long, long],
      ],
    } as DeckSlideContent);
    expect(contentSchemaFor("table-compact").safeParse(fitted).success).toBe(true);
    const cells = (fitted as Extract<DeckSlideContent, { layout: "table-compact" }>).rows.flat();
    expect(cells.every((cell) => cell.length <= 120)).toBe(true);
    const divider = fitContent({
      layout: "section-divider",
      label: "Where the airport stands today",
      statement: long,
    } as DeckSlideContent) as Extract<DeckSlideContent, { layout: "section-divider" }>;
    expect(divider.statement?.length ?? 0).toBeLessThanOrEqual(160);
    expect(contentSchemaFor("section-divider").safeParse(divider).success).toBe(true);
  });

  test("the deck prompts localise to the target and label peers as references", () => {
    const brief: ExportBrief = {
      request: "pitch DFW Airport on data maturity",
      mode: "pitch",
      documentTitle: "DFW data maturity",
      subject: null,
      partiesInvolved: ["DFW Airport"],
      keyEntities: ["DFW Airport"],
      keyTopics: ["data maturity"],
      client: "DFW Airport",
      industry: "airports",
      sector: null,
      audience: "CIO",
      problem: null,
      goals: [],
      constraints: [],
      budget: null,
      timeline: null,
      tone: null,
      include: [],
      exclude: [],
      decisions: [],
      citedDocuments: [],
      chatFigures: [],
      openItems: [],
      targetClients: ["DFW Airport"],
      anonymise: false,
    };
    const pack = buildEvidencePack(CHUNKS, ["DFW Airport"], {
      targetClient: "DFW Airport",
    });
    const writer = writerUserPrompt(
      {
        layout: "context-bullets",
        actionTitle: "DFW Airport's manual capacity is the constraint",
        purpose: "Frame the situation",
        evidenceRefs: [],
        tier: "sourced",
      },
      brief,
      draftFor({ client: "DFW Airport" }),
      pack,
    );
    expect(writer).toContain("Target client (write every sentence for this client): DFW Airport");
    expect(writer).toContain("Never print a library customer's real name");
    expect(writer).toContain("reference:");
    expect(WRITER_SYSTEM).toContain("Aggressive localisation is mandatory");
    expect(WRITER_SYSTEM).toContain("Never hard-code colours, logos");

    const planner = plannerUserPrompt(brief, draftFor({ client: "DFW Airport" }), pack);
    expect(planner).toContain("Target client (the deck is written to this client): DFW Airport");
    expect(planner).toContain("never parties");
    expect(PLANNER_SYSTEM).toContain("every action title is written for that client by name");

    const legacy = deckUserPrompt([], brief, CHUNKS, null, "");
    expect(legacy).toContain("Target client: DFW Airport");
    expect(legacy).toContain("reference: Zurich Insurance");
    expect(DECK_SYSTEM).toContain("Never print a library customer's real name");
  });

  test("the writer prompt states the exact JSON shape it will validate", () => {
    const brief: ExportBrief = {
      documentTitle: "Adani Airports — pitch",
      request: "Build a pitch deck for Adani Airports.",
      partiesInvolved: ["Adani Airports"],
      mode: "pitch",
      client: "Adani Airports",
      industry: "aviation",
      sector: null,
      audience: "CIO",
      problem: null,
      goals: [],
      constraints: [],
      budget: null,
      timeline: null,
      tone: "consultative",
      include: [],
      exclude: [],
      decisions: [],
      citedDocuments: [],
      chatFigures: [],
      openItems: [],
    };
    const prompt = writerUserPrompt(
      {
        layout: "table-compact",
        actionTitle: "Three offer lines cover intake, triage and review",
        purpose: "Show the offer",
        evidenceRefs: [],
        tier: "sourced",
      },
      brief,
      draftFor({ client: "Adani Airports" }),
      buildEvidencePack(CHUNKS, ["Adani Airports"], {}),
    );
    expect(prompt).toContain('Return one JSON object with three keys: {"content"');
    expect(prompt).toContain('"headers"');
    expect(prompt).toContain('"rows"');
  });

  test("extracts ingest facts with exact values and known entities", () => {
    const facts = extractChunkFacts({
      chunkIndex: 3,
      text: "IndiGo cut roster publication from 48 hours to 9 hours in 2025.",
      knownEntities: [
        { name: "IndiGo", type: "company" },
        { name: "Aviation", type: "concept" },
      ],
      sourceTitle: "Roster control tower",
      customerName: "InterGlobe Aviation",
    });
    expect(facts.entities.map((entity) => entity.name)).toContain("IndiGo");
    expect(facts.entities.map((entity) => entity.name)).toContain("InterGlobe Aviation");
    expect(facts.claims.some((claim) => claim.value_text === "48 hours")).toBe(true);
    expect(facts.claims.some((claim) => claim.value_text === "9 hours")).toBe(true);
    expect(facts.claims.every((claim) => claim.source_title === "Roster control tower")).toBe(true);
    expect(facts.claims[0]?.source_year).toBe("2025");
  });

  test("merges database claims ahead of extracted claims without id collisions", async () => {
    const chunk = CHUNKS[0]!;
    const client = {
      from: () => ({
        select: () => ({
          in: async () => ({
            data: [
              {
                chunk_id: chunk.chunkId,
                metric: "verified metric",
                value_text: "999 hours",
                value_min: 999,
                value_max: 999,
                unit: "hours",
                context: "A verified sentence with 999 hours.",
                source_title: "Verified source",
                source_year: 2025,
                entities: null,
              },
            ],
            error: null,
          }),
        }),
      }),
    } as unknown as Parameters<typeof loadClaims>[0];
    const registry = await loadClaims(client, [chunk]);
    expect(registry["CL-1"]?.valueText).toBe("999 hours");
    expect(registry["CL-1"]?.sourceTitle).toBe("Verified source");
    const ids = Object.keys(registry);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^CL-\d+$/.test(id))).toBe(true);
  });

  test("uses retrieval groups before metadata when assigning a passage to a party", () => {
    const chunk = { ...CHUNKS[0]!, customerName: "Old Spelling Ltd" };
    const pack = buildEvidencePack([chunk], ["Zurich Insurance"], {
      groups: [{ name: "Zurich Insurance", matchedName: "Zurich", chunkIds: [chunk.chunkId] }],
    });
    expect(pack.parties[0]?.chunks.map((entry) => entry.chunkId)).toEqual([chunk.chunkId]);
    expect(pack.genericChunks).toHaveLength(0);
  });

  test("removes provenance language and unsupported figures from slide copy", () => {
    const registry = claimsFromChunks(CHUNKS);
    const first = Object.values(registry)[0]!;
    const result = sanitiseSlide(
      {
        layout: "context-bullets",
        bullets: [
          {
            text: `The library documents comparable work with ${first.valueText}.`,
            claimIds: [first.id],
          },
          { text: "This is not for hotels specifically and 27% is claimed.", claimIds: [] },
        ],
      },
      [first.id],
      registry,
    );
    expect(result.content.layout).toBe("context-bullets");
    if (result.content.layout === "context-bullets") {
      expect(result.content.bullets).toHaveLength(1);
      expect(hasBannedCopy(result.content.bullets[0]!.text)).toBe(false);
      expect(result.content.bullets[0]!.text).not.toContain("27%");
    }
  });
});

describe("consulting layouts", () => {
  function specWith(slides: DeckSpecSlide[]): DeckSpec {
    return {
      deckTitle: "Airport data maturity",
      audience: "Executive committee",
      storyline: "Connected data is the prerequisite for predictive operations.",
      slides,
      claims: {},
      entities: ["Zurich Airport"],
      gaps: [],
      warnings: [],
    };
  }

  function slide(layout: DeckSlideContent, actionTitle: string): DeckSpecSlide {
    return {
      id: actionTitle.toLowerCase().replace(/\W+/g, "-"),
      layout: layout.layout,
      actionTitle,
      purpose: "Carry the argument",
      tier: "sourced",
      content: layout,
      notes: "Supporting detail is held in the cited passages.",
      claimIds: [],
    };
  }

  test("accepts the staged, horizon and layered shapes through the writer schema", () => {
    const maturity = contentSchemaFor("maturity-progression").safeParse({
      layout: "maturity-progression",
      stages: [
        { label: "Disconnected" },
        { label: "Shared definitions", descriptor: "One agreed set of measures." },
        { label: "Predictive" },
      ],
      currentStage: 0,
      targetStage: 2,
    });
    expect(maturity.success).toBe(true);

    const tooFewStages = contentSchemaFor("maturity-progression").safeParse({
      layout: "maturity-progression",
      stages: [{ label: "One" }, { label: "Two" }],
    });
    expect(tooFewStages.success).toBe(false);

    expect(
      contentSchemaFor("three-horizon").safeParse({
        layout: "three-horizon",
        horizons: [
          { label: "Now", description: "Stabilise the core.", outcomes: ["One owner"] },
          { label: "Next", description: "Connect the flow.", outcomes: ["Shorter cycles"] },
          { label: "Later", description: "Predict demand.", outcomes: ["Early warning"] },
        ],
      }).success,
    ).toBe(true);

    expect(
      contentSchemaFor("layered-architecture").safeParse({
        layout: "layered-architecture",
        layers: [
          { label: "Experience", items: ["Operations console", "Airline portal"] },
          { label: "Decision", items: ["Forecasting", "Rules"] },
          { label: "Data", items: ["Flight feed", "Weather feed"] },
        ],
      }).success,
    ).toBe(true);
  });

  test("renders a maturity journey without inventing a score per stage", async () => {
    const spec = specWith([
      slide(
        {
          layout: "maturity-progression",
          stages: [
            { label: "Disconnected records", descriptor: "Teams keep their own copies." },
            { label: "Shared definitions", descriptor: "One agreed set of measures." },
            { label: "Integrated flow", descriptor: "One flow with a named owner." },
            { label: "Predictive decisions", descriptor: "Act before the outcome is fixed." },
          ],
          currentStage: 1,
          targetStage: 3,
        },
        "Predictive operations start with connected data",
      ),
    ]);
    const rendered = await renderDeck(spec, { date: "2026-11-17", subtitle: "Pitch" });
    expect(rendered.pages).toBe(2);
    const parts = unzipSync(rendered.bytes);
    const xml = Object.keys(parts)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => new TextDecoder().decode(parts[name]))
      .join("\n");
    expect(xml).toContain("Predictive decisions");
    // Progression is drawn from stage order, never from a fabricated score.
    expect(xml).not.toMatch(/>\s*50\s*</);
  });

  test("renders the three horizons and the layered stack", async () => {
    const spec = specWith([
      slide(
        {
          layout: "three-horizon",
          horizons: [
            {
              label: "Now",
              description: "Stabilise the core and remove costly handoffs.",
              outcomes: ["One owner per step", "Shared baseline"],
            },
            {
              label: "Next",
              description: "Connect the workflow end to end.",
              outcomes: ["Automated routing", "One performance view"],
            },
            {
              label: "Later",
              description: "Predict demand and prevent failures.",
              outcomes: ["Early warning", "Scenario planning"],
            },
          ],
        },
        "Value arrives in three deliberate horizons",
      ),
      slide(
        {
          layout: "layered-architecture",
          layers: [
            { label: "Experience", items: ["Operations console", "Airline portal"] },
            { label: "Decision", items: ["Forecasting", "Rules engine"] },
            { label: "Data", items: ["Flight feed", "Weather feed"] },
          ],
        },
        "One platform separates experience, decisions and data",
      ),
    ]);
    const rendered = await renderDeck(spec, { date: "2026-11-17", subtitle: "Pitch" });
    expect(rendered.pages).toBe(3);
    const parts = unzipSync(rendered.bytes);
    const xml = Object.keys(parts)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => new TextDecoder().decode(parts[name]))
      .join("\n");
    expect(xml).toContain("Scenario planning");
    expect(xml).toContain("Weather feed");
  });

  test("removes template leftovers from copy before it reaches a slide", () => {
    const result = sanitiseSlide(
      {
        layout: "context-bullets",
        bullets: [
          { text: "Operational data is fragmented {{CL-}} across teams TODO", claimIds: [] },
          { text: "A shared definition removes the rework [insert metric here]", claimIds: [] },
        ],
      },
      [],
      {},
    );
    expect(result.content.layout).toBe("context-bullets");
    if (result.content.layout !== "context-bullets") return;
    const joined = result.content.bullets.map((bullet) => bullet.text).join(" ");
    expect(joined).not.toContain("{{");
    expect(joined).not.toContain("TODO");
    expect(joined).not.toContain("insert metric");
    expect(joined).toContain("Operational data is fragmented");
  });

  test("keeps house-theme cover and divider titles readable on navy", async () => {
    const spec = specWith([
      slide(
        {
          layout: "section-divider",
          label: "Where the work starts",
          statement: "One shared view of the operation.",
        },
        "Where the work starts",
      ),
    ]);
    const rendered = await renderDeck(
      spec,
      { date: "18 November 2026", subtitle: "Proposal for a new client" },
      {},
    );
    const parts = unzipSync(rendered.bytes);
    for (const name of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
      const xml = new TextDecoder().decode(parts[name]);
      const background = xml.match(/<p:bg>.*?val="([0-9A-F]{6})"/s)?.[1] ?? "0B1F3A";
      const bodyXml = xml.replace(/<p:bg>.*?<\/p:bg>/s, "");
      const inks = [...bodyXml.matchAll(/<a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/g)].map(
        (match) => match[1]!,
      );
      expect(background).toBe("0B1F3A");
      // The title ink must not be the same navy as the canvas.
      expect(inks).not.toContain(background);
      expect(inks.some((ink) => contrastRatio(`#${ink}`, `#${background}`) >= 4.5)).toBe(true);
    }
  });

  test("refuses to render a deck that still carries a placeholder", () => {
    const spec = specWith([
      slide(
        { layout: "context-bullets", bullets: [{ text: "Fragmented {{CL-}} data", claimIds: [] }] },
        "Fragmented data slows every handover",
      ),
    ]);
    expect(() => assertDeckTraceable(spec)).toThrow(/placeholder/i);
  });
});

describe("deck pipeline", () => {
  test("builds a grounded, action-title deck with no leaked assumptions", async () => {
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
    });
    const spec = result.model.deck;
    expect(spec).toBeDefined();
    if (!spec) return;

    expect(spec.slides.length).toBeGreaterThanOrEqual(6);
    expect(spec.slides.length).toBeLessThanOrEqual(10);
    expect(spec.entities).toEqual(expect.arrayContaining(["Zurich Insurance"]));
    expect(spec.gaps.every((gap) => !/package volumes/i.test(gap))).toBe(true);

    const text = everyVisibleText(spec).join("\n");
    expect(text.toLowerCase()).not.toContain("package volumes");
    expect(text.toLowerCase()).not.toContain("documented capability");
    expect(text.toLowerCase()).not.toContain("what the library documents");
    expect(text).not.toContain("[1]");
    expect(text).not.toContain("(continued)");
    expect(text).not.toContain("[To be confirmed]");

    // Every chart point resolves through a claim in the registry.
    for (const slide of spec.slides) {
      if (slide.content.layout !== "chart-with-takeaway") continue;
      for (const series of slide.content.chart.series) {
        for (const point of series.points) {
          expect(spec.claims[point.claimId]).toBeDefined();
        }
      }
    }

    // No layout runs three slides deep.
    const layouts = spec.slides.map((slide) => slide.content.layout);
    for (let index = 2; index < layouts.length; index += 1) {
      expect(new Set(layouts.slice(index - 2, index + 1)).size).toBeGreaterThan(1);
    }

    expect(() => assertDeckTraceable(spec)).not.toThrow();
    // Qualitative slides have no numeric claims, but the passages they were
    // written from must still reach the audit and the source list.
    expect(result.trace.sections.every((section) => section.chunkIds.length > 0)).toBe(true);
    expect(result.model.sources.length).toBeGreaterThan(0);
  });

  test("renders the DeckSpec through the new renderer", async () => {
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
    });
    const spec = result.model.deck;
    expect(spec).toBeDefined();
    if (!spec) return;

    const direct = await renderDeck(spec, { date: "2026-11-16", subtitle: "Pitch deck" });
    expect(direct.pages).toBe(spec.slides.length + 1);

    const pptx = await renderPptx(result.model);
    expect(pptx.pages).toBe(spec.slides.length + 1);
    const parts = unzipSync(pptx.bytes);
    expect(Object.keys(parts).some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true);
    // Every declared part must exist, or the in-app viewer renders nothing.
    const declared = [
      ...new TextDecoder().decode(parts["[Content_Types].xml"]).matchAll(/PartName="([^"]+)"/g),
    ].map((match) => match[1]!.replace(/^\//, ""));
    expect(declared.filter((name) => !parts[name])).toEqual([]);
    const xml = Object.keys(parts)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => new TextDecoder().decode(parts[name]))
      .join("\n");
    expect(xml).not.toContain("(continued)");
    expect(xml.toLowerCase()).not.toContain("documented capability");
    expect(xml.toLowerCase()).not.toContain("package volumes");
  });

  test("falls back to a deterministic storyline when planning fails twice", async () => {
    const base = createMockFetch();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role: string; content: string }[];
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("senior pre-sales strategist")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return base(input as RequestInfo, init);
    }) as typeof fetch;

    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx" }),
      history: deckHistory(),
      client: createMockSupabase(CHUNKS, []),
      provider: { ...PROVIDER, fetchImpl },
    });
    expect(result.model.deck?.slides.length).toBeGreaterThanOrEqual(6);
    expect(result.model.deck?.warnings.some((warning) => /standard storyline/i.test(warning))).toBe(
      true,
    );
    expect(result.gate.blocked).toBe(false);
  });
});

describe("cross-client isolation", () => {
  test("a deck for a new client never names the source clients", async () => {
    const REFERENCE_NAMES = ["Zurich", "InterGlobe", "IndiGo", "Adani", "Northwind", "Fly++"];
    const result = await buildDocument({
      draft: draftFor({ mode: "pitch", type: "pptx", client: "Ethiopian Airlines", industry: "airlines" }),
      history: deckHistory("Ethiopian Airlines", "airlines"),
      client: createMockSupabase(CHUNKS, []),
      provider: PROVIDER,
      scope: {
        industries: ["airlines"],
        companies: [],
        targetClients: [
          {
            name: "Ethiopian Airlines",
            websiteUrl: null,
            industry: "airlines",
            anonymise: true,
            includePriorWork: false,
            notes: "",
          },
        ],
        updatedAt: null,
      },
    });

    expect(result.gate.blocked).toBe(false);
    const pptx = await renderPptx(result.model);
    const parts = unzipSync(pptx.bytes);
    const xml = Object.keys(parts)
      .filter((name) => /\.(?:xml|rels)$/i.test(name))
      .map((name) => new TextDecoder().decode(parts[name]))
      .join("\n");
    for (const name of REFERENCE_NAMES) {
      expect(xml.includes(name)).toBe(false);
    }
  });
});
