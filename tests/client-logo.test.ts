import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { logoCandidates } from "../src/lib/logo/candidates";
import { renderDeck } from "../src/lib/documents/render/deck";
import { cleanClientLogo } from "../src/lib/documents/render/client-logo";
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

  test("finds a logo named by class or id outside the header", () => {
    const html = `<body><footer><img class="brand-logo" src="/img/footer-logo.svg" /></footer></body>`;
    const urls = logoCandidates(html, new URL("https://example.com/")).map((entry) => entry.url);
    expect(urls).toContain("https://example.com/img/footer-logo.svg");
  });

  test("prefers a CSS-background brand logo over a third-party badge and a footer logo", () => {
    // Mirrors easemytrip.com: the navbar wordmark is a styled <div>, the
    // TrustPilot badge is an <img> that names itself "logo", and the footer
    // holds a white variant.
    const html = `
      <style>._EMTLogo{background:url(https://images.example.com/brandlogo/emtlogo_new8.svg) 50%/138px 58px no-repeat}</style>
      <body>
        <div class="_EMTLogo"><a href="/">home</a></div>
        <section><img src="https://images.example.com/desk-img/tp-logo-black.svg" alt="TP Logo" /></section>
        <footer><img src="https://images.example.com/common/footer/EMTLogo_white.png" /></footer>
      </body>`;
    const candidates = logoCandidates(html, new URL("https://example.com/"));
    expect(candidates[0]?.url).toBe("https://images.example.com/brandlogo/emtlogo_new8.svg");
  });

  test("reads a JSON-LD logo and a lazy image, and skips country flags", () => {
    const html = `
      <head>
        <script type="application/ld+json">{"@type":"Organization","logo":{"url":"/brand/mark.png"}}</script>
      </head>
      <body>
        <img data-src="/assets/site-logo.svg" alt="Home" />
        <img src="/sites-logo/egypt.svg" class="logo" alt="Egypt" />
      </body>`;
    const candidates = logoCandidates(html, new URL("https://example.com/"));
    const urls = candidates.map((entry) => entry.url);
    expect(urls).toContain("https://example.com/brand/mark.png");
    expect(urls).toContain("https://example.com/assets/site-logo.svg");
    expect(urls.some((url) => url.includes("egypt"))).toBe(false);
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
    const rendered = await renderDeck(specWithLogo(), {
      date: "18 November 2026",
      subtitle: "Pitch",
    });
    expect(rendered.pages).toBeGreaterThanOrEqual(2);
  });

  test("draws the client logo on the cover, on the gradient, not a separate page", async () => {
    const rendered = await renderDeck(
      specWithLogo(),
      { date: "18 November 2026", subtitle: "Pitch" },
      { clientLogo: { dataUrl: PNG, light: true, aspect: 3 } },
    );
    const parts = unzipSync(rendered.bytes);
    const cover = new TextDecoder().decode(parts["ppt/slides/slide1.xml"]!);
    // Slide 1 carries the baked gradient and the client mark, nothing else.
    expect(cover).toMatch(/<p:bg>[\s\S]*?val="030C44"/);
    expect((cover.match(/<a:blip/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(cover).not.toMatch('<a:prstGeom prst="roundRect"');
  });

  test("pastes a dark logo with no panel or border", async () => {
    const rendered = await renderDeck(
      specWithLogo(),
      { date: "18 November 2026", subtitle: "Pitch" },
      { clientLogo: { dataUrl: PNG, light: false, aspect: 3 } },
    );
    const parts = unzipSync(rendered.bytes);
    const cover = new TextDecoder().decode(parts["ppt/slides/slide1.xml"]!);
    // Just the image: no rounded card, no shape behind it.
    expect(cover).not.toMatch('<a:prstGeom prst="roundRect"');
  });
});

describe("client logo cleaning", () => {
  /** An opaque white box with a blue mark in the centre, as a JPEG-like logo. */
  function whiteBoxLogo(): string {
    const canvas = createCanvas(200, 80);
    const context = canvas.getContext("2d");
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, 200, 80);
    context.fillStyle = "#2148FB";
    context.fillRect(60, 20, 80, 40);
    return canvas.toDataURL("image/png");
  }

  test("keys out the white background and crops to the mark", async () => {
    const cleaned = await cleanClientLogo(whiteBoxLogo());
    const image = await loadImage(Buffer.from(cleaned.split(",")[1]!, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const px = context.getImageData(0, 0, image.width, image.height).data;
    // The surrounding white is gone; the mark is still there and cropped tight.
    expect(px[3]).toBe(0);
    expect(image.width).toBeLessThan(120);
    expect(image.width).toBeGreaterThan(70);
    expect(image.height).toBeGreaterThan(35);
  });

  test("leaves a transparent logo unchanged in shape", async () => {
    const canvas = createCanvas(40, 40);
    const context = canvas.getContext("2d");
    context.fillStyle = "#1C2453";
    context.fillRect(10, 10, 20, 20);
    const cleaned = await cleanClientLogo(canvas.toDataURL("image/png"));
    const image = await loadImage(Buffer.from(cleaned.split(",")[1]!, "base64"));
    expect(image.width).toBeLessThan(40);
    expect(image.height).toBeLessThan(40);
  });
});
