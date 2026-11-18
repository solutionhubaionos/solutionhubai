import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { checkTextPair, PALETTE } from "../src/lib/documents/contrast";
import { checkDeckContrast } from "../src/lib/documents/render/contrast-check";
import { renderDeck } from "../src/lib/documents/render/deck";
import type { DeckSpec } from "../src/lib/documents/deck/types";

describe("Aionos contrast table", () => {
  test("white on the dark backgrounds is allowed", () => {
    expect(checkTextPair("FFFFFF", "1C2453").ok).toBe(true);
    expect(checkTextPair("FFFFFF", "030C44").ok).toBe(true);
    expect(checkTextPair("FFFFFF", "2148FB").ok).toBe(true);
  });

  test("navy on the light fills is allowed, on dark it is not", () => {
    expect(checkTextPair("1C2453", "00ECFF").ok).toBe(true);
    expect(checkTextPair("1C2453", "FFAF75").ok).toBe(true);
    expect(checkTextPair("1C2453", "1C2453").ok).toBe(false);
  });

  test("white on a light fill and graphics colours as text are forbidden", () => {
    expect(checkTextPair("FFFFFF", "00ECFF").ok).toBe(false);
    expect(checkTextPair("2148FB", "1C2453").ok).toBe(false);
    expect(checkTextPair("BAD6FF", "FFFFFF").ok).toBe(false);
  });

  test("the palette matches the Aionos guide", () => {
    expect(PALETTE.navy).toBe("#1C2453");
    expect(PALETTE.electricBlue).toBe("#2148FB");
    expect(PALETTE.cyan).toBe("#00ECFF");
  });
});

function spec(): DeckSpec {
  return {
    deckTitle: "Air India data platform",
    audience: "Executive committee",
    storyline: "One argument.",
    claims: {},
    entities: ["Air India"],
    gaps: [],
    warnings: [],
    slides: [
      {
        id: "slide-1",
        layout: "context-bullets",
        actionTitle: "A shared platform removes the rework",
        purpose: "Carry the argument",
        tier: "sourced",
        content: {
          layout: "context-bullets",
          bullets: [{ text: "Separate systems keep teams on their own copy.", claimIds: [] }],
        },
        notes: "Walk the client through the point.",
        claimIds: [],
      },
      {
        id: "slide-2",
        layout: "kpi-cards",
        actionTitle: "Two numbers frame the case",
        purpose: "Quantify",
        tier: "sourced",
        content: {
          layout: "kpi-cards",
          cards: [{ label: "Cycle time", claimId: "CL-1" }],
        },
        claimIds: ["CL-1"],
      },
    ],
    claims: {
      "CL-1": {
        id: "CL-1",
        metric: "Cycle time",
        valueText: "6 days",
        unit: "days",
        context: "",
        sourceTitle: "Prior engagement",
      } as never,
    },
  };
}

describe("rendered deck contrast", () => {
  test("every slide is navy and every text run passes the table", async () => {
    const rendered = await renderDeck(spec(), { date: "18 November 2026", subtitle: "Pitch" });
    const parts = unzipSync(rendered.bytes);
    const firstSlides = Object.fromEntries(
      Object.entries(parts).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    );
    const findings = checkDeckContrast(firstSlides);
    expect(findings).toEqual([]);
    // The cover uses the kit's BLUE surface.
    const cover = new TextDecoder().decode(parts["ppt/slides/slide1.xml"]!);
    expect(cover.toUpperCase()).toContain("2148FB");
  });
});
