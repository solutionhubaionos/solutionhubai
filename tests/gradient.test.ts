import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { coverBackgroundDataUrl, orbDataUrl } from "../src/lib/documents/render/gradient";
import { renderDeck } from "../src/lib/documents/render/deck";
import type { DeckSpec } from "../src/lib/documents/deck/types";

describe("Aionos gradient assets", () => {
  test("the cover gradient and orb render as PNG data URLs", () => {
    for (const url of [coverBackgroundDataUrl(), orbDataUrl()]) {
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(url.length).toBeGreaterThan(1000);
    }
  });

  test("a rendered deck embeds the cover gradient image", async () => {
    const spec: DeckSpec = {
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
      ],
    };
    const rendered = await renderDeck(spec, { date: "18 November 2026", subtitle: "Pitch" });
    const parts = unzipSync(rendered.bytes);
    expect(Object.keys(parts).some((name) => name.startsWith("ppt/media/"))).toBe(true);
  });
});
