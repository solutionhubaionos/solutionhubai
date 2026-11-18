import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { logoCandidates } from "../src/lib/documents/client-logo";
import { renderDeck } from "../src/lib/documents/render/deck";
import type { DeckSpec } from "../src/lib/documents/deck/types";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("client logo detection", () => {
  test("prefers a logo-named image and never uses og:image", () => {
    const html = `
      <head>
        <meta property="og:image" content="/hero-banner.jpg" />
        <link rel="apple-touch-icon" href="/touch.png" />
        <link rel="icon" href="/favicon-32.png" />
      </head>
      <body><header><img class="site-logo" src="/assets/brand-logo.svg" /></header></body>`;
    const candidates = logoCandidates(html, new URL("https://example.com/about"));
    const urls = candidates.map((entry) => entry.url);
    expect(urls).toContain("https://example.com/assets/brand-logo.svg");
    expect(urls).toContain("https://example.com/touch.png");
    expect(urls.some((url) => url.includes("hero-banner"))).toBe(false);
    // apple-touch-icon outranks the header image.
    expect(candidates[0]?.url).toBe("https://example.com/touch.png");
  });
});

function specWithLogo(): DeckSpec {
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
    ],
  };
}

describe("client logo on the cover", () => {
  test("embeds the logo image in the rendered deck", async () => {
    const rendered = await renderDeck(
      specWithLogo(),
      { date: "18 November 2026", subtitle: "Pitch" },
      { clientLogo: { dataUrl: PNG, light: false, aspect: 3 } },
    );
    const parts = unzipSync(rendered.bytes);
    expect(Object.keys(parts).some((name) => name.startsWith("ppt/media/"))).toBe(true);
  });

  test("renders without a logo when none is provided", async () => {
    const rendered = await renderDeck(specWithLogo(), { date: "18 November 2026", subtitle: "Pitch" });
    expect(rendered.pages).toBeGreaterThanOrEqual(2);
  });
});
