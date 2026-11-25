import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { renderDeck } from "../src/lib/documents/render/deck";
import {
  checkDeckBackgrounds,
  checkDeckFonts,
  checkDeckGradients,
  checkDeckPalette,
  paletteIsComplete,
} from "../src/lib/documents/render/palette-check";
import { SAFE_PAIRS, TOKENS, palette, validateTokens } from "../src/lib/documents/tokens";
import { SURFACE_BACKGROUND } from "../src/lib/documents/brand-guide";
import type { DeckSpec } from "../src/lib/documents/deck/types";

function spec(): DeckSpec {
  return {
    deckTitle: "Airport data maturity",
    audience: "Executive committee",
    storyline: "Connected data is the prerequisite for predictive operations.",
    claims: {
      "CL-1": {
        id: "CL-1",
        metric: "turnaround time",
        valueText: "18%",
        unit: "%",
        context: "",
        sourceTitle: "Prior engagement",
      } as never,
    },
    entities: ["GMR Airports"],
    gaps: [],
    warnings: [],
    slides: [
      {
        id: "s1",
        layout: "context-bullets",
        actionTitle: "A shared platform removes the rework",
        purpose: "Carry the argument",
        tier: "sourced",
        content: {
          layout: "context-bullets",
          bullets: [{ text: "Separate systems keep teams on their own copy.", claimIds: [] }],
        },
        notes: "Notes.",
        claimIds: [],
      },
      {
        id: "s2",
        layout: "kpi-cards",
        actionTitle: "Two numbers frame the case",
        purpose: "Carry the argument",
        tier: "sourced",
        content: {
          layout: "kpi-cards",
          cards: [{ label: "Faster turnaround", claimId: "CL-1" }],
        },
        notes: "Notes.",
        claimIds: ["CL-1"],
      },
      {
        id: "s3",
        layout: "next-steps-ask",
        actionTitle: "Agree the pilot scope",
        purpose: "Ask",
        tier: "sourced",
        content: {
          layout: "next-steps-ask",
          ask: "Approve the pilot",
          steps: [{ text: "Sign off the scope", owner: "COO" }],
        },
        notes: "Notes.",
        claimIds: [],
      },
    ],
  };
}

describe("brand tokens", () => {
  test("the palette matches the guide and is closed", () => {
    expect(palette.navy).toBe("1C2453");
    expect(palette.electricBlue).toBe("2148FB");
    expect(palette.deepNavy).toBe("030C44");
    expect(palette.pearl).toBe("F5F4F1");
    expect(palette.mist).toBe("D2D7E2");
    expect(palette.lightGrey).toBe("EDEDED");
    expect(palette.softBlue).toBe("BAD6FF");
    expect(palette.warmClay).toBe("FFAF75");
    expect(palette.electricCyan).toBe("00ECFF");
    expect(palette.white).toBe("FFFFFF");
    expect(Object.keys(palette)).toHaveLength(10);
    expect(paletteIsComplete()).toBe(true);
    expect(() => validateTokens()).not.toThrow();
  });

  test("the safe-pair matrix is generated, not hardcoded", () => {
    const ratio = Object.fromEntries(
      SAFE_PAIRS.map((pair) => [`${pair.text}/${pair.background}`, pair.ratio]),
    );
    expect(ratio["white/navy"]).toBeGreaterThan(14);
    expect(ratio["white/deepNavy"]).toBeGreaterThan(18);
    expect(ratio["white/electricBlue"]).toBeGreaterThan(6);
    expect(ratio["navy/pearl"]).toBeGreaterThan(13);
    expect(ratio["navy/mist"]).toBeGreaterThan(9);
    expect(ratio["navy/lightGrey"]).toBeGreaterThan(9);
    expect(ratio["navy/softBlue"]).toBeGreaterThan(9);
    expect(ratio["navy/warmClay"]).toBeGreaterThan(8);
    expect(ratio["navy/electricCyan"]).toBeGreaterThan(9);
    // The forbidden pairs are the ones the guide names; none is a declared pair.
    expect(ratio["navy/electricBlue"]).toBeUndefined();
    expect(ratio["white/pearl"]).toBeUndefined();
    expect(ratio["white/mist"]).toBeUndefined();
    expect(ratio["white/lightGrey"]).toBeUndefined();
    expect(ratio["white/electricCyan"]).toBeUndefined();
  });

  test("fonts and surfaces come from the token file", () => {
    expect(TOKENS.fonts.deckHeading).toBe("Century Gothic");
    expect(TOKENS.fonts.deckBody).toBe("Aptos");
    expect(TOKENS.fonts.deckChart).toBe("+mn-lt");
    expect(SURFACE_BACKGROUND.gradient).toBe("deepNavy");
    expect(SURFACE_BACKGROUND.navy).toBe("deepNavy");
    expect(SURFACE_BACKGROUND.light).toBe("white");
  });

  test("a rendered deck uses only brand colours and the bundled imagery", async () => {
    const rendered = await renderDeck(spec(), { date: "18 November 2026", subtitle: "Pitch" });
    const parts = unzipSync(rendered.bytes);
    expect(checkDeckPalette(parts)).toEqual([]);
    expect(checkDeckGradients(parts)).toEqual([]);
    expect(checkDeckFonts(parts)).toEqual([]);
    // The pictures are the wordmark logos (PNG) and the baked brand gradient (PNG).
    const media = Object.keys(parts).filter((name) => /^ppt\/media\/.+/.test(name));
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((name) => /\.(?:png|jpe?g)$/i.test(name))).toBe(true);
    const { sequence, findings } = checkDeckBackgrounds(parts);
    expect(findings).toEqual([]);
    // Cover gradient on deep navy, white content pages, deep-navy closing.
    expect(sequence[0]).toBe(palette.deepNavy);
    expect(sequence[1]).toBe(palette.white);
    expect(sequence.at(-1)).toBe(palette.deepNavy);
    const cover = new TextDecoder().decode(parts["ppt/slides/slide1.xml"]!);
    expect(cover).toMatch(`val="${palette.deepNavy}"`);
    // The cover bleeds the baked guideline gradient, never an <a:gradFill>.
    expect(cover).toContain("<a:blip");
  });

  test("caps the deck at the token slide budget", async () => {
    const base = spec();
    const many: DeckSpec = {
      ...base,
      slides: Array.from({ length: 12 }, (_, index) => ({
        ...base.slides[index % base.slides.length]!,
        id: `s${index}`,
      })),
    };
    const rendered = await renderDeck(many, { date: "18 November 2026", subtitle: "Pitch" });
    expect(rendered.pages).toBeLessThanOrEqual(TOKENS.config.maxSlides);
  });

  test("the deck renderer hard-codes no colour or font", () => {
    const dir = new URL("../src/lib/documents/render/", import.meta.url).pathname;
    const files = ["deck.ts", "pptx.ts", "contrast-check.ts"];
    const offenders: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8");
      if (/"(?!000000)[0-9A-Fa-f]{6}"/.test(source)) offenders.push(`${name}: hex colour literal`);
      if (/Century Gothic|Aptos|Georgia|Calibri|Helvetica|Outfit/.test(source)) {
        offenders.push(`${name}: font literal`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
