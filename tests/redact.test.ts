import { describe, expect, test } from "bun:test";
import { createReferenceRedactor, neutralDescriptor } from "../src/lib/documents/redact";
import { loadReferenceRedactor } from "../src/lib/documents/references";
import { lintDeckSpec, lintTitle, presenterNotes } from "../src/lib/documents/lint";
import type { DeckSpec } from "../src/lib/documents/deck/types";
import type { RetrievedChunk } from "../src/lib/rag/search";

const chunk: RetrievedChunk = {
  chunkId: "c1",
  contentId: "doc-indigo",
  content: "IndiGo's marketplace grew while Riyadh Air_AIonOS v1.0 was piloted.",
  page: null,
  slide: 7,
  heading: "IndiGo commercial model",
  title: "Fly++ Indigo Proposal",
  fileName: "Fly++ Indigo Proposal 2019.pptx",
  filePath: "airlines/Fly++ Indigo Proposal 2019.pptx",
  industry: "airlines",
  customerName: "IndiGo Airlines",
  vectorRank: 1,
  textRank: 1,
  score: 0.8,
};

function specWith(text: string, notes = ""): DeckSpec {
  return {
    deckTitle: "Ethiopian Airlines | Marketplace",
    audience: "Executive committee",
    storyline: "One argument.",
    claims: {},
    entities: ["Ethiopian Airlines"],
    gaps: [],
    warnings: [],
    slides: [
      {
        id: "slide-1",
        layout: "context-bullets",
        actionTitle: text,
        purpose: "Carry the argument",
        tier: "sourced",
        content: {
          layout: "context-bullets",
          bullets: [{ text, claimIds: [] }],
        },
        notes,
        claimIds: [],
      },
    ],
  };
}

describe("reference redaction", () => {
  test("uses a neutral descriptor for the sector", () => {
    expect(neutralDescriptor("airlines")).toBe("peer airline");
    expect(neutralDescriptor("airports")).toBe("peer airport");
    expect(neutralDescriptor("hotels")).toBe("peer hotel group");
    expect(neutralDescriptor("something else")).toBe("peer company");
  });

  test("removes names, possessives and document titles before the model sees them", () => {
    const redactor = createReferenceRedactor({
      references: [
        { name: "IndiGo Airlines", industry: "airlines", aliases: ["IndiGo", "Fly++"] },
        { name: "Riyadh Air", industry: "airlines" },
        { name: "Adani Airports", industry: "airports" },
      ],
      documents: [
        { contentId: "doc-indigo", industry: "airlines", customerName: "IndiGo Airlines" },
      ],
      targets: ["Ethiopian Airlines"],
    });

    expect(redactor.scrub("IndiGo's comparable marketplace opportunity")).toBe(
      "peer airline A’s comparable marketplace opportunity",
    );
    expect(redactor.scrub("IndiGo’s comparable marketplace opportunity")).toBe(
      "peer airline A’s comparable marketplace opportunity",
    );
    expect(redactor.scrub("Riyadh Air_AIonOS v1.0")).not.toContain("Riyadh");
    expect(redactor.scrub("Adani Airports and now Ethiopian Airlines")).toContain(
      "Ethiopian Airlines",
    );
    expect(redactor.scrub("Adani Airports and now Ethiopian Airlines")).not.toContain("Adani");

    const scrubbed = redactor.scrubChunk(chunk);
    expect(scrubbed.content).not.toContain("IndiGo");
    expect(scrubbed.content).not.toContain("Riyadh");
    expect(scrubbed.title).toBe("Prior engagement with peer airline A");
    expect(scrubbed.fileName).toBe("");
    expect(scrubbed.customerName).toBe("peer airline A");
  });

  test("keeps the target client out of the blocklist", () => {
    const redactor = createReferenceRedactor({
      references: [{ name: "Ethiopian Airlines", industry: "airlines" }],
      targets: ["Ethiopian Airlines"],
    });
    expect(redactor.scrub("Ethiopian Airlines needs a marketplace")).toBe(
      "Ethiopian Airlines needs a marketplace",
    );
  });

  test("compiles names with dots, underscores, hyphens and punctuation", () => {
    const redactor = createReferenceRedactor({
      references: [
        { name: "IndiGo Airlines", industry: "airlines", aliases: ["IndiGo", "Fly++"] },
        { name: "Riyadh Air_AIonOS v1.0", industry: "airlines" },
        { name: "AT&T Inc.", industry: "telecom" },
        { name: "Acme (India) Pvt. Ltd.", industry: "retail" },
      ],
    });
    const clean = redactor.scrub(
      "IndiGo's deal, Riyadh Air_AIonOS v1.0, AT&T Inc. and Acme (India) Pvt. Ltd. moved.",
    );
    expect(clean).not.toMatch(/IndiGo|Riyadh|AT&T|Acme/i);
  });

  test("skips names too short to match without false positives", () => {
    const redactor = createReferenceRedactor({
      references: [{ name: "A.B.", industry: "airlines" }],
    });
    expect(redactor.entries).toHaveLength(0);
    expect(redactor.scrub("A.B. is here")).toBe("A.B. is here");
  });

  test("loads customers and aliases only, never vendor names or title tokens", async () => {
    const tables: Record<string, unknown[]> = {
      customers: [
        { name: "IndiGo Airlines", industry: "airlines" },
        { name: "booking.com", industry: "hospitality" },
      ],
      content_items: [
        {
          id: "doc-1",
          customer_name: "IndiGo Airlines",
          industry: "airlines",
          title: "Booking.com x AIonOS CX Transformation",
        },
      ],
      customer_aliases: [{ alias: "Fly++", canonical: "IndiGo Airlines" }],
    };
    const client = {
      from: (table: string) => ({
        select: () => Promise.resolve({ data: tables[table] ?? [], error: null }),
      }),
    };
    const redactor = await loadReferenceRedactor(
      client as never,
      [],
      ["Ethiopian Airlines"],
      () => undefined,
    );
    expect(redactor.scrub("booking.com is a channel")).toBe("booking.com is a channel");
    const scrubbed = redactor.scrub("IndiGo Airlines and Fly++ are references");
    expect(scrubbed).not.toContain("IndiGo");
    expect(scrubbed).not.toContain("Fly++");
  });
});

describe("output lint", () => {
  test("removes instruction prefixes and imperative titles", () => {
    expect(lintTitle("Proof: show prior work now proposed for the client")).toBe(
      "prior work now proposed for the client",
    );
    expect(lintTitle("Contrast the fragmented status quo with the target")).toBe(
      "The fragmented status quo with the target",
    );
  });

  test("removes the whole title when a figure leaves an orphan unit", () => {
    expect(lintTitle("The $ billion opportunity is real")).toBe("The commercial case needs sizing");
    expect(lintTitle("Margins improved by 12% at % of revenue")).not.toMatch(/\bat\s*%/i);
  });

  test("notes are presenter speech, not audit logs", () => {
    const notes = presenterNotes(
      "CL-4 explains the 2019 IndiGo figures in Fly++ Indigo Proposal.pptx. Source: Riyadh Air_AIONOS v1.0. The peer benchmark is not a projection for Ethiopian Airlines.",
      (text) => text.replace(/IndiGo/g, "peer airline A"),
    );
    expect(notes).not.toMatch(/CL-\d/);
    expect(notes).not.toMatch(/\.pptx/);
    expect(notes).not.toContain("IndiGo");
    expect(notes).toContain("peer airline A");
  });

  test("rewrites the brand name to the title-cased Aionos", () => {
    expect(lintTitle("Why AIonOS wins for the client")).toContain("Aionos");
    expect(lintTitle("Why AionOS wins for the client")).not.toMatch(/AIonOS|AionOS/);
  });

  test("keeps one anonymised proof attribution and removes later copies", () => {
    const spec = specWith(
      "As demonstrated at peer airline A and now proposed for Ethiopian Airlines, the model works.",
    );
    spec.slides.push({
      ...spec.slides[0]!,
      id: "slide-2",
      actionTitle: "A second proof point follows the same model",
      content: {
        layout: "context-bullets",
        bullets: [
          {
            text: "As demonstrated at peer airline A and now proposed for Ethiopian Airlines, adoption follows.",
            claimIds: [],
          },
        ],
      },
    });
    const result = lintDeckSpec(spec);
    expect(result.findings.some((finding) => finding.kind === "repeated-attribution")).toBe(true);
    expect(JSON.stringify(result.spec.slides[1])).not.toContain("As demonstrated");
  });
});
